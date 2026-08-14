import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, link, mkdir, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export const SCHEMA_VERSION = 'dsh-capability-receipt/v1'
export const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 256,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024
})

const SHA256 = /^[a-f0-9]{64}$/

export class CapabilityReceiptError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'CapabilityReceiptError'
    this.code = code
  }
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeJson(value) {
  if (Array.isArray(value)) return value.map(normalizeJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().flatMap((key) => {
      const child = value[key]
      return child === undefined ? [] : [[key, normalizeJson(child)]]
    }))
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new CapabilityReceiptError('non-json-value', 'Non-finite number cannot be canonicalized.')
  return value
}

export function canonicalJson(value) {
  return `${JSON.stringify(normalizeJson(value), null, 2)}\n`
}

function hashJson(value) {
  return sha256(canonicalJson(value))
}

function positiveInteger(value, fallback, label) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) throw new CapabilityReceiptError('invalid-limit', `${label} must be a positive safe integer.`)
  return value
}

function normalizeLimits(limits = {}) {
  return {
    maxFiles: positiveInteger(limits.maxFiles, DEFAULT_LIMITS.maxFiles, 'maxFiles'),
    maxFileBytes: positiveInteger(limits.maxFileBytes, DEFAULT_LIMITS.maxFileBytes, 'maxFileBytes'),
    maxTotalBytes: positiveInteger(limits.maxTotalBytes, DEFAULT_LIMITS.maxTotalBytes, 'maxTotalBytes')
  }
}

function assertSkillName(skillName) {
  if (typeof skillName !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName)) {
    throw new CapabilityReceiptError('invalid-skill-name', 'skillName must be a kebab-case DSH skill name.')
  }
}

function assertRelativePath(value, label, { allowDot = false } = {}) {
  if (typeof value !== 'string' || value.length === 0 || isAbsolute(value)) {
    throw new CapabilityReceiptError('unsafe-path', `${label} must be a non-empty relative path.`)
  }
  const normalized = value.replaceAll('\\', '/')
  if ((!allowDot && normalized === '.') || normalized.split('/').includes('..')) {
    throw new CapabilityReceiptError('unsafe-path', `${label} must stay inside workspaceRoot.`)
  }
}

function isInside(parent, child, allowEqual = true) {
  const rel = relative(parent, child)
  if (allowEqual && rel === '') return true
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

async function workspaceContext(workspaceRoot, cwd) {
  const root = await realpath(resolve(workspaceRoot ?? process.cwd()))
  const selected = cwd === undefined ? root : resolve(root, (assertRelativePath(cwd, 'cwd', { allowDot: true }), cwd))
  if (!isInside(root, selected)) throw new CapabilityReceiptError('unsafe-path', 'cwd escapes workspaceRoot.')
  const selectedReal = await realpath(selected)
  if (!isInside(root, selectedReal)) throw new CapabilityReceiptError('unsafe-path', 'cwd resolves outside workspaceRoot.')
  return { root, cwd: selectedReal }
}

function publicResourceBase(resourceBase) {
  if (!resourceBase) return undefined
  return { kind: String(resourceBase.kind ?? 'unknown') }
}

function summaryView(summary) {
  return {
    name: summary.name,
    descriptionSha256: sha256(String(summary.description ?? '')),
    whenToUseSha256: summary.whenToUse === undefined ? null : sha256(String(summary.whenToUse)),
    invocation: {
      modelInvocable: Boolean(summary.invocation?.modelInvocable),
      userInvocable: Boolean(summary.invocation?.userInvocable)
    },
    source: String(summary.source ?? ''),
    provider: String(summary.provider ?? ''),
    resourceBase: publicResourceBase(summary.resourceBase)
  }
}

function catalogView(snapshot) {
  const skills = [...(snapshot?.skills ?? [])].map(summaryView).sort((a, b) => a.name.localeCompare(b.name))
  return { complete: snapshot?.complete === true, skills }
}

async function stableFileDigest(path, limits) {
  const before = await lstat(path, { bigint: true })
  if (before.isSymbolicLink()) throw new CapabilityReceiptError('resource-symlink', 'Resource closure contains a symbolic link.')
  if (!before.isFile()) throw new CapabilityReceiptError('resource-special-file', 'Resource closure contains a non-regular file.')
  if (before.size > BigInt(limits.maxFileBytes)) throw new CapabilityReceiptError('resource-file-limit', 'Resource file exceeds maxFileBytes.')
  const bytes = await readFile(path)
  const after = await lstat(path, { bigint: true })
  if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ino !== after.ino || before.dev !== after.dev) {
    throw new CapabilityReceiptError('resource-raced', 'Resource changed while it was being observed.')
  }
  return { size: bytes.byteLength, sha256: sha256(bytes) }
}

