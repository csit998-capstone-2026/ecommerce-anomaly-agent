import assert from 'node:assert/strict';
import test from 'node:test';
import { diagnoseFixture, diagnoseWithTools } from '../src/agent/diagnose.ts';
import { makeFixture, queryFixtureMetric } from '../src/data/fixtures.ts';
import type { Metric, Observation } from '../src/domain/contracts.ts';

function conflictingInventory(fixture: ReturnType<typeof makeFixture>): Observation[] {
  const original = queryFixtureMetric(fixture, 'stock_on_hand');
  const conflicting = original.filter(row => row.observedDate >= fixture.diagnosisCase.anomalyWindow.start)
    .map(row => ({
      ...row,
      observationId: `${row.observationId}:conflict`,
      source: 'conflicting-inventory-source',
      value: row.value === 0 ? 20 : 0,
    }));
  return [...original, ...conflicting];
}

test('the read-only Agent follows evidence gaps and returns traceable stockout evidence', async () => {
  const fixture = makeFixture('stockout', 0);
  const report = await diagnoseFixture(fixture);
  assert.equal(report.verification.status, 'supported');
  assert.equal(report.ranking[0]?.cause, 'stockout');
  assert.deepEqual(report.queriedMetrics, ['units_sold', 'visitors', 'stock_on_hand']);
  assert.ok(report.evidence.some(item => item.cause === 'stockout' && item.observationIds.length > 0));
  assert.ok(report.trace.some(item => item.kind === 'tool_decision' && item.decision === 'execute'));
  assert.equal(report.synthetic, true);
});

test('the tool gate blocks a forbidden metric before the adapter receives it', async () => {
  const fixture = makeFixture('stockout', 0);
  const seen: Metric[] = [];
  const report = await diagnoseWithTools(fixture.diagnosisCase, {
    queryMetric(metric) {
      seen.push(metric);
      return queryFixtureMetric(fixture, metric);
    },
  }, { blockedMetrics: ['stock_on_hand'] });
  assert.deepEqual(seen, ['units_sold', 'visitors']);
  assert.ok(report.trace.some(item => item.metric === 'stock_on_hand' && item.decision === 'block'));
  assert.equal(report.verification.status, 'insufficient');
  assert.match(report.verification.reason, /未执行/);
});

test('a shared source slug does not authorize an inactive metric', async () => {
  const fixture = makeFixture('stockout', 0);
  const seen: Metric[] = [];
  const report = await diagnoseWithTools(fixture.diagnosisCase, {
    sourceSlug: () => 'store-api',
    sourceActive: metric => metric !== 'stock_on_hand',
    queryMetric(metric) {
      seen.push(metric);
      return queryFixtureMetric(fixture, metric);
    },
  });
  assert.deepEqual(seen, ['units_sold', 'visitors']);
  assert.ok(report.trace.some(item => item.metric === 'stock_on_hand' && item.decision === 'block'));
  assert.notEqual(report.verification.status, 'supported');
});

test('a source becoming stale before follow-up is blocked at call time', async () => {
  const fixture = makeFixture('stockout', 0);
  const seen: Metric[] = [];
  let inventoryStale = false;
  const report = await diagnoseWithTools(fixture.diagnosisCase, {
    sourceSlug: () => 'store-api',
    sourceState: metric => metric === 'stock_on_hand' && inventoryStale ? 'stale' : 'healthy',
    queryMetric(metric) {
      seen.push(metric);
      if (metric === 'visitors') inventoryStale = true;
      return queryFixtureMetric(fixture, metric);
    },
  });
  assert.deepEqual(seen, ['units_sold', 'visitors']);
  assert.ok(report.trace.some(item => item.metric === 'stock_on_hand' &&
    item.decision === 'block' && /stale/i.test(item.detail)));
  assert.equal(report.verification.status, 'insufficient');
});

test('the Agent rejects tool observations from another SKU', async () => {
  const fixture = makeFixture('stockout', 0);
  await assert.rejects(() => diagnoseWithTools(fixture.diagnosisCase, {
    queryMetric(metric) {
      return queryFixtureMetric(fixture, metric).map((row, index) =>
        index === 0 ? { ...row, skuId: 'foreign-sku' } : row);
    },
  }), /does not match/);
});

test('the Agent rejects a valid observation for the wrong requested metric', async () => {
  const fixture = makeFixture('stockout', 0);
  await assert.rejects(() => diagnoseWithTools(fixture.diagnosisCase, {
    queryMetric(metric) {
      return queryFixtureMetric(fixture, metric === 'units_sold' ? 'visitors' : metric);
    },
  }), /visitors while units_sold was requested/);
});

