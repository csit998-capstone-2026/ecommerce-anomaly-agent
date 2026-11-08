import assert from 'node:assert/strict';
import test from 'node:test';
import { SCHEMA_VERSION, type DiagnosisCase, type Observation } from '../src/domain/contracts.ts';
import { validateDiagnosisCase, validateObservation } from '../src/domain/validation.ts';

const diagnosisCase: DiagnosisCase = {
  schemaVersion: SCHEMA_VERSION,
  caseId: 'case-001',
  storeId: 'store-01',
  skuId: 'sku-123',
  baselineWindow: { start: '2026-10-01', end: '2026-10-07' },
  anomalyWindow: { start: '2026-10-08', end: '2026-10-14' },
};

const validStockout: Observation = {
  schemaVersion: SCHEMA_VERSION,
  observationId: 'obs-001',
  caseId: diagnosisCase.caseId,
  storeId: diagnosisCase.storeId,
  skuId: diagnosisCase.skuId,
  observedDate: '2026-10-09',
  metric: 'stock_on_hand',
  value: 0,
  unit: 'items',
  source: 'demo-inventory',
  sourceUpdatedAt: '2026-10-09T09:00:00Z',
  fetchedAt: '2026-10-09T10:00:00Z',
  status: 'ok',
};

test('valid case and a measured stockout are accepted', () => {
  assert.doesNotThrow(() => validateDiagnosisCase(diagnosisCase));
  assert.doesNotThrow(() => validateObservation(diagnosisCase, validStockout));
});

test('a missing metric is different from a measured zero', () => {
  assert.doesNotThrow(() => validateObservation(diagnosisCase, {
    ...validStockout, observationId: 'obs-002', value: null, status: 'missing', sourceUpdatedAt: null,
  }));
  assert.throws(() => validateObservation(diagnosisCase, {
    ...validStockout, observationId: 'obs-003', value: 0, status: 'missing',
  }), /null value/);
});

test('a different SKU or an out-of-window record is rejected', () => {
  assert.throws(() => validateObservation(diagnosisCase, {
    ...validStockout, skuId: 'sku-other',
  }), /does not match/);
  assert.throws(() => validateObservation(diagnosisCase, {
    ...validStockout, observedDate: '2026-09-30',
  }), /outside/);
});

test('invalid and overlapping date windows are rejected', () => {
  assert.throws(() => validateDiagnosisCase({
    ...diagnosisCase, anomalyWindow: { start: '2026-10-07', end: '2026-10-14' },
  }), /overlap/);
  assert.throws(() => validateDiagnosisCase({
    ...diagnosisCase, baselineWindow: { start: '2026-02-30', end: '2026-03-01' },
  }), /Invalid ISO date/);
});

test('timestamps must include a valid date and timezone, with source update before fetch', () => {
  assert.throws(() => validateObservation(diagnosisCase, {
    ...validStockout, fetchedAt: '2026-10-09 10:00:00',
  }), /Invalid fetchedAt/);
  assert.throws(() => validateObservation(diagnosisCase, {
    ...validStockout, fetchedAt: '2026-02-30T10:00:00Z',
  }), /Invalid ISO date/);
  assert.throws(() => validateObservation(diagnosisCase, {
    ...validStockout, sourceUpdatedAt: '2026-10-09T11:00:00Z',
  }), /cannot be after fetchedAt/);
});

test('count metrics require whole numbers while prices may contain decimals', () => {
  assert.throws(() => validateObservation(diagnosisCase, {
    ...validStockout, value: 1.5,
  }), /whole-number count/);
  assert.doesNotThrow(() => validateObservation(diagnosisCase, {
    ...validStockout, metric: 'price', unit: 'CNY', value: 12.5,
  }));
});

test('malformed case and observation shapes fail with a validation error', () => {
  assert.throws(() => validateDiagnosisCase(null as unknown as DiagnosisCase), /must be an object/);
  assert.throws(() => validateDiagnosisCase({
    ...diagnosisCase, baselineWindow: null as unknown as DiagnosisCase['baselineWindow'],
  }), /Date window must be an object/);
  assert.throws(() => validateObservation(diagnosisCase, null as unknown as Observation),
    /Observation must be an object/);
});
