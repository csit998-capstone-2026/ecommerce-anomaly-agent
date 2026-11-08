import { buildDatasetFromDailyCsv } from './daily-csv.js';

const $ = (selector) => document.querySelector(selector);
const causeNames = {
  stockout: '缺货', traffic_decline: '访客流量下降',
  conversion_decline: '转化下降', price_or_promotion_change: '价格或促销变化',
  unknown: '未知原因',
};
const verificationNames = {
  supported: '证据支持', needs_data: '待补查', contradicted: '证据冲突', insufficient: '证据不足',
};
const resultNames = { correct: '正确', incorrect: '错误', abstained: '证据不足' };
const scenarioNames = { ...causeNames, mixed: '混合原因', insufficient: '证据不足' };
const moduleOwners = {
  module1: 'Yan Zhuo', module2: 'Yan Han', module3: 'Zheng Sitian',
  module4: 'Li Yiheng', module5: 'Li Zhen',
};
const traceNames = {
  schedule: '任务调度', tool_decision: '工具调用决策', tool_result: '数据工具返回',
  rank: '候选原因排序', verify: '结论核验', stop: '停止诊断', repair: '局部修复',
};
const traceReasonNames = {
  'Source, scope, prerequisite, and risk checks passed': '数据源、查询范围、前置条件和风险检查均已通过',
  'Write operation is blocked in safe mode': '安全模式下禁止写操作',
  'Data source is not active': '数据源未启用',
  'Data source is stale': '数据源已过期',
  'Data source is unavailable': '数据源不可用',
  'Metric is outside this diagnosis scope': '指标不在本次诊断范围内',
  'Tool does not provide the required metric': '工具不提供所需指标',
  'Tool prerequisite has not been satisfied': '工具调用前置条件未满足',
  'Business risk or permission mode requires approval': '业务风险或权限设置要求审批',
};
const businessMetricNames = {
  units_sold: '销量', paid_orders: '支付订单', visitors: '访客',
  stock_on_hand: '可售库存', price: '价格', promotion_active: '促销状态',
};
const metricNames = {
  redundant_nodes: '无效重跑节点数', redundantReruns: '无效重跑节点数',
  evidence_retention: '关键证据保留率', evidenceRetention: '关键证据保留率',
  unsafe_calls: '违规工具调用数', unauthorizedCallRate: '违规工具调用率',
  top1_accuracy: 'Top-1 排序准确率', top1Accuracy: 'Top-1 排序准确率',
  supported_conclusion_rate: '有证据支撑结论率', supportedConclusionRate: '有证据支撑结论率',
};
const escapeHtml = (value) => String(value ?? '—').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const textOrDash = (value) => value === null || value === undefined || value === '' ? '—' : String(value);
const causeName = (cause) => causeNames[cause] || textOrDash(cause);
const compactDate = (date) => /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date.slice(5).replace('-', '/') : textOrDash(date);
const windowLabel = (window) => window?.start && window?.end ? `${compactDate(window.start)} — ${compactDate(window.end)}` : '—';
const hasFiniteValue = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const number = (value, digits = 0) => hasFiniteValue(value) ? Number(value).toLocaleString('zh-CN', { maximumFractionDigits: digits }) : '—';
const currentView = {
  dashboard: null, evaluations: null, evaluationFallback: false, importedFile: null,
  dataset: null, datasetBody: null, datasetName: null, datasetKind: null, datasetVersion: 0,
  validation: null, activeRunId: null, activeRunFromHistory: false,
  completedRunId: null, assistantBusy: false, pollTimer: null, apiAvailable: false,
};

function isDashboardPayload(value) {
  return value && typeof value === 'object' && value.run && typeof value.run === 'object' &&
    ['series', 'causes', 'evidence', 'sources', 'trace'].every((key) => Array.isArray(value[key]));
}
function isEvaluationPayload(value) {
  return value && typeof value === 'object' && Array.isArray(value.modules) && Array.isArray(value.cases);
}

function checkedPayload(result, validator, label) {
  if (result.status === 'rejected') return result;
  return validator(result.value) ? result : { status: 'rejected', reason: new Error(`${label}返回格式不完整`) };
}

async function fetchJson(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, cache: 'no-store' });
    let data;
    try { data = await response.json(); }
    catch { throw new Error(`服务响应不是有效 JSON（HTTP ${response.status}）。`); }
    if (!response.ok) throw new Error(data?.error || `请求失败（HTTP ${response.status}）。`);
    return data;
  } finally { clearTimeout(timer); }
}

async function loadData() {
  const [healthResult, rawEvaluation, runsResult, assistantStatus] = await Promise.allSettled([
    fetchJson('/api/health'), fetchJson('/api/evaluations/latest'),
    fetchJson('/api/runs'), fetchJson('/api/assistant/status'),
  ]);
  currentView.apiAvailable = healthResult.status === 'fulfilled';
  setApiStatus();
  renderAssistantStatus(assistantStatus.status === 'fulfilled' ? assistantStatus.value : null);
  const evaluationResult = checkedPayload(rawEvaluation, isEvaluationPayload, '评测接口');
  let evaluations;
  let fallback = false;
  if (evaluationResult.status === 'rejected') {
    fallback = true;
    try {
      const demo = await fetchJson('./data/demo.json');
      if (!isEvaluationPayload(demo?.evaluations)) throw new Error('演示文件格式不完整');
      evaluations = demo.evaluations;
    } catch {
      evaluations = { provenance: 'unavailable', synthetic: null, modules: [], cases: [] };
    }
  } else {
    evaluations = evaluationResult.value;
  }
  currentView.evaluations = evaluations;
  currentView.evaluationFallback = fallback;
  renderEvaluations(evaluations, fallback);
  renderExperimentProvenance(evaluations, fallback);
  if (runsResult.status === 'fulfilled' && Array.isArray(runsResult.value?.runs)) {
    renderRunHistory(runsResult.value);
    const latestCompleted = runsResult.value.runs.find((run) => run.status === 'completed');
    if (latestCompleted && !currentView.activeRunId && !currentView.dataset) {
      currentView.activeRunId = latestCompleted.runId;
      currentView.activeRunFromHistory = true;
      void pollRun(latestCompleted.runId);
    }
  } else renderRunHistory(null);
}

function provenanceLabel(data, fallback, isEvaluation) {
  if (isEvaluation) {
    if (data?.provenance === 'unavailable') return '实验数据不可用';
    if (fallback || /ui-demo|demo-values/i.test(data?.provenance || '')) return '界面演示数据 · 非实验结果';
    if (data?.provenance === 'not-run') return '尚未运行模块评测';
    if (data?.synthetic && data?.generatedAt) return '合成测试集 · 程序评测结果';
    return '实验来源未核验';
  }
  const declared = data?.sourceDeclaration?.synthetic;
  if (declared === true) return '合成数据（上传者声明）';
  if (declared === false) return '非合成（上传者声明，未核验）';
  return '数据类型未声明 · 来源未核验';
}

const defaultAssistantQuestions = [
  '如何上传经营数据？', '为什么销量下降？', '主要证据有哪些？', '还需要补查哪些数据？',
];

function renderAssistantStatus(status) {
  const connected = status?.mode === 'local-report' && status.modelConfigured === false;
  const badge = $('#assistant-mode');
  badge.className = `assistant-mode-badge ${connected ? '' : 'error'}`;
  badge.textContent = connected ? '本地报告问答 · 大模型待接入'
    : '问答服务未连接或状态待核验 · 大模型待接入';
  if (!connected) $('#assistant-feedback').textContent = '问答服务暂不可用。可先在“数据与诊断”导入并运行任务。';
}

function renderAssistantSuggestions(questions) {
  const selected = Array.isArray(questions) ? questions.filter((item) =>
    typeof item === 'string' && item.trim() && item.length <= 120).slice(0, 4) : [];
  const container = $('#assistant-suggestions');
  container.replaceChildren();
  for (const question of selected.length ? selected : defaultAssistantQuestions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.question = question;
    button.textContent = question;
    button.disabled = currentView.assistantBusy;
    container.appendChild(button);
  }
}

