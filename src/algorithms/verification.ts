import {
  type Cause,
  type DiagnosisCase,
  type Evidence,
  type Metric,
  type Observation,
  type RankedHypothesis,
  type Verification,
} from '../domain/contracts.ts';
import { validateDiagnosisCase, validateObservation } from '../domain/validation.ts';

const TOOL_FOR_METRIC: Record<Metric, string> = {
  units_sold: 'get_sku_sales',
  paid_orders: 'get_sku_orders',
  visitors: 'get_sku_traffic',
  stock_on_hand: 'get_sku_inventory',
  price: 'get_sku_price',
  promotion_active: 'get_sku_promotion',
};

const CAUSE_LABEL: Record<Cause, string> = {
  stockout: '缺货',
  traffic_decline: '流量下降',
  conversion_decline: '支付转化下降',
  price_or_promotion_change: '价格或促销变化',
};

const QUERY_COST: Record<Metric, number> = {
  units_sold: 1,
  paid_orders: 1,
  visitors: 1,
  stock_on_hand: 1,
  price: 1.2,
  promotion_active: 1.1,
};

/** Needed for diagnosis; not a claim that the cause has been proven. */
const CAUSE_METRICS: Record<Cause, Metric[]> = {
  stockout: ['stock_on_hand'],
  traffic_decline: ['visitors'],
  conversion_decline: ['paid_orders', 'visitors'],
  price_or_promotion_change: ['price', 'promotion_active'],
};

interface QueryCandidate {
  metric: Metric;
  value: number;
}

export interface VerificationOptions {
  /** Minimum relative fall in average daily sales; 0 accepts any positive fall. */
  minSalesDeclineRatio?: number;
}

const DEFAULT_MIN_SALES_DECLINE_RATIO = 0.1;

