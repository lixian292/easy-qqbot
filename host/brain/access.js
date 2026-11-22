/**
 * Shared authorization for chat commands and model-initiated multimodal output.
 *
 * QQ uses several identifiers for one person (member_openid in a group,
 * user_openid in single chat, union_openid across scenes, and sometimes the QQ
 * uin in `id`). An admin may have copied any one of them into
 * `commands.adminOpenids`, so matching must consider the whole identity set and
 * compare case-insensitively.
 */
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

export function normalizeIdentity(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

/** All known identifiers for the inbound speaker (primary first). */
export function identityIdsOf(inbound) {
  const values = [
    inbound?.userId,
    inbound?.userOpenId,
    inbound?.memberOpenId,
    inbound?.unionOpenId,
    inbound?.authorId,
    ...(Array.isArray(inbound?.identityIds) ? inbound.identityIds : [])
  ]
  const out = []
  for (const value of values) {
    const id = normalizeIdentity(value)
    if (id !== '' && !out.includes(id)) out.push(id)
  }
  return out
}

/** Is this speaker configured as an admin (or group owner/admin when allowed)? */
export function isAdmin(inbound, config) {
  const commands = isPlainObject(config?.commands) ? config.commands : {}
  const configured = Array.isArray(commands.adminOpenids) ? commands.adminOpenids.map(normalizeIdentity).filter(Boolean) : []
  if (configured.length > 0) {
    const identities = identityIdsOf(inbound)
    if (identities.some((identity) => configured.includes(identity))) return true
  }
  if (commands.allowGroupOwner === true && inbound?.kind === 'group') {
    return inbound.memberRole === 'owner' || inbound.memberRole === 'admin'
  }
  return false
}

/**
 * Whether this speaker may trigger multimodal generation.
 * `commandAccess=admin` gates both chat commands and model output directives.
 */
export function canUseOutput(inbound, config) {
  const output = isPlainObject(config?.output) ? config.output : {}
  if (output.enabled !== true) return false
  if (output.commandAccess === 'all') return true
  return isAdmin(inbound, config)
}
