#!/usr/bin/env node
import { resolve } from 'node:path'
import { CapabilityReceiptError, verifyCapabilityReceiptFile } from '../lib/capability-receipt.mjs'

function usage() {
  return 'Usage: dsh-capability-receipt verify --receipt <path> [--require-verified]\n'
}

function parse(argv) {
  if (argv[0] !== 'verify') throw new CapabilityReceiptError('usage', usage().trim())
  let receipt
  let requireVerified = false
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--receipt') receipt = argv[++index]
    else if (arg === '--require-verified') requireVerified = true
    else throw new CapabilityReceiptError('usage', `Unknown argument: ${arg}`)
  }
  if (!receipt) throw new CapabilityReceiptError('usage', '--receipt is required.')
  return { receipt: resolve(receipt), requireVerified }
}

try {
  const options = parse(process.argv.slice(2))
  const result = await verifyCapabilityReceiptFile(options.receipt, { requireVerified: options.requireVerified })
  process.stdout.write(`${JSON.stringify(result)}\n`)
} catch (error) {
  const code = error instanceof CapabilityReceiptError ? error.code : 'unexpected-error'
  process.stderr.write(`${JSON.stringify({ ok: false, code, message: error.message })}\n`)
  process.exitCode = code === 'usage' ? 1 : 4
}
