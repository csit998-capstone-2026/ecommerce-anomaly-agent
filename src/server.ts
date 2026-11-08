import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { getFixture, makeCorpus } from './data/fixtures.ts';
import { diagnoseFixture, diagnoseWithTools, type DiagnosisReport } from './agent/diagnose.ts';
import { createJsonReadOnlyTools, validateBusinessDataset, type BusinessDataset } from './data/json-tools.ts';
import { METRIC_UNITS, type DateWindow, type Metric, type Observation } from './domain/contracts.ts';
import { answerFromReport } from './assistant/local-report.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_ROOT = path.join(ROOT, 'web');
const MAX_JSON_BYTES = 1024 * 1024;
const RUN_RETENTION = 'memory-only; lost on server restart';
const RUN_FAILURE_MESSAGE = '诊断任务失败，请检查数据或稍后重试。';
const RESPONSE_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

class HttpRequestError extends Error {
  readonly status: number;
  readonly allow?: string;
  constructor(status: number, message: string, allow?: string) {
    super(message);
    this.status = status;
    this.allow = allow;
  }
}

function isMissingFile(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

function sendJson(response: ServerResponse, status: number, value: unknown,
  extraHeaders: Record<string, string> = {}): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    ...RESPONSE_HEADERS,
    ...extraHeaders,
    ...(status >= 400 ? { connection: 'close' } : {}),
  });
  response.end(JSON.stringify(value));
}

