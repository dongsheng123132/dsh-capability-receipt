import assert from 'node:assert/strict'
import * as plugin from '../index.js'

const registry = { snapshot() {}, get() {} }
const definitions = plugin.createDefinitions({ skills: registry }, { workspaceRoot: process.cwd() })
assert.deepEqual(plugin.inject, ['tools', 'skills'])
assert.equal('default' in plugin, false)
assert.deepEqual(definitions.map(({ name }) => name), [
  'dsh_capability_receipt_inspect',
  'dsh_capability_receipt_issue',
  'dsh_capability_receipt_issue_from_pack'
])
assert.equal(definitions[1].parameters.properties.expectedModelInvocable.type, 'boolean')
process.stdout.write(`${JSON.stringify({ ok: true, inject: plugin.inject, hostNeutral: true, tools: definitions.map(({ name }) => name) })}\n`)
