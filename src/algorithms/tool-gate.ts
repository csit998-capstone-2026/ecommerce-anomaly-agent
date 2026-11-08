import { METRIC_UNITS, type Metric, type ToolDecision } from '../domain/contracts.ts';

export type PermissionMode = 'safe' | 'ask' | 'allow-all';
export type SourceState = 'healthy' | 'stale' | 'unavailable';

/** The model or workflow proposes a specific business-data tool call. */
export interface ToolCallRequest {
  caseId: string;
  toolName: string;
  sourceSlug: string;
  metric: Metric;
  operation: 'read' | 'write';
  /** Data sensitivity or operational impact, from 0 to 1. */
  businessRisk: number;
}

export interface ToolGateContext {
  permissionMode: PermissionMode;
  activeSourceSlugs: ReadonlySet<string>;
  sourceStates: Readonly<Record<string, SourceState>>;
  /** Metrics required and authorized for this diagnosis. */
  allowedMetrics: ReadonlySet<Metric>;
  /** Optional declared capabilities for each tool. */
  toolMetrics?: Readonly<Record<string, readonly Metric[]>>;
  prerequisiteMet: boolean;
  /** Approval for this exact proposed call, supplied by the caller. */
  approvalGranted?: boolean;
}

function decision(request: ToolCallRequest, action: ToolDecision['action'], reason: string): ToolDecision {
  return { caseId: request.caseId, toolName: request.toolName, action, reason };
}

/**
 * Deterministic pre-execution gate. It does not pick a tool for the Agent;
 * it decides whether the proposed call may execute, must stop, or needs a
 * human approval. The data adapter must enforce scope/authorization again.
 */
export function decideToolCall(request: ToolCallRequest, context: ToolGateContext): ToolDecision {
  if (!request.caseId?.trim() || !request.toolName?.trim() || !request.sourceSlug?.trim()) {
    throw new Error('caseId, toolName, and sourceSlug are required');
  }
  if (!Object.hasOwn(METRIC_UNITS, request.metric)) throw new Error(`Unsupported metric: ${request.metric}`);
  if (request.operation !== 'read' && request.operation !== 'write') throw new Error('Unsupported tool operation');
  if (!Number.isFinite(request.businessRisk) || request.businessRisk < 0 || request.businessRisk > 1) {
    throw new Error('businessRisk must be between 0 and 1');
  }
  if (!['safe', 'ask', 'allow-all'].includes(context.permissionMode)) throw new Error('Unsupported permission mode');

  // Hard stop before source activation or approval: safe mode never permits mutations.
  if (context.permissionMode === 'safe' && request.operation === 'write') {
    return decision(request, 'block', 'Write operation is blocked in safe mode');
  }
  if (!context.activeSourceSlugs.has(request.sourceSlug)) {
    return decision(request, 'block', 'Data source is not active');
  }
  const sourceState = context.sourceStates[request.sourceSlug];
  if (sourceState !== 'healthy') {
    return decision(request, 'block', sourceState === 'stale' ? 'Data source is stale' : 'Data source is unavailable');
  }
  if (!context.allowedMetrics.has(request.metric)) {
    return decision(request, 'block', 'Metric is outside this diagnosis scope');
  }
  if (context.toolMetrics && !context.toolMetrics[request.toolName]?.includes(request.metric)) {
    return decision(request, 'block', 'Tool does not provide the required metric');
  }
  if (!context.prerequisiteMet) {
    return decision(request, 'block', 'Tool prerequisite has not been satisfied');
  }

  const needsApproval =
    request.businessRisk >= 0.7 ||
    (request.operation === 'write' && context.permissionMode === 'ask');
  if (needsApproval && !context.approvalGranted) {
    return decision(request, 'request_approval', 'Business risk or permission mode requires approval');
  }
  return decision(request, 'execute', 'Source, scope, prerequisite, and risk checks passed');
}
