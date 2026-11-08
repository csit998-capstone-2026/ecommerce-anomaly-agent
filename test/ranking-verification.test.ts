import assert from 'node:assert/strict';
import test from 'node:test';
import {
  METRIC_UNITS,
  SCHEMA_VERSION,
  type DiagnosisCase,
  type Metric,
  type Observation,
} from '../src/domain/contracts.ts';
import { rankCauses } from '../src/algorithms/ranking.ts';
import { verifyConclusion } from '../src/algorithms/verification.ts';

const diagnosisCase: DiagnosisCase = {
  schemaVersion: SCHEMA_VERSION,
  caseId: 'diagnosis-1',
  storeId: 'store-1',
  skuId: 'sku-1',
  baselineWindow: { start: '2026-10-01', end: '2026-10-07' },
  anomalyWindow: { start: '2026-10-08', end: '2026-10-14' },
};

let nextId = 0;
function observation(metric: Metric, day: number, value: number | null,
  options: { source?: string; stale?: boolean; status?: Observation['status'] } = {}): Observation {
  const observedDate = `2026-10-${String(day).padStart(2, '0')}`;
  const status = options.status ?? (value === null ? 'missing' : 'ok');
  return {
    schemaVersion: SCHEMA_VERSION,
    observationId: `measurement-${++nextId}`,
    caseId: diagnosisCase.caseId,
    storeId: diagnosisCase.storeId,
    skuId: diagnosisCase.skuId,
    observedDate,
    metric,
    value,
    unit: METRIC_UNITS[metric],
    source: options.source ?? 'test-source',
    sourceUpdatedAt: status === 'ok'
      ? options.stale ? '2026-09-01T20:00:00Z' : `${observedDate}T20:00:00Z`
      : null,
    fetchedAt: `${observedDate}T21:00:00Z`,
    status,
    ...(status === 'error' ? { error: 'query failed' } : {}),
  };
}

function allDays(metric: Metric, baseline: number | undefined,
  anomaly: number | number[] | undefined, options: { stale?: boolean } = {}): Observation[] {
  const result: Observation[] = [];
  if (baseline !== undefined) {
    for (let day = 1; day <= 7; day++) result.push(observation(metric, day, baseline, options));
  }
  if (anomaly !== undefined) {
    for (let day = 8; day <= 14; day++) {
      const value = Array.isArray(anomaly) ? anomaly[day - 8] : anomaly;
      result.push(observation(metric, day, value, options));
    }
  }
  return result;
}

test('stockout is ranked above a contradicted traffic explanation and can be supported', () => {
  const rows = [
    ...allDays('units_sold', 10, 5),
    ...allDays('stock_on_hand', 20, 0),
    ...allDays('visitors', 100, 100),
  ];
  const result = rankCauses(diagnosisCase, rows);
  assert.equal(result.ranking[0].cause, 'stockout');
  assert.ok(result.evidence.some((item) => item.cause === 'stockout' && item.polarity === 'supports'));
  assert.ok(result.evidence.some((item) => item.cause === 'traffic_decline' && item.polarity === 'contradicts'));
  assert.equal(verifyConclusion(diagnosisCase, rows, result.evidence, result.ranking).status, 'supported');
});

test('verification requires a configurable minimum sales decline', () => {
  const slightDrop = [
    ...allDays('units_sold', 100, 99),
    ...allDays('stock_on_hand', 20, 0),
    ...allDays('visitors', 100, 100),
  ];
  const slight = rankCauses(diagnosisCase, slightDrop);
  const defaultVerdict = verifyConclusion(diagnosisCase, slightDrop, slight.evidence, slight.ranking);
  assert.equal(defaultVerdict.status, 'insufficient');
  assert.match(defaultVerdict.reason, /未达到异常判断阈值/);
  assert.equal(verifyConclusion(diagnosisCase, slightDrop, slight.evidence, slight.ranking,
    [], { minSalesDeclineRatio: 0.005 }).status, 'supported');

  const thresholdDrop = [
    ...allDays('units_sold', 100, 90),
    ...allDays('stock_on_hand', 20, 0),
    ...allDays('visitors', 100, 100),
  ];
  const boundary = rankCauses(diagnosisCase, thresholdDrop);
  assert.equal(verifyConclusion(diagnosisCase, thresholdDrop, boundary.evidence, boundary.ranking).status,
    'supported');
  for (const invalid of [-0.01, 1.01, NaN, Infinity]) {
    assert.throws(() => verifyConclusion(diagnosisCase, slightDrop, slight.evidence, slight.ranking,
      [], { minSalesDeclineRatio: invalid }), RangeError);
  }
});