async function scanDirectory(rootPath, definitionPath, limits) {
  const rootStat = await lstat(rootPath)
  if (rootStat.isSymbolicLink()) throw new CapabilityReceiptError('resource-symlink', 'resourceBase is a symbolic link.')
  if (!rootStat.isDirectory()) throw new CapabilityReceiptError('resource-not-directory', 'resourceBase is not a directory.')
  const root = await realpath(rootPath)

  if (definitionPath !== undefined) {
    const definitionStat = await lstat(definitionPath)
    if (definitionStat.isSymbolicLink()) throw new CapabilityReceiptError('definition-symlink', 'Loaded skill path is a symbolic link.')
    const definitionReal = await realpath(definitionPath)
    if (!isInside(root, definitionReal)) throw new CapabilityReceiptError('definition-outside-resource-base', 'Loaded skill path is outside resourceBase.')
  }

  const entries = []
  let totalBytes = 0

  async function walk(directory) {
    const children = await readdir(directory, { withFileTypes: true })
    children.sort((a, b) => a.name.localeCompare(b.name))
    for (const child of children) {
      const absolute = resolve(directory, child.name)
      const stat = await lstat(absolute)
      if (stat.isSymbolicLink()) throw new CapabilityReceiptError('resource-symlink', 'Resource closure contains a symbolic link.')
      if (stat.isDirectory()) {
        await walk(absolute)
        continue
      }
      if (!stat.isFile()) throw new CapabilityReceiptError('resource-special-file', 'Resource closure contains a non-regular file.')
      if (entries.length >= limits.maxFiles) throw new CapabilityReceiptError('resource-file-count-limit', 'Resource closure exceeds maxFiles.')
      const digest = await stableFileDigest(absolute, limits)
      totalBytes += digest.size
      if (totalBytes > limits.maxTotalBytes) throw new CapabilityReceiptError('resource-total-limit', 'Resource closure exceeds maxTotalBytes.')
      entries.push({ path: relative(root, absolute).split(sep).join('/'), ...digest })
    }
  }

  await walk(root)
  return {
    status: 'complete',
    kind: 'directory',
    fileCount: entries.length,
    totalBytes,
    sha256: hashJson(entries),
    files: entries
  }
}

export async function observeResourceClosure(skill, limits = DEFAULT_LIMITS) {
  const normalizedLimits = normalizeLimits(limits)
  const base = skill.resourceBase
  if (!base) return { status: 'none', kind: 'none' }
  if (base.kind !== 'directory') return { status: 'unavailable', kind: String(base.kind ?? 'unknown'), code: 'non-local-resource-base' }
  try {
    return await scanDirectory(base.path, skill.path, normalizedLimits)
  } catch (error) {
    if (error instanceof CapabilityReceiptError) return { status: 'error', kind: 'directory', code: error.code }
    throw error
  }
}

function skillView(skill) {
  return {
    name: skill.name,
    provider: String(skill.provider ?? ''),
    source: String(skill.source ?? ''),
    invocation: {
      modelInvocable: Boolean(skill.invocation?.modelInvocable),
      userInvocable: Boolean(skill.invocation?.userInvocable)
    },
    descriptionSha256: sha256(String(skill.description ?? '')),
    whenToUseSha256: skill.whenToUse === undefined ? null : sha256(String(skill.whenToUse)),
    contentSha256: sha256(String(skill.content ?? '')),
    metadataSha256: skill.metadata === undefined ? null : hashJson(skill.metadata),
    resourceBase: publicResourceBase(skill.resourceBase)
  }
}

