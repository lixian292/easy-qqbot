/** Small async filesystem helpers shared by every qqbot module. */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

export function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true })
}

export async function pathExists(target) {
  try {
    await fsp.access(target)
    return true
  } catch {
    return false
  }
}

export async function readJson(file, fallback) {
  try {
    const raw = await fsp.readFile(file, 'utf8')
    if (raw.trim() === '') return fallback
    return JSON.parse(raw)
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return fallback
    throw error
  }
}

export function readJsonSync(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    if (raw.trim() === '') return fallback
    return JSON.parse(raw)
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return fallback
    throw error
  }
}

/**
 * Atomically replace a JSON file: write to a sibling temp file, then rename.
 * Concurrent writers on the same file are serialized by their own promise
 * chains; this helper only guarantees readers never see a half-written file.
 */
export async function writeJsonAtomic(file, value, { mode } = {}) {
  const dir = path.dirname(file)
  await ensureDir(dir)
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`)
  const body = `${JSON.stringify(value, null, 2)}\n`
  await fsp.writeFile(tmp, body, mode === undefined ? undefined : { mode })
  await fsp.rename(tmp, file)
}

export async function appendJsonl(file, entry) {
  await ensureDir(path.dirname(file))
  await fsp.appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8')
}

/** Read a JSONL file, returning only parseable lines and never throwing on ENOENT. */
export async function readJsonl(file) {
  let raw
  try {
    raw = await fsp.readFile(file, 'utf8')
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return []
    throw error
  }
  const out = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      out.push(JSON.parse(trimmed))
    } catch {
      // Tolerate a partially written trailing line after a crash.
    }
  }
  return out
}

export async function listFilesRecursive(dir, { maxFiles = 5000 } = {}) {
  const out = []
  async function walk(current) {
    let entries
    try {
      entries = await fsp.readdir(current, { withFileTypes: true })
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return
      throw error
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile()) {
        out.push(full)
      }
    }
  }
  await walk(dir)
  return out
}

export async function sha256File(file) {
  const hash = crypto.createHash('sha256')
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  return hash.digest('hex')
}

export function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

export function extOf(nameOrPath) {
  const ext = path.extname(String(nameOrPath ?? '')).toLowerCase().replace(/^\./, '')
  return ext === '' ? 'bin' : ext
}

export function baseName(nameOrPath) {
  return path.basename(String(nameOrPath ?? ''))
}

/** Safe identifier usable in ids, file names and chat folders. */
export function safeId(value, fallback = 'item') {
  const text = String(value ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return text === '' ? fallback : text
}

export async function moveFile(from, to) {
  await ensureDir(path.dirname(to))
  try {
    await fsp.rename(from, to)
  } catch (error) {
    if (error && error.code === 'EXDEV') {
      await fsp.copyFile(from, to)
      await fsp.unlink(from)
      return
    }
    throw error
  }
}

export async function removeFile(file) {
  try {
    await fsp.unlink(file)
  } catch (error) {
    if (error && error.code === 'ENOENT') return
    throw error
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