test('a later stockout cannot outrank earlier traffic decline', () => {
  const rows = [
    ...allDays('units_sold', 10, 5),
    ...allDays('visitors', 100, 50),
    ...allDays('stock_on_hand', 20, [20, 20, 20, 0, 0, 0, 0]),
  ];
  const result = rankCauses(diagnosisCase, rows);
  assert.equal(result.ranking[0].cause, 'traffic_decline');
  assert.ok(result.evidence.some((item) => item.cause === 'stockout' &&
    item.polarity === 'contradicts' && item.explanation.includes('晚于')));
  const withoutTemporal = rankCauses(diagnosisCase, rows, { useTemporal: false });
  assert.ok((withoutTemporal.ranking.find((item) => item.cause === 'stockout')?.score ?? 0) >
    (result.ranking.find((item) => item.cause === 'stockout')?.score ?? 0));
});

test('later stockout remains a documented aggravating factor when sales fall further', () => {
  const rows = [
    ...allDays('units_sold', 10, [5, 0, 0, 0, 0, 0, 5]),
    ...allDays('visitors', 100, 50),
    ...allDays('stock_on_hand', 20, [20, 0, 0, 0, 0, 0, 20]),
  ];
  const result = rankCauses(diagnosisCase, rows);
  assert.equal(result.ranking[0].cause, 'traffic_decline');
  assert.ok((result.ranking.find((item) => item.cause === 'stockout')?.score ?? 0) > 0);
  assert.ok(result.evidence.some((item) => item.cause === 'stockout' &&
    item.polarity === 'supports' && item.explanation.includes('后续加重因素')));
  const verdict = verifyConclusion(diagnosisCase, rows, result.evidence, result.ranking);
  assert.equal(verdict.status, 'supported');
  assert.match(verdict.reason, /缺货可能是后续加重因素/);
});

test('conflicting inventory records trigger a targeted inventory requery', () => {
  const rows = [
    ...allDays('units_sold', 10, 5),
    ...allDays('stock_on_hand', 20, 0),
    ...allDays('stock_on_hand', undefined, 20),
  ];
  const result = rankCauses(diagnosisCase, rows);
  assert.equal(result.ranking[0].cause, 'stockout');
  const verdict = verifyConclusion(diagnosisCase, rows, result.evidence, result.ranking);
  assert.equal(verdict.status, 'needs_data');
  assert.deepEqual(verdict.nextQuery, { toolName: 'get_sku_inventory', metric: 'stock_on_hand' });
  const afterAttempt = verifyConclusion(diagnosisCase, rows, result.evidence, result.ranking, ['stock_on_hand']);
  assert.equal(afterAttempt.nextQuery?.metric, 'stock_on_hand');
  const noMoreQueries = verifyConclusion(diagnosisCase, rows, result.evidence, result.ranking,
    ['stock_on_hand', 'stock_on_hand', 'visitors', 'paid_orders', 'price', 'promotion_active', 'units_sold']);
  assert.equal(noMoreQueries.status, 'insufficient');
});

test('a strong same-day inventory conflict takes priority over missing unrelated metrics', () => {
  const rows = [
    ...allDays('units_sold', 10, 5),
    ...allDays('visitors', 100, 100),
    ...allDays('stock_on_hand', 20, 0),
    ...allDays('stock_on_hand', undefined, 50),
  ];
  const result = rankCauses(diagnosisCase, rows);
  const verdict = verifyConclusion(diagnosisCase, rows, result.evidence, result.ranking);
  assert.equal(verdict.status, 'needs_data');
  assert.equal(verdict.nextQuery?.metric, 'stock_on_hand');
  assert.match(verdict.reason, /相互冲突/);
});

