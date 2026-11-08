import { getLocalRepairPlan, getReadyTasks, type TaskNode } from '../algorithms/scheduler.ts';

export interface ExecutableTask extends TaskNode {
  run(results: ReadonlyMap<string, unknown>): Promise<unknown> | unknown;
}

export interface TaskExecutionEvent {
  kind: 'dispatch' | 'completed' | 'repair';
  taskIds: string[];
  detail: string;
}

export interface TaskExecutionResult {
  results: Map<string, unknown>;
  events: TaskExecutionEvent[];
  repairRounds: number;
}

export interface TaskExecutionOptions {
  maxParallel: number;
  maxRepairRounds?: number;
  /** Return false for failures that must not be retried, such as a timed-out call whose adapter may still be running. */
  shouldRetryFailure?(error: unknown, taskId: string): boolean;
  /** After all nodes finish, name failed nodes whose result did not pass validation. */
  verdict?(results: ReadonlyMap<string, unknown>): Promise<string[]> | string[];
  onEvent?(event: TaskExecutionEvent): void;
}

/**
 * Execute a DAG and repair only a failed node and its transitive consumers.
 * Independent upstream results are retained. A bounded repair count prevents
 * repeated bad data or a permanently failing tool from looping forever.
 */
export async function executeTaskGraph(
  tasks: readonly ExecutableTask[],
  options: TaskExecutionOptions,
): Promise<TaskExecutionResult> {
  if (!Number.isInteger(options.maxParallel) || options.maxParallel < 1) {
    throw new Error('maxParallel must be a positive integer');
  }
  const maxRepairRounds = options.maxRepairRounds ?? 1;
  if (!Number.isInteger(maxRepairRounds) || maxRepairRounds < 0 || maxRepairRounds > 10) {
    throw new Error('maxRepairRounds must be between 0 and 10');
  }
  const nodeSpecs: TaskNode[] = tasks.map(({ id, dependsOn, anomalySeverity, estimatedCost }) =>
    ({ id, dependsOn, anomalySeverity, estimatedCost }));
  const byId = new Map(tasks.map(task => [task.id, task]));
  const results = new Map<string, unknown>();
  const events: TaskExecutionEvent[] = [];
  let repairRounds = 0;
  const emit = (event: TaskExecutionEvent) => {
    events.push(event);
    options.onEvent?.(event);
  };

  while (true) {
    while (results.size < tasks.length) {
      const ready = getReadyTasks(nodeSpecs, new Set(results.keys()), new Set(), options.maxParallel);
      if (ready.length === 0) throw new Error('Task graph made no progress');
      emit({ kind: 'dispatch', taskIds: ready.map(item => item.id),
        detail: `Dispatch: ${ready.map(item => item.id).join(', ')}` });
      const settled = await Promise.allSettled(ready.map(item =>
        Promise.resolve().then(() => byId.get(item.id)!.run(results))));
      const failedIds: string[] = [];
      const failureReasons: string[] = [];
      const nonRetryableReasons: string[] = [];
      settled.forEach((outcome, index) => {
        const id = ready[index]!.id;
        if (outcome.status === 'fulfilled') {
          results.set(id, outcome.value);
          emit({ kind: 'completed', taskIds: [id], detail: `Completed: ${id}` });
        } else {
          failedIds.push(id);
          failureReasons.push(`${id}: ${String(outcome.reason)}`);
          if (options.shouldRetryFailure?.(outcome.reason, id) === false) {
            nonRetryableReasons.push(`${id}: ${String(outcome.reason)}`);
          }
        }
      });
      if (failedIds.length) {
        if (nonRetryableReasons.length) {
          throw new Error(`Non-retryable task failure for: ${nonRetryableReasons.join('; ')}`);
        }
        if (repairRounds >= maxRepairRounds) {
          throw new Error(`Repair budget exhausted for: ${failureReasons.join('; ')}`);
        }
        const plan = getLocalRepairPlan(nodeSpecs, failedIds);
        for (const id of plan.rerunIds) results.delete(id);
        repairRounds += 1;
        emit({ kind: 'repair', taskIds: plan.rerunIds,
          detail: `Repair ${repairRounds}: rerun ${plan.rerunIds.join(', ')}; preserve ${plan.preserveIds.join(', ')}` });
      }
    }
    const failedIds = await options.verdict?.(results) ?? [];
    if (!failedIds.length) return { results, events, repairRounds };
    if (repairRounds >= maxRepairRounds) {
      throw new Error(`Repair budget exhausted after verdict for: ${failedIds.join(', ')}`);
    }
    const plan = getLocalRepairPlan(nodeSpecs, failedIds);
    for (const id of plan.rerunIds) results.delete(id);
    repairRounds += 1;
    emit({ kind: 'repair', taskIds: plan.rerunIds,
      detail: `Verdict repair ${repairRounds}: rerun ${plan.rerunIds.join(', ')}; preserve ${plan.preserveIds.join(', ')}` });
  }
}