test('the Agent locally repairs a transient invalid sales response without requerying traffic', async () => {
  const fixture = makeFixture('stockout', 0);
  const calls = new Map<Metric, number>();
  const report = await diagnoseWithTools(fixture.diagnosisCase, {
    queryMetric(metric) {
      const count = (calls.get(metric) ?? 0) + 1;
      calls.set(metric, count);
      const rows = queryFixtureMetric(fixture, metric);
      if (metric === 'units_sold' && count === 1) {
        return rows.map((row, index) => index === 0 ? { ...row, skuId: 'foreign-sku' } : row);
      }
      return rows;
    },
  });
  assert.equal(report.repairRounds, 1);
  assert.equal(calls.get('units_sold'), 2);
  assert.equal(calls.get('visitors'), 1);
  assert.ok(report.trace.some(event => event.kind === 'repair'));
  assert.equal(report.ranking[0]?.cause, 'stockout');
});

test('the Agent stops after its follow-up budget', async () => {
  const fixture = makeFixture('price_or_promotion_change', 0);
  const report = await diagnoseFixture(fixture, { maxFollowUpQueries: 0 });
  assert.equal(report.queriedMetrics.length, 2);
  assert.equal(report.verification.status, 'insufficient');
  assert.match(report.verification.reason, /最多 0 次补查/);
});

test('a transient follow-up error retries once and commits inventory records only once', async () => {
  const fixture = makeFixture('stockout', 0);
  let inventoryCalls = 0;
  const report = await diagnoseWithTools(fixture.diagnosisCase, {
    queryMetric(metric) {
      const rows = queryFixtureMetric(fixture, metric);
      if (metric !== 'stock_on_hand') return rows;
      inventoryCalls += 1;
      return inventoryCalls === 1
        ? rows.map((row, index) => index === 0 ? { ...row, skuId: 'foreign-sku' } : row)
        : rows;
    },
  });
  assert.equal(inventoryCalls, 2);
  assert.equal(report.repairRounds, 1);
  assert.equal(report.verification.status, 'supported');
  assert.equal(report.observations.filter(item => item.metric === 'stock_on_hand').length,
    queryFixtureMetric(fixture, 'stock_on_hand').length);
  assert.equal(new Set(report.observations.map(item => item.observationId)).size,
    report.observations.length);
});

test('a conflicting inventory result is rechecked once and atomically replaced by clean records', async () => {
  const fixture = makeFixture('stockout', 0);
  let inventoryCalls = 0;
  const report = await diagnoseWithTools(fixture.diagnosisCase, {
    queryMetric(metric) {
      if (metric !== 'stock_on_hand') return queryFixtureMetric(fixture, metric);
      inventoryCalls += 1;
      return inventoryCalls === 1 ? conflictingInventory(fixture) : queryFixtureMetric(fixture, metric);
    },
  }, { maxFollowUpQueries: 10 });
  assert.equal(inventoryCalls, 2);
  assert.equal(report.queriedMetrics.filter(metric => metric === 'stock_on_hand').length, 2);
  assert.equal(report.verification.status, 'supported');
  assert.equal(report.ranking[0]?.cause, 'stockout');
  assert.equal(report.observations.filter(item => item.metric === 'stock_on_hand').length,
    queryFixtureMetric(fixture, 'stock_on_hand').length);
  assert.ok(!report.observations.some(item => item.source === 'conflicting-inventory-source'));
  assert.equal(new Set(report.observations.map(item => item.observationId)).size,
    report.observations.length);
  assert.ok(report.trace.some(item => item.metric === 'stock_on_hand' &&
    item.kind === 'tool_result' && item.detail.includes('复查')));
});

test('a second conflicting inventory result stops at two successful queries without a false conclusion', async () => {
  const fixture = makeFixture('stockout', 0);
  let inventoryCalls = 0;
  const report = await diagnoseWithTools(fixture.diagnosisCase, {
    queryMetric(metric) {
      if (metric !== 'stock_on_hand') return queryFixtureMetric(fixture, metric);
      inventoryCalls += 1;
      return conflictingInventory(fixture);
    },
  }, { maxFollowUpQueries: 10 });
  assert.equal(inventoryCalls, 2);
  assert.equal(report.queriedMetrics.filter(metric => metric === 'stock_on_hand').length, 2);
  assert.equal(report.verification.status, 'insufficient');
  assert.equal(new Set(report.observations.map(item => item.observationId)).size,
    report.observations.length);
});

test('an invalid recheck preserves the previously validated inventory batch', async () => {
  const fixture = makeFixture('stockout', 0);
  const firstBatch = conflictingInventory(fixture);
  let inventoryCalls = 0;
  const report = await diagnoseWithTools(fixture.diagnosisCase, {
    queryMetric(metric) {
      if (metric !== 'stock_on_hand') return queryFixtureMetric(fixture, metric);
      inventoryCalls += 1;
      if (inventoryCalls === 1) return firstBatch;
      return queryFixtureMetric(fixture, metric).map((row, index) => index === 0
        ? { ...row, skuId: 'foreign-sku', source: 'invalid-recheck-source' }
        : row);
    },
  }, { maxFollowUpQueries: 10, maxRepairRounds: 0 });
  assert.equal(inventoryCalls, 2);
  assert.equal(report.queriedMetrics.filter(metric => metric === 'stock_on_hand').length, 1);
  assert.equal(report.verification.status, 'insufficient');
  assert.match(report.verification.reason, /补查 stock_on_hand 失败/);
  assert.deepEqual(report.observations.filter(item => item.metric === 'stock_on_hand'), firstBatch);
  assert.ok(!report.observations.some(item => item.source === 'invalid-recheck-source'));
});