test('missing inventory is not treated as zero and generates a follow-up query', () => {
  const rows = [
    ...allDays('units_sold', 10, 5),
    observation('stock_on_hand', 8, null),
    observation('visitors', 8, null, { status: 'error' }),
  ];
  const result = rankCauses(diagnosisCase, rows);
  assert.ok(!result.evidence.some((item) => item.cause === 'stockout' && item.polarity === 'supports'));
  assert.ok(result.ranking.find((item) => item.cause === 'stockout')?.missingMetrics.includes('stock_on_hand'));
  const verdict = verifyConclusion(diagnosisCase, rows, result.evidence, result.ranking);
  assert.equal(verdict.status, 'needs_data');
  assert.equal(verdict.nextQuery?.metric, 'stock_on_hand');
  const afterOrdinaryQuery = verifyConclusion(diagnosisCase, rows, result.evidence, result.ranking,
    ['stock_on_hand']);
  assert.notEqual(afterOrdinaryQuery.nextQuery?.metric, 'stock_on_hand');
});

test('stale stockout evidence is not accepted as a final conclusion', () => {
  const rows = [
    ...allDays('units_sold', 10, 5),
    ...allDays('stock_on_hand', 20, 0, { stale: true }),
  ];
  const result = rankCauses(diagnosisCase, rows);
  const verdict = verifyConclusion(diagnosisCase, rows, result.evidence, result.ranking);
  assert.equal(verdict.status, 'needs_data');
  assert.equal(verdict.nextQuery?.metric, 'stock_on_hand');
  assert.equal(verifyConclusion(diagnosisCase, rows, result.evidence, result.ranking,
    ['stock_on_hand']).nextQuery?.metric, 'stock_on_hand');
  assert.notEqual(verifyConclusion(diagnosisCase, rows, result.evidence, result.ranking,
    ['stock_on_hand', 'stock_on_hand']).nextQuery?.metric, 'stock_on_hand');
  const withoutQuality = rankCauses(diagnosisCase, rows, { useQuality: false });
  assert.ok(withoutQuality.ranking[0].score > result.ranking[0].score);
});

test('a low-quality competing stockout can block a seemingly supported conversion conclusion', () => {
  const rows = [
    ...allDays('units_sold', 10, 5),
    ...allDays('paid_orders', 10, 5),
    ...allDays('visitors', 100, 100),
    ...allDays('stock_on_hand', 20, 0, { stale: true }),
    ...allDays('price', 10, 10),
    ...allDays('promotion_active', 1, 1),
  ];
  const result = rankCauses(diagnosisCase, rows);
  assert.equal(result.ranking[0].cause, 'conversion_decline');
  const verdict = verifyConclusion(diagnosisCase, rows, result.evidence, result.ranking);
  assert.equal(verdict.status, 'needs_data');
  assert.equal(verdict.nextQuery?.metric, 'stock_on_hand');
  const exhausted = verifyConclusion(diagnosisCase, rows, result.evidence, result.ranking,
    ['stock_on_hand', 'stock_on_hand']);
  assert.equal(exhausted.status, 'insufficient');
});

test('a late fetch does not make completed historical daily data stale', () => {
  const stock = allDays('stock_on_hand', 20, 0).map((row) => ({
    ...row, fetchedAt: '2026-11-01T09:00:00Z',
  }));
  const rows = [...allDays('units_sold', 10, 5), ...stock];
  const result = rankCauses(diagnosisCase, rows);
  assert.equal(result.ranking[0].cause, 'stockout');
  assert.equal(verifyConclusion(diagnosisCase, rows, result.evidence, result.ranking).status, 'supported');
});

test('counterevidence ablation actually removes contradictory evidence', () => {
  const rows = [...allDays('units_sold', 10, 5), ...allDays('visitors', 100, 100)];
  const full = rankCauses(diagnosisCase, rows);
  const ablated = rankCauses(diagnosisCase, rows, { useCounterEvidence: false });
  assert.ok((full.ranking.find((item) => item.cause === 'traffic_decline')?.score ?? 0) < 0);
  assert.equal(ablated.ranking.find((item) => item.cause === 'traffic_decline')?.score, 0);
});

