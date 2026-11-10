# qqbot 管理后台 API 与页面契约

> 管理页由宿主插件在 DSH Web 服务上注册：页面地址 `http://127.0.0.1:<web端口>/qqbot`（路径取自 `config.admin.path`）。
> 同源策略与 plugin-workbench 相同：只接受同源请求（校验 `Origin`/`Sec-Fetch-Site`），只接受 `POST` API 与 `GET` 静态资源。

## 1. HTTP 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/qqbot` 或 `/qqbot/` | 返回 `host/admin/ui/index.html` |
| GET | `/qqbot/assets/<file>` | 返回 `host/admin/ui/<file>`（仅允许 `app.js`、`style.css`、其它白名单文件） |
| GET | `/qqbot/media/sticker/<id>` | 返回表情包图片文件（由 `stickerStore.filePath` 定位，内容类型按扩展名；`Cache-Control: private, max-age=86400`） |
| POST | `/qqbot/api` | 请求体 `{"method": string, "args": object}`；响应 `{"ok": true, "result": any}` 或 `{"ok": false, "error": string}` |

请求体上限 32 MiB（表情包上传用 base64）。所有 API 都需要同源校验；失败返回 `403`。未知方法返回 `{ok:false,error:'unknown method ...'}`。

## 2. API 方法

### 2.1 只读快照

`snapshot` → args `{}`，返回：

```js
{
  version: '0.2.0',
  dataDir: string,
  configWarnings: string[],
  status: { enabled, hasCredentials, state, bot, sessionId, connectedAt, lastHeartbeatAt, lastInboundAt,
            lastError, sent, received, attempts },
  llm: { provider, model },
  multimodal: { enabled, configured, baseUrl, image:{...}, audio:{...}, video:{...} } | null,
  budget: BudgetSnapshot,          // 见 budget.snapshot
  stickers: { total, byLayer: {library,candidate,negative,trash}, tags: number },
  chats: number,
  people: number,
  serverTime: number
}
```

### 2.2 配置

- `config.get` → `{ config: PublicConfig, warnings: string[] }`。`qq.appSecret` 恒为 `''`，并带 `qq.appSecretMasked`、`qq.hasSecret`；`multimodal.apiKey` 同样只返回空串 + `multimodal.apiKeyMasked` + `multimodal.hasApiKey`。
- `config.save` args `{ patch: object }` → `{ config: PublicConfig, warnings: string[] }`。
  - `patch` 为深层局部覆盖；`qq.appSecret` / `multimodal.apiKey` 留空表示保留原密钥。
  - 保存后插件会按新配置自动重启 QQ 连接（页面可延迟 1s 刷新状态）。

### 2.3 QQ 连接

- `gateway.start` → `{ status }`（无凭据返回 error）
- `gateway.stop` → `{ status }`
- `gateway.reconnect` → `{ status }`
- `gateway.test` → `{ ok: true, bot?, tokenExpiresIn, gatewayUrl }` 或 `{ ok:false, error }`（只测 token + gateway 地址，token 不回显）

### 2.4 LLM 自检

`llm.test` args `{ prompt?: string }` → `{ text, provider, model, usage: {inputTokens,outputTokens,totalTokens} }`；失败返回 `{ok:false,error}`（错误信息由 admin 层包装）。

### 2.4.1 多模态识别自检（可选）

`multimodal.test` → 用内置 1×1 PNG 调用已配置的 OpenAI 兼容视觉接口，返回 `{ text, model, usage, ms }`；
未启用/未配置/接口失败时返回 `{ok:false,error}`。`snapshot` 中的 `multimodal` 字段给出
`{enabled, configured, baseUrl, image:{enabled,configured,model}, audio:{...}, video:{...}}`。
`config` 的 `multimodal.apiKey` 与 `qq.appSecret` 一样只写不读（响应里为空串 + 掩码 + `hasApiKey`）。

### 2.5 预算

- `budget.snapshot` → `{ date, monthKey, today:{calls,inputTokens,outputTokens,totalTokens,cost}, month:{calls,inputTokens,outputTokens,totalTokens,cost}, chats:[{chatId,calls,totalTokens,cost,lastAt}], limits:{...}, currency }`
  （注意：`monthKey` 是 `'YYYY-MM'` 字符串，`month` 是当月用量对象）
- `budget.reset` args `{ scope: 'today'|'month'|'all' }` → 新 snapshot
- `budget.events` args `{ limit?: number }` → `{ events: [{ts,chatId,userId,provider,model,inputTokens,outputTokens,totalTokens,cost}] }`

### 2.6 表情包

- `stickers.list` args `{ layer?, tags?: string[], query?, limit?=60, offset?=0 }` → `{ total, items: StickerItem[] }`
- `stickers.upload` args `{ files: [{name, dataBase64}], tags?: string[], desc?, layer?='candidate' }` → `{ added: StickerItem[], duplicates: StickerItem[], skipped: [{name,reason}], errors: string[] }`
- `stickers.scanDir` args `{}` → `{ files: [{path,name,size}] }`（只扫描 `qqbot/import/`，不导入）
- `stickers.importDir` args `{ tags?: string[], layer? }` → 与 upload 相同的统计结构
- `stickers.update` args `{ id, tags?, desc?, layer? }` → `{ item }`
- `stickers.batchUpdate` args `{ ids: string[], addTags?: string[], removeTags?: string[], layer? }` → `{ updated: number }`
- `stickers.remove` / `stickers.purge` / `stickers.restore` args `{ id }` → `{ item }`
- `stickers.stats` → `{ total, byLayer, tags: [{tag,count}] }`（最多 100 个标签）

