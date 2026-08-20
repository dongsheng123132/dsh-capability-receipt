import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'

const lockJson = await readFile('test/fixtures/pack-agent-project/.agent-pack/lock.json', 'utf8')
const child = spawn(process.execPath, ['mcp-server.mjs'], { cwd: process.cwd(), shell: false, stdio: ['pipe', 'pipe', 'inherit'] })
let output = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => { output += chunk })
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`)
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`)
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'capability_receipt_inspect_lock', arguments: { lockJson, skillName: 'runtime-proof' } } })}\n`)
child.stdin.end()
await new Promise((resolve, reject) => { child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`MCP exited ${code}`))); child.on('error', reject) })
const messages = output.trim().split(/\r?\n/).map(JSON.parse)
assert.equal(messages[0].result.serverInfo.version, '0.3.0')
assert.deepEqual(messages[1].result.tools.map(({ name }) => name), ['capability_receipt_inspect_lock', 'capability_receipt_verify_recorded'])
assert.equal(messages[2].result.structuredContent.disclosure.proofOnly, true)
assert.equal(messages[2].result.structuredContent.disclosure.filesystemAccess, false)
process.stdout.write(`${JSON.stringify({ ok: true, proofOnly: true, tools: messages[1].result.tools.map(({ name }) => name) })}\n`)
