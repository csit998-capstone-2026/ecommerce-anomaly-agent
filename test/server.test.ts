import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import test from 'node:test';
import { makeFixture } from '../src/data/fixtures.ts';
import { buildDashboard, createAppRequestHandler, handleAppRequest, readJsonBody } from '../src/server.ts';
import { diagnoseFixture, diagnoseWithTools } from '../src/agent/diagnose.ts';

type CapturedResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
  json(): Record<string, any>;
};

function makeRequest(method: string, url: string, body?: string | Buffer,
  headers: Record<string, string> = {}): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [body]);
  return Object.assign(stream, {
    method, url,
    headers: { host: '127.0.0.1:4173', ...headers },
  }) as unknown as IncomingMessage;
}

async function invoke(method: string, url: string, body?: string | Buffer,
  headers: Record<string, string> = {},
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> = handleAppRequest,
): Promise<CapturedResponse> {
  const captured: CapturedResponse = {
    status: 0, headers: {}, body: '',
    json() { return JSON.parse(this.body); },
  };
  const response = {
    writeHead(status: number, responseHeaders: Record<string, string>) {
      captured.status = status;
      captured.headers = responseHeaders;
      return this;
    },
    end(chunk?: string | Buffer) {
      captured.body = chunk === undefined ? '' : Buffer.from(chunk).toString('utf8');
      return this;
    },
  } as unknown as ServerResponse;
  await handler(makeRequest(method, url, body, headers), response);
  return captured;
}

async function invokeRun(handler: ReturnType<typeof createAppRequestHandler>, method: string,
  url: string, dataset = exampleDataset()): Promise<CapturedResponse> {
  return invoke(method, url, method === 'POST' ? JSON.stringify(dataset) : undefined,
    method === 'POST' ? { 'content-type': 'application/json' } : {}, handler);
}

async function ask(handler: ReturnType<typeof createAppRequestHandler>, message: string,
  runId?: string): Promise<CapturedResponse> {
  return invoke('POST', '/api/assistant/messages', JSON.stringify({ message, ...(runId ? { runId } : {}) }),
    { 'content-type': 'application/json', origin: 'http://127.0.0.1:4173' }, handler);
}

