import {
  METRIC_UNITS,
  SCHEMA_VERSION,
  type DateWindow,
  type DiagnosisCase,
  type Observation,
} from './contracts.ts';

function dateNumber(day: string): number {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error(`Invalid ISO date: ${day}`);
  }
  const timestamp = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== day) {
    throw new Error(`Invalid ISO date: ${day}`);
  }
  return timestamp;
}

function timestampNumber(label: string, value: string): number {
  if (typeof value !== 'string') throw new Error(`Invalid ${label}`);
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid ${label}: expected ISO timestamp with timezone`);
  dateNumber(match[1]!);
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4]);
  const zone = match[5]!;
  if (hour > 23 || minute > 59 || second > 59 ||
      (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))) {
    throw new Error(`Invalid ${label}: timestamp component out of range`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid ${label}`);
  return timestamp;
}

function validateWindow(window: DateWindow): void {
  if (!window || typeof window !== 'object') throw new Error('Date window must be an object');
  if (dateNumber(window.start) > dateNumber(window.end)) {
    throw new Error('Window start must not be after end');
  }
}

function inWindow(day: string, window: DateWindow): boolean {
  const value = dateNumber(day);
  return value >= dateNumber(window.start) && value <= dateNumber(window.end);
}

function nonEmpty(label: string, value: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
}

export function validateDiagnosisCase(diagnosisCase: DiagnosisCase): void {
  if (!diagnosisCase || typeof diagnosisCase !== 'object') {
    throw new Error('Diagnosis case must be an object');
  }
  if (diagnosisCase.schemaVersion !== SCHEMA_VERSION) throw new Error('Unsupported schema version');
  nonEmpty('caseId', diagnosisCase.caseId);
  nonEmpty('storeId', diagnosisCase.storeId);
  nonEmpty('skuId', diagnosisCase.skuId);
  validateWindow(diagnosisCase.baselineWindow);
  validateWindow(diagnosisCase.anomalyWindow);
  if (dateNumber(diagnosisCase.baselineWindow.end) >= dateNumber(diagnosisCase.anomalyWindow.start)) {
    throw new Error('Baseline and anomaly windows must not overlap');
  }
}

export function validateObservation(diagnosisCase: DiagnosisCase, observation: Observation): void {
  validateDiagnosisCase(diagnosisCase);
  if (!observation || typeof observation !== 'object') {
    throw new Error('Observation must be an object');
  }
  if (observation.schemaVersion !== SCHEMA_VERSION) throw new Error('Unsupported schema version');
  nonEmpty('observationId', observation.observationId);
  nonEmpty('source', observation.source);
  if (observation.caseId !== diagnosisCase.caseId ||
      observation.storeId !== diagnosisCase.storeId ||
      observation.skuId !== diagnosisCase.skuId) {
    throw new Error('Observation case, store, or SKU does not match the diagnosis');
  }
  if (!inWindow(observation.observedDate, diagnosisCase.baselineWindow) &&
      !inWindow(observation.observedDate, diagnosisCase.anomalyWindow)) {
    throw new Error('Observation date is outside both diagnosis windows');
  }
  if (!Object.hasOwn(METRIC_UNITS, observation.metric)) throw new Error('Unsupported metric');
  if (observation.unit !== METRIC_UNITS[observation.metric]) throw new Error('Metric unit mismatch');
  const fetchedAt = timestampNumber('fetchedAt', observation.fetchedAt);
  const sourceUpdatedAt = observation.sourceUpdatedAt === null
    ? null : timestampNumber('sourceUpdatedAt', observation.sourceUpdatedAt);
  if (sourceUpdatedAt !== null && sourceUpdatedAt > fetchedAt) {
    throw new Error('sourceUpdatedAt cannot be after fetchedAt');
  }

  if (observation.status === 'ok') {
    if (observation.value === null || !Number.isFinite(observation.value) || observation.value < 0) {
      throw new Error('A successful observation must have a nonnegative finite value');
    }
    if (observation.metric === 'promotion_active' && ![0, 1].includes(observation.value)) {
      throw new Error('promotion_active must be 0 or 1');
    }
    if (['units_sold', 'paid_orders', 'visitors', 'stock_on_hand'].includes(observation.metric) &&
        !Number.isInteger(observation.value)) {
      throw new Error(`${observation.metric} must be a whole-number count`);
    }
    if (sourceUpdatedAt === null) {
      throw new Error('A successful observation needs sourceUpdatedAt');
    }
  } else if (observation.status === 'missing' || observation.status === 'error') {
    if (observation.value !== null) throw new Error('Missing or failed observations must have null value');
    if (observation.status === 'error') nonEmpty('error', observation.error ?? '');
  } else {
    throw new Error('Unsupported query status');
  }
}
