import { makeCorpus, queryFixtureMetric, type FixtureCase } from '../src/data/fixtures.ts';
import type { Cause, Metric, Observation } from '../src/domain/contracts.ts';
import { rankCauses } from '../src/algorithms/ranking.ts';
import { verifyConclusion } from '../src/algorithms/verification.ts';
import { diagnoseFixture } from '../src/agent/diagnose.ts';

type MetricResult = { name: string; baseline: number; full: number; unit: string; better: 'higher' | 'lower' };
export interface ModuleEvaluation {
  id: string;
  name: string;
  sampleCount: number;
  metrics: MetricResult[];
  ablations?: Record<string, unknown>;
  details?: Record<string, unknown>;
}

const avg = (items: number[]): number => items.length ? items.reduce((a, b) => a + b, 0) / items.length : 0;
const round = (value: number): number => Math.round(value * 10000) / 10000;

function mean(fixture: FixtureCase, observations: Observation[], metric: Metric, window: 'baseline' | 'anomaly'): number | null {
  const period = window === 'baseline' ? fixture.diagnosisCase.baselineWindow : fixture.diagnosisCase.anomalyWindow;
  const values = observations.filter(row => row.metric === metric && row.status === 'ok' && row.value !== null &&
    row.observedDate >= period.start && row.observedDate <= period.end).map(row => row.value as number);
  return values.length ? avg(values) : null;
}

function drop(before: number | null, after: number | null): number {
  return before && after !== null ? (before - after) / before : 0;
}

/** Transparent fixed-priority rules with no evidence scoring. */
function fixedRuleCandidates(fixture: FixtureCase, observations: Observation[]): Cause[] {
  const candidates: Cause[] = [];
  const stock = observations.filter(row => row.metric === 'stock_on_hand' && row.status === 'ok' &&
    row.observedDate >= fixture.diagnosisCase.anomalyWindow.start &&
    row.observedDate <= fixture.diagnosisCase.anomalyWindow.end).map(row => row.value);
  if (stock.includes(0)) candidates.push('stockout');
  if (drop(mean(fixture, observations, 'visitors', 'baseline'), mean(fixture, observations, 'visitors', 'anomaly')) > 0.15) {
    candidates.push('traffic_decline');
  }
  const baseOrders = mean(fixture, observations, 'paid_orders', 'baseline');
  const currentOrders = mean(fixture, observations, 'paid_orders', 'anomaly');
  const baseVisitors = mean(fixture, observations, 'visitors', 'baseline');
  const currentVisitors = mean(fixture, observations, 'visitors', 'anomaly');
  if (baseOrders !== null && currentOrders !== null && baseVisitors && currentVisitors &&
    drop(baseOrders / baseVisitors, currentOrders / currentVisitors) > 0.15) candidates.push('conversion_decline');
  const basePrice = mean(fixture, observations, 'price', 'baseline');
  const currentPrice = mean(fixture, observations, 'price', 'anomaly');
  const basePromotion = mean(fixture, observations, 'promotion_active', 'baseline');
  const currentPromotion = mean(fixture, observations, 'promotion_active', 'anomaly');
  if ((basePrice && currentPrice && currentPrice > basePrice * 1.03) ||
    (basePromotion !== null && currentPromotion !== null && currentPromotion < basePromotion)) {
    candidates.push('price_or_promotion_change');
  }
  return candidates;
}

function pairedBootstrapDifferences(base: number[], full: number[], repeats = 2000): [number, number] {
  if (base.length !== full.length || base.length === 0) return [0, 0];
  let state = 20261023;
  const random = () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 2 ** 32;
  };
  const differences: number[] = [];
  for (let i = 0; i < repeats; i++) {
    let total = 0;
    for (let j = 0; j < base.length; j++) {
      const index = Math.floor(random() * base.length);
      total += full[index]! - base[index]!;
    }
    differences.push(total / base.length);
  }
  differences.sort((a, b) => a - b);
  return [round(differences[Math.floor(repeats * 0.025)]!), round(differences[Math.floor(repeats * 0.975)]!)];
}

function rankCorrect(fixture: FixtureCase, cause: Cause | undefined): number {
  return cause && fixture.goldCauses.includes(cause) ? 1 : 0;
}

