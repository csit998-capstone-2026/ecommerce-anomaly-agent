import type { DiagnosisReport } from '../agent/diagnose.ts';
import type { Cause, Evidence, Metric } from '../domain/contracts.ts';

export interface LocalReportAnswer {
  mode: 'local-report';
  answer: string;
  referenceIds: string[];
  suggestions: string[];
}

type Topic = 'cause' | 'evidence' | 'advice' | 'gaps' | 'overview';

const CAUSE_LABELS: Record<Cause, string> = {
  stockout: '缺货',
  traffic_decline: '访客流量下降',
  conversion_decline: '支付转化下降',
  price_or_promotion_change: '价格或促销变化',
};

const METRIC_LABELS: Record<Metric, string> = {
  units_sold: '商品销量',
  paid_orders: '支付订单',
  visitors: '访客流量',
  stock_on_hand: '可售库存',
  price: '商品价格',
  promotion_active: '促销状态',
};

const REVIEW_STEPS: Record<Cause, string> = {
  stockout: '核对缺货日期、可售库存和补货到货记录',
  traffic_decline: '核对渠道访客变化、投放记录和商品曝光',
  conversion_decline: '核对商品详情页、支付链路和同口径转化率',
  price_or_promotion_change: '核对调价、促销结束时间和活动记录',
};

// Only ranker-owned sentences can be turned into user-visible summaries.
// Unknown or externally supplied explanation text is never echoed.
const EVIDENCE_SUMMARIES: Record<string, string> = {
  '异常期存在库存为零的记录': '异常期出现缺货记录',
  '缺货记录晚于销量开始下降': '缺货记录晚于销量下降',
  '缺货发生在初次销量下降之后，但与随后进一步下跌相符，可能是后续加重因素': '缺货可能是后续销量下跌的加重因素',
  '同日库存来源相互冲突': '同日库存记录存在冲突',
  '已查询的异常期库存均大于零': '已查库存记录不支持缺货解释',
  '基线期也处于缺货状态，单独解释新增销量下降的力度较弱': '基线期也有缺货，难以单独解释新增下降',
  '异常期访客数较基线期下降': '异常期访客流量较基线期下降',
  '流量下降晚于销量开始下降': '流量下降晚于销量下降',
  '访客数未明显下降': '访客流量未明显下降',
  '支付订单数与访客数之比下降': '同口径支付转化表现下降',
  '转化率下降晚于销量开始下降': '转化下降晚于销量下降',
  '支付转化率未明显下降': '支付转化表现未明显下降',
  '异常期商品价格上涨': '异常期存在商品涨价记录',
  '涨价晚于销量开始下降': '涨价晚于销量下降',
  '基线期促销活跃，异常期促销结束': '异常期促销状态较基线期发生变化',
  '促销结束晚于销量开始下降': '促销结束晚于销量下降',
  '未观察到涨价或促销结束': '未观察到涨价或促销结束',
  '转化率下降与缺货时段重合，可能是缺货的结果，不能单独归因': '转化下降可能受到缺货影响',
  '转化率下降可能受涨价或促销结束影响，不能单独归因': '转化下降可能受到价格或促销变化影响',
};

const SUGGESTIONS: Record<Topic, string[]> = {
  cause: ['有哪些证据支持？', '还缺哪些数据？', '可以先做什么？'],
  evidence: ['最值得排查的原因是什么？', '有没有反对证据？', '还缺哪些数据？'],
  advice: ['最值得排查的原因是什么？', '有哪些证据支持？', '还缺哪些数据？'],
  gaps: ['有哪些证据支持？', '最值得排查的原因是什么？', '可以先做什么？'],
  overview: ['最值得排查的原因是什么？', '有哪些证据支持？', '还缺哪些数据？'],
};

function topicOf(message: string): Topic {
  // Only classify the question. Its text never enters an answer or a tool call.
  const question = message.normalize('NFKC').toLowerCase();
  if (/缺口|缺失|缺少|补查|补充|还需|还要|什么数据|哪些数据|数据不足|missing|gap/.test(question)) return 'gaps';
  if (/建议|怎么办|怎么做|如何处理|如何改善|行动|措施|策略|advice|recommend/.test(question)) return 'advice';
  if (/证据|依据|凭什么|怎么判断|反对|支持|evidence|basis|proof/.test(question)) return 'evidence';
  if (/原因|为什么|为何|导致|归因|根因|cause|reason|why/.test(question)) return 'cause';
  return 'overview';
}

function readableMetric(metric: Metric | undefined): string | undefined {
  return metric && Object.hasOwn(METRIC_LABELS, metric) ? METRIC_LABELS[metric] : undefined;
}

function readableCause(cause: Cause | undefined): string | undefined {
  return cause && Object.hasOwn(CAUSE_LABELS, cause) ? CAUSE_LABELS[cause] : undefined;
}

function missingMetricLabels(report: DiagnosisReport): string[] {
  const metrics = [report.verification.nextQuery?.metric, ...(report.ranking[0]?.missingMetrics ?? [])];
  return [...new Set(metrics.map(readableMetric).filter((item): item is string => !!item))];
}

function linkedEvidence(report: DiagnosisReport): Evidence[] {
  const leading = report.ranking[0];
  if (!leading) return [];
  const byId = new Map(report.evidence.map(item => [item.evidenceId, item]));
  const links: Array<[string, Evidence['polarity']]> = [
    ...leading.supportEvidenceIds.map(id => [id, 'supports'] as const),
    ...leading.contradictionEvidenceIds.map(id => [id, 'contradicts'] as const),
  ];
  return links.flatMap(([id, polarity]) => {
    const item = byId.get(id);
    return item && item.caseId === report.diagnosisCase.caseId && item.cause === leading.cause &&
      item.polarity === polarity ? [item] : [];
  });
}