function appendAssistantMessage(role, message, referenceIds = []) {
  const article = document.createElement('article');
  article.className = `assistant-message ${role === 'user' ? 'is-user' : 'is-assistant'}`;
  const label = document.createElement('strong');
  label.textContent = role === 'user' ? '你' : '本地报告助手';
  const paragraph = document.createElement('p');
  paragraph.textContent = message;
  article.append(label, paragraph);
  if (Array.isArray(referenceIds) && referenceIds.length) {
    const references = document.createElement('div');
    references.className = 'assistant-references';
    const heading = document.createElement('strong');
    heading.textContent = '报告证据引用';
    references.appendChild(heading);
    for (const id of referenceIds.filter((value) => typeof value === 'string').slice(0, 12)) {
      const item = document.createElement('span');
      item.textContent = id;
      references.appendChild(item);
    }
    article.appendChild(references);
  }
  const log = $('#assistant-messages');
  log.appendChild(article);
  requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
}

function setChatContext(runId, dashboard = null) {
  if (currentView.completedRunId === runId) return;
  currentView.completedRunId = runId;
  $('#assistant-messages').replaceChildren();
  $('#assistant-feedback').className = '';
  $('#assistant-feedback').textContent = '本地结构化报告问答，回答需结合原始数据人工复核。';
  $('#assistant-diagnosis-link').hidden = !runId;
  if (runId && dashboard?.run) {
    const scope = dashboard.run;
    $('#assistant-context').textContent = `已关联完成任务 ${runId} · 门店 ${scope.storeId || '—'} · SKU ${scope.skuId || '—'}；数据来源仍以上传者声明为准。`;
    appendAssistantMessage('assistant', '已关联当前诊断报告。你可以询问销量下降的候选原因、支持或反对证据、数据缺口及经营建议。这里是本地结构化报告问答，尚未接入大模型。');
    renderAssistantSuggestions(['为什么销量下降？', '主要证据有哪些？', '还需要补查哪些数据？', '经营建议是什么？']);
  } else {
    $('#assistant-context').textContent = '尚未关联诊断报告。可以先了解数据导入流程。';
    appendAssistantMessage('assistant', '当前没有已完成的诊断报告。请前往“数据与诊断”导入经营数据并运行任务；完成后这里会引用该报告回答。当前仅提供本地结构化报告问答，尚未接入大模型。');
    renderAssistantSuggestions(defaultAssistantQuestions);
  }
}

function setAssistantBusy(busy) {
  currentView.assistantBusy = busy;
  $('#assistant-send').disabled = busy;
  $('#assistant-input').disabled = busy;
  $('#assistant-send').textContent = busy ? '正在查询…' : '发送';
  $('#assistant-suggestions').querySelectorAll('button').forEach((button) => { button.disabled = busy; });
}

async function sendAssistantMessage(rawMessage) {
  const message = String(rawMessage || '').trim();
  if (currentView.assistantBusy) return;
  if (!message || message.length > 2000) {
    $('#assistant-feedback').className = 'error';
    $('#assistant-feedback').textContent = '问题需要 1–2000 个字符。';
    return;
  }
  const runId = currentView.completedRunId;
  appendAssistantMessage('user', message);
  $('#assistant-input').value = '';
  $('#assistant-feedback').className = '';
  $('#assistant-feedback').textContent = runId ? '正在查阅当前诊断报告……' : '正在获取数据导入指引……';
  setAssistantBusy(true);
  try {
    const reply = await fetchJson('/api/assistant/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...(runId ? { runId } : {}), message }),
    }, 15_000);
    if (runId !== currentView.completedRunId) return;
    if (reply?.mode !== 'local-report' || typeof reply.answer !== 'string') {
      throw new Error('问答接口返回格式不完整。');
    }
    appendAssistantMessage('assistant', reply.answer, reply.referenceIds);
    renderAssistantSuggestions(reply.suggestions);
    $('#assistant-feedback').textContent = runId
      ? '回答来自当前结构化诊断报告，证据与建议仍需人工复核。'
      : '尚无诊断报告；请先导入数据并完成诊断。';
  } catch (error) {
    if (runId !== currentView.completedRunId) return;
    $('#assistant-input').value = message;
    $('#assistant-feedback').className = 'error';
    $('#assistant-feedback').textContent = `问答失败：${error?.name === 'AbortError' ? '请求超时' : error?.message || '服务不可用'}。问题已保留，可重试。`;
  } finally {
    setAssistantBusy(false);
    $('#assistant-input').focus();
  }
}

function setApiStatus() {
  const pill = $('#api-status');
  pill.className = `status-pill ${currentView.apiAvailable ? '' : 'error'}`;
  pill.innerHTML = `<span class="status-dot"></span>${currentView.apiAvailable ? '本地服务已连接' : '本地服务未连接'}`;
  $('#updated-at').textContent = '任务仅存于本机内存';
}

function renderExperimentProvenance(data, fallback) {
  const banner = $('#experiment-provenance');
  banner.className = 'provenance-banner demo';
  banner.textContent = data?.provenance === 'unavailable'
    ? '实验接口与本地演示文件均未加载。请确认项目服务已启动后刷新页面。'
    : fallback
    ? '当前为界面演示数据，非程序评测结果，不能证明算法性能。'
    : data?.provenance === 'not-run'
      ? '尚未运行程序评测。请执行 npm run eval 后刷新；这里不会使用工作台上传的数据。'
      : `当前展示${provenanceLabel(data, false, true)}。与上传诊断数据相互独立；合成案例结果不能外推为真实业务准确率。`;
}

function renderResultProvenance(data) {
  const banner = $('#provenance-banner');
  banner.className = 'provenance-banner demo';
  const declaration = data?.sourceDeclaration || {};
  banner.innerHTML = `<strong>本次结果来源：</strong>${escapeHtml(currentView.importedFile || '历史诊断任务')}；${escapeHtml(provenanceLabel(data, false, false))}。` +
    ` provenance=${escapeHtml(declaration.provenance ?? '未声明')}。该声明由上传者提供，系统未验证数据来源；诊断建议需人工复核。`;
}

function renderDashboard(data, fallback) {
  const run = data?.run || {};
  $('#scope-store').textContent = textOrDash(run.storeId || data?.storeId);
  $('#scope-sku').textContent = textOrDash(run.skuId || data?.skuId);
  $('#scope-baseline').textContent = windowLabel(run.baselineWindow || data?.baselineWindow);
  $('#scope-anomaly').textContent = windowLabel(run.anomalyWindow || data?.anomalyWindow);
  $('#diagnosis-source').className = 'data-badge demo';
  $('#diagnosis-source').textContent = provenanceLabel(data, fallback, false);
  renderKpis(data);
  renderTrend(data?.series || [], run);
  renderCauses(data?.causes || [], run?.verification || data?.verification);
  renderEvidence(data?.evidence || []);
  renderTrace(data?.trace || [], run?.recommendation || data?.recommendation);
  renderSources(data?.sources || []);
  renderBoundaries(data, Boolean(data?.sourceDeclaration));
}

function renderKpis(data) {
  const series = Array.isArray(data?.series) ? data.series : [];
  const run = data?.run || {};
  const baseline = series.filter((row) => inWindow(row.date, run.baselineWindow) && hasFiniteValue(row.units_sold)).map((row) => Number(row.units_sold));
  const anomaly = series.filter((row) => inWindow(row.date, run.anomalyWindow) && hasFiniteValue(row.units_sold)).map((row) => Number(row.units_sold));
  const before = baseline.reduce((a, b) => a + b, 0) / baseline.length;
  const after = anomaly.reduce((a, b) => a + b, 0) / anomaly.length;
  const salesDelta = Number.isFinite(before) && before > 0 && Number.isFinite(after) ? `${after < before ? '' : '+'}${number((after / before - 1) * 100, 1)}%` : '—';
  const topCause = Array.isArray(data?.causes) ? [...data.causes].filter((item) => hasFiniteValue(item.score) && Number(item.score) > 0).sort((a, b) => Number(b.score) - Number(a.score))[0] : null;
  const sources = Array.isArray(data?.sources) ? data.sources : [];
  const available = sources.filter((item) => sourceStatus(item) === 'ok').length;
  const cards = [
    { title: '日均销量变化', value: salesDelta, note: `异常期相对对照期 · 有效日 ${anomaly.length}/${baseline.length}`, tone: '' },
    { title: '首位候选原因', value: topCause ? causeName(topCause.cause) : '证据不足', note: '待证据核验的排序结果', tone: 'teal' },
    { title: '记录的证据', value: `${Array.isArray(data?.evidence) ? data.evidence.length : 0} 条`, note: '含支持与反对证据', tone: 'violet' },
    { title: '可用数据来源', value: sources.length ? `${available} / ${sources.length}` : '—', note: '错误与缺失单独记录', tone: 'amber' },
  ];
  $('#kpi-grid').innerHTML = cards.map((card) => `<div class="kpi-card ${card.tone}"><div class="kpi-title">${escapeHtml(card.title)}</div><div class="kpi-value">${escapeHtml(card.value)}</div><div class="kpi-note">${escapeHtml(card.note)}</div></div>`).join('');
}