export function evaluateRanking(): ModuleEvaluation {
  const cases = makeCorpus().filter(item => item.split === 'holdout');
  const single = cases.filter(item => item.goldCauses.length === 1);
  const rows = single.map(fixture => {
    const baseline = fixedRuleCandidates(fixture, fixture.observations)[0];
    const full = rankCauses(fixture.diagnosisCase, fixture.observations).ranking[0]?.cause;
    const noTemporal = rankCauses(fixture.diagnosisCase, fixture.observations, { useTemporal: false }).ranking[0]?.cause;
    const noQuality = rankCauses(fixture.diagnosisCase, fixture.observations, { useQuality: false }).ranking[0]?.cause;
    const noCounterEvidence = rankCauses(fixture.diagnosisCase, fixture.observations,
      { useCounterEvidence: false }).ranking[0]?.cause;
    return {
      caseId: fixture.diagnosisCase.caseId,
      skuId: fixture.diagnosisCase.skuId,
      scenario: fixture.scenario,
      gold: fixture.goldCauses,
      baseline, full,
      baselineCorrect: rankCorrect(fixture, baseline),
      fullCorrect: rankCorrect(fixture, full),
      noTemporalCorrect: rankCorrect(fixture, noTemporal),
      noQualityCorrect: rankCorrect(fixture, noQuality),
      noCounterEvidenceCorrect: rankCorrect(fixture, noCounterEvidence),
    };
  });
  const mixed = cases.filter(item => item.scenario === 'mixed');
  const mixedBaselineRecall = avg(mixed.map(fixture => {
    const predicted = fixedRuleCandidates(fixture, fixture.observations).slice(0, 2);
    return fixture.goldCauses.filter(cause => predicted.includes(cause)).length / fixture.goldCauses.length;
  }));
  const mixedTopTwoRecall = avg(mixed.map(fixture => {
    const topTwo = rankCauses(fixture.diagnosisCase, fixture.observations).ranking.slice(0, 2).map(item => item.cause);
    return fixture.goldCauses.filter(cause => topTwo.includes(cause)).length / fixture.goldCauses.length;
  }));
  return {
    id: 'module4', name: '多源证据异常原因排序', sampleCount: rows.length + mixed.length,
    metrics: [
      { name: '单原因 Top-1 准确率', baseline: round(avg(rows.map(row => row.baselineCorrect))),
        full: round(avg(rows.map(row => row.fullCorrect))), unit: 'ratio', better: 'higher' },
      { name: '混合原因 Top-2 召回率', baseline: round(mixedBaselineRecall),
        full: round(mixedTopTwoRecall), unit: 'ratio', better: 'higher' },
    ],
    ablations: {
      noTemporalTop1: round(avg(rows.map(row => row.noTemporalCorrect))),
      noQualityTop1: round(avg(rows.map(row => row.noQualityCorrect))),
      noCounterEvidenceTop1: round(avg(rows.map(row => row.noCounterEvidenceCorrect))),
      note: 'Ablations use the same observations and change one scoring component at a time.',
    },
    details: {
      singleCauseCount: single.length,
      mixedCauseCount: mixed.length,
      topOneBootstrapCaseCount: rows.length,
      pairedBootstrap95Difference: pairedBootstrapDifferences(
        rows.map(row => row.baselineCorrect), rows.map(row => row.fullCorrect)),
      cases: rows,
    },
  };
}

function initialObservations(fixture: FixtureCase): Observation[] {
  return ['units_sold', 'visitors'].flatMap(metric => queryFixtureMetric(fixture, metric as Metric));
}

function outcomeCorrect(fixture: FixtureCase, status: string, cause: Cause | undefined): number {
  if (fixture.goldCauses.length === 0) return status !== 'supported' ? 1 : 0;
  // Mixed cases credit a supported first cause; this does not verify every cause.
  return status === 'supported' && rankCorrect(fixture, cause) ? 1 : 0;
}

function fixedOrderResult(fixture: FixtureCase, maxQueries = 6) {
  const order: Metric[] = ['units_sold', 'visitors', 'stock_on_hand', 'paid_orders', 'price', 'promotion_active'];
  const observations: Observation[] = [];
  const queried: Metric[] = [];
  let verdict: ReturnType<typeof verifyConclusion> | undefined;
  let top: Cause | undefined;
  for (const metric of order) {
    if (queried.length >= maxQueries) break;
    observations.push(...queryFixtureMetric(fixture, metric));
    queried.push(metric);
    const { evidence, ranking } = rankCauses(fixture.diagnosisCase, observations);
    top = ranking[0]?.cause;
    verdict = verifyConclusion(fixture.diagnosisCase, observations, evidence, ranking, queried);
    if (queried.length >= 2 && verdict.status !== 'needs_data') break;
  }
  return { status: verdict?.status ?? 'insufficient', cause: top, queryCount: queried.length };
}