test('conversion decline requires orders and visitors, not units sold alone', () => {
  const noOrders = [
    ...allDays('units_sold', 10, 5),
    ...allDays('visitors', 100, 100),
  ];
  const first = rankCauses(diagnosisCase, noOrders);
  assert.ok(first.ranking.find((item) => item.cause === 'conversion_decline')?.missingMetrics.includes('paid_orders'));

  const withOrders = [...noOrders, ...allDays('paid_orders', 10, 5)];
  const second = rankCauses(diagnosisCase, withOrders);
  assert.equal(second.ranking[0].cause, 'conversion_decline');
  const firstCheck = verifyConclusion(diagnosisCase, withOrders, second.evidence, second.ranking);
  assert.equal(firstCheck.status, 'needs_data');
  assert.equal(firstCheck.nextQuery?.metric, 'promotion_active');

  const withPromotion = [...withOrders, ...allDays('promotion_active', 1, 1)];
  const third = rankCauses(diagnosisCase, withPromotion);
  assert.equal(verifyConclusion(diagnosisCase, withPromotion, third.evidence, third.ranking).nextQuery?.metric,
    'price');
  const withPrice = [...withPromotion, ...allDays('price', 10, 10)];
  const fourth = rankCauses(diagnosisCase, withPrice);
  assert.equal(verifyConclusion(diagnosisCase, withPrice, fourth.evidence, fourth.ranking).status,
    'supported');
});

test('conversion verification requires enough same-day order and visitor pairs in both windows', () => {
  const orderDays = new Set([1, 2, 3, 4, 8, 9, 10, 11]);
  const visitorDays = new Set([1, 5, 6, 7, 8, 12, 13, 14]);
  const rows = [
    ...allDays('units_sold', 10, 5),
    ...allDays('paid_orders', 10, 5).filter((row) => orderDays.has(Number(row.observedDate.slice(-2)))),
    ...allDays('visitors', 100, 100).filter((row) => visitorDays.has(Number(row.observedDate.slice(-2)))),
    ...allDays('price', 10, 10),
    ...allDays('promotion_active', 1, 1),
  ];
  const result = rankCauses(diagnosisCase, rows);
  assert.equal(result.ranking[0].cause, 'conversion_decline');
  const verdict = verifyConclusion(diagnosisCase, rows, result.evidence, result.ranking);
  assert.equal(verdict.status, 'needs_data');
  assert.equal(verdict.nextQuery?.metric, 'paid_orders');
  const exhausted = verifyConclusion(diagnosisCase, rows, result.evidence, result.ranking,
    ['paid_orders', 'paid_orders', 'visitors', 'visitors', 'price', 'price',
      'promotion_active', 'promotion_active']);
  assert.equal(exhausted.status, 'insufficient');
});

test('conversion comparison excludes unmatched days and cites only paired observations', () => {
  const orderDays = new Set([1, 2, 3, 4, 8, 9, 10, 11]);
  const visitorDays = new Set([1, 5, 6, 7, 8, 12, 13, 14]);
  const orders = allDays('paid_orders', 100, [10, 1, 1, 1, 1, 1, 1])
    .filter((row) => orderDays.has(Number(row.observedDate.slice(-2))))
    .map((row) => row.observedDate.endsWith('-01') ? { ...row, value: 10 } : row);
  const rows = [
    ...allDays('units_sold', 40, 20),
    ...orders,
    ...allDays('visitors', 100, 100).filter((row) => visitorDays.has(Number(row.observedDate.slice(-2)))),
  ];
  const result = rankCauses(diagnosisCase, rows);
  const conversionEvidence = result.evidence.filter((item) => item.cause === 'conversion_decline');
  assert.ok(conversionEvidence.some((item) => item.polarity === 'contradicts'));
  assert.ok(!conversionEvidence.some((item) => item.polarity === 'supports'));
  const byId = new Map(rows.map((row) => [row.observationId, row]));
  const citedDays = [...new Set(conversionEvidence.flatMap((item) => item.observationIds)
    .map((id) => byId.get(id)!.observedDate))].sort();
  assert.deepEqual(citedDays, ['2026-10-01', '2026-10-08']);
});