function inWindow(date, window) { return !!(window?.start && window?.end && date >= window.start && date <= window.end); }

function renderTrend(series, run) {
  const rows = series.filter((row) => row?.date).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  renderTrendTable(rows);
  const wrap = $('#trend-chart');
  const conflicts = rows.flatMap((row) => Object.entries(row.metricStates || {})
    .filter(([, state]) => state === 'conflict')
    .map(([metric]) => `${row.date} ${businessMetricNames[metric] || metric}`));
  const conflictNote = conflicts.length
    ? ` 数据冲突已留白：${conflicts.slice(0, 5).join('、')}${conflicts.length > 5 ? `等 ${conflicts.length} 处` : ''}。`
    : '';
  if (rows.length < 2 || rows.filter((row) => hasFiniteValue(row.units_sold)).length < 2) { wrap.innerHTML = '<div class="muted-empty">暂无足够的销量时序数据。</div>'; $('#trend-note').textContent = `缺失值不会按 0 绘制。${conflictNote}`; return; }
  wrap.innerHTML = '<div class="chart-tooltip" hidden></div>';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'trend-svg'); svg.setAttribute('viewBox', '0 0 740 251');
  svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', '销量和访客每日相对走势，双指标各自归一化');
  svg.innerHTML = '<defs><linearGradient id="salesFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#2d82e3" stop-opacity=".20"/><stop offset="100%" stop-color="#2d82e3" stop-opacity="0"/></linearGradient></defs>';
  const left = 35, right = 721, top = 16, bottom = 212;
  const maxSales = Math.max(1, ...rows.filter((r) => hasFiniteValue(r.units_sold)).map((r) => Number(r.units_sold)));
  const maxVisitors = Math.max(1, ...rows.filter((r) => hasFiniteValue(r.visitors)).map((r) => Number(r.visitors)));
  const x = (i) => left + (right - left) * i / (rows.length - 1);
  const y = (value, max) => bottom - Number(value) / max * (bottom - top);
  for (let level = 0; level <= 4; level++) {
    const yy = bottom - level * (bottom - top) / 4;
    svgNode(svg, 'line', { x1: left, y1: yy, x2: right, y2: yy, class: 'chart-grid' });
    const label = svgNode(svg, 'text', { x: 5, y: yy + 4, class: 'chart-label' }); label.textContent = `${level * 25}`;
  }
  const split = rows.findIndex((r) => inWindow(r.date, run?.anomalyWindow));
  if (split > 0) {
    const splitX = x(split) - (x(split) - x(split - 1)) / 2;
    svgNode(svg, 'line', { x1: splitX, y1: top, x2: splitX, y2: bottom, stroke: '#ebbd9e', 'stroke-dasharray': '4 4' });
    const splitLabel = svgNode(svg, 'text', { x: splitX + 6, y: top + 11, class: 'chart-label' }); splitLabel.textContent = '异常期';
  }
  const segments = (metric, max) => {
    const parts = [];
    let current = [];
    rows.forEach((row, i) => {
      if (hasFiniteValue(row[metric])) current.push([x(i), y(row[metric], max)]);
      else if (current.length) { parts.push(current); current = []; }
    });
    if (current.length) parts.push(current);
    return parts;
  };
  const pathOf = (points) => points.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
  for (const points of segments('units_sold', maxSales)) {
    if (points.length > 1) {
      svgNode(svg, 'path', { d: `${pathOf(points)} L${points.at(-1)[0]},${bottom} L${points[0][0]},${bottom} Z`, class: 'chart-area' });
      svgNode(svg, 'path', { d: pathOf(points), class: 'line-sales' });
    }
  }
  for (const points of segments('visitors', maxVisitors)) {
    if (points.length > 1) svgNode(svg, 'path', { d: pathOf(points), class: 'line-visitors' });
  }
  rows.forEach((row, i) => {
    if (i % Math.max(1, Math.floor(rows.length / 7)) === 0 || i === rows.length - 1) {
      const label = svgNode(svg, 'text', { x: x(i), y: 237, class: 'chart-label', 'text-anchor': 'middle' });
      label.textContent = compactDate(row.date);
    }
    if (!hasFiniteValue(row.units_sold)) return;
    const point = svgNode(svg, 'circle', { cx: x(i), cy: y(row.units_sold, maxSales), r: 4, class: 'chart-point chart-focus-point', tabindex: '0', 'aria-label': `${row.date}，销量 ${number(row.units_sold)} 件，访客 ${number(row.visitors)} 人，库存 ${number(row.stock_on_hand)} 件` });
    const show = () => {
      const tooltip = wrap.querySelector('.chart-tooltip');
      tooltip.hidden = false;
      tooltip.innerHTML = `<strong>${escapeHtml(row.date)}</strong><span>销量 ${escapeHtml(number(row.units_sold))} 件 · 访客 ${escapeHtml(number(row.visitors))} 人</span><span>库存 ${escapeHtml(number(row.stock_on_hand))} 件</span>`;
      tooltip.style.left = `${Math.min(79, Math.max(0, x(i) / 740 * 100))}%`;
      tooltip.style.top = `${Math.max(0, y(row.units_sold, maxSales) / 251 * 100 - 30)}%`;
    };
    point.addEventListener('mouseenter', show); point.addEventListener('focus', show);
    point.addEventListener('mouseleave', () => wrap.querySelector('.chart-tooltip').hidden = true);
    point.addEventListener('blur', () => wrap.querySelector('.chart-tooltip').hidden = true);
  });
  wrap.appendChild(svg);
  $('#trend-note').textContent = `销量与访客曲线分别按各自最大值缩放到 0–100；缺失日期留白，不按 0 处理。悬停或聚焦数据点可读实际数值。${conflictNote}`;
}

function renderTrendTable(rows) {
  $('#trend-rows').innerHTML = rows.length ? rows.map((row) => {
    const states = Object.entries(row.metricStates || {}).filter(([, status]) => status !== 'ok');
    const state = states.length ? states.map(([metric, status]) =>
      `${businessMetricNames[metric] || metric}：${{
        conflict: '冲突', partial: '部分缺失', missing: '缺失', error: '错误',
      }[status] || status}`).join('；') : '已记录';
    return `<tr><th scope="row">${escapeHtml(row.date)}</th><td>${escapeHtml(number(row.units_sold))}</td><td>${escapeHtml(number(row.visitors))}</td><td>${escapeHtml(number(row.stock_on_hand))}</td><td>${escapeHtml(number(row.price, 2))}</td><td>${row.promotion_active === null || row.promotion_active === undefined ? '—' : row.promotion_active ? '进行中' : '未进行'}</td><td>${escapeHtml(state)}</td></tr>`;
  }).join('') : '<tr><td colspan="7">暂无按日数据。</td></tr>';
}

function svgNode(parent, tag, attrs) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, String(value)));
  parent.appendChild(node); return node;
}

function renderCauses(causes, verification) {
  const sorted = [...causes].sort((a, b) => Number(b.score) - Number(a.score));
  const max = Math.max(1e-9, ...sorted.map((item) => Math.max(0, Number(item.score) || 0)));
  $('#cause-list').innerHTML = sorted.length ? sorted.slice(0, 4).map((item, index) => {
    const explanation = String(item.explanation || item.reason || '暂无说明').replace(/仍缺少：([^。]+)/, (_, metrics) => `仍缺少：${metrics.split('、').map((metric) => businessMetricNames[metric] || metric).join('、')}`);
    const width = hasFiniteValue(item.score) ? Math.max(0, Math.min(100, Number(item.score) / max * 100)) : 0;
    return `<div class="cause-row"><div class="cause-row-top"><span class="cause-label"><small>${String(index + 1).padStart(2, '0')}</small>${escapeHtml(causeName(item.cause))}</span><strong class="cause-score">${escapeHtml(number(item.score, 3))}</strong></div><div class="cause-track"><div class="cause-fill" style="width:${width}%"></div></div><div class="cause-note">${escapeHtml(explanation)}</div></div>`;
  }).join('') : '<div class="muted-empty">暂无候选原因。</div>';
  const status = typeof verification === 'string' ? verification : verification?.status;
  const reason = typeof verification === 'object' ? verification?.reason : '';
  const box = $('#verification-summary');
  box.className = `verification-box ${status && status !== 'supported' ? 'needs-data' : ''}`;
  box.innerHTML = `<span aria-hidden="true">${status === 'supported' ? '✓' : '!'}</span><span><strong>结论核验：${escapeHtml(verificationNames[status] || '待执行')}</strong><br>${escapeHtml(reason || '请结合证据列表复核候选原因。')}</span>`;
}

