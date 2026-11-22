/**
 * Admin surface of the qqbot plugin.
 *
 *   GET  <admin.path>                  → host/admin/ui/index.html (302 adds trailing slash)
 *   GET  <admin.path>/assets/<file>    → host/admin/ui/<file> (whitelisted names)
 *   GET  <admin.path>/media/sticker/<id> → sticker image bytes
 *   POST <admin.path>/api              → { method, args } → { ok, result | error }
 *
 * Only same-origin requests are accepted; there is no token because the page is
 * served by the loopback DSH web server.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const UI_DIR = fileURLToPath(new URL('./ui', import.meta.url))
const MAX_BODY_BYTES = 32 * 1024 * 1024
const ASSET_NAMES = new Set(['index.html', 'app.js', 'style.css'])

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon'
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

function sameOrigin(req) {
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return false
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    try {
      if (new URL(origin).host !== host) return false
    } catch {
      return false
    }
  }
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false
  return true
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body))
  })
  res.end(body)
}

function sendText(res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, { 'content-type': contentType, 'cache-control': 'no-store' })
  res.end(text)
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    let size = 0
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      size += Buffer.byteLength(chunk)
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大（上限 32MB）'))
        req.destroy()
        return
      }
      body += chunk
    })
    req.on('end', () => {
      if (body.trim() === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(body))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', (error) => reject(error))
  })
}

function requireString(args, name) {
  const value = args?.[name]
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`参数 ${name} 必须是非空字符串`)
  return value.trim()
}

function optionalString(args, name) {
  const value = args?.[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`参数 ${name} 必须是字符串`)
  return value
}

function optionalNumber(args, name, fallback) {
  const value = args?.[name]
  if (value === undefined || value === null) return fallback
  const num = Number(value)
  if (!Number.isFinite(num)) throw new Error(`参数 ${name} 必须是数字`)
  return num
}

function normalizeTagsInput(value) {
  if (value === undefined || value === null) return undefined
  if (Array.isArray(value)) return value.map((item) => String(item ?? '').trim()).filter(Boolean)
  if (typeof value === 'string') return value.split(/[,，、;；|/\n]+|\s{2,}/).map((item) => item.trim()).filter(Boolean)
  throw new Error('tags 必须是字符串或字符串数组')
}

function decodeBase64(data) {
  const text = String(data ?? '')
  const comma = text.indexOf(',')
  const payload = text.startsWith('data:') && comma >= 0 ? text.slice(comma + 1) : text
  if (payload === '') throw new Error('文件内容为空')
  const buffer = Buffer.from(payload, 'base64')
  if (buffer.length === 0) throw new Error('文件内容解码失败')
  return buffer
}

function stickerContentType(ext) {
  return MIME[`.${String(ext ?? '').toLowerCase()}`] ?? 'application/octet-stream'
}

/**
 * Register the admin HTTP surface on the host web server.
 * @returns {(() => void)|undefined} disposer, when a web server is available
 */