export async function evaluateVerification(): Promise<ModuleEvaluation> {
  const cases = makeCorpus().filter(item => item.split === 'holdout');
  const rows = [];
  for (const fixture of cases) {
    const initial = initialObservations(fixture);
    const initialRanking = rankCauses(fixture.diagnosisCase, initial).ranking;
    const initialTop = initialRanking[0]?.cause;
    const baselineTop = rankCauses(fixture.diagnosisCase, fixture.observations).ranking[0]?.cause;
    const fixed = fixedOrderResult(fixture);
    const full = await diagnoseFixture(fixture);
    rows.push({
      caseId: fixture.diagnosisCase.caseId,
      skuId: fixture.diagnosisCase.skuId,
      scenario: fixture.scenario,
      gold: fixture.goldCauses,
      baselineCause: baselineTop ?? null,
      initialOnlyCause: initialTop ?? null,
      fixedCause: fixed.cause ?? null,
      fullCause: full.ranking[0]?.cause ?? null,
      fullStatus: full.verification.status,
      baselineCorrect: fixture.goldCauses.length > 0 && rankCorrect(fixture, baselineTop) ? 1 : 0,
      initialOnlyCorrect: fixture.goldCauses.length > 0 && rankCorrect(fixture, initialTop) ? 1 : 0,
      fixedCorrect: outcomeCorrect(fixture, fixed.status, fixed.cause),
      fullCorrect: outcomeCorrect(fixture, full.verification.status, full.ranking[0]?.cause),
      baselineUnsafe: fixture.goldCauses.length === 0 || !rankCorrect(fixture, baselineTop) ? 1 : 0,
      fullUnsafe: full.verification.status === 'supported' &&
        !rankCorrect(fixture, full.ranking[0]?.cause) ? 1 : 0,
      fixedQueries: fixed.queryCount,
      fullQueries: full.queriedMetrics.length,
    });
  }
  const insufficient = rows.filter(row => row.scenario === 'insufficient');
  const single = rows.filter(row => row.gold.length === 1);
  // Exploratory budget probe: one preselected variant from each scenario,
  // identical metric cap and observations for both query policies.
  const boundedCases = cases.filter(item => item.variant === 2);
  const bounded = [];
  for (const followUps of [1, 2]) {
    const probeRows = [];
    for (const fixture of boundedCases) {
      const fixed = fixedOrderResult(fixture, 2 + followUps);
      const targeted = await diagnoseFixture(fixture, { maxFollowUpQueries: followUps });
      probeRows.push({
        scenario: fixture.scenario,
        fixedStatus: fixed.status,
        targetedStatus: targeted.verification.status,
        fixedCorrect: outcomeCorrect(fixture, fixed.status, fixed.cause),
        targetedCorrect: outcomeCorrect(fixture, targeted.verification.status,
          targeted.ranking[0]?.cause),
        fixedQueries: fixed.queryCount,
        targetedQueries: targeted.queriedMetrics.length,
      });
    }
    bounded.push({
      maxTotalQueries: 2 + followUps,
      caseCount: probeRows.length,
      fixedDecisionCorrect: round(avg(probeRows.map(row => row.fixedCorrect))),
      targetedDecisionCorrect: round(avg(probeRows.map(row => row.targetedCorrect))),
      fixedAverageQueries: round(avg(probeRows.map(row => row.fixedQueries))),
      targetedAverageQueries: round(avg(probeRows.map(row => row.targetedQueries))),
      cases: probeRows,
    });
  }
  return {
    id: 'module5', name: '诊断结论核验与定向补查', sampleCount: rows.length,
    metrics: [
      { name: '决策正确率（相对全量直接断言）', baseline: round(avg(rows.map(row => row.baselineCorrect))),
        full: round(avg(rows.map(row => row.fullCorrect))), unit: 'ratio', better: 'higher' },
      { name: '错误强结论率（相对全量直接断言）', baseline: round(avg(rows.map(row => row.baselineUnsafe))),
        full: round(avg(rows.map(row => row.fullUnsafe))), unit: 'ratio', better: 'lower' },
      { name: '每例平均查询指标数（相对固定顺序）', baseline: round(avg(rows.map(row => row.fixedQueries))),
        full: round(avg(rows.map(row => row.fullQueries))), unit: 'queries', better: 'lower' },
      { name: '单原因支持正确率', baseline: round(avg(single.map(row => row.baselineCorrect))),
        full: round(avg(single.map(row => row.fullCorrect))), unit: 'ratio', better: 'higher' },
      { name: '信息不足案例保留判断率', baseline: round(avg(insufficient.map(row => 1 - row.baselineUnsafe))),
        full: round(avg(insufficient.map(row => row.fullStatus !== 'supported' ? 1 : 0))),
        unit: 'ratio', better: 'higher' },
    ],
    ablations: {
      fixedOrderDecisionCorrect: round(avg(rows.map(row => row.fixedCorrect))),
      fixedOrderAverageQueries: round(avg(rows.map(row => row.fixedQueries))),
      fullDataNoVerificationDecisionCorrect: round(avg(rows.map(row => row.baselineCorrect))),
      initialOnlyNoVerificationDecisionCorrect: round(avg(rows.map(row => row.initialOnlyCorrect))),
    },
    details: {
      baselineStrategies: {
        decision: 'All six metrics queried, top ranked cause asserted without conclusion verification',
        queryCost: 'Same verifier, but metrics queried in fixed order rather than selected by evidence gap',
        initialOnly: 'Sales and traffic queried, top ranked cause asserted without verification',
      },
      decisionScope: 'Mixed cases count as correct when the supported first cause matches either gold cause; the second cause is not separately verified.',
      fixedOrderCaseCount: rows.length,
      boundedQueryProbe: bounded,
      pairedBootstrap95Difference: pairedBootstrapDifferences(
        rows.map(row => row.baselineCorrect), rows.map(row => row.fullCorrect)),
      cases: rows,
    },
  };
}