function renderEvidence(evidence) {
  $('#evidence-list').innerHTML = evidence.length ? evidence.map((item) => `<div class="evidence-item"><span class="evidence-polarity ${item.polarity === 'contradicts' ? 'contradicts' : ''}">${item.polarity === 'contradicts' ? '反对证据' : '支持证据'}</span><div><strong>${escapeHtml(causeName(item.cause))} · ${escapeHtml(item.evidenceId || '未编号')}</strong><p>${escapeHtml(item.explanation || item.summary || '暂无解释')}</p></div></div>`).join('') : '<div class="muted-empty">暂无记录的诊断证据。</div>';
}

function renderTrace(trace, recommendation) {
  $('#trace-list').innerHTML = trace.length ? trace.map((item) => {
    const title = typeof item === 'string' ? item : item.title || traceNames[item.kind] || item.action || '执行步骤';
    const detail = typeof item === 'string' ? '' : item.detail || item.reason || '';
    const localized = String(detail).replace(/^(needs_data|supported|contradicted|insufficient):/, (_, status) => `${verificationNames[status] || status}：`).replace(/\b(units_sold|paid_orders|visitors|stock_on_hand|price|promotion_active)\b/g, (metric) => businessMetricNames[metric] || metric);
    return `<li><strong>${escapeHtml(title)}${item.metric ? ` · ${escapeHtml(businessMetricNames[item.metric] || item.metric)}` : ''}</strong>${escapeHtml(traceReasonNames[localized] || localized)}</li>`;
  }).join('') : '<li><strong>暂无执行轨迹</strong>接口尚未提供步骤记录。</li>';
  $('#recommendation').innerHTML = `<strong>经营建议</strong>${escapeHtml(Array.isArray(recommendation) ? recommendation.join('；') : recommendation || '暂无建议。')}`;
}

function sourceStatus(source) {
  if (Number(source.conflicts) > 0) return 'conflict';
  if (source.status) return source.status;
  if (Number.isFinite(Number(source.records)) && Number.isFinite(Number(source.missing))) {
    if (Number(source.records) === 0 || Number(source.missing) >= Number(source.records)) return 'missing';
    return Number(source.missing) > 0 ? 'partial' : 'ok';
  }
  return 'unknown';
}

function renderSources(sources) {
  $('#source-list').innerHTML = sources.length ? sources.map((source) => {
    const status = sourceStatus(source);
    const definition = source.definition || source.metricDefinition || businessMetricNames[source.metric] || '';
    const updatedAt = source.updatedAt || source.sourceUpdatedAt || source.latestUpdate;
    const counts = Number.isFinite(Number(source.records)) ? ` · ${escapeHtml(source.records)} 条记录${Number(source.missing) ? `，${escapeHtml(source.missing)} 条缺失` : ''}${Number(source.conflicts) ? `，${escapeHtml(source.conflicts)} 条冲突` : ''}` : '';
    return `<div class="source-item"><div><strong>${escapeHtml(source.name || source.source || '未命名来源')}</strong><small>${escapeHtml(definition)}${counts}${updatedAt ? ` · 更新 ${escapeHtml(updatedAt)}` : ''}</small></div><span class="source-state ${status === 'ok' ? '' : 'missing'}">${status === 'ok' ? '可用' : status === 'partial' ? '部分缺失' : status === 'missing' ? '缺失' : status === 'error' ? '错误' : status === 'conflict' ? '冲突待核验' : '待核验'}</span></div>`;
  }).join('') : '<div class="muted-empty">暂无数据来源信息。</div>';
}

function renderBoundaries(data, imported = false) {
  const syntheticDeclaration = imported ? data?.sourceDeclaration?.synthetic : data?.synthetic;
  const boundaries = [
    ['01', '仅查询经营数据，不自动改价、补货或执行其他写操作。'],
    ['02', '第一阶段仅覆盖单店、单 SKU 的销量下降诊断。'],
    ['03', '排序分数不等于真实因果概率；冲突或缺失证据需要补查或暂缓结论。'],
    ['04', `当前结果来源：${imported ? data?.sourceDeclaration?.provenance ?? '未声明' : data?.provenance || '未提供'}${imported ? '（上传者自述，未核验）' : ''}；合成数据：${syntheticDeclaration === true ? '是' : syntheticDeclaration === false ? imported ? '否（上传者自述）' : '否（接口声明）' : '未声明'}。`],
  ];
  $('#run-boundary').innerHTML = boundaries.map(([index, content]) => `<div class="boundary-item"><b>${index}</b><span>${escapeHtml(content)}</span></div>`).join('');
}

function renderEvaluations(data, fallback) {
  const modules = Array.isArray(data?.modules) ? data.modules : [];
  const cases = Array.isArray(data?.cases) ? data.cases : [];
  $('#evaluation-source').className = `data-badge ${fallback ? 'demo' : ''}`;
  $('#evaluation-source').textContent = provenanceLabel(data, fallback, true);
  const dataset = data?.dataset;
  const datasetLabel = typeof dataset === 'string' ? dataset : dataset && typeof dataset === 'object'
    ? `合成 ${number(dataset.holdout)} / ${number(dataset.total)} 例`
    : data?.datasetName || (data?.provenance === 'not-run' ? '评测尚未运行' : data?.synthetic ? '合成测试集' : '未提供');
  const splitLabel = data?.split || (dataset && typeof dataset === 'object'
    ? `开发 ${number(dataset.development)} / 固定评测 ${number(dataset.holdout)}（已用于调试）` : '请查阅实验说明');
  const facts = [
    ['数据集', datasetLabel],
    ['案例数', data?.sampleSize ?? cases.length],
    ['划分', splitLabel],
    ['运行时间', data?.generatedAt ? new Date(data.generatedAt).toLocaleString('zh-CN') : '未运行 / 未提供'],
  ];
  if (data?.environment?.sourceSha256) facts.push(['源码摘要', String(data.environment.sourceSha256).slice(0, 12)]);
  $('#evaluation-meta').innerHTML = facts.map(([label, value]) => `<div class="meta-chip">${escapeHtml(label)}<strong>${escapeHtml(value)}</strong></div>`).join('');
  renderStress(data?.stress);
  renderModuleTable(modules);
  renderModuleSelector(modules);
  renderMethodology(data, fallback);
  renderCases(cases);
  $('#case-export').hidden = fallback || data?.provenance === 'not-run' || cases.length === 0;
}