export function registerAdminRoutes({ ctx, app }) {
  const webServer = ctx?.get?.('webServer')
  if (webServer === undefined || typeof webServer.register !== 'function') {
    app?.logger?.warn?.('没有可用的 webServer 服务，管理后台页面不会启动')
    return undefined
  }
  const initialPath = app.configStore.get().admin.path
  if (app.configStore.get().admin.enabled === false) {
    app?.logger?.info?.('管理后台已在配置中关闭（admin.enabled=false）')
    return undefined
  }

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      let pathname
      try {
        pathname = decodeURIComponent(url.pathname)
      } catch {
        sendJson(res, 400, { ok: false, error: '非法 URL 编码' })
        return
      }
      const base = initialPath
      if (pathname !== base && !pathname.startsWith(`${base}/`)) {
        sendJson(res, 404, { ok: false, error: 'not found' })
        return
      }
      const rest = pathname.slice(base.length)
      const headOnly = req.method === 'HEAD'

      if (req.method === 'GET' || req.method === 'HEAD') {
        if (rest === '') {
          res.writeHead(302, { location: `${base}/`, 'cache-control': 'no-store' })
          res.end()
          return
        }
        if (rest === '/') {
          await servePackageFile(res, path.join(UI_DIR, 'index.html'), MIME['.html'], 0, headOnly)
          return
        }
        if (rest === '/icon.svg') {
          await servePackageFile(res, path.resolve(UI_DIR, '..', '..', '..', 'icon.svg'), 'image/svg+xml', 3600, headOnly)
          return
        }
        if (rest.startsWith('/assets/')) {
          await serveAsset(res, rest.slice('/assets/'.length), headOnly)
          return
        }
        if (rest.startsWith('/media/sticker/')) {
          await serveSticker(res, rest.slice('/media/sticker/'.length), headOnly)
          return
        }
        if (rest.startsWith('/media/output/')) {
          await serveOutput(res, rest.slice('/media/output/'.length), headOnly, req.headers?.range)
          return
        }
        if (rest.startsWith('/media/reference/')) {
          await serveReference(res, rest.slice('/media/reference/'.length), headOnly)
          return
        }
        sendJson(res, 404, { ok: false, error: 'not found' })
        return
      }

      if (req.method === 'POST' && (rest === '/api' || rest === '/api/')) {
        if (!sameOrigin(req)) {
          sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
          return
        }
        let payload
        try {
          payload = await readJsonBody(req)
        } catch (error) {
          sendJson(res, 413, { ok: false, error: errorText(error) })
          return
        }
        const method = typeof payload?.method === 'string' ? payload.method : ''
        const args = payload?.args !== null && typeof payload?.args === 'object' ? payload.args : {}
        try {
          const result = await dispatch(method, args, app)
          sendJson(res, 200, { ok: true, result })
        } catch (error) {
          app.logger?.warn?.(`admin api ${method} 失败`, error)
          sendJson(res, 200, { ok: false, error: errorText(error) })
        }
        return
      }

      sendJson(res, 405, { ok: false, error: 'method not allowed' })
    } catch (error) {
      app.logger?.error?.('admin 请求处理异常', error)
      try {
        sendJson(res, 500, { ok: false, error: 'internal error' })
      } catch {
        res.destroy?.()
      }
    }
  }

  async function serveAsset(res, name, headOnly = false) {
    const clean = name.split('?')[0]
    if (!ASSET_NAMES.has(clean)) {
      sendJson(res, 404, { ok: false, error: 'asset not found' })
      return
    }
    const file = path.join(UI_DIR, clean)
    await servePackageFile(res, file, MIME[path.extname(clean)] ?? 'application/octet-stream', 0, headOnly)
  }

  async function serveSticker(res, id, headOnly = false) {
    const stickerId = String(id ?? '').split('?')[0].replace(/[^a-zA-Z0-9_-]/g, '')
    if (!/^[a-zA-Z0-9]{6,64}$/.test(stickerId)) {
      sendJson(res, 404, { ok: false, error: 'invalid sticker id' })
      return
    }
    const item = await app.stickerStore.get(stickerId)
    if (item === undefined || item === null) {
      sendJson(res, 404, { ok: false, error: 'sticker not found' })
      return
    }
    const file = app.stickerStore.filePath(item)
    try {
      const data = await fsp.readFile(file)
      res.writeHead(200, {
        'content-type': stickerContentType(item.ext),
        'content-length': String(data.length),
        'cache-control': 'private, max-age=86400'
      })
      res.end(headOnly ? undefined : data)
    } catch {
      sendJson(res, 404, { ok: false, error: 'sticker file missing' })
    }
  }

  /**
   * Serve one generated asset. Audio/video tags need byte-range support for
   * seeking, so a minimal single-range parser is included; multi-range
   * requests fall back to the full body.
   */
  async function serveOutput(res, id, headOnly = false, rangeHeader = undefined) {
    const outputId = String(id ?? '').split('?')[0].replace(/[^a-zA-Z0-9_-]/g, '')
    if (!/^[a-zA-Z0-9]{6,64}$/.test(outputId)) {
      sendJson(res, 404, { ok: false, error: 'invalid output id' })
      return
    }
    if (app.outputStore === undefined || typeof app.outputStore.get !== 'function') {
      sendJson(res, 404, { ok: false, error: 'output store unavailable' })
      return
    }
    const item = await app.outputStore.get(outputId)
    if (item === undefined || item === null) {
      sendJson(res, 404, { ok: false, error: 'output not found' })
      return
    }
    let data
    try {
      data = await fsp.readFile(app.outputStore.filePath(item))
    } catch {
      sendJson(res, 404, { ok: false, error: 'output file missing' })
      return
    }
    const total = data.length
    const contentType = typeof item.mime === 'string' && item.mime !== '' ? item.mime : 'application/octet-stream'
    const range = parseByteRange(rangeHeader, total)
    if (range !== null) {
      const length = range.end - range.start + 1
      res.writeHead(206, {
        'content-type': contentType,
        'content-length': String(length),
        'content-range': `bytes ${range.start}-${range.end}/${total}`,
        'accept-ranges': 'bytes',
        'cache-control': 'private, max-age=86400'
      })
      res.end(headOnly ? undefined : data.subarray(range.start, range.end + 1))
      return
    }
    res.writeHead(200, {
      'content-type': contentType,
      'content-length': String(total),
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=86400'
    })
    res.end(headOnly ? undefined : data)
  }

  async function serveReference(res, id, headOnly = false) {
    const referenceId = String(id ?? '').split('?')[0].replace(/[^a-zA-Z0-9_-]/g, '')
    if (!/^[a-zA-Z0-9]{6,64}$/.test(referenceId)) {
      sendJson(res, 404, { ok: false, error: 'invalid reference id' })
      return
    }
    if (app.referenceStore === undefined || typeof app.referenceStore.get !== 'function') {
      sendJson(res, 404, { ok: false, error: 'reference store unavailable' })
      return
    }
    const item = await app.referenceStore.get(referenceId)
    if (item === undefined || item === null) {
      sendJson(res, 404, { ok: false, error: 'reference not found' })
      return
    }
    try {
      const data = await fsp.readFile(app.referenceStore.filePath(item))
      res.writeHead(200, {
        'content-type': item.mime || 'application/octet-stream',
        'content-length': String(data.length),
        'cache-control': 'private, max-age=86400'
      })
      res.end(headOnly ? undefined : data)
    } catch {
      sendJson(res, 404, { ok: false, error: 'reference file missing' })
    }
  }

  function parseByteRange(header, total) {
    if (typeof header !== 'string' || header === '' || total <= 0) return null
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
    if (match === null) return null
    const startRaw = match[1]
    const endRaw = match[2]
    if (startRaw === '' && endRaw === '') return null
    let start
    let end
    if (startRaw === '') {
      const suffix = Number(endRaw)
      if (!Number.isFinite(suffix) || suffix <= 0) return null
      start = Math.max(0, total - suffix)
      end = total - 1
    } else {
      start = Number(startRaw)
      end = endRaw === '' ? total - 1 : Number(endRaw)
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= total) return null
    if (end < start) return null
    return { start, end: Math.min(end, total - 1) }
  }

  async function servePackageFile(res, file, contentType, maxAgeSeconds, headOnly = false) {
    try {
      const data = await fsp.readFile(file)
      res.writeHead(200, {
        'content-type': contentType,
        'content-length': String(data.length),
        'cache-control': maxAgeSeconds > 0 ? `private, max-age=${maxAgeSeconds}` : 'no-store'
      })
      res.end(headOnly ? undefined : data)
    } catch {
      sendText(res, 404, 'not found')
    }
  }

  const register = () =>
    webServer.register({
      kind: 'prefix',
      path: initialPath,
      handler
    })

  // Register inside a Cordis effect when available: the host web server tracks
  // route disposers against the owning fiber, so a bare call may be rejected
  // when a plugin activates via HMR. The fallback keeps the module usable in
  // unit tests that pass a plain { register } object.
  let dispose
  let disposed = false
  const disposeRoute = () => {
    if (disposed) return
    disposed = true
    try {
      dispose?.()
    } catch (error) {
      app.logger?.warn?.('注销管理后台路由失败', error)
    }
  }

  if (typeof ctx?.effect === 'function') {
    dispose = ctx.effect(register, 'qqbot: admin routes')
  } else {
    dispose = register()
  }
  app.logger?.info?.(`管理后台已注册：${initialPath}/`)
  return disposeRoute
}