function requireLocalHost(request: IncomingMessage): string {
  const header = request.headers.host;
  if (typeof header !== 'string' || !/^(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/i.test(header)) {
    throw new HttpRequestError(400, 'A single local Host header is required');
  }
  let host: URL;
  try { host = new URL(`http://${header}`); }
  catch { throw new HttpRequestError(400, 'Invalid Host header'); }
  if (!['127.0.0.1', 'localhost'].includes(host.hostname) || host.username || host.password ||
      host.pathname !== '/' || host.search || host.hash) {
    throw new HttpRequestError(403, 'Only local hosts are accepted');
  }
  return host.host;
}

function requireSameOriginForPost(request: IncomingMessage, expectedHost: string): void {
  const header = request.headers.origin;
  if (header === undefined) return; // CLI clients need not send Origin.
  if (typeof header !== 'string') throw new HttpRequestError(403, 'Cross-origin requests are not accepted');
  let origin: URL;
  try { origin = new URL(header); }
  catch { throw new HttpRequestError(403, 'Cross-origin requests are not accepted'); }
  if (origin.protocol !== 'http:' || origin.host !== expectedHost || origin.pathname !== '/' ||
      origin.search || origin.hash) {
    throw new HttpRequestError(403, 'Cross-origin requests are not accepted');
  }
}

export function buildDashboard(report: DiagnosisReport) {
  const byDay = new Map<string, Map<Metric, DiagnosisReport['observations']>>();
  for (const observation of report.observations) {
    const metrics = byDay.get(observation.observedDate) ?? new Map();
    const records = metrics.get(observation.metric) ?? [];
    records.push(observation);
    metrics.set(observation.metric, records);
    byDay.set(observation.observedDate, metrics);
  }
  const conflictedPairs = new Set<string>();
  const series = [...byDay.entries()].map(([date, metrics]) => {
    const row: Record<string, unknown> = { date };
    const metricStates: Record<string, string> = {};
    const conflictedMetrics: Metric[] = [];
    for (const [metric, records] of metrics) {
      const values = new Set(records.filter(item => item.status === 'ok').map(item => item.value));
      if (values.size > 1) {
        row[metric] = null;
        metricStates[metric] = 'conflict';
        conflictedMetrics.push(metric);
        conflictedPairs.add(`${date}\0${metric}`);
      } else if (values.size === 1) {
        row[metric] = values.values().next().value;
        metricStates[metric] = records.some(item => item.status !== 'ok') ? 'partial' : 'ok';
      } else {
        row[metric] = null;
        metricStates[metric] = records.some(item => item.status === 'error') ? 'error' : 'missing';
      }
    }
    row.metricStates = metricStates;
    if (conflictedMetrics.length) row.conflictedMetrics = conflictedMetrics;
    return row;
  }).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const sources = [...new Set(report.observations.map(item => item.source))].map(source => {
    const records = report.observations.filter(item => item.source === source);
    return {
      source, metric: records[0]?.metric as Metric | undefined,
      records: records.length,
      missing: records.filter(item => item.status !== 'ok').length,
      conflicts: records.filter(item => conflictedPairs.has(`${item.observedDate}\0${item.metric}`)).length,
      latestUpdate: records.map(item => item.sourceUpdatedAt).filter(Boolean).sort().at(-1) ?? null,
    };
  });
  return {
    provenance: report.provenance,
    synthetic: report.synthetic,
    run: {
      caseId: report.diagnosisCase.caseId,
      storeId: report.diagnosisCase.storeId,
      skuId: report.diagnosisCase.skuId,
      baselineWindow: report.diagnosisCase.baselineWindow,
      anomalyWindow: report.diagnosisCase.anomalyWindow,
      verification: report.verification,
      recommendation: report.recommendation,
      queryCount: report.queriedMetrics.length,
      queriedMetrics: report.queriedMetrics,
      repairRounds: report.repairRounds,
    },
    series,
    causes: report.ranking.map(item => {
      const support = report.evidence.find(evidence =>
        item.supportEvidenceIds.includes(evidence.evidenceId));
      const contradiction = report.evidence.find(evidence =>
        item.contradictionEvidenceIds.includes(evidence.evidenceId));
      return {
        ...item,
        explanation: support?.explanation ??
          (contradiction ? `反对证据：${contradiction.explanation}` :
            item.missingMetrics.length ? `仍缺少：${item.missingMetrics.join('、')}` : '暂无可用证据'),
      };
    }),
    evidence: report.evidence,
    sources,
    trace: report.trace,
    context: report.context,
    contextBudgetTokens: report.contextBudgetTokens,
  };
}

type RunStatus = 'queued' | 'running' | 'completed' | 'failed';
type SourceDeclaration = { synthetic: boolean | null; provenance: string | null; authenticated: false };
type DiagnoseRunner = typeof diagnoseWithTools;

interface RunRecord {
  runId: string;
  status: RunStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  caseId: string;
  storeId: string;
  skuId: string;
  sourceDeclaration: SourceDeclaration;
  dataset?: BusinessDataset;
  report?: DiagnosisReport & { sourceDeclaration: SourceDeclaration };
  dashboard?: ReturnType<typeof buildDashboard> & { sourceDeclaration: SourceDeclaration };
  error?: string;
}

export interface RunStoreOptions {
  maxRecords?: number;
  maxConcurrent?: number;
  diagnose?: DiagnoseRunner;
}

function declarationOf(dataset: BusinessDataset): SourceDeclaration {
  return {
    synthetic: dataset.synthetic ?? null,
    provenance: dataset.provenance ?? null,
    authenticated: false,
  };
}

const BUSINESS_METRICS = Object.keys(METRIC_UNITS) as Metric[];

function windowDays(window: DateWindow): number {
  return Math.round((Date.parse(`${window.end}T00:00:00Z`) -
    Date.parse(`${window.start}T00:00:00Z`)) / 86_400_000) + 1;
}

function windowValidationSummary(rows: Observation[], window: DateWindow) {
  const inWindow = rows.filter(row => row.observedDate >= window.start && row.observedDate <= window.end);
  const valid = inWindow.filter(row => row.status === 'ok');
  const totalDays = windowDays(window);
  const validDays = new Set(valid.map(row => row.observedDate)).size;
  return {
    valid: valid.length,
    missing: inWindow.filter(row => row.status === 'missing').length,
    error: inWindow.filter(row => row.status === 'error').length,
    validDays,
    totalDays,
    coverageRatio: validDays / totalDays,
  };
}

/** Preflight statistics only; raw values, source names, provenance, and error text stay out. */
function buildDatasetValidationSummary(dataset: BusinessDataset) {
  const { diagnosisCase, observations } = dataset;
  const metrics = BUSINESS_METRICS.map(metric => {
    const rows = observations.filter(row => row.metric === metric);
    const baseline = windowValidationSummary(rows, diagnosisCase.baselineWindow);
    const anomaly = windowValidationSummary(rows, diagnosisCase.anomalyWindow);
    return {
      metric,
      valid: baseline.valid + anomaly.valid,
      missing: baseline.missing + anomaly.missing,
      error: baseline.error + anomaly.error,
      baseline,
      anomaly,
    };
  });
  const byDayMetric = new Map<string, {
    metric: Metric; date: string; sources: Set<string>; values: Set<number>;
  }>();
  for (const row of observations) {
    if (row.status !== 'ok' || row.value === null) continue;
    const key = JSON.stringify([row.metric, row.observedDate]);
    const group = byDayMetric.get(key) ?? {
      metric: row.metric, date: row.observedDate, sources: new Set<string>(), values: new Set<number>(),
    };
    group.sources.add(row.source);
    group.values.add(row.value);
    byDayMetric.set(key, group);
  }
  const conflicting = [...byDayMetric.values()]
    .filter(group => group.sources.size > 1 && group.values.size > 1)
    .sort((a, b) => a.date.localeCompare(b.date) || a.metric.localeCompare(b.metric));
  const byMetric = Object.fromEntries(BUSINESS_METRICS.map(metric =>
    [metric, conflicting.filter(group => group.metric === metric).length])) as Record<Metric, number>;
  const examples = conflicting.slice(0, 20).map(group => ({
    metric: group.metric, date: group.date, sourceCount: group.sources.size,
  }));
  return {
    valid: true,
    scope: {
      storeId: diagnosisCase.storeId,
      skuId: diagnosisCase.skuId,
      baselineWindow: diagnosisCase.baselineWindow,
      anomalyWindow: diagnosisCase.anomalyWindow,
    },
    observationCount: observations.length,
    metrics,
    conflicts: { count: conflicting.length, byMetric, examples,
      truncated: conflicting.length > examples.length },
  };
}

function summarizeRun(record: RunRecord) {
  return {
    runId: record.runId,
    status: record.status,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    caseId: record.caseId,
    storeId: record.storeId,
    skuId: record.skuId,
    sourceDeclaration: record.sourceDeclaration,
  };
}

function createRunStore(options: RunStoreOptions = {}) {
  const maxRecords = options.maxRecords ?? 20;
  const maxConcurrent = options.maxConcurrent ?? 2;
  if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 100 ||
      !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > maxRecords) {
    throw new Error('Invalid run store capacity');
  }
  const diagnose = options.diagnose ?? diagnoseWithTools;
  const records: RunRecord[] = [];
  let active = 0;
  let scheduled = false;
  let stopped = false;

  function schedule(): void {
    if (stopped || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (stopped) return;
      while (active < maxConcurrent) {
        const record = records.find(item => item.status === 'queued');
        if (!record) break;
        record.status = 'running';
        record.startedAt = new Date().toISOString();
        active++;
        const dataset = record.dataset!;
        void Promise.resolve().then(() => diagnose(
          dataset.diagnosisCase, createJsonReadOnlyTools(dataset), {
            synthetic: dataset.synthetic,
            provenance: dataset.provenance ?? 'unverified-user-json',
          })).then(report => {
          record.dashboard = { ...buildDashboard(report), sourceDeclaration: record.sourceDeclaration };
          record.report = { ...report, sourceDeclaration: record.sourceDeclaration };
          record.finishedAt = new Date().toISOString();
          record.status = 'completed';
        }).catch(error => {
          record.finishedAt = new Date().toISOString();
          record.status = 'failed';
          record.report = undefined;
          record.dashboard = undefined;
          record.error = RUN_FAILURE_MESSAGE;
          console.error('Async diagnosis failed:', error instanceof Error ? error.name : 'UnknownError');
        }).finally(() => {
          record.dataset = undefined;
          active--;
          schedule();
        });
      }
    });
  }

  return {
    submit(dataset: BusinessDataset) {
      if (stopped) throw new HttpRequestError(503, 'Run service is stopping');
      if (records.length >= maxRecords) {
        const finished = records
          .map((record, index) => ({ record, index }))
          .filter(({ record }) => record.status === 'completed' || record.status === 'failed')
          .sort((a, b) => String(a.record.finishedAt).localeCompare(String(b.record.finishedAt)) || a.index - b.index)[0];
        if (!finished) throw new HttpRequestError(429, 'Run capacity is full; retry after an active run finishes');
        records.splice(finished.index, 1);
      }
      const record: RunRecord = {
        runId: `run-${randomUUID()}`,
        status: 'queued',
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        caseId: dataset.diagnosisCase.caseId,
        storeId: dataset.diagnosisCase.storeId,
        skuId: dataset.diagnosisCase.skuId,
        sourceDeclaration: declarationOf(dataset),
        dataset,
      };
      records.push(record);
      schedule();
      return {
        ...summarizeRun(record),
        statusUrl: `/api/runs/${record.runId}`,
        ephemeral: true,
        retention: RUN_RETENTION,
      };
    },
    list() {
      return {
        runs: records.toReversed().map(summarizeRun),
        count: records.length,
        maxRecords,
        ephemeral: true,
        retention: RUN_RETENTION,
      };
    },
    get(runId: string) {
      const record = records.find(item => item.runId === runId);
      if (!record) return null;
      return {
        ...summarizeRun(record),
        ephemeral: true,
        retention: RUN_RETENTION,
        ...(record.status === 'completed' ? { report: record.report, dashboard: record.dashboard } : {}),
        ...(record.status === 'failed' ? { error: record.error } : {}),
      };
    },
    stop() {
      stopped = true;
      for (const record of records) {
        if (record.status !== 'queued') continue;
        record.status = 'failed';
        record.error = '服务已关闭，任务未执行。';
        record.finishedAt = new Date().toISOString();
        record.dataset = undefined;
      }
    },
  };
}

