/**
 * Typed error shared by the multimodal modules.
 *
 * Kept in its own file so that download.js / frames.js / client.js can all use
 * the same class without a circular import (client.js re-exports it).
 */
export class MultimodalError extends Error {
  constructor(message, { code = 'MULTIMODAL_ERROR', cause } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'MultimodalError'
    this.code = code
    if (cause !== undefined) this.cause = cause
  }
}

/** Clamp a free-form message so a provider response can never bloat logs/errors. */
export function shortMessage(value, limit = 300) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}
