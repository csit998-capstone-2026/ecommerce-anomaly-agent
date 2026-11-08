import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateModules123 } from '../eval/modules-1-3.ts';

test('module 1 simulates allSettled batches and compares serial, FIFO, and local repair', async () => {
  const [scheduler] = await evaluateModules123();
  assert.equal(scheduler?.sampleCount, 48);
  const details = scheduler!.details as {
    note: string;
    scenarios: Array<{
      scenario: string;
      repairIds: string[];
      taskDurationsMs: Record<string, number>;
      serialFullRerun: { durationMs: number; executions: number };
      parallelFifoFullRerun: { durationMs: number; executions: number };
      parallelFifoLocalRepair: { durationMs: number; executions: number };
      priorityFullRerun: { durationMs: number; executions: number };
      priorityLocalRepair: { durationMs: number; executions: number };
    }>;
    slowerThanParallelFifoExamples: unknown[];
  };
  assert.equal(new Set(details.scenarios.map((row) => row.scenario)).size, 48);
  assert.match(details.note, /seed 20261023/);
  const stockFailure = details.scenarios.find((scenario) => scenario.scenario === 'reference:verdict-fail-stock');
  assert.ok(stockFailure);
  assert.deepEqual(stockFailure.repairIds, ['stock', 'rank', 'verify']);
  assert.equal(stockFailure.serialFullRerun.durationMs, 800);
  assert.equal(stockFailure.parallelFifoFullRerun.durationMs, 640);
  assert.equal(stockFailure.priorityLocalRepair.durationMs, 420);
  assert.equal(stockFailure.priorityLocalRepair.executions, 8);
  assert.equal(stockFailure.parallelFifoLocalRepair.executions, 8);
  assert.ok(details.scenarios.some((row) => row.scenario.startsWith('noisy-severity-')));
  assert.ok(details.slowerThanParallelFifoExamples.length > 0);
  const strata = scheduler!.ablations as {
    severityRegimes: { aligned: { sampleCount: number }; exploratoryNoisy: { sampleCount: number } };
  };
  assert.equal(strata.severityRegimes.aligned.sampleCount, 24);
  assert.equal(strata.severityRegimes.exploratoryNoisy.sampleCount, 24);
  assert.match(details.note, /exploratory/i);
  for (const row of details.scenarios) {
    assert.equal(Object.keys(row.taskDurationsMs).length, 5);
    assert.ok(row.priorityLocalRepair.executions <= row.priorityFullRerun.executions);
  }
  assert.equal(scheduler!.metrics[0]?.unit, 'virtual-ms');
});

test('module 2 reports evidence retention and labels same-heuristic budget checks as diagnostic', async () => {
  const [, context] = await evaluateModules123();
  assert.equal(context?.sampleCount, 27);
  const recall = context!.metrics.find((metric) => metric.name === '关键证据保留率')!;
  const fullText = context!.metrics.find((metric) => metric.name === '关键证据全文保留率')!;
  assert.ok(recall.full > recall.baseline);
  assert.equal(recall.full, 100);
  assert.ok(fullText.full >= fullText.baseline);
  const details = context!.details as {
    note: string;
    scenarios: Array<{
      id: string;
      budgetTokens: number;
      inputChunks: Array<{ id: string; category: string; fullCharacters: number }>;
      fixed4Fifo: { ids: string[]; auditTokens: number };
      fixedThresholdPrioritySummary: { ids: string[]; auditTokens: number };
      densityPrioritySummary: { ids: string[]; auditTokens: number };
      missedRequiredIds: { fixed4Fifo: string[]; densityPrioritySummary: string[] };
    }>;
    fullMissExamples: unknown[];
  };
  assert.equal(new Set(details.scenarios.map((row) => row.id)).size, 27);
  assert.equal(details.scenarios.filter((row) => row.id.includes(':budget-')).length, 24);
  assert.ok(details.scenarios.some((row) => row.id.includes('cjk-dense')));
  assert.ok(details.scenarios.some((row) => row.id.includes('stockout')));
  assert.equal(details.fullMissExamples.length, 0);
  const dense = details.scenarios.find((scenario) => scenario.id === 'dense-export-first')!;
  assert.deepEqual(dense.fixed4Fifo.ids, ['encoded-export']);
  assert.ok(dense.densityPrioritySummary.ids.includes('sales'));
  assert.ok(dense.densityPrioritySummary.ids.includes('stock'));
  assert.deepEqual(dense.missedRequiredIds.fixed4Fifo, ['sales', 'stock']);
  assert.ok(details.scenarios.every((row) => row.densityPrioritySummary.auditTokens <= row.budgetTokens));
  const fixedThreshold = context!.ablations as {
    sameEstimatorBudgetCheck: {
      fixed4FifoProxyOverrunCases: number;
      dynamicPrioritySummaryProxyOverrunCases: number;
    };
    fixedThresholdPrioritySummary: { thresholdTokens: number; fullKeyEvidencePct: number };
    dynamicPrioritySummaryFullKeyEvidencePct: number;
  };
  assert.ok(fixedThreshold.sameEstimatorBudgetCheck.fixed4FifoProxyOverrunCases > 0);
  assert.equal(fixedThreshold.sameEstimatorBudgetCheck.dynamicPrioritySummaryProxyOverrunCases, 0);
  assert.equal(fixedThreshold.fixedThresholdPrioritySummary.thresholdTokens, 180);
  assert.ok(fixedThreshold.dynamicPrioritySummaryFullKeyEvidencePct >= fixedThreshold.fixedThresholdPrioritySummary.fullKeyEvidencePct);
  assert.match(details.note, /No model tokenizer/i);
  assert.match(details.note, /internal invariant/i);
});