type RunStore = ReturnType<typeof createRunStore>;
const standaloneRunStore = createRunStore();

export function readJsonBody(request: IncomingMessage, timeoutMs = 10_000): Promise<unknown> {
  const contentType = request.headers['content-type'];
  if (typeof contentType !== 'string' || contentType.split(';', 1)[0]!.trim().toLowerCase() !== 'application/json') {
    throw new HttpRequestError(415, 'Expected application/json request body');
  }
  const contentLength = request.headers['content-length'];
  if (contentLength !== undefined &&
      (typeof contentLength !== 'string' || !/^\d+$/.test(contentLength))) {
    throw new HttpRequestError(400, 'Invalid Content-Length');
  }
  if (contentLength !== undefined && Number(contentLength) > MAX_JSON_BYTES) {
    throw new HttpRequestError(413, 'Dataset exceeds 1 MiB limit');
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let finished = false;
    const timer = setTimeout(() => finish(new HttpRequestError(408, 'Request body timed out')), timeoutMs);
    function finish(error?: Error, value?: unknown): void {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      request.off('close', onClose);
      if (error) {
        request.pause();
        reject(error);
      } else resolve(value);
    }
    function onData(chunk: Buffer | string): void {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += part.length;
      if (bytes > MAX_JSON_BYTES) return finish(new HttpRequestError(413, 'Dataset exceeds 1 MiB limit'));
      chunks.push(part);
    }
    function onEnd(): void {
      if (contentLength !== undefined && bytes !== Number(contentLength)) {
        return finish(new HttpRequestError(400, 'Content-Length does not match request body'));
      }
      try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { finish(new HttpRequestError(400, 'Invalid JSON request body')); }
    }
    function onError(): void { finish(new HttpRequestError(400, 'Request body could not be read')); }
    function onClose(): void { finish(new HttpRequestError(400, 'Request body ended unexpectedly')); }
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    request.once('close', onClose);
    request.resume();
  });
}

