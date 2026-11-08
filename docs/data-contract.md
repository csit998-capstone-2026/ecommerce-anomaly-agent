# 经营数据接入格式

系统第一阶段每次只诊断一个店铺、一个 SKU、两个不重叠的连续时间窗。可通过 `npm run diagnose -- path/to/dataset.json` 在命令行运行，或在本机页面使用每日 CSV 表单、上传完整 JSON；服务端只在内存里处理上传内容，不写入项目文件。

完整示例：[`../examples/synthetic-stockout.json`](../examples/synthetic-stockout.json)。该示例是合成数据，`caseId` 为不包含原因名称的标识；真实案例也应避免让 ID、文件名或数据源名称暴露人工标注答案。

```json
{
  "provenance": "user-declared-commerce-export",
  "synthetic": false,
  "diagnosisCase": {
    "schemaVersion": 1,
    "caseId": "case-001",
    "storeId": "store-A",
    "skuId": "sku-123",
    "baselineWindow": { "start": "2026-09-01", "end": "2026-09-07" },
    "anomalyWindow": { "start": "2026-09-08", "end": "2026-09-14" }
  },
  "observations": []
}
```

每条 `observations[]` 必填：`schemaVersion`、唯一 `observationId`、同一个 `caseId/storeId/skuId`、`observedDate`、`metric`、`value`、`unit`、`source`、`sourceUpdatedAt`、`fetchedAt`、`status`。日期窗口端点包含当日；逐日数据推荐覆盖每个窗口的大部分日期。

| metric | 含义 | unit | 典型来源 |
| --- | --- | --- | --- |
| `units_sold` | 成交商品件数 | `items` | 商品销售明细 |
| `paid_orders` | 已支付订单数 | `orders` | 订单报表 |
| `visitors` | 商品访客数 | `visitors` | 流量报表 |
| `stock_on_hand` | 当日可售库存快照 | `items` | 库存系统 |
| `price` | 商品展示/成交口径价格，须保持口径一致 | `CNY` | 商品价格记录 |
| `promotion_active` | 促销是否有效，0 或 1 | `flag` | 活动配置 |

## 每日 CSV 导入映射

页面可将单店、单 SKU 的每日 CSV 转成上述 JSON。CSV 必须包含表头 `date,units_sold,paid_orders,visitors,stock_on_hand,price,promotion_active`；可有额外列，额外列不会进入诊断数据。每行代表一个唯一日期，日期须在基线或异常窗口内；支持 UTF-8 BOM、CRLF 换行、带逗号的双引号字段和 `""` 转义。示例：

```csv
date,units_sold,paid_orders,visitors,stock_on_hand,price,promotion_active
2026-09-01,22,20,210,60,90,1
2026-09-08,0,0,,0,90,1
```

空白指标单元格映射为 `status: "missing", value: null`，实测 `0` 保留为 `status: "ok", value: 0`。销量、订单、访客和库存必须是非负整数，价格是非负数，促销标记只能为 0 或 1。每条记录按上表填写 `unit`；同一 CSV 的指标来源标为调用方填写的 `sourceName:metric`，例如 `shop-export:visitors`。

CSV 本身不包含店铺 ID、SKU、案例 ID、两个日期窗口和来源时间；调用方必须另行提供 `storeId`、`skuId`、`caseId`、`baselineWindow`、`anomalyWindow`、`sourceName`、`sourceUpdatedAt` 与 `fetchedAt`。两个时间戳必须是含时区的 ISO 时间，`sourceUpdatedAt` 不得晚于 `fetchedAt`。转换器不会推断或伪造来源更新时间；若无法确认，应先取得可靠的导出元数据。`synthetic` 和 `provenance` 为调用方声明，不能当作已认证来源。转换后仍应先调用 `POST /api/datasets/validate` 检查覆盖与冲突，再提交诊断任务。

`status: "ok"` 时 `value` 必须是非负有限数值；销量、订单、访客和库存必须是整数，价格可含小数。真实测得的 0 写 `value: 0`。`status: "missing"` 或 `"error"` 时写 `value: null`；错误状态另填 `error`。不能用 0 代替缺失值。

`sourceUpdatedAt` 和 `fetchedAt` 采用含时区的 ISO 时间戳（如 `2026-09-14T23:30:00Z`），来源更新时间不得晚于抓取时间。同一指标、日期、来源只能有一条记录；不同来源的同日记录可并存，以保留冲突证据。来源和抓取时间用于证据质量判断，上传者声明的 `provenance` 不能由本程序自动认证。

上传响应中的 `sourceDeclaration` 保留 `synthetic` 的三态：`true`、`false`、`null`（未提供声明）。`authenticated` 目前始终为 `false`。多个来源对同日同指标给出不同有效值时，图表序列不选取任意一个值，而是返回 `null` 与 `metricStates[metric]: "conflict"`；诊断算法仍检查这些记录的冲突。

销量、访客、订单、库存、价格和促销的口径应由业务人员核对：是否按支付日还是下单日统计、访客去重方式、库存是日初还是日末、价格是否含优惠券、促销生效时间与时区。口径不一致会让排序和建议失真。真实数据接入先用只读导出或只读 API；不要在数据文件中包含平台密钥、个人信息或客户订单明细。

人工标注的原因标签只放在评测器侧，不能加入 JSON 中供 Agent 查询。算法输出是“优先排查的可能原因”；需要真实经营因果结论时，另需干预或外部对照验证。

结论核验前使用默认 10% 的销量相对降幅作为“异常下降”筛查阈值，可通过 Agent 的 `minSalesDeclineRatio` 调整。它是业务启发式阈值，并非统计显著性或因果检验；不同品类、销量规模和季节性下应重新设定并验证。
