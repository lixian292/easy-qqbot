/** Lead-owned tests for the optional OpenAI-compatible vision client + image download. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createVisionClient, sniffImageMimeType, VisionError } from '../host/vision/client.js'
import { downloadImageBuffer, ImageDownloadError } from '../host/vision/download.js'
import { makeConfigStore, makeLogger } from './helpers.mjs'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

function configuredStore(overrides = {}) {
  return makeConfigStore({
    vision: {
      enabled: true,
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      model: 'vl-model',
      ...overrides
    }
  })
}

function okResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

test('vision client posts an OpenAI-compatible image_url request and returns the description', async () => {
  const calls = []
  const configStore = configuredStore()
  const client = createVisionClient({
    configStore,
    logger: makeLogger(),
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) })
      return okResponse({
        model: 'vl-model',
        choices: [{ message: { content: '  一只橘猫趴在键盘上，配文“摸鱼中”。 ' } }],
        usage: { total_tokens: 42 }
      })
    }
  })

  const result = await client.describeImage({ buffer: PNG, contentType: 'image/png' })
  assert.equal(result.description, '一只橘猫趴在键盘上，配文“摸鱼中”。')
  assert.equal(result.model, 'vl-model')
  assert.equal(result.usage.total_tokens, 42)

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.example.com/v1/chat/completions')
  assert.equal(calls[0].options.headers.authorization, 'Bearer test-key')
  assert.equal(calls[0].body.model, 'vl-model')
  const content = calls[0].body.messages[0].content
  assert.equal(content[0].type, 'text')
  assert.equal(content[1].type, 'image_url')
  assert.ok(content[1].image_url.url.startsWith('data:image/png;base64,'))
  assert.equal(client.status().enabled, true)
  assert.equal(client.status().hasApiKey, true)
})

test('vision client rejects missing/disabled configuration', async () => {
  const disabled = createVisionClient({ configStore: makeConfigStore({}), logger: makeLogger() })
  await assert.rejects(() => disabled.describeImage({ buffer: PNG, contentType: 'image/png' }), (error) => {
    assert.ok(error instanceof VisionError)
    assert.equal(error.code, 'VISION_NOT_ENABLED')
    return true
  })

  const incomplete = createVisionClient({ configStore: configuredStore({ baseUrl: '' }), logger: makeLogger() })
  await assert.rejects(() => incomplete.describeImage({ buffer: PNG, contentType: 'image/png' }), (error) => {
    assert.equal(error.code, 'VISION_NOT_CONFIGURED')
    return true
  })
})

test('vision client maps HTTP failures and empty responses to typed errors', async () => {
  const httpError = createVisionClient({
    configStore: configuredStore(),
    logger: makeLogger(),
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 })
  })
  await assert.rejects(() => httpError.describeImage({ buffer: PNG, contentType: 'image/png' }), (error) => {
    assert.equal(error.code, 'HTTP_401')
    assert.match(error.message, /bad key/)
    return true
  })

  const empty = createVisionClient({
    configStore: configuredStore(),
    logger: makeLogger(),
    fetchImpl: async () => okResponse({ choices: [{ message: { content: '   ' } }] })
  })
  await assert.rejects(() => empty.describeImage({ buffer: PNG, contentType: 'image/png' }), (error) => {
    assert.equal(error.code, 'EMPTY_RESPONSE')
    return true
  })
})

test('sniffImageMimeType identifies common formats', () => {
  assert.equal(sniffImageMimeType(PNG), 'image/png')
  assert.equal(sniffImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg')
  assert.equal(sniffImageMimeType(Buffer.from('GIF89a')), 'image/gif')
  assert.equal(sniffImageMimeType(Buffer.from('RIFF0000WEBP')), 'image/webp')
  assert.equal(sniffImageMimeType(Buffer.from('plain text')), '')
})

test('downloadImageBuffer fetches bytes, enforces size and reports HTTP errors', async () => {
  const ok = await downloadImageBuffer({
    url: 'https://example.com/a.png',
    maxBytes: 1024,
    fetchImpl: async () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })
  })
  assert.equal(ok.contentType, 'image/png')
  assert.equal(ok.buffer.equals(PNG), true)

  await assert.rejects(
    () =>
      downloadImageBuffer({
        url: 'https://example.com/big.png',
        maxBytes: 10,
        fetchImpl: async () => new Response(PNG, { status: 200, headers: { 'content-length': String(PNG.length) } })
      }),
    (error) => {
      assert.ok(error instanceof ImageDownloadError)
      assert.equal(error.code, 'IMAGE_TOO_LARGE')
      return true
    }
  )

  await assert.rejects(
    () => downloadImageBuffer({ url: 'https://example.com/missing.png', fetchImpl: async () => new Response('', { status: 404 }) }),
    (error) => {
      assert.equal(error.code, 'HTTP_404')
      return true
    }
  )
})
