import type {
  Cause, DiagnosisCase, Evidence, Metric, Observation, RankedHypothesis, ToolDecision, Verification,
} from '../domain/contracts.ts';
import { validateDiagnosisCase, validateObservation } from '../domain/validation.ts';
import { type FixtureCase, queryFixtureMetric } from '../data/fixtures.ts';
import { executeTaskGraph, type ExecutableTask } from './task-executor.ts';
import { budgetFromContextWindow, selectContext, type ContextChunk } from '../algorithms/context-budget.ts';
import { decideToolCall } from '../algorithms/tool-gate.ts';
import { rankCauses } from '../algorithms/ranking.ts';
import { verifyConclusion } from '../algorithms/verification.ts';

export interface AgentTraceEvent {
  step: number;
  kind: 'schedule' | 'repair' | 'tool_decision' | 'tool_result' | 'rank' | 'verify' | 'stop';
  detail: string;
  metric?: Metric;
  decision?: ToolDecision['action'];
}

export interface DiagnosisReport {
  provenance: string;
  synthetic: boolean | null;
  diagnosisCase: DiagnosisCase;
  observations: Observation[];
  evidence: Evidence[];
  ranking: RankedHypothesis[];
  verification: Verification;
  queriedMetrics: Metric[];
  trace: AgentTraceEvent[];
  context: ReturnType<typeof selectContext>;
  contextBudgetTokens: number;
  recommendation: string;
  repairRounds: number;
}

const ALL_METRICS: Metric[] = [
  'units_sold', 'paid_orders', 'visitors', 'stock_on_hand', 'price', 'promotion_active',
];

const TOOLS: Record<Metric, string> = {
  units_sold: 'get_sku_sales',
  paid_orders: 'get_sku_orders',
  visitors: 'get_sku_traffic',
  stock_on_hand: 'get_sku_inventory',
  price: 'get_sku_price',
  promotion_active: 'get_sku_promotion',
};

const CAUSE_LABELS: Record<Cause, string> = {
  stockout: '缺货',
  traffic_decline: '访客流量下降',
  conversion_decline: '支付转化下降',
  price_or_promotion_change: '价格或促销变化',
};

export interface ReadOnlyDiagnosisTools {
  /** Must independently enforce the case/store/SKU scope before returning records. */
  queryMetric(metric: Metric, signal?: AbortSignal): Promise<Observation[]> | Observation[];
  sourceSlug?(metric: Metric): string;
  sourceActive?(metric: Metric): boolean;
  sourceState?(metric: Metric): 'healthy' | 'stale' | 'unavailable';
}

export interface AgentOptions {
  maxFollowUpQueries?: number;
  maxRepairRounds?: number;
  /** Per-tool deadline. Adapters should stop work when the optional signal aborts. */
  toolTimeoutMs?: number;
  /** Configured model window; this is not discovered from a live model API. */
  contextWindowTokens?: number;
  /** Tokens reserved for system instructions, dialogue, tools, and output. */
  reservedContextTokens?: number;
  /** Minimum sales decline required before a cause can be verified. */
  minSalesDeclineRatio?: number;
  blockedMetrics?: Metric[];
  provenance?: string;
  synthetic?: boolean;
}

class ToolTimeoutError extends Error {
  constructor(metric: Metric, timeoutMs: number) {
    super(`Tool query ${metric} timed out after ${timeoutMs} ms`);
    this.name = 'ToolTimeoutError';
  }
}

interface QueryOutcome {
  executed: boolean;
  reason: string;
}

function explanationCategory(cause: Cause): ContextChunk['category'] {
  return {
    stockout: 'stockout',
    traffic_decline: 'traffic_change',
    conversion_decline: 'sales_change',
    price_or_promotion_change: 'price_change',
  }[cause];
}

