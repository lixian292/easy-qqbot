/** Offline tests for host/multimodal/client.js (injected fetch/spawn, no network). */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { createMultimodalClient, MultimodalError } from '../host/multimodal/client.js'
import { makeConfigStore, makeLogger, makeTempPaths } from './helpers.mjs'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from('WAVEfmt '), Buffer.alloc(20)])
const MP4 = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(12)])
const FRAME_A = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x11, 0x22])
const FRAME_B = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x33, 0x44])

const BASE_MULTIMODAL = {
  enabled: true,
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'test-key',
  prompt: '描述一下',
  timeoutMs: 5000,
  maxBytes: 1024 * 1024,
  ffmpegPath: 'ffmpeg',
  image: { enabled: true, model: 'vl-image' },
  audio: { enabled: true, model: 'asr-model', mode: 'transcribe' },
  video: { enabled: true, model: 'vl-video', mode: 'frames', frameCount: 2, frameIntervalSec: 2 }
}

function deepMerge(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    out[key] = value !== null && typeof value === 'object' && !Array.isArray(value) ? deepMerge(base?.[key] ?? {}, value) : value
  }
  return out
}

/**
 * makeConfigStore() drops unknown keys until Lead's config migration lands, so
 * this helper keeps the raw `multimodal` section visible to the client either way.
 */
function makeMultimodalStore(overrides = {}) {
  const store = makeConfigStore()
  const multimodal = deepMerge(BASE_MULTIMODAL, overrides)
  return { ...store, get: () => ({ ...store.get(), multimodal }) }
}

function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function chatResponse(content, { model = 'reply-model', usage } = {}) {
  const payload = { model, choices: [{ message: { content } }] }
  if (usage !== undefined) payload.usage = usage
  return jsonResponse(payload)
}

function makeFakeSpawn({ frames = [], code = 0, error = null } = {}) {
  const calls = []
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options })
    const child = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    setImmediate(async () => {
      try {
        if (error !== null) {
          child.emit('error', error)
          return
        }
        if (code === 0) {
          const pattern = args[args.length - 1]
          for (let index = 0; index < frames.length; index += 1) {
            await fs.writeFile(pattern.replace('%02d', String(index + 1).padStart(2, '0')), frames[index])
          }
        }
        child.emit('close', code)
      } catch (failure) {
        child.emit('error', failure)
      }
    })
    return child
  }
  return { calls, spawnImpl }
}

function argsValue(args, flag) {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

test('status reports per-modality configuration without exposing the api key', () => {
  const unconfigured = createMultimodalClient({ configStore: makeConfigStore(), logger: makeLogger() }).status()
  assert.equal(unconfigured.enabled, false)
  assert.equal(unconfigured.configured, false)
  assert.equal(unconfigured.baseUrl, '')
  assert.deepEqual(unconfigured.image, { enabled: true, configured: false, model: '' })
  assert.deepEqual(unconfigured.audio, { enabled: false, configured: false, model: '', mode: 'transcribe' })
  assert.deepEqual(unconfigured.video, { enabled: false, configured: false, model: '', mode: 'frames' })

  const status = createMultimodalClient({ configStore: makeMultimodalStore(), logger: makeLogger() }).status()
  assert.deepEqual(status, {
    enabled: true,
    configured: true,
    baseUrl: 'https://api.example.com/v1',
    image: { enabled: true, configured: true, model: 'vl-image' },
    audio: { enabled: true, configured: true, model: 'asr-model', mode: 'transcribe' },
    video: { enabled: true, configured: true, model: 'vl-video', mode: 'frames' }
  })
  assert.equal(JSON.stringify(status).includes('test-key'), false)
})

test('status works with the normalized config shape from host/config.js', () => {
  // makeConfigStore() runs the real normalizeConfig(), so this proves the
  // client reads `config.multimodal` exactly as Lead's config module writes it.
  const configStore = makeConfigStore({
    multimodal: {
      enabled: true,
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      image: { enabled: true, model: 'vl-image' }
    }
  })
  const status = createMultimodalClient({ configStore, logger: makeLogger() }).status()
  assert.equal(status.enabled, true)
  assert.equal(status.configured, true)
  assert.equal(status.baseUrl, 'https://api.example.com/v1')
  assert.deepEqual(status.image, { enabled: true, configured: true, model: 'vl-image' })
  assert.equal(status.audio.mode, 'transcribe')
  assert.equal(status.video.mode, 'frames')
  assert.equal(status.audio.configured, false)
  assert.equal(status.video.configured, false)
})

test('image describe posts an OpenAI-compatible image_url request and joins text parts', async () => {
  const calls = []
  const logger = makeLogger()
  const client = createMultimodalClient({
    configStore: makeMultimodalStore({ image: { model: 'vl-image' } }),
    logger,
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) })
      return chatResponse(
        [
          { type: 'text', text: '一只橘猫' },
          { type: 'text', text: '趴在键盘上' }
        ],
        { model: 'vl-image', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
      )
    }
  })

  const result = await client.describe({ kind: 'image', buffer: PNG, contentType: 'image/png' })
  assert.equal(result.text, '一只橘猫趴在键盘上')
  assert.equal(result.kind, 'image')
  assert.equal(result.model, 'vl-image')
  assert.deepEqual(result.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.example.com/v1/chat/completions')
  assert.equal(calls[0].options.method, 'POST')
  assert.equal(calls[0].options.headers.authorization, 'Bearer test-key')
  assert.equal(calls[0].body.model, 'vl-image')
  assert.equal(calls[0].body.max_tokens, 240)
  const content = calls[0].body.messages[0].content
  assert.equal(content[0].type, 'text')
  assert.equal(content[0].text, '描述一下')
  assert.equal(content[1].type, 'image_url')
  assert.ok(content[1].image_url.url.startsWith('data:image/png;base64,'))
  assert.equal(Buffer.from(content[1].image_url.url.split(',')[1], 'base64').equals(PNG), true)
  assert.equal(JSON.stringify(logger.entries).includes('test-key'), false)
})