`StickerItem` 字段：`id, hash, ext, size, layer, tags, desc, useCount, createdAt, updatedAt, lastUsedAt?, source?`。

### 2.7 会话与记忆

- `chats.list` args `{ query? }` → `{ chats: [{chatId,title,kind,messageCount,userMessages,lastAt,summaryChars,factsCount}] }`
- `chats.get` args `{ chatId }` → `{ chat: {id, title, history: ChatMessage[], summary, facts, counters}, persona: object|null, members: [{id,name,facts,messageCount,updatedAt}] }`（群聊成员按发言者 ID 的长期事实；单聊可为空数组）
- `chats.clear` args `{ chatId, keepFacts?: true }` → `{ ok: true }`
- `chats.compress` args `{ chatId }` → `{ compressed, removed, summary?, error? }`
- `chats.extract` args `{ chatId }` → `{ extracted, facts: string[] }`
- `chats.persona.set` args `{ chatId, patch }` → `{ persona }`
- `chats.persona.delete` args `{ chatId }` → `{ ok: true }`
- `people.list` → `{ people: [{id,name,facts,messageCount,lastSeen}] }`
- `people.set` args `{ openid, patch: {name?, addFacts?} }` → `{ person }`
- `persona.users.set` args `{ userId, patch }` / `persona.users.delete` args `{ userId }`
- `persona.list` → `{ chats, users }`

### 2.8 日志

- `logs.recent` args `{ limit?=200, level? }` → `{ entries: [{ts,level,msg,detail?}] }`

## 3. 页面要求（host/admin/ui/）

单页应用，纯 HTML/CSS/原生 JS，**不得引入任何第三方库或 CDN**；不访问 Harness 的 React/模块加载器（这是独立页面，不是 DSH Client 插件）。要求：

1. 顶部固定标题栏：标题「QQ Bot 控制台」+ 数据目录 + **「← 退出工作台」按钮** + 刷新按钮 + 连接状态徽标。
   退出按钮分三种宿主：嵌入 DSH 应用内（iframe）时向父页面 `postMessage({type:'qqbot-console-exit'})`，
   由父面板切回会话界面（不重载 APP）；独立子窗口（window.name=`qqbot-console` 或存在 opener）调用 `window.close()`；
   普通标签页优先 `history.back()`，没有历史时 `location.assign('/')` 跳回 DSH；无弹窗时按 Esc 也可退出。
2. 左侧/顶部 Tab：**概览 / 配置 / 表情包 / 预算 / 会话 / 人员 / 日志**。
3. **概览**：状态卡片（QQ 状态、机器人名、模型、预算今日用量/限额进度条、表情包统计、会话数）；按钮：启动/停止/重连、测试 QQ 凭证、测试 LLM（显示返回文本与耗时）；配置警告列表。
4. **配置**：分区表单（QQ 接入、LLM、多模态识别、人设、预算、记忆与压缩、表情包、命令与管理员、日志），保存按钮 + 恢复默认提示；AppSecret / 多模态 API Key 显示掩码，输入留空不改；保存后 toast。
5. **表情包**：最关键页面。
   - 工具栏：图层 Tab（全部/正式库/候选/负面/回收站，带数量）、搜索框（标签/描述/id）、标签筛选 chips、「扫描 import 目录」按钮、上传文件按钮（`<input type=file multiple accept=image/*>`，转 base64 提交）。
   - 网格卡片：缩略图（`/qqbot/media/sticker/<id>`）、勾选框、id、图层徽标、标签 chips、使用次数；点击卡片打开右侧/弹层编辑：图片预览、标签输入（逗号分隔 + 已有标签 chips 可点选）、描述、图层下拉、保存/删除。
   - 批量操作：全选/反选；批量改图层、批量加标签、批量移入回收站、批量删除（确认）。
   - 导入结果用 toast 展示 added/duplicates/skipped 数量。
6. **预算**：今日本月用量卡片、限额进度、按会话表格（chatId/tokens/cost/lastAt）、最近调用表格（时间/chatId/模型/tokens/cost），重置今日/本月按钮（二次确认）。
7. **会话**：左侧列表 + 右侧详情；详情展示历史（role/content/时间）、摘要、事实、覆盖人设表单（JSON 字段用表单：名字/系统提示/风格/表情频率/模型），按钮：压缩、抽取记忆、清空上下文。
8. **人员**：表格（openid/昵称/消息数/最近出现/事实数）；可编辑昵称与追加事实。
9. **日志**：级别筛选 + 刷新 + 自动滚动；每条显示时间/级别/内容。
10. 通用：所有请求走 `POST /qqbot/api`；`fetch(..., {headers:{'content-type':'application/json'}, body: JSON.stringify({method,args})})`；错误 toast；操作中按钮禁用；深色/浅色主题用 `prefers-color-scheme`；移动端可用（网格自适应）。
11. 页面 JS 必须语法正确（`node --check host/admin/ui/app.js`）；不使用 `eval`；对 API 返回做空值防御。

## 4. 文件

- `host/admin/ui/index.html`（页面骨架 + 引入 assets）
- `host/admin/ui/app.js`（全部交互，允许一个文件，约 600-1200 行）
- `host/admin/ui/style.css`
