import { createHash } from 'node:crypto';
import {
  METRIC_UNITS,
  SCHEMA_VERSION,
  type Cause,
  type DiagnosisCase,
  type Metric,
  type Observation,
} from '../domain/contracts.ts';

export type Scenario = Cause | 'mixed' | 'insufficient';
export type Split = 'development' | 'holdout';

/** Gold labels and hidden observations are evaluation-only and never enter the Agent prompt/state. */
export interface FixtureCase {
  diagnosisCase: DiagnosisCase;
  observations: Observation[];
  goldCauses: Cause[];
  scenario: Scenario;
  split: Split;
  variant: number;
}

const METRICS: Metric[] = [
  'units_sold', 'paid_orders', 'visitors', 'stock_on_hand', 'price', 'promotion_active',
];
const SCENARIOS: Scenario[] = [
  'stockout', 'traffic_decline', 'conversion_decline', 'price_or_promotion_change',
  'mixed', 'insufficient',
];

function day(offset: number): string {
  const date = new Date(Date.UTC(2026, 8, 1 + offset));
  return date.toISOString().slice(0, 10);
}

function seededVariation(variant: number, dayIndex: number, salt: number): number {
  const n = Math.sin((variant + 1) * 17.17 + dayIndex * 29.31 + salt * 13.13) * 10000;
  return (n - Math.floor(n)) * 2 - 1;
}

function bounded(value: number): number {
  return Math.max(0, Math.round(value));
}

export function makeFixture(scenario: Scenario, variant: number): FixtureCase {
  if (!SCENARIOS.includes(scenario)) throw new Error(`Unknown scenario: ${scenario}`);
  if (!Number.isInteger(variant) || variant < 0) throw new Error('Variant must be a nonnegative integer');
  // Runtime IDs must not reveal the evaluation-only scenario label to an Agent.
  const opaqueId = createHash('sha256').update(`fixture-v1:${scenario}:${variant}`).digest('hex').slice(0, 16);
  const caseId = `synthetic-case-${opaqueId}`;
  const diagnosisCase: DiagnosisCase = {
    schemaVersion: SCHEMA_VERSION,
    caseId,
    storeId: 'synthetic-store-01',
    skuId: `synthetic-sku-${String(variant).padStart(2, '0')}`,
    baselineWindow: { start: day(0), end: day(6) },
    anomalyWindow: { start: day(7), end: day(13) },
  };
  const goldCauses: Cause[] = scenario === 'mixed'
    ? ['stockout', 'traffic_decline']
    : scenario === 'insufficient' ? [] : [scenario];
  const observations: Observation[] = [];
  const baseSales = 22 + variant % 5;
  const baseVisitors = 210 + (variant % 4) * 15;
  const basePrice = 90 + (variant % 6) * 8;

  for (let i = 0; i < 14; i++) {
    const anomaly = i >= 7;
    const stockoutDay = anomaly && (scenario === 'stockout' || scenario === 'mixed') && i >= 8 && i <= 12;
    const trafficMultiplier = anomaly && (scenario === 'traffic_decline' || scenario === 'mixed') ? 0.48 : 1;
    const conversionMultiplier = anomaly && scenario === 'conversion_decline' ? 0.44 : 1;
    const promotion = anomaly && scenario === 'price_or_promotion_change' ? 0 : 1;
    const price = anomaly && scenario === 'price_or_promotion_change' ? basePrice * 1.25 : basePrice;
    const priceMultiplier = anomaly && scenario === 'price_or_promotion_change' ? 0.49 : 1;
    const unexplainedMultiplier = anomaly && scenario === 'insufficient' ? 0.43 : 1;
    const visitors = bounded(baseVisitors * trafficMultiplier * (1 + seededVariation(variant, i, 1) * 0.04));
    const sales = stockoutDay ? 0 : bounded(baseSales * trafficMultiplier * conversionMultiplier
      * priceMultiplier * unexplainedMultiplier * (1 + seededVariation(variant, i, 2) * 0.07));
    const values: Record<Metric, number> = {
      units_sold: sales,
      paid_orders: Math.max(0, sales - 2),
      visitors,
      stock_on_hand: stockoutDay ? 0 : 60 + i % 7,
      price,
      promotion_active: promotion,
    };
    for (const metric of METRICS) {
      const missing = scenario === 'insufficient' && anomaly &&
        ['visitors', 'stock_on_hand', 'price', 'promotion_active'].includes(metric);
      observations.push({
        schemaVersion: SCHEMA_VERSION,
        observationId: `${caseId}:${metric}:${day(i)}`,
        caseId,
        storeId: diagnosisCase.storeId,
        skuId: diagnosisCase.skuId,
        observedDate: day(i),
        metric,
        value: missing ? null : values[metric],
        unit: METRIC_UNITS[metric],
        source: `synthetic-${metric}`,
        sourceUpdatedAt: missing ? null : `${day(i)}T23:30:00.000Z`,
        fetchedAt: `${day(i + 1)}T09:00:00.000Z`,
        status: missing ? 'missing' : 'ok',
      });
    }
  }
  return {
    diagnosisCase, observations, goldCauses, scenario,
    split: variant < 2 ? 'development' : 'holdout', variant,
  };
}

/** 48 labelled cases: 12 development and 36 fixed evaluation variants. */
export function makeCorpus(): FixtureCase[] {
  return SCENARIOS.flatMap(scenario => Array.from({ length: 8 }, (_, variant) => makeFixture(scenario, variant)));
}

export function getFixture(caseId: string): FixtureCase | undefined {
  return makeCorpus().find(item => item.diagnosisCase.caseId === caseId);
}

/** Read-only, case-scoped mock tool; gold labels are deliberately absent from the return value. */
export function queryFixtureMetric(fixture: FixtureCase, metric: Metric): Observation[] {
  return fixture.observations.filter(item => item.metric === metric).map(item => ({ ...item }));
}
