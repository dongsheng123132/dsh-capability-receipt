import { createHash, randomUUID } from 'node:crypto'
import { lstat, link, mkdir, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export const SCHEMA_VERSION = 'dsh-capability-receipt/v1'
export const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 256,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024
})

const SHA256 = /^[a-f0-9]{64}$/
const PACK_AGENT_SHA256 = /^sha256:[a-f0-9]{64}$/
const PACK_AGENT_LOCK_SCHEMA = 'agent-pack/lock/v1'
const MAX_PACK_LOCK_BYTES = 1024 * 1024

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
  return { size: bytes.byteLength, sha256: sha256(bytes), text: bytes.toString('utf8') }
}

export function packAgentSkillContentHash(files, { bundleSkillName } = {}) {
  const prefix = bundleSkillName === undefined ? '' : `skills/${bundleSkillName}/`
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path))
  const payload = sorted.map((file) => `${prefix}${file.path}\n${file.text}`).join('\n---\n')
  return `sha256:${sha256(payload)}`
}

function dshSkillBody(raw) {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0 || raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return raw.trim()
  let lineStart = firstLineEnd + 1
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      return raw.slice(nextNewline < 0 ? raw.length : nextNewline + 1).trim()
    }
    if (nextNewline < 0) break
    lineStart = nextNewline + 1
  }
  return raw.trim()
}

