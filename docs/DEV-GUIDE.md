# 开发约定与协作说明

## 1. 基本约束

- **运行时零第三方依赖**：只允许 `node:*` 内置模块和相对路径 import。
- **纯 ESM**：`import`/`export`，文件后缀 `.js`、`.mjs`。
- **不访问网络**（除被测代码显式注入的 fetch/WebSocket，测试里必须 mock）。
- 不改 `package.json` / `cordis.patch.yml` / `host/app.js` / `host/config.js` 等共享文件；需要变更时在共享任务里留言由 Lead 处理。
- 代码注释用英文即可；**面向用户的文案、错误提示、管理页 UI 一律中文**。
- 每个新文件都要能通过 `node --check`。

## 2. 工作目录与数据

- 包根：本仓库根目录（即 `qqbot/`）。
- 运行时数据默认在 `<包根>/data`；测试通过 `createPaths({ packageRoot: <临时目录> })` 隔离，**不要写真实 `data/`**。
- 所有路径从 `host/paths.js` 的 `paths` 对象取，不要自己拼 `data/...`。

## 3. 工具函数（Lead 已提供，直接复用）

- `host/util/fsx.js`：`ensureDir` `readJson` `readJsonSync` `writeJsonAtomic` `appendJsonl` `readJsonl` `listFilesRecursive` `sha256File` `sha256Buffer` `extOf` `baseName` `safeId` `moveFile` `removeFile` `pathExists` `sleep`
- `host/util/text.js`：`estimateTokens` `estimateMessagesTokens` `chunkText` `stripMarkdown` `parseStickerDirectives` `normalizeTags` `mergeTags` `parseCommand` `escapeRegExp` `formatDateTime` `formatDate` `formatMonth` `maskSecret` `shortTitle` `isLikelyImageContentType` `clampText`
- `host/util/log.js`：`createLogger({file, ctxLogger, maxLines, debug})`（模块里只使用注入的 `logger`，不要自己创建）
- `host/config.js`：`DEFAULT_CONFIG` `normalizeConfig` `patchConfig` `loadConfig` `saveConfig` `publicConfig` `hasCredentials`

## 4. 错误处理

- 面向聊天用户的错误：记录日志，发兜底文案，不让异常冒泡到插件外。
- 面向管理页的错误：抛 `Error`，由 admin API 统一捕获成 `{ok:false,error}`。
- 所有 setTimeout/定时器、WebSocket 回调、promise 链必须有 try/catch 或 `.catch`，不能出现 unhandledRejection。
- 日志中**绝不打印 AppSecret、access_token、完整 URL query 中的 rkey**。

## 5. 测试要求

```powershell
node --check host/qq/api.js          # 单文件语法
node --test tests/qq-api.test.mjs    # 自己的测试
node --test "tests/*.test.mjs"       # 全部（Lead 会跑）
```

- 每个模块至少：1 条正常路径 + 2 条异常/边界路径。
- 测试从 `tests/helpers.mjs` 取工具（见下），使用 `node:test` + `node:assert/strict`。
- 文件系统测试用 `makeTempPaths()`，`after()` 里 `await cleanup()`。
- mock LLM：`makeFakeLlm({ reply: '...' })` 与 `makeFakeCtxLlm([...chunks])`。
- 判断「等待异步」时用 `await waitFor(() => ...)`，不要裸 sleep 太长。
- 需要 fake WebSocket 时自己实现 `{ readyState, send(), close(), addEventListener() }`，由 `WebSocketImpl` 注入。

## 6. tests/helpers.mjs 用法

```js
import { makeTempPaths, makeConfigStore, makeLogger, makeFakeLlm, makeFakeCtxLlm, waitFor } from './helpers.mjs'

const { paths, cleanup } = await makeTempPaths()
const configStore = makeConfigStore({ qq: { textChunkSize: 200 } })
const logger = makeLogger()
```

（`setConfig` 是内存 mock 的额外方法，仅测试可调用。）

## 7. 汇报格式

完成后用一条最终消息汇报：

1. 任务 id 与状态（已 complete）；
2. 新建/修改的文件清单；
3. 验证命令与结果（`node --check`、`node --test` 的输出摘要）；
4. 已知限制 / 需要 Lead 接线的地方；
5. 是否触碰了范围外文件（应为「无」）。

## 8. 并行注意

- 队友之间不要互相等待；接口以 `docs/INTERFACES.md` 为准。
- 若发现契约有歧义：按契约实现，并在汇报里列出「建议澄清点」，由 Lead 统一修正文档/接线。
