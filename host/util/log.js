/**
 * Plugin logger: fans out to the DSH logger and keeps a bounded in-memory ring
 * buffer (plus a rolling file) that the admin page can tail without reading
 * unbounded history.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { ensureDir } from './fsx.js'

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

export function createLogger({ file, ctxLogger, maxLines = 500, debug = false, label = 'qqbot' } = {}) {
  const buffer = []
  let writeChain = Promise.resolve()
  let lastWrite = 0

  if (typeof file === 'string' && file !== '') {
    try {
      // Best effort warm start: keep the tail of the previous run.
      const raw = fs.readFileSync(file, 'utf8')
      const lines = raw.split('\n').filter((line) => line.trim() !== '')
      for (const line of lines.slice(-maxLines)) buffer.push({ raw: line })
      lastWrite = buffer.length
    } catch {
      // No previous log; fine.
    }
  }

  function trim() {
    while (buffer.length > maxLines) buffer.shift()
  }

  function persist(rows) {
    if (typeof file !== 'string' || file === '') return
    writeChain = writeChain
      .then(async () => {
        await ensureDir(path.dirname(file))
        if (lastWrite > maxLines * 4) {
          // Compact occasionally so the file does not grow forever.
          const tail = buffer.map((row) => row.line ?? row.raw).filter(Boolean).slice(-maxLines)
          await fsp.writeFile(file, `${tail.join('\n')}\n`)
          lastWrite = tail.length
          return
        }
        await fsp.appendFile(file, `${rows.map((row) => row.line ?? row.raw).filter(Boolean).join('\n')}\n`)
        lastWrite += rows.length
      })
      .catch(() => {})
  }

  function write(level, message, detail) {
    if (LEVELS[level] < (debug ? LEVELS.debug : LEVELS.info)) return
    const entry = {
      ts: new Date().toISOString(),
      level,
      msg: String(message ?? ''),
      detail: detail === undefined ? undefined : safeDetail(detail),
      line: ''
    }
    entry.line = JSON.stringify(entry)
    buffer.push(entry)
    trim()
    if (typeof ctxLogger?.info === 'function') {
      const text = `[${label}] ${entry.msg}`
      if (level === 'error') ctxLogger.warn?.(text) ?? ctxLogger.info?.(text)
      else if (level === 'warn') ctxLogger.warn?.(text) ?? ctxLogger.info?.(text)
      else if (level === 'debug') ctxLogger.debug?.(text)
      else ctxLogger.info?.(text)
    }
    persist([entry])
    return entry
  }

  return {
    file,
    debug: (message, detail) => write('debug', message, detail),
    info: (message, detail) => write('info', message, detail),
    warn: (message, detail) => write('warn', message, detail),
    error: (message, detail) => write('error', message, detail),
    /** Recent entries, oldest first, parsed for the admin UI. */
    recent(limit = 200) {
      const size = Math.max(1, Math.min(Number(limit) || 200, maxLines))
      return buffer.slice(-size).map((row) => {
        if (row.raw !== undefined) {
          try {
            return JSON.parse(row.raw)
          } catch {
            return { ts: '', level: 'info', msg: row.raw }
          }
        }
        return row
      })
    },
    /** Wait for pending file writes (used by tests and shutdown). */
    async flush() {
      await writeChain
    }
  }
}

function safeDetail(detail) {
  if (detail === undefined || detail === null) return undefined
  if (typeof detail === 'string') return detail.length > 2000 ? `${detail.slice(0, 2000)}…` : detail
  if (detail instanceof Error) return { name: detail.name, message: detail.message, code: detail.code }
  try {
    const text = JSON.stringify(detail)
    if (text.length > 2000) return { truncated: text.slice(0, 2000) }
    return JSON.parse(text)
  } catch {
    return String(detail).slice(0, 2000)
  }
}
