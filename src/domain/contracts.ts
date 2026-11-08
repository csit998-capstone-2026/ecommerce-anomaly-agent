/** Shared contracts for one store, one SKU, and one diagnosis window. */

export const SCHEMA_VERSION = 1 as const;

export type QueryStatus = 'ok' | 'missing' | 'error';

export type Metric =
  | 'units_sold'
  | 'paid_orders'
  | 'visitors'
  | 'stock_on_hand'
  | 'price'
  | 'promotion_active';

export const METRIC_UNITS: Record<Metric, string> = {
  units_sold: 'items',
  paid_orders: 'orders',
  visitors: 'visitors',
  stock_on_hand: 'items',
  price: 'CNY',
  promotion_active: 'flag',
};

/** Dates are inclusive ISO calendar dates (YYYY-MM-DD). */
export interface DateWindow {
  start: string;
  end: string;
}

export interface DiagnosisCase {
  schemaVersion: typeof SCHEMA_VERSION;
  caseId: string;
  storeId: string;
  skuId: string;
  baselineWindow: DateWindow;
  anomalyWindow: DateWindow;
}

/** A missing/failed measurement has value=null; a measured zero has value=0. */
export interface Observation {
  schemaVersion: typeof SCHEMA_VERSION;
  observationId: string;
  caseId: string;
  storeId: string;
  skuId: string;
  observedDate: string;
  metric: Metric;
  value: number | null;
  unit: string;
  source: string;
  sourceUpdatedAt: string | null;
  fetchedAt: string;
  status: QueryStatus;
  error?: string;
}

export type Cause = 'stockout' | 'traffic_decline' | 'conversion_decline' | 'price_or_promotion_change';

export interface Evidence {
  evidenceId: string;
  caseId: string;
  cause: Cause;
  observationIds: string[];
  polarity: 'supports' | 'contradicts';
  strength: number;
  quality: number;
  temporalMatch: number;
  explanation: string;
}

export interface RankedHypothesis {
  caseId: string;
  cause: Cause;
  /** A ranking score, not a causal probability. */
  score: number;
  supportEvidenceIds: string[];
  contradictionEvidenceIds: string[];
  missingMetrics: Metric[];
}

export interface ToolDecision {
  caseId: string;
  toolName: string;
  action: 'execute' | 'block' | 'request_approval';
  reason: string;
}

export interface Verification {
  caseId: string;
  status: 'supported' | 'needs_data' | 'contradicted' | 'insufficient';
  reason: string;
  nextQuery?: { toolName: string; metric: Metric };
}
