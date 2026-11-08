/**
 * Hand-authored boundary and mechanism-sensitivity probes.
 * These cases are separate from the labelled business holdout corpus and MUST
 * NOT be presented as a diagnosis accuracy estimate or an independent sample.
 */
import { METRIC_UNITS, SCHEMA_VERSION, type Cause, type DiagnosisCase, type Metric, type Observation } from '../src/domain/contracts.ts';
import { rankCauses } from '../src/algorithms/ranking.ts';
import { verifyConclusion } from '../src/algorithms/verification.ts';
import { decideToolCall, type ToolCallRequest, type ToolGateContext } from '../src/algorithms/tool-gate.ts';
import { getLocalRepairPlan, getReadyTasks, type TaskNode } from '../src/algorithms/scheduler.ts';
import { estimateTokensHeuristic, selectContext } from '../src/algorithms/context-budget.ts';
import { diagnoseFixture } from '../src/agent/diagnose.ts';
import type { FixtureCase } from '../src/data/fixtures.ts';

export interface StressCaseResult {
  id: string;
  expected: string;
  actual: string;
  pass: boolean;
  /** Distinguishes a contract check from a mechanism probe or a business scenario. */
  note: string;
}

export interface StressEvaluation {
  sampleCount: number;
  cases: StressCaseResult[];
  /** Percentage of fixed probes passing; not real-world diagnosis accuracy. */
  passRate: number;
}