function hasWindowCoverage(
  observations: Observation[], metric: Metric, start: string, end: string,
): boolean {
  const days = new Set(observations.filter((row) => row.metric === metric &&
    row.status === 'ok' && row.value !== null && row.observedDate >= start &&
    row.observedDate <= end).map((row) => row.observedDate));
  const windowDays = Math.round((Date.parse(`${end}T00:00:00Z`) -
    Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
  // One isolated day cannot substantiate a trend over a multi-day window.
  return days.size >= Math.ceil(windowDays / 2);
}

function hasSufficientPair(
  diagnosisCase: DiagnosisCase, observations: Observation[], metric: Metric,
): boolean {
  return hasWindowCoverage(observations, metric,
    diagnosisCase.baselineWindow.start, diagnosisCase.baselineWindow.end) &&
    hasWindowCoverage(observations, metric,
      diagnosisCase.anomalyWindow.start, diagnosisCase.anomalyWindow.end);
}

function hasPairedConversionWindowCoverage(
  observations: Observation[], start: string, end: string,
): boolean {
  const orderDays = new Set(observations.filter((row) => row.metric === 'paid_orders' &&
    row.status === 'ok' && row.value !== null && row.observedDate >= start &&
    row.observedDate <= end).map((row) => row.observedDate));
  const visitorDays = new Set(observations.filter((row) => row.metric === 'visitors' &&
    row.status === 'ok' && row.value !== null && row.value > 0 &&
    row.observedDate >= start && row.observedDate <= end).map((row) => row.observedDate));
  const pairedDays = [...orderDays].filter((day) => visitorDays.has(day)).length;
  const windowDays = Math.round((Date.parse(`${end}T00:00:00Z`) -
    Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
  return pairedDays >= Math.ceil(windowDays / 2);
}

function hasSufficientConversionPairs(
  diagnosisCase: DiagnosisCase, observations: Observation[],
): boolean {
  return hasPairedConversionWindowCoverage(observations,
    diagnosisCase.baselineWindow.start, diagnosisCase.baselineWindow.end) &&
    hasPairedConversionWindowCoverage(observations,
      diagnosisCase.anomalyWindow.start, diagnosisCase.anomalyWindow.end);
}

function usableSalesMetric(
  diagnosisCase: DiagnosisCase, observations: Observation[],
): Metric | undefined {
  if (hasSufficientPair(diagnosisCase, observations, 'units_sold')) return 'units_sold';
  if (hasSufficientPair(diagnosisCase, observations, 'paid_orders')) return 'paid_orders';
  return undefined;
}

function candidateCoverageGaps(
  diagnosisCase: DiagnosisCase, observations: Observation[], cause: Cause,
): Metric[] {
  if (cause === 'stockout') {
    return hasWindowCoverage(observations, 'stock_on_hand',
      diagnosisCase.anomalyWindow.start, diagnosisCase.anomalyWindow.end) ? [] : ['stock_on_hand'];
  }
  if (cause === 'traffic_decline') {
    return hasSufficientPair(diagnosisCase, observations, 'visitors') ? [] : ['visitors'];
  }
  if (cause === 'conversion_decline') {
    const individualGaps = (['paid_orders', 'visitors'] as Metric[])
      .filter((metric) => !hasSufficientPair(diagnosisCase, observations, metric));
    return individualGaps.length || hasSufficientConversionPairs(diagnosisCase, observations)
      ? individualGaps : ['paid_orders', 'visitors'];
  }
  return hasSufficientPair(diagnosisCase, observations, 'price') ||
    hasSufficientPair(diagnosisCase, observations, 'promotion_active')
    ? [] : ['price', 'promotion_active'];
}

function averageInWindow(
  observations: Observation[], metric: Metric, start: string, end: string,
): number | null {
  const byDay = new Map<string, number[]>();
  for (const row of observations) {
    if (row.metric !== metric || row.status !== 'ok' || row.value === null ||
        row.observedDate < start || row.observedDate > end) continue;
    const values = byDay.get(row.observedDate) ?? [];
    values.push(row.value);
    byDay.set(row.observedDate, values);
  }
  if (!byDay.size) return null;
  const dailyMeans = [...byDay.values()].map((values) =>
    values.reduce((sum, value) => sum + value, 0) / values.length);
  return dailyMeans.reduce((sum, value) => sum + value, 0) / dailyMeans.length;
}

function salesTrend(
  diagnosisCase: DiagnosisCase, observations: Observation[], minSalesDeclineRatio = DEFAULT_MIN_SALES_DECLINE_RATIO,
): 'missing' | 'declining' | 'below_threshold' {
  const metric = usableSalesMetric(diagnosisCase, observations);
  if (!metric) return 'missing';
  const before = averageInWindow(observations, metric,
    diagnosisCase.baselineWindow.start, diagnosisCase.baselineWindow.end);
  const after = averageInWindow(observations, metric,
    diagnosisCase.anomalyWindow.start, diagnosisCase.anomalyWindow.end);
  if (before === null || after === null || before <= 0) return 'missing';
  const declineRatio = (before - after) / before;
  return declineRatio > 0 && declineRatio >= minSalesDeclineRatio ? 'declining' : 'below_threshold';
}

function dropRatio(diagnosisCase: DiagnosisCase, observations: Observation[], metric: Metric): number | null {
  const before = averageInWindow(observations, metric,
    diagnosisCase.baselineWindow.start, diagnosisCase.baselineWindow.end);
  const after = averageInWindow(observations, metric,
    diagnosisCase.anomalyWindow.start, diagnosisCase.anomalyWindow.end);
  return before !== null && after !== null && before > 0 ? (before - after) / before : null;
}

function needsUpstreamCheck(
  diagnosisCase: DiagnosisCase, observations: Observation[], top: RankedHypothesis,
): { metric: Metric; reason: string } | undefined {
  if (top.cause === 'conversion_decline') {
    if (!hasSufficientPair(diagnosisCase, observations, 'promotion_active')) {
      return { metric: 'promotion_active', reason: '转化率下降可能是促销结束的下游表现' };
    }
    if (!hasSufficientPair(diagnosisCase, observations, 'price')) {
      return { metric: 'price', reason: '转化率下降可能是涨价的下游表现' };
    }
  }
  if (top.cause === 'traffic_decline') {
    const salesMetric = usableSalesMetric(diagnosisCase, observations);
    const salesDrop = salesMetric ? dropRatio(diagnosisCase, observations, salesMetric) : null;
    const visitorDrop = dropRatio(diagnosisCase, observations, 'visitors');
    const inventorySeen = hasWindowCoverage(observations, 'stock_on_hand',
      diagnosisCase.anomalyWindow.start, diagnosisCase.anomalyWindow.end);
    if (!inventorySeen && salesDrop !== null && visitorDrop !== null &&
        salesDrop > visitorDrop + 0.15) {
      return { metric: 'stock_on_hand', reason: '销量跌幅明显大于流量跌幅，需排查缺货是否叠加影响' };
    }
  }
  return undefined;
}

function addCandidate(candidates: Map<Metric, number>, metric: Metric, weight: number): void {
  candidates.set(metric, (candidates.get(metric) ?? 0) + weight);
}

function conflictingMetrics(observations: Observation[]): Metric[] {
  const byDayMetric = new Map<string, { metric: Metric; values: number[] }>();
  for (const row of observations) {
    if (row.status !== 'ok' || row.value === null) continue;
    const key = `${row.metric}:${row.observedDate}`;
    const group = byDayMetric.get(key) ?? { metric: row.metric, values: [] };
    group.values.push(row.value);
    byDayMetric.set(key, group);
  }
  const conflicts = new Set<Metric>();
  for (const { metric, values } of byDayMetric.values()) {
    if (values.length < 2) continue;
    const spread = Math.max(...values) - Math.min(...values);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    if (metric === 'promotion_active' ? spread > 0 : spread > Math.max(1, mean * 0.2)) {
      conflicts.add(metric);
    }
  }
  return [...conflicts];
}

function materialLowQualityAlternatives(
  observations: Observation[], evidence: Evidence[], ranking: RankedHypothesis[],
): Metric[] {
  const top = ranking[0];
  const byId = new Map(observations.map((row) => [row.observationId, row]));
  const metrics = new Set<Metric>();
  for (const alternative of ranking.slice(1)) {
    const weakSupport = evidence.filter((item) => item.cause === alternative.cause &&
      item.polarity === 'supports' && item.quality < 0.55);
    // Estimate the score this alternative could reach if the same observations
    // were confirmed by a reliable source. This is a prioritization bound,
    // not an estimated probability of the alternative being true.
    const possibleScore = alternative.score + weakSupport.reduce((sum, item) =>
      sum + item.strength * item.temporalMatch * (1 - item.quality), 0);
    if (possibleScore < top.score - 0.15) continue;
    for (const item of weakSupport) {
      for (const id of item.observationIds) {
        const metric = byId.get(id)?.metric;
        if (metric) metrics.add(metric);
      }
    }
  }
  return [...metrics];
}

function selectNextQuery(
  diagnosisCase: DiagnosisCase,
  observations: Observation[],
  evidence: Evidence[],
  ranking: RankedHypothesis[],
  queriedMetrics: Metric[],
  conflicts: Metric[],
  materialWeakAlternatives: Metric[],
  coverageGaps: Metric[],
): QueryCandidate | undefined {
  const candidates = new Map<Metric, number>();
  const eligibleForRecheck = new Set<Metric>([...conflicts, ...materialWeakAlternatives]);
  const top = ranking[0];
  const runner = ranking[1];

  const upstreamCheck = needsUpstreamCheck(diagnosisCase, observations, top);
  if (upstreamCheck) addCandidate(candidates, upstreamCheck.metric, 7);
  for (const metric of conflicts) addCandidate(candidates, metric, 20);
  for (const metric of materialWeakAlternatives) addCandidate(candidates, metric, 12);
  for (const metric of coverageGaps) addCandidate(candidates, metric, 10);

  // First establish that the reported sales decline exists.
  if (salesTrend(diagnosisCase, observations) === 'missing') {
    if (!hasSufficientPair(diagnosisCase, observations, 'units_sold')) {
      addCandidate(candidates, 'units_sold', 15);
    }
    if (!hasSufficientPair(diagnosisCase, observations, 'paid_orders')) {
      addCandidate(candidates, 'paid_orders', 14);
    }
  }

  for (const metric of top.missingMetrics) addCandidate(candidates, metric, 4.5);
  if (runner && top.score - runner.score < 0.25) {
    for (const metric of runner.missingMetrics) addCandidate(candidates, metric, 1.5);
  }

  const byId = new Map(observations.map((row) => [row.observationId, row]));
  const relevant = evidence.filter((item) => item.cause === top.cause ||
    (runner && top.score - runner.score < 0.25 && item.cause === runner.cause));
  for (const item of relevant) {
    // Requery stale or directly conflicting measurements. A timestamp-only
    // contradiction should not by itself cause the same query to repeat.
    if (item.quality >= 0.55 && !item.explanation.includes('相互冲突')) continue;
    const implicatedMetrics = new Set(item.observationIds.map((id) => byId.get(id)?.metric));
    for (const metric of implicatedMetrics) {
      if (metric) {
        eligibleForRecheck.add(metric);
        addCandidate(candidates, metric, item.explanation.includes('相互冲突') ? 3 : 2);
      }
    }
  }

  // If two plausible causes remain tied, query the input that best separates
  // their requirements, provided it is not already present and reliable.
  if (runner && top.score - runner.score < 0.25) {
    const separating = CAUSE_METRICS[runner.cause].filter((metric) =>
      !CAUSE_METRICS[top.cause].includes(metric));
    for (const metric of separating) {
      if (!hasSufficientPair(diagnosisCase, observations, metric)) addCandidate(candidates, metric, 1.2);
    }
  }

  const queryCounts = new Map<Metric, number>();
  for (const metric of queriedMetrics) queryCounts.set(metric, (queryCounts.get(metric) ?? 0) + 1);
  return [...candidates]
    .filter(([metric]) => {
      const count = queryCounts.get(metric) ?? 0;
      return count === 0 || (count === 1 && eligibleForRecheck.has(metric));
    })
    .map(([metric, weight]) => ({ metric, value: weight / QUERY_COST[metric] }))
    .sort((a, b) => b.value - a.value || a.metric.localeCompare(b.metric))[0];
}

/**
 * Verify the leading ranked explanation and suggest at most one next read-only
 * query. The caller must pass the suggestion through its tool permission gate.
 * `queriedMetrics` records successful query executions, including repeated
 * metrics. Conflicting or low-quality measurements can be queried once more;
 * all other measurements are queried at most once.
 */
export function verifyConclusion(
  diagnosisCase: DiagnosisCase,
  observations: Observation[],
  evidence: Evidence[],
  ranking: RankedHypothesis[],
  queriedMetrics: Metric[] = [],
  options: VerificationOptions = {},
): Verification {
  const minSalesDeclineRatio = options.minSalesDeclineRatio ?? DEFAULT_MIN_SALES_DECLINE_RATIO;
  if (!Number.isFinite(minSalesDeclineRatio) || minSalesDeclineRatio < 0 || minSalesDeclineRatio > 1) {
    throw new RangeError('minSalesDeclineRatio must be a finite number between 0 and 1');
  }
  validateDiagnosisCase(diagnosisCase);
  for (const row of observations) validateObservation(diagnosisCase, row);
  if (!ranking.length) {
    return { caseId: diagnosisCase.caseId, status: 'insufficient', reason: '没有可核验的候选原因' };
  }
  if (ranking.some((item) => item.caseId !== diagnosisCase.caseId) ||
      evidence.some((item) => item.caseId !== diagnosisCase.caseId)) {
    throw new Error('Ranking or evidence caseId does not match diagnosis');
  }
  const observationIds = new Set(observations.map((row) => row.observationId));
  if (evidence.some((item) => item.observationIds.some((id) => !observationIds.has(id)))) {
    throw new Error('Evidence references an unknown observation');
  }
  const byEvidenceId = new Map(evidence.map((item) => [item.evidenceId, item]));
  if (byEvidenceId.size !== evidence.length) throw new Error('Duplicate evidenceId');
  for (const item of ranking) {
    const references: Array<[string, Evidence['polarity']]> = [
      ...item.supportEvidenceIds.map((id): [string, Evidence['polarity']] => [id, 'supports']),
      ...item.contradictionEvidenceIds.map((id): [string, Evidence['polarity']] => [id, 'contradicts']),
    ];
    if (new Set(references.map(([id]) => id)).size !== references.length ||
        references.some(([id, polarity]) => {
          const linked = byEvidenceId.get(id);
          return !linked || linked.cause !== item.cause || linked.polarity !== polarity;
        })) {
      throw new Error('Ranking references invalid evidence');
    }
  }
  const top = ranking[0];
  const runner = ranking[1];
  const supports = top.supportEvidenceIds.map((id) => byEvidenceId.get(id)).filter((item): item is Evidence => !!item);
  const contradicts = top.contradictionEvidenceIds.map((id) => byEvidenceId.get(id)).filter((item): item is Evidence => !!item);
  const supportWeight = supports.reduce((sum, item) => sum +
    item.strength * item.quality * item.temporalMatch, 0);
  const contradictionWeight = contradicts.reduce((sum, item) => sum + item.strength * item.quality, 0);
  const bestQuality = Math.max(0, ...supports.map((item) => item.quality));
  const trend = salesTrend(diagnosisCase, observations, minSalesDeclineRatio);
  if (trend === 'below_threshold') {
    return { caseId: diagnosisCase.caseId, status: 'insufficient',
      reason: `商品销量降幅未达到异常判断阈值（${(minSalesDeclineRatio * 100).toFixed(1)}%），无法核验异常原因` };
  }

  const conflicts = conflictingMetrics(observations);
  const materialWeakAlternatives = materialLowQualityAlternatives(observations, evidence, ranking);
  const coverageGaps = candidateCoverageGaps(diagnosisCase, observations, top.cause);
  const next = selectNextQuery(diagnosisCase, observations, evidence, ranking, queriedMetrics,
    conflicts, materialWeakAlternatives, coverageGaps);
  const upstreamCheck = needsUpstreamCheck(diagnosisCase, observations, top);
  const unresolved = trend === 'missing' || top.missingMetrics.length > 0 || bestQuality < 0.55 ||
    contradictionWeight >= 0.3 || upstreamCheck !== undefined || conflicts.length > 0 ||
    materialWeakAlternatives.length > 0 || coverageGaps.length > 0 ||
    (runner && top.score - runner.score < 0.15);
  if (unresolved && next) {
    return {
      caseId: diagnosisCase.caseId,
      status: 'needs_data',
      reason: trend === 'missing' ? '缺少可核对的销量基线与异常期数据' :
        conflicts.length ? '同一日期的指标来源相互冲突，需优先核对该指标' :
        materialWeakAlternatives.length ? '低质量的竞争原因证据可能改变排序，需补查' :
        upstreamCheck ? upstreamCheck.reason :
        contradictionWeight >= 0.3 ? '当前结论存在反对或冲突证据，需要补查' :
        '候选原因所需证据缺失、过期或难以区分，需要补查',
      nextQuery: { toolName: TOOL_FOR_METRIC[next.metric], metric: next.metric },
    };
  }

  if (trend === 'missing' || top.missingMetrics.length > 0 || coverageGaps.length > 0) {
    return { caseId: diagnosisCase.caseId, status: 'insufficient',
      reason: '必要指标缺失或日期覆盖不足，且没有可继续执行的补查查询' };
  }
  if (conflicts.length || materialWeakAlternatives.length) {
    return { caseId: diagnosisCase.caseId, status: 'insufficient',
      reason: '关键指标冲突或竞争原因证据质量不足，且没有可继续执行的补查查询' };
  }
  if (upstreamCheck) {
    return { caseId: diagnosisCase.caseId, status: 'insufficient',
      reason: `${upstreamCheck.reason}，但相关数据未取得，暂不能将当前候选作为单一原因` };
  }
  if (contradictionWeight >= 0.3 && contradictionWeight >= supportWeight * 0.75) {
    return { caseId: diagnosisCase.caseId, status: 'contradicted',
      reason: '候选原因受到较强反对证据约束，不能作为已核验结论' };
  }
  if (supportWeight >= 0.35 && bestQuality >= 0.55 && contradictionWeight < 0.3 &&
      (!runner || top.score - runner.score >= 0.15)) {
    const laterStockout = ranking.find((item) => item.cause === 'stockout' && item.cause !== top.cause);
    const laterContribution = laterStockout && laterStockout.score > 0.25 &&
      evidence.some((item) => item.cause === 'stockout' && item.polarity === 'supports' &&
        item.explanation.includes('后续加重因素'));
    return { caseId: diagnosisCase.caseId, status: 'supported',
      reason: laterContribution
        ? `现有证据支持${CAUSE_LABEL[top.cause]}为初始可能原因，缺货可能是后续加重因素；排序分数不是因果概率`
        : `现有证据支持将${CAUSE_LABEL[top.cause]}列为优先排查的可能原因；排序分数不是因果概率` };
  }
  return { caseId: diagnosisCase.caseId, status: 'insufficient',
    reason: '现有证据不足以区分候选原因，不能确定异常原因' };
}
