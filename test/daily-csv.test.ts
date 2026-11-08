import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import test from 'node:test';
import { buildDatasetFromDailyCsv } from '../web/daily-csv.js';
import { validateBusinessDataset } from '../src/data/json-tools.ts';
import { handleAppRequest } from '../src/server.ts';

const HEADER = 'date,units_sold,paid_orders,visitors,stock_on_hand,price,promotion_active';

function options(csvText: string) {
  return {
    csvText,
    storeId: 'store-A',
    skuId: 'sku-123',
    caseId: 'case-001',
    baselineWindow: { start: '2026-10-01', end: '2026-10-07' },
    anomalyWindow: { start: '2026-10-08', end: '2026-10-14' },
    sourceName: 'merchant-export',
    sourceUpdatedAt: '2026-10-14T23:30:00+08:00',
    fetchedAt: '2026-10-15T09:00:00+08:00',
    synthetic: false,
    provenance: 'merchant-declared-export',
  };
}

test('daily CSV with BOM, CRLF, quoted commas and escaped quotes maps to the BusinessDataset contract', () => {
  const csv = '\uFEFF"date","units_sold","paid_orders","visitors","stock_on_hand","price","promotion_active","note"\r\n' +
    '"2026-10-01","10","9","100","0","19.50","1","campaign, starts"\r\n' +
    '"2026-10-08","0","0","","0","20","0","promotion ""ended"""\r\n';
  const dataset = buildDatasetFromDailyCsv(options(csv));
  assert.deepEqual(dataset.diagnosisCase, {
    schemaVersion: 1,
    caseId: 'case-001',
    storeId: 'store-A',
    skuId: 'sku-123',
    baselineWindow: { start: '2026-10-01', end: '2026-10-07' },
    anomalyWindow: { start: '2026-10-08', end: '2026-10-14' },
  });
  assert.equal(dataset.synthetic, false);
  assert.equal(dataset.provenance, 'merchant-declared-export');
  assert.equal(dataset.observations.length, 12);
  const zero = dataset.observations.find((row: any) => row.metric === 'units_sold' &&
    row.observedDate === '2026-10-08');
  const missing = dataset.observations.find((row: any) => row.metric === 'visitors' &&
    row.observedDate === '2026-10-08');
  const price = dataset.observations.find((row: any) => row.metric === 'price' &&
    row.observedDate === '2026-10-01');
  assert.deepEqual([zero.value, zero.status, zero.unit], [0, 'ok', 'items']);
  assert.deepEqual([missing.value, missing.status, missing.sourceUpdatedAt], [null, 'missing', null]);
  assert.deepEqual([price.value, price.unit], [19.5, 'CNY']);
  assert.ok(dataset.observations.every((row: any) => row.source === `merchant-export:${row.metric}`));
  assert.ok(dataset.observations.every((row: any) => row.fetchedAt === options(csv).fetchedAt));
  assert.equal(new Set(dataset.observations.map((row: any) => row.observationId)).size, 12);
  assert.deepEqual(validateBusinessDataset(dataset), dataset);
});

test('missing, invalid, and extra CSV fields get understandable errors', () => {
  assert.throws(() => buildDatasetFromDailyCsv(options('date,units_sold\n2026-10-01,10')),
    /缺少必需表头/);
  assert.throws(() => buildDatasetFromDailyCsv(options(`${HEADER}\n2026-10-01,10,9,100,20,19.5`)),
    /要求 7 列/);
  assert.throws(() => buildDatasetFromDailyCsv(options(`${HEADER}\n"2026-10-01,10,9,100,20,19.5,1`)),
    /双引号未闭合/);
  assert.throws(() => buildDatasetFromDailyCsv(options(`${HEADER}\n2026-10-01,10,9,100,20,19.5,1\n2026-10-01,10,9,100,20,19.5,1`)),
    /日期 .* 重复/);
  assert.throws(() => buildDatasetFromDailyCsv(options(`${HEADER}\n2026-10-15,10,9,100,20,19.5,1`)),
    /不在基线或异常窗口内/);
  assert.throws(() => buildDatasetFromDailyCsv(options(`${HEADER}\n2026-10-01,-1,9,100,20,19.5,1`)),
    /units_sold 必须是非负数/);
  assert.throws(() => buildDatasetFromDailyCsv(options(`${HEADER}\n2026-10-01,1.5,9,100,20,19.5,1`)),
    /units_sold 必须是非负整数/);
  assert.throws(() => buildDatasetFromDailyCsv(options(`${HEADER}\n2026-10-01,10,9,100,20,19.5,2`)),
    /promotion_active 只能是 0 或 1/);
});

test('time and scope metadata must be supplied rather than invented from CSV rows', () => {
  const csv = `${HEADER}\n2026-10-01,10,9,100,20,19.5,1`;
  assert.throws(() => buildDatasetFromDailyCsv({ ...options(csv), sourceUpdatedAt: '' }),
    /sourceUpdatedAt .*含时区/);
  assert.throws(() => buildDatasetFromDailyCsv({ ...options(csv), fetchedAt: '2026-10-15T09:00:00' }),
    /fetchedAt .*含时区/);
  assert.throws(() => buildDatasetFromDailyCsv({ ...options(csv),
    sourceUpdatedAt: '2026-10-16T09:00:00+08:00' }),
  /sourceUpdatedAt 不能晚于 fetchedAt/);
  assert.throws(() => buildDatasetFromDailyCsv({ ...options(csv), caseId: '' }), /案例 ID/);
  assert.throws(() => buildDatasetFromDailyCsv({ ...options(csv),
    anomalyWindow: { start: '2026-10-07', end: '2026-10-14' } }), /不能重叠/);
});

test('the server serves the fixed browser CSV module with a no-store JavaScript response', async () => {
  const request = Object.assign(Readable.from([]), {
    method: 'GET', url: '/daily-csv.js', headers: { host: '127.0.0.1:4173' },
  }) as unknown as IncomingMessage;
  let status = 0;
  let headers: Record<string, string> = {};
  let body = '';
  const response = {
    writeHead(code: number, values: Record<string, string>) {
      status = code;
      headers = values;
      return this;
    },
    end(value?: string | Buffer) {
      body = value === undefined ? '' : Buffer.from(value).toString('utf8');
      return this;
    },
  } as unknown as ServerResponse;
  await handleAppRequest(request, response);
  assert.equal(status, 200);
  assert.match(headers['content-type'], /^text\/javascript/);
  assert.equal(headers['cache-control'], 'no-store');
  assert.match(body, /export function buildDatasetFromDailyCsv/);
});