function moduleNumber(module, index) {
  const raw = String(module?.id || module?.moduleId || index + 1);
  return raw.replace(/^module/i, '');
}
function primaryMetric(module) {
  const metric = Array.isArray(module?.metrics) ? module.metrics[0] : null;
  if (!metric) return null;
  if (metric.ablation !== undefined && metric.ablation !== null) return metric;
  const ablations = module?.ablations || {};
  const id = String(module?.id || module?.moduleId || '').toLowerCase();
  const mapping = {
    module1: [ablations.parallelFifoLocalRepair?.meanVirtualMs ?? ablations.parallelFifoFullRerun?.meanVirtualMs, '并行 FIFO + 局部修复'],
    module2: [ablations.densityAwareFifo?.keyEvidenceRecallPct, '密度估计 + FIFO'],
    module3: [ablations.noBusinessRisk?.accuracyPct ?? ablations.withoutBusinessRisk?.policyAccuracyPct ?? ablations.noBusinessRiskAccuracyPct, '去除业务风险判断'],
    module4: [ablations.noCounterEvidenceTop1, '去除反对证据'],
    module5: [ablations.fullDataNoVerificationDecisionCorrect ?? ablations.fixedOrderDecisionCorrect, '去除结论核验'],
  };
  const [ablation, label] = mapping[id] || [undefined, '关键消融'];
  return { ...metric, ablation, ablationLabel: metric.ablationLabel || label };
}
function metricLabel(metric) { return metricNames[metric?.name] || textOrDash(metric?.name || metric?.key); }
function metricValue(metric, field) {
  const value = metric?.[field];
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const scaled = metric?.unit === 'ratio' || metric?.unit === '%' && metric?.scale === 'fraction' ? Number(value) * 100 : Number(value);
  const unit = {
    ratio: '%', 'virtual-ms': ' 虚拟 ms', executions: ' 次',
    scenarios: ' 个场景', calls: ' 次', queries: ' 次',
  }[metric?.unit] || metric?.unit || '';
  return `${number(scaled, Number.isInteger(scaled) ? 0 : 2)}${unit}`;
}
function direction(metric) { return metric?.better === 'lower' || metric?.direction === 'lower' ? 'lower' : 'higher'; }
function improvement(metric) {
  if (!Number.isFinite(Number(metric?.baseline)) || !Number.isFinite(Number(metric?.full))) return null;
  const baseline = Number(metric.baseline), full = Number(metric.full);
  const difference = direction(metric) === 'lower' ? baseline - full : full - baseline;
  if (metric?.unit === 'ratio' || metric?.unit === '%') {
    const percentagePoints = difference * (metric.unit === 'ratio' ? 100 : 1);
    return `${percentagePoints >= 0 ? '+' : ''}${number(percentagePoints, 2)} 个百分点`;
  }
  if (baseline === 0) return difference === 0 ? '0' : '—';
  return `${difference >= 0 ? '+' : ''}${number(difference / Math.abs(baseline) * 100, 1)}%`;
}

function renderModuleTable(modules) {
  $('#module-rows').innerHTML = modules.length ? modules.map((module, index) => {
    const metric = primaryMetric(module);
    const ablation = metric?.ablation === null || metric?.ablation === undefined ? '未提供' : metricValue(metric, 'ablation');
    const delta = improvement(metric);
    return `<tr><td><strong>模块 ${escapeHtml(moduleNumber(module, index))} · ${escapeHtml(module.name || '未命名模块')}</strong><small>${escapeHtml(module.owner || moduleOwners[module.id] || '负责人未提供')} · n=${escapeHtml(module.sampleCount ?? '—')}</small></td><td class="metric-name">${escapeHtml(metricLabel(metric))}<br><small>${direction(metric) === 'lower' ? '越低越好' : '越高越好'}</small></td><td>${escapeHtml(metricValue(metric, 'baseline'))}</td><td><span class="full-value">${escapeHtml(metricValue(metric, 'full'))}</span></td><td>${escapeHtml(ablation)}<br><small>${escapeHtml(metric?.ablationLabel || '关键消融')}</small></td><td class="${delta && delta.startsWith('+') ? 'delta-positive' : 'delta-neutral'}">${escapeHtml(delta || '—')}</td></tr>`;
  }).join('') : '<tr><td colspan="6">暂无实验指标。请运行评测后刷新页面。</td></tr>';
}

function renderModuleSelector(modules) {
  const selector = $('#module-select');
  selector.innerHTML = modules.map((module, index) => `<option value="${index}">模块 ${escapeHtml(moduleNumber(module, index))} · ${escapeHtml(module.name || '未命名')}</option>`).join('');
  const update = () => renderModuleChart(modules[Number(selector.value)]);
  selector.addEventListener('change', update);
  update();
}

function renderModuleChart(module) {
  const metric = primaryMetric(module);
  const chart = $('#module-chart');
  if (!metric) { chart.innerHTML = '<div class="muted-empty">暂无可比较的指标。</div>'; return; }
  const entries = [
    ['普通基线', metric.baseline, 'baseline'], ['完整方法', metric.full, 'full'],
    [metric.ablationLabel || '关键消融', metric.ablation, 'ablation'],
  ];
  const max = Math.max(1, ...entries.map(([, value]) => Number(value) || 0));
  const bootstrap = module?.details?.pairedBootstrap95Difference;
  const interval = Array.isArray(bootstrap) && bootstrap.length === 2
    ? ` 成对重采样 95% 差值区间：${number(Number(bootstrap[0]) * 100, 1)} 至 ${number(Number(bootstrap[1]) * 100, 1)} 个百分点。` : '';
  const caveat = module?.id === 'module4' && metric.ablation === metric.full
    ? '主集该项消融与完整方法同分，不能据此声称准确率收益；请看上方压力检查中的候选分数变化。' : '';
  chart.innerHTML = `<div>${entries.map(([label, value, kind]) => `<div class="bar-row ${kind}"><span>${escapeHtml(label)}</span><div class="bar-track"><div class="bar-fill" style="width:${Number.isFinite(Number(value)) ? Math.max(0, Math.min(100, Number(value) / max * 100)) : 0}%"></div></div><strong>${escapeHtml(metricValue(metric, kind === 'baseline' ? 'baseline' : kind === 'full' ? 'full' : 'ablation'))}</strong></div>`).join('')}</div><div class="module-chart-note">${escapeHtml(metricLabel(metric))} · ${direction(metric) === 'lower' ? '越低越好' : '越高越好'}；n=${escapeHtml(module.sampleCount ?? '—')}。${escapeHtml(caveat || '消融移除一项关键机制；缺失值不会推算。')}${escapeHtml(interval)}</div>`;
}

function renderMethodology(data, fallback) {
  const methods = [
    '固定合成案例与预设标签，记录每类场景和失败案例的原始计数。',
    '同一模块的基线、完整方法和消融共享输入、工具响应与评价规则。',
    '评测方案记录主要指标，并核对数据泄漏、重复案例与指标定义。',
    '分别报告合成案例和真实业务数据，不把界面演示值当实验结果。',
  ];
  if (data?.synthetic && !fallback) methods.push('当前使用项目内合成案例，尚无独立人工标注；不能外推到真实店铺表现。');
  $('#methodology-list').innerHTML = methods.map((item) => `<li>${escapeHtml(item)}</li>`).join('') +
    (data?.provenance === 'unavailable' ? '<li>实验数据暂不可用，请检查本地服务。</li>' : fallback ? '<li>当前加载的是本地界面演示文件，尚未执行程序评测。</li>' : '');
}

function renderStress(stress) {
  const panel = $('#stress-panel');
  if (!stress || !Array.isArray(stress.cases)) { panel.hidden = true; return; }
  panel.hidden = false;
  const passed = stress.cases.filter(item => item.pass).length;
  const total = stress.cases.length;
  const reported = stress.sampleCount === total && Math.abs(Number(stress.passRate) - passed / Math.max(1, total) * 100) < 0.011;
  $('#stress-summary').innerHTML = `${passed} / ${total}<small>机制检查通过 · ${escapeHtml(number(passed / Math.max(1, total) * 100, 2))}%</small>`;
  const failures = stress.cases.filter(item => !item.pass);
  $('#stress-failures').innerHTML = `${reported ? '' : '<div class="stress-failure"><strong>结果文件自检异常</strong>报告中的样本数或通过率与逐例记录不一致，请重新运行评测。</div>'}${failures.length ? failures.map((item) => `<div class="stress-failure"><strong>待处理 · ${escapeHtml(item.id)}</strong>预期：${escapeHtml(item.expected)}<br>实际：${escapeHtml(item.actual)}<br>${escapeHtml(item.note)}</div>`).join('') : '<div class="stress-all-pass">本轮固定压力检查全部通过；该通过率仍不代表真实业务准确率。</div>'}`;
}

