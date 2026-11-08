import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateStress } from '../eval/stress.ts';

test('hand-authored stress suite reports every probe and a reproducible pass rate', async () => {
  const result = await evaluateStress();
  assert.ok(result.sampleCount >= 10);
  assert.equal(result.cases.length, result.sampleCount);
  assert.equal(new Set(result.cases.map(item => item.id)).size, result.sampleCount);
  assert.ok(result.cases.every(item => item.expected && item.actual && item.note));
  assert.equal(result.passRate,
    Math.round(result.cases.filter(item => item.pass).length / result.sampleCount * 10_000) / 100);
});

test('stress suite includes identity, zero-vs-missing, tool, DAG, and context boundaries', async () => {
  const byId = new Map((await evaluateStress()).cases.map(item => [item.id, item]));
  for (const id of [
    'cross-store-isolation', 'cross-sku-isolation',
    'measured-zero-inventory', 'missing-is-not-zero',
    'high-risk-approval', 'safe-mode-write-block', 'stale-source-block',
    'local-repair-frontier', 'dag-cycle-rejected', 'dense-context-preserves-evidence',
    'blocked-recheck-stops',
  ]) {
    assert.equal(byId.get(id)?.pass, true, `${id}: ${byId.get(id)?.actual}`);
  }
});

test('ranking probes separately expose temporal, quality, and counterevidence sensitivity', async () => {
  const byId = new Map((await evaluateStress()).cases.map(item => [item.id, item]));
  for (const id of [
    'temporal-ablation-late-price',
    'counterevidence-ablation-conflict',
    'quality-ablation-stale-stock',
  ]) {
    const probe = byId.get(id);
    assert.ok(probe, `missing ${id}`);
    assert.match(probe.actual, /默认=.*；去/);
    assert.match(probe.note, /机制敏感性/);
  }
});

test('unmet expectations remain in the result rather than being dropped', async () => {
  const result = await evaluateStress();
  const failures = result.cases.filter(item => !item.pass);
  for (const failure of failures) {
    assert.ok(failure.expected.length > 0);
    assert.ok(failure.actual.length > 0);
  }
  assert.equal(result.cases.find(item => item.id === 'conflict-targeted-recheck')?.actual.includes('下个指标='), true);
});
