/**
 * Multimodal output client: image generation, text-to-speech and text-to-video
 * through third-party HTTP APIs.
 *
 * Supported protocols
 *   - image: OpenAI-compatible `POST {base}/images/generations`
 *            (`data[].b64_json` / `data[].url`; also tolerates the
 *            SiliconFlow-style `images[].url` response)
 *   - audio: OpenAI-compatible `POST {base}/audio/speech` returning binary
 *            audio (also tolerates JSON responses with base64 / URL)
 *   - video: asynchronous task APIs
 *       * siliconflow: POST /video/submit → POST /video/status
 *       * openai:      POST /videos → GET /videos/{id} → GET .../content
 *       * custom:      configurable submit / poll paths and JSON field paths
 *
 * The client only performs HTTP and returns raw bytes; persistence lives in
 * `output/store.js`. API keys are read from config on every call and never
 * appear in status/log messages.
 */
import fsp from 'node:fs/promises'
import { sleep } from '../util/fsx.js'
import { OutputError, shortMessage } from './errors.js'
import { decodeBase64Payload, extensionForMime, mimeForFormat, sniffGeneratedMime } from './media.js'

const DEFAULT_TIMEOUT_MS = 120000
const DEFAULT_MAX_BYTES = 33554432
const DEFAULT_VIDEO_TIMEOUT_MS = 300000
const DEFAULT_POLL_INTERVAL_MS = 3000
const MAX_PROMPT_CHARS = 2000
const IMAGE_PATH = '/images/generations'
const AUDIO_PATH = '/audio/speech'
const VIDEO_CREATE_PATH = '/video/submit'
const VIDEO_QUERY_PATH = '/video/status'
const OPENAI_VIDEO_CREATE_PATH = '/videos'
const MODELS_PATH = '/models'
const MODALITY_LABELS = Object.freeze({ image: '图片', audio: '语音', video: '视频' })

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function nonEmptyString(value, fallback = '') {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

function validatedBaseUrl(raw) {
  const value = String(raw ?? '').trim().replace(/\/+$/, '')
  if (value === '') return ''
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? value : ''
  } catch {
    return ''
  }
}

function providerLabel(baseUrl) {
  try {
    return new URL(baseUrl).host
  } catch {
    return 'custom-api'
  }
}

/** Resolve a dot path such as `results.videos.0.url` or `data[0].url`. */
export function dotGet(value, path) {
  const keys = String(path ?? '')
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((key) => key.trim())
    .filter((key) => key !== '')
  let node = value
  for (const key of keys) {
    if (node === null || node === undefined) return undefined
    node = node[key]
  }
  return node
}

function readConfigStore(configStore, logger) {
  try {
    const config = configStore?.get?.() ?? {}
    return isPlainObject(config) ? config : {}
  } catch (error) {
    logger?.warn?.('读取多模态输出配置失败', { error: shortMessage(error?.message ?? String(error)) })
    return {}
  }
}

function readSettings(config) {
  const raw = isPlainObject(config.output) ? config.output : {}
  const image = isPlainObject(raw.image) ? raw.image : {}
  const audio = isPlainObject(raw.audio) ? raw.audio : {}
  const video = isPlainObject(raw.video) ? raw.video : {}
  const sizeField = nonEmptyString(image.sizeField, 'size')
  const countField = nonEmptyString(image.countField, 'n')
  const responseFormat = typeof image.responseFormat === 'string' ? image.responseFormat.trim() : 'b64_json'
  const reference = isPlainObject(image.reference) ? image.reference : {}
  return {
    enabled: raw.enabled === true,
    commandAccess: raw.commandAccess === 'all' ? 'all' : 'admin',
    sendToQQ: raw.sendToQQ !== false,
    allowModelDirectives: raw.allowModelDirectives === true,
    promptPrefix: typeof raw.promptPrefix === 'string' ? raw.promptPrefix : '',
    timeoutMs: positiveNumber(raw.timeoutMs, DEFAULT_TIMEOUT_MS),
    maxBytes: positiveNumber(raw.maxBytes, DEFAULT_MAX_BYTES),
    maxItems: boundedInteger(raw.maxItems, 200, 0, 2000),
    retentionDays: boundedInteger(raw.retentionDays, 14, 0, 3650),
    image: {
      enabled: image.enabled === true,
      baseUrl: validatedBaseUrl(image.baseUrl),
      apiKey: nonEmptyString(image.apiKey),
      model: nonEmptyString(image.model),
      path: nonEmptyString(image.path, IMAGE_PATH),
      size: nonEmptyString(image.size),
      sizeField: sizeField === 'image_size' ? 'image_size' : sizeField === 'none' ? 'none' : 'size',
      count: boundedInteger(image.count, 1, 1, 4),
      countField: countField === 'batch_size' ? 'batch_size' : countField === 'none' ? 'none' : 'n',
      responseFormat: responseFormat === 'b64_json' || responseFormat === 'url' ? responseFormat : '',
      quality: nonEmptyString(image.quality),
      style: nonEmptyString(image.style),
      extraBody: typeof image.extraBody === 'string' ? image.extraBody : '',
      reference: {
        enabled: reference.enabled === true,
        id: nonEmptyString(reference.id),
        trigger: reference.trigger === 'always' ? 'always' : 'auto',
        keywords: typeof reference.keywords === 'string' ? reference.keywords : '',
        requestMode: reference.requestMode === 'generations' ? 'generations' : 'edits',
        path: nonEmptyString(reference.path, '/images/edits'),
        field: nonEmptyString(reference.field, 'image'),
        format: reference.format === 'base64' ? 'base64' : 'data_url',
        promptPrefix: typeof reference.promptPrefix === 'string' ? reference.promptPrefix : '',
        fallbackToText: reference.fallbackToText !== false,
        maxBytes: positiveNumber(reference.maxBytes, 10485760),
        maxItems: boundedInteger(reference.maxItems, 20, 1, 100)
      }
    },
    audio: {
      enabled: audio.enabled === true,
      baseUrl: validatedBaseUrl(audio.baseUrl),
      apiKey: nonEmptyString(audio.apiKey),
      model: nonEmptyString(audio.model),
      path: nonEmptyString(audio.path, AUDIO_PATH),
      voice: nonEmptyString(audio.voice, 'alloy'),
      format: ['mp3', 'opus', 'wav', 'ogg'].includes(audio.format) ? audio.format : 'mp3',
      speed: positiveNumber(audio.speed, 1),
      extraBody: typeof audio.extraBody === 'string' ? audio.extraBody : ''
    },
    video: {
      enabled: video.enabled === true,
      preset: ['siliconflow', 'openai', 'custom'].includes(video.preset) ? video.preset : 'siliconflow',
      baseUrl: validatedBaseUrl(video.baseUrl),
      apiKey: nonEmptyString(video.apiKey),
      model: nonEmptyString(video.model),
      size: nonEmptyString(video.size),
      sizeField: video.sizeField === 'size' ? 'size' : 'image_size',
      duration: boundedInteger(video.duration, 5, 1, 60),
      negativePrompt: typeof video.negativePrompt === 'string' ? video.negativePrompt : '',
      createPath: nonEmptyString(video.createPath, VIDEO_CREATE_PATH),
      queryPath: nonEmptyString(video.queryPath, VIDEO_QUERY_PATH),
      queryMethod: String(video.queryMethod ?? 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST',
      requestFormat: video.requestFormat === 'multipart' ? 'multipart' : 'json',
      idField: nonEmptyString(video.idField, 'requestId'),
      statusField: nonEmptyString(video.statusField, 'status'),
      resultField: nonEmptyString(video.resultField, 'results.videos.0.url'),
      successValues: nonEmptyString(video.successValues, 'Succeed,SUCCEEDED,completed,succeeded,success'),
      failureValues: nonEmptyString(video.failureValues, 'Failed,FAILED,failed,error,cancelled'),
      pollIntervalMs: boundedInteger(video.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, 500, 60000),
      maxWaitMs: boundedInteger(video.maxWaitMs, DEFAULT_VIDEO_TIMEOUT_MS, 10000, 1800000),
      extraBody: typeof video.extraBody === 'string' ? video.extraBody : ''
    }
  }
}

function parseExtraBody(raw, label) {
  const text = String(raw ?? '').trim()
  if (text === '') return {}
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new OutputError(`${label}的自定义参数不是合法 JSON：${shortMessage(error?.message ?? String(error), 120)}`, {
      code: 'INVALID_EXTRA_BODY',
      cause: error
    })
  }
  if (!isPlainObject(value)) throw new OutputError(`${label}的自定义参数必须是 JSON 对象`, { code: 'INVALID_EXTRA_BODY' })
  return value
}

