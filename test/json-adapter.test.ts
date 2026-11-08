import assert from 'node:assert/strict';
import test from 'node:test';
import { makeFixture } from '../src/data/fixtures.ts';
import { createJsonReadOnlyTools, validateBusinessDataset } from '../src/data/json-tools.ts';
import { diagnoseWithTools } from '../src/agent/diagnose.ts';

test('a scoped JSON dataset can drive the same diagnosis loop without a gold label', async () => {
  const fixture = makeFixture('stockout', 0);
  const dataset = validateBusinessDataset({
    diagnosisCase: fixture.diagnosisCase,
    observations: fixture.observations,
    synthetic: true,
  });
  const tools = createJsonReadOnlyTools(dataset);
  const report = await diagnoseWithTools(dataset.diagnosisCase, tools, { synthetic: true });
  assert.equal(report.ranking[0]?.cause, 'stockout');
  assert.equal(report.verification.status, 'supported');
  const copies = await tools.queryMetric('units_sold');
  copies[0]!.value = 999;
  assert.notEqual(dataset.observations.find(item => item.observationId === copies[0]!.observationId)?.value, 999);
});

test('the JSON loader rejects mixed-SKU data and duplicate observations', () => {
  const fixture = makeFixture('stockout', 0);
  assert.throws(() => validateBusinessDataset({
    diagnosisCase: fixture.diagnosisCase,
    observations: [{ ...fixture.observations[0], skuId: 'another' }],
  }), /does not match/);
  assert.throws(() => validateBusinessDataset({
    diagnosisCase: fixture.diagnosisCase,
    observations: [fixture.observations[0], fixture.observations[0]],
  }), /Duplicate observationId/);
});

test('a dataset rejects repeated metric/date/source records but allows independent sources', () => {
  const fixture = makeFixture('stockout', 0);
  const row = fixture.observations[0]!;
  assert.throws(() => validateBusinessDataset({
    diagnosisCase: fixture.diagnosisCase,
    observations: [row, { ...row, observationId: 'second-row' }],
  }), /Duplicate metric\/date\/source row/);
  assert.doesNotThrow(() => validateBusinessDataset({
    diagnosisCase: fixture.diagnosisCase,
    observations: [row, { ...row, observationId: 'second-source-row', source: 'other-source' }],
  }));
});

test('the read-only JSON adapter retains a validated snapshot after caller mutation', async () => {
  const fixture = makeFixture('stockout', 0);
  const dataset = validateBusinessDataset({
    diagnosisCase: structuredClone(fixture.diagnosisCase),
    observations: fixture.observations.map(item => ({ ...item })),
  });
  const original = dataset.observations.find(item => item.metric === 'units_sold')!;
  const originalValue = original.value;
  const tools = createJsonReadOnlyTools(dataset);

  original.value = 999;
  dataset.diagnosisCase.skuId = 'modified-after-validation';
  const rows = await tools.queryMetric('units_sold');
  assert.ok(rows.length > 0);
  assert.equal(rows.find(item => item.observationId === original.observationId)?.value, originalValue);
  assert.ok(rows.every(item => item.skuId === fixture.diagnosisCase.skuId));
});
