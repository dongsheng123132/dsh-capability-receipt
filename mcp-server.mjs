#!/usr/bin/env node
import readline from 'node:readline'
import { inspectPackAgentLockJson, verifyRecordedPackCapability } from './lib/capability-receipt.mjs'

const MAX_LINE_BYTES = 2 * 1024 * 1024
const hash = { type: 'string', pattern: '^[a-f0-9]{64}$' }
const packHash = { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' }
const tools = [
  {
    name: 'capability_receipt_inspect_lock',
    description: 'Inspect one inline pack-agent skill lock entry without filesystem access, source bodies, or secrets.',
    inputSchema: {
      type: 'object', required: ['lockJson', 'skillName'], additionalProperties: false,
      properties: { lockJson: { type: 'string', maxLength: 1048576 }, skillName: { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' } }
    }
  },
  {
    name: 'capability_receipt_verify_recorded',
    description: 'Compare a recorded DSH effective skill and resource hashes with one inline pack-agent lock. Proof-only: no files, network, capability execution, or source bodies.',
    inputSchema: {
      type: 'object', required: ['lockJson', 'skillName', 'observedContentSha256', 'skillFileBodySha256', 'directoryContentHash', 'bundleContentHash', 'fileCount'], additionalProperties: false,
      properties: { lockJson: { type: 'string', maxLength: 1048576 }, skillName: { type: 'string' }, observedContentSha256: hash, skillFileBodySha256: hash, directoryContentHash: packHash, bundleContentHash: packHash, fileCount: { type: 'integer', minimum: 1 } }
    }
  }
]

function call(name, args) {
  if (name === 'capability_receipt_inspect_lock') return { ...inspectPackAgentLockJson(args.lockJson, args.skillName), disclosure: { proofOnly: true, filesystemAccess: false, networkAccess: false, rawContentIncluded: false } }
  if (name === 'capability_receipt_verify_recorded') return verifyRecordedPackCapability(args)
  throw Object.assign(new Error(`Unknown tool: ${name}`), { code: 'METHOD_NOT_FOUND' })
}

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of lines) {
  if (!line.trim() || Buffer.byteLength(line) > MAX_LINE_BYTES) continue
  let request
  try { request = JSON.parse(line) } catch { continue }
  if (request.id === undefined) continue
  try {
    if (request.method === 'initialize') send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: request.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'dsh-capability-receipt', version: '0.3.0' } } })
    else if (request.method === 'tools/list') send({ jsonrpc: '2.0', id: request.id, result: { tools } })
    else if (request.method === 'tools/call') {
      const result = call(request.params?.name, request.params?.arguments ?? {})
      send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } })
    } else send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })
  } catch (error) {
    send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: error.message, data: { code: error.code ?? 'ERROR' } } })
  }
}
