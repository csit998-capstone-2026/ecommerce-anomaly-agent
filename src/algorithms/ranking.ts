import {
  type Cause,
  type DateWindow,
  type DiagnosisCase,
  type Evidence,
  type Metric,
  type Observation,
  type RankedHypothesis,
} from '../domain/contracts.ts';
import { validateDiagnosisCase, validateObservation } from '../domain/validation.ts';

/** Scores order hypotheses; they are neither probabilities nor proof of causation. */
export interface RankingResult {
  evidence: Evidence[];
  ranking: RankedHypothesis[];
}

/** Optional ablations for a reproducible comparison; all mechanisms are on by default. */
export interface RankingOptions {
  useTemporal?: boolean;
  useQuality?: boolean;
  useCounterEvidence?: boolean;
}

interface Series {
  mean: number | null;
  quality: number;
  observationIds: string[];
  byDate: Map<string, number>;
  rawByDate: Map<string, number[]>;
  idsByDate: Map<string, string[]>;
}

interface PairedRateSeries {
  mean: number | null;
  quality: number;
  observationIds: string[];
  byDate: Map<string, number>;
}

const CAUSES: Cause[] = [
  'stockout',
  'traffic_decline',
  'conversion_decline',
  'price_or_promotion_change',
];

const DAY_MS = 86_400_000;
const clamp = (value: number): number => Math.max(0, Math.min(1, value));
const dayNumber = (day: string): number => Date.parse(`${day}T00:00:00.000Z`);
const windowLength = (window: DateWindow): number =>
  Math.round((dayNumber(window.end) - dayNumber(window.start)) / DAY_MS) + 1;
const inWindow = (day: string, window: DateWindow): boolean =>
  day >= window.start && day <= window.end;

function freshness(observation: Observation): number {
  if (observation.status !== 'ok' || !observation.sourceUpdatedAt) return 0;
  const updatedAt = Date.parse(observation.sourceUpdatedAt);
  const fetchedAt = Date.parse(observation.fetchedAt);
  const observedDay = dayNumber(observation.observedDate);
  if (updatedAt > fetchedAt) return 0.3;
  // Completed historical daily data does not become stale just because it is
  // read later. A source snapshot older than its observed day is unreliable.
  if (updatedAt < observedDay) return 0.25;
  return updatedAt < observedDay + DAY_MS * 0.75 ? 0.7 : 1;
}

function series(observations: Observation[], metric: Metric, window: DateWindow): Series {
  const rows = observations.filter((row) =>
    row.metric === metric && inWindow(row.observedDate, window) && row.status === 'ok' && row.value !== null);
  const rawByDate = new Map<string, number[]>();
  const idsByDate = new Map<string, string[]>();
  for (const row of rows) {
    const values = rawByDate.get(row.observedDate) ?? [];
    values.push(row.value as number);
    rawByDate.set(row.observedDate, values);
    const ids = idsByDate.get(row.observedDate) ?? [];
    ids.push(row.observationId);
    idsByDate.set(row.observedDate, ids);
  }
  const byDate = new Map<string, number>();
  let consistency = 1;
  for (const [day, values] of rawByDate) {
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    byDate.set(day, average);
    if (values.length > 1 && Math.max(...values) - Math.min(...values) > Math.max(1, average * 0.2)) {
      consistency = Math.min(consistency, 0.45);
    }
  }
  const daily = [...byDate.values()];
  const averageFreshness = rows.length
    ? rows.reduce((sum, row) => sum + freshness(row), 0) / rows.length
    : 0;
  const coverage = byDate.size / windowLength(window);
  return {
    mean: daily.length ? daily.reduce((sum, value) => sum + value, 0) / daily.length : null,
    quality: clamp(averageFreshness * (0.5 + coverage * 0.5) * consistency),
    observationIds: rows.map((row) => row.observationId),
    byDate,
    rawByDate,
    idsByDate,
  };
}