test('describe maps disabled / incomplete configuration and bad media to typed errors', async () => {
  const missing = createMultimodalClient({ configStore: makeConfigStore(), logger: makeLogger() })
  await assert.rejects(() => missing.describe({ kind: 'image', buffer: PNG, contentType: 'image/png' }), (error) => {
    assert.ok(error instanceof MultimodalError)
    assert.equal(error.code, 'MULTIMODAL_NOT_ENABLED')
    return true
  })

  const noKey = createMultimodalClient({ configStore: makeMultimodalStore({ apiKey: '' }), logger: makeLogger() })
  await assert.rejects(() => noKey.describe({ kind: 'image', buffer: PNG, contentType: 'image/png' }), (error) => {
    assert.equal(error.code, 'MULTIMODAL_NOT_CONFIGURED')
    return true
  })

  const imageDisabled = createMultimodalClient({
    configStore: makeMultimodalStore({ image: { enabled: false } }),
    logger: makeLogger()
  })
  await assert.rejects(() => imageDisabled.describe({ kind: 'image', buffer: PNG, contentType: 'image/png' }), (error) => {
    assert.equal(error.code, 'MODALITY_DISABLED')
    return true
  })

  const noModel = createMultimodalClient({
    configStore: makeMultimodalStore({ image: { model: '' } }),
    logger: makeLogger(),
    fetchImpl: async () => chatResponse('should not be called')
  })
  await assert.rejects(() => noModel.describe({ kind: 'image', buffer: PNG, contentType: 'image/png' }), (error) => {
    assert.equal(error.code, 'MULTIMODAL_NOT_CONFIGURED')
    return true
  })

  const configured = createMultimodalClient({
    configStore: makeMultimodalStore(),
    logger: makeLogger(),
    fetchImpl: async () => chatResponse('ok')
  })
  await assert.rejects(() => configured.describe({ kind: 'image', buffer: Buffer.alloc(0) }), (error) => {
    assert.equal(error.code, 'EMPTY_MEDIA')
    return true
  })
  await assert.rejects(() => configured.describe({ kind: 'image', buffer: Buffer.from('plain text') }), (error) => {
    assert.equal(error.code, 'UNSUPPORTED_MEDIA')
    return true
  })
  // A PNG buffer must not be accepted as an audio attachment even with an audio hint.
  await assert.rejects(
    () => configured.describe({ kind: 'audio', buffer: PNG, contentType: 'audio/wav' }),
    (error) => {
      assert.equal(error.code, 'UNSUPPORTED_MEDIA')
      return true
    }
  )
  await assert.rejects(() => configured.describe({ kind: 'sticker', buffer: PNG }), (error) => {
    assert.equal(error.code, 'UNSUPPORTED_MEDIA')
    return true
  })
})

