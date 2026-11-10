/**
 * Video frame extraction for the `video.mode=frames` multimodal path.
 *
 * ffmpeg is an external, optional dependency: it is invoked through an
 * injectable `spawnImpl` so tests never touch a real binary. A missing binary
 * surfaces as `FFMPEG_MISSING` for the caller to degrade from.
 */
import { spawn as defaultSpawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MultimodalError, shortMessage } from './errors.js'

const DEFAULT_FRAME_COUNT = 4
const DEFAULT_INTERVAL_SEC = 1
const DEFAULT_TIMEOUT_MS = 30000
const MAX_FRAME_COUNT = 16
const MIN_INTERVAL_SEC = 0.05
const MAX_INTERVAL_SEC = 600
const STDERR_LIMIT = 4000

const MIME_EXTENSIONS = {
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/x-matroska': '.mkv',
  'video/x-msvideo': '.avi'
}

function normalizeInteger(value, fallback, { min, max }) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

function normalizeNumber(value, fallback, { min, max }) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.min(max, Math.max(min, number))
}

function extensionForMime(mime) {
  const normalized = String(mime ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  return MIME_EXTENSIONS[normalized] ?? '.mp4'
}

function frameIndex(fileName) {
  const match = /^out-(\d+)\.jpg$/i.exec(fileName)
  return match === null ? Number.MAX_SAFE_INTEGER : Number(match[1])
}

/** Map a spawn failure to the typed error the contract requires. */
function spawnFailure(error, command) {
  const code = typeof error?.code === 'string' ? error.code : ''
  if (code === 'ENOENT') return new MultimodalError('ffmpeg 不可用', { code: 'FFMPEG_MISSING', cause: error })
  return new MultimodalError(`ffmpeg 抽帧失败：${shortMessage(error?.message ?? String(error), 200)}（${command}）`, {
    code: 'FFMPEG_FAILED',
    cause: error
  })
}

/**
 * Run ffmpeg and wait for it to exit, collecting stderr for diagnostics.
 * @returns {Promise<void>}
 */
function runFfmpeg({ command, args, spawnFn, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false
    let stderrText = ''
    let timer = null
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      callback(value)
    }

    let child
    try {
      child = spawnFn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (error) {
      finish(reject, spawnFailure(error, command))
      return
    }
    if (child === null || typeof child !== 'object') {
      finish(reject, new MultimodalError('ffmpeg 抽帧失败：进程无法启动', { code: 'FFMPEG_FAILED' }))
      return
    }

    child.on?.('error', (error) => finish(reject, spawnFailure(error, command)))
    child.stderr?.on?.('data', (chunk) => {
      if (stderrText.length >= STDERR_LIMIT) return
      stderrText += String(chunk ?? '')
    })
    child.on?.('close', (code, signal) => {
      if (code === 0) {
        finish(resolve, undefined)
        return
      }
      const detail = shortMessage(stderrText) !== '' ? `：${shortMessage(stderrText)}` : ''
      const reason = code === null || code === undefined ? `信号 ${signal ?? '未知'}` : `退出码 ${code}`
      finish(reject, new MultimodalError(`ffmpeg 抽帧失败（${reason}）${detail}`, { code: 'FFMPEG_FAILED' }))
    })

    timer = setTimeout(() => {
      try {
        child.kill?.('SIGKILL')
      } catch {
        // best effort; the typed timeout error is what matters
      }
      finish(reject, new MultimodalError(`ffmpeg 抽帧超时（${timeoutMs}ms）`, { code: 'FFMPEG_TIMEOUT' }))
    }, timeoutMs)
  })
}

/**
 * Extract up to `frameCount` JPEG frames from a video buffer.
 *
 * Command shape (contract):
 * `ffmpeg -hide_banner -loglevel error -i <input> -vf fps=1/<intervalSec> -frames:v <n> <out>-%02d.jpg`
 *
 * @param {{
 *   buffer: Buffer,
 *   mime?: string,
 *   frameCount?: number,
 *   intervalSec?: number,
 *   ffmpegPath?: string,
 *   spawnImpl?: typeof import('node:child_process').spawn,
 *   tmpDir?: string
 * }} input
 * @returns {Promise<{ frames: Buffer[], mime: 'image/jpeg' }>}
 */
export async function extractVideoFrames({
  buffer,
  mime,
  frameCount = DEFAULT_FRAME_COUNT,
  intervalSec = DEFAULT_INTERVAL_SEC,
  ffmpegPath = 'ffmpeg',
  spawnImpl,
  tmpDir
} = {}) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : undefined
  if (bytes === undefined || bytes.length === 0) {
    throw new MultimodalError('视频内容为空，无法抽帧', { code: 'EMPTY_MEDIA' })
  }

  const framesWanted = normalizeInteger(frameCount, DEFAULT_FRAME_COUNT, { min: 1, max: MAX_FRAME_COUNT })
  const interval = normalizeNumber(intervalSec, DEFAULT_INTERVAL_SEC, { min: MIN_INTERVAL_SEC, max: MAX_INTERVAL_SEC })
  const command = typeof ffmpegPath === 'string' && ffmpegPath.trim() !== '' ? ffmpegPath.trim() : 'ffmpeg'
  const spawnFn = typeof spawnImpl === 'function' ? spawnImpl : defaultSpawn
  const baseTmp = typeof tmpDir === 'string' && tmpDir.trim() !== '' ? path.resolve(tmpDir.trim()) : os.tmpdir()
  await fs.mkdir(baseTmp, { recursive: true })

  let workDir
  try {
    workDir = await fs.mkdtemp(path.join(baseTmp, 'qqbot-frames-'))
    const inputFile = path.join(workDir, `input${extensionForMime(mime)}`)
    const outputPattern = path.join(workDir, 'out-%02d.jpg')
    await fs.writeFile(inputFile, bytes)

    const args = ['-hide_banner', '-loglevel', 'error', '-i', inputFile, '-vf', `fps=1/${interval}`, '-frames:v', String(framesWanted), outputPattern]
    await runFfmpeg({ command, args, spawnFn, timeoutMs: DEFAULT_TIMEOUT_MS })

    let names
    try {
      names = await fs.readdir(workDir)
    } catch (error) {
      if (error?.code === 'ENOENT') names = []
      else throw error
    }
    const frameFiles = names
      .filter((name) => /^out-\d+\.jpg$/i.test(name))
      .sort((left, right) => frameIndex(left) - frameIndex(right))
      .slice(0, framesWanted)
    if (frameFiles.length === 0) {
      throw new MultimodalError('ffmpeg 没有产出任何视频帧', { code: 'FFMPEG_NO_FRAMES' })
    }

    const frames = []
    for (const file of frameFiles) frames.push(await fs.readFile(path.join(workDir, file)))
    return { frames, mime: 'image/jpeg' }
  } finally {
    if (workDir !== undefined) {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}
