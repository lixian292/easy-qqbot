/** Offline tests for host/multimodal/download.js (injected fetch, no network). */
import assert from 'node:assert/strict'
import test from 'node:test'
import { MediaDownloadError, downloadMediaBuffer, sniffMediaMimeType } from '../host/multimodal/download.js'
import { MultimodalError } from '../host/multimodal/client.js'

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1')
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x1a, 0x00, 0x00, 0x00]), Buffer.from('WEBPVP8 '), Buffer.alloc(8)])
const BMP = Buffer.from('BM\x3a\x00\x00\x00\x00\x00\x00\x00', 'latin1')
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from('WAVEfmt '), Buffer.alloc(20)])
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(20)])
const MP3_FRAME = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(16)])
const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(20)])
const MP4 = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(12)])

function mediaResponse(buffer, { contentType = 'application/octet-stream', headers = {} } = {}) {
  return new Response(buffer, {
    status: 200,
    headers: { 'content-type': contentType, ...headers }
  })
}

test('sniffMediaMimeType detects image/audio/video magic bytes', () => {
  assert.equal(sniffMediaMimeType(JPEG), 'image/jpeg')
  assert.equal(sniffMediaMimeType(PNG), 'image/png')
  assert.equal(sniffMediaMimeType(GIF), 'image/gif')
  assert.equal(sniffMediaMimeType(WEBP), 'image/webp')
  assert.equal(sniffMediaMimeType(BMP), 'image/bmp')
  assert.equal(sniffMediaMimeType(WAV), 'audio/wav')
  assert.equal(sniffMediaMimeType(MP3), 'audio/mpeg')
  assert.equal(sniffMediaMimeType(MP3_FRAME), 'audio/mpeg')
  assert.equal(sniffMediaMimeType(OGG), 'audio/ogg')
  assert.equal(sniffMediaMimeType(MP4), 'video/mp4')
  assert.equal(sniffMediaMimeType(Buffer.from('plain text here')), '')
  assert.equal(sniffMediaMimeType(Buffer.alloc(0)), '')
})

test('sniffMediaMimeType falls back to a normalized content-type hint', () => {
  assert.equal(sniffMediaMimeType(Buffer.from('plain text here'), 'image/jpg; charset=utf-8'), 'image/jpeg')
  assert.equal(sniffMediaMimeType(Buffer.from('plain text here'), 'audio/mp3'), 'audio/mpeg')
  assert.equal(sniffMediaMimeType(Buffer.from('plain text here'), 'text/plain'), '')
  // Magic bytes win over a misleading header.
  assert.equal(sniffMediaMimeType(PNG, 'image/jpeg'), 'image/png')
})

test('downloadMediaBuffer returns bytes with the sniffed MIME type', async () => {
  const png = await downloadMediaBuffer({
    url: 'https://example.com/a.png',
    maxBytes: 1024 * 1024,
    fetchImpl: async () => mediaResponse(PNG, { contentType: 'application/octet-stream' })
  })
  assert.equal(png.contentType, 'image/png')
  assert.equal(png.buffer.equals(PNG), true)

  const wav = await downloadMediaBuffer({
    url: 'https://example.com/voice.wav',
    contentType: 'voice',
    fetchImpl: async () => mediaResponse(WAV, { contentType: 'audio/wav' })
  })
  assert.equal(wav.contentType, 'audio/wav')
  assert.equal(wav.buffer.equals(WAV), true)

  const mp4 = await downloadMediaBuffer({
    url: 'https://example.com/v.mp4',
    fetchImpl: async () => mediaResponse(MP4, { contentType: 'video/mp4' })
  })
  assert.equal(mp4.contentType, 'video/mp4')
  assert.equal(mp4.buffer.equals(MP4), true)
})

test('downloadMediaBuffer rejects invalid URLs and non-http protocols', async () => {
  for (const url of ['not a url', '', 'ftp://example.com/a.png']) {
    await assert.rejects(
      () => downloadMediaBuffer({ url, fetchImpl: async () => mediaResponse(PNG) }),
      (error) => {
        assert.ok(error instanceof MediaDownloadError)
        assert.ok(error instanceof MultimodalError)
        assert.equal(error.code, 'INVALID_URL')
        return true
      }
    )
  }
})

test('downloadMediaBuffer maps HTTP failures, empty bodies and unsupported formats', async () => {
  await assert.rejects(
    () => downloadMediaBuffer({ url: 'https://example.com/missing.png', fetchImpl: async () => new Response('', { status: 404 }) }),
    (error) => {
      assert.equal(error.code, 'HTTP_404')
      return true
    }
  )

  await assert.rejects(
    () =>
      downloadMediaBuffer({
        url: 'https://example.com/empty',
        fetchImpl: async () => mediaResponse(Buffer.alloc(0), { contentType: 'image/png' })
      }),
    (error) => {
      assert.equal(error.code, 'EMPTY_MEDIA')
      return true
    }
  )

  await assert.rejects(
    () =>
      downloadMediaBuffer({
        url: 'https://example.com/notes.txt',
        fetchImpl: async () => mediaResponse(Buffer.from('just some text'), { contentType: 'text/plain' })
      }),
    (error) => {
      assert.equal(error.code, 'UNSUPPORTED_MEDIA')
      return true
    }
  )
})

test('downloadMediaBuffer enforces the declared and actual byte limit', async () => {
  await assert.rejects(
    () =>
      downloadMediaBuffer({
        url: 'https://example.com/big.png',
        maxBytes: 10,
        fetchImpl: async () =>
          mediaResponse(PNG, { headers: { 'content-length': String(PNG.length) } })
      }),
    (error) => {
      assert.equal(error.code, 'MEDIA_TOO_LARGE')
      return true
    }
  )

  // No trustworthy content-length header: the entity size is checked after reading.
  await assert.rejects(
    () =>
      downloadMediaBuffer({
        url: 'https://example.com/big2.png',
        maxBytes: 10,
        fetchImpl: async () => {
          const response = mediaResponse(PNG)
          response.headers.delete('content-length')
          return response
        }
      }),
    (error) => {
      assert.equal(error.code, 'MEDIA_TOO_LARGE')
      return true
    }
  )
})

test('downloadMediaBuffer maps network errors and timeouts', async () => {
  await assert.rejects(
    () =>
      downloadMediaBuffer({
        url: 'https://example.com/down.png',
        fetchImpl: async () => {
          throw new Error('ECONNRESET')
        }
      }),
    (error) => {
      assert.equal(error.code, 'NETWORK')
      assert.match(error.message, /ECONNRESET/)
      return true
    }
  )

  await assert.rejects(
    () =>
      downloadMediaBuffer({
        url: 'https://example.com/timeout.png',
        timeoutMs: 20,
        fetchImpl: (url, { signal }) =>
          new Promise((resolve, reject) => {
            const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            if (signal.aborted) onAbort()
            else signal.addEventListener('abort', onAbort, { once: true })
          })
      }),
    (error) => {
      assert.equal(error.code, 'TIMEOUT')
      return true
    }
  )
})

test('downloadMediaBuffer supports caller aborts', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => downloadMediaBuffer({ url: 'https://example.com/a.png', signal: controller.signal, fetchImpl: async () => mediaResponse(PNG) }),
    (error) => {
      assert.equal(error.code, 'ABORTED')
      return true
    }
  )
})
