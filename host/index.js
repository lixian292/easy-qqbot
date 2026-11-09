/**
 * Cordis plugin entry. The bundle patch inserts the row `{ id: qqbot, name: easy-qqbot }`,
 * and the loader calls `apply(ctx, config)` once the profile mounts it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from './app.js'

export const name = 'qqbot'

const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

function recordBootFailure(ctx, error) {
  const message = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error)
  ctx.logger?.error?.('[qqbot] 插件初始化失败', error)
  // The host logger is not persisted to our own log file during early failures,
  // so keep a dedicated boot error file next to the runtime data for diagnosis.
  for (const file of [path.join(PACKAGE_ROOT, 'data', 'logs', 'boot-error.log')]) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFileSync(file, `[${new Date().toISOString()}] ${message}\n\n`, 'utf8')
    } catch {
      // Diagnostics are best effort; never mask the original failure.
    }
  }
}

/**
 * Boot the qqbot application. Initialization is asynchronous (config + stores +
 * QQ connection); the Cordis effect keeps the returned disposer so unload/HMR
 * detaches the HTTP route, timers and WebSocket cleanly.
 */
export function apply(ctx) {
  let app = undefined
  let disposed = false

  const ready = createApp({ ctx })
    .then((created) => {
      app = created
      if (disposed) created.dispose()
      return created
    })
    .catch((error) => {
      recordBootFailure(ctx, error)
      return undefined
    })

  ctx.effect(
    () => () => {
      disposed = true
      if (app !== undefined) {
        Promise.resolve()
          .then(() => app.dispose())
          .catch(() => {})
      } else {
        ready.then((created) => created?.dispose()).catch(() => {})
      }
    },
    'qqbot: lifecycle'
  )

  return undefined
}
