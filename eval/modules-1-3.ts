import { getLocalRepairPlan, getReadyTasks, type TaskNode } from '../src/algorithms/scheduler.ts';
import {
  estimateTokensHeuristic,
  selectContext,
  type ContextChunk,
} from '../src/algorithms/context-budget.ts';
import {
  decideToolCall,
  type PermissionMode,
  type SourceState,
  type ToolCallRequest,
  type ToolGateContext,
} from '../src/algorithms/tool-gate.ts';
import type { ToolDecision } from '../src/domain/contracts.ts';

export interface ComparisonMetric {
  name: string;
  baseline: number;
  full: number;
  unit: string;
  better: 'higher' | 'lower';
}

export interface ModuleEvaluation {
  id: string;
  name: string;
  metrics: ComparisonMetric[];
  ablations?: unknown;
  sampleCount: number;
  details?: unknown;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Fixed LCG seed and ranges are chosen before comparisons, not from outcomes. */
function deterministicDurations(seed: number, count: number): number[][] {
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
  return Array.from({ length: count }, () =>
    Array.from({ length: DIAGNOSIS_DAG.length }, () => 20 + (next() % 19) * 10),
  );
}

// ---------------------------------------------------------------------------
// Module 1: deterministic, virtual-time DAG execution. Each dispatch waits
// for the whole Promise.allSettled batch, matching task-executor.ts. Times
// are fixture durations, not measured wall-clock performance or LLM latency.
// ---------------------------------------------------------------------------

interface TimedTask extends TaskNode { durationMs: number }
type DispatchPolicy = 'fifo' | 'priority';

const DIAGNOSIS_DAG: TimedTask[] = [
  { id: 'sales', dependsOn: [], anomalySeverity: 0.8, estimatedCost: 2, durationMs: 80 },
  { id: 'traffic', dependsOn: [], anomalySeverity: 0.4, estimatedCost: 3, durationMs: 140 },
  { id: 'stock', dependsOn: [], anomalySeverity: 0.95, estimatedCost: 1, durationMs: 40 },
  { id: 'rank', dependsOn: ['sales', 'stock'], anomalySeverity: 0.7, estimatedCost: 2, durationMs: 120 },
  { id: 'verify', dependsOn: ['rank', 'traffic'], anomalySeverity: 0.5, estimatedCost: 1, durationMs: 20 },
];

interface SimulatedRun { durationMs: number; executions: number; dispatchOrder: string[] }

function simulateRun(
  tasks: readonly TimedTask[],
  preserved: ReadonlySet<string>,
  maxParallel: number,
  policy: DispatchPolicy,
): SimulatedRun {
  const completed = new Set(preserved);
  const dispatchOrder: string[] = [];
  let now = 0;
  while (completed.size < tasks.length) {
    const ready = policy === 'priority'
      ? getReadyTasks(tasks, completed, new Set(), maxParallel)
      : tasks.filter((task) =>
        !completed.has(task.id) &&
        task.dependsOn.every((dependency) => completed.has(dependency)),
      ).slice(0, maxParallel);
    if (ready.length === 0) throw new Error('DAG fixture deadlocked');
    now += Math.max(...ready.map((task) => task.durationMs));
    for (const task of ready) {
      dispatchOrder.push(task.id);
      completed.add(task.id);
    }
  }
  return { durationMs: now, executions: dispatchOrder.length, dispatchOrder };
}

function evaluateScheduler(): ModuleEvaluation {
  const injectedFailures: Array<string | null> = [null, 'stock', 'sales', 'traffic'];
  const durationProfiles = [
    { id: 'reference', tasks: DIAGNOSIS_DAG },
    ...deterministicDurations(20_261_023, 5).map((durations, index) => ({
      id: `seeded-${index + 1}`,
      tasks: DIAGNOSIS_DAG.map((task, taskIndex) => ({
        ...task, durationMs: durations[taskIndex]!,
      })),
    })),
  ];
  // Exploratory stress regime added after inspecting the first duration-only
  // results. It tests inaccurate severity inputs; it is not preregistered.
  const noisySeverity = { sales: 0.4, traffic: 0.95, stock: 0.9, rank: 0.7, verify: 0.5 };
  const profiles = [
    ...durationProfiles,
    ...durationProfiles.map(({ id, tasks }) => ({
      id: `noisy-severity-${id}`,
      tasks: tasks.map((task) => ({ ...task, anomalySeverity: noisySeverity[task.id as keyof typeof noisySeverity] })),
    })),
  ];
  const perCase = profiles.flatMap(({ id: profile, tasks }) => injectedFailures.map((failedNode) => {
    const serialInitial = simulateRun(tasks, new Set(), 1, 'fifo');
    const fifoInitial = simulateRun(tasks, new Set(), 2, 'fifo');
    const priorityInitial = simulateRun(tasks, new Set(), 2, 'priority');
    const repairPlan = failedNode ? getLocalRepairPlan(tasks, [failedNode]) : null;
    const serialRetry = failedNode ? simulateRun(tasks, new Set(), 1, 'fifo') : null;
    const fifoFullRetry = failedNode ? simulateRun(tasks, new Set(), 2, 'fifo') : null;
    const priorityFullRetry = failedNode ? simulateRun(tasks, new Set(), 2, 'priority') : null;
    const fifoLocalRetry = repairPlan
      ? simulateRun(tasks, new Set(repairPlan.preserveIds), 2, 'fifo')
      : null;
    const priorityLocalRetry = repairPlan
      ? simulateRun(tasks, new Set(repairPlan.preserveIds), 2, 'priority')
      : null;
    const combine = (first: SimulatedRun, retry: SimulatedRun | null) => ({
      durationMs: first.durationMs + (retry?.durationMs ?? 0),
      executions: first.executions + (retry?.executions ?? 0),
      retryExecutions: retry?.executions ?? 0,
    });
    return {
      scenario: `${profile}:${failedNode === null ? 'no-failure' : `verdict-fail-${failedNode}`}`,
      profile,
      taskDurationsMs: Object.fromEntries(tasks.map((task) => [task.id, task.durationMs])),
      failedNode,
      repairIds: repairPlan?.rerunIds ?? [],
      serialFullRerun: combine(serialInitial, serialRetry),
      parallelFifoFullRerun: combine(fifoInitial, fifoFullRetry),
      priorityFullRerun: combine(priorityInitial, priorityFullRetry),
      parallelFifoLocalRepair: combine(fifoInitial, fifoLocalRetry),
      priorityLocalRepair: combine(priorityInitial, priorityLocalRetry),
      initialDispatch: {
        fifo: fifoInitial.dispatchOrder,
        priority: priorityInitial.dispatchOrder,
      },
    };
  }));
  const regimeSummary = (rows: typeof perCase) => ({
    sampleCount: rows.length,
    fifoFullRerunMeanVirtualMs: mean(rows.map((row) => row.parallelFifoFullRerun.durationMs)),
    priorityLocalRepairMeanVirtualMs: mean(rows.map((row) => row.priorityLocalRepair.durationMs)),
    casesWhereFullSlowerThanParallelFifo: rows.filter((row) =>
      row.priorityLocalRepair.durationMs > row.parallelFifoFullRerun.durationMs,
    ).length,
  });
  const alignedCases = perCase.filter((row) => !row.profile.startsWith('noisy-severity-'));
  const noisyCases = perCase.filter((row) => row.profile.startsWith('noisy-severity-'));

  return {
    id: 'module1',
    name: '依赖图任务调度与局部修复',
    sampleCount: perCase.length,
    metrics: [
      {
        name: '平均模拟完成时间',
        baseline: mean(perCase.map((row) => row.parallelFifoFullRerun.durationMs)),
        full: mean(perCase.map((row) => row.priorityLocalRepair.durationMs)),
        unit: 'virtual-ms', better: 'lower',
      },
      {
        name: '平均任务执行次数',
        baseline: mean(perCase.map((row) => row.parallelFifoFullRerun.executions)),
        full: mean(perCase.map((row) => row.priorityLocalRepair.executions)),
        unit: 'executions', better: 'lower',
      },
    ],
    ablations: {
      serialFullRerun: {
        meanVirtualMs: mean(perCase.map((row) => row.serialFullRerun.durationMs)),
        meanExecutions: mean(perCase.map((row) => row.serialFullRerun.executions)),
      },
      priorityFullRerun: {
        meanVirtualMs: mean(perCase.map((row) => row.priorityFullRerun.durationMs)),
        meanExecutions: mean(perCase.map((row) => row.priorityFullRerun.executions)),
      },
      parallelFifoLocalRepair: {
        meanVirtualMs: mean(perCase.map((row) => row.parallelFifoLocalRepair.durationMs)),
        meanExecutions: mean(perCase.map((row) => row.parallelFifoLocalRepair.executions)),
      },
      casesWhereFullSlowerThanParallelFifo: perCase.filter((row) =>
        row.priorityLocalRepair.durationMs > row.parallelFifoFullRerun.durationMs,
      ).length,
      severityRegimes: {
        aligned: regimeSummary(alignedCases),
        exploratoryNoisy: regimeSummary(noisyCases),
      },
    },
    details: {
      note: 'Six fixed duration profiles (one reference plus five LCG profiles from seed 20261023, each duration 20-200 in steps of 10) crossed with four verdict outcomes. The inaccurate-severity stress regime was added after inspecting initial results, so its pooled average is exploratory and weighted equally by design, not a population estimate. Virtual time models current allSettled batches, not wall-clock latency. Every strategy receives the same DAG, durations, severity inputs, and failure node. Primary baseline is parallel FIFO with full rerun.',
      scenarios: perCase,
      slowerThanParallelFifoExamples: perCase.filter((row) =>
        row.priorityLocalRepair.durationMs > row.parallelFifoFullRerun.durationMs,
      ).slice(0, 8),
    },
  };
}

// ---------------------------------------------------------------------------
// Module 2: fixed-4-char FIFO, density-aware FIFO, and density-aware priority
// with adapter-supplied summaries. Proxy budget checks below reuse the
// selection heuristic and are diagnostics, not independent overflow evidence.
// ---------------------------------------------------------------------------

interface ContextScenario {
  id: string;
  budgetTokens: number;
  chunks: ContextChunk[];
  requiredIds: string[];
}

const CONTEXT_SCENARIOS: ContextScenario[] = [
  {
    id: 'verbose-log-first', budgetTokens: 90, requiredIds: ['sales', 'stock'],
    chunks: [
      { id: 'debug-a', category: 'other', fullText: 'log '.repeat(50), summaryText: 'debug-a' },
      { id: 'debug-b', category: 'other', fullText: 'log '.repeat(45), summaryText: 'debug-b' },
      { id: 'sales', category: 'sales_change', importance: 1, fullText: 'Paid orders decreased 30%. '.repeat(30), summaryText: 'paid orders -30%' },
      { id: 'stock', category: 'stockout', importance: 1, fullText: 'Stock reached zero before the drop. '.repeat(30), summaryText: 'stock=0 before drop' },
    ],
  },
  {
    id: 'dense-export-first', budgetTokens: 12_000, requiredIds: ['sales', 'stock'],
    chunks: [
      { id: 'encoded-export', category: 'other', fullText: 'A'.repeat(48_000), summaryText: 'encoded export contains no business metrics' },
      { id: 'sales', category: 'sales_change', importance: 1, fullText: 'Orders down 30%; source=sales; date=2026-10-09.', summaryText: 'orders -30%' },
      { id: 'stock', category: 'stockout', importance: 1, fullText: 'Stock zero; source=inventory; date=2026-10-08.', summaryText: 'stock=0' },
    ],
  },
  {
    id: 'all-small', budgetTokens: 1_000, requiredIds: ['sales', 'traffic'],
    chunks: [
      { id: 'trace', category: 'other', fullText: 'query succeeded', summaryText: 'query ok' },
      { id: 'sales', category: 'sales_change', fullText: 'Orders down 20%', summaryText: 'orders -20%' },
      { id: 'traffic', category: 'traffic_change', fullText: 'Visitors down 22%', summaryText: 'visitors -22%' },
    ],
  },
  ...[
    {
      id: 'key-first', requiredIds: ['sales', 'stock'],
      chunks: [
        { id: 'sales', category: 'sales_change', importance: 1, fullText: 'Orders -30%; sales export; Oct 9. '.repeat(5), summaryText: 'orders -30%' },
        { id: 'stock', category: 'stockout', importance: 1, fullText: 'Stock zero on Oct 8; warehouse feed. '.repeat(5), summaryText: 'stock=0 Oct 8' },
        { id: 'debug', category: 'other', fullText: 'worker log '.repeat(80), summaryText: 'worker log' },
      ],
    },
    {
      id: 'noise-first', requiredIds: ['sales', 'stock'],
      chunks: [
        { id: 'trace', category: 'other', fullText: 'request trace '.repeat(100), summaryText: 'trace only' },
        { id: 'debug', category: 'other', fullText: 'worker log '.repeat(80), summaryText: 'worker log' },
        { id: 'sales', category: 'sales_change', importance: 1, fullText: 'Orders -31%; sales feed; Oct 9. '.repeat(15), summaryText: 'orders -31%' },
        { id: 'stock', category: 'stockout', importance: 1, fullText: 'Stock zero Oct 8; inventory feed. '.repeat(15), summaryText: 'stock=0 Oct 8' },
      ],
    },
    {
      id: 'stockout-first', requiredIds: ['stock', 'sales'],
      chunks: [
        { id: 'stock', category: 'stockout', importance: 1, fullText: 'Stock zero at 09:00 Oct 8; feed refreshed 10:00. '.repeat(18), summaryText: 'stock=0 before sales drop' },
        { id: 'traffic', category: 'traffic_change', fullText: 'Visitors stable Oct 8-9. '.repeat(10), summaryText: 'visitors stable' },
        { id: 'sales', category: 'sales_change', importance: 1, fullText: 'Orders fell 29% at 12:00 Oct 8. '.repeat(18), summaryText: 'orders -29%' },
      ],
    },
    {
      id: 'traffic-before-sales', requiredIds: ['sales', 'traffic'],
      chunks: [
        { id: 'traffic', category: 'traffic_change', importance: 1, fullText: 'Visitors fell 26% on Oct 8. '.repeat(22), summaryText: 'visitors -26%' },
        { id: 'promotion', category: 'promotion_change', fullText: 'Campaign ended on Oct 7. '.repeat(22), summaryText: 'campaign ended Oct 7' },
        { id: 'sales', category: 'sales_change', importance: 1, fullText: 'Orders fell 30% on Oct 9. '.repeat(22), summaryText: 'orders -30%' },
      ],
    },
    {
      id: 'encoded-first', requiredIds: ['sales', 'stock'],
      chunks: [
        { id: 'encoded-export', category: 'other', fullText: 'A'.repeat(48_000), summaryText: 'raw encoded export' },
        { id: 'sales', category: 'sales_change', importance: 1, fullText: 'Orders fell 30%; source=sales; Oct 9.', summaryText: 'orders -30%' },
        { id: 'stock', category: 'stockout', importance: 1, fullText: 'Stock zero; source=inventory; Oct 8.', summaryText: 'stock=0 Oct 8' },
      ],
    },
    {
      id: 'encoded-last', requiredIds: ['sales', 'stock'],
      chunks: [
        { id: 'sales', category: 'sales_change', importance: 1, fullText: 'Orders fell 30%; source=sales; Oct 9.', summaryText: 'orders -30%' },
        { id: 'stock', category: 'stockout', importance: 1, fullText: 'Stock zero; source=inventory; Oct 8.', summaryText: 'stock=0 Oct 8' },
        { id: 'encoded-export', category: 'other', fullText: 'A'.repeat(48_000), summaryText: 'raw encoded export' },
      ],
    },
    {
      id: 'cjk-dense-first', requiredIds: ['sales', 'stock'],
      chunks: [
        { id: 'debug-cn', category: 'other', fullText: '系统调试记录'.repeat(80), summaryText: '调试记录' },
        { id: 'sales', category: 'sales_change', importance: 1, fullText: '订单销量下降百分之三十'.repeat(15), summaryText: '销量下降30%' },
        { id: 'stock', category: 'stockout', importance: 1, fullText: '十月八日库存为零'.repeat(15), summaryText: '10月8日库存为零' },
      ],
    },
    {
      id: 'counter-evidence-last', requiredIds: ['sales', 'stock', 'counter'],
      chunks: [
        { id: 'price', category: 'price_change', fullText: 'Price unchanged Oct 7-9. '.repeat(20), summaryText: 'price unchanged' },
        { id: 'promotion', category: 'promotion_change', fullText: 'Promotion unchanged Oct 7-9. '.repeat(20), summaryText: 'promotion unchanged' },
        { id: 'sales', category: 'sales_change', importance: 1, fullText: 'Orders fell 30% on Oct 9. '.repeat(20), summaryText: 'orders -30%' },
        { id: 'stock', category: 'stockout', importance: 1, fullText: 'Stock zero on Oct 8. '.repeat(20), summaryText: 'stock=0 Oct 8' },
        { id: 'counter', category: 'counter_evidence', importance: 1, fullText: 'Visitor count remained stable. '.repeat(20), summaryText: 'visitors stable' },
      ],
    },
  ].flatMap((fixture) => [90, 180, 12_000].map((budgetTokens) => ({
    id: `${fixture.id}:budget-${budgetTokens}`,
    budgetTokens,
    chunks: fixture.chunks as ContextChunk[],
    requiredIds: fixture.requiredIds,
  }))),
];

interface ContextRun {
  ids: string[];
  fullIds: string[];
  auditTokens: number;
  overBudgetByHeuristic: boolean;
}

function selectFifo(scenario: ContextScenario, estimate: (text: string) => number): ContextRun {
  const ids: string[] = [];
  let assumedTokens = 0;
  let auditTokens = 0;
  for (const chunk of scenario.chunks) {
    const cost = estimate(chunk.fullText);
    if (assumedTokens + cost > scenario.budgetTokens) continue;
    ids.push(chunk.id);
    assumedTokens += cost;
    auditTokens += estimateTokensHeuristic(chunk.fullText);
  }
  return { ids, fullIds: ids, auditTokens, overBudgetByHeuristic: auditTokens > scenario.budgetTokens };
}

function selectPrioritySummary(scenario: ContextScenario, budgetTokens: number): ContextRun {
  const selection = selectContext(scenario.chunks, budgetTokens);
  return {
    ids: selection.items.map((item) => item.id),
    fullIds: selection.items.filter((item) => item.mode === 'full').map((item) => item.id),
    auditTokens: selection.estimatedTokens,
    overBudgetByHeuristic: selection.estimatedTokens > scenario.budgetTokens,
  };
}

function keyRecall(scenarios: readonly ContextScenario[], runs: readonly ContextRun[]): number {
  let found = 0;
  let required = 0;
  for (let i = 0; i < scenarios.length; i += 1) {
    const scenario = scenarios[i]!;
    const selected = new Set(runs[i]!.ids);
    required += scenario.requiredIds.length;
    found += scenario.requiredIds.filter((id) => selected.has(id)).length;
  }
  return (100 * found) / required;
}

function fullKeyEvidenceRate(scenarios: readonly ContextScenario[], runs: readonly ContextRun[]): number {
  let found = 0;
  let required = 0;
  for (let i = 0; i < scenarios.length; i += 1) {
    const scenario = scenarios[i]!;
    const selectedFull = new Set(runs[i]!.fullIds);
    required += scenario.requiredIds.length;
    found += scenario.requiredIds.filter((id) => selectedFull.has(id)).length;
  }
  return (100 * found) / required;
}

function evaluateContext(): ModuleEvaluation {
  const fixed4 = (text: string): number => Math.ceil(text.length / 4);
  const baseline = CONTEXT_SCENARIOS.map((scenario) => selectFifo(scenario, fixed4));
  const densityOnly = CONTEXT_SCENARIOS.map((scenario) => selectFifo(scenario, estimateTokensHeuristic));
  const fixedThreshold = CONTEXT_SCENARIOS.map((scenario) =>
    selectPrioritySummary(scenario, Math.min(180, scenario.budgetTokens)),
  );
  const full = CONTEXT_SCENARIOS.map((scenario) => selectPrioritySummary(scenario, scenario.budgetTokens));
  const overrunCount = (runs: readonly ContextRun[]) => runs.filter((run) => run.overBudgetByHeuristic).length;
  return {
    id: 'module2',
    name: '密度感知的动态上下文预算',
    sampleCount: CONTEXT_SCENARIOS.length,
    metrics: [
      { name: '关键证据保留率', baseline: keyRecall(CONTEXT_SCENARIOS, baseline), full: keyRecall(CONTEXT_SCENARIOS, full), unit: '%', better: 'higher' },
      { name: '关键证据全文保留率', baseline: fullKeyEvidenceRate(CONTEXT_SCENARIOS, baseline), full: fullKeyEvidenceRate(CONTEXT_SCENARIOS, full), unit: '%', better: 'higher' },
    ],
    ablations: {
      sameEstimatorBudgetCheck: {
        note: 'Internal consistency only: the full selector uses this exact heuristic to decide fit.',
        fixed4FifoProxyOverrunCases: overrunCount(baseline),
        dynamicPrioritySummaryProxyOverrunCases: overrunCount(full),
      },
      densityAwareFifo: { keyEvidenceRecallPct: keyRecall(CONTEXT_SCENARIOS, densityOnly), proxyOverrunCases: overrunCount(densityOnly) },
      fixedThresholdPrioritySummary: {
        thresholdTokens: 180,
        keyEvidenceRecallPct: keyRecall(CONTEXT_SCENARIOS, fixedThreshold),
        fullKeyEvidencePct: fullKeyEvidenceRate(CONTEXT_SCENARIOS, fixedThreshold),
        proxyOverrunCases: overrunCount(fixedThreshold),
      },
      dynamicPrioritySummaryFullKeyEvidencePct: fullKeyEvidenceRate(CONTEXT_SCENARIOS, full),
    },
    details: {
      note: '27 prespecified order/content/budget cases. Full-text retention is a format measure, not answer quality; a summary can be sufficient. Proxy overruns are checked with the same heuristic used by the selector, so zero for the full method is an internal invariant, not independent validation. No model tokenizer or measured context overflow is used. Fixed-threshold ablation caps evidence at 180 tokens while respecting smaller scenario budgets. Summaries are adapter-supplied fixture inputs whose factual fidelity is assumed here.',
      scenarios: CONTEXT_SCENARIOS.map((scenario, i) => ({
        id: scenario.id, budgetTokens: scenario.budgetTokens, requiredIds: scenario.requiredIds,
        inputChunks: scenario.chunks.map((chunk) => ({
          id: chunk.id, category: chunk.category,
          fullCharacters: chunk.fullText.length, summaryCharacters: chunk.summaryText.length,
        })),
        fixed4Fifo: baseline[i], densityAwareFifo: densityOnly[i],
        fixedThresholdPrioritySummary: fixedThreshold[i], densityPrioritySummary: full[i],
        missedRequiredIds: {
          fixed4Fifo: scenario.requiredIds.filter((id) => !baseline[i]!.ids.includes(id)),
          densityPrioritySummary: scenario.requiredIds.filter((id) => !full[i]!.ids.includes(id)),
        },
      })),
      fullMissExamples: CONTEXT_SCENARIOS.flatMap((scenario, i) => {
        const missedIds = scenario.requiredIds.filter((id) => !full[i]!.ids.includes(id));
        return missedIds.length ? [{ id: scenario.id, missedIds }] : [];
      }).slice(0, 8),
      fullWorseRecallExamples: CONTEXT_SCENARIOS.flatMap((scenario, i) => {
        const baselineHits = scenario.requiredIds.filter((id) => baseline[i]!.ids.includes(id)).length;
        const fullHits = scenario.requiredIds.filter((id) => full[i]!.ids.includes(id)).length;
        return fullHits < baselineHits ? [{ id: scenario.id, baselineHits, fullHits }] : [];
      }).slice(0, 8),
    },
  };
}

// ---------------------------------------------------------------------------
// Module 3: exhaustive policy matrix. The oracle is an explicit policy table
// independent of decideToolCall; it does not call the production gate.
// ---------------------------------------------------------------------------

type Action = ToolDecision['action'];
type Matrix = Record<Action, Record<Action, number>>;

interface PolicyCase {
  mode: PermissionMode;
  active: boolean;
  sourceState: SourceState;
  prerequisiteMet: boolean;
  metricAllowed: boolean;
  toolSupportsMetric: boolean;
  operation: 'read' | 'write';
  risk: number;
  approvalGranted: boolean;
}

const ACTIONS: Action[] = ['execute', 'block', 'request_approval'];

function blankMatrix(): Matrix {
  return Object.fromEntries(ACTIONS.map((expected) => [
    expected, Object.fromEntries(ACTIONS.map((actual) => [actual, 0])),
  ])) as Matrix;
}

/** Evaluation policy contract, expressed separately from the production function. */
function oracle(input: PolicyCase): Action {
  const hardDenied =
    (input.mode === 'safe' && input.operation === 'write') ||
    !input.active || input.sourceState !== 'healthy' ||
    !input.prerequisiteMet || !input.metricAllowed || !input.toolSupportsMetric;
  if (hardDenied) return 'block';
  const approvalNeeded = input.risk >= 0.7 || (input.mode === 'ask' && input.operation === 'write');
  return approvalNeeded && !input.approvalGranted ? 'request_approval' : 'execute';
}

/** Permission-only baseline: no source, scope, prerequisite, or business-risk policy. */
function permissionOnly(input: PolicyCase): Action {
  if (input.mode === 'safe' && input.operation === 'write') return 'block';
  if (input.mode === 'ask' && input.operation === 'write' && !input.approvalGranted) return 'request_approval';
  return 'execute';
}

function* policyCases(): Generator<PolicyCase> {
  for (const mode of ['safe', 'ask', 'allow-all'] as const) {
    for (const active of [false, true]) {
      for (const sourceState of ['healthy', 'stale', 'unavailable'] as const) {
        for (const prerequisiteMet of [false, true]) {
          for (const metricAllowed of [false, true]) {
            for (const toolSupportsMetric of [false, true]) {
              for (const operation of ['read', 'write'] as const) {
                for (const risk of [0.1, 0.5, 0.9]) {
                  for (const approvalGranted of [false, true]) {
                    yield { mode, active, sourceState, prerequisiteMet, metricAllowed, toolSupportsMetric, operation, risk, approvalGranted };
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}

function evaluateGate(): ModuleEvaluation {
  const request: ToolCallRequest = {
    caseId: 'fixture-case', toolName: 'get_sku_inventory', sourceSlug: 'commerce',
    metric: 'stock_on_hand', operation: 'read', businessRisk: 0,
  };
  const baselineMatrix = blankMatrix();
  const fullMatrix = blankMatrix();
  const ablationMatrices = {
    noBusinessRisk: blankMatrix(),
    noSourceState: blankMatrix(),
    noPrerequisite: blankMatrix(),
  };
  const baselineFailures: Array<{ input: PolicyCase; expected: Action; actual: Action }> = [];
  const fullFailures: Array<{ input: PolicyCase; expected: Action; actual: Action }> = [];
  const ablationFailures: Record<keyof typeof ablationMatrices,
    Array<{ input: PolicyCase; expected: Action; actual: Action }>> = {
    noBusinessRisk: [], noSourceState: [], noPrerequisite: [],
  };
  let samples = 0;

  for (const input of policyCases()) {
    const expected = oracle(input);
    const baseline = permissionOnly(input);
    const context: ToolGateContext = {
      permissionMode: input.mode,
      activeSourceSlugs: input.active ? new Set(['commerce']) : new Set(),
      sourceStates: { commerce: input.sourceState },
      allowedMetrics: input.metricAllowed ? new Set(['stock_on_hand']) : new Set(),
      toolMetrics: { get_sku_inventory: input.toolSupportsMetric ? ['stock_on_hand'] : ['visitors'] },
      prerequisiteMet: input.prerequisiteMet,
      approvalGranted: input.approvalGranted,
    };
    const actual = decideToolCall({ ...request, operation: input.operation, businessRisk: input.risk }, context).action;
    const ablated: Record<keyof typeof ablationMatrices, Action> = {
      noBusinessRisk: decideToolCall({ ...request, operation: input.operation, businessRisk: 0 }, context).action,
      noSourceState: decideToolCall(
        { ...request, operation: input.operation, businessRisk: input.risk },
        { ...context, sourceStates: { commerce: 'healthy' } },
      ).action,
      noPrerequisite: decideToolCall(
        { ...request, operation: input.operation, businessRisk: input.risk },
        { ...context, prerequisiteMet: true },
      ).action,
    };
    baselineMatrix[expected][baseline] += 1;
    fullMatrix[expected][actual] += 1;
    if (expected !== baseline && baselineFailures.length < 8) baselineFailures.push({ input, expected, actual: baseline });
    if (expected !== actual && fullFailures.length < 8) fullFailures.push({ input, expected, actual });
    for (const name of Object.keys(ablationMatrices) as Array<keyof typeof ablationMatrices>) {
      const predicted = ablated[name];
      ablationMatrices[name][expected][predicted] += 1;
      if (expected !== predicted && ablationFailures[name].length < 8) {
        ablationFailures[name].push({ input, expected, actual: predicted });
      }
    }
    samples += 1;
  }

  const correct = (matrix: Matrix) => ACTIONS.reduce((sum, action) => sum + matrix[action][action], 0);
  const macroRecall = (matrix: Matrix) => 100 * mean(ACTIONS.map((action) => {
    const rowTotal = ACTIONS.reduce((sum, predicted) => sum + matrix[action][predicted], 0);
    return rowTotal ? matrix[action][action] / rowTotal : 0;
  }));
  const unauthorizedExecutions = (matrix: Matrix) => matrix.block.execute + matrix.request_approval.execute;
  const falseBlocks = (matrix: Matrix) => matrix.execute.block + matrix.request_approval.block;
  return {
    id: 'module3',
    name: '多级工具调用决策',
    sampleCount: samples,
    metrics: [
      { name: '政策决策准确率', baseline: (100 * correct(baselineMatrix)) / samples, full: (100 * correct(fullMatrix)) / samples, unit: '%', better: 'higher' },
      { name: '三类决策宏平均召回率', baseline: macroRecall(baselineMatrix), full: macroRecall(fullMatrix), unit: '%', better: 'higher' },
      { name: '未经许可直接执行数', baseline: unauthorizedExecutions(baselineMatrix), full: unauthorizedExecutions(fullMatrix), unit: 'calls', better: 'lower' },
      { name: '误阻断数', baseline: falseBlocks(baselineMatrix), full: falseBlocks(fullMatrix), unit: 'calls', better: 'lower' },
    ],
    ablations: {
      permissionOnly: {
        accuracyPct: (100 * correct(baselineMatrix)) / samples,
        unauthorizedExecutions: unauthorizedExecutions(baselineMatrix),
        falseBlocks: falseBlocks(baselineMatrix),
      },
      ...Object.fromEntries((Object.keys(ablationMatrices) as Array<keyof typeof ablationMatrices>).map((name) => [
        name,
        {
          accuracyPct: (100 * correct(ablationMatrices[name])) / samples,
          unauthorizedExecutions: unauthorizedExecutions(ablationMatrices[name]),
          falseBlocks: falseBlocks(ablationMatrices[name]),
        },
      ])),
    },
    details: {
      note: 'Exhaustive deterministic policy conformance, not a measurement of real user behavior or real tool side effects. Rows are oracle action; columns are predicted action.',
      expectedClassCounts: Object.fromEntries(ACTIONS.map((action) => [
        action, ACTIONS.reduce((sum, predicted) => sum + fullMatrix[action][predicted], 0),
      ])),
      baselineConfusionMatrix: baselineMatrix,
      fullConfusionMatrix: fullMatrix,
      ablationConfusionMatrices: ablationMatrices,
      baselineFailureExamples: baselineFailures,
      fullFailureExamples: fullFailures,
      ablationFailureExamples: ablationFailures,
    },
  };
}

/** Reproducible, read-only comparisons for the first three Agent modules. */
export async function evaluateModules123(): Promise<ModuleEvaluation[]> {
  return [evaluateScheduler(), evaluateContext(), evaluateGate()];
}