export async function inspectRegistryCapability({ registry, workspaceRoot, cwd, skillName, limits }) {
  if (!registry || typeof registry.snapshot !== 'function' || typeof registry.get !== 'function') {
    throw new CapabilityReceiptError('missing-skill-registry', 'A DSH skill registry is required.')
  }
  assertSkillName(skillName)
  const workspace = await workspaceContext(workspaceRoot, cwd)
  const options = { cwd: workspace.cwd }
  const beforeRaw = await registry.snapshot(options)
  const skill = await registry.get(skillName, options)
  const afterRaw = await registry.snapshot(options)
  if (!skill) throw new CapabilityReceiptError('skill-not-found', `DSH did not load skill ${skillName}.`)
  if (skill.name !== skillName) throw new CapabilityReceiptError('skill-name-mismatch', 'DSH returned a different skill name.')

  const before = catalogView(beforeRaw)
  const after = catalogView(afterRaw)
  const catalogStable = hashJson(before) === hashJson(after)
  const catalogEntry = after.skills.find((entry) => entry.name === skillName)
  const loadedSummary = summaryView(skill)
  const catalogEntryConsistent = catalogEntry !== undefined && hashJson(catalogEntry) === hashJson(loadedSummary)
  const resourceClosure = await observeResourceClosure(skill, limits)

  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'dsh.capability.observation',
    skill: skillView(skill),
    catalog: {
      complete: after.complete,
      stable: catalogStable,
      entryConsistent: catalogEntryConsistent,
      skillCount: after.skills.length,
      sha256: hashJson(after)
    },
    resourceClosure,
    disclosure: {
      executesCapability: false,
      rawContentIncluded: false,
      rawMetadataIncluded: false,
      absolutePathsIncluded: false
    }
  }
}

function assertExpected(expected) {
  if (!expected || !SHA256.test(String(expected.contentSha256 ?? ''))) {
    throw new CapabilityReceiptError('invalid-expected-hash', 'expectedContentSha256 must be 64 lowercase hexadecimal characters.')
  }
  if (expected.resourceClosureSha256 !== undefined && !SHA256.test(String(expected.resourceClosureSha256))) {
    throw new CapabilityReceiptError('invalid-expected-hash', 'expectedResourceClosureSha256 must be 64 lowercase hexadecimal characters.')
  }
}

function comparison(name, expected, actual) {
  return { name, expected, actual, match: expected === actual }
}

export function buildCapabilityReceipt(observation, expected) {
  assertExpected(expected)
  const checks = [comparison('contentSha256', expected.contentSha256, observation.skill.contentSha256)]
  if (expected.resourceClosureSha256 !== undefined) checks.push(comparison('resourceClosureSha256', expected.resourceClosureSha256, observation.resourceClosure.sha256 ?? null))
  if (expected.provider !== undefined) checks.push(comparison('provider', expected.provider, observation.skill.provider))
  if (expected.source !== undefined) checks.push(comparison('source', expected.source, observation.skill.source))
  if (expected.modelInvocable !== undefined) checks.push(comparison('modelInvocable', expected.modelInvocable, observation.skill.invocation.modelInvocable))
  if (expected.userInvocable !== undefined) checks.push(comparison('userInvocable', expected.userInvocable, observation.skill.invocation.userInvocable))

  const findings = []
  if (!observation.catalog.complete) findings.push('catalog-incomplete')
  if (!observation.catalog.stable) findings.push('catalog-changed-during-observation')
  if (!observation.catalog.entryConsistent) findings.push('catalog-entry-mismatch')
  if (observation.resourceClosure.status === 'unavailable') findings.push('resource-closure-unavailable')
  if (observation.resourceClosure.status === 'error') findings.push(`resource-closure-${observation.resourceClosure.code}`)
  for (const check of checks) if (!check.match) findings.push(`expected-${check.name}-mismatch`)
  findings.sort()

  const payload = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'dsh.capability.receipt',
    observation,
    checks,
    verification: { status: findings.length === 0 ? 'verified' : 'failed', findings }
  }
  return { ...payload, receiptSha256: hashJson(payload) }
}