async function scanDirectory(rootPath, definitionPath, effectiveContent, skillName, limits) {
  const rootStat = await lstat(rootPath)
  if (rootStat.isSymbolicLink()) throw new CapabilityReceiptError('resource-symlink', 'resourceBase is a symbolic link.')
  if (!rootStat.isDirectory()) throw new CapabilityReceiptError('resource-not-directory', 'resourceBase is not a directory.')
  const root = await realpath(rootPath)

  let definitionRelativePath = 'SKILL.md'
  if (definitionPath !== undefined) {
    const definitionStat = await lstat(definitionPath)
    if (definitionStat.isSymbolicLink()) throw new CapabilityReceiptError('definition-symlink', 'Loaded skill path is a symbolic link.')
    const definitionReal = await realpath(definitionPath)
    if (!isInside(root, definitionReal)) throw new CapabilityReceiptError('definition-outside-resource-base', 'Loaded skill path is outside resourceBase.')
    definitionRelativePath = relative(root, definitionReal).split(sep).join('/')
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
  const skillFile = entries.find((entry) => entry.path === definitionRelativePath)
  const skillFileBodySha256 = skillFile === undefined ? null : sha256(dshSkillBody(skillFile.text))
  const publicEntries = entries.map(({ text: _text, ...entry }) => entry)
  return {
    status: 'complete',
    kind: 'directory',
    fileCount: entries.length,
    totalBytes,
    sha256: hashJson(publicEntries),
    files: publicEntries,
    packAgent: {
      algorithm: 'pack-agent/versioning.ts@e2db1f8',
      directoryContentHash: packAgentSkillContentHash(entries),
      bundleContentHash: packAgentSkillContentHash(entries, { bundleSkillName: skillName }),
      definitionPath: definitionRelativePath,
      skillFileBodySha256,
      effectiveContentMatchesSkillFile: skillFileBodySha256 !== null && skillFileBodySha256 === sha256(String(effectiveContent ?? ''))
    }
  }
}

export async function observeResourceClosure(skill, limits = DEFAULT_LIMITS) {
  const normalizedLimits = normalizeLimits(limits)
  const base = skill.resourceBase
  if (!base) return { status: 'none', kind: 'none' }
  if (base.kind !== 'directory') return { status: 'unavailable', kind: String(base.kind ?? 'unknown'), code: 'non-local-resource-base' }
  try {
    return await scanDirectory(base.path, skill.path, skill.content, skill.name, normalizedLimits)
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

function observationFindings(observation) {
  const findings = []
  if (!observation.catalog.complete) findings.push('catalog-incomplete')
  if (!observation.catalog.stable) findings.push('catalog-changed-during-observation')
  if (!observation.catalog.entryConsistent) findings.push('catalog-entry-mismatch')
  if (observation.resourceClosure.status === 'unavailable') findings.push('resource-closure-unavailable')
  if (observation.resourceClosure.status === 'error') findings.push(`resource-closure-${observation.resourceClosure.code}`)
  return findings
}

export function buildCapabilityReceipt(observation, expected) {
  assertExpected(expected)
  const checks = [comparison('contentSha256', expected.contentSha256, observation.skill.contentSha256)]
  if (expected.resourceClosureSha256 !== undefined) checks.push(comparison('resourceClosureSha256', expected.resourceClosureSha256, observation.resourceClosure.sha256 ?? null))
  if (expected.provider !== undefined) checks.push(comparison('provider', expected.provider, observation.skill.provider))
  if (expected.source !== undefined) checks.push(comparison('source', expected.source, observation.skill.source))
  if (expected.modelInvocable !== undefined) checks.push(comparison('modelInvocable', expected.modelInvocable, observation.skill.invocation.modelInvocable))
  if (expected.userInvocable !== undefined) checks.push(comparison('userInvocable', expected.userInvocable, observation.skill.invocation.userInvocable))

  const findings = observationFindings(observation)
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

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

async function readStableWorkspaceFile(workspaceRoot, relativePath, label, maxBytes) {
  assertRelativePath(relativePath, label)
  const target = resolve(workspaceRoot, relativePath)
  if (!isInside(workspaceRoot, target, false)) throw new CapabilityReceiptError('unsafe-path', `${label} escapes workspaceRoot.`)
  const before = await lstat(target, { bigint: true })
  if (before.isSymbolicLink() || !before.isFile()) throw new CapabilityReceiptError('unsafe-source-file', `${label} must be a regular non-link file.`)
  const targetReal = await realpath(target)
  if (!isInside(workspaceRoot, targetReal, false)) throw new CapabilityReceiptError('unsafe-path', `${label} resolves outside workspaceRoot.`)
  if (before.size > BigInt(maxBytes)) throw new CapabilityReceiptError('source-file-limit', `${label} exceeds its byte limit.`)
  const bytes = await readFile(targetReal)
  const after = await lstat(targetReal, { bigint: true })
  if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ino !== after.ino || before.dev !== after.dev) {
    throw new CapabilityReceiptError('source-file-raced', `${label} changed while it was being read.`)
  }
  return bytes
}

export function inspectPackAgentLockJson(lockJson, skillName) {
  assertSkillName(skillName)
  if (typeof lockJson !== 'string' || Buffer.byteLength(lockJson) > MAX_PACK_LOCK_BYTES) {
    throw new CapabilityReceiptError('source-file-limit', 'pack-agent lock JSON must be a string no larger than 1 MiB.')
  }
  let lock
  try {
    lock = JSON.parse(lockJson)
  } catch {
    throw new CapabilityReceiptError('invalid-pack-lock-json', 'pack-agent lock is not valid JSON.')
  }
  const document = plainObject(lock)
  if (!document || document.schema !== PACK_AGENT_LOCK_SCHEMA) {
    throw new CapabilityReceiptError('invalid-pack-lock-schema', `pack-agent lock schema must be ${PACK_AGENT_LOCK_SCHEMA}.`)
  }
  const components = plainObject(document.components)
  const skills = plainObject(components?.skills)
  const component = plainObject(skills?.[skillName])
  if (!component) throw new CapabilityReceiptError('pack-skill-not-found', `pack-agent lock does not contain skill ${skillName}.`)
  if (!PACK_AGENT_SHA256.test(String(component.contentHash ?? ''))) {
    throw new CapabilityReceiptError('invalid-pack-skill-hash', 'pack-agent skill contentHash must be sha256:<64 lowercase hex>.')
  }
  if (!Number.isSafeInteger(component.fileCount) || component.fileCount < 1) {
    throw new CapabilityReceiptError('invalid-pack-skill-file-count', 'pack-agent skill fileCount must be a positive safe integer.')
  }
  if (typeof document.packName !== 'string' || document.packName.length === 0 || typeof document.packVersion !== 'string' || document.packVersion.length === 0) {
    throw new CapabilityReceiptError('invalid-pack-identity', 'pack-agent lock requires non-empty packName and packVersion.')
  }
  if (document.packContentHash !== undefined && !PACK_AGENT_SHA256.test(String(document.packContentHash))) {
    throw new CapabilityReceiptError('invalid-pack-content-hash', 'packContentHash must be sha256:<64 lowercase hex> when present.')
  }
  return {
    kind: 'pack-agent-lock',
    schema: PACK_AGENT_LOCK_SCHEMA,
    lockFileSha256: sha256(lockJson),
    packName: document.packName,
    packVersion: document.packVersion,
    packContentHash: document.packContentHash ?? null,
    skillName,
    skillVersion: typeof component.version === 'string' ? component.version : null,
    skillContentHash: component.contentHash,
    skillFileCount: component.fileCount
  }
}

export async function loadPackAgentExpectation({ workspaceRoot, packLockPath, skillName }) {
  const workspace = await workspaceContext(workspaceRoot)
  const bytes = await readStableWorkspaceFile(workspace.root, packLockPath, 'packLockPath', MAX_PACK_LOCK_BYTES)
  return inspectPackAgentLockJson(bytes.toString('utf8'), skillName)
}

export function verifyRecordedPackCapability({
  lockJson,
  skillName,
  observedContentSha256,
  skillFileBodySha256,
  directoryContentHash,
  bundleContentHash,
  fileCount
}) {
  const expectation = inspectPackAgentLockJson(lockJson, skillName)
  for (const [label, value] of Object.entries({ observedContentSha256, skillFileBodySha256 })) {
    if (!SHA256.test(String(value ?? ''))) throw new CapabilityReceiptError('invalid-observed-hash', `${label} must be 64 lowercase hexadecimal characters.`)
  }
  for (const [label, value] of Object.entries({ directoryContentHash, bundleContentHash })) {
    if (!PACK_AGENT_SHA256.test(String(value ?? ''))) throw new CapabilityReceiptError('invalid-observed-hash', `${label} must be sha256:<64 lowercase hex>.`)
  }
  if (!Number.isSafeInteger(fileCount) || fileCount < 1) throw new CapabilityReceiptError('invalid-observed-file-count', 'fileCount must be a positive safe integer.')
  const matchedHashMode = expectation.skillContentHash === directoryContentHash
    ? 'directory'
    : expectation.skillContentHash === bundleContentHash
      ? 'bundle'
      : null
  const checks = [
    { name: 'packAgentSkillContentHash', expected: expectation.skillContentHash, actual: { directory: directoryContentHash, bundle: bundleContentHash }, match: matchedHashMode !== null, matchedMode: matchedHashMode },
    comparison('packAgentSkillFileCount', expectation.skillFileCount, fileCount),
    comparison('effectiveContentSha256', skillFileBodySha256, observedContentSha256)
  ]
  const findings = checks.filter((check) => !check.match).map((check) => `expected-${check.name}-mismatch`).sort()
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'dsh.capability.recorded-verdict',
    source: expectation,
    observation: { skillName, observedContentSha256, skillFileBodySha256, directoryContentHash, bundleContentHash, fileCount },
    checks,
    verification: { status: findings.length === 0 ? 'verified' : 'failed', findings, matchedHashMode },
    disclosure: { proofOnly: true, filesystemAccess: false, networkAccess: false, rawContentIncluded: false }
  }
  return { ...payload, verdictSha256: hashJson(payload) }
}

export function buildPackAgentCapabilityReceipt(observation, packExpectation, expected = {}) {
  const compatibility = observation.resourceClosure?.packAgent
  const directoryHash = compatibility?.directoryContentHash ?? null
  const bundleHash = compatibility?.bundleContentHash ?? null
  const matchedHashMode = packExpectation.skillContentHash === directoryHash
    ? 'directory'
    : packExpectation.skillContentHash === bundleHash
      ? 'bundle'
      : null
  const checks = [
    {
      name: 'packAgentSkillContentHash',
      expected: packExpectation.skillContentHash,
      actual: { directory: directoryHash, bundle: bundleHash },
      match: matchedHashMode !== null,
      matchedMode: matchedHashMode
    },
    comparison('packAgentSkillFileCount', packExpectation.skillFileCount, observation.resourceClosure?.fileCount ?? null),
    comparison('contentSha256', compatibility?.skillFileBodySha256 ?? null, observation.skill.contentSha256)
  ]
  if (expected.provider !== undefined) checks.push(comparison('provider', expected.provider, observation.skill.provider))
  if (expected.source !== undefined) checks.push(comparison('source', expected.source, observation.skill.source))
  if (expected.modelInvocable !== undefined) checks.push(comparison('modelInvocable', expected.modelInvocable, observation.skill.invocation.modelInvocable))
  if (expected.userInvocable !== undefined) checks.push(comparison('userInvocable', expected.userInvocable, observation.skill.invocation.userInvocable))

  const findings = observationFindings(observation)
  if (!compatibility) findings.push('pack-agent-resource-compatibility-unavailable')
  else {
    if (compatibility.definitionPath !== 'SKILL.md') findings.push('pack-agent-definition-is-not-skill-md')
    if (!compatibility.effectiveContentMatchesSkillFile) findings.push('effective-content-does-not-match-skill-file')
  }
  for (const check of checks) if (!check.match) findings.push(`expected-${check.name}-mismatch`)
  findings.sort()

  const payload = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'dsh.capability.receipt',
    source: packExpectation,
    observation,
    checks,
    verification: { status: findings.length === 0 ? 'verified' : 'failed', findings, matchedHashMode }
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
      const written = await readFile(destination, 'utf8')
      if (written !== body) throw new CapabilityReceiptError('receipt-readback-mismatch', 'Written receipt did not match the requested bytes.')
      return { path: relative(workspace.root, destination).split(sep).join('/'), replayed: false, bytes: Buffer.byteLength(written), verifiedByReadBack: true }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const existing = await readFile(destination, 'utf8')
      if (existing !== body) throw new CapabilityReceiptError('receipt-diverged', 'Existing content-addressed receipt has different bytes.')
      return { path: relative(workspace.root, destination).split(sep).join('/'), replayed: true, bytes: Buffer.byteLength(existing), verifiedByReadBack: true }
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

export async function issueRegistryCapabilityReceiptFromPack(options) {
  const [observation, packExpectation] = await Promise.all([
    inspectRegistryCapability(options),
    loadPackAgentExpectation(options)
  ])
  const receipt = buildPackAgentCapabilityReceipt(observation, packExpectation, options.expected)
  const artifact = await writeCapabilityReceipt({ workspaceRoot: options.workspaceRoot, artifactDir: options.artifactDir, receipt })
  return {
    ok: receipt.verification.status === 'verified',
    status: receipt.verification.status,
    receiptSha256: receipt.receiptSha256,
    artifact,
    findings: receipt.verification.findings,
    pack: {
      name: packExpectation.packName,
      version: packExpectation.packVersion,
      skillVersion: packExpectation.skillVersion,
      matchedHashMode: receipt.verification.matchedHashMode
    }
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