const DAYS = Array.from({ length: 8 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`);
const METRICS: Metric[] = ['units_sold', 'paid_orders', 'visitors', 'stock_on_hand', 'price', 'promotion_active'];
const BASE: Record<Metric, readonly (number | null)[]> = {
  units_sold: [40, 41, 39, 40, 20, 18, 17, 16],
  paid_orders: [38, 39, 37, 38, 18, 16, 15, 14],
  visitors: [400, 404, 396, 400, 400, 402, 398, 401],
  stock_on_hand: [50, 50, 50, 50, 50, 50, 50, 50],
  price: [100, 100, 100, 100, 100, 100, 100, 100],
  promotion_active: [1, 1, 1, 1, 1, 1, 1, 1],
};

/** Each override is a literal eight-day series chosen before evaluating the algorithms. */
function authoredCase(
  id: string,
  overrides: Partial<Record<Metric, readonly (number | null)[]>> = {},
  options: { staleMetrics?: readonly Metric[]; goldCauses?: Cause[]; scenario?: FixtureCase['scenario'] } = {},
): FixtureCase {
  const diagnosisCase: DiagnosisCase = {
    schemaVersion: SCHEMA_VERSION,
    caseId: id, storeId: 'stress-store-A', skuId: 'stress-sku-01',
    baselineWindow: { start: DAYS[0]!, end: DAYS[3]! },
    anomalyWindow: { start: DAYS[4]!, end: DAYS[7]! },
  };
  const observations: Observation[] = METRICS.flatMap(metric => {
    const values = overrides[metric] ?? BASE[metric];
    if (values.length !== DAYS.length) throw new Error(`Stress series ${metric} must contain eight values`);
    return values.map((value, i) => ({
      schemaVersion: SCHEMA_VERSION,
      observationId: `${id}:${metric}:${i}`,
      caseId: id,
      storeId: diagnosisCase.storeId,
      skuId: diagnosisCase.skuId,
      observedDate: DAYS[i]!, metric, value,
      unit: METRIC_UNITS[metric], source: `stress-${metric}`,
      sourceUpdatedAt: value === null ? null : options.staleMetrics?.includes(metric)
        ? '2026-08-01T20:00:00.000Z' : `${DAYS[i]}T20:00:00.000Z`,
      fetchedAt: `${DAYS[i]}T22:00:00.000Z`,
      status: value === null ? 'missing' as const : 'ok' as const,
    }));
  });
  return {
    diagnosisCase, observations, goldCauses: options.goldCauses ?? [],
    scenario: options.scenario ?? 'insufficient', split: 'holdout', variant: 0,
  };
}

const STOCKOUT = {
  units_sold: [40, 41, 39, 40, 20, 0, 0, 0],
  paid_orders: [38, 39, 37, 38, 18, 0, 0, 0],
  stock_on_hand: [50, 50, 50, 50, 4, 0, 0, 0],
} as const;

function stockScore(fixture: FixtureCase, options: Parameters<typeof rankCauses>[2] = {}): number {
  return rankCauses(fixture.diagnosisCase, fixture.observations, options)
    .ranking.find(item => item.cause === 'stockout')?.score ?? NaN;
}

function priceScore(fixture: FixtureCase, options: Parameters<typeof rankCauses>[2] = {}): number {
  return rankCauses(fixture.diagnosisCase, fixture.observations, options)
    .ranking.find(item => item.cause === 'price_or_promotion_change')?.score ?? NaN;
}

function record(id: string, expected: string, actual: string, pass: boolean, note: string): StressCaseResult {
  return { id, expected, actual, pass, note };
}

function thrownMessage(action: () => unknown): string {
  try { action(); return '未拒绝'; }
  catch (error) { return error instanceof Error ? error.message : String(error); }
}

const request: ToolCallRequest = {
  caseId: 'stress-gate', toolName: 'get_sku_inventory', sourceSlug: 'commerce',
  metric: 'stock_on_hand', operation: 'read', businessRisk: 0.1,
};
const gateContext: ToolGateContext = {
  permissionMode: 'safe', activeSourceSlugs: new Set(['commerce']),
  sourceStates: { commerce: 'healthy' }, allowedMetrics: new Set(['stock_on_hand']),
  toolMetrics: { get_sku_inventory: ['stock_on_hand'] }, prerequisiteMet: true,
};

/** Runs deterministic checks; failures remain visible instead of being filtered out. */
export async function evaluateStress(): Promise<StressEvaluation> {
  const cases: StressCaseResult[] = [];
  const stockout = authoredCase('stress-measured-zero', STOCKOUT, {
    goldCauses: ['stockout'], scenario: 'stockout',
  });

  // Identity and measurement contracts: these are parser/validation checks.
  const otherStore = stockout.observations.map((row, i) => i === 0 ? { ...row, storeId: 'stress-store-B' } : row);
  const storeError = thrownMessage(() => rankCauses(stockout.diagnosisCase, otherStore));
  cases.push(record('cross-store-isolation', '拒绝跨门店观测', storeError,
    /does not match/.test(storeError), '数据契约检查；不计入业务诊断准确率。'));

  const otherSku = stockout.observations.map((row, i) => i === 0 ? { ...row, skuId: 'other-sku' } : row);
  const skuError = thrownMessage(() => rankCauses(stockout.diagnosisCase, otherSku));
  cases.push(record('cross-sku-isolation', '拒绝跨 SKU 观测', skuError,
    /does not match/.test(skuError), '数据契约检查；验证商品隔离。'));

  const stockResult = rankCauses(stockout.diagnosisCase, stockout.observations);
  const zeroSupport = stockResult.evidence.some(item => item.cause === 'stockout' && item.polarity === 'supports');
  cases.push(record('measured-zero-inventory', '库存 0 作为有效缺货证据',
    `缺货支持证据=${zeroSupport}；排序首位=${stockResult.ranking[0]?.cause}`,
    zeroSupport && stockResult.ranking[0]?.cause === 'stockout',
    '手工经营边界场景；只验证零值语义和候选排序。'));

  const missingStock = authoredCase('stress-missing-stock', {
    stock_on_hand: [50, 50, 50, 50, null, null, null, null],
  });
  const missingResult = rankCauses(missingStock.diagnosisCase, missingStock.observations);
  const missingAsZero = missingResult.evidence.some(item => item.cause === 'stockout' && item.polarity === 'supports');
  const missingFlag = missingResult.ranking.find(item => item.cause === 'stockout')?.missingMetrics.includes('stock_on_hand') ?? false;
  cases.push(record('missing-is-not-zero', '缺失库存不产生缺货证据，保留缺失标记',
    `缺货支持证据=${missingAsZero}；缺失标记=${missingFlag}`,
    !missingAsZero && missingFlag, '数据语义检查；与上一个零值案例成对比较。'));

  // Mechanism sensitivity: turn exactly one ranking component off each time.
  const staleStock = authoredCase('stress-stale-stock', STOCKOUT, { staleMetrics: ['stock_on_hand'] });
  const qualityOn = stockScore(staleStock);
  const qualityOff = stockScore(staleStock, { useQuality: false });
  const staleRanking = rankCauses(staleStock.diagnosisCase, staleStock.observations);
  const staleVerdict = verifyConclusion(staleStock.diagnosisCase, staleStock.observations,
    staleRanking.evidence, staleRanking.ranking);
  cases.push(record('quality-ablation-stale-stock', '开启质量权重时过期库存的缺货分数更低',
    `默认=${qualityOn.toFixed(4)}；去质量=${qualityOff.toFixed(4)}；核验=${staleVerdict.status}`,
    qualityOn < qualityOff,
    '机制敏感性；固定旧时间戳，仅切换 useQuality。整体核验可能支持其他原因，故不把它纳入本项判定。'));

  const latePrice = authoredCase('stress-late-price', {
    price: [100, 100, 100, 100, 100, 100, 100, 130],
  }, { goldCauses: [], scenario: 'insufficient' });
  const timeOn = priceScore(latePrice);
  const timeOff = priceScore(latePrice, { useTemporal: false });
  const lateReason = rankCauses(latePrice.diagnosisCase, latePrice.observations).evidence
    .some(item => item.cause === 'price_or_promotion_change' && item.explanation.includes('晚于'));
  cases.push(record('temporal-ablation-late-price', '涨价晚于销量下降时，默认分数低于去时序版本',
    `默认=${timeOn.toFixed(4)}；去时序=${timeOff.toFixed(4)}；迟到证据=${lateReason}`,
    timeOn < timeOff && lateReason,
    '机制敏感性；固定第 8 天涨价、第 5 天销量下跌，仅切换 useTemporal。'));

  const conflict = authoredCase('stress-conflicting-stock', STOCKOUT);
  const zeroDay = conflict.observations.find(row => row.metric === 'stock_on_hand' && row.observedDate === DAYS[5]);
  if (!zeroDay) throw new Error('Authored conflict case has no zero-stock day');
  conflict.observations.push({ ...zeroDay, observationId: `${conflict.diagnosisCase.caseId}:stock-conflict`, value: 50, source: 'stress-second-inventory' });
  const counterOn = stockScore(conflict);
  const counterOff = stockScore(conflict, { useCounterEvidence: false });
  const conflictResult = rankCauses(conflict.diagnosisCase, conflict.observations);
  const contradiction = conflictResult.evidence.some(item => item.cause === 'stockout' && item.polarity === 'contradicts' && item.explanation.includes('冲突'));
  cases.push(record('counterevidence-ablation-conflict', '冲突反证压低缺货分数',
    `默认=${counterOn.toFixed(4)}；去反证=${counterOff.toFixed(4)}；冲突记录=${contradiction}`,
    counterOn < counterOff && contradiction,
    '机制敏感性；固定同日库存 0 与 50 的冲突，仅切换 useCounterEvidence。'));

  const conflictVerdict = verifyConclusion(conflict.diagnosisCase, conflict.observations,
    conflictResult.evidence, conflictResult.ranking);
  cases.push(record('conflict-targeted-recheck', '库存冲突触发库存定向补查',
    `${conflictVerdict.status}；下个指标=${conflictVerdict.nextQuery?.metric ?? '无'}`,
    conflictVerdict.status === 'needs_data' && conflictVerdict.nextQuery?.metric === 'stock_on_hand',
    '跨模块边界：排序反证进入结论核验与补查选择。'));

  const mixed = authoredCase('stress-mixed', {
    units_sold: [40, 41, 39, 40, 20, 0, 0, 0],
    paid_orders: [38, 39, 37, 38, 18, 0, 0, 0],
    visitors: [400, 404, 396, 400, 230, 220, 215, 225],
    stock_on_hand: [50, 50, 50, 50, 8, 0, 0, 0],
  }, { goldCauses: ['stockout', 'traffic_decline'], scenario: 'mixed' });
  const mixedTopTwo = rankCauses(mixed.diagnosisCase, mixed.observations).ranking.slice(0, 2).map(item => item.cause);
  cases.push(record('mixed-cause-top-two', '混因案例前两位覆盖流量下降与缺货',
    `前两位=${mixedTopTwo.join(',')}`,
    mixedTopTwo.includes('stockout') && mixedTopTwo.includes('traffic_decline'),
    '手工经营边界场景；一个案例的 Top-2 检查不代表总体准确率。'));

  // Deterministic permission, DAG, and context checks.
  const approval = decideToolCall({ ...request, businessRisk: 0.9 }, gateContext).action;
  cases.push(record('high-risk-approval', '高风险只读调用需审批', approval,
    approval === 'request_approval', '工具策略契约检查；没有真实外部工具副作用。'));

  const safeWrite = decideToolCall({ ...request, operation: 'write', businessRisk: 0.9 },
    { ...gateContext, approvalGranted: true }).action;
  cases.push(record('safe-mode-write-block', '安全模式即使已有审批也阻止写操作', safeWrite,
    safeWrite === 'block', '权限边界；不尝试执行写操作。'));

  const staleSource = decideToolCall(request, {
    ...gateContext, sourceStates: { commerce: 'stale' },
  }).action;
  cases.push(record('stale-source-block', '过期数据源阻止工具调用', staleSource,
    staleSource === 'block', '数据源状态契约检查。'));

  const graph: TaskNode[] = [
    { id: 'sales', dependsOn: [], anomalySeverity: 1, estimatedCost: 1 },
    { id: 'traffic', dependsOn: [], anomalySeverity: 0.5, estimatedCost: 1 },
    { id: 'stock', dependsOn: [], anomalySeverity: 0.8, estimatedCost: 1 },
    { id: 'rank', dependsOn: ['sales', 'stock'], anomalySeverity: 0.7, estimatedCost: 1 },
    { id: 'verify', dependsOn: ['rank', 'traffic'], anomalySeverity: 0.6, estimatedCost: 1 },
  ];
  const repair = getLocalRepairPlan(graph, ['stock']);
  cases.push(record('local-repair-frontier', '库存节点失败只重跑库存、排序、核验',
    `重跑=${repair.rerunIds.join(',')}；保留=${repair.preserveIds.join(',')}`,
    JSON.stringify(repair.rerunIds) === JSON.stringify(['stock', 'rank', 'verify']) &&
    JSON.stringify(repair.preserveIds) === JSON.stringify(['sales', 'traffic']),
    '任务图算法边界；不包含实际工具延迟。'));

  const cycleError = thrownMessage(() => getReadyTasks([
    { id: 'a', dependsOn: ['b'], anomalySeverity: 1, estimatedCost: 1 },
    { id: 'b', dependsOn: ['a'], anomalySeverity: 1, estimatedCost: 1 },
  ], new Set(), new Set(), 2));
  cases.push(record('dag-cycle-rejected', '循环依赖在调度前被拒绝', cycleError,
    /cycle/.test(cycleError), '图结构契约检查。'));

  const denseText = 'A'.repeat(30_000);
  const context = selectContext([
    { id: 'bulk', category: 'other', fullText: denseText, summaryText: '编码数据，未包含经营指标' },
    { id: 'sales', category: 'sales_change', fullText: '销量从每日 40 件降为 20 件。', summaryText: '销量下降 50%' },
    { id: 'stock', category: 'stockout', fullText: '库存第 6 天为 0 件。', summaryText: '第 6 天缺货' },
  ], 100);
  const densityEstimate = estimateTokensHeuristic(denseText);
  const selectedIds = context.items.map(item => item.id);
  cases.push(record('dense-context-preserves-evidence', '密集长结果被摘要，销量与缺货证据保留且不超代理预算',
    `密集估算=${densityEstimate}；选中=${selectedIds.join(',')}；预算=${context.estimatedTokens}/100`,
    densityEstimate > Math.ceil(denseText.length / 4) &&
    context.items.find(item => item.id === 'bulk')?.mode === 'summary' &&
    selectedIds.includes('sales') && selectedIds.includes('stock') && context.estimatedTokens <= 100,
    '上下文机制检查；Token 是启发式代理，未调用模型 tokenizer。'));

  const blockedRun = await diagnoseFixture(stockout, { blockedMetrics: ['stock_on_hand'], maxFollowUpQueries: 4 });
  const blockedDecision = blockedRun.trace.some(item => item.kind === 'tool_decision' &&
    item.metric === 'stock_on_hand' && item.decision === 'block');
  cases.push(record('blocked-recheck-stops', '库存补查被权限阻止后不执行该指标且有界停止',
    `阻止事件=${blockedDecision}；已查=${blockedRun.queriedMetrics.join(',')}；轨迹=${blockedRun.trace.length}`,
    blockedDecision && !blockedRun.queriedMetrics.includes('stock_on_hand') && blockedRun.trace.length < 30,
    '跨模块边界：核验建议仍须经过工具门控；没有真实数据源调用。'));

  return {
    sampleCount: cases.length,
    cases,
    passRate: Math.round(cases.filter(item => item.pass).length / cases.length * 10_000) / 100,
  };
}