test('non-overlapping order and visitor dates do not create a conversion signal', () => {
  const orderDays = new Set([1, 2, 3, 8, 9, 10]);
  const visitorDays = new Set([4, 5, 6, 11, 12, 13]);
  const rows = [
    ...allDays('units_sold', 10, 5),
    ...allDays('paid_orders', 10, 5).filter((row) => orderDays.has(Number(row.observedDate.slice(-2)))),
    ...allDays('visitors', 100, 100).filter((row) => visitorDays.has(Number(row.observedDate.slice(-2)))),
  ];
  const result = rankCauses(diagnosisCase, rows);
  assert.ok(!result.evidence.some((item) => item.cause === 'conversion_decline' &&
    item.polarity === 'supports'));
  const conversion = result.ranking.find((item) => item.cause === 'conversion_decline')!;
  assert.ok(conversion.missingMetrics.includes('paid_orders'));
  assert.ok(conversion.missingMetrics.includes('visitors'));
});

test('traffic decline checks inventory when sales fall materially faster than visitors', () => {
  const rows = [...allDays('units_sold', 10, 3), ...allDays('visitors', 100, 60)];
  const first = rankCauses(diagnosisCase, rows);
  assert.equal(first.ranking[0].cause, 'traffic_decline');
  const verdict = verifyConclusion(diagnosisCase, rows, first.evidence, first.ranking);
  assert.equal(verdict.status, 'needs_data');
  assert.deepEqual(verdict.nextQuery, { toolName: 'get_sku_inventory', metric: 'stock_on_hand' });
});

test('price rise and a finished promotion yield traceable evidence, not a causal probability', () => {
  const rows = [
    ...allDays('units_sold', 10, 5),
    ...allDays('price', 10, 12),
    ...allDays('promotion_active', 1, 0),
  ];
  const result = rankCauses(diagnosisCase, rows);
  assert.equal(result.ranking[0].cause, 'price_or_promotion_change');
  assert.ok(result.ranking[0].supportEvidenceIds.length >= 2);
  assert.ok(result.evidence.every((item) => item.observationIds.every((id) =>
    rows.some((row) => row.observationId === id))));
  const verdict = verifyConclusion(diagnosisCase, rows, result.evidence, result.ranking);
  assert.equal(verdict.status, 'supported');
  assert.match(verdict.reason, /不是因果概率/);
});

test('sales baseline must be checked before any cause is accepted', () => {
  const rows = allDays('stock_on_hand', 20, 0);
  const result = rankCauses(diagnosisCase, rows);
  const verdict = verifyConclusion(diagnosisCase, rows, result.evidence, result.ranking);
  assert.equal(verdict.status, 'needs_data');
  assert.deepEqual(verdict.nextQuery, { toolName: 'get_sku_sales', metric: 'units_sold' });
});

test('one observed day per seven-day window cannot support a whole-window cause', () => {
  const rows = [
    observation('units_sold', 7, 10),
    observation('units_sold', 10, 0),
    observation('stock_on_hand', 10, 0),
  ];
  const result = rankCauses(diagnosisCase, rows);
  assert.equal(result.ranking[0].cause, 'stockout');
  const first = verifyConclusion(diagnosisCase, rows, result.evidence, result.ranking);
  assert.equal(first.status, 'needs_data');
  assert.equal(first.nextQuery?.metric, 'units_sold');
  const exhausted = verifyConclusion(diagnosisCase, rows, result.evidence, result.ranking,
    ['units_sold', 'paid_orders', 'stock_on_hand']);
  assert.equal(exhausted.status, 'insufficient');
});

test('sparse candidate evidence cannot be supported even with complete sales data', () => {
  const rows = [
    ...allDays('units_sold', 10, 5),
    observation('stock_on_hand', 8, 0),
  ];
  const result = rankCauses(diagnosisCase, rows);
  const verdict = verifyConclusion(diagnosisCase, rows, result.evidence, result.ranking);
  assert.equal(verdict.status, 'needs_data');
  assert.equal(verdict.nextQuery?.metric, 'stock_on_hand');
});

test('verification rejects a ranking that borrows evidence from another cause', () => {
  const rows = [
    ...allDays('units_sold', 10, 5),
    ...allDays('stock_on_hand', 20, 0),
    ...allDays('visitors', 100, 100),
  ];
  const result = rankCauses(diagnosisCase, rows);
  const foreignId = result.evidence.find((item) => item.cause === 'traffic_decline')!.evidenceId;
  const forged = result.ranking.map((item, index) => index === 0
    ? { ...item, supportEvidenceIds: [foreignId] } : item);
  assert.throws(() => verifyConclusion(diagnosisCase, rows, result.evidence, forged),
    /Ranking references invalid evidence/);
});
