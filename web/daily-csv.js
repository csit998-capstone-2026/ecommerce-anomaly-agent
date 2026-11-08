const METRIC_UNITS = Object.freeze({
  units_sold: 'items',
  paid_orders: 'orders',
  visitors: 'visitors',
  stock_on_hand: 'items',
  price: 'CNY',
  promotion_active: 'flag',
});

const METRICS = Object.keys(METRIC_UNITS);
const REQUIRED_HEADERS = ['date', ...METRICS];
const COUNT_METRICS = new Set(['units_sold', 'paid_orders', 'visitors', 'stock_on_hand']);

function parseCsv(csvText) {
  if (typeof csvText !== 'string') throw new Error('CSV 内容必须是文本。');
  const text = csvText.startsWith('\uFEFF') ? csvText.slice(1) : csvText;
  const records = [];
  let cells = [];
  let field = '';
  let inQuotes = false;
  let closedQuote = false;
  let line = 1;
  let rowLine = 1;

  function finishField() {
    cells.push(field);
    field = '';
    closedQuote = false;
  }

  function finishRow() {
    finishField();
    if (!(cells.length === 1 && cells[0].trim() === '')) {
      records.push({ cells, line: rowLine });
    }
    cells = [];
  }

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const newline = char === '\n' || char === '\r';
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          inQuotes = false;
          closedQuote = true;
        }
      } else if (newline) {
        field += '\n';
        if (char === '\r' && text[index + 1] === '\n') index++;
        line++;
      } else {
        field += char;
      }
      continue;
    }
    if (closedQuote && char !== ',' && !newline && char !== ' ' && char !== '\t') {
      throw new Error(`CSV 第 ${line} 行：引号结束后只能接逗号或换行。`);
    }
    if (char === ',') {
      finishField();
    } else if (newline) {
      finishRow();
      if (char === '\r' && text[index + 1] === '\n') index++;
      line++;
      rowLine = line;
    } else if (char === '"') {
      if (field !== '') throw new Error(`CSV 第 ${line} 行：双引号必须位于字段开头。`);
      inQuotes = true;
    } else if (!closedQuote) {
      field += char;
    }
  }
  if (inQuotes) throw new Error(`CSV 第 ${rowLine} 行：双引号未闭合。`);
  if (field !== '' || cells.length > 0 || closedQuote) finishRow();
  if (records.length === 0) throw new Error('CSV 为空，请提供表头和至少一行数据。');
  return records;
}

function validDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} 必须为 YYYY-MM-DD 日期。`);
  }
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} 不是有效的日历日期。`);
  }
  return value;
}

function validWindow(window, label) {
  if (!window || typeof window !== 'object') throw new Error(`${label} 必须包含 start 和 end。`);
  const start = validDate(window.start, `${label}.start`);
  const end = validDate(window.end, `${label}.end`);
  if (start > end) throw new Error(`${label} 的开始日期不能晚于结束日期。`);
  return { start, end };
}

function validTimestamp(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} 必须由调用方提供含时区的 ISO 时间。`);
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new Error(`${label} 必须由调用方提供含时区的 ISO 时间。`);
  validDate(match[1], label);
  const [, , hour, minute, second, zone] = match;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 ||
      (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))) {
    throw new Error(`${label} 包含无效的时间或时区。`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${label} 不是有效的时间。`);
  return timestamp;
}

function requiredText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`请提供${label}。`);
  return value.trim();
}

function metricValue(raw, metric, line) {
  const text = raw.trim();
  if (text === '') return null;
  if (!/^\d+(?:\.\d+)?$/.test(text)) {
    throw new Error(`CSV 第 ${line} 行的 ${metric} 必须是非负数，留空才表示缺失。`);
  }
  const value = Number(text);
  if (!Number.isFinite(value) || (COUNT_METRICS.has(metric) && !Number.isInteger(value))) {
    throw new Error(`CSV 第 ${line} 行的 ${metric} 必须是非负${COUNT_METRICS.has(metric) ? '整数' : '数值'}。`);
  }
  if (metric === 'promotion_active' && value !== 0 && value !== 1) {
    throw new Error(`CSV 第 ${line} 行的 promotion_active 只能是 0 或 1。`);
  }
  return value;
}