async function waitForRun(handler: ReturnType<typeof createAppRequestHandler>, runId: string,
  status: string): Promise<Record<string, any>> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = (await invokeRun(handler, 'GET', `/api/runs/${runId}`)).json();
    if (result.status === status && (status !== 'completed' || result.finishedAt !== null)) return result;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Run ${runId} did not reach ${status}`);
}

function exampleDataset() {
  const fixture = makeFixture('stockout', 0);
  return { diagnosisCase: fixture.diagnosisCase, observations: fixture.observations };
}

test('local read endpoints and static page return scoped responses without binding a socket', async () => {
  const health = await invoke('GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.json().mode, 'read-only-diagnosis');
  assert.equal(health.headers['x-content-type-options'], 'nosniff');

  const cases = await invoke('GET', '/api/cases');
  assert.equal(cases.status, 200);
  assert.equal(cases.json().synthetic, true);
  assert.ok(cases.json().cases.length > 0);

  const dashboard = await invoke('GET', '/api/dashboard');
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.json().synthetic, true);
  assert.ok(Array.isArray(dashboard.json().trace));

  const page = await invoke('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /^text\/html/);
  assert.match(page.body, /电商经营异常诊断/);
});

test('dashboard daily series preserves consistent values and exposes source conflicts', async () => {
  const report = await diagnoseFixture(makeFixture('stockout', 0));
  const original = report.observations.find(item => item.metric === 'units_sold' && item.status === 'ok')!;
  const missing = { ...original, observationId: 'other-source-missing', source: 'other-source',
    status: 'missing' as const, value: null };
  const partial = buildDashboard({ ...report, observations: [...report.observations, missing] });
  const partialDay = partial.series.find(row => row.date === original.observedDate)!;
  assert.equal(partialDay.units_sold, original.value);
  assert.equal((partialDay.metricStates as Record<string, string>).units_sold, 'partial');

  const conflicting = { ...original, observationId: 'other-source-conflict', source: 'other-source',
    value: original.value! + 3 };
  const conflict = buildDashboard({ ...report, observations: [...report.observations, conflicting] });
  const conflictDay = conflict.series.find(row => row.date === original.observedDate)!;
  assert.equal(conflictDay.units_sold, null);
  assert.equal((conflictDay.metricStates as Record<string, string>).units_sold, 'conflict');
  assert.deepEqual(conflictDay.conflictedMetrics, ['units_sold']);
  assert.equal(conflict.sources.find(item => item.source === 'other-source')?.conflicts, 1);

  const agreeing = { ...original, observationId: 'other-source-agree', source: 'other-source' };
  const consistent = buildDashboard({ ...report, observations: [...report.observations, agreeing] });
  assert.equal(consistent.series.find(row => row.date === original.observedDate)!.units_sold, original.value);
});

test('dataset preflight reports scoped coverage and conflicts without running or echoing raw data', async () => {
  let diagnoses = 0;
  const handler = createAppRequestHandler({ diagnose: async (...args) => {
    diagnoses++;
    return diagnoseWithTools(...args);
  } });
  try {
    const dataset = exampleDataset();
    const baseDay = dataset.diagnosisCase.baselineWindow.start;
    const anomalyDay = dataset.diagnosisCase.anomalyWindow.start;
    const originalSales = dataset.observations.find(row =>
      row.metric === 'units_sold' && row.observedDate === baseDay)!;
    const originalTraffic = dataset.observations.find(row =>
      row.metric === 'visitors' && row.observedDate === baseDay)!;
    const originalAnomalyTraffic = dataset.observations.find(row =>
      row.metric === 'visitors' && row.observedDate === anomalyDay)!;
    const sensitive = 'private-customer-record-7391';
    const submitted = {
      ...dataset,
      provenance: sensitive,
      observations: [
        ...dataset.observations,
        { ...originalSales, observationId: 'conflict-extra', source: sensitive,
          value: originalSales.value! + 5 },
        { ...originalTraffic, observationId: 'missing-extra', source: 'missing-feed',
          status: 'missing' as const, value: null, sourceUpdatedAt: null },
        { ...originalAnomalyTraffic, observationId: 'error-extra', source: 'error-feed',
          status: 'error' as const, value: null, sourceUpdatedAt: null, error: sensitive },
      ],
    };
    const response = await invokeRun(handler, 'POST', '/api/datasets/validate', submitted);
    assert.equal(response.status, 200, response.body);
    const summary = response.json();
    assert.equal(summary.valid, true);
    assert.deepEqual(summary.scope, {
      storeId: dataset.diagnosisCase.storeId,
      skuId: dataset.diagnosisCase.skuId,
      baselineWindow: dataset.diagnosisCase.baselineWindow,
      anomalyWindow: dataset.diagnosisCase.anomalyWindow,
    });
    assert.equal(summary.observationCount, dataset.observations.length + 3);
    const sales = summary.metrics.find((item: Record<string, any>) => item.metric === 'units_sold');
    const traffic = summary.metrics.find((item: Record<string, any>) => item.metric === 'visitors');
    assert.deepEqual([sales.valid, sales.missing, sales.error], [15, 0, 0]);
    assert.deepEqual([sales.baseline.validDays, sales.baseline.totalDays, sales.baseline.coverageRatio],
      [7, 7, 1]);
    assert.deepEqual([traffic.valid, traffic.missing, traffic.error], [14, 1, 1]);
    assert.deepEqual([traffic.baseline.missing, traffic.anomaly.error], [1, 1]);
    assert.equal(summary.conflicts.count, 1);
    assert.equal(summary.conflicts.byMetric.units_sold, 1);
    assert.deepEqual(summary.conflicts.examples, [
      { metric: 'units_sold', date: baseDay, sourceCount: 2 },
    ]);
    assert.doesNotMatch(response.body, /private-customer-record-7391|sourceUpdatedAt|fetchedAt|observationId|"value"/);
    assert.equal(diagnoses, 0);
    assert.equal((await invokeRun(handler, 'GET', '/api/runs')).json().count, 0);
  } finally { handler.stop(); }
});

test('the fixed example endpoint serves a complete synthetic BusinessDataset and is GET-only', async () => {
  const handler = createAppRequestHandler();
  try {
    const response = await invokeRun(handler, 'GET', '/api/datasets/example');
    assert.equal(response.status, 200, response.body);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.match(response.headers['content-type'], /^application\/json/);
    const dataset = response.json();
    assert.equal(dataset.synthetic, true);
    assert.equal(dataset.provenance, 'synthetic-example');
    assert.deepEqual(dataset.diagnosisCase, makeFixture('stockout', 0).diagnosisCase);
    assert.equal(dataset.observations.length, makeFixture('stockout', 0).observations.length);
    const validated = await invokeRun(handler, 'POST', '/api/datasets/validate', dataset);
    assert.equal(validated.status, 200, validated.body);
    assert.equal(validated.json().valid, true);
    const wrongMethod = await invokeRun(handler, 'POST', '/api/datasets/example');
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.allow, 'GET');
    assert.equal((await invokeRun(handler, 'GET', '/api/datasets/example?path=private.json')).status, 400);
  } finally { handler.stop(); }
});

test('dataset preflight reuses upload media, size, origin, and safe validation errors', async () => {
  const handler = createAppRequestHandler();
  try {
    const body = JSON.stringify(exampleDataset());
    assert.equal((await invoke('GET', '/api/datasets/validate', undefined, {}, handler)).status, 405);
    assert.equal((await invoke('POST', '/api/datasets/validate', body,
      { 'content-type': 'text/plain' }, handler)).status, 415);
    assert.equal((await invoke('POST', '/api/datasets/validate', body,
      { 'content-type': 'application/json', origin: 'https://evil.example' }, handler)).status, 403);
    assert.equal((await invoke('POST', '/api/datasets/validate', body,
      { 'content-type': 'application/json', 'content-length': String(1024 * 1024 + 1) }, handler)).status, 413);
    const invalid = await invoke('POST', '/api/datasets/validate',
      JSON.stringify({ ...exampleDataset(), observations: [{ secret: 'private-customer-record-7391' }] }),
      { 'content-type': 'application/json' }, handler);
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json().error, 'Invalid business dataset');
    assert.doesNotMatch(invalid.body, /private-customer-record-7391/);
  } finally { handler.stop(); }
});

test('assistant status and guide disclose local-report mode without a model or raw message echo', async () => {
  const handler = createAppRequestHandler();
  try {
    const status = await invoke('GET', '/api/assistant/status', undefined, {}, handler);
    assert.equal(status.status, 200);
    assert.equal(status.json().mode, 'local-report');
    assert.equal(status.json().modelConfigured, false);
    assert.match(status.json().description, /未接入大模型/);
    assert.equal((await invoke('POST', '/api/assistant/status', '{}', {}, handler)).status, 405);
    assert.equal((await invoke('GET', '/api/assistant/messages', undefined, {}, handler)).status, 405);
    const guide = await ask(handler, 'private-user-prompt-7391');
    assert.equal(guide.status, 200);
    assert.equal(guide.json().mode, 'local-report');
    assert.match(guide.json().answer, /先选择示例或上传经营数据/);
    assert.deepEqual(guide.json().referenceIds, []);
    assert.doesNotMatch(guide.body, /private-user-prompt-7391/);
    const upload = await ask(handler, '如何上传经营数据？');
    assert.equal(upload.status, 200);
    assert.match(upload.json().answer, /CSV/);
    assert.match(upload.json().answer, /数据预检/);
    const topics = await ask(handler, '诊断完成后可以问哪些问题？');
    assert.equal(topics.status, 200);
    assert.match(topics.json().answer, /候选原因/);
    assert.match(topics.json().answer, /证据/);
    assert.equal((await invoke('POST', '/api/assistant/messages', '{}',
      { 'content-type': 'text/plain' }, handler)).status, 415);
    assert.equal((await invoke('POST', '/api/assistant/messages', '{}',
      { 'content-type': 'application/json', origin: 'https://other.example' }, handler)).status, 403);
    const tooLong = await ask(handler, 'x'.repeat(2001));
    assert.equal(tooLong.status, 400);
    assert.doesNotMatch(tooLong.body, /xxxxxx/);
    assert.equal((await ask(handler, '   ')).status, 400);
    assert.equal((await ask(handler, '原因？', 'run-invalid')).status, 400);
    assert.equal((await invoke('POST', '/api/assistant/messages', '{}', {
      'content-type': 'application/json', 'content-length': String(1024 * 1024 + 1),
    }, handler)).status, 413);
  } finally { handler.stop(); }
});

test('assistant answers only from a completed local run and cites its report evidence', async () => {
  const handler = createAppRequestHandler();
  const other = createAppRequestHandler();
  try {
    const accepted = await invokeRun(handler, 'POST', '/api/runs');
    const runId = accepted.json().runId;
    const completed = await waitForRun(handler, runId, 'completed');
    const answer = await ask(handler, '销量下降的原因是什么？', runId);
    assert.equal(answer.status, 200, answer.body);
    assert.equal(answer.json().mode, 'local-report');
    assert.match(answer.json().answer, /缺货/);
    assert.match(answer.json().answer, /因果概率/);
    const validIds = new Set([
      ...completed.report.evidence.map((item: Record<string, any>) => item.evidenceId),
      ...completed.report.observations.map((item: Record<string, any>) => item.observationId),
    ]);
    assert.ok(answer.json().referenceIds.length > 0);
    assert.ok(answer.json().referenceIds.every((id: string) => validIds.has(id)));
    assert.equal((await ask(other, '原因？', runId)).status, 404);
    assert.equal((await ask(handler, '原因？', 'run-00000000-0000-0000-0000-000000000000')).status, 404);
  } finally { handler.stop(); other.stop(); }
});

test('assistant does not echo user-controlled observation IDs or an unsupported cause', async () => {
  const handler = createAppRequestHandler();
  try {
    const secret = 'private-observation-id-7391';
    const base = exampleDataset();
    const dataset = { ...base, observations: base.observations.map(row => ({
      ...row, observationId: `${secret}:${row.metric}:${row.observedDate}`,
    })) };
    const accepted = await invokeRun(handler, 'POST', '/api/runs', dataset);
    const runId = accepted.json().runId;
    await waitForRun(handler, runId, 'completed');
    const evidence = await ask(handler, '有哪些证据？', runId);
    assert.equal(evidence.status, 200);
    assert.ok(evidence.json().referenceIds.every((id: string) => id.startsWith('ev-')));
    assert.doesNotMatch(evidence.body, /private-observation-id-7391/);

    const weak = makeFixture('insufficient', 0);
    const weakRun = (await invokeRun(handler, 'POST', '/api/runs', {
      diagnosisCase: weak.diagnosisCase, observations: weak.observations,
    })).json().runId;
    const completed = await waitForRun(handler, weakRun, 'completed');
    assert.notEqual(completed.report.verification.status, 'supported');
    const answer = await ask(handler, '销量下降的原因是什么？', weakRun);
    assert.equal(answer.status, 200);
    assert.match(answer.json().answer, /不能确定/);
    assert.doesNotMatch(answer.json().answer, /报告将“.*”列为优先排查/);
  } finally { handler.stop(); }
});

test('import preserves omitted, true, and false synthetic declarations separately', async () => {
  for (const declared of [undefined, true, false] as const) {
    const dataset = { ...exampleDataset(),
      ...(declared === undefined ? {} : { synthetic: declared }),
      provenance: 'fixture-for-test' };
    const result = await invoke('POST', '/api/diagnose-dataset', JSON.stringify(dataset), {
      'content-type': 'application/json; charset=utf-8',
      origin: 'http://127.0.0.1:4173',
    });
    assert.equal(result.status, 200, result.body);
    const parsed = result.json();
    assert.equal(parsed.dashboard.synthetic, declared ?? null);
    assert.equal(parsed.report.synthetic, declared ?? null);
    assert.equal(parsed.dashboard.sourceDeclaration.synthetic, declared ?? null);
    assert.equal(parsed.report.sourceDeclaration.synthetic, declared ?? null);
    assert.equal(parsed.sourceDeclaration.provenance, 'fixture-for-test');
    assert.equal(parsed.sourceDeclaration.authenticated, false);
    assert.equal(parsed.dashboard.run.skuId, dataset.diagnosisCase.skuId);
    assert.ok(parsed.dashboard.causes.length > 0);
  }
  const noProvenance = await invoke('POST', '/api/diagnose-dataset', JSON.stringify(exampleDataset()), {
    'content-type': 'application/json',
  });
  assert.equal(noProvenance.status, 200);
  assert.equal(noProvenance.json().sourceDeclaration.provenance, null);
  assert.equal(noProvenance.json().dashboard.provenance, 'unverified-user-json');
});

test('import reports 415, 400, and 413 for media type, JSON, dataset, and size errors', async () => {
  const goodBody = JSON.stringify(exampleDataset());
  assert.equal((await invoke('POST', '/api/diagnose-dataset', goodBody, {
    'content-type': 'text/plain',
  })).status, 415);
  assert.equal((await invoke('POST', '/api/diagnose-dataset', '{', {
    'content-type': 'application/json',
  })).status, 400);
  assert.equal((await invoke('POST', '/api/diagnose-dataset', '{}', {
    'content-type': 'application/json',
  })).status, 400);
  assert.equal((await invoke('POST', '/api/diagnose-dataset', goodBody, {
    'content-type': 'application/json', 'content-length': String(1024 * 1024 + 1),
  })).status, 413);
  assert.equal((await invoke('POST', '/api/diagnose-dataset', Buffer.alloc(1024 * 1024 + 1), {
    'content-type': 'application/json',
  })).status, 413);
});

test('request body reader times out on an unfinished upload', async () => {
  const stream = Object.assign(new Readable({ read() {} }), {
    headers: { 'content-type': 'application/json' },
  }) as unknown as IncomingMessage;
  await assert.rejects(readJsonBody(stream, 10), (error: Error & { status?: number }) =>
    error.status === 408 && /timed out/.test(error.message));
  stream.destroy();
});

test('host, origin, method, and caseId boundaries return explicit status codes', async () => {
  assert.equal((await invoke('GET', '/api/health', undefined, { host: 'evil.example' })).status, 400);
  const crossOrigin = await invoke('POST', '/api/diagnose-dataset', JSON.stringify(exampleDataset()), {
    'content-type': 'application/json', origin: 'https://evil.example',
  });
  assert.equal(crossOrigin.status, 403);
  const wrongMethod = await invoke('GET', '/api/diagnose-dataset');
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, 'POST');
  assert.equal((await invoke('GET', '/api/dashboard?caseId=')).status, 400);
  assert.equal((await invoke('GET', '/api/dashboard?caseId=a&caseId=b')).status, 400);
  assert.equal((await invoke('GET', '/api/dashboard?caseId=unknown')).status, 404);
  assert.equal((await invoke('GET', '/not-a-route')).status, 404);
});

test('run API exposes queued, running, and completed states with scoped report and provenance', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const handler = createAppRequestHandler({ maxConcurrent: 1,
    diagnose: async (...args) => { await gate; return diagnoseWithTools(...args); },
  });
  try {
    const dataset = { ...exampleDataset(), synthetic: false, provenance: 'user-supplied-test' };
    const accepted = await invokeRun(handler, 'POST', '/api/runs', dataset);
    assert.equal(accepted.status, 202);
    const { runId, statusUrl } = accepted.json();
    assert.match(runId, /^run-[0-9a-f-]{36}$/);
    assert.equal(accepted.headers.location, statusUrl);
    assert.equal(accepted.json().status, 'queued');
    assert.equal(accepted.json().ephemeral, true);
    assert.match(accepted.json().retention, /restart/);
    assert.deepEqual(accepted.json().sourceDeclaration, {
      synthetic: false, provenance: 'user-supplied-test', authenticated: false,
    });
    const running = await waitForRun(handler, runId, 'running');
    assert.equal(running.report, undefined);
    assert.equal(running.dashboard, undefined);
    assert.equal((await ask(handler, '原因？', runId)).status, 409);
    assert.equal((await invokeRun(handler, 'GET', `/api/runs/${runId}/report`)).status, 409);
    const listed = await invokeRun(handler, 'GET', '/api/runs');
    assert.equal(listed.status, 200);
    assert.equal(listed.json().count, 1);
    assert.equal(listed.json().runs[0].runId, runId);
    release();
    const completed = await waitForRun(handler, runId, 'completed');
    assert.equal(completed.report.synthetic, false);
    assert.equal(completed.dashboard.synthetic, false);
    assert.deepEqual(completed.report.sourceDeclaration, completed.sourceDeclaration);
    assert.deepEqual(completed.dashboard.sourceDeclaration, completed.sourceDeclaration);
    assert.equal(completed.dashboard.run.caseId, dataset.diagnosisCase.caseId);
    const download = await invokeRun(handler, 'GET', `/api/runs/${runId}/report`);
    assert.equal(download.status, 200);
    assert.match(download.headers['content-disposition'], /^attachment; filename="diagnosis-report-run-/);
    assert.equal(download.headers['cache-control'], 'no-store');
    assert.equal(download.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(download.json(), completed.report);
    assert.equal((await invokeRun(handler, 'GET', '/api/runs/run-00000000-0000-0000-0000-000000000000/report')).status, 404);
    assert.equal((await invokeRun(handler, 'POST', `/api/runs/${runId}/report`)).status, 405);
  } finally { release(); handler.stop(); }
});

test('run API keeps omitted, true, and false provenance declarations distinct', async () => {
  const handler = createAppRequestHandler({ maxRecords: 3 });
  try {
    for (const declared of [undefined, true, false] as const) {
      const dataset = { ...exampleDataset(),
        ...(declared === undefined ? {} : { synthetic: declared }),
      };
      const accepted = await invokeRun(handler, 'POST', '/api/runs', dataset);
      assert.equal(accepted.status, 202);
      assert.equal(accepted.json().sourceDeclaration.synthetic, declared ?? null);
      const completed = await waitForRun(handler, accepted.json().runId, 'completed');
      assert.equal(completed.report.synthetic, declared ?? null);
      assert.equal(completed.dashboard.synthetic, declared ?? null);
      assert.equal(completed.sourceDeclaration.authenticated, false);
    }
  } finally { handler.stop(); }
});

test('run API applies import validation, capacity, completed eviction, and store isolation', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started = 0;
  const handler = createAppRequestHandler({ maxRecords: 2, maxConcurrent: 1,
    diagnose: async (...args) => {
      started++;
      if (started === 1) await gate;
      return diagnoseWithTools(...args);
    },
  });
  const other = createAppRequestHandler();
  try {
    const invalid = await invoke('POST', '/api/runs', '{}', { 'content-type': 'application/json' }, handler);
    assert.equal(invalid.status, 400);
    assert.equal((await invoke('POST', '/api/runs', '{}', {
      'content-type': 'text/plain',
    }, handler)).status, 415);
    const first = (await invokeRun(handler, 'POST', '/api/runs')).json().runId;
    await waitForRun(handler, first, 'running');
    const second = (await invokeRun(handler, 'POST', '/api/runs')).json().runId;
    assert.equal((await invokeRun(handler, 'GET', `/api/runs/${second}`)).json().status, 'queued');
    assert.equal((await invokeRun(handler, 'POST', '/api/runs')).status, 429);
    assert.equal((await invokeRun(other, 'GET', `/api/runs/${first}`)).status, 404);
    assert.equal((await invokeRun(other, 'GET', '/api/runs')).json().count, 0);
    release();
    await waitForRun(handler, first, 'completed');
    const third = await invokeRun(handler, 'POST', '/api/runs');
    assert.equal(third.status, 202);
    assert.equal((await invokeRun(handler, 'GET', `/api/runs/${first}`)).status, 404);
    assert.equal((await invokeRun(handler, 'GET', '/api/runs')).json().count, 2);
  } finally { release(); handler.stop(); other.stop(); }
});

test('failed runs expose a safe message, and stopping prevents queued runs from starting', async () => {
  const failing = createAppRequestHandler({ diagnose: async () => {
    throw new Error('private customer data and stack details');
  } });
  try {
    const runId = (await invokeRun(failing, 'POST', '/api/runs')).json().runId;
    const failed = await waitForRun(failing, runId, 'failed');
    assert.equal(typeof failed.error, 'string');
    assert.doesNotMatch(JSON.stringify(failed), /private customer data|stack details/);
    assert.equal(failed.report, undefined);
    assert.equal(failed.dashboard, undefined);
    assert.equal((await invokeRun(failing, 'GET', `/api/runs/${runId}/report`)).status, 409);
  } finally { failing.stop(); }

  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started = 0;
  const handler = createAppRequestHandler({ maxConcurrent: 1,
    diagnose: async (...args) => {
      started++;
      if (started === 1) await gate;
      return diagnoseWithTools(...args);
    },
  });
  try {
    const first = (await invokeRun(handler, 'POST', '/api/runs')).json().runId;
    await waitForRun(handler, first, 'running');
    const second = (await invokeRun(handler, 'POST', '/api/runs')).json().runId;
    handler.stop();
    const cancelled = await waitForRun(handler, second, 'failed');
    assert.match(cancelled.error, /服务已关闭/);
    assert.equal((await invokeRun(handler, 'POST', '/api/runs')).status, 503);
    release();
    await waitForRun(handler, first, 'completed');
    assert.equal(started, 1);
  } finally { release(); handler.stop(); }
});
