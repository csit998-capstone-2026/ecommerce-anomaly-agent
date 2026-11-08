/** A diagnosis step. Severity is a number from 0 to 1, not a probability. */
export interface TaskNode {
  id: string;
  dependsOn: readonly string[];
  anomalySeverity: number;
  /** Relative execution cost, such as an estimated number of tool calls. */
  estimatedCost: number;
}

export interface LocalRepairPlan {
  /** Failed nodes and every node that consumes their output. */
  rerunIds: string[];
  /** Independent or upstream results that remain valid. */
  preserveIds: string[];
}

interface TaskGraph {
  nodes: readonly TaskNode[];
  byId: Map<string, TaskNode>;
  dependents: Map<string, Set<string>>;
}

function buildTaskGraph(nodes: readonly TaskNode[]): TaskGraph {
  if (nodes.length === 0) throw new Error('Task graph must contain at least one node');
  const byId = new Map<string, TaskNode>();
  const dependents = new Map<string, Set<string>>();

  for (const node of nodes) {
    if (!node.id?.trim()) throw new Error('Task id must not be empty');
    if (byId.has(node.id)) throw new Error(`Duplicate task id: ${node.id}`);
    if (!Number.isFinite(node.anomalySeverity) || node.anomalySeverity < 0 || node.anomalySeverity > 1) {
      throw new Error(`Invalid anomaly severity for ${node.id}`);
    }
    if (!Number.isFinite(node.estimatedCost) || node.estimatedCost <= 0) {
      throw new Error(`Invalid estimated cost for ${node.id}`);
    }
    byId.set(node.id, node);
    dependents.set(node.id, new Set());
  }

  for (const node of nodes) {
    const seenDependencies = new Set<string>();
    for (const dependency of node.dependsOn) {
      if (!byId.has(dependency)) throw new Error(`Unknown dependency ${dependency} for ${node.id}`);
      if (seenDependencies.has(dependency)) throw new Error(`Duplicate dependency ${dependency} for ${node.id}`);
      seenDependencies.add(dependency);
      dependents.get(dependency)!.add(node.id);
    }
  }

  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string): void => {
    if (state.get(id) === 'visiting') throw new Error(`Dependency cycle includes ${id}`);
    if (state.get(id) === 'done') return;
    state.set(id, 'visiting');
    for (const dependency of byId.get(id)!.dependsOn) visit(dependency);
    state.set(id, 'done');
  };
  for (const node of nodes) visit(node.id);
  return { nodes, byId, dependents };
}

function countDownstream(graph: TaskGraph, id: string): number {
  const seen = new Set<string>();
  const queue = [...graph.dependents.get(id)!];
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head]!;
    if (seen.has(current)) continue;
    seen.add(current);
    queue.push(...graph.dependents.get(current)!);
  }
  return seen.size;
}

/**
 * Pick ready work without violating dependencies or the concurrency limit.
 * Priority is lexicographic: more severe anomaly, more downstream consumers,
 * lower estimated cost, then task id. This avoids an opaque weighted score.
 */
export function getReadyTasks(
  nodes: readonly TaskNode[],
  completedIds: ReadonlySet<string>,
  runningIds: ReadonlySet<string>,
  maxParallel: number,
): TaskNode[] {
  const graph = buildTaskGraph(nodes);
  if (!Number.isInteger(maxParallel) || maxParallel < 1) throw new Error('maxParallel must be a positive integer');
  for (const id of [...completedIds, ...runningIds]) {
    if (!graph.byId.has(id)) throw new Error(`Unknown task state id: ${id}`);
  }
  for (const id of completedIds) {
    if (runningIds.has(id)) throw new Error(`Task cannot be both completed and running: ${id}`);
  }
  const freeSlots = Math.max(0, maxParallel - runningIds.size);
  if (freeSlots === 0) return [];

  return nodes
    .filter((node) => !completedIds.has(node.id) && !runningIds.has(node.id))
    .filter((node) => node.dependsOn.every((dependency) => completedIds.has(dependency)))
    .sort((a, b) =>
      b.anomalySeverity - a.anomalySeverity ||
      countDownstream(graph, b.id) - countDownstream(graph, a.id) ||
      a.estimatedCost - b.estimatedCost ||
      a.id.localeCompare(b.id),
    )
    .slice(0, freeSlots);
}

/**
 * Return the smallest dependency-closed set to reset after a failed verdict.
 * The caller resets these nodes to pending, then calls getReadyTasks again.
 */
export function getLocalRepairPlan(nodes: readonly TaskNode[], failedNodeIds: readonly string[]): LocalRepairPlan {
  const graph = buildTaskGraph(nodes);
  if (failedNodeIds.length === 0) throw new Error('At least one failed task id is required');
  for (const id of failedNodeIds) {
    if (!graph.byId.has(id)) throw new Error(`Unknown failed task id: ${id}`);
  }
  const affected = new Set<string>();
  const queue = [...failedNodeIds];
  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head]!;
    if (affected.has(id)) continue;
    affected.add(id);
    queue.push(...graph.dependents.get(id)!);
  }
  return {
    rerunIds: nodes.filter((node) => affected.has(node.id)).map((node) => node.id),
    preserveIds: nodes.filter((node) => !affected.has(node.id)).map((node) => node.id),
  };
}
