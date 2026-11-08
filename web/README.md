# 中文实验工作台

零依赖的静态 HTML/CSS/JavaScript 页面。项目 HTTP 服务把 `web/` 作为静态目录，并提供下列接口：

- `GET /api/dashboard`：单店、单 SKU 诊断运行。期望 `{ provenance, synthetic, run, series, causes, evidence, sources, trace }`。`run` 至少提供 `storeId`、`skuId`、`baselineWindow`、`anomalyWindow`、`verification`、`recommendation`。`series` 每行用 `date`、`units_sold`、`visitors`，可选 `stock_on_hand`、`price`、`promotion_active`。若序列中有缺失值，前端不会把它作为 0 绘制。
- `GET /api/evaluations/latest`：最近一次五模块评测。期望 `{ provenance, synthetic, generatedAt, dataset, modules, cases, stress }`。`dataset` 可为名称或 `{total, development, holdout}`。每个模块的 `metrics[0]` 是表格主指标，字段为 `{ name, unit, better: "higher" | "lower", baseline, full }`，消融值可放在该指标的 `ablation` 字段或当前评测脚本的 `module.ablations` 对象中；如果缺少消融值，页面会显示“未提供”。百分数默认用 0–100 数值，`unit: "ratio"` 会按 0–1 比例显示成百分数。案例表兼容实验脚本的 `{gold: Cause[], fullCause, fullStatus, fullCorrect, fullQueries}`。`stress` 为固定手工压力检查 `{sampleCount, passRate, cases}`，与业务准确率分开展示。
- `GET /api/evaluations/cases.csv`：下载生成的合成评测案例明细。仅当评测接口提供非演示案例时，页面显示下载入口；服务端尚未运行评测则返回 404。
- `POST /api/diagnose-dataset`：浏览器导入单店单 SKU 的 JSON 数据。请求正文为 `{diagnosisCase, observations, synthetic?, provenance?}`，返回 `{dashboard, report}`；页面仅使用 `dashboard` 更新诊断视图，保留当前评测视图。文件和请求正文均限 1 MiB，服务端验证案例、观察值和 ID 范围；诊断只读且不保存导入文件。可从仓库的 [`examples/synthetic-stockout.json`](../examples/synthetic-stockout.json) 开始试用。

当接口不可用或返回格式不完整时，页面按接口分别回退到 [`data/demo.json`](./data/demo.json)，顶部和实验区域均会标明“界面演示数据 · 非实验结果”。接口若返回 `synthetic: true`，页面会标出合成数据；带 `generatedAt` 的评测接口会标为“合成测试集 · 程序评测结果”，与本地演示值区分。压力检查通过率只表示固定边界探针的通过比例，不是诊断准确率。导入文件的 `provenance` 和 `synthetic` 均为上传者声明，页面会明确标识其未经独立核验。

运行完整服务请在仓库根目录执行 `npm run dev`，访问服务输出的本地地址。独立查看界面可运行 `python3 -m http.server 8765 --directory web` 并访问 `http://127.0.0.1:8765/`；此时 API 不存在，页面会明确显示本地演示数据，文件导入也会提示接口错误。页面无外部 CDN、远程字体或第三方前端代码依赖。

图表的销量与访客曲线各自按本窗口最大值缩放，纵轴表示相对强度；悬停或键盘聚焦数据点可查看实际数值。原因排序的分数仅用于候选原因比较，不是因果概率。页面显示的“实验复核清单”不表示这些条件已经通过验证。