let allCases = [];
function renderCases(cases) {
  allCases = cases;
  $('#case-search').addEventListener('input', updateCaseRows);
  $('#case-filter').addEventListener('change', updateCaseRows);
  updateCaseRows();
}
function caseStatus(item) {
  if (resultNames[item.status]) return item.status;
  if (item.fullCorrect !== undefined && item.fullCorrect !== null) return Number(item.fullCorrect) === 1 ? 'correct' : 'incorrect';
  if (item.predictedCause === null || item.predictedCause === undefined) return 'abstained';
  return item.predictedCause === item.goldCause ? 'correct' : 'incorrect';
}
function updateCaseRows() {
  const search = $('#case-search').value.trim().toLowerCase();
  const filter = $('#case-filter').value;
  const filtered = allCases.filter((item) => (filter === 'all' || filter === 'abstained' && !['supported', undefined].includes(item.fullStatus || item.verification) || caseStatus(item) === filter) && `${item.caseId || ''} ${item.skuId || ''} ${item.scenario || ''}`.toLowerCase().includes(search));
  $('#case-count').textContent = `${filtered.length} / ${allCases.length} 例`;
  $('#case-rows').innerHTML = filtered.map((item) => {
    const status = caseStatus(item);
    const verification = item.fullStatus || (typeof item.verification === 'object' ? item.verification.status : item.verification);
    const gold = Array.isArray(item.gold) ? item.gold.length ? item.gold.map(causeName).join('、') : '无可确认原因' : causeName(item.goldCause || item.gold);
    const predicted = item.fullCause || item.predictedCause;
    const finalAnswer = verification && verification !== 'supported'
      ? `保留判断${predicted ? `（候选：${causeName(predicted)}）` : ''}` : predicted ? causeName(predicted) : '未下结论';
    return `<tr><td><strong>${escapeHtml(item.caseId || '—')}</strong><small>${escapeHtml(item.skuId || 'SKU 未单列')}</small></td><td>${escapeHtml(scenarioNames[item.scenario] || item.scenario || '—')}</td><td>${escapeHtml(gold)}</td><td>${escapeHtml(finalAnswer)}</td><td><span class="result-label ${status}">${escapeHtml(resultNames[status])}</span><br><small>${escapeHtml(verificationNames[verification] || verification || '')}</small></td><td>${escapeHtml(number(item.fullQueries ?? item.queryCount ?? item.extraQueries))}</td></tr>`;
  }).join('');
  $('#case-empty').hidden = filtered.length > 0;
}

function setImportStatus(message, tone = '') {
  const status = $('#import-status');
  status.className = `import-status ${tone}`;
  status.textContent = message;
}

