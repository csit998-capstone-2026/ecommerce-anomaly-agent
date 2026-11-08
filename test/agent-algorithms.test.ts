import assert from 'node:assert/strict';
import test from 'node:test';
import { getLocalRepairPlan, getReadyTasks, type TaskNode } from '../src/algorithms/scheduler.ts';
import {
  budgetFromContextWindow,
  estimateTokensHeuristic,
  selectContext,
  type ContextChunk,
} from '../src/algorithms/context-budget.ts';
import {
  decideToolCall,
  type ToolCallRequest,
  type ToolGateContext,
} from '../src/algorithms/tool-gate.ts';

const graph: TaskNode[] = [
  { id: 'sales', dependsOn: [], anomalySeverity: 0.7, estimatedCost: 2 },
  { id: 'traffic', dependsOn: [], anomalySeverity: 0.6, estimatedCost: 1 },
  { id: 'stock', dependsOn: [], anomalySeverity: 0.9, estimatedCost: 1 },
  { id: 'rank', dependsOn: ['sales', 'traffic', 'stock'], anomalySeverity: 0.8, estimatedCost: 2 },
  { id: 'verify', dependsOn: ['rank'], anomalySeverity: 0.8, estimatedCost: 1 },
];

test('scheduler prioritizes severe independent checks and waits for every dependency', () => {
  assert.deepEqual(getReadyTasks(graph, new Set(), new Set(), 2).map((n) => n.id), ['stock', 'sales']);
  assert.deepEqual(getReadyTasks(graph, new Set(['stock']), new Set(['sales']), 2).map((n) => n.id), ['traffic']);
  assert.deepEqual(getReadyTasks(graph, new Set(['sales', 'traffic', 'stock']), new Set(), 2).map((n) => n.id), ['rank']);
  assert.deepEqual(getReadyTasks(graph, new Set(['sales', 'traffic', 'stock', 'rank']), new Set(), 2).map((n) => n.id), ['verify']);
});

test('scheduler uses downstream impact and cost to break equal-severity ties', () => {
  const nodes: TaskNode[] = [
    { id: 'minor', dependsOn: [], anomalySeverity: 0.6, estimatedCost: 1 },
    { id: 'root', dependsOn: [], anomalySeverity: 0.6, estimatedCost: 3 },
    { id: 'consumer', dependsOn: ['root'], anomalySeverity: 0.6, estimatedCost: 1 },
  ];
  assert.equal(getReadyTasks(nodes, new Set(), new Set(), 1)[0]?.id, 'root');
  assert.throws(() => getReadyTasks([
    { id: 'a', dependsOn: ['b'], anomalySeverity: 0.5, estimatedCost: 1 },
    { id: 'b', dependsOn: ['a'], anomalySeverity: 0.5, estimatedCost: 1 },
  ], new Set(), new Set(), 1), /cycle/i);
});

test('local repair reruns a failed branch and its consumers, preserving unrelated data', () => {
  const plan = getLocalRepairPlan(graph, ['stock']);
  assert.deepEqual(plan.rerunIds, ['stock', 'rank', 'verify']);
  assert.deepEqual(plan.preserveIds, ['sales', 'traffic']);
  assert.deepEqual(
    getReadyTasks(graph, new Set(plan.preserveIds), new Set(), 2).map((n) => n.id),
    ['stock'],
  );
  assert.throws(() => getLocalRepairPlan(graph, ['unknown']), /Unknown failed task/);
});

test('density heuristic catches long encoded output and does not claim exact tokenizer counts', () => {
  const dense = 'A'.repeat(30_000);
  const prose = 'Sales decreased after inventory reached zero. '.repeat(800);
  assert.equal(estimateTokensHeuristic(dense), 20_000);
  assert.equal(estimateTokensHeuristic(prose), Math.ceil(prose.length / 4));
  assert.ok(estimateTokensHeuristic('销量下降'.repeat(100)) > Math.ceil('销量下降'.repeat(100).length / 4));
});