/** Convert one-store, one-SKU daily CSV into the existing BusinessDataset JSON contract. */
export function buildDatasetFromDailyCsv({
  csvText, storeId, skuId, baselineWindow, anomalyWindow,
  sourceName, sourceUpdatedAt, fetchedAt, synthetic, provenance, caseId,
}) {
  const store = requiredText(storeId, '店铺 ID');
  const sku = requiredText(skuId, '商品 SKU');
  const id = requiredText(caseId, '案例 ID');
  const source = requiredText(sourceName, '数据来源名称');
  const baseline = validWindow(baselineWindow, '基线窗口');
  const anomaly = validWindow(anomalyWindow, '异常窗口');
  if (baseline.end >= anomaly.start) throw new Error('基线窗口和异常窗口不能重叠，且基线必须在异常期之前。');
  const updated = validTimestamp(sourceUpdatedAt, 'sourceUpdatedAt');
  const fetched = validTimestamp(fetchedAt, 'fetchedAt');
  if (updated > fetched) throw new Error('sourceUpdatedAt 不能晚于 fetchedAt。');
  if (synthetic !== undefined && typeof synthetic !== 'boolean') throw new Error('synthetic 必须是布尔值。');
  if (provenance !== undefined) requiredText(provenance, '来源说明 provenance');

  const records = parseCsv(csvText);
  const headers = records[0].cells.map(cell => cell.trim());
  if (new Set(headers).size !== headers.length) throw new Error('CSV 表头存在重复列名。');
  const missingHeaders = REQUIRED_HEADERS.filter(header => !headers.includes(header));
  if (missingHeaders.length) throw new Error(`CSV 缺少必需表头：${missingHeaders.join('、')}。`);
  if (records.length === 1) throw new Error('CSV 只有表头，请至少添加一日数据。');
  const column = Object.fromEntries(REQUIRED_HEADERS.map(header => [header, headers.indexOf(header)]));
  const seenDays = new Set();
  const observations = [];
  for (const record of records.slice(1)) {
    if (record.cells.length !== headers.length) {
      throw new Error(`CSV 第 ${record.line} 行有 ${record.cells.length} 列，表头要求 ${headers.length} 列。`);
    }
    const day = validDate(record.cells[column.date].trim(), `CSV 第 ${record.line} 行 date`);
    if (seenDays.has(day)) throw new Error(`CSV 第 ${record.line} 行日期 ${day} 重复；每行只能代表一天。`);
    seenDays.add(day);
    if (!((day >= baseline.start && day <= baseline.end) ||
          (day >= anomaly.start && day <= anomaly.end))) {
      throw new Error(`CSV 第 ${record.line} 行日期 ${day} 不在基线或异常窗口内。`);
    }
    for (const metric of METRICS) {
      const value = metricValue(record.cells[column[metric]], metric, record.line);
      observations.push({
        schemaVersion: 1,
        observationId: `${id}:${metric}:${day}`,
        caseId: id,
        storeId: store,
        skuId: sku,
        observedDate: day,
        metric,
        value,
        unit: METRIC_UNITS[metric],
        source: `${source}:${metric}`,
        sourceUpdatedAt: value === null ? null : sourceUpdatedAt,
        fetchedAt,
        status: value === null ? 'missing' : 'ok',
      });
    }
  }
  return {
    diagnosisCase: {
      schemaVersion: 1,
      caseId: id,
      storeId: store,
      skuId: sku,
      baselineWindow: baseline,
      anomalyWindow: anomaly,
    },
    observations,
    ...(synthetic === undefined ? {} : { synthetic }),
    ...(provenance === undefined ? {} : { provenance: provenance.trim() }),
  };
}