function recommendation(verification: Verification, ranking: RankedHypothesis[]): string {
  if (verification.status !== 'supported' || !ranking[0]) {
    return '当前证据不足以确定原因；先补齐缺失指标并核对数据口径，暂不建议据此自动调整经营策略。';
  }
  const advice: Record<Cause, string> = {
    stockout: '优先核对缺货日期、可售库存与补货到货记录。',
    traffic_decline: '优先核对渠道访客变化、投放记录和商品曝光。',
    conversion_decline: '优先核对详情页、支付链路和同口径转化率。',
    price_or_promotion_change: '优先核对调价、促销结束时间与竞争商品活动。',
  };
  return `当前证据较支持“${CAUSE_LABELS[ranking[0].cause]}”这一假设。${advice[ranking[0].cause]}结论仍需业务复核。`;
}

/** A bounded observe → decide → query → rank → verify Agent loop with read-only tools. */
export async function diagnoseWithTools(
  diagnosisCase: DiagnosisCase,
  tools: ReadOnlyDiagnosisTools,
  options: AgentOptions = {},
): Promise<DiagnosisReport> {
  validateDiagnosisCase(diagnosisCase);
  const maxFollowUpQueries = options.maxFollowUpQueries ?? 4;
  if (!Number.isInteger(maxFollowUpQueries) || maxFollowUpQueries < 0 || maxFollowUpQueries > 10) {
    throw new Error('maxFollowUpQueries must be between 0 and 10');
  }
  const maxRepairRounds = options.maxRepairRounds ?? 1;
  if (!Number.isInteger(maxRepairRounds) || maxRepairRounds < 0 || maxRepairRounds > 10) {
    throw new Error('maxRepairRounds must be between 0 and 10');
  }
  const toolTimeoutMs = options.toolTimeoutMs ?? 30_000;
  if (!Number.isInteger(toolTimeoutMs) || toolTimeoutMs < 1 || toolTimeoutMs > 60_000) {
    throw new Error('toolTimeoutMs must be between 1 and 60000');
  }
  if (options.minSalesDeclineRatio !== undefined &&
      (!Number.isFinite(options.minSalesDeclineRatio) ||
       options.minSalesDeclineRatio < 0 || options.minSalesDeclineRatio > 1)) {
    throw new Error('minSalesDeclineRatio must be between 0 and 1');
  }
  const trace: AgentTraceEvent[] = [];
  const push = (event: Omit<AgentTraceEvent, 'step'>) => trace.push({ step: trace.length + 1, ...event });
  let observations: Observation[] = [];
  let observationIds = new Set<string>();
  const queriedMetrics: Metric[] = [];
  const blocked = new Set(options.blockedMetrics ?? []);
  const slug = (metric: Metric) => tools.sourceSlug?.(metric) ?? `business-${metric}`;

  async function query(metric: Metric): Promise<QueryOutcome> {
    const successfulCalls = queriedMetrics.filter(item => item === metric).length;
    if (successfulCalls >= 2) {
      return { executed: false, reason: `${metric} has reached its two-query limit` };
    }
    const isRecheck = successfulCalls === 1;
    // Check the proposed metric at call time. A shared source slug must not
    // let another metric's active state authorize this metric's query.
    const sourceSlug = slug(metric);
    const sourceActive = tools.sourceActive?.(metric) ?? true;
    const sourceState = tools.sourceState?.(metric) ?? 'healthy';
    const decision = decideToolCall({
      caseId: diagnosisCase.caseId,
      toolName: TOOLS[metric],
      sourceSlug,
      metric,
      operation: 'read',
      businessRisk: 0.05,
    }, {
      permissionMode: 'safe',
      activeSourceSlugs: sourceActive ? new Set([sourceSlug]) : new Set(),
      sourceStates: { [sourceSlug]: sourceState },
      allowedMetrics: new Set(ALL_METRICS.filter(item => !blocked.has(item))),
      prerequisiteMet: true,
    });
    push({ kind: 'tool_decision', detail: `${isRecheck ? '复查：' : ''}${decision.reason}`,
      metric, decision: decision.action });
    if (decision.action !== 'execute') return { executed: false, reason: decision.reason };

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        const error = new ToolTimeoutError(metric, toolTimeoutMs);
        reject(error);
        controller.abort(error);
      }, toolTimeoutMs);
    });
    let result: Observation[];
    try {
      result = await Promise.race([
        Promise.resolve().then(() => tools.queryMetric(metric, controller.signal)),
        timeout,
      ]);
    } catch (error) {
      // An adapter may reject synchronously in response to abort. Preserve the
      // timeout classification so the still-running call is never retried.
      if (timedOut) throw new ToolTimeoutError(metric, toolTimeoutMs);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!Array.isArray(result)) throw new Error(`Tool query ${metric} did not return observations[]`);
    // On a recheck, the new metric batch replaces its predecessor. Validate
    // against other metrics before touching any old rows or observation IDs.
    const retained = isRecheck ? observations.filter(item => item.metric !== metric) : observations;
    const retainedIds = isRecheck ? new Set(retained.map(item => item.observationId)) : observationIds;
    const batchIds = new Set<string>();
    const logicalRows = new Set<string>();
    for (const item of result) {
      validateObservation(diagnosisCase, item);
      if (item.metric !== metric) {
        throw new Error(`Tool returned ${item.metric} while ${metric} was requested`);
      }
      if (batchIds.has(item.observationId) || retainedIds.has(item.observationId)) {
        throw new Error(`Duplicate observationId from tool: ${item.observationId}`);
      }
      batchIds.add(item.observationId);
      const logicalKey = JSON.stringify([item.metric, item.observedDate, item.source]);
      if (logicalRows.has(logicalKey)) {
        throw new Error(`Duplicate metric/date/source row from tool: ${item.metric} ${item.observedDate} ${item.source}`);
      }
      logicalRows.add(logicalKey);
    }
    // Commit only after the whole batch passes validation. A failed recheck
    // retains its predecessor and does not count as a successful call.
    const accepted = result.map(item => ({ ...item }));
    const nextObservations = [...retained, ...accepted];
    const nextIds = new Set([...retainedIds, ...batchIds]);
    observations = nextObservations;
    observationIds = nextIds;
    queriedMetrics.push(metric);
    push({ kind: 'tool_result',
      detail: `${isRecheck ? '复查 ' : ''}${TOOLS[metric]} 返回 ${result.length} 条逐日记录`, metric });
    return { executed: true, reason: 'query completed' };
  }

  const initialTasks: ExecutableTask[] = [
    { id: 'sales', dependsOn: [], anomalySeverity: 1, estimatedCost: 1,
      run: () => query('units_sold') },
    { id: 'traffic', dependsOn: [], anomalySeverity: 0.7, estimatedCost: 1,
      run: () => query('visitors') },
    { id: 'rank', dependsOn: ['sales', 'traffic'], anomalySeverity: 0.8, estimatedCost: 1,
      run: () => {
        const result = rankCauses(diagnosisCase, observations);
        push({ kind: 'rank', detail: `对 ${result.ranking.length} 个候选原因排序` });
        return result;
      } },
    { id: 'verify', dependsOn: ['rank'], anomalySeverity: 0.8, estimatedCost: 1,
      run: results => {
        const result = results.get('rank') as ReturnType<typeof rankCauses>;
        const verdict = verifyConclusion(
          diagnosisCase, observations, result.evidence, result.ranking, queriedMetrics,
          { minSalesDeclineRatio: options.minSalesDeclineRatio });
        push({ kind: 'verify', detail: `${verdict.status}: ${verdict.reason}` });
        return verdict;
      } },
  ];
  const initial = await executeTaskGraph(initialTasks, {
    maxParallel: 2,
    maxRepairRounds,
    shouldRetryFailure: error => !(error instanceof ToolTimeoutError),
    onEvent: event => {
      if (event.kind === 'dispatch') {
        push({ kind: 'schedule', detail: `调度任务：${event.taskIds.join('、')}` });
      } else if (event.kind === 'repair') {
        push({ kind: 'repair', detail: `局部修复，重跑任务：${event.taskIds.join('、')}` });
      }
    },
  });
  let { evidence, ranking } = initial.results.get('rank') as ReturnType<typeof rankCauses>;
  let verification = initial.results.get('verify') as Verification;
  let repairRounds = initial.repairRounds;
  for (let i = 0; i < maxFollowUpQueries; i++) {
    if (verification.status !== 'needs_data' || !verification.nextQuery) break;
    const metric = verification.nextQuery.metric;
    let outcome: QueryOutcome | undefined;
    while (!outcome) {
      try {
        outcome = await query(metric);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof ToolTimeoutError || repairRounds >= maxRepairRounds) {
          verification = {
            caseId: diagnosisCase.caseId,
            status: 'insufficient',
            reason: `补查 ${metric} 失败：${message}；未据此形成结论。`,
          };
          push({ kind: 'tool_result', detail: `补查 ${metric} 失败：${message}`, metric });
          break;
        }
        repairRounds += 1;
        push({ kind: 'repair', detail: `补查 ${metric} 失败，尝试第 ${repairRounds} 次局部重查：${message}`, metric });
      }
    }
    if (!outcome) break;
    if (!outcome.executed) {
      verification = {
        caseId: diagnosisCase.caseId,
        status: 'insufficient',
        reason: `补查 ${metric} 未执行：${outcome.reason}；未据此形成结论。`,
      };
      break;
    }
    ({ evidence, ranking } = rankCauses(diagnosisCase, observations));
    push({ kind: 'rank', detail: `补查 ${metric} 后重新排序 ${ranking.length} 个候选原因`, metric });
    verification = verifyConclusion(diagnosisCase, observations, evidence, ranking, queriedMetrics,
      { minSalesDeclineRatio: options.minSalesDeclineRatio });
    push({ kind: 'verify', detail: `${verification.status}: ${verification.reason}` });
  }
  if (verification.status === 'needs_data') {
    verification = {
      caseId: diagnosisCase.caseId,
      status: 'insufficient',
      reason: `达到最多 ${maxFollowUpQueries} 次补查或无可继续查询的指标，现有证据仍不足。`,
    };
    push({ kind: 'verify', detail: `${verification.status}: ${verification.reason}` });
  }
  push({ kind: 'stop', detail: `诊断结束，共完成 ${queriedMetrics.length} 次指标查询` });

  const chunks: ContextChunk[] = evidence.map(item => ({
    id: item.evidenceId,
    category: item.polarity === 'contradicts' ? 'counter_evidence' : explanationCategory(item.cause),
    fullText: `${item.explanation} Evidence IDs: ${item.observationIds.join(', ')}`,
    summaryText: item.explanation,
    importance: Math.min(1, item.strength * item.quality * item.temporalMatch),
  }));
  const contextBudgetTokens = budgetFromContextWindow(
    options.contextWindowTokens ?? 16_384, options.reservedContextTokens ?? 15_360);
  const context = selectContext(chunks, contextBudgetTokens);
  return {
    provenance: options.provenance ?? 'read-only-tools', synthetic: options.synthetic ?? null,
    diagnosisCase, observations, evidence, ranking, verification,
    queriedMetrics, trace, context, contextBudgetTokens,
    recommendation: recommendation(verification, ranking),
    repairRounds,
  };
}

/** Evaluation adapter: gold labels stay outside diagnoseWithTools and tool results. */
export async function diagnoseFixture(fixture: FixtureCase, options: AgentOptions = {}): Promise<DiagnosisReport> {
  return diagnoseWithTools(fixture.diagnosisCase, {
    queryMetric: metric => queryFixtureMetric(fixture, metric),
    sourceSlug: metric => `synthetic-${metric}`,
  }, { ...options, provenance: 'synthetic-fixture', synthetic: true });
}
