/** Tests for shared admin/output authorization (host/brain/access.js). */
import test from 'node:test'
import assert from 'node:assert/strict'
import { canUseOutput, identityIdsOf, isAdmin, normalizeIdentity } from '../host/brain/access.js'

function config(overrides = {}) {
  return {
    commands: { adminOpenids: [], allowGroupOwner: true, ...(overrides.commands ?? {}) },
    output: { enabled: true, commandAccess: 'admin', ...(overrides.output ?? {}) }
  }
}

test('admin matching accepts user / member / union / author ids case-insensitively', () => {
  const inbound = {
    kind: 'group',
    userId: 'member-openid',
    unionOpenId: 'union-openid',
    authorId: 'QQ123',
    identityIds: ['member-openid', 'union-openid', 'QQ123']
  }
  assert.deepEqual(identityIdsOf(inbound), ['member-openid', 'union-openid', 'qq123'])
  for (const admin of ['member-openid', 'UNION-OPENID', 'qq123']) {
    assert.equal(isAdmin(inbound, config({ commands: { adminOpenids: [admin] } })), true, admin)
  }
  assert.equal(isAdmin(inbound, config({ commands: { adminOpenids: ['someone-else'] } })), false)
  assert.equal(normalizeIdentity('  ABC  '), 'abc')
})

test('group owner/admin fallback only applies to groups when enabled', () => {
  const owner = { kind: 'group', userId: 'member-1', memberRole: 'owner' }
  assert.equal(isAdmin(owner, config()), true)
  assert.equal(isAdmin(owner, config({ commands: { allowGroupOwner: false } })), false)
  assert.equal(isAdmin({ kind: 'c2c', userId: 'member-1', memberRole: 'owner' }, config()), false)
})

test('canUseOutput gates model/chat generation by commandAccess', () => {
  const ordinary = { kind: 'group', userId: 'member-1', memberRole: 'member', identityIds: ['member-1'] }
  const admin = { kind: 'group', userId: 'admin-1', identityIds: ['admin-1'] }
  const cfg = config({ commands: { adminOpenids: ['admin-1'] } })
  assert.equal(canUseOutput(ordinary, cfg), false)
  assert.equal(canUseOutput(admin, cfg), true)
  assert.equal(canUseOutput(ordinary, config({ output: { commandAccess: 'all' } })), true)
  assert.equal(canUseOutput(admin, config({ output: { enabled: false } })), false)
})