function references(evidence: Evidence[]): string[] {
  // The ranker generates these identifiers. Observation IDs are caller-defined
  // and may themselves contain private business data, so never echo them here.
  return [...new Set(evidence.map(item => item.evidenceId).filter(id =>
    /^ev-(?:stockout|traffic_decline|conversion_decline|price_or_promotion_change)-[1-9]\d{0,3}$/.test(id)))].slice(0, 8);
}

function evidenceSummary(item: Evidence): string {
  return Object.hasOwn(EVIDENCE_SUMMARIES, item.explanation)
    ? EVIDENCE_SUMMARIES[item.explanation]!
    : item.polarity === 'supports' ? '有支持该候选的观测记录' : '有约束该候选的观测记录';
}

function gapFromVerdict(report: DiagnosisReport): string | undefined {
  const reason = report.verification.reason;
  // The Agent may append an adapter error to a failed-query reason. Handle that
  // envelope first, then classify only known verifier messages, never raw text.
  if (/^补查 (?:units_sold|paid_orders|visitors|stock_on_hand|price|promotion_active) (?:失败|未执行)：/.test(reason) ||
      /^达到最多 \d+ 次补查或无可继续查询的指标/.test(reason)) {
    return '补查未完成或已达到查询上限，请核对数据源后重新诊断。';
  }
  if (reason === '关键指标冲突或竞争原因证据质量不足，且没有可继续执行的补查查询') {
    return '报告提示关键指标可能冲突，或竞争原因的证据质量不足；请核对同日记录和数据口径。';
  }
  if (reason === '同一日期的指标来源相互冲突，需优先核对该指标' ||
      reason === '当前结论存在反对或冲突证据，需要补查') {
    return '报告提示关键指标可能存在冲突，请核对同日记录及数据口径。';
  }
  if (reason === '低质量的竞争原因证据可能改变排序，需补查') {
    return '报告提示竞争原因的证据质量不足，请核对相关指标。';
  }
  if (reason === '必要指标缺失或日期覆盖不足，且没有可继续执行的补查查询') {
    return '报告提示日期覆盖不足或必要指标缺失，请补齐基线期和异常期的逐日记录。';
  }
  if (reason.startsWith('商品销量降幅未达到异常判断阈值（')) {
    return '报告判断销量降幅未达到异常判断阈值，请先复核异常判定口径。';
  }
  if (report.verification.status === 'contradicted') return '首位候选受到较强反对证据约束，请核对相应记录。';
  return undefined;
}

/** Answer a bounded set of report questions without model, network, env, or raw-data access. */
export function answerFromReport(report: DiagnosisReport, message: string): LocalReportAnswer {
  const topic = topicOf(message);
  const supported = report.verification.status === 'supported';
  const leading = report.ranking[0];
  const cause = readableCause(leading?.cause);
  const evidence = linkedEvidence(report);
  const supports = evidence.filter(item => item.polarity === 'supports');
  const contradictions = evidence.filter(item => item.polarity === 'contradicts');
  const gaps = missingMetricLabels(report);
  const verdictGap = gapFromVerdict(report);
  const gapText = [
    gaps.length ? `报告标记待补查或缺失的指标：${gaps.join('、')}。` : undefined,
    verdictGap,
  ].filter(Boolean).join(' ') || (supported ? '报告未标记明确缺失指标。' :
    '报告未标记明确缺失指标；可复核数据口径、日期覆盖和反对证据。');
  let answer: string;

  switch (topic) {
    case 'cause':
      answer = supported && cause
        ? `报告将“${cause}”列为优先排查的可能原因。排序分数不是因果概率，仍需业务复核。`
        : '当前结论未通过核验，不能确定销量下降的具体原因，也不能将排序首位视为已确认原因。';
      break;
    case 'evidence':
      if (!evidence.length) {
        answer = '报告暂没有可引用的候选证据，无法据此确认原因。';
      } else {
        const supportText = supports.length
          ? `支持记录：${supports.slice(0, 2).map(evidenceSummary).join('；')}。` : '';
        const contradictionText = contradictions.length
          ? `反对或约束记录：${contradictions.slice(0, 1).map(evidenceSummary).join('；')}。` : '';
        answer = `${supportText}${contradictionText}${supported ?
          '这些证据只支持优先排查，不能单独证明因果关系。' :
          '当前核验未通过，这些记录不足以确认原因。'}下方列出相关证据编号。`;
      }
      break;
    case 'advice':
      answer = supported && leading && cause
        ? `建议先${REVIEW_STEPS[leading.cause]}。这属于核查步骤；原因仍需业务复核，不应仅凭排序分数直接调整经营策略。`
        : `当前证据不足以支持经营调整建议。请先补齐或核对诊断数据。${gaps.length ? `优先核对：${gaps.join('、')}。` : (verdictGap ?? '')}`;
      break;
    case 'gaps':
      answer = `${gapText}${supported ? '当前结论仅用于优先排查，补充数据仍有助于业务复核。' : '补查完成前不要将候选原因当作确定结论。'}`;
      break;
    default:
      answer = supported && cause
        ? `报告已通过现有证据核验，建议优先排查“${cause}”。排序分数不是因果概率；可继续查看证据、数据缺口和核查步骤。`
        : `报告尚未形成通过核验的原因结论。${gapText}可继续查看证据和补查方向。`;
  }

  return {
    mode: 'local-report',
    answer,
    referenceIds: topic === 'gaps' ? [] : references(evidence),
    suggestions: [...SUGGESTIONS[topic]],
  };
}