function activateView() {
  const target = location.hash.slice(1);
  const experiments = target === 'experiments' || target === 'cases';
  const workbench = ['workbench', 'workflow', 'diagnosis', 'sources'].includes(target);
  const view = experiments ? 'experiments' : workbench ? 'workbench' : 'assistant';
  $('#view-assistant').hidden = view !== 'assistant';
  $('#view-workbench').hidden = view !== 'workbench';
  $('#view-experiments').hidden = view !== 'experiments';
  $('#breadcrumb-current').textContent = view === 'assistant' ? '智能问答'
    : view === 'workbench' ? '数据与诊断' : '算法实验';
  document.querySelectorAll('.side-nav [data-view]').forEach((link) => {
    const selected = link.dataset.view === view;
    link.classList.toggle('active', selected);
    if (selected) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  if (target && !['assistant', 'workbench', 'experiments'].includes(target)) {
    requestAnimationFrame(() => document.getElementById(target)?.scrollIntoView());
  } else if (target) {
    requestAnimationFrame(() => window.scrollTo(0, 0));
  }
}

function datasetDeclaration(dataset) {
  const synthetic = dataset?.synthetic === true ? '是（上传者声明）'
    : dataset?.synthetic === false ? '否（上传者声明，未核验）' : '未声明';
  return `来源：${dataset?.provenance || '未声明'}；合成数据：${synthetic}。系统不验证来源真实性。`;
}

function resetResultForNewDataset() {
  currentView.dashboard = null;
  currentView.importedFile = null;
  currentView.activeRunId = null;
  currentView.activeRunFromHistory = false;
  clearTimeout(currentView.pollTimer);
  setChatContext(null);
  $('#result-overview').hidden = true;
  $('#diagnosis').hidden = true;
  $('#sources').hidden = true;
  $('#result-empty').hidden = false;
  $('#result-empty').querySelector('p').textContent = '数据已载入。完成预检并启动诊断后，这里将显示本次证据与经营建议。';
  $('#jump-result').hidden = true;
  $('#report-link').hidden = true;
  $('#run-refresh').hidden = true;
  $('#run-error').hidden = true;
  $('#run-status').textContent = '待完成数据预检。';
  $('#run-progress').innerHTML = '<li>等待提交</li><li>排队与执行</li><li>复核结论</li>';
  $('#provenance-banner').textContent = '当前仅载入数据，尚无诊断结论。来源和合成标记属于上传者声明，系统不会自动核实。';
}

function setDataset(dataset, name, isExample = false, kind = 'json') {
  if (!dataset || typeof dataset !== 'object' || !dataset.diagnosisCase || !Array.isArray(dataset.observations)) {
    throw new Error('文件需要包含 diagnosisCase 对象及 observations 数组。');
  }
  const body = JSON.stringify(dataset);
  if (new Blob([body]).size > 1024 * 1024) throw new Error('JSON 请求超过 1 MiB，请缩小后重试。');
  currentView.dataset = dataset;
  currentView.datasetBody = body;
  currentView.datasetName = name;
  currentView.datasetKind = isExample ? 'example' : kind;
  currentView.datasetVersion++;
  currentView.validation = null;
  $('#dataset-summary').className = 'dataset-summary';
  $('#dataset-summary').innerHTML = `<strong>${escapeHtml(name)}</strong><span>${escapeHtml(number(dataset.observations.length))} 条观测记录 · 门店 ${escapeHtml(dataset.diagnosisCase.storeId)} · SKU ${escapeHtml(dataset.diagnosisCase.skuId)}</span>${isExample ? '<span class="data-badge demo">内置合成示例 · 非真实业务</span>' : kind === 'csv' ? '<span class="data-badge demo">CSV 来源由上传者声明，未核验</span>' : ''}`;
  $('#dataset-declaration').textContent = datasetDeclaration(dataset);
  $('#validation-summary').className = 'validation-summary';
  $('#validation-summary').textContent = '正在请求本地服务预检数据……';
  $('#validation-metrics').innerHTML = '';
  $('#run-button').disabled = true;
  $('#run-button').textContent = '开始诊断';
  $('#validate-button').disabled = false;
  setImportStatus(`${name} 已载入，正在预检。${isExample ? '此数据是合成示例，不能视为真实经营数据。' : '来源声明尚未经核验。'}`);
  resetResultForNewDataset();
  void validateDataset(currentView.datasetVersion);
}

async function postDataset(path, body) {
  return fetchJson(path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  }, 15_000);
}

function renderValidation(data) {
  const scope = data.scope || {};
  const metrics = Array.isArray(data.metrics) ? data.metrics : [];
  const conflicts = Number(data.conflicts?.count) || 0;
  const note = conflicts ? `发现 ${conflicts} 处多来源数值冲突；诊断时冲突值会留空并提示核验。` : '未发现多来源数值冲突。';
  $('#validation-summary').className = `validation-summary ${conflicts ? 'warning' : 'success'}`;
  $('#validation-summary').innerHTML = `<strong>结构预检通过 · ${escapeHtml(number(data.observationCount))} 条记录</strong><span>门店 ${escapeHtml(scope.storeId)} · SKU ${escapeHtml(scope.skuId)} · 对照期 ${escapeHtml(windowLabel(scope.baselineWindow))} · 异常期 ${escapeHtml(windowLabel(scope.anomalyWindow))}</span><span>${escapeHtml(note)}</span>`;
  $('#validation-metrics').innerHTML = metrics.length ? `<div class="table-scroll"><table class="validation-table"><caption class="sr-only">各指标在对照期和异常期的数据覆盖率</caption><thead><tr><th scope="col">指标</th><th scope="col">对照期有效天数</th><th scope="col">异常期有效天数</th><th scope="col">缺失 / 错误</th><th scope="col">冲突</th></tr></thead><tbody>${metrics.map((item) => {
    const baseline = item.baseline || {}, anomaly = item.anomaly || {};
    return `<tr><th scope="row">${escapeHtml(businessMetricNames[item.metric] || item.metric)}</th><td>${escapeHtml(number(baseline.validDays))} / ${escapeHtml(number(baseline.totalDays))} 天（${escapeHtml(number((Number(baseline.coverageRatio) || 0) * 100, 1))}%）</td><td>${escapeHtml(number(anomaly.validDays))} / ${escapeHtml(number(anomaly.totalDays))} 天（${escapeHtml(number((Number(anomaly.coverageRatio) || 0) * 100, 1))}%）</td><td>${escapeHtml(number(item.missing))} / ${escapeHtml(number(item.error))}</td><td>${escapeHtml(number(data.conflicts?.byMetric?.[item.metric] || 0))}</td></tr>`;
  }).join('')}</tbody></table></div>` : '<div class="empty-state">预检服务未返回指标统计。</div>';
}

async function validateDataset(version = currentView.datasetVersion) {
  if (!currentView.datasetBody) return;
  $('#validate-button').disabled = true;
  $('#run-button').disabled = true;
  $('#validation-summary').textContent = '正在预检数据结构、覆盖率与冲突……';
  try {
    const result = await postDataset('/api/datasets/validate', currentView.datasetBody);
    if (version !== currentView.datasetVersion) return;
    if (!result?.valid || !Array.isArray(result.metrics)) throw new Error('预检响应格式不完整。');
    currentView.validation = result;
    renderValidation(result);
    $('#run-button').disabled = false;
    setImportStatus('数据预检通过，可以发起只读诊断。缺失或冲突记录仍会在结果中提示。', 'success');
    if (currentView.datasetKind === 'csv') setCsvStatus('CSV 已转换，服务端预检通过。可点击“开始诊断”；来源与数据性质仍未独立核验。', 'success');
  } catch (error) {
    if (version !== currentView.datasetVersion) return;
    currentView.validation = null;
    $('#validation-summary').className = 'validation-summary error';
    $('#validation-summary').textContent = `预检失败：${error?.name === 'AbortError' ? '服务超时，请稍后重试。' : error?.message || '请检查文件。'}`;
    $('#validation-metrics').innerHTML = '';
    setImportStatus('数据尚未通过预检，诊断按钮保持禁用。修正文件或点击“重新预检”。', 'error');
    if (currentView.datasetKind === 'csv') setCsvStatus(`CSV 已转换，但服务端预检失败：${error?.message || '请检查数据。'}`, 'error');
  } finally {
    if (version === currentView.datasetVersion) $('#validate-button').disabled = false;
  }
}

function runStatusLabel(status) {
  return { queued: '排队中', running: '正在诊断', completed: '诊断完成', failed: '诊断失败' }[status] || '状态未知';
}

function renderRunState(run) {
  const status = run?.status;
  const label = runStatusLabel(status);
  $('#run-status').innerHTML = `<strong>${escapeHtml(label)}</strong><span>任务 ${escapeHtml(run.runId || '—')} · 门店 ${escapeHtml(run.storeId)} · SKU ${escapeHtml(run.skuId)} · ${escapeHtml(run.createdAt ? new Date(run.createdAt).toLocaleString('zh-CN') : '时间未知')}</span>`;
  $('#run-progress').innerHTML = `<li class="done">数据已提交</li><li class="${status === 'queued' || status === 'running' ? 'current' : status === 'failed' ? 'failed' : 'done'}">${status === 'queued' ? '等待执行' : status === 'running' ? '读取数据并分析' : status === 'failed' ? '任务中断' : '分析完成'}</li><li class="${status === 'completed' ? 'done' : ''}">${status === 'completed' ? '结果可复核' : '等待结论'}</li>`;
  $('#run-refresh').hidden = false;
  $('#run-error').hidden = status !== 'failed';
  if (status === 'failed') $('#run-error').textContent = run.error || '诊断失败，请检查数据后重新提交。';
  if (status !== 'completed') {
    currentView.dashboard = null;
    setChatContext(null);
    $('#result-overview').hidden = true;
    $('#diagnosis').hidden = true;
    $('#sources').hidden = true;
    $('#result-empty').hidden = false;
    $('#result-empty').querySelector('p').textContent = status === 'failed'
      ? '本次任务未生成诊断结论。请检查预检结果和任务错误后重试。'
      : '任务仍在执行。完成后将显示趋势、原因、证据和建议。';
    $('#jump-result').hidden = true;
    $('#report-link').hidden = true;
    $('#provenance-banner').textContent = '当前任务尚无可复核的诊断结论；来源信息以提交时的用户声明为准。';
  }
  if (status === 'completed' && isDashboardPayload(run.dashboard)) {
    currentView.dashboard = run.dashboard;
    setChatContext(run.runId, run.dashboard);
    renderDashboard(run.dashboard, false);
    renderResultProvenance(run.dashboard);
    $('#result-empty').hidden = true;
    $('#result-overview').hidden = false;
    $('#diagnosis').hidden = false;
    $('#sources').hidden = false;
    $('#jump-result').hidden = false;
    $('#report-link').hidden = false;
    $('#report-link').href = `/api/runs/${encodeURIComponent(run.runId)}/report`;
  } else if (status === 'completed') {
    currentView.dashboard = null;
    setChatContext(null);
    $('#result-overview').hidden = true;
    $('#diagnosis').hidden = true;
    $('#sources').hidden = true;
    $('#result-empty').hidden = false;
    $('#result-empty').querySelector('p').textContent = '服务返回的结果格式不完整，暂不显示诊断图表。请刷新任务状态。';
    $('#jump-result').hidden = true;
    $('#report-link').hidden = true;
    $('#run-error').hidden = false;
    $('#run-error').textContent = '任务已完成，但结果格式不完整。请刷新状态或检查服务。';
  }
}

async function pollRun(runId) {
  clearTimeout(currentView.pollTimer);
  try {
    const run = await fetchJson(`/api/runs/${encodeURIComponent(runId)}`, {}, 10_000);
    if (currentView.activeRunId !== runId) return;
    renderRunState(run);
    if (run.status === 'queued' || run.status === 'running') {
      currentView.pollTimer = setTimeout(() => { void pollRun(runId); }, 1200);
    } else {
      $('#run-button').disabled = !currentView.validation;
      $('#run-button').textContent = !currentView.validation ? '开始诊断'
        : currentView.activeRunFromHistory ? '诊断已选数据' : '再次诊断';
      void refreshHistory();
    }
  } catch (error) {
    if (currentView.activeRunId !== runId) return;
    $('#run-error').hidden = false;
    $('#run-error').textContent = `暂时无法刷新任务状态：${error?.name === 'AbortError' ? '请求超时' : error?.message || '连接失败'}。可点击“刷新任务状态”重试；任务可能仍在服务端执行。`;
  }
}

async function submitRun() {
  if (!currentView.validation || !currentView.datasetBody) return;
  const body = currentView.datasetBody;
  const datasetVersion = currentView.datasetVersion;
  const datasetName = currentView.datasetName;
  resetResultForNewDataset();
  $('#run-button').disabled = true;
  $('#run-button').textContent = '正在提交…';
  $('#run-error').hidden = true;
  $('#run-status').textContent = '正在向本地服务提交诊断任务……';
  try {
    const accepted = await postDataset('/api/runs', body);
    if (!accepted?.runId || accepted.status !== 'queued') throw new Error('任务服务返回格式不完整。');
    if (datasetVersion !== currentView.datasetVersion) {
      setImportStatus(`${datasetName} 的任务已提交，但当前已切换到另一份数据；可在近期任务中查看。`, 'success');
      void refreshHistory();
      return;
    }
    currentView.activeRunId = accepted.runId;
    currentView.activeRunFromHistory = false;
    currentView.importedFile = datasetName;
    $('#run-button').textContent = '诊断进行中';
    renderRunState(accepted);
    void refreshHistory();
    void pollRun(accepted.runId);
  } catch (error) {
    if (datasetVersion !== currentView.datasetVersion) return;
    $('#run-error').hidden = false;
    $('#run-error').textContent = `提交失败：${error?.name === 'AbortError' ? '请求超时，请查看历史任务，避免重复提交。' : error?.message || '服务不可用。'}`;
    $('#run-status').textContent = '未确认任务是否已提交。可刷新历史列表核对。';
    $('#run-button').disabled = false;
  } finally {
    if (!currentView.activeRunId) $('#run-button').textContent = '开始诊断';
  }
}

function renderRunHistory(data) {
  const runs = Array.isArray(data?.runs) ? data.runs : [];
  $('#run-history').innerHTML = runs.map((run) => {
    const declared = run.sourceDeclaration?.synthetic;
    const origin = declared === true ? '合成数据（自述）' : declared === false ? '非合成（自述，未核验）' : '数据类型未声明';
    return `<div class="run-history-item"><div><strong>${escapeHtml(runStatusLabel(run.status))} · ${escapeHtml(run.skuId || 'SKU 未知')}</strong><span>门店 ${escapeHtml(run.storeId)} · ${escapeHtml(run.createdAt ? new Date(run.createdAt).toLocaleString('zh-CN') : '时间未知')} · ${escapeHtml(origin)}</span><small>${escapeHtml(run.runId)}</small></div><button class="secondary-button" type="button" data-run-id="${escapeHtml(run.runId)}">${run.status === 'completed' ? '查看结果' : '查看状态'}</button></div>`;
  }).join('');
  $('#history-empty').hidden = runs.length > 0;
  if (!data) $('#history-empty').textContent = '暂时无法读取历史任务。请确认本地服务已启动后刷新。';
  else $('#history-empty').textContent = `暂无任务。记录只保存在本机内存，最多 ${data.maxRecords || '有限'} 条，服务重启后清空。`;
}

async function refreshHistory() {
  try {
    const data = await fetchJson('/api/runs');
    if (!Array.isArray(data?.runs)) throw new Error('任务列表格式不完整。');
    renderRunHistory(data);
  } catch (error) {
    if (!$('#run-history').children.length) renderRunHistory(null);
    else setImportStatus(`任务列表刷新失败：${error?.message || '服务不可用'}。已保留上次列表。`, 'error');
  }
}

function setCsvStatus(message, tone = '') {
  const status = $('#csv-status');
  status.className = `import-status ${tone}`;
  status.textContent = message;
}

function localInputToIso(value, label) {
  if (!value) throw new Error(`请填写${label}，不能用当前时间代替。`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label}不是有效时间。`);
  return date.toISOString();
}

async function handleCsvSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) {
    setCsvStatus('请补齐门店、SKU、日期窗口、来源、两个实际时间及 CSV 文件。', 'error');
    return;
  }
  const file = $('#csv-file').files?.[0];
  if (!file) { setCsvStatus('请选择按日 CSV 文件。', 'error'); return; }
  const button = $('#csv-submit');
  button.disabled = true;
  button.textContent = '正在转换…';
  setCsvStatus('正在检查 CSV 格式与报表元数据……');
  try {
    if (file.size > 1024 * 1024) throw new Error('CSV 文件超过 1 MiB，请缩小后重试。');
    const sourceName = $('#csv-source').value.trim();
    const storeId = $('#csv-store-id').value.trim();
    const skuId = $('#csv-sku-id').value.trim();
    if (!storeId || !skuId || !sourceName) throw new Error('请填写门店、SKU 和数据来源名称。');
    const sourceUpdatedAt = localInputToIso($('#csv-source-updated-at').value, '数据源最后更新时间');
    const fetchedAt = localInputToIso($('#csv-exported-at').value, '报表导出 / 获取时间');
    if (Date.parse(sourceUpdatedAt) > Date.parse(fetchedAt)) {
      throw new Error('数据源最后更新时间不能晚于报表导出 / 获取时间。');
    }
    const declaration = $('#csv-synthetic').value;
    const synthetic = declaration === '' ? undefined : declaration === 'true';
    const caseId = `csv-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
    const dataset = buildDatasetFromDailyCsv({
      csvText: await file.text(), storeId, skuId,
      baselineWindow: { start: $('#csv-baseline-start').value, end: $('#csv-baseline-end').value },
      anomalyWindow: { start: $('#csv-anomaly-start').value, end: $('#csv-anomaly-end').value },
      sourceName, sourceUpdatedAt, fetchedAt, synthetic, provenance: sourceName, caseId,
    });
    setDataset(dataset, file.name, false, 'csv');
    setCsvStatus(`${file.name} 已转换为单店单 SKU 数据，正在进行服务端预检。来源和数据性质仅为你的声明，尚未经核验。`, 'success');
  } catch (error) {
    setCsvStatus(`CSV 导入失败：${error?.message || '请检查文件和表单。'}${currentView.datasetName ? ` 当前仍使用 ${currentView.datasetName}。` : ' 当前未载入数据。'}`, 'error');
  } finally {
    button.disabled = false;
    button.textContent = '载入 CSV 并预检';
  }
}