test('module 3 reports an exhaustive policy matrix and its failed baseline cases', async () => {
  const [, , gate] = await evaluateModules123();
  assert.equal(gate?.sampleCount, 1_728);
  const details = gate!.details as {
    baselineConfusionMatrix: Record<string, Record<string, number>>;
    fullConfusionMatrix: Record<string, Record<string, number>>;
    baselineFailureExamples: Array<{ expected: string; actual: string }>;
    fullFailureExamples: unknown[];
    ablationConfusionMatrices: Record<string, Record<string, Record<string, number>>>;
    ablationFailureExamples: Record<string, unknown[]>;
    expectedClassCounts: Record<string, number>;
  };
  const sumMatrix = (matrix: Record<string, Record<string, number>>) =>
    Object.values(matrix).flatMap((row) => Object.values(row)).reduce((sum, value) => sum + value, 0);
  assert.equal(sumMatrix(details.baselineConfusionMatrix), gate!.sampleCount);
  assert.equal(sumMatrix(details.fullConfusionMatrix), gate!.sampleCount);
  assert.deepEqual(details.expectedClassCounts, { execute: 23, block: 1698, request_approval: 7 });
  for (const matrix of Object.values(details.ablationConfusionMatrices)) {
    assert.equal(sumMatrix(matrix), gate!.sampleCount);
  }
  assert.ok(details.baselineFailureExamples.length > 0);
  assert.equal(details.fullFailureExamples.length, 0);
  for (const name of ['noBusinessRisk', 'noSourceState', 'noPrerequisite']) {
    assert.ok(details.ablationFailureExamples[name]!.length > 0);
  }
  const ablations = gate!.ablations as Record<string, { accuracyPct: number; unauthorizedExecutions: number }>;
  assert.ok(ablations.noBusinessRisk!.accuracyPct < 100);
  assert.ok(ablations.noSourceState!.accuracyPct < 100);
  assert.ok(ablations.noPrerequisite!.accuracyPct < 100);
  assert.ok(ablations.noBusinessRisk!.unauthorizedExecutions > 0);
  assert.ok(ablations.noSourceState!.unauthorizedExecutions > 0);
  assert.ok(ablations.noPrerequisite!.unauthorizedExecutions > 0);
  const macroRecall = gate!.metrics.find((metric) => metric.name === '三类决策宏平均召回率')!;
  assert.ok(macroRecall.baseline > 0 && macroRecall.baseline < 100);
  assert.equal(macroRecall.full, 100);
  assert.ok(gate!.metrics.find((metric) => metric.name === '未经许可直接执行数')!.baseline > 0);
  assert.equal(gate!.metrics.find((metric) => metric.name === '未经许可直接执行数')!.full, 0);
});
