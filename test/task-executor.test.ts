import assert from 'node:assert/strict';
import test from 'node:test';
import { executeTaskGraph, type ExecutableTask } from '../src/agent/task-executor.ts';

test('a failed verdict reruns only its branch and preserves unrelated results', async () => {
  const calls = new Map<string, number>();
  const run = (id: string) => () => {
    calls.set(id, (calls.get(id) ?? 0) + 1);
    return `${id}-${calls.get(id)}`;
  };
  const tasks: ExecutableTask[] = [
    { id: 'sales', dependsOn: [], anomalySeverity: 1, estimatedCost: 1, run: run('sales') },
    { id: 'traffic', dependsOn: [], anomalySeverity: 1, estimatedCost: 1, run: run('traffic') },
    { id: 'sales_rank', dependsOn: ['sales'], anomalySeverity: 1, estimatedCost: 1, run: run('sales_rank') },
    { id: 'traffic_rank', dependsOn: ['traffic'], anomalySeverity: 1, estimatedCost: 1, run: run('traffic_rank') },
  ];
  let verdicts = 0;
  const result = await executeTaskGraph(tasks, {
    maxParallel: 2,
    verdict: () => ++verdicts === 1 ? ['sales'] : [],
  });
  assert.equal(result.repairRounds, 1);
  assert.deepEqual(Object.fromEntries(calls), {
    sales: 2, traffic: 1, sales_rank: 2, traffic_rank: 1,
  });
  assert.deepEqual(result.events.find(event => event.kind === 'repair')?.taskIds,
    ['sales', 'sales_rank']);
  assert.equal(result.results.get('traffic_rank'), 'traffic_rank-1');
});

test('a synchronous task failure is repaired once without repeating a sibling', async () => {
  let failures = 0;
  let siblingRuns = 0;
  const tasks: ExecutableTask[] = [
    { id: 'unstable', dependsOn: [], anomalySeverity: 1, estimatedCost: 1,
      run: () => { if (failures++ === 0) throw new Error('temporary data error'); return 'ok'; } },
    { id: 'sibling', dependsOn: [], anomalySeverity: 0.5, estimatedCost: 1,
      run: () => { siblingRuns++; return 'kept'; } },
    { id: 'consumer', dependsOn: ['unstable'], anomalySeverity: 0.5, estimatedCost: 1,
      run: results => results.get('unstable') },
  ];
  const result = await executeTaskGraph(tasks, { maxParallel: 2 });
  assert.equal(result.repairRounds, 1);
  assert.equal(failures, 2);
  assert.equal(siblingRuns, 1);
  assert.equal(result.results.get('consumer'), 'ok');
});

test('a permanent failure stops when the local repair budget is exhausted', async () => {
  await assert.rejects(() => executeTaskGraph([
    { id: 'bad', dependsOn: [], anomalySeverity: 1, estimatedCost: 1,
      run: () => { throw new Error('invalid source row'); } },
  ], { maxParallel: 1, maxRepairRounds: 1 }), /Repair budget exhausted.*invalid source row/);
});

test('a non-retryable failure stops before consuming the repair budget', async () => {
  let calls = 0;
  await assert.rejects(() => executeTaskGraph([
    { id: 'slow-tool', dependsOn: [], anomalySeverity: 1, estimatedCost: 1,
      run: () => { calls += 1; throw new Error('timed out'); } },
  ], {
    maxParallel: 1,
    maxRepairRounds: 3,
    shouldRetryFailure: error => !(error instanceof Error && error.message === 'timed out'),
  }), /Non-retryable task failure.*timed out/);
  assert.equal(calls, 1);
});