/** Only same-day paid orders and positive visitor counts define a conversion rate. */
function pairedConversion(orders: Series, visitors: Series, window: DateWindow): PairedRateSeries {
  const byDate = new Map<string, number>();
  const observationIds: string[] = [];
  let totalOrders = 0;
  let totalVisitors = 0;
  for (const [day, orderCount] of orders.byDate) {
    const visitorCount = visitors.byDate.get(day);
    if (visitorCount === undefined || visitorCount <= 0) continue;
    byDate.set(day, orderCount / visitorCount);
    totalOrders += orderCount;
    totalVisitors += visitorCount;
    observationIds.push(...(orders.idsByDate.get(day) ?? []), ...(visitors.idsByDate.get(day) ?? []));
  }
  const pairedCoverage = byDate.size / windowLength(window);
  return {
    mean: totalVisitors > 0 ? totalOrders / totalVisitors : null,
    quality: clamp(Math.min(orders.quality, visitors.quality) * (0.5 + pairedCoverage * 0.5)),
    observationIds: [...new Set(observationIds)],
    byDate,
  };
}

function decline(baseline: number | null, current: number | null): number | null {
  if (baseline === null || current === null || baseline <= 0) return null;
  return clamp((baseline - current) / baseline);
}

function firstDay(values: Map<string, number>, predicate: (value: number) => boolean): string | undefined {
  return [...values].sort(([a], [b]) => a.localeCompare(b)).find(([, value]) => predicate(value))?.[0];
}

function temporalMatch(eventDay: string | undefined, salesDropDay: string | undefined): number {
  if (!eventDay || !salesDropDay) return 0.6;
  return eventDay <= salesDropDay ? 1 : 0.2;
}

function furtherSalesDrop(eventDay: string, sales: Series): number {
  const days = [...sales.byDate].sort(([a], [b]) => a.localeCompare(b));
  const before = days.filter(([day]) => day < eventDay).at(-1)?.[1];
  const after = days.filter(([day]) => day >= eventDay).map(([, value]) => value);
  if (before === undefined || before <= 0 || !after.length) return 0;
  return clamp((before - Math.min(...after)) / before / 0.5);
}

function mergeIds(...sources: Series[]): string[] {
  return [...new Set(sources.flatMap((source) => source.observationIds))];
}

function distinctMetrics(metrics: Metric[]): Metric[] {
  return [...new Set(metrics)];
}

/**
 * Rank plausible explanations of a sales decline from time-aligned observations.
 * A missing measurement never becomes a measured zero. Every contribution can be
 * traced to observation IDs through the returned Evidence records.
 */