/* ------------------------------------------------------------------ */
/* API dispatch                                                       */
/* ------------------------------------------------------------------ */

async function dispatch(method, args, app) {
  switch (method) {
    case 'snapshot':
      return snapshot(app)
    case 'config.get':
      return { config: app.configStore.public(), warnings: app.configStore.warnings() }
    case 'config.save': {
      if (args.patch === null || typeof args.patch !== 'object') throw new Error('参数 patch 必须是对象')
      const result = await app.configStore.save(args.patch)
      return { config: app.configStore.public(), warnings: result.warnings ?? [] }
    }
    case 'gateway.start':
      await app.qqClient.start()
      return { status: app.qqClient.status() }
    case 'gateway.stop':
      await app.qqClient.stop()
      return { status: app.qqClient.status() }
    case 'gateway.reconnect':
      await app.qqClient.restart()
      return { status: app.qqClient.status() }
    case 'gateway.test':
      return app.qqClient.testAuth()
    case 'llm.test': {
      const prompt = typeof args.prompt === 'string' && args.prompt.trim() !== '' ? args.prompt.trim() : '你好，请用一句话介绍你自己。'
      const started = Date.now()
      const result = await app.llmClient.complete({
        system: '你是连通性测试助手。只回复一行简短中文。',
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 128
      })
      return {
        text: result.text,
        provider: result.provider,
        model: result.model,
        usage: result.usage,
        ms: Date.now() - started
      }
    }
    case 'multimodal.test': {
      // 1x1 transparent PNG: proves URL/auth/model wiring without requiring a
      // sample upload. Providers normally answer "空白/透明图片".
      const pixel = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64'
      )
      const started = Date.now()
      const result = await app.multimodalClient.describe({ kind: 'image', buffer: pixel, contentType: 'image/png' })
      return { ...result, ms: Date.now() - started }
    }
    case 'output.status':
      return {
        status: readOutputStatus(app),
        store: typeof app.outputStore?.stats === 'function' ? app.outputStore.stats() : null
      }
    case 'output.test': {
      const kind = requireOutputKind(args)
      return app.outputClient.test({ kind })
    }
    case 'output.generate': {
      const kind = requireOutputKind(args)
      const prompt = requireString(args, 'prompt')
      if (prompt.length > 2000) throw new Error('prompt 最多 2000 个字符')
      if (typeof app.outputClient?.generate !== 'function') throw new Error('多模态输出服务不可用')
      const result = await app.outputClient.generate({
        kind,
        prompt,
        source: { kind: 'admin', chatId: typeof args.chatId === 'string' ? args.chatId : '' }
      })
      return {
        kind: result.kind,
        records: (Array.isArray(result.records) ? result.records : []).map(publicOutputRecord),
        record: result.record ? publicOutputRecord(result.record) : null
      }
    }
    case 'output.history': {
      if (typeof app.outputStore?.list !== 'function') throw new Error('多模态输出作品库不可用')
      const result = await app.outputStore.list({
        kind: optionalString(args, 'kind'),
        limit: clampInt(args.limit, 30, 1, 200),
        offset: clampInt(args.offset, 0, 0, 1e9)
      })
      return { total: result.total, items: result.items.map(publicOutputRecord) }
    }
    case 'output.delete': {
      const id = requireString(args, 'id')
      const removed = await app.outputStore.remove(id)
      return { ok: true, item: publicOutputRecord(removed) }
    }
    case 'output.clear': {
      if (typeof app.outputStore?.clear !== 'function') throw new Error('多模态输出作品库不可用')
      const kind = typeof args.kind === 'string' && args.kind !== '' ? requireOutputKind(args) : undefined
      const result = await app.outputStore.clear(kind === undefined ? {} : { kind })
      return { ok: true, ...result, store: app.outputStore.stats() }
    }
    case 'output.reference.list': {
      if (typeof app.referenceStore?.list !== 'function') throw new Error('角色参考图存储不可用')
      const listed = await app.referenceStore.list()
      const activeId = app.configStore.get().output.image.reference.id
      return {
        items: listed.items.map(publicReference),
        active: activeId,
        settings: app.configStore.get().output.image.reference
      }
    }
    case 'output.reference.upload': {
      if (typeof app.referenceStore?.add !== 'function') throw new Error('角色参考图存储不可用')
      const name = typeof args.name === 'string' && args.name.trim() !== '' ? args.name.trim() : 'reference'
      const buffer = decodeBase64(args.dataBase64)
      const item = await app.referenceStore.add({ buffer, mime: typeof args.mime === 'string' ? args.mime : '', originalName: name })
      return { item: publicReference(item) }
    }
    case 'output.reference.activate': {
      const id = requireString(args, 'id')
      const item = await app.referenceStore.get(id)
      if (item === undefined || item === null) throw new Error('找不到该参考图片')
      const referencePatch = { id }
      if (typeof args.enabled === 'boolean') referencePatch.enabled = args.enabled
      const result = await app.configStore.save({ output: { image: { reference: referencePatch } } })
      return { item: publicReference(item), config: app.configStore.public(), warnings: result.warnings ?? [] }
    }
    case 'output.reference.delete': {
      const id = requireString(args, 'id')
      const removed = await app.referenceStore.remove(id)
      const activeId = app.configStore.get().output.image.reference.id
      if (activeId === id) {
        await app.configStore.save({ output: { image: { reference: { id: '' } } } })
      }
      return { ok: true, item: publicReference(removed), active: app.configStore.get().output.image.reference.id }
    }
    case 'budget.snapshot':
      return app.budgetStore.snapshot()
    case 'budget.reset':
      return app.budgetStore.reset(typeof args.scope === 'string' ? args.scope : 'today')
    case 'budget.events':
      return { events: await app.budgetStore.recent(clampInt(args.limit, 20, 1, 500)) }
    case 'stickers.list': {
      const limit = clampInt(args.limit, app.configStore.get().admin.pageSize, 1, 200)
      const offset = clampInt(args.offset, 0, 0, 1e9)
      return app.stickerStore.list({
        layer: optionalString(args, 'layer'),
        tags: normalizeTagsInput(args.tags),
        query: optionalString(args, 'query'),
        limit,
        offset
      })
    }
    case 'stickers.upload': {
      if (!Array.isArray(args.files) || args.files.length === 0) throw new Error('files 不能为空')
      if (args.files.length > 100) throw new Error('一次最多上传 100 个文件')
      const files = args.files.map((file) => {
        if (file === null || typeof file !== 'object') throw new Error('files 项必须是 {name,dataBase64}')
        return { name: typeof file.name === 'string' ? file.name : 'upload', buffer: decodeBase64(file.dataBase64) }
      })
      return app.importer.importBuffers(files, {
        tags: normalizeTagsInput(args.tags) ?? [],
        desc: typeof args.desc === 'string' ? args.desc : '',
        layer: validLayer(args.layer, 'candidate'),
        source: { path: 'upload' }
      })
    }
    case 'stickers.scanDir': {
      const files = await app.importer.scanImportDir()
      return {
        files: files.map((file) => ({ path: file.path, name: file.name, size: file.size }))
      }
    }
    case 'stickers.importDir':
      return app.importer.importDirectory({
        tags: normalizeTagsInput(args.tags) ?? [],
        desc: typeof args.desc === 'string' ? args.desc : '',
        layer: validLayer(args.layer, 'candidate')
      })
    case 'stickers.update': {
      const id = requireString(args, 'id')
      const patch = {}
      if (args.tags !== undefined) patch.tags = normalizeTagsInput(args.tags) ?? []
      if (args.desc !== undefined) patch.desc = String(args.desc ?? '')
      if (args.layer !== undefined) patch.layer = validLayer(args.layer)
      const item = await app.stickerStore.update(id, patch)
      return { item }
    }
    case 'stickers.batchUpdate': {
      if (!Array.isArray(args.ids) || args.ids.length === 0) throw new Error('ids 不能为空')
      const addTags = normalizeTagsInput(args.addTags) ?? []
      const removeTags = (normalizeTagsInput(args.removeTags) ?? []).map((tag) => tag.toLowerCase())
      const layer = args.layer === undefined ? undefined : validLayer(args.layer)
      let updated = 0
      for (const rawId of args.ids.slice(0, 500)) {
        const id = String(rawId ?? '').trim()
        if (id === '') continue
        const current = await app.stickerStore.get(id)
        if (current === undefined || current === null) continue
        const nextTags = [...new Set([...(current.tags ?? []), ...addTags])].filter(
          (tag) => !removeTags.includes(tag.toLowerCase())
        )
        await app.stickerStore.update(id, {
          tags: nextTags,
          ...(layer === undefined ? {} : { layer })
        })
        updated += 1
      }
      return { updated }
    }
    case 'stickers.remove': {
      const id = requireString(args, 'id')
      return { item: await app.stickerStore.remove(id) }
    }
    case 'stickers.purge': {
      const id = requireString(args, 'id')
      await app.stickerStore.purge(id)
      return { ok: true }
    }
    case 'stickers.restore': {
      const id = requireString(args, 'id')
      return { item: await app.stickerStore.restore(id) }
    }
    case 'stickers.stats': {
      const stats = await app.stickerStore.stats()
      const catalog = await app.stickerStore.catalog({ maxTags: 100 })
      return { ...stats, tags: catalog.tags }
    }
    case 'chats.list': {
      const query = (optionalString(args, 'query') ?? '').toLowerCase()
      const chats = await app.memoryStore.listChats()
      const filtered = query === '' ? chats : chats.filter((chat) => `${chat.chatId} ${chat.title}`.toLowerCase().includes(query))
      return { chats: filtered }
    }
    case 'chats.get': {
      const chatId = requireString(args, 'chatId')
      const chat = await app.memoryStore.getChat(chatId)
      const persona = await app.personaStore.get(chatId)
      const members = await readChatMembers(app, chatId)
      return { chat, persona, members }
    }
    case 'chats.clear': {
      const chatId = requireString(args, 'chatId')
      await app.memoryStore.clearChat(chatId, { keepFacts: args.keepFacts !== false })
      return { ok: true }
    }
    case 'chats.compress': {
      const chatId = requireString(args, 'chatId')
      return app.chatEngine.compressChat(chatId)
    }
    case 'chats.extract': {
      const chatId = requireString(args, 'chatId')
      return app.chatEngine.extractFacts(chatId)
    }
    case 'chats.persona.set': {
      const chatId = requireString(args, 'chatId')
      if (args.patch === null || typeof args.patch !== 'object') throw new Error('参数 patch 必须是对象')
      return { persona: await app.personaStore.set(chatId, args.patch) }
    }
    case 'chats.persona.delete': {
      const chatId = requireString(args, 'chatId')
      await app.personaStore.remove(chatId)
      return { ok: true }
    }
    case 'persona.list':
      return app.personaStore.list()
    case 'persona.users.set': {
      const userId = requireString(args, 'userId')
      if (args.patch === null || typeof args.patch !== 'object') throw new Error('参数 patch 必须是对象')
      return { persona: await app.personaStore.setUser(userId, args.patch) }
    }
    case 'persona.users.delete': {
      const userId = requireString(args, 'userId')
      await app.personaStore.removeUser(userId)
      return { ok: true }
    }
    case 'people.list': {
      const people = await app.memoryStore.listPeople()
      return { people }
    }
    case 'people.set': {
      const openid = requireString(args, 'openid')
      if (args.patch === null || typeof args.patch !== 'object') throw new Error('参数 patch 必须是对象')
      return { person: await app.memoryStore.upsertPerson(openid, args.patch) }
    }
    case 'logs.recent': {
      const limit = clampInt(args.limit, 200, 1, 1000)
      const level = optionalString(args, 'level')
      let entries = app.logger.recent(limit)
      if (typeof level === 'string' && level !== '' && level !== 'all') {
        const allowed = new Set(String(level).split(',').map((item) => item.trim()))
        entries = entries.filter((entry) => allowed.has(entry.level))
      }
      return { entries }
    }
    default:
      throw new Error(`unknown method "${String(method)}"`)
  }
}