async function readBusinessDataset(request: IncomingMessage): Promise<BusinessDataset> {
  const raw = await readJsonBody(request);
  try { return validateBusinessDataset(raw); }
  catch {
    // Validation errors may embed user-supplied identifiers; keep them out of HTTP responses.
    throw new HttpRequestError(400, 'Invalid business dataset');
  }
}

async function readAssistantMessage(request: IncomingMessage): Promise<{ runId?: string; message: string }> {
  const raw = await readJsonBody(request);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HttpRequestError(400, 'Expected an object with message and optional runId');
  }
  const input = raw as Record<string, unknown>;
  if (typeof input.message !== 'string' || !input.message.trim() ||
      input.message.length > 4_000 || [...input.message].length > 2_000) {
    throw new HttpRequestError(400, 'Message must contain 1 to 2000 characters');
  }
  if (input.runId !== undefined &&
      (typeof input.runId !== 'string' || !/^run-[0-9a-f-]{36}$/.test(input.runId))) {
    throw new HttpRequestError(400, 'Invalid runId');
  }
  return { message: input.message.trim(),
    ...(input.runId === undefined ? {} : { runId: input.runId as string }) };
}

function assistantGuide(message: string) {
  const question = message.normalize('NFKC').toLowerCase();
  let answer: string;
  if (/可以问|问哪些|能问|问什么|范围|功能|帮助|help|topic/.test(question)) {
    answer = '诊断完成后可以询问：销量下降的候选原因、支持与反对证据、优先核查步骤，以及数据缺口。当前仅提供本地结构化报告问答，尚未连接大模型。';
  } else if (/上传|导入|csv|示例|数据/.test(question)) {
    answer = '可先载入固定合成示例，或上传每日 CSV/JSON。CSV 需填写店铺、SKU、基线与异常窗口及真实来源更新时间；先做数据预检，再创建诊断任务。任务完成后即可询问报告。当前尚未连接大模型。';
  } else {
    answer = '当前是本地结构化报告问答，尚未连接大模型。请先选择示例或上传经营数据并创建诊断任务，等待任务完成后再提问。';
  }
  return {
    mode: 'local-report' as const,
    answer,
    referenceIds: [] as string[],
    suggestions: ['如何上传经营数据？', '诊断完成后可以问哪些问题？'],
  };
}

