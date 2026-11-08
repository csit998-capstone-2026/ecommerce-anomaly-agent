import assert from 'node:assert/strict';
import test from 'node:test';
import { makeCorpus, makeFixture, queryFixtureMetric } from '../src/data/fixtures.ts';
import { validateDiagnosisCase, validateObservation } from '../src/domain/validation.ts';

test('the synthetic corpus has a fixed, balanced development/holdout split', () => {
  const corpus = makeCorpus();
  assert.equal(corpus.length, 48);
  assert.equal(corpus.filter(item => item.split === 'development').length, 12);
  assert.equal(corpus.filter(item => item.split === 'holdout').length, 36);
  assert.equal(new Set(corpus.map(item => item.diagnosisCase.caseId)).size, 48);
  for (const fixture of corpus) {
    validateDiagnosisCase(fixture.diagnosisCase);
    assert.equal(fixture.observations.length, 84);
    fixture.observations.forEach(item => validateObservation(fixture.diagnosisCase, item));
    assert.equal(fixture.diagnosisCase.caseId.includes(fixture.scenario), false);
    assert.ok(fixture.observations.every(item => !item.observationId.includes(fixture.scenario)));
  }
});

test('the read-only fixture tool returns one metric without leaking gold labels', () => {
  const fixture = makeFixture('stockout', 3);
  const inventory = queryFixtureMetric(fixture, 'stock_on_hand');
  assert.equal(inventory.length, 14);
  assert.ok(inventory.every(item => item.metric === 'stock_on_hand'));
  assert.ok(inventory.some(item => item.value === 0 && item.status === 'ok'));
  assert.equal('goldCauses' in inventory[0]!, false);
  inventory[0]!.value = 999;
  assert.notEqual(fixture.observations.find(item => item.observationId === inventory[0]!.observationId)?.value, 999);
});

test('insufficient evidence uses missing status rather than measured zero', () => {
  const fixture = makeFixture('insufficient', 4);
  const anomalyInventory = queryFixtureMetric(fixture, 'stock_on_hand')
    .filter(item => item.observedDate >= fixture.diagnosisCase.anomalyWindow.start);
  assert.equal(anomalyInventory.length, 7);
  assert.ok(anomalyInventory.every(item => item.status === 'missing' && item.value === null));
});