test('describe enforces multimodal.maxBytes', async () => {
  const client = createMultimodalClient({
    configStore: makeMultimodalStore({ maxBytes: 10 }),
    logger: makeLogger(),
    fetchImpl: async () => chatResponse('ok')
  })
  await assert.rejects(() => client.describe({ kind: 'image', buffer: PNG, contentType: 'image/png' }), (error) => {
    assert.equal(error.code, 'MEDIA_TOO_LARGE')
    return true
  })
})

test('audio transcribe uploads multipart form data to /audio/transcriptions', async () => {
  const calls = []
  const client = createMultimodalClient({
    configStore: makeMultimodalStore({ audio: { mode: 'transcribe' } }),
    logger: makeLogger(),
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return jsonResponse({ text: ' 你好，世界 ' })
    }
  })

  const result = await client.describe({ kind: 'audio', buffer: WAV, contentType: 'audio/wav', fileName: 'voice.wav' })
  assert.equal(result.text, '你好，世界')
  assert.equal(result.kind, 'audio')
  assert.equal(result.model, 'asr-model')

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.example.com/v1/audio/transcriptions')
  assert.equal(calls[0].options.method, 'POST')
  assert.equal(calls[0].options.headers.authorization, 'Bearer test-key')
  assert.equal(calls[0].options.headers['content-type'], undefined)
  const form = calls[0].options.body
  assert.ok(form instanceof FormData)
  assert.equal(form.get('model'), 'asr-model')
  assert.equal(form.get('response_format'), 'json')
  const file = form.get('file')
  assert.equal(file.name, 'voice.wav')
  assert.equal(file.type, 'audio/wav')
  assert.equal(Buffer.from(await file.arrayBuffer()).equals(WAV), true)
})

test('audio chat sends input_audio base64 to chat/completions', async () => {
  const calls = []
  const client = createMultimodalClient({
    configStore: makeMultimodalStore({ audio: { mode: 'chat' } }),
    logger: makeLogger(),
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) })
      return chatResponse('语音里在说你好', { model: 'asr-chat' })
    }
  })

  const result = await client.describe({ kind: 'audio', buffer: WAV, contentType: 'audio/wav' })
  assert.equal(result.text, '语音里在说你好')
  assert.equal(result.model, 'asr-chat')
  assert.equal(calls[0].url, 'https://api.example.com/v1/chat/completions')
  const content = calls[0].body.messages[0].content
  assert.equal(content[0].type, 'text')
  assert.equal(content[1].type, 'input_audio')
  assert.equal(content[1].input_audio.data, WAV.toString('base64'))
  assert.equal(content[1].input_audio.format, 'wav')
})

test('audio transcribe maps an empty transcript to EMPTY_RESPONSE', async () => {
  const client = createMultimodalClient({
    configStore: makeMultimodalStore(),
    logger: makeLogger(),
    fetchImpl: async () => jsonResponse({ text: '   ' })
  })
  await assert.rejects(() => client.describe({ kind: 'audio', buffer: WAV, contentType: 'audio/wav' }), (error) => {
    assert.equal(error.code, 'EMPTY_RESPONSE')
    return true
  })
})

test('video frames extracts frames and merges per-frame descriptions', async () => {
  const { root, cleanup } = await makeTempPaths()
  try {
    const tempRoot = path.join(root, 'client-frames')
    const spawn = makeFakeSpawn({ frames: [FRAME_A, FRAME_B] })
    const fetchCalls = []
    const client = createMultimodalClient({
      configStore: makeMultimodalStore({
        ffmpegPath: 'ffmpeg-test',
        image: { enabled: false, model: '' },
        video: { model: 'vl-video', mode: 'frames', frameCount: 2, frameIntervalSec: 2 }
      }),
      logger: makeLogger(),
      spawnImpl: spawn.spawnImpl,
      tmpDir: tempRoot,
      fetchImpl: async (url, options) => {
        fetchCalls.push({ url, options, body: JSON.parse(options.body) })
        const index = fetchCalls.length
        return chatResponse(`画面${index === 1 ? '一' : '二'}`, {
          model: 'vl-video',
          usage: { total_tokens: 15 }
        })
      }
    })

    const result = await client.describe({ kind: 'video', buffer: MP4, contentType: 'video/mp4' })
    assert.equal(result.text, '第1帧：画面一；第2帧：画面二')
    assert.equal(result.kind, 'video')
    assert.equal(result.model, 'vl-video')
    assert.deepEqual(result.usage, { total_tokens: 30 })

    assert.equal(spawn.calls.length, 1)
    assert.equal(spawn.calls[0].command, 'ffmpeg-test')
    assert.equal(argsValue(spawn.calls[0].args, '-vf'), 'fps=1/2')
    assert.equal(argsValue(spawn.calls[0].args, '-frames:v'), '2')

    assert.equal(fetchCalls.length, 2)
    for (const call of fetchCalls) {
      assert.equal(call.url, 'https://api.example.com/v1/chat/completions')
      assert.equal(call.body.model, 'vl-video')
      assert.ok(call.body.messages[0].content[1].image_url.url.startsWith('data:image/jpeg;base64,'))
    }
    assert.deepEqual(await fs.readdir(tempRoot), [])
  } finally {
    await cleanup()
  }
})

