import assert from 'node:assert/strict'
import { createDefinitions, inject } from '../index.js'

const registry = { snapshot() {}, get() {} }
const definitions = createDefinitions({ skills: registry }, { workspaceRoot: process.cwd() })
assert.deepEqual(inject, ['tools', 'skills'])
assert.deepEqual(definitions.map(({ name }) => name), [
  'dsh_capability_receipt_inspect',
  'dsh_capability_receipt_issue'
])
process.stdout.write(`${JSON.stringify({ ok: true, inject, tools: definitions.map(({ name }) => name) })}\n`)