test('a failed follow-up returns an explicit insufficient result', async () => {
  const fixture = makeFixture('stockout', 0);
  let inventoryCalls = 0;
  const report = await diagnoseWithTools(fixture.diagnosisCase, {
    queryMetric(metric) {
      if (metric === 'stock_on_hand') {
        inventoryCalls += 1;
        throw new Error('inventory service unavailable');
      }
      return queryFixtureMetric(fixture, metric);
    },
  });
  assert.equal(inventoryCalls, 2);
  assert.equal(report.repairRounds, 1);
  assert.equal(report.verification.status, 'insufficient');
  assert.match(report.verification.reason, /inventory service unavailable/);
  assert.equal(report.queriedMetrics.includes('stock_on_hand'), false);
});

test('an initial tool timeout aborts its signal and never retries the possibly running call', async () => {
  const fixture = makeFixture('stockout', 0);
  let salesCalls = 0;
  let aborts = 0;
  await assert.rejects(() => diagnoseWithTools(fixture.diagnosisCase, {
    queryMetric(metric, signal) {
      if (metric !== 'units_sold') return queryFixtureMetric(fixture, metric);
      salesCalls += 1;
      return new Promise<Observation[]>(() => {
        signal?.addEventListener('abort', () => { aborts += 1; }, { once: true });
      });
    },
  }, { toolTimeoutMs: 20, maxRepairRounds: 3 }), /Non-retryable task failure.*timed out/);
  assert.equal(salesCalls, 1);
  assert.equal(aborts, 1);
});

test('a follow-up timeout is explicit and does not start an overlapping retry', async () => {
  const fixture = makeFixture('stockout', 0);
  let inventoryCalls = 0;
  let aborts = 0;
  const report = await diagnoseWithTools(fixture.diagnosisCase, {
    queryMetric(metric, signal) {
      if (metric !== 'stock_on_hand') return queryFixtureMetric(fixture, metric);
      inventoryCalls += 1;
      return new Promise<Observation[]>(() => {
        signal?.addEventListener('abort', () => { aborts += 1; }, { once: true });
      });
    },
  }, { toolTimeoutMs: 20, maxRepairRounds: 3 });
  assert.equal(inventoryCalls, 1);
  assert.equal(aborts, 1);
  assert.equal(report.verification.status, 'insufficient');
  assert.match(report.verification.reason, /timed out/);
  assert.equal(report.queriedMetrics.includes('stock_on_hand'), false);
});

test('duplicate observation IDs across tool batches are rejected before commit', async () => {
  const fixture = makeFixture('stockout', 0);
  const duplicateId = queryFixtureMetric(fixture, 'units_sold')[0]!.observationId;
  await assert.rejects(() => diagnoseWithTools(fixture.diagnosisCase, {
    queryMetric(metric) {
      const rows = queryFixtureMetric(fixture, metric);
      return metric === 'visitors'
        ? rows.map((row, index) => index === 0 ? { ...row, observationId: duplicateId } : row)
        : rows;
    },
  }), /Duplicate observationId/);
});

test('duplicate metric/date/source rows in one tool batch are rejected even with distinct IDs', async () => {
  const fixture = makeFixture('stockout', 0);
  await assert.rejects(() => diagnoseWithTools(fixture.diagnosisCase, {
    queryMetric(metric) {
      const rows = queryFixtureMetric(fixture, metric);
      return metric === 'units_sold'
        ? [...rows, { ...rows[0]!, observationId: `${rows[0]!.observationId}:duplicate` }]
        : rows;
    },
  }, { maxRepairRounds: 0 }), /Duplicate metric\/date\/source row/);
});

test('configured model window changes the Agent evidence budget', async () => {
  const fixture = makeFixture('stockout', 0);
  const compact = await diagnoseFixture(fixture, {
    contextWindowTokens: 8_192,
    reservedContextTokens: 8_160,
  });
  const roomy = await diagnoseFixture(fixture, {
    contextWindowTokens: 32_768,
    reservedContextTokens: 20_000,
  });
  assert.equal(compact.contextBudgetTokens, 32);
  assert.ok(compact.context.estimatedTokens <= 32);
  assert.equal(roomy.contextBudgetTokens, 3_276);
  assert.ok(roomy.context.estimatedTokens >= compact.context.estimatedTokens);
});