export function rankCauses(
  diagnosisCase: DiagnosisCase, observations: Observation[], options: RankingOptions = {},
): RankingResult {
  validateDiagnosisCase(diagnosisCase);
  const seenIds = new Set<string>();
  for (const observation of observations) {
    validateObservation(diagnosisCase, observation);
    if (seenIds.has(observation.observationId)) throw new Error('Duplicate observationId');
    seenIds.add(observation.observationId);
  }

  const before = (metric: Metric) => series(observations, metric, diagnosisCase.baselineWindow);
  const during = (metric: Metric) => series(observations, metric, diagnosisCase.anomalyWindow);
  const baselineUnits = before('units_sold');
  const anomalyUnits = during('units_sold');
  const baselineOrders = before('paid_orders');
  const anomalyOrders = during('paid_orders');
  const baselineSales = baselineUnits.mean !== null && anomalyUnits.mean !== null ? baselineUnits : baselineOrders;
  const anomalySales = baselineUnits.mean !== null && anomalyUnits.mean !== null ? anomalyUnits : anomalyOrders;
  const baselineVisitors = before('visitors');
  const anomalyVisitors = during('visitors');
  const baselineConversion = pairedConversion(baselineOrders, baselineVisitors, diagnosisCase.baselineWindow);
  const anomalyConversion = pairedConversion(anomalyOrders, anomalyVisitors, diagnosisCase.anomalyWindow);
  const baselineStock = before('stock_on_hand');
  const anomalyStock = during('stock_on_hand');
  const baselinePrice = before('price');
  const anomalyPrice = during('price');
  const baselinePromotion = before('promotion_active');
  const anomalyPromotion = during('promotion_active');

  const salesDrop = decline(baselineSales.mean, anomalySales.mean);
  const salesDropDay = baselineSales.mean === null
    ? undefined
    : firstDay(anomalySales.byDate, (value) => value < (baselineSales.mean as number) * 0.85);
  const evidence: Evidence[] = [];
  const add = (
    cause: Cause,
    polarity: Evidence['polarity'],
    strength: number,
    quality: number,
    when: string | undefined,
    ids: string[],
    explanation: string,
    explicitTemporalMatch?: number,
  ): void => {
    if (polarity === 'contradicts' && options.useCounterEvidence === false) return;
    evidence.push({
      evidenceId: `ev-${cause}-${evidence.length + 1}`,
      caseId: diagnosisCase.caseId,
      cause,
      observationIds: [...new Set(ids)],
      polarity,
      strength: clamp(strength),
      quality: options.useQuality === false ? 1 : clamp(quality),
      temporalMatch: options.useTemporal === false ? 1 :
        polarity === 'supports' ? explicitTemporalMatch ?? temporalMatch(when, salesDropDay) : 1,
      explanation,
    });
  };

  // Stock availability is an immediate constraint on realized sales.
  if (anomalyStock.mean !== null) {
    const zeroDays = [...anomalyStock.rawByDate].filter(([, values]) => values.some((value) => value === 0));
    const positiveDays = [...anomalyStock.rawByDate].filter(([, values]) => values.every((value) => value > 0));
    if (zeroDays.length) {
      const firstZero = zeroDays.map(([day]) => day).sort()[0];
      add('stockout', 'supports', Math.min(1, zeroDays.length / Math.max(1, anomalyStock.byDate.size) * 2),
        anomalyStock.quality, firstZero, anomalyStock.observationIds, '异常期存在库存为零的记录');
      if (options.useTemporal !== false && salesDropDay && firstZero > salesDropDay) {
        add('stockout', 'contradicts', 0.8, anomalyStock.quality, firstZero,
          anomalyStock.observationIds, '缺货记录晚于销量开始下降');
        const additionalDrop = furtherSalesDrop(firstZero, anomalySales);
        if (additionalDrop > 0.2) {
          add('stockout', 'supports', additionalDrop,
            Math.min(anomalyStock.quality, anomalySales.quality), firstZero,
            mergeIds(anomalyStock, anomalySales),
            '缺货发生在初次销量下降之后，但与随后进一步下跌相符，可能是后续加重因素', 1);
        }
      }
      if ([...anomalyStock.rawByDate.values()].some((values) => values.includes(0) && values.some((value) => value > 0))) {
        add('stockout', 'contradicts', 0.9, anomalyStock.quality, firstZero,
          anomalyStock.observationIds, '同日库存来源相互冲突');
      }
    } else if (positiveDays.length) {
      add('stockout', 'contradicts', 0.8, anomalyStock.quality, undefined,
        anomalyStock.observationIds, '已查询的异常期库存均大于零');
    }
    if (baselineStock.mean !== null && baselineStock.mean === 0) {
      add('stockout', 'contradicts', 0.45, Math.min(baselineStock.quality, anomalyStock.quality),
        undefined, mergeIds(baselineStock, anomalyStock), '基线期也处于缺货状态，单独解释新增销量下降的力度较弱');
    }
  }

  // Compare visitor volumes; a stable or rising visitor count is counterevidence.
  const trafficDrop = decline(baselineVisitors.mean, anomalyVisitors.mean);
  if (trafficDrop !== null) {
    const trafficQuality = Math.min(baselineVisitors.quality, anomalyVisitors.quality);
    const trafficIds = mergeIds(baselineVisitors, anomalyVisitors);
    if (trafficDrop >= 0.1) {
      const firstTrafficDrop = firstDay(anomalyVisitors.byDate,
        (value) => value < (baselineVisitors.mean as number) * 0.9);
      add('traffic_decline', 'supports', Math.min(1, trafficDrop / 0.4), trafficQuality,
        firstTrafficDrop, trafficIds, '异常期访客数较基线期下降');
      if (options.useTemporal !== false && salesDropDay && firstTrafficDrop && firstTrafficDrop > salesDropDay) {
        add('traffic_decline', 'contradicts', 0.7, trafficQuality, firstTrafficDrop,
          trafficIds, '流量下降晚于销量开始下降');
      }
    } else {
      add('traffic_decline', 'contradicts', 0.8, trafficQuality, undefined,
        trafficIds, '访客数未明显下降');
    }
  }

  // Conversion uses matched dates only; missing days are not aligned by taking
  // independent orders and visitors means from different sets of dates.
  if (baselineConversion.mean !== null && anomalyConversion.mean !== null) {
    const conversionDrop = decline(baselineConversion.mean, anomalyConversion.mean);
    if (conversionDrop !== null) {
      const quality = Math.min(baselineConversion.quality, anomalyConversion.quality);
      const ids = [...new Set([...baselineConversion.observationIds, ...anomalyConversion.observationIds])];
      if (conversionDrop >= 0.1) {
        const firstRateDrop = firstDay(anomalyConversion.byDate,
          (value) => value < (baselineConversion.mean as number) * 0.9);
        add('conversion_decline', 'supports', Math.min(1, conversionDrop / 0.4), quality,
          firstRateDrop, ids, '支付订单数与访客数之比下降');
        if (options.useTemporal !== false && salesDropDay && firstRateDrop && firstRateDrop > salesDropDay) {
          add('conversion_decline', 'contradicts', 0.7, quality, firstRateDrop,
            ids, '转化率下降晚于销量开始下降');
        }
      } else {
        add('conversion_decline', 'contradicts', 0.8, quality, undefined,
          ids, '支付转化率未明显下降');
      }
    }
  }

  // Price rise and promotion ending are separate observations for one candidate.
  let priceOrPromoAvailable = false;
  let priceChanged = false;
  let promoChanged = false;
  if (baselinePrice.mean !== null && anomalyPrice.mean !== null && baselinePrice.mean > 0) {
    priceOrPromoAvailable = true;
    const rise = (anomalyPrice.mean - baselinePrice.mean) / baselinePrice.mean;
    const quality = Math.min(baselinePrice.quality, anomalyPrice.quality);
    const ids = mergeIds(baselinePrice, anomalyPrice);
    if (rise >= 0.03) {
      priceChanged = true;
      const day = firstDay(anomalyPrice.byDate, (value) => value >= (baselinePrice.mean as number) * 1.03);
      add('price_or_promotion_change', 'supports', Math.min(1, rise / 0.2), quality,
        day, ids, '异常期商品价格上涨');
      if (options.useTemporal !== false && salesDropDay && day && day > salesDropDay) {
        add('price_or_promotion_change', 'contradicts', 0.7, quality, day, ids,
          '涨价晚于销量开始下降');
      }
    }
  }
  if (baselinePromotion.mean !== null && anomalyPromotion.mean !== null) {
    priceOrPromoAvailable = true;
    const quality = Math.min(baselinePromotion.quality, anomalyPromotion.quality);
    const ids = mergeIds(baselinePromotion, anomalyPromotion);
    if (baselinePromotion.mean >= 0.5 && anomalyPromotion.mean < 0.5) {
      promoChanged = true;
      const day = firstDay(anomalyPromotion.byDate, (value) => value === 0);
      add('price_or_promotion_change', 'supports', 0.8, quality, day, ids,
        '基线期促销活跃，异常期促销结束');
      if (options.useTemporal !== false && salesDropDay && day && day > salesDropDay) {
        add('price_or_promotion_change', 'contradicts', 0.7, quality, day, ids,
          '促销结束晚于销量开始下降');
      }
    }
  }
  if (priceOrPromoAvailable && !priceChanged && !promoChanged) {
    add('price_or_promotion_change', 'contradicts', 0.7,
      Math.max(Math.min(baselinePrice.quality, anomalyPrice.quality),
        Math.min(baselinePromotion.quality, anomalyPromotion.quality)),
      undefined, mergeIds(baselinePrice, anomalyPrice, baselinePromotion, anomalyPromotion),
      '未观察到涨价或促销结束');
  }

  // Falling orders/visitor can be a downstream symptom of stockout or a
  // changed offer. Count that as counterevidence to an *independent*
  // conversion explanation, while preserving the observed rate decline.
  if (evidence.some((item) => item.cause === 'conversion_decline' && item.polarity === 'supports')) {
    const zeroDays = [...anomalyStock.rawByDate].filter(([, values]) => values.some((value) => value === 0));
    const ordersOnZeroDays = zeroDays.filter(([day]) => (anomalyOrders.byDate.get(day) ?? Infinity) <= 1);
    if (zeroDays.length && ordersOnZeroDays.length / zeroDays.length >= 0.5) {
      add('conversion_decline', 'contradicts', 0.8,
        Math.min(anomalyStock.quality, anomalyOrders.quality), undefined,
        mergeIds(anomalyStock, anomalyOrders),
        '转化率下降与缺货时段重合，可能是缺货的结果，不能单独归因');
    }
    if (priceChanged || promoChanged) {
      add('conversion_decline', 'contradicts', 0.7,
        Math.max(Math.min(baselinePrice.quality, anomalyPrice.quality),
          Math.min(baselinePromotion.quality, anomalyPromotion.quality)), undefined,
        mergeIds(baselinePrice, anomalyPrice, baselinePromotion, anomalyPromotion),
        '转化率下降可能受涨价或促销结束影响，不能单独归因');
    }
  }

  const missingSales: Metric[] = baselineSales.mean === null || anomalySales.mean === null
    ? ['units_sold', 'paid_orders'] : [];
  const missingFor: Record<Cause, Metric[]> = {
    stockout: anomalyStock.mean === null ? ['stock_on_hand'] : [],
    traffic_decline: baselineVisitors.mean === null || anomalyVisitors.mean === null ? ['visitors'] : [],
    conversion_decline: [
      ...(baselineVisitors.mean === null || anomalyVisitors.mean === null ? ['visitors' as const] : []),
      ...(baselineOrders.mean === null || anomalyOrders.mean === null ? ['paid_orders' as const] : []),
      ...(baselineConversion.mean === null || anomalyConversion.mean === null
        ? ['paid_orders' as const, 'visitors' as const] : []),
    ],
    price_or_promotion_change: !priceOrPromoAvailable ? ['price', 'promotion_active'] : [],
  };
  const ranking: RankedHypothesis[] = CAUSES.map((cause) => {
    const relevant = evidence.filter((item) => item.cause === cause);
    const signedScore = relevant.reduce((sum, item) => sum +
      (item.polarity === 'supports' ? 1 : -1) * item.strength * item.quality * item.temporalMatch, 0);
    return {
      caseId: diagnosisCase.caseId,
      cause,
      score: Number(signedScore.toFixed(4)),
      supportEvidenceIds: relevant.filter((item) => item.polarity === 'supports').map((item) => item.evidenceId),
      contradictionEvidenceIds: relevant.filter((item) => item.polarity === 'contradicts').map((item) => item.evidenceId),
      missingMetrics: distinctMetrics([...missingSales, ...missingFor[cause]]),
    };
  }).sort((a, b) => b.score - a.score || CAUSES.indexOf(a.cause) - CAUSES.indexOf(b.cause));

  // A sales decline is a precondition for interpretation, not another cause.
  if (salesDrop === null || salesDrop <= 0) {
    for (const item of ranking) item.score = Math.min(0, item.score);
    ranking.sort((a, b) => b.score - a.score || CAUSES.indexOf(a.cause) - CAUSES.indexOf(b.cause));
  }
  return { evidence, ranking };
}
