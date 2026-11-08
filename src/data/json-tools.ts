import { readFile } from 'node:fs/promises';
import type { DiagnosisCase, Metric, Observation } from '../domain/contracts.ts';
import { validateDiagnosisCase, validateObservation } from '../domain/validation.ts';
import type { ReadOnlyDiagnosisTools } from '../agent/diagnose.ts';

export interface BusinessDataset {
  diagnosisCase: DiagnosisCase;
  observations: Observation[];
  /** User-declared provenance; the loader cannot authenticate a business source. */
  synthetic?: boolean;
  provenance?: string;
}

export function validateBusinessDataset(value: unknown): BusinessDataset {
  if (!value || typeof value !== 'object') throw new Error('Dataset must be an object');
  const candidate = value as Record<string, unknown>;
  if (!candidate.diagnosisCase || !Array.isArray(candidate.observations)) {
    throw new Error('Dataset needs diagnosisCase and observations[]');
  }
  const dataset = candidate as unknown as BusinessDataset;
  if (dataset.synthetic !== undefined && typeof dataset.synthetic !== 'boolean') {
    throw new Error('synthetic must be a boolean when supplied');
  }
  if (dataset.provenance !== undefined && (typeof dataset.provenance !== 'string' || !dataset.provenance.trim())) {
    throw new Error('provenance must be a nonempty string when supplied');
  }
  validateDiagnosisCase(dataset.diagnosisCase);
  const ids = new Set<string>();
  const logicalRows = new Set<string>();
  for (const item of dataset.observations) {
    validateObservation(dataset.diagnosisCase, item);
    if (ids.has(item.observationId)) throw new Error(`Duplicate observationId: ${item.observationId}`);
    ids.add(item.observationId);
    const logicalKey = `${item.metric}\u0000${item.observedDate}\u0000${item.source}`;
    if (logicalRows.has(logicalKey)) {
      throw new Error(`Duplicate metric/date/source row: ${item.metric} ${item.observedDate} ${item.source}`);
    }
    logicalRows.add(logicalKey);
  }
  return dataset;
}

export async function loadBusinessDataset(filename: string): Promise<BusinessDataset> {
  const text = await readFile(filename, 'utf8');
  return validateBusinessDataset(JSON.parse(text));
}

/** All records are validated before the first call; every query is scoped and returns copies. */
export function createJsonReadOnlyTools(dataset: BusinessDataset): ReadOnlyDiagnosisTools {
  validateBusinessDataset(dataset);
  // The caller may retain and mutate its parsed JSON object. Capture the
  // validated primitive scope and rows so later queries see a stable snapshot.
  const scope = {
    caseId: dataset.diagnosisCase.caseId,
    storeId: dataset.diagnosisCase.storeId,
    skuId: dataset.diagnosisCase.skuId,
  };
  const observations = dataset.observations.map(item => ({ ...item }));
  return {
    sourceSlug: metric => `json-${metric}`,
    sourceState: () => 'healthy',
    queryMetric(metric: Metric) {
      return observations.filter(item => item.metric === metric &&
        item.caseId === scope.caseId &&
        item.storeId === scope.storeId &&
        item.skuId === scope.skuId).map(item => ({ ...item }));
    },
  };
}