async function serveFile(requestPath: string, response: ServerResponse): Promise<void> {
  const routes: Record<string, { file: string; contentType: string }> = {
    '/': { file: 'index.html', contentType: 'text/html; charset=utf-8' },
    '/index.html': { file: 'index.html', contentType: 'text/html; charset=utf-8' },
    '/app.js': { file: 'app.js', contentType: 'text/javascript; charset=utf-8' },
    '/daily-csv.js': { file: 'daily-csv.js', contentType: 'text/javascript; charset=utf-8' },
    '/styles.css': { file: 'styles.css', contentType: 'text/css; charset=utf-8' },
    '/data/demo.json': { file: 'data/demo.json', contentType: 'application/json; charset=utf-8' },
  };
  const route = routes[requestPath];
  if (!route) return sendJson(response, 404, { error: 'Not found' });
  try {
    const body = await readFile(path.join(WEB_ROOT, route.file));
    response.writeHead(200, { 'content-type': route.contentType, ...RESPONSE_HEADERS });
    response.end(body);
  } catch (error) {
    if (isMissingFile(error)) sendJson(response, 404, { error: 'File not found' });
    else throw error;
  }
}

export async function handleAppRequest(request: IncomingMessage, response: ServerResponse,
  runStore: RunStore = standaloneRunStore): Promise<void> {
  try {
    const localHost = requireLocalHost(request);
    const target = request.url ?? '/';
    if (!target.startsWith('/') || target.startsWith('//')) {
      throw new HttpRequestError(400, 'Invalid request target');
    }
    const url = new URL(target, 'http://localhost');

    if (url.pathname === '/api/assistant/status') {
      if (request.method !== 'GET') throw new HttpRequestError(405, 'Method not allowed', 'GET');
      return sendJson(response, 200, {
        mode: 'local-report',
        modelConfigured: false,
        description: '本地结构化报告问答；尚未接入大模型 API。',
        supportedTopics: ['销量下降的候选原因', '证据依据', '经营建议', '数据缺口'],
      });
    }
    if (url.pathname === '/api/assistant/messages') {
      if (request.method !== 'POST') throw new HttpRequestError(405, 'Method not allowed', 'POST');
      requireSameOriginForPost(request, localHost);
      if (url.searchParams.size) throw new HttpRequestError(400, 'Assistant endpoint does not accept query parameters');
      const { runId, message } = await readAssistantMessage(request);
      if (!runId) {
        return sendJson(response, 200, assistantGuide(message));
      }
      const run = runStore.get(runId);
      if (!run) return sendJson(response, 404, { error: 'Run not found' });
      if (run.status !== 'completed' || !run.report) {
        return sendJson(response, 409, { error: 'Diagnosis report is not available yet' });
      }
      return sendJson(response, 200, answerFromReport(run.report, message));
    }
    if (url.pathname === '/api/datasets/example') {
      if (request.method !== 'GET') throw new HttpRequestError(405, 'Method not allowed', 'GET');
      if (url.searchParams.size) throw new HttpRequestError(400, 'Example endpoint does not accept query parameters');
      const raw = JSON.parse(await readFile(path.join(ROOT, 'examples', 'synthetic-stockout.json'), 'utf8'));
      const dataset = validateBusinessDataset(raw);
      if (dataset.synthetic !== true) throw new Error('Bundled example must be marked synthetic');
      return sendJson(response, 200, dataset);
    }
    if (url.pathname === '/api/datasets/validate') {
      if (request.method !== 'POST') throw new HttpRequestError(405, 'Method not allowed', 'POST');
      requireSameOriginForPost(request, localHost);
      if (url.searchParams.size) throw new HttpRequestError(400, 'Validation endpoint does not accept query parameters');
      const dataset = await readBusinessDataset(request);
      return sendJson(response, 200, buildDatasetValidationSummary(dataset));
    }
    if (url.pathname === '/api/diagnose-dataset') {
      if (request.method !== 'POST') throw new HttpRequestError(405, 'Method not allowed', 'POST');
      requireSameOriginForPost(request, localHost);
      if (url.searchParams.size) throw new HttpRequestError(400, 'Import endpoint does not accept query parameters');
      const dataset = await readBusinessDataset(request);
      const report = await diagnoseWithTools(
        dataset.diagnosisCase, createJsonReadOnlyTools(dataset), {
          synthetic: dataset.synthetic,
          provenance: dataset.provenance ?? 'unverified-user-json',
        });
      const sourceDeclaration = declarationOf(dataset);
      return sendJson(response, 200, {
        dashboard: { ...buildDashboard(report), sourceDeclaration },
        report: { ...report, sourceDeclaration },
        sourceDeclaration,
      });
    }
    if (url.pathname === '/api/runs') {
      if (request.method === 'POST') {
        requireSameOriginForPost(request, localHost);
        if (url.searchParams.size) throw new HttpRequestError(400, 'Run creation does not accept query parameters');
        const dataset = await readBusinessDataset(request);
        const accepted = runStore.submit(dataset);
        return sendJson(response, 202, accepted, { location: accepted.statusUrl });
      }
      if (request.method !== 'GET') throw new HttpRequestError(405, 'Method not allowed', 'GET, POST');
      return sendJson(response, 200, runStore.list());
    }
    if (url.pathname.startsWith('/api/runs/') && url.pathname.endsWith('/report')) {
      if (request.method !== 'GET') throw new HttpRequestError(405, 'Method not allowed', 'GET');
      const runId = url.pathname.slice('/api/runs/'.length, -'/report'.length);
      if (!/^run-[0-9a-f-]{36}$/.test(runId)) return sendJson(response, 404, { error: 'Run not found' });
      const run = runStore.get(runId);
      if (!run) return sendJson(response, 404, { error: 'Run not found' });
      if (run.status !== 'completed' || !run.report) {
        return sendJson(response, 409, { error: 'Report is available only after a run completes' });
      }
      return sendJson(response, 200, run.report, {
        'content-disposition': `attachment; filename="diagnosis-report-${runId}.json"`,
      });
    }
    if (url.pathname.startsWith('/api/runs/')) {
      if (request.method !== 'GET') throw new HttpRequestError(405, 'Method not allowed', 'GET');
      const runId = url.pathname.slice('/api/runs/'.length);
      if (!/^run-[0-9a-f-]{36}$/.test(runId)) return sendJson(response, 404, { error: 'Run not found' });
      const run = runStore.get(runId);
      return run ? sendJson(response, 200, run) : sendJson(response, 404, { error: 'Run not found' });
    }
    if (request.method !== 'GET') throw new HttpRequestError(405, 'Method not allowed', 'GET');
    if (url.pathname === '/api/health') return sendJson(response, 200, { status: 'ok', mode: 'read-only-diagnosis' });
    if (url.pathname === '/api/cases') return sendJson(response, 200, {
      provenance: 'synthetic-fixture', synthetic: true,
      cases: makeCorpus().map(item => ({
        caseId: item.diagnosisCase.caseId,
        scenario: item.scenario,
        split: item.split,
      })),
    });
    if (url.pathname === '/api/evaluations/latest') {
      let body: string;
      try { body = await readFile(path.join(ROOT, 'eval', 'results', 'latest.json'), 'utf8'); }
      catch (error) {
        if (!isMissingFile(error)) throw error;
        return sendJson(response, 200, {
          provenance: 'not-run', synthetic: true, generatedAt: null, modules: [], cases: [],
        });
      }
      return sendJson(response, 200, JSON.parse(body));
    }
    if (url.pathname === '/api/evaluations/cases.csv') {
      let body: Buffer;
      try { body = await readFile(path.join(ROOT, 'eval', 'results', 'case-results.csv')); }
      catch (error) {
        if (!isMissingFile(error)) throw error;
        return sendJson(response, 404, { error: 'Run npm run eval first' });
      }
      response.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="case-results.csv"',
        ...RESPONSE_HEADERS,
      });
      response.end(body);
      return;
    }
    if (url.pathname === '/api/dashboard' || url.pathname === '/api/diagnose') {
      const supplied = url.searchParams.getAll('caseId');
      if (supplied.length > 1 || supplied.some(id => !id.trim() || id.length > 128)) {
        throw new HttpRequestError(400, 'Supply one nonempty caseId of at most 128 characters');
      }
      const caseId = supplied[0] ?? makeCorpus()[0]!.diagnosisCase.caseId;
      const fixture = getFixture(caseId);
      if (!fixture) return sendJson(response, 404, { error: 'Unknown synthetic case' });
      const report = await diagnoseFixture(fixture);
      return sendJson(response, 200, url.pathname === '/api/dashboard' ? buildDashboard(report) : report);
    }
    return serveFile(url.pathname, response);
  } catch (error) {
    if (error instanceof HttpRequestError) return sendJson(response, error.status, { error: error.message },
      error.allow ? { allow: error.allow } : {});
    console.error('HTTP request failed:', error instanceof Error ? error.name : 'UnknownError');
    return sendJson(response, 500, { error: 'Internal server error' });
  }
}

export function createAppRequestHandler(options: RunStoreOptions = {}) {
  const runStore = createRunStore(options);
  const handler = (request: IncomingMessage, response: ServerResponse) =>
    handleAppRequest(request, response, runStore);
  return Object.assign(handler, { stop: () => runStore.stop() });
}

export function createAppServer() {
  const handler = createAppRequestHandler();
  const server = createServer((request, response) => { void handler(request, response); });
  server.on('close', handler.stop);
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number.parseInt(process.env.PORT ?? '4173', 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT');
  createAppServer().listen(port, '127.0.0.1', () => {
    process.stdout.write(`E-commerce diagnosis service: http://127.0.0.1:${port}\n`);
  });
}
