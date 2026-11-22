# qqbot 管理后台 API 与页面契约

> 管理页由宿主插件在 DSH Web 服务上注册：页面地址 `http://127.0.0.1:<web端口>/qqbot`（路径取自 `config.admin.path`）。
> 同源策略与 plugin-workbench 相同：只接受同源请求（校验 `Origin`/`Sec-Fetch-Site`），只接受 `POST` API 与 `GET` 静态资源。

## 1. HTTP 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/qqbot` 或 `/qqbot/` | 返回 `host/admin/ui/index.html` |
| GET | `/qqbot/assets/<file>` | 返回 `host/admin/ui/<file>`（仅允许 `app.js`、`style.css`、其它白名单文件） |
| GET | `/qqbot/media/sticker/<id>` | 返回表情包图片文件（由 `stickerStore.filePath` 定位，内容类型按扩展名；`Cache-Control: private, max-age=86400`） |
| GET/HEAD | `/qqbot/media/output/<id>` | 返回生成的图片 / 音频 / 视频；Content-Type 取索引中的 mime；支持单段 `Range`（`206` + `Content-Range`），便于音视频拖动播放 |
| GET/HEAD | `/qqbot/media/reference/<id>` | 返回上传的角色形象参考图（图片类型取索引中的 mime） |
| POST | `/qqbot/api` | 请求体 `{"method": string, "args": object}`；响应 `{"ok": true, "result": any}` 或 `{"ok": false, "error": string}` |

请求体上限 32 MiB（表情包上传用 base64）。所有 API 都需要同源校验；失败返回 `403`。未知方法返回 `{ok:false,error:'unknown method ...'}`。

## 2. API 方法

### 2.1 只读快照

`snapshot` → args `{}`，返回：

```js
{
  version: '0.3.0',
  dataDir: string,
  configWarnings: string[],
  status: { enabled, hasCredentials, state, bot, sessionId, connectedAt, lastHeartbeatAt, lastInboundAt,
            lastError, sent, received, attempts },
  llm: { provider, model },
  multimodal: { enabled, configured, baseUrl, image:{...}, audio:{...}, video:{...} } | null,
  output: { enabled, sendToQQ, commandAccess, allowModelDirectives,
            image:{enabled,configured,model,baseUrl,requestUrl,reference:{enabled,configured,id,trigger,requestMode}},...},
  references: { items: ReferenceRecord[], active: string } | null,
  outputs: { total, byKind:{image,audio,video}, bytes, latestAt } | null,
  outputs: { total, byKind:{image,audio,video}, bytes, latestAt } | null,
  budget: BudgetSnapshot,          // 见 budget.snapshot
  stickers: { total, byLayer: {library,candidate,negative,trash}, tags: number },
  chats: number,
  people: number,
  serverTime: number
}
```

### 2.2 配置

- `config.get` → `{ config: PublicConfig, warnings: string[] }`。`qq.appSecret` 恒为 `''`，并带 `qq.appSecretMasked`、`qq.hasSecret`；`multimodal.apiKey` 同样只返回空串 + `multimodal.apiKeyMasked` + `multimodal.hasApiKey`；`output.image/audio/video` 各自返回 `apiKey:''` + `apiKeyMasked` + `hasApiKey`。
- `config.save` args `{ patch: object }` → `{ config: PublicConfig, warnings: string[] }`。
  - `patch` 为深层局部覆盖；`qq.appSecret`、`multimodal.apiKey`、`output.*.apiKey` 留空表示保留原密钥。
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

### 2.4.2 多模态输出

- `output.status` → `{ status: OutputStatus, store: { total, byKind, bytes, latestAt } }`；`status` 字段同 `snapshot.output`，不含任何密钥。
- `output.test` args `{ kind: 'image'|'audio'|'video' }` → `{ ok:true, kind, mode:'models'|'reachable'|'config-only', modelFound?, modelCount?, warning?, ms }`；`/models` 不存在时软通过并给出 warning；401/403/网络错误返回 `{ok:false,error}`。
- `output.generate` args `{ kind, prompt }` → `{ kind, records: OutputRecord[], record }`。会真实调用第三方接口、可能耗时数分钟；记录中**不含**本地 `filePath`。
- `output.history` args `{ kind?, limit?=30, offset?=0 }` → `{ total, items: OutputRecord[] }`。
- `output.delete` args `{ id }` → `{ ok:true, item }`（删除索引与本地文件）。
- `output.clear` args `{ kind? }` → `{ ok:true, removed, store }`（省略 kind 时清空全部）。
- `output.reference.list` → `{ items: ReferenceRecord[], active, settings }`。
- `output.reference.upload` args `{ name: string, mime?: string, dataBase64: string }` → `{ item }`；只接受 png/jpg/webp/gif/bmp，大小受 `output.image.reference.maxBytes` 限制。
- `output.reference.activate` args `{ id, enabled?: boolean }` → `{ item, config, warnings }`；把图片设为当前参考图，`enabled=true` 时同时打开总开关。
- `output.reference.delete` args `{ id }` → `{ ok:true, item, active }`；删除当前参考图时会清空当前 id。