function splitValues(raw) {
  return String(raw ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
}

function isSuccessStatus(status, successValues) {
  return successValues.includes(String(status ?? '').trim().toLowerCase())
}

function isFailureStatus(status, failureValues) {
  return failureValues.includes(String(status ?? '').trim().toLowerCase())
}

const OPENAI_STYLE_PREFIX = /^\/(?:images|audio|videos|models|chat)(?:\/|$)/i

/**
 * Join a provider base URL and a request path.
 *
 * Most OpenAI-compatible gateways expect `https://host/v1/...`. Users often
 * paste only `https://host` as the Base URL, which used to produce
 * `https://host/images/generations` and a confusing 404. For the standard
 * OpenAI endpoints we therefore insert `/v1` when the base has no path at all;
 * custom bases that already contain a path (including `/v1`, `/openai/v1`, …)
 * are left untouched. A duplicate `/v1` is also collapsed.
 */
export function resolveApiUrl(baseUrl, requestPath) {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '')
  if (base === '') return ''
  let suffix = String(requestPath ?? '').trim()
  if (suffix === '') return base
  if (/^https?:\/\//i.test(suffix)) return suffix
  if (!suffix.startsWith('/')) suffix = `/${suffix}`
  let basePath = ''
  try {
    basePath = new URL(base).pathname.replace(/\/+$/, '')
  } catch {
    basePath = ''
  }
  if (/\/v1$/i.test(basePath) && /^\/v1(?:\/|$)/i.test(suffix)) {
    suffix = suffix.replace(/^\/v1/i, '')
  }
  const hasPath = basePath !== '' && basePath !== '/'
  if (!hasPath && OPENAI_STYLE_PREFIX.test(suffix)) {
    return `${base}/v1${suffix}`
  }
  return `${base}${suffix}`
}

function joinUrl(baseUrl, requestPath) {
  return resolveApiUrl(baseUrl, requestPath)
}

function dataUrlBase64(value) {
  const text = String(value ?? '')
  const comma = text.indexOf(',')
  return text.startsWith('data:') && comma >= 0
}

function isLikelyBase64(value) {
  const text = String(value ?? '').trim()
  if (text.length < 64) return false
  const payload = text.startsWith('data:') ? text.slice(text.indexOf(',') + 1) : text
  if (payload.length < 64) return false
  return /^[A-Za-z0-9+/=_\-\s]+$/.test(payload)
}

function collectImageCandidates(payload) {
  const out = []
  const seen = new Set()
  const pushUrl = (url) => {
    const value = typeof url === 'string' ? url.trim() : ''
    if (!/^https?:\/\//i.test(value) || seen.has(`u:${value}`)) return
    seen.add(`u:${value}`)
    out.push({ url: value })
  }
  const pushBase64 = (value) => {
    const text = typeof value === 'string' ? value.trim() : ''
    if (text === '') return
    out.push({ b64: text })
  }
  const item = (value) => {
    if (typeof value === 'string') {
      if (/^https?:\/\//i.test(value.trim())) pushUrl(value)
      else if (isLikelyBase64(value)) pushBase64(value)
      return
    }
    if (!isPlainObject(value)) return
    for (const key of ['b64_json', 'b64', 'base64', 'image_base64']) {
      if (typeof value[key] === 'string' && value[key].trim() !== '') {
        pushBase64(value[key])
        return
      }
    }
    const image = value.image
    if (typeof image === 'string' && (isLikelyBase64(image) || dataUrlBase64(image))) {
      pushBase64(image)
      return
    }
    for (const key of ['url', 'image_url', 'imageUrl']) {
      const candidate = value[key]
      if (typeof candidate === 'string') {
        pushUrl(candidate)
        return
      }
      if (isPlainObject(candidate) && typeof candidate.url === 'string') {
        pushUrl(candidate.url)
        return
      }
    }
  }
  const arrays = []
  if (Array.isArray(payload?.data)) arrays.push(payload.data)
  if (Array.isArray(payload?.images)) arrays.push(payload.images)
  if (Array.isArray(payload?.output)) arrays.push(payload.output)
  if (Array.isArray(payload?.data?.images)) arrays.push(payload.data.images)
  if (isPlainObject(payload?.data) && Array.isArray(payload.data.images)) arrays.push(payload.data.images)
  for (const list of arrays) for (const entry of list) item(entry)
  if (out.length === 0) item(payload)
  return out
}

function firstHttpUrl(payload, depth = 0) {
  if (depth > 6 || payload === null || payload === undefined) return ''
  if (typeof payload === 'string') return /^https?:\/\//i.test(payload.trim()) ? payload.trim() : ''
  if (Array.isArray(payload)) {
    for (const entry of payload) {
      const found = firstHttpUrl(entry, depth + 1)
      if (found !== '') return found
    }
    return ''
  }
  if (!isPlainObject(payload)) return ''
  const preferred = ['url', 'video_url', 'videoUrl', 'output_url', 'outputUrl', 'file_url', 'fileUrl']
  for (const key of preferred) {
    if (typeof payload[key] === 'string' && /^https?:\/\//i.test(payload[key].trim())) return payload[key].trim()
  }
  for (const value of Object.values(payload)) {
    const found = firstHttpUrl(value, depth + 1)
    if (found !== '') return found
  }
  return ''
}

function collectAudioCandidate(payload) {
  if (payload === null || payload === undefined) return undefined
  if (typeof payload === 'string') {
    if (/^https?:\/\//i.test(payload.trim())) return { url: payload.trim() }
    if (isLikelyBase64(payload)) return { b64: payload }
    return undefined
  }
  if (Array.isArray(payload)) {
    for (const entry of payload) {
      const found = collectAudioCandidate(entry)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (!isPlainObject(payload)) return undefined
  for (const key of ['b64_json', 'b64', 'base64', 'audio_base64']) {
    if (typeof payload[key] === 'string' && payload[key].trim() !== '') return { b64: payload[key] }
  }
  for (const key of ['audio', 'data', 'output', 'result']) {
    const value = payload[key]
    if (typeof value === 'string') {
      const text = value.trim()
      if (/^https?:\/\//i.test(text)) return { url: text }
      if (text !== '') return { b64: text }
    } else {
      const found = collectAudioCandidate(value)
      if (found !== undefined) return found
    }
  }
  for (const key of ['url', 'audio_url', 'audioUrl']) {
    if (typeof payload[key] === 'string' && /^https?:\/\//i.test(payload[key].trim())) {
      return { url: payload[key].trim() }
    }
  }
  return undefined
}

function providerErrorDetail(buffer) {
  const raw = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer ?? '')
  let detail = raw
  try {
    const payload = JSON.parse(raw)
    detail = String(payload?.error?.message ?? payload?.error ?? payload?.message ?? payload?.msg ?? raw)
  } catch {
    // keep the raw snippet
  }
  return shortMessage(detail, 240)
}

function contentTypeOf(headers) {
  if (headers === null || headers === undefined || typeof headers.get !== 'function') return ''
  try {
    return String(headers.get('content-type') ?? '')
  } catch {
    return ''
  }
}

/**
 * @param {{
 *   configStore: { get(): object },
 *   store: object,
 *   referenceStore?: object,
 *   logger?: object,
 *   fetchImpl?: typeof fetch,
 *   sleepImpl?: (ms: number) => Promise<void>
 * }} deps
 */
export function createOutputClient({ configStore, store, referenceStore, logger, fetchImpl, sleepImpl } = {}) {
  if (store === null || typeof store !== 'object' || typeof store.add !== 'function') {
    throw new Error('createOutputClient 需要 outputStore')
  }
  const log = logger ?? { debug() {}, info() {}, warn() {}, error() {} }
  const injectedFetch = typeof fetchImpl === 'function' ? fetchImpl : undefined
  const wait = typeof sleepImpl === 'function' ? sleepImpl : sleep

  function currentSettings() {
    return readSettings(readConfigStore(configStore, logger))
  }

  function resolveFetch() {
    const fetchFn = injectedFetch ?? globalThis.fetch
    if (typeof fetchFn !== 'function') throw new OutputError('当前环境没有可用的 fetch', { code: 'NO_FETCH' })
    return fetchFn
  }

  function resolveSection(kind, { requireGlobal = true, requireEnabled = true } = {}) {
    const settings = currentSettings()
    const label = MODALITY_LABELS[kind]
    if (!label) throw new OutputError(`不支持的多模态输出类型：${String(kind ?? '') || '(空)'}`, { code: 'UNSUPPORTED_KIND' })
    if (requireGlobal && settings.enabled !== true) {
      throw new OutputError('多模态输出未启用（output.enabled=false）', { code: 'OUTPUT_NOT_ENABLED' })
    }
    const section = settings[kind]
    if (requireEnabled && section.enabled !== true) {
      throw new OutputError(`${label}输出未启用（output.${kind}.enabled=false）`, { code: 'MODALITY_DISABLED' })
    }
    if (section.baseUrl === '' || section.apiKey === '' || section.model === '') {
      throw new OutputError(`${label}输出配置不完整：需要 baseUrl / apiKey / model`, { code: 'OUTPUT_NOT_CONFIGURED' })
    }
    return { settings, section, label }
  }

  async function fetchBuffer({ url, method = 'GET', headers, body, timeoutMs, signal, maxBytes }) {
    const fetchFn = resolveFetch()
    if (signal !== undefined && signal !== null && signal.aborted === true) {
      throw new OutputError('多模态输出请求已取消', { code: 'ABORTED' })
    }
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        controller.abort()
      } catch {
        // ignore
      }
    }, positiveNumber(timeoutMs, DEFAULT_TIMEOUT_MS))
    timer.unref?.()
    const onAbort = () => controller.abort()
    const externalSignal = signal !== undefined && signal !== null && typeof signal.addEventListener === 'function'
    if (externalSignal) signal.addEventListener('abort', onAbort, { once: true })
    try {
      let response
      try {
        response = await fetchFn(url, { method, headers, body, signal: controller.signal })
      } catch (error) {
        if (timedOut) throw new OutputError(`多模态输出请求超时（${positiveNumber(timeoutMs, DEFAULT_TIMEOUT_MS)}ms）`, { code: 'TIMEOUT', cause: error })
        if (signal?.aborted === true) throw new OutputError('多模态输出请求已取消', { code: 'ABORTED', cause: error })
        throw new OutputError(`多模态输出请求失败：${shortMessage(error?.message ?? String(error), 200)}`, { code: 'NETWORK', cause: error })
      }
      if (response === null || typeof response !== 'object') {
        throw new OutputError('多模态输出接口没有返回响应', { code: 'INVALID_RESPONSE' })
      }
      let buffer
      try {
        buffer = Buffer.from(await response.arrayBuffer())
      } catch (error) {
        if (timedOut) throw new OutputError('多模态输出响应读取超时', { code: 'TIMEOUT', cause: error })
        throw new OutputError(`读取多模态输出响应失败：${shortMessage(error?.message ?? String(error), 160)}`, { code: 'READ_ERROR', cause: error })
      }
      if (timedOut) throw new OutputError(`多模态输出请求超时（${positiveNumber(timeoutMs, DEFAULT_TIMEOUT_MS)}ms）`, { code: 'TIMEOUT' })
      if (signal?.aborted === true) throw new OutputError('多模态输出请求已取消', { code: 'ABORTED' })
      const limit = positiveNumber(maxBytes, DEFAULT_MAX_BYTES)
      if (buffer.length > limit) {
        throw new OutputError(`多模态输出响应过大（${buffer.length} > ${limit} 字节）`, { code: 'MEDIA_TOO_LARGE' })
      }
      return { status: Number(response.status) || 0, ok: response.ok === true, headers: response.headers, buffer }
    } finally {
      clearTimeout(timer)
      if (externalSignal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort)
    }
  }

  function assertHttpOk(response, label) {
    if (response.ok) return
    const status = response.status
    const detail = providerErrorDetail(response.buffer)
    let hint = ''
    if (status === 401 || status === 403) hint = '（API Key 无效或没有该模型的权限）'
    else if (status === 404) hint = '（请检查 Base URL 是否到 /v1 层级，以及接口路径是否正确）'
    throw new OutputError(`${label}接口 HTTP ${status}${hint}：${detail || '服务商未返回错误详情'}`, {
      code: `HTTP_${status}`,
      status
    })
  }

  async function requestJson({ url, method = 'POST', headers, body, timeoutMs, signal, maxBytes = DEFAULT_MAX_BYTES, label }) {
    const response = await fetchBuffer({ url, method, headers, body, timeoutMs, signal, maxBytes })
    assertHttpOk(response, label)
    const text = response.buffer.toString('utf8')
    if (text.trim() === '') throw new OutputError(`${label}接口返回空响应`, { code: 'EMPTY_RESPONSE' })
    try {
      return JSON.parse(text)
    } catch (error) {
      throw new OutputError(`${label}接口返回的不是合法 JSON：${shortMessage(text, 120)}`, {
        code: 'INVALID_RESPONSE',
        cause: error
      })
    }
  }

  async function requestBinary({ url, method = 'POST', headers, body, timeoutMs, signal, maxBytes, label }) {
    const response = await fetchBuffer({ url, method, headers, body, timeoutMs, signal, maxBytes })
    assertHttpOk(response, label)
    return response
  }

  function authHeaders(section) {
    return { authorization: `Bearer ${section.apiKey}` }
  }

  function jsonHeaders(section, extra = {}) {
    return { 'content-type': 'application/json', ...authHeaders(section), ...extra }
  }

  function composePrompt(settings, prompt, { withPrefix = true } = {}) {
    const value = String(prompt ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_PROMPT_CHARS)
    if (value === '') throw new OutputError('生成提示词不能为空', { code: 'INVALID_PROMPT' })
    const prefix = withPrefix ? String(settings.promptPrefix ?? '').trim() : ''
    return prefix === '' ? value : `${prefix}\n${value}`
  }

  /**
   * Download a provider result URL. Deliberately does not reuse the inbound
   * multimodal downloader: generated assets can be WebM/FLAC/M4A and should be
   * stored even when QQ cannot send them directly.
   */
  async function downloadGenerated({ url, kind, settings, signal }) {
    let response
    try {
      response = await fetchBuffer({
        url,
        method: 'GET',
        timeoutMs: Math.max(60000, settings.timeoutMs),
        signal,
        maxBytes: settings.maxBytes
      })
    } catch (error) {
      throw new OutputError(`下载生成的${MODALITY_LABELS[kind]}失败：${shortMessage(error?.message ?? String(error), 200)}`, {
        code: error?.code ?? 'DOWNLOAD_FAILED',
        cause: error
      })
    }
    assertHttpOk(response, `下载${MODALITY_LABELS[kind]}`)
    const contentHint = contentTypeOf(response.headers)
    const mime = sniffGeneratedMime(response.buffer, kind, contentHint)
    if (mime === '' || !mime.startsWith(`${kind}/`)) {
      throw new OutputError(`下载内容不是可识别的${MODALITY_LABELS[kind]}（${contentHint || '未知类型'}）`, {
        code: 'UNSUPPORTED_MEDIA'
      })
    }
    return { buffer: response.buffer, mime, contentType: contentHint }
  }

  async function materializeCandidate(candidate, kind, { section, settings, signal }) {
    if (candidate === null || typeof candidate !== 'object') {
      throw new OutputError(`服务商没有返回${MODALITY_LABELS[kind]}内容`, { code: 'EMPTY_RESPONSE' })
    }
    if (typeof candidate.b64 === 'string' && candidate.b64.trim() !== '') {
      const buffer = decodeBase64Payload(candidate.b64)
      if (buffer.length === 0) throw new OutputError(`服务商返回的${MODALITY_LABELS[kind]} base64 无法解码`, { code: 'INVALID_RESPONSE' })
      if (buffer.length > settings.maxBytes) {
        throw new OutputError(`${MODALITY_LABELS[kind]}结果过大（${buffer.length} > ${settings.maxBytes} 字节）`, { code: 'MEDIA_TOO_LARGE' })
      }
      return buffer
    }
    if (typeof candidate.url === 'string' && candidate.url !== '') {
      const downloaded = await downloadGenerated({ url: candidate.url, kind, settings, signal })
      return downloaded.buffer
    }
    throw new OutputError(`服务商没有返回${MODALITY_LABELS[kind]}地址或内容`, { code: 'EMPTY_RESPONSE' })
  }

  function finalizeMime(kind, buffer, hint) {
    const mime = sniffGeneratedMime(buffer, kind, hint)
    if (mime === '' || !mime.startsWith(`${kind}/`)) {
      throw new OutputError(`无法识别生成的${MODALITY_LABELS[kind]}格式：${mime || '未知'}`, { code: 'UNSUPPORTED_MEDIA' })
    }
    return mime
  }

  async function saveRecords({ kind, assets, prompt, model, source }) {
    const records = []
    for (const asset of assets) {
      const record = await store.add({
        kind,
        buffer: asset.buffer,
        mime: asset.mime,
        ext: extensionForMime(asset.mime),
        prompt,
        provider: providerLabel(asset.baseUrl ?? ''),
        model,
        durationMs: asset.durationMs ?? 0,
        source: source ?? { kind: 'admin' },
        ...(asset.referenceId ? { referenceId: asset.referenceId } : {})
      })
      records.push(record)
    }
    if (records.length === 0) throw new OutputError('生成接口没有返回可用内容', { code: 'EMPTY_RESPONSE' })
    return records
  }

  function referenceKeywords(raw) {
    return String(raw ?? '')
      .split(/[,，、;；|/\n]+|\s{2,}/)
      .map((value) => value.trim())
      .filter((value) => value !== '')
  }

  /** Whether this prompt makes the bot itself the subject of the image. */
  function shouldUseReference(prompt, settings) {
    const reference = settings.image.reference
    if (reference.enabled !== true) return false
    if (reference.trigger === 'always') return true
    const keywords = new Set(referenceKeywords(reference.keywords))
    const config = readConfigStore(configStore, logger)
    const personaName = typeof config.persona?.name === 'string' ? config.persona.name.trim() : ''
    if (personaName !== '') keywords.add(personaName)
    const text = String(prompt ?? '').toLowerCase()
    for (const keyword of keywords) {
      if (keyword !== '' && text.includes(keyword.toLowerCase())) return true
    }
    return false
  }

  async function loadReference(settings, prompt) {
    const reference = settings.image.reference
    if (!shouldUseReference(prompt, settings)) return null
    if (reference.id === '') {
      throw new OutputError('已启用角色形象参考，但还没有选择参考图片；请到「多模态输出 → 角色形象参考」上传并设为当前', {
        code: 'REFERENCE_MISSING'
      })
    }
    if (referenceStore === undefined || referenceStore === null || typeof referenceStore.get !== 'function') {
      throw new OutputError('角色形象参考存储不可用', { code: 'REFERENCE_UNAVAILABLE' })
    }
    const record = await referenceStore.get(reference.id)
    if (record === undefined || record === null) {
      throw new OutputError('当前角色参考图片不存在，可能已被删除；请重新上传并设为当前', { code: 'REFERENCE_MISSING' })
    }
    let buffer
    try {
      buffer = await fsp.readFile(referenceStore.filePath(record))
    } catch (error) {
      throw new OutputError(`读取角色参考图片失败：${shortMessage(error?.message ?? String(error), 160)}`, {
        code: 'REFERENCE_READ_ERROR',
        cause: error
      })
    }
    if (buffer.length > reference.maxBytes) {
      throw new OutputError(`角色参考图片过大（${buffer.length} > ${reference.maxBytes} 字节）`, { code: 'REFERENCE_TOO_LARGE' })
    }
    return {
      record,
      buffer,
      fileName: typeof record.originalName === 'string' && record.originalName !== '' ? record.originalName : `${record.id}.${record.ext}`
    }
  }

  function withReferencePrompt(settings, prompt) {
    const prefix = String(settings.image.reference.promptPrefix ?? '').trim()
    return prefix === '' ? prompt : `${prefix}\n${prompt}`
  }

  async function imageAssetsFromPayload(payload, section, settings, signal, startedAt, referenceId) {
    if (isPlainObject(payload?.error)) {
      throw new OutputError(`图片生成失败：${shortMessage(payload.error.message ?? payload.error, 200)}`, { code: 'PROVIDER_ERROR' })
    }
    const candidates = collectImageCandidates(payload).slice(0, section.count)
    if (candidates.length === 0) throw new OutputError('图片生成接口没有返回图片内容', { code: 'EMPTY_RESPONSE' })
    const assets = []
    for (const candidate of candidates) {
      const buffer = await materializeCandidate(candidate, 'image', { section, settings, signal })
      assets.push({
        buffer,
        mime: finalizeMime('image', buffer, ''),
        baseUrl: section.baseUrl,
        durationMs: Date.now() - startedAt,
        ...(referenceId ? { referenceId } : {})
      })
    }
    return assets
  }

  function textImageBody(settings, prompt) {
    const section = settings.image
    // `n` / `batch_size` is only meaningful for batch generation. Sending an
    // explicit `"n": 1` for a single image is redundant and some providers
    // (especially Midjourney-compatible relays) treat it as an unknown
    // parameter, so omit it unless the user actually asked for >1 image.
    const countBody = section.countField !== 'none' && section.count > 1 ? { [section.countField]: section.count } : {}
    return {
      model: section.model,
      prompt,
      ...(section.size !== '' && section.sizeField !== 'none' ? { [section.sizeField]: section.size } : {}),
      ...countBody,
      ...(section.responseFormat !== '' ? { response_format: section.responseFormat } : {}),
      ...(section.quality !== '' ? { quality: section.quality } : {}),
      ...(section.style !== '' ? { style: section.style } : {}),
      ...parseExtraBody(section.extraBody, '图片输出')
    }
  }

  async function requestTextImageAssets(settings, prompt, { signal } = {}) {
    const section = settings.image
    const startedAt = Date.now()
    const payload = await requestJson({
      url: joinUrl(section.baseUrl, section.path),
      headers: jsonHeaders(section),
      body: JSON.stringify(textImageBody(settings, prompt)),
      timeoutMs: settings.timeoutMs,
      signal,
      maxBytes: Math.min(settings.maxBytes * 2 + 1048576, 419430400),
      label: '图片生成'
    })
    return imageAssetsFromPayload(payload, section, settings, signal, startedAt)
  }

  function imageFormData(settings, prompt, reference) {
    const section = settings.image
    const form = new FormData()
    form.append(section.reference.field, new Blob([reference.buffer], { type: reference.record.mime }), reference.fileName)
    form.append('model', section.model)
    form.append('prompt', prompt)
    if (section.size !== '' && section.sizeField !== 'none') form.append(section.sizeField, section.size)
    if (section.countField !== 'none' && section.count > 1) form.append(section.countField, String(section.count))
    if (section.responseFormat !== '') form.append('response_format', section.responseFormat)
    if (section.quality !== '') form.append('quality', section.quality)
    if (section.style !== '') form.append('style', section.style)
    const extra = parseExtraBody(section.extraBody, '图片输出')
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined || value === null) continue
      form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
    }
    return form
  }

  async function requestReferenceImageAssets(settings, prompt, reference, { signal } = {}) {
    const section = settings.image
    const startedAt = Date.now()
    const referenceSettings = section.reference
    if (referenceSettings.requestMode === 'edits') {
      const payload = await requestJson({
        url: joinUrl(section.baseUrl, referenceSettings.path),
        headers: authHeaders(section),
        body: imageFormData(settings, prompt, reference),
        timeoutMs: settings.timeoutMs,
        signal,
        maxBytes: Math.min(settings.maxBytes * 2 + 1048576, 419430400),
        label: '图片参考生成'
      })
      return imageAssetsFromPayload(payload, section, settings, signal, startedAt, reference.record.id)
    }
    const body = textImageBody(settings, prompt)
    const field = referenceSettings.field
    body[field] =
      referenceSettings.format === 'base64'
        ? reference.buffer.toString('base64')
        : `data:${reference.record.mime};base64,${reference.buffer.toString('base64')}`
    const payload = await requestJson({
      url: joinUrl(section.baseUrl, section.path),
      headers: jsonHeaders(section),
      body: JSON.stringify(body),
      timeoutMs: settings.timeoutMs,
      signal,
      maxBytes: Math.min(settings.maxBytes * 2 + 1048576, 419430400),
      label: '图片参考生成'
    })
    return imageAssetsFromPayload(payload, section, settings, signal, startedAt, reference.record.id)
  }

  async function generateImages(settings, prompt, { signal, source, userPrompt } = {}) {
    const section = settings.image
    const reference = await loadReference(settings, userPrompt === undefined ? prompt : userPrompt)
    const requestPrompt = reference === null ? prompt : withReferencePrompt(settings, prompt)
    let assets
    let usedReference = false
    if (reference !== null) {
      try {
        assets = await requestReferenceImageAssets(settings, requestPrompt, reference, { signal })
        usedReference = true
        log.debug?.('使用角色参考图生成图片', {
          model: section.model,
          referenceId: reference.record.id,
          mode: section.reference.requestMode
        })
      } catch (error) {
        if (section.reference.fallbackToText !== true) throw error
        log.warn?.('角色参考图生成失败，回退为纯文生图', {
          model: section.model,
          referenceId: reference.record.id,
          code: error?.code,
          error: shortMessage(error?.message ?? String(error), 200)
        })
        assets = await requestTextImageAssets(settings, prompt, { signal })
      }
    } else {
      assets = await requestTextImageAssets(settings, prompt, { signal })
    }
    log.debug?.('图片生成完成', { count: assets.length, model: section.model, bytes: assets.reduce((sum, item) => sum + item.buffer.length, 0) })
    return saveRecords({ kind: 'image', assets, prompt: usedReference ? requestPrompt : prompt, model: section.model, source })
  }

  async function generateSpeech(settings, prompt, { signal, source }) {
    const section = settings.audio
    const startedAt = Date.now()
    const body = {
      model: section.model,
      input: prompt,
      voice: section.voice,
      response_format: section.format,
      speed: section.speed,
      ...parseExtraBody(section.extraBody, '语音输出')
    }
    const response = await requestBinary({
      url: joinUrl(section.baseUrl, section.path),
      headers: jsonHeaders(section),
      body: JSON.stringify(body),
      timeoutMs: settings.timeoutMs,
      signal,
      maxBytes: settings.maxBytes,
      label: '语音生成'
    })
    const contentType = contentTypeOf(response.headers)
    let buffer = response.buffer
    let hint = contentType
    const looksJson = contentType.includes('json') || (buffer.length > 0 && buffer[0] === 0x7b)
    if (looksJson) {
      let payload
      try {
        payload = JSON.parse(buffer.toString('utf8'))
      } catch (error) {
        throw new OutputError('语音生成接口返回了无法解析的 JSON', { code: 'INVALID_RESPONSE', cause: error })
      }
      if (isPlainObject(payload?.error)) {
        throw new OutputError(`语音生成失败：${shortMessage(payload.error.message ?? payload.error, 200)}`, { code: 'PROVIDER_ERROR' })
      }
      const candidate = collectAudioCandidate(payload)
      if (candidate === undefined) throw new OutputError('语音生成接口没有返回音频内容', { code: 'EMPTY_RESPONSE' })
      buffer = await materializeCandidate(candidate, 'audio', { section, settings, signal })
      hint = mimeForFormat(section.format)
    }
    if (buffer.length === 0) throw new OutputError('语音生成接口返回空音频', { code: 'EMPTY_RESPONSE' })
    if (buffer.length > settings.maxBytes) {
      throw new OutputError(`语音结果过大（${buffer.length} > ${settings.maxBytes} 字节）`, { code: 'MEDIA_TOO_LARGE' })
    }
    const mime = finalizeMime('audio', buffer, hint || mimeForFormat(section.format))
    log.debug?.('语音生成完成', { model: section.model, bytes: buffer.length, mime })
    return saveRecords({
      kind: 'audio',
      assets: [{ buffer, mime, baseUrl: section.baseUrl, durationMs: Date.now() - startedAt }],
      prompt,
      model: section.model,
      settings,
      source
    })
  }

  async function pollUntil(check, { intervalMs, maxWaitMs, signal, label }) {
    const startedAt = Date.now()
    let attempt = 0
    while (true) {
      if (signal !== undefined && signal !== null && signal.aborted === true) {
        throw new OutputError(`${label}轮询已取消`, { code: 'ABORTED' })
      }
      attempt += 1
      const result = await check(attempt)
      if (result.state === 'success') return result.payload
      if (result.state === 'failure') {
        throw new OutputError(`${label}失败：${result.reason || '服务商返回失败状态'}`, { code: 'TASK_FAILED' })
      }
      const elapsed = Date.now() - startedAt
      if (elapsed >= maxWaitMs) {
        throw new OutputError(`${label}超时（已等待 ${Math.round(elapsed / 1000)} 秒）`, { code: 'TASK_TIMEOUT' })
      }
      if (attempt % 10 === 0) log.debug?.(`${label}仍在生成`, { attempt, elapsedMs: elapsed })
      await wait(Math.min(intervalMs, Math.max(0, maxWaitMs - elapsed)))
    }
  }

  function videoStatusValues(section) {
    return {
      success: splitValues(section.successValues),
      failure: splitValues(section.failureValues)
    }
  }

  async function downloadVideoResult(section, settings, url, signal, startedAt) {
    if (typeof url !== 'string' || url === '') throw new OutputError('视频生成成功但没有返回视频地址', { code: 'INVALID_RESPONSE' })
    const downloaded = await downloadGenerated({ url, kind: 'video', settings, signal })
    return { buffer: downloaded.buffer, mime: downloaded.mime, baseUrl: section.baseUrl, durationMs: Date.now() - startedAt }
  }

  async function generateSiliconflowVideo(settings, section, prompt, { signal, source }) {
    const startedAt = Date.now()
    const body = {
      model: section.model,
      prompt,
      ...(section.size !== '' ? { image_size: section.size } : {}),
      ...(section.negativePrompt.trim() !== '' ? { negative_prompt: section.negativePrompt.trim() } : {}),
      ...parseExtraBody(section.extraBody, '视频输出')
    }
    const submitted = await requestJson({
      url: joinUrl(section.baseUrl, VIDEO_CREATE_PATH),
      headers: jsonHeaders(section),
      body: JSON.stringify(body),
      timeoutMs: settings.timeoutMs,
      signal,
      maxBytes: 4 * 1024 * 1024,
      label: '视频生成提交'
    })
    const requestId = submitted?.requestId ?? submitted?.id ?? submitted?.data?.requestId ?? submitted?.data?.id
    if (typeof requestId !== 'string' || requestId === '') {
      throw new OutputError('视频生成接口没有返回任务 id（requestId）', { code: 'INVALID_RESPONSE' })
    }
    const values = videoStatusValues(section)
    const payload = await pollUntil(
      async () => {
        const statusPayload = await requestJson({
          url: joinUrl(section.baseUrl, VIDEO_QUERY_PATH),
          headers: jsonHeaders(section),
          body: JSON.stringify({ requestId }),
          timeoutMs: settings.timeoutMs,
          signal,
          maxBytes: 4 * 1024 * 1024,
          label: '视频生成状态'
        })
        const status = statusPayload?.status
        if (isFailureStatus(status, values.failure)) {
          return { state: 'failure', reason: shortMessage(statusPayload?.reason ?? statusPayload?.message ?? status, 200) }
        }
        if (isSuccessStatus(status, values.success)) return { state: 'success', payload: statusPayload }
        return { state: 'pending' }
      },
      { intervalMs: section.pollIntervalMs, maxWaitMs: section.maxWaitMs, signal, label: '视频生成' }
    )
    const url = dotGet(payload, 'results.videos.0.url') ?? dotGet(payload, 'data.results.videos.0.url') ?? firstHttpUrl(payload)
    const asset = await downloadVideoResult(section, settings, url, signal, startedAt)
    log.debug?.('视频生成完成', { model: section.model, bytes: asset.buffer.length })
    return saveRecords({ kind: 'video', assets: [asset], prompt, model: section.model, settings, source })
  }

  async function generateOpenAIVideo(settings, section, prompt, { signal, source }) {
    const startedAt = Date.now()
    let body
    if (section.requestFormat === 'multipart') {
      const form = new FormData()
      form.append('model', section.model)
      form.append('prompt', prompt)
      form.append('seconds', String(section.duration))
      if (section.size !== '') form.append('size', section.size)
      body = form
    } else {
      body = JSON.stringify({
        model: section.model,
        prompt,
        seconds: String(section.duration),
        ...(section.size !== '' ? { size: section.size } : {}),
        ...parseExtraBody(section.extraBody, '视频输出')
      })
    }
    const submitted = await requestJson({
      url: joinUrl(section.baseUrl, OPENAI_VIDEO_CREATE_PATH),
      headers: section.requestFormat === 'multipart' ? authHeaders(section) : jsonHeaders(section),
      body,
      timeoutMs: settings.timeoutMs,
      signal,
      maxBytes: 4 * 1024 * 1024,
      label: '视频生成提交'
    })
    const taskId = submitted?.id ?? submitted?.task_id ?? dotGet(submitted, section.idField)
    if (typeof taskId !== 'string' || taskId === '') {
      throw new OutputError('视频生成接口没有返回任务 id', { code: 'INVALID_RESPONSE' })
    }
    const values = videoStatusValues(section)
    const payload = await pollUntil(
      async () => {
        const statusPayload = await requestJson({
          url: joinUrl(section.baseUrl, `/videos/${encodeURIComponent(taskId)}`),
          method: 'GET',
          headers: authHeaders(section),
          timeoutMs: settings.timeoutMs,
          signal,
          maxBytes: 4 * 1024 * 1024,
          label: '视频生成状态'
        })
        const status = dotGet(statusPayload, section.statusField) ?? statusPayload?.status
        if (isFailureStatus(status, values.failure)) {
          return { state: 'failure', reason: shortMessage(statusPayload?.error?.message ?? statusPayload?.error ?? status, 200) }
        }
        if (isSuccessStatus(status, values.success)) return { state: 'success', payload: statusPayload }
        return { state: 'pending' }
      },
      { intervalMs: section.pollIntervalMs, maxWaitMs: section.maxWaitMs, signal, label: '视频生成' }
    )
    let asset
    try {
      const response = await requestBinary({
        url: joinUrl(section.baseUrl, `/videos/${encodeURIComponent(taskId)}/content`),
        method: 'GET',
        headers: authHeaders(section),
        timeoutMs: Math.max(60000, settings.timeoutMs),
        signal,
        maxBytes: settings.maxBytes,
        label: '视频下载'
      })
      const mime = finalizeMime('video', response.buffer, contentTypeOf(response.headers))
      asset = { buffer: response.buffer, mime, baseUrl: section.baseUrl, durationMs: Date.now() - startedAt }
    } catch (error) {
      const fallbackUrl = dotGet(payload, section.resultField) ?? firstHttpUrl(payload)
      if (typeof fallbackUrl !== 'string' || fallbackUrl === '') throw error
      asset = await downloadVideoResult(section, settings, fallbackUrl, signal, startedAt)
    }
    log.debug?.('视频生成完成', { model: section.model, bytes: asset.buffer.length, preset: 'openai' })
    return saveRecords({ kind: 'video', assets: [asset], prompt, model: section.model, settings, source })
  }

  async function generateCustomVideo(settings, section, prompt, { signal, source }) {
    const startedAt = Date.now()
    const baseBody = {
      model: section.model,
      prompt,
      ...(section.size !== '' && section.sizeField !== 'none' ? { [section.sizeField]: section.size } : {}),
      ...parseExtraBody(section.extraBody, '视频输出')
    }
    let createBody = JSON.stringify(baseBody)
    let createHeaders = jsonHeaders(section)
    if (section.requestFormat === 'multipart') {
      const form = new FormData()
      for (const [key, value] of Object.entries(baseBody)) {
        if (value !== undefined && value !== null && typeof value !== 'object') form.append(key, String(value))
      }
      createBody = form
      createHeaders = authHeaders(section)
    }
    const submitted = await requestJson({
      url: joinUrl(section.baseUrl, section.createPath),
      headers: createHeaders,
      body: createBody,
      timeoutMs: settings.timeoutMs,
      signal,
      maxBytes: 4 * 1024 * 1024,
      label: '视频生成提交'
    })
    const taskId = dotGet(submitted, section.idField) ?? submitted?.id ?? submitted?.task_id
    if (typeof taskId !== 'string' || taskId === '') {
      throw new OutputError(`视频生成接口没有返回任务 id（字段：${section.idField}）`, { code: 'INVALID_RESPONSE' })
    }
    const values = videoStatusValues(section)
    const pollUrl = joinUrl(section.baseUrl, section.queryPath.replaceAll('{id}', encodeURIComponent(taskId)))
    const queryBodyField = section.idField.split('.').filter(Boolean).pop() || 'id'
    const payload = await pollUntil(
      async () => {
        const statusPayload = await requestJson({
          url: pollUrl,
          method: section.queryMethod,
          headers: section.queryMethod === 'GET' ? authHeaders(section) : jsonHeaders(section),
          ...(section.queryMethod === 'GET' ? {} : { body: JSON.stringify({ [queryBodyField]: taskId }) }),
          timeoutMs: settings.timeoutMs,
          signal,
          maxBytes: 4 * 1024 * 1024,
          label: '视频生成状态'
        })
        const status = dotGet(statusPayload, section.statusField) ?? statusPayload?.status
        if (isFailureStatus(status, values.failure)) {
          return { state: 'failure', reason: shortMessage(dotGet(statusPayload, 'reason') ?? dotGet(statusPayload, 'message') ?? status, 200) }
        }
        if (isSuccessStatus(status, values.success)) return { state: 'success', payload: statusPayload }
        return { state: 'pending' }
      },
      { intervalMs: section.pollIntervalMs, maxWaitMs: section.maxWaitMs, signal, label: '视频生成' }
    )
    const rawUrl = dotGet(payload, section.resultField) ?? firstHttpUrl(payload)
    const url = isPlainObject(rawUrl) ? rawUrl.url : rawUrl
    const asset = await downloadVideoResult(section, settings, url, signal, startedAt)
    log.debug?.('视频生成完成', { model: section.model, bytes: asset.buffer.length, preset: 'custom' })
    return saveRecords({ kind: 'video', assets: [asset], prompt, model: section.model, settings, source })
  }

  /**
   * Generate one output asset (image may return several records when
   * `output.image.count > 1`).
   *
   * @returns {Promise<{kind: string, records: object[], record: object}>}
   */
  async function generate({ kind, prompt, source, signal } = {}) {
    const type = String(kind ?? '').trim().toLowerCase()
    const { settings, section } = resolveSection(type)
    const text = composePrompt(settings, prompt, { withPrefix: type !== 'audio' })
    let records
    if (type === 'image') records = await generateImages(settings, text, { signal, source, userPrompt: prompt })
    else if (type === 'audio') records = await generateSpeech(settings, text, { signal, source })
    else if (settings.video.preset === 'openai') records = await generateOpenAIVideo(settings, section, text, { signal, source })
    else if (settings.video.preset === 'custom') records = await generateCustomVideo(settings, section, text, { signal, source })
    else records = await generateSiliconflowVideo(settings, section, text, { signal, source })
    return { kind: type, records, record: records[0] }
  }

  /**
   * Probe `GET /models` without generating (avoids cost).
   *
   * `/v1` is inserted automatically for a path-less OpenAI-style base URL, and
   * HTML responses (typically the provider's web console) are rejected instead
   * of being mistaken for a healthy API.
   */
  async function test({ kind } = {}) {
    const type = String(kind ?? '').trim().toLowerCase()
    const { settings, section, label } = resolveSection(type, { requireGlobal: false, requireEnabled: false })
    const startedAt = Date.now()
    const modelsUrl = joinUrl(section.baseUrl, MODELS_PATH)
    const requestUrl = joinUrl(section.baseUrl, type === 'video' ? section.createPath : section.path)
    let response
    try {
      response = await fetchBuffer({
        url: modelsUrl,
        headers: authHeaders(section),
        timeoutMs: Math.min(30000, settings.timeoutMs),
        maxBytes: 4 * 1024 * 1024
      })
    } catch (error) {
      throw new OutputError(`连接${label}接口失败：${shortMessage(error?.message ?? String(error), 200)}`, {
        code: error?.code ?? 'NETWORK',
        cause: error
      })
    }
    if (!response.ok) {
      const status = response.status
      if (status === 404 || status === 405 || status === 501) {
        return {
          ok: true,
          kind: type,
          mode: 'config-only',
          configured: true,
          url: modelsUrl,
          requestUrl,
          warning: `该服务商没有提供 /models 接口（${modelsUrl}），未能在线校验；请用下方「生成试跑」确认接口可用`,
          ms: Date.now() - startedAt
        }
      }
      assertHttpOk(response, `${label}接口`)
    }

    const contentType = contentTypeOf(response.headers)
    const rawText = response.buffer.toString('utf8').trim()
    if (contentType.includes('text/html') || rawText.startsWith('<')) {
      throw new OutputError(
        `${label}接口返回的是网页而不是 API JSON（${modelsUrl}）。OpenAI 兼容服务通常需要以 /v1 结尾的 Base URL，请检查配置`,
        { code: 'HTML_RESPONSE' }
      )
    }
    let payload
    try {
      payload = JSON.parse(rawText)
    } catch (error) {
      throw new OutputError(`${label}接口返回的不是合法 JSON（${modelsUrl}）：${shortMessage(rawText, 120)}`, {
        code: 'INVALID_RESPONSE',
        cause: error
      })
    }
    const models = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : []
    const modelCount = models.length
    let modelFound
    if (modelCount > 0) {
      modelFound = models.some((entry) => {
        const id = typeof entry === 'string' ? entry : entry?.id ?? entry?.name
        return typeof id === 'string' && id === section.model
      })
    }
    let suggestedBaseUrl
    try {
      const basePath = new URL(section.baseUrl).pathname.replace(/\/+$/, '')
      if (basePath === '' && modelsUrl !== `${section.baseUrl}${MODELS_PATH}`) suggestedBaseUrl = `${section.baseUrl}/v1`
    } catch {
      suggestedBaseUrl = undefined
    }
    return {
      ok: true,
      kind: type,
      mode: modelCount > 0 ? 'models' : 'reachable',
      configured: true,
      modelFound,
      modelCount,
      url: modelsUrl,
      requestUrl,
      suggestedBaseUrl,
      ms: Date.now() - startedAt
    }
  }

  /** Public status summary (never includes keys). */
  function status() {
    const settings = currentSettings()
    const describe = (kind) => {
      const section = settings[kind]
      const requestPath = kind === 'video' ? section.createPath : section.path
      return {
        enabled: section.enabled,
        configured: section.baseUrl !== '' && section.apiKey !== '' && section.model !== '',
        model: section.model,
        baseUrl: section.baseUrl,
        path: requestPath,
        requestUrl: section.baseUrl === '' ? '' : resolveApiUrl(section.baseUrl, requestPath),
        modelsUrl: section.baseUrl === '' ? '' : resolveApiUrl(section.baseUrl, MODELS_PATH),
        ...(kind === 'video' ? { preset: section.preset, queryPath: section.queryPath } : {}),
        ...(kind === 'image'
          ? {
              count: section.count,
              size: section.size,
              reference: {
                enabled: section.reference.enabled,
                configured: section.reference.id !== '',
                id: section.reference.id,
                trigger: section.reference.trigger,
                requestMode: section.reference.requestMode,
                keywords: section.reference.keywords
              }
            }
          : {}),
        ...(kind === 'audio' ? { format: section.format, voice: section.voice } : {})
      }
    }
    return {
      enabled: settings.enabled,
      sendToQQ: settings.sendToQQ,
      commandAccess: settings.commandAccess,
      allowModelDirectives: settings.allowModelDirectives,
      image: describe('image'),
      audio: describe('audio'),
      video: describe('video')
    }
  }

  return { status, test, generate, dotGet }
}
