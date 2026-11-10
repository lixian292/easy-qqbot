/** Offline tests for host/multimodal/frames.js (fake child process, no ffmpeg). */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { extractVideoFrames } from '../host/multimodal/frames.js'
import { MultimodalError } from '../host/multimodal/client.js'
import { makeTempPaths } from './helpers.mjs'

const VIDEO = Buffer.from('\x00\x00\x00\x18ftypisom-demo-video', 'latin1')
const FRAME_A = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x11, 0x22])
const FRAME_B = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x33, 0x44])
const FRAME_C = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x55, 0x66])

/**
 * Fake child_process.spawn that "runs ffmpeg" by writing JPEG files to the
 * output pattern, then emitting close. Supports async spawn errors.
 */
function makeFakeSpawn({ frames = [], code = 0, stderr = '', error = null, throwError = null } = {}) {
  const calls = []
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options })
    if (throwError !== null) throw throwError
    const child = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdout = new EventEmitter()
    child.kill = () => {}
    setImmediate(async () => {
      try {
        if (error !== null) {
          child.emit('error', error)
          return
        }
        if (stderr !== '') child.stderr.emit('data', Buffer.from(stderr))
        if (code === 0) {
          const pattern = args[args.length - 1]
          for (let index = 0; index < frames.length; index += 1) {
            const file = pattern.replace('%02d', String(index + 1).padStart(2, '0'))
            await fs.writeFile(file, frames[index])
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

test('extractVideoFrames runs ffmpeg with the contract arguments and reads JPEG frames', async () => {
  const { root, cleanup } = await makeTempPaths()
  try {
    const tempRoot = path.join(root, 'frames-tmp')
    const { calls, spawnImpl } = makeFakeSpawn({ frames: [FRAME_A, FRAME_B, FRAME_C] })
    const result = await extractVideoFrames({
      buffer: VIDEO,
      mime: 'video/mp4',
      frameCount: 2,
      intervalSec: 2,
      ffmpegPath: 'C:\\tools\\ffmpeg.exe',
      spawnImpl,
      tmpDir: tempRoot
    })

    assert.equal(result.mime, 'image/jpeg')
    assert.equal(result.frames.length, 2)
    assert.equal(result.frames[0].equals(FRAME_A), true)
    assert.equal(result.frames[1].equals(FRAME_B), true)

    assert.equal(calls.length, 1)
    assert.equal(calls[0].command, 'C:\\tools\\ffmpeg.exe')
    assert.deepEqual(calls[0].args.slice(0, 5), ['-hide_banner', '-loglevel', 'error', '-i', argsValue(calls[0].args, '-i')])
    assert.equal(argsValue(calls[0].args, '-vf'), 'fps=1/2')
    assert.equal(argsValue(calls[0].args, '-frames:v'), '2')
    assert.match(calls[0].args[calls[0].args.length - 1], /out-%02d\.jpg$/)
    assert.equal(calls[0].args[calls[0].args.length - 1].startsWith(tempRoot), true)
    assert.equal(calls[0].options.windowsHide, true)

    // Input file exists while ffmpeg runs, then the work dir is cleaned up.
    const inputFile = argsValue(calls[0].args, '-i')
    assert.match(inputFile, /input\.mp4$/)
    await assert.rejects(() => fs.access(inputFile), /ENOENT/)
    assert.deepEqual(await fs.readdir(tempRoot), [])
  } finally {
    await cleanup()
  }
})

test('extractVideoFrames maps a missing ffmpeg (async spawn error) to FFMPEG_MISSING', async () => {
  const { spawnImpl } = makeFakeSpawn({
    error: Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' })
  })
  await assert.rejects(
    () => extractVideoFrames({ buffer: VIDEO, mime: 'video/mp4', spawnImpl }),
    (error) => {
      assert.ok(error instanceof MultimodalError)
      assert.equal(error.code, 'FFMPEG_MISSING')
      return true
    }
  )
})

test('extractVideoFrames maps a synchronous spawn ENOENT to FFMPEG_MISSING', async () => {
  const spawnImpl = () => {
    throw Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' })
  }
  await assert.rejects(
    () => extractVideoFrames({ buffer: VIDEO, spawnImpl }),
    (error) => {
      assert.equal(error.code, 'FFMPEG_MISSING')
      return true
    }
  )
})

test('extractVideoFrames reports ffmpeg failures with the stderr snippet', async () => {
  const { spawnImpl } = makeFakeSpawn({ code: 1, stderr: 'Invalid data found when processing input' })
  await assert.rejects(
    () => extractVideoFrames({ buffer: VIDEO, spawnImpl }),
    (error) => {
      assert.equal(error.code, 'FFMPEG_FAILED')
      assert.match(error.message, /退出码 1/)
      assert.match(error.message, /Invalid data found/)
      return true
    }
  )
})

test('extractVideoFrames reports when ffmpeg produced no frames', async () => {
  const { spawnImpl } = makeFakeSpawn({ code: 0, frames: [] })
  await assert.rejects(
    () => extractVideoFrames({ buffer: VIDEO, spawnImpl }),
    (error) => {
      assert.equal(error.code, 'FFMPEG_NO_FRAMES')
      return true
    }
  )
})

test('extractVideoFrames rejects empty input before spawning ffmpeg', async () => {
  const { calls, spawnImpl } = makeFakeSpawn()
  await assert.rejects(
    () => extractVideoFrames({ buffer: Buffer.alloc(0), spawnImpl }),
    (error) => {
      assert.equal(error.code, 'EMPTY_MEDIA')
      return true
    }
  )
  assert.equal(calls.length, 0)
})

test('extractVideoFrames clamps frameCount and accepts a default ffmpeg command', async () => {
  const { calls, spawnImpl } = makeFakeSpawn({ frames: [FRAME_A] })
  const result = await extractVideoFrames({ buffer: VIDEO, spawnImpl, frameCount: 999, intervalSec: 0 })
  assert.equal(result.frames.length, 1)
  assert.equal(calls[0].command, 'ffmpeg')
  assert.equal(argsValue(calls[0].args, '-frames:v'), '16')
  assert.equal(argsValue(calls[0].args, '-vf'), 'fps=1/1')
})