test('context budget scales with the model window and remaining free space', () => {
  assert.equal(budgetFromContextWindow(64_000, 0), 6_400);
  assert.equal(budgetFromContextWindow(200_000, 0), 12_000);
  assert.equal(budgetFromContextWindow(16_000, 15_000), 1_000);
  assert.equal(budgetFromContextWindow(16_000, 16_000), 0);
});

const chunks: ContextChunk[] = [
  {
    id: 'bulk-log', category: 'other', importance: 1,
    fullText: 'debug '.repeat(120), summaryText: 'debug-log',
  },
  {
    id: 'stockout', category: 'stockout', importance: 1,
    fullText: 'Inventory remained at zero for three days. '.repeat(30),
    summaryText: 'stock=0 on 2026-10-09',
  },
  {
    id: 'sales-drop', category: 'sales_change', importance: 1,
    fullText: 'Paid orders fell by 30 percent after stockout. '.repeat(30),
    summaryText: 'orders down 30%',
  },
];

test('context budget keeps short key evidence ahead of a long low-value result', () => {
  const selection = selectContext(chunks, 12);
  assert.ok(selection.estimatedTokens <= 12);
  assert.deepEqual(selection.items.slice(0, 2).map((item) => item.id), ['sales-drop', 'stockout']);
  assert.ok(selection.items.slice(0, 2).every((item) => item.mode === 'summary'));
});

test('context budget upgrades selected evidence to full text when room remains', () => {
  const selection = selectContext(chunks, 1_000);
  assert.equal(selection.omittedIds.length, 0);
  assert.ok(selection.items.every((item) => item.mode === 'full'));
  assert.ok(selection.estimatedTokens <= 1_000);
  assert.throws(() => selectContext([{ ...chunks[0]!, id: 'same' }, { ...chunks[1]!, id: 'same' }], 20), /Duplicate/);
});

const request: ToolCallRequest = {
  caseId: 'case-001',
  toolName: 'get_sku_inventory',
  sourceSlug: 'commerce',
  metric: 'stock_on_hand',
  operation: 'read',
  businessRisk: 0.1,
};

function gateContext(overrides: Partial<ToolGateContext> = {}): ToolGateContext {
  return {
    permissionMode: 'safe',
    activeSourceSlugs: new Set(['commerce']),
    sourceStates: { commerce: 'healthy' },
    allowedMetrics: new Set(['stock_on_hand']),
    toolMetrics: { get_sku_inventory: ['stock_on_hand'] },
    prerequisiteMet: true,
    ...overrides,
  };
}

test('tool gate executes a permitted fresh read and blocks unavailable or out-of-scope data', () => {
  assert.equal(decideToolCall(request, gateContext()).action, 'execute');
  assert.equal(decideToolCall(request, gateContext({ activeSourceSlugs: new Set() })).action, 'block');
  assert.equal(decideToolCall(request, gateContext({ sourceStates: { commerce: 'stale' } })).action, 'block');
  assert.equal(decideToolCall(request, gateContext({ prerequisiteMet: false })).action, 'block');
  assert.equal(decideToolCall(request, gateContext({ allowedMetrics: new Set() })).action, 'block');
  assert.equal(decideToolCall(request, gateContext({ toolMetrics: { get_sku_inventory: ['visitors'] } })).action, 'block');
});

test('tool gate requests approval for high-risk reads and writes, but safe mode blocks writes', () => {
  const highRisk = { ...request, businessRisk: 0.8 };
  assert.equal(decideToolCall(highRisk, gateContext()).action, 'request_approval');
  assert.equal(decideToolCall(highRisk, gateContext({ approvalGranted: true })).action, 'execute');

  const write: ToolCallRequest = { ...request, operation: 'write', businessRisk: 0.2 };
  assert.equal(decideToolCall(write, gateContext()).action, 'block');
  assert.equal(decideToolCall(write, gateContext({ permissionMode: 'ask' })).action, 'request_approval');
  assert.equal(decideToolCall(write, gateContext({ permissionMode: 'ask', approvalGranted: true })).action, 'execute');
  assert.throws(() => decideToolCall({ ...request, businessRisk: 2 }, gateContext()), /between 0 and 1/);
});