test('video frames maps a missing ffmpeg to FFMPEG_MISSING', async () => {
  const spawn = makeFakeSpawn({ error: Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' }) })
  const client = createMultimodalClient({
    configStore: makeMultimodalStore(),
    logger: makeLogger(),
    spawnImpl: spawn.spawnImpl,
    fetchImpl: async () => chatResponse('unused')
  })
  await assert.rejects(() => client.describe({ kind: 'video', buffer: MP4, contentType: 'video/mp4' }), (error) => {
    assert.equal(error.code, 'FFMPEG_MISSING')
    return true
  })
})

test('video url mode sends video_url and requires a non-empty url', async () => {
  const calls = []
  const client = createMultimodalClient({
    configStore: makeMultimodalStore({ video: { mode: 'url' } }),
    logger: makeLogger(),
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) })
      return chatResponse('视频里有人在跳舞')
    }
  })

  const result = await client.describe({ kind: 'video', url: 'https://cdn.example.com/v.mp4' })
  assert.equal(result.text, '视频里有人在跳舞')
  assert.equal(result.kind, 'video')
  assert.equal(calls.length, 1)
  const content = calls[0].body.messages[0].content
  assert.equal(content[1].type, 'video_url')
  assert.equal(content[1].video_url.url, 'https://cdn.example.com/v.mp4')

  const before = calls.length
  await assert.rejects(() => client.describe({ kind: 'video', url: '   ' }), (error) => {
    assert.equal(error.code, 'VIDEO_URL_REQUIRED')
    return true
  })
  assert.equal(calls.length, before)
})

test('describe maps HTTP failures and empty model replies to typed errors', async () => {
  const httpError = createMultimodalClient({
    configStore: makeMultimodalStore(),
    logger: makeLogger(),
    fetchImpl: async () => jsonResponse({ error: { message: 'invalid api key' } }, { status: 401 })
  })
  await assert.rejects(() => httpError.describe({ kind: 'image', buffer: PNG, contentType: 'image/png' }), (error) => {
    assert.equal(error.code, 'HTTP_401')
    assert.match(error.message, /invalid api key/)
    return true
  })

  const empty = createMultimodalClient({
    configStore: makeMultimodalStore(),
    logger: makeLogger(),
    fetchImpl: async () => chatResponse('   ')
  })
  await assert.rejects(() => empty.describe({ kind: 'image', buffer: PNG, contentType: 'image/png' }), (error) => {
    assert.equal(error.code, 'EMPTY_RESPONSE')
    return true
  })

  const emptyBody = createMultimodalClient({
    configStore: makeMultimodalStore(),
    logger: makeLogger(),
    fetchImpl: async () => new Response('', { status: 200 })
  })
  await assert.rejects(() => emptyBody.describe({ kind: 'image', buffer: PNG, contentType: 'image/png' }), (error) => {
    assert.equal(error.code, 'EMPTY_RESPONSE')
    return true
  })
})

test('describe maps timeouts and caller aborts', async () => {
  const timeoutClient = createMultimodalClient({
    configStore: makeMultimodalStore({ timeoutMs: 20 }),
    logger: makeLogger(),
    fetchImpl: (url, { signal }) =>
      new Promise((resolve, reject) => {
        const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      })
  })
  await assert.rejects(() => timeoutClient.describe({ kind: 'image', buffer: PNG, contentType: 'image/png' }), (error) => {
    assert.equal(error.code, 'TIMEOUT')
    return true
  })

  const controller = new AbortController()
  controller.abort()
  const abortClient = createMultimodalClient({
    configStore: makeMultimodalStore(),
    logger: makeLogger(),
    fetchImpl: async () => chatResponse('unused')
  })
  await assert.rejects(
    () => abortClient.describe({ kind: 'image', buffer: PNG, contentType: 'image/png', signal: controller.signal }),
    (error) => {
      assert.equal(error.code, 'ABORTED')
      return true
    }
  )
})