async function ensureSafeDirectory(workspaceRoot, relativeDirectory) {
  assertRelativePath(relativeDirectory, 'artifactDir')
  const parts = relativeDirectory.replaceAll('\\', '/').split('/').filter((part) => part && part !== '.')
  let cursor = workspaceRoot
  for (const part of parts) {
    cursor = resolve(cursor, part)
    if (!isInside(workspaceRoot, cursor, false)) throw new CapabilityReceiptError('unsafe-path', 'artifactDir escapes workspaceRoot.')
    try {
      const stat = await lstat(cursor)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new CapabilityReceiptError('unsafe-path', 'artifactDir crosses a link or non-directory.')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      await mkdir(cursor)
    }
  }
  const directory = await realpath(cursor)
  if (!isInside(workspaceRoot, directory, false)) throw new CapabilityReceiptError('unsafe-path', 'artifactDir resolves outside workspaceRoot.')
  return directory
}

export async function writeCapabilityReceipt({ workspaceRoot, artifactDir, receipt }) {
  const workspace = await workspaceContext(workspaceRoot)
  const directory = await ensureSafeDirectory(workspace.root, artifactDir)
  const filename = `capability-receipt-${receipt.receiptSha256}.json`
  const destination = resolve(directory, filename)
  const body = canonicalJson(receipt)
  const temporary = resolve(directory, `.${filename}.${randomUUID()}.tmp`)
  await writeFile(temporary, body, { flag: 'wx', mode: 0o600 })
  try {
    try {
      await link(temporary, destination)
      return { path: relative(workspace.root, destination).split(sep).join('/'), replayed: false }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const existing = await readFile(destination, 'utf8')
      if (existing !== body) throw new CapabilityReceiptError('receipt-diverged', 'Existing content-addressed receipt has different bytes.')
      return { path: relative(workspace.root, destination).split(sep).join('/'), replayed: true }
    }
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

export async function issueRegistryCapabilityReceipt(options) {
  const observation = await inspectRegistryCapability(options)
  const receipt = buildCapabilityReceipt(observation, options.expected)
  const artifact = await writeCapabilityReceipt({ workspaceRoot: options.workspaceRoot, artifactDir: options.artifactDir, receipt })
  return {
    ok: receipt.verification.status === 'verified',
    status: receipt.verification.status,
    receiptSha256: receipt.receiptSha256,
    artifact,
    findings: receipt.verification.findings
  }
}

export async function verifyCapabilityReceiptFile(path, { requireVerified = false } = {}) {
  const body = await readFile(path, 'utf8')
  let receipt
  try {
    receipt = JSON.parse(body)
  } catch {
    throw new CapabilityReceiptError('invalid-json', 'Receipt is not valid JSON.')
  }
  if (receipt.schemaVersion !== SCHEMA_VERSION || receipt.kind !== 'dsh.capability.receipt') {
    throw new CapabilityReceiptError('invalid-schema', 'Receipt schema or kind is unsupported.')
  }
  const claimed = receipt.receiptSha256
  if (!SHA256.test(String(claimed ?? ''))) throw new CapabilityReceiptError('invalid-receipt-hash', 'Receipt hash is missing or invalid.')
  const { receiptSha256: _ignored, ...payload } = receipt
  const actual = hashJson(payload)
  if (actual !== claimed) throw new CapabilityReceiptError('receipt-hash-mismatch', 'Receipt content does not match receiptSha256.')
  const expectedFilename = `capability-receipt-${claimed}.json`
  const filenameMatches = path.replaceAll('\\', '/').endsWith(`/${expectedFilename}`) || path === expectedFilename
  if (!filenameMatches) throw new CapabilityReceiptError('receipt-filename-mismatch', 'Receipt filename is not content-addressed by receiptSha256.')
  if (requireVerified && receipt.verification?.status !== 'verified') {
    throw new CapabilityReceiptError('receipt-not-verified', 'Receipt verification status is not verified.')
  }
  return { ok: true, receiptSha256: claimed, status: receipt.verification?.status, filenameMatches }
}

export async function canRead(path) {
  try {
    await access(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}