async function snapshot(app) {
  const [budget, stickerStats, chats, people, outputStats, referenceList] = await Promise.all([
    app.budgetStore.snapshot(),
    app.stickerStore.stats(),
    app.memoryStore.listChats(),
    app.memoryStore.listPeople(),
    typeof app.outputStore?.stats === 'function' ? Promise.resolve(app.outputStore.stats()) : Promise.resolve(null),
    typeof app.referenceStore?.list === 'function' ? app.referenceStore.list() : Promise.resolve({ items: [] })
  ])
  const config = app.configStore.get()
  return {
    version: app.version,
    dataDir: app.paths.data,
    configWarnings: app.configStore.warnings(),
    status: app.qqClient.status(),
    llm: { provider: config.llm.provider, model: config.llm.model },
    multimodal: readMultimodalStatus(app),
    output: readOutputStatus(app),
    outputs: outputStats,
    references: {
      items: (Array.isArray(referenceList?.items) ? referenceList.items : []).map(publicReference),
      active: config.output.image.reference.id
    },
    budget,
    stickers: { total: stickerStats.total, byLayer: stickerStats.byLayer, tags: stickerStats.tags },
    chats: chats.length,
    people: people.length,
    serverTime: Date.now()
  }
}

function readMultimodalStatus(app) {
  try {
    return typeof app.multimodalClient?.status === 'function' ? app.multimodalClient.status() : null
  } catch {
    return null
  }
}