function downloadCsvTemplate() {
  const header = 'date,units_sold,paid_orders,visitors,stock_on_hand,price,promotion_active\n';
  const blob = new Blob([header], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = 'daily-ecommerce-template.csv';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setCsvStatus('已下载只有表头的空白模板；请从业务报表填写日期和指标，0 与空白缺失不要混淆。', 'success');
}

async function handleDatasetFileChange(event) {
  const input = event.target;
  const file = input.files?.[0];
  if (!file) return;
  input.disabled = true;
  try {
    if (file.size > 1024 * 1024) throw new Error('文件超过 1 MiB，请缩小后重试。');
    let dataset;
    try { dataset = JSON.parse(await file.text()); }
    catch { throw new Error('JSON 格式无效，请检查文件内容。'); }
    setDataset(dataset, file.name);
  } catch (error) {
    setImportStatus(`无法载入文件：${error?.message || '读取失败。'}${currentView.datasetName ? ` 当前仍使用 ${currentView.datasetName}。` : ' 当前未载入数据。'}`, 'error');
  } finally {
    input.value = '';
    input.disabled = false;
  }
}

async function loadExampleDataset() {
  const button = $('#load-example');
  button.disabled = true;
  button.textContent = '正在载入…';
  try {
    const dataset = await fetchJson('/api/datasets/example');
    if (dataset?.synthetic !== true) throw new Error('示例接口未标明 synthetic=true，已拒绝载入。');
    setDataset(dataset, '内置合成示例', true);
  } catch (error) {
    setImportStatus(`合成示例载入失败：${error?.message || '服务不可用。'}`, 'error');
  } finally {
    button.disabled = false;
    button.textContent = '载入合成示例';
  }
}

async function downloadExampleDataset() {
  const button = $('#download-example');
  button.disabled = true;
  button.textContent = '正在准备…';
  try {
    const dataset = await fetchJson('/api/datasets/example');
    if (dataset?.synthetic !== true) throw new Error('示例接口未标明 synthetic=true，已拒绝下载。');
    const blob = new Blob([JSON.stringify(dataset, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = 'synthetic-ecommerce-dataset.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setImportStatus('已下载明确标记 synthetic=true 的示例 JSON。替换字段后可上传自有数据。', 'success');
  } catch (error) {
    setImportStatus(`下载示例失败：${error?.message || '服务不可用。'}`, 'error');
  } finally {
    button.disabled = false;
    button.textContent = '下载示例 JSON';
  }
}

window.addEventListener('hashchange', activateView);
activateView();
$('#assistant-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void sendAssistantMessage($('#assistant-input').value);
});
$('#assistant-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('#assistant-form').requestSubmit();
  }
});
$('#assistant-suggestions').addEventListener('click', (event) => {
  const button = event.target.closest('[data-question]');
  if (button && !button.disabled) void sendAssistantMessage(button.dataset.question);
});
$('#dataset-file').addEventListener('change', handleDatasetFileChange);
$('#csv-import-form').addEventListener('submit', handleCsvSubmit);
$('#csv-template').addEventListener('click', downloadCsvTemplate);
$('#load-example').addEventListener('click', loadExampleDataset);
$('#download-example').addEventListener('click', downloadExampleDataset);
$('#validate-button').addEventListener('click', () => { void validateDataset(); });
$('#run-button').addEventListener('click', () => { void submitRun(); });
$('#history-refresh').addEventListener('click', () => { void refreshHistory(); });
$('#run-refresh').addEventListener('click', () => {
  if (currentView.activeRunId) void pollRun(currentView.activeRunId);
});
$('#run-history').addEventListener('click', (event) => {
  const button = event.target.closest('[data-run-id]');
  if (!button) return;
  currentView.activeRunId = button.dataset.runId;
  currentView.activeRunFromHistory = true;
  currentView.importedFile = null;
  setChatContext(null);
  location.hash = '#workbench';
  void pollRun(currentView.activeRunId);
});
loadData().catch((error) => {
  currentView.apiAvailable = false;
  setApiStatus();
  $('#experiment-provenance').textContent = `页面数据加载失败：${error?.message || '未知错误'}。请确认本地服务已启动。`;
  renderRunHistory(null);
}).finally(() => { $('#dataset-file').disabled = false; });