`OutputRecord`：`id, kind, ext, mime, size, prompt, provider, model, durationMs, createdAt, source?, referenceId?`。
`ReferenceRecord`：`id, ext, mime, size, originalName, createdAt`。

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

1. 固定左侧栏：品牌 + 数据目录 + 连接状态徽标 + **功能搜索** + 分组导航 + **「← 退出工作台」按钮**；移动端（≤900px）变为抽屉，用「☰ 功能」打开、Esc/遮罩关闭。
   退出按钮分三种宿主：嵌入 DSH 应用内（iframe）时向父页面 `postMessage({type:'qqbot-console-exit'})`，
   由父面板切回会话界面（不重载 APP）；独立子窗口（window.name=`qqbot-console` 或存在 opener）调用 `window.close()`；
   普通标签页优先 `history.back()`，没有历史时 `location.assign('/')` 跳回 DSH；无弹窗时按 Esc 也可退出。
2. **分组导航**（不再是一排平铺 Tab）：
   - 运行：概览
   - 智能能力：多模态输出、多模态识别、对话模型、人设、记忆与压缩（后四项直接跳到配置对应分区）
   - 聊天运营：预算、会话、人员
   - 内容：表情包
   - 系统：全部配置、日志
   使用 hash 路由（`#/overview`、`#/output`、`#/config/multimodal`…），支持浏览器前进/后退与深链接；Ctrl/Cmd+K 聚焦功能搜索。
3. **概览**：快捷入口网格（多模态输出、表情包、预算、会话、人员、多模态识别、全部配置、日志）+ 状态卡片（QQ、模型、今日预算、多模态输出/作品库、多模态识别、表情包、会话/人员）；按钮：启动/停止/重连、测试 QQ 凭证、测试 LLM；配置警告列表。
4. **多模态输出**：三张状态卡（图片/语音/视频与作品库）+ **接口配置**（输出总开关、图片、语音、视频、角色形象参考五组字段，支持按视频协议/参考图模式显示、隐藏高级字段，每类「检测接口」按钮）+ **角色形象参考**（上传、预览、设为当前、删除参考图，命中角色名/触发词时自动带入图片生成）+ **生成试跑**（类型切换、提示词、生成中计时、预览、最近结果）+ **最近生成**（图片点击放大、音视频播放、参考图标记、删除、清空、加载更多）。
5. **配置**：左侧配置分区导航 + 搜索框（按字段名/键名/提示过滤，显示匹配数），右侧分区表单；AppSecret / 识别 API Key / 输出各模态 API Key 显示掩码，输入留空不改；保存后 toast。分区：QQ 接入、LLM 模型、人设、多模态识别、记忆与压缩、预算、表情包、命令与管理员、系统与日志。多模态输出的接口配置只在「多模态输出」页，配置页给出跳转提示。
6. **表情包**：最关键页面。
   - 工具栏：图层 Tab（全部/正式库/候选/负面/回收站，带数量）、搜索框（标签/描述/id）、标签筛选 chips、「扫描 import 目录」按钮、上传文件按钮（`<input type=file multiple accept=image/*>`，转 base64 提交）。
   - 网格卡片：缩略图（`/qqbot/media/sticker/<id>`）、勾选框、id、图层徽标、标签 chips、使用次数；点击卡片打开右侧/弹层编辑：图片预览、标签输入（逗号分隔 + 已有标签 chips 可点选）、描述、图层下拉、保存/删除。
   - 批量操作：全选/反选；批量改图层、批量加标签、批量移入回收站、批量删除（确认）。
   - 导入结果用 toast 展示 added/duplicates/skipped 数量。
7. **预算**：今日本月用量卡片、限额进度、按会话表格（chatId/tokens/cost/lastAt）、最近调用表格（时间/chatId/模型/tokens/cost），重置今日/本月按钮（二次确认）。
8. **会话**：左侧列表 + 右侧详情；详情展示历史（role/content/时间）、摘要、事实、覆盖人设表单（JSON 字段用表单：名字/系统提示/风格/表情频率/模型），按钮：压缩、抽取记忆、清空上下文。
9. **人员**：表格（openid/昵称/消息数/最近出现/事实数）；可编辑昵称与追加事实。
10. **日志**：级别筛选 + 刷新 + 自动滚动；每条显示时间/级别/内容。
11. 通用：所有请求走 `POST /qqbot/api`；`fetch(..., {headers:{'content-type':'application/json'}, body: JSON.stringify({method,args})})`；错误 toast；操作中按钮禁用；深色/浅色主题用 `prefers-color-scheme`；移动端可用（网格自适应）。生成类请求需放宽前端超时（当前 660s）。
12. 页面 JS 必须语法正确（`node --check host/admin/ui/app.js`）；不使用 `eval`；对 API 返回做空值防御。

## 4. 文件

- `host/admin/ui/index.html`（页面骨架 + 引入 assets）
- `host/admin/ui/app.js`（全部交互，单文件原生 JS；v0.3.0 约 4000 行）
- `host/admin/ui/style.css`
