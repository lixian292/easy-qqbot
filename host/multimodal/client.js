/**
 * Multimodal recognition client (OpenAI-compatible endpoints).
 *
 * One client handles three modalities:
 *   - image: chat/completions with an inline `image_url` data URL
 *   - audio: `audio/transcriptions` multipart (mode=transcribe) or
 *            chat/completions with `input_audio` (mode=chat)
 *   - video: ffmpeg frame extraction + per-frame image description (mode=frames)
 *            or chat/completions with `video_url` (mode=url)
 *
 * The surrounding chat pipeline decides whether recognition is worth the cost;
 * this module only implements the calls and surfaces typed errors. Injected
 * `fetchImpl` / `spawnImpl` keep tests offline and avoid invoking ffmpeg.
 */
import { MultimodalError, shortMessage } from './errors.js'
import { sniffMediaMimeType } from './download.js'
import { extractVideoFrames } from './frames.js'

export { MultimodalError } from './errors.js'

const DEFAULT_PROMPT =
  '请用中文简短描述这张图片/这段音视频的内容（1-2 句，最多 80 字）；如果是表情包/梗图，请说明画面、文字和表达的情绪。'
const DEFAULT_TIMEOUT_MS = 60000
const DEFAULT_MAX_BYTES = 16777216
const DEFAULT_FRAME_COUNT = 4
const DEFAULT_FRAME_INTERVAL_SEC = 1
const DEFAULT_AUDIO_MODE = 'transcribe'
const DEFAULT_VIDEO_MODE = 'frames'
const MAX_TOKENS = 240
const MAX_TEXT_CHARS = 300
const MAX_FRAME_COUNT = 16

