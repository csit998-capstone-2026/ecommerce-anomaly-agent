# 诊断工作台 API

所有接口由本地服务 `http://127.0.0.1:4173` 提供。服务只监听本机，响应禁用缓存；写入型请求只接受本机同源页面或未设置 `Origin` 的本地客户端。上传 JSON 最多 1 MiB。页面的每日 CSV 表单先在浏览器内转换为同一 JSON 契约，再调用下列接口；CSV 列名与业务口径见 [data-contract.md](data-contract.md)。这些接口只查询和诊断，不修改电商平台数据。

| 步骤 | 方法与路径 | 用途 |
| --- | --- | --- |
| 载入演示 | `GET /api/datasets/example` | 返回固定的完整合成数据集，`synthetic: true` |
| 导入预检 | `POST /api/datasets/validate` | 校验 JSON 契约，返回店铺、SKU、窗口、每项指标覆盖率及冲突摘要；不运行 Agent、不保存任务 |
| 开始诊断 | `POST /api/runs` | 接受与预检相同的 JSON，返回 `202`、`runId` 和 `statusUrl` |
| 任务历史 | `GET /api/runs` | 返回当前进程中的最近任务摘要 |
| 查看结果 | `GET /api/runs/{runId}` | 返回 `queued` / `running` / `completed` / `failed`；完成后包含 `dashboard` 和 `report` |
| 下载报告 | `GET /api/runs/{runId}/report` | 完成后下载完整 JSON；未完成返回 409，未知任务返回 404 |
| 问答状态 | `GET /api/assistant/status` | 返回本地问答模式与支持的话题，不触发模型调用 |
| 报告问答 | `POST /api/assistant/messages` | 请求体为 `{ "message": "为什么销量下降？", "runId": "已完成任务的 runId" }`；返回固定模板答案和证据引用 |

示例命令：

```bash
curl -sS -H 'Content-Type: application/json' \
  --data-binary @examples/synthetic-stockout.json \
  http://127.0.0.1:4173/api/datasets/validate

curl -sS -H 'Content-Type: application/json' \
  --data-binary @examples/synthetic-stockout.json \
  http://127.0.0.1:4173/api/runs
```

第二个响应中的 `statusUrl` 可用于轮询。预检只返回汇总，不回显原始销量、来源名称、来源声明或错误文本。诊断报告包含原始观测与证据，因此下载前应确认文件可安全存放。任务、数据和报告仅保留在当前进程的内存中，重启后清空；默认最多 20 条任务，同时运行 2 条。

`sourceDeclaration.synthetic` 仅记录提供者的 `true` / `false` / `null` 声明，`authenticated` 始终为 `false`。输出原因分数用于优先排查，不是经实验确认的因果概率。当前不含店铺平台接入、账号体系、长期存储或自动经营操作。

## 本地报告问答

`POST /api/assistant/messages` 接受 JSON，`message` 为非空字符串（最多 2,000 个字符），`runId` 可省略。省略 `runId` 时可询问 CSV/示例数据导入流程及诊断完成后的可提问范围；其他问法提示先完成诊断。任务不存在返回 404，任务尚未完成或失败返回 409。成功响应格式为 `{ "mode": "local-report", "answer": "…", "referenceIds": ["…"], "suggestions": ["…"] }`。`referenceIds` 仅包含该报告中算法生成的证据编号；可在报告的 `evidence` 中查找该编号及关联观测。用户自定义的观测编号不会在问答中回显。支持询问候选原因、证据、核查建议、数据缺口和概览；其他问法返回概览。未通过 `supported` 核验的报告不会给出确定原因或经营调整建议；通过核验也只提出优先排查方向，排序分数不是因果概率。

问答仅在本地使用结构化报告和固定模板，不读取环境密钥，不调用外部 API 或大模型，也不回显来源名称、用户原消息或原始业务数值。服务只限本机使用；`runId` 是临时任务定位符，**不是用户或租户授权凭证**。当前没有多用户鉴权，不应将该服务直接开放到外网或共享网络。