function readOutputStatus(app) {
  try {
    return typeof app.outputClient?.status === 'function' ? app.outputClient.status() : null
  } catch {
    return null
  }
}

function requireOutputKind(args) {
  const kind = String(args?.kind ?? '').trim().toLowerCase()
  if (!['image', 'audio', 'video'].includes(kind)) throw new Error(`参数 kind 必须是 image / audio / video，收到：${kind || '(空)'}`)
  return kind
}

function publicOutputRecord(record) {
  if (record === null || typeof record !== 'object') return null
  const { filePath, ...rest } = record
  return rest
}

function publicReference(record) {
  if (record === null || typeof record !== 'object') return null
  const { filePath, ...rest } = record
  return rest
}

async function readChatMembers(app, chatId) {
  try {
    if (typeof app.memoryStore?.listChatMembers !== 'function') return []
    return await app.memoryStore.listChatMembers(chatId)
  } catch (error) {
    app.logger?.warn?.('读取群成员长期事实失败', { chatId, error: error?.message })
    return []
  }
}

function clampInt(value, fallback, min, max) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, Math.floor(num)))
}

function validLayer(value, fallback = undefined) {
  const layer = String(value ?? '')
  if (['library', 'candidate', 'negative', 'trash'].includes(layer)) return layer
  if (fallback !== undefined) return fallback
  throw new Error(`非法图层：${layer}`)
}

export { ASSET_NAMES, MIME, sameOrigin, readJsonBody, dispatch as dispatchAdminMethod }