const MODALITY_LABELS = { image: '图片', audio: '音频', video: '视频' }
const MIME_PREFIX = { image: 'image/', audio: 'audio/', video: 'video/' }
const AUDIO_EXTENSIONS = { 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg' }
const AUDIO_INPUT_FORMATS = { 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg' }

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function nonEmptyString(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

function positiveNumber(value, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function finiteInteger(value, fallback, { min, max }) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

function boolField(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
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

function readConfig(configStore, logger) {
  try {
    const config = configStore?.get?.() ?? {}
    return isPlainObject(config) ? config : {}
  } catch (error) {
    logger?.warn?.('读取多模态配置失败', { error: shortMessage(error?.message ?? String(error), 200) })
    return {}
  }
}

/** Normalize `config.multimodal` into a complete, typed settings object. */
function readSettings(config) {
  const raw = isPlainObject(config.multimodal) ? config.multimodal : {}
  const image = isPlainObject(raw.image) ? raw.image : {}
  const audio = isPlainObject(raw.audio) ? raw.audio : {}
  const video = isPlainObject(raw.video) ? raw.video : {}
  const audioMode = String(audio.mode ?? '').trim().toLowerCase()
  const videoMode = String(video.mode ?? '').trim().toLowerCase()
  return {
    enabled: raw.enabled === true,
    baseUrl: validatedBaseUrl(raw.baseUrl),
    apiKey: nonEmptyString(raw.apiKey, ''),
    prompt: nonEmptyString(raw.prompt, DEFAULT_PROMPT),
    timeoutMs: positiveNumber(raw.timeoutMs, DEFAULT_TIMEOUT_MS),
    maxBytes: positiveNumber(raw.maxBytes, DEFAULT_MAX_BYTES),
    ffmpegPath: nonEmptyString(raw.ffmpegPath, 'ffmpeg'),
    image: {
      enabled: boolField(image.enabled, true),
      model: nonEmptyString(image.model, '')
    },
    audio: {
      enabled: boolField(audio.enabled, false),
      model: nonEmptyString(audio.model, ''),
      mode: audioMode === 'chat' ? 'chat' : DEFAULT_AUDIO_MODE
    },
    video: {
      enabled: boolField(video.enabled, false),
      model: nonEmptyString(video.model, ''),
      mode: videoMode === 'url' ? 'url' : DEFAULT_VIDEO_MODE,
      frameCount: finiteInteger(video.frameCount, DEFAULT_FRAME_COUNT, { min: 1, max: MAX_FRAME_COUNT }),
      frameIntervalSec: positiveNumber(video.frameIntervalSec, DEFAULT_FRAME_INTERVAL_SEC)
    }
  }
}

function dataUrl(mime, bytes) {
  return `data:${mime};base64,${bytes.toString('base64')}`
}

function pickUsage(payload) {
  return isPlainObject(payload?.usage) && Object.keys(payload.usage).length > 0 ? { ...payload.usage } : undefined
}

function mergeUsage(total, next) {
  if (next === undefined || next === null) return total
  const out = { ...total }
  for (const [key, value] of Object.entries(next)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = (typeof out[key] === 'number' ? out[key] : 0) + value
    } else if (out[key] === undefined) {
      out[key] = value
    }
  }
  return out
}

function withUsage(result, usage) {
  return usage !== undefined && Object.keys(usage).length > 0 ? { ...result, usage } : result
}

/** Pull the assistant text out of an OpenAI-compatible chat response. */
function extractMessageText(payload) {
  const message = payload?.choices?.[0]?.message
  let text = ''
  if (typeof message?.content === 'string') {
    text = message.content
  } else if (Array.isArray(message?.content)) {
    text = message.content
      .filter((part) => isPlainObject(part) && (part.type === undefined || part.type === 'text') && typeof part.text === 'string')
      .map((part) => part.text)
      .join('')
  }
  text = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT_CHARS)
  if (text === '') throw new MultimodalError('多模态模型没有返回内容', { code: 'EMPTY_RESPONSE' })
  return text
}

function parseJsonResponse(rawText) {
  if (rawText.trim() === '') throw new MultimodalError('多模态接口返回空响应', { code: 'EMPTY_RESPONSE' })
  try {
    return JSON.parse(rawText)
  } catch (error) {
    throw new MultimodalError('多模态接口返回的不是合法 JSON', { code: 'INVALID_RESPONSE', cause: error })
  }
}

function httpErrorDetail(rawText) {
  let detail = rawText
  try {
    const payload = JSON.parse(rawText)
    detail = String(payload?.error?.message ?? payload?.message ?? payload?.error ?? rawText)
  } catch {
    // keep the raw snippet
  }
  return shortMessage(detail)
}

/**
 * @param {{
 *   configStore: { get(): object },
 *   logger?: object,
 *   fetchImpl?: typeof fetch,
 *   spawnImpl?: typeof import('node:child_process').spawn,
 *   tmpDir?: string
 * }} deps
 */
export function createMultimodalClient({ configStore, logger, fetchImpl, spawnImpl, tmpDir } = {}) {
  const injectedFetch = typeof fetchImpl === 'function' ? fetchImpl : undefined
  const injectedSpawn = typeof spawnImpl === 'function' ? spawnImpl : undefined
  const injectedTmpDir = typeof tmpDir === 'string' && tmpDir.trim() !== '' ? tmpDir.trim() : undefined

  function currentSettings() {
    return readSettings(readConfig(configStore, logger))
  }

  function resolveFetch() {
    const fetchFn = injectedFetch ?? globalThis.fetch
    if (typeof fetchFn !== 'function') throw new MultimodalError('当前环境没有可用的 fetch', { code: 'NO_FETCH' })
    return fetchFn
  }

  /** POST one request and return the raw response body text. */
  async function requestText({ endpoint, headers, body, signal, timeoutMs }) {
    const fetchFn = resolveFetch()
    if (signal !== undefined && signal !== null && signal.aborted === true) {
      throw new MultimodalError('多模态请求已取消', { code: 'ABORTED' })
    }

    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const onAbort = () => controller.abort()
    const externalSignal = signal !== undefined && signal !== null && typeof signal.addEventListener === 'function'
    if (externalSignal) signal.addEventListener('abort', onAbort, { once: true })

    try {
      let response
      try {
        response = await fetchFn(endpoint, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal
        })
      } catch (error) {
        if (timedOut) throw new MultimodalError(`多模态请求超时（${timeoutMs}ms）`, { code: 'TIMEOUT', cause: error })
        if (signal?.aborted === true) throw new MultimodalError('多模态请求已取消', { code: 'ABORTED', cause: error })
        throw new MultimodalError(`多模态请求失败：${shortMessage(error?.message ?? String(error), 200)}`, {
          code: 'NETWORK',
          cause: error
        })
      }

      if (response === null || typeof response !== 'object') {
        throw new MultimodalError('多模态接口没有返回响应', { code: 'INVALID_RESPONSE' })
      }
      const rawText = await response.text().catch(() => '')
      if (timedOut) throw new MultimodalError(`多模态请求超时（${timeoutMs}ms）`, { code: 'TIMEOUT' })
      if (signal?.aborted === true) throw new MultimodalError('多模态请求已取消', { code: 'ABORTED' })
      const status = Number(response.status)
      if (response.ok !== true) {
        throw new MultimodalError(`多模态接口 HTTP ${Number.isFinite(status) ? status : '未知'}：${httpErrorDetail(rawText)}`, {
          code: `HTTP_${Number.isFinite(status) ? status : 'UNKNOWN'}`
        })
      }
      return rawText
    } finally {
      clearTimeout(timer)
      if (externalSignal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort)
    }
  }

  /** POST to `chat/completions` and return the parsed description. */
  async function chatCompletion({ model, content, signal, timeoutMs }) {
    const settings = currentSettings()
    const rawText = await requestText({
      endpoint: `${settings.baseUrl}/chat/completions`,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content }],
        max_tokens: MAX_TOKENS,
        temperature: 0.2
      }),
      signal,
      timeoutMs
    })
    const payload = parseJsonResponse(rawText)
    const text = extractMessageText(payload)
    return {
      text,
      model: typeof payload?.model === 'string' && payload.model.trim() !== '' ? payload.model : model,
      usage: pickUsage(payload)
    }
  }

  /** mode=transcribe: multipart upload to `audio/transcriptions`. */
  async function transcribeAudio({ settings, audio, bytes, mime, fileName, signal }) {
    const extension = AUDIO_EXTENSIONS[mime] ?? 'wav'
    const name = nonEmptyString(fileName, `audio.${extension}`)
    const form = new FormData()
    form.append('file', new Blob([bytes], { type: mime }), name)
    form.append('model', audio.model)
    form.append('response_format', 'json')

    logger?.debug?.('调用多模态语音转写', { model: audio.model, mime, bytes: bytes.length })
    const rawText = await requestText({
      endpoint: `${settings.baseUrl}/audio/transcriptions`,
      headers: { authorization: `Bearer ${settings.apiKey}` },
      body: form,
      signal,
      timeoutMs: settings.timeoutMs
    })
    const payload = parseJsonResponse(rawText)
    let text = typeof payload?.text === 'string' ? payload.text : ''
    text = text
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_TEXT_CHARS)
    if (text === '') throw new MultimodalError('语音转写没有返回文本', { code: 'EMPTY_RESPONSE' })
    return withUsage({ text, kind: 'audio', model: audio.model }, pickUsage(payload))
  }

  /** mode=frames: extract frames, describe each one, merge the results. */
  async function describeVideoFrames({ settings, video, bytes, mime, signal }) {
    const { frames } = await extractVideoFrames({
      buffer: bytes,
      mime,
      frameCount: video.frameCount,
      intervalSec: video.frameIntervalSec,
      ffmpegPath: settings.ffmpegPath,
      spawnImpl: injectedSpawn,
      tmpDir: injectedTmpDir
    })
    logger?.debug?.('视频抽帧完成', { frames: frames.length, mime })

    const descriptions = []
    const failures = []
    let usage
    let resolvedModel = video.model
    for (let index = 0; index < frames.length; index += 1) {
      try {
        const result = await chatCompletion({
          model: video.model,
          content: [
            { type: 'text', text: settings.prompt },
            { type: 'image_url', image_url: { url: dataUrl('image/jpeg', frames[index]) } }
          ],
          signal,
          timeoutMs: settings.timeoutMs
        })
        descriptions.push(`第${index + 1}帧：${result.text}`)
        usage = mergeUsage(usage ?? {}, result.usage)
        resolvedModel = result.model
      } catch (error) {
        failures.push(index + 1)
        logger?.warn?.('视频帧描述失败，已跳过', {
          frame: index + 1,
          error: shortMessage(error?.message ?? String(error), 200)
        })
      }
    }
    if (descriptions.length === 0) {
      throw new MultimodalError(`视频帧描述全部失败（共 ${frames.length} 帧）`, { code: 'EMPTY_RESPONSE' })
    }
    if (failures.length > 0) logger?.debug?.('部分视频帧描述失败', { failed: failures.length, total: frames.length })
    return withUsage({ text: descriptions.join('；'), kind: 'video', model: resolvedModel }, usage)
  }

  /** Image / audio-chat / video-url share the same chat-completions shape. */
  async function describeWithChat({ settings, kind, content, signal, model }) {
    const result = await chatCompletion({ model, content, signal, timeoutMs: settings.timeoutMs })
    return withUsage({ text: result.text, kind, model: result.model }, result.usage)
  }

  /** Public status summary; never includes the api key. */
  function status() {
    const settings = currentSettings()
    const configured = settings.enabled && settings.baseUrl !== '' && settings.apiKey !== ''
    const modality = (section) => ({
      enabled: section.enabled,
      configured: configured && section.enabled && section.model !== '',
      model: section.model
    })
    return {
      enabled: settings.enabled,
      configured,
      baseUrl: settings.baseUrl,
      image: modality(settings.image),
      audio: { ...modality(settings.audio), mode: settings.audio.mode },
      video: { ...modality(settings.video), mode: settings.video.mode }
    }
  }

  /**
   * Describe one media buffer.
   *
   * @param {{
   *   kind: 'image'|'audio'|'video',
   *   buffer?: Buffer,
   *   contentType?: string,
   *   fileName?: string,
   *   url?: string,
   *   signal?: AbortSignal
   * }} input
   * @returns {Promise<{ text: string, kind: string, model: string, usage?: object }>}
   */
  async function describe({ kind, buffer, contentType, fileName, url, signal } = {}) {
    const settings = currentSettings()
    if (settings.enabled !== true) {
      throw new MultimodalError('多模态识别未启用（multimodal.enabled=false）', { code: 'MULTIMODAL_NOT_ENABLED' })
    }
    if (settings.baseUrl === '' || settings.apiKey === '') {
      throw new MultimodalError('多模态识别配置不完整：需要 baseUrl / apiKey', { code: 'MULTIMODAL_NOT_CONFIGURED' })
    }

    const type = String(kind ?? '').trim().toLowerCase()
    if (type !== 'image' && type !== 'audio' && type !== 'video') {
      throw new MultimodalError(`不支持的多模态类型：${type === '' ? '(空)' : type}`, { code: 'UNSUPPORTED_MEDIA' })
    }
    const modality = settings[type]
    const label = MODALITY_LABELS[type]
    if (modality.enabled !== true) {
      throw new MultimodalError(`${label}识别未启用（multimodal.${type}.enabled=false）`, { code: 'MODALITY_DISABLED' })
    }
    if (modality.model === '') {
      throw new MultimodalError(`${label}识别配置不完整：需要 multimodal.${type}.model`, {
        code: 'MULTIMODAL_NOT_CONFIGURED'
      })
    }

    // mode=url does not need the downloaded bytes; every other path does.
    if (type === 'video' && modality.mode === 'url') {
      if (typeof url !== 'string' || url.trim() === '') {
        throw new MultimodalError('视频 URL 模式需要提供视频地址（url）', { code: 'VIDEO_URL_REQUIRED' })
      }
      logger?.debug?.('调用多模态视频识别', { kind: 'video', mode: 'url', model: modality.model })
      return describeWithChat({
        settings,
        kind: 'video',
        model: modality.model,
        content: [
          { type: 'text', text: settings.prompt },
          { type: 'video_url', video_url: { url: url.trim() } }
        ],
        signal
      })
    }

    const bytes = Buffer.isBuffer(buffer) ? buffer : undefined
    if (bytes === undefined || bytes.length === 0) {
      throw new MultimodalError(`${label}内容为空`, { code: 'EMPTY_MEDIA' })
    }
    if (bytes.length > settings.maxBytes) {
      throw new MultimodalError(`${label}内容过大（${bytes.length} > ${settings.maxBytes} 字节）`, {
        code: 'MEDIA_TOO_LARGE'
      })
    }
    const mime = sniffMediaMimeType(bytes, contentType)
    if (mime === '') {
      throw new MultimodalError(`无法识别的${label}格式`, { code: 'UNSUPPORTED_MEDIA' })
    }
    if (!mime.startsWith(MIME_PREFIX[type])) {
      throw new MultimodalError(`媒体格式与识别类型不匹配（${mime} 不能作为${label}识别）`, { code: 'UNSUPPORTED_MEDIA' })
    }

    if (type === 'image') {
      logger?.debug?.('调用多模态识别', { kind: 'image', model: modality.model, mime, bytes: bytes.length })
      return describeWithChat({
        settings,
        kind: 'image',
        model: modality.model,
        content: [
          { type: 'text', text: settings.prompt },
          { type: 'image_url', image_url: { url: dataUrl(mime, bytes) } }
        ],
        signal
      })
    }

    if (type === 'audio') {
      if (modality.mode === 'transcribe') {
        return transcribeAudio({ settings, audio: modality, bytes, mime, fileName, signal })
      }
      logger?.debug?.('调用多模态语音识别', { kind: 'audio', mode: 'chat', model: modality.model, mime })
      return describeWithChat({
        settings,
        kind: 'audio',
        model: modality.model,
        content: [
          { type: 'text', text: settings.prompt },
          {
            type: 'input_audio',
            input_audio: { data: bytes.toString('base64'), format: AUDIO_INPUT_FORMATS[mime] ?? 'wav' }
          }
        ],
        signal
      })
    }

    // type === 'video' && mode === 'frames'
    logger?.debug?.('调用多模态视频识别', {
      model: modality.model,
      mime,
      bytes: bytes.length,
      frameCount: modality.frameCount
    })
    return describeVideoFrames({ settings, video: modality, bytes, mime, signal })
  }

  return { status, describe }
}
