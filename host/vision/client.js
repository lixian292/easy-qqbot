/**
 * Vision client: OpenAI-compatible chat-completions endpoint that accepts an
 * inline base64 image (`image_url` + data URL). Providers such as SiliconFlow,
 * OpenRouter, DashScope compatible mode and local Ollama-via-OpenAI proxies all
 * speak this shape.
 *
 * The bot's normal chat model is text-only; this client is only used to turn an
 * inbound image into a short Chinese description that is then injected into the
 * conversation context.
 */
const DEFAULT_PROMPT = '请用中文简短描述这张图片的内容（1-2 句，最多 80 字）；如果是表情包/梗图，请说明画面、文字和表达的情绪。'
const DEFAULT_MAX_TOKENS = 240
const DEFAULT_TIMEOUT_MS = 45000

export class VisionError extends Error {
  constructor(message, { code = 'VISION_ERROR', cause } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'VisionError'
    this.code = code
    if (cause !== undefined) this.cause = cause
  }
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function validatedBaseUrl(raw) {
  const value = String(raw ?? '').trim().replace(/\/+$/, '')
  if (value === '') return ''
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return ''
    return value
  } catch {
    return ''
  }
}

function readConfig(configStore, logger) {
  try {
    const config = configStore?.get?.() ?? {}
    return isPlainObject(config) ? config : {}
  } catch (error) {
    logger?.warn?.('读取视觉模型配置失败', { error: error?.message })
    return {}
  }
}

function normalizeMimeType(contentType) {
  const value = String(contentType ?? '').trim().toLowerCase()
  if (value === 'image/jpg') return 'image/jpeg'
  if (/^image\/(?:jpeg|png|gif|webp|bmp)$/.test(value)) return value
  return ''
}

/** Detect the actual image MIME type from magic bytes (falls back to JPEG). */
export function sniffImageMimeType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return ''
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png'
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif'
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp'
  return ''
}

/**
 * @param {{ configStore: { get(): object }, logger?: object, fetchImpl?: typeof fetch }} deps
 */
export function createVisionClient({ configStore, logger, fetchImpl } = {}) {
  const injectedFetch = typeof fetchImpl === 'function' ? fetchImpl : undefined

  function settings(config) {
    const vision = isPlainObject(config.vision) ? config.vision : {}
    const baseUrl = validatedBaseUrl(vision.baseUrl)
    const apiKey = typeof vision.apiKey === 'string' ? vision.apiKey.trim() : ''
    const model = typeof vision.model === 'string' ? vision.model.trim() : ''
    const prompt = typeof vision.prompt === 'string' && vision.prompt.trim() !== '' ? vision.prompt.trim() : DEFAULT_PROMPT
    const maxTokens = Number.isSafeInteger(vision.maxTokens) && vision.maxTokens >= 32 ? vision.maxTokens : DEFAULT_MAX_TOKENS
    const timeoutMs = Number.isFinite(vision.timeoutMs) && vision.timeoutMs >= 5000 ? vision.timeoutMs : DEFAULT_TIMEOUT_MS
    const maxImageBytes = Number.isFinite(vision.maxImageBytes) && vision.maxImageBytes > 0 ? vision.maxImageBytes : 8388608
    return {
      enabled: vision.enabled === true,
      baseUrl,
      apiKey,
      model,
      prompt,
      maxTokens,
      timeoutMs,
      maxImageBytes,
      configured: baseUrl !== '' && apiKey !== '' && model !== ''
    }
  }

  /** Whether the current config can describe images. */
  function status() {
    const config = readConfig(configStore, logger)
    const current = settings(config)
    return {
      enabled: current.enabled && current.configured,
      configured: current.configured,
      baseUrl: current.baseUrl,
      model: current.model,
      hasApiKey: current.apiKey !== ''
    }
  }

  /**
   * Describe one image buffer.
   * @param {{ buffer: Buffer, contentType?: string, signal?: AbortSignal }} input
   * @returns {Promise<{ description: string, model: string, usage: object }>}
   */
  async function describeImage({ buffer, contentType, signal } = {}) {
    const config = readConfig(configStore, logger)
    const current = settings(config)
    if (current.enabled !== true) throw new VisionError('视觉模型未启用（vision.enabled=false）', { code: 'VISION_NOT_ENABLED' })
    if (current.configured !== true) throw new VisionError('视觉模型配置不完整：需要 baseUrl / apiKey / model', { code: 'VISION_NOT_CONFIGURED' })
    const bytes = Buffer.isBuffer(buffer) ? buffer : undefined
    if (bytes === undefined || bytes.length === 0) throw new VisionError('图片内容为空', { code: 'EMPTY_IMAGE' })
    if (bytes.length > current.maxImageBytes) throw new VisionError(`图片过大（${bytes.length} > ${current.maxImageBytes} 字节）`, { code: 'IMAGE_TOO_LARGE' })
    const mime = normalizeMimeType(contentType) || sniffImageMimeType(bytes)
    if (mime === '') throw new VisionError('无法识别的图片格式（支持 jpg/png/gif/webp/bmp）', { code: 'UNSUPPORTED_IMAGE' })
    const fetchFn = injectedFetch ?? globalThis.fetch
    if (typeof fetchFn !== 'function') throw new VisionError('当前环境没有可用的 fetch', { code: 'NO_FETCH' })

    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, current.timeoutMs)
    const onAbort = () => controller.abort()
    if (signal !== undefined && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true })

    const endpoint = `${current.baseUrl}/chat/completions`
    const body = {
      model: current.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: current.prompt },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${bytes.toString('base64')}` } }
          ]
        }
      ],
      max_tokens: current.maxTokens,
      temperature: 0.2
    }

    logger?.debug?.('调用视觉模型', { model: current.model, mime, bytes: bytes.length })
    let response
    try {
      response = await fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${current.apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      })
    } catch (error) {
      if (timedOut) throw new VisionError(`视觉模型请求超时（${current.timeoutMs}ms）`, { code: 'TIMEOUT', cause: error })
      throw new VisionError(`视觉模型请求失败：${error?.message ?? String(error)}`, { code: 'NETWORK', cause: error })
    } finally {
      clearTimeout(timer)
      if (signal !== undefined && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort)
    }

    const rawText = await response.text().catch(() => '')
    if (response.ok !== true) {
      let detail = rawText.slice(0, 300)
      try {
        const parsed = JSON.parse(rawText)
        detail = String(parsed?.error?.message ?? parsed?.message ?? detail)
      } catch {
        // keep raw snippet
      }
      throw new VisionError(`视觉模型 HTTP ${response.status}：${detail}`, { code: `HTTP_${response.status}` })
    }

    let payload
    try {
      payload = JSON.parse(rawText)
    } catch (error) {
      throw new VisionError('视觉模型返回的不是合法 JSON', { code: 'INVALID_RESPONSE', cause: error })
    }

    const message = payload?.choices?.[0]?.message
    let description = ''
    if (typeof message?.content === 'string') description = message.content
    else if (Array.isArray(message?.content)) {
      description = message.content
        .filter((part) => isPlainObject(part) && (part.type === undefined || part.type === 'text') && typeof part.text === 'string')
        .map((part) => part.text)
        .join('')
    }
    description = String(description ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)
    if (description === '') throw new VisionError('视觉模型没有返回描述内容', { code: 'EMPTY_RESPONSE' })

    logger?.debug?.('视觉模型描述完成', { model: current.model, chars: description.length })
    return {
      description,
      model: typeof payload?.model === 'string' ? payload.model : current.model,
      usage: isPlainObject(payload?.usage) ? payload.usage : {}
    }
  }

  return { status, describeImage }
}
