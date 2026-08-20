import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  buildPackAgentCapabilityReceipt,
  inspectRegistryCapability,
  issueRegistryCapabilityReceiptFromPack,
  inspectPackAgentLockJson,
  loadPackAgentExpectation,
  verifyRecordedPackCapability,
  verifyCapabilityReceiptFile
} from '../lib/capability-receipt.mjs'

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url))
const effectiveBody = '# Runtime proof\n\nObserve the actual registry winner.'

async function projectFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pack-agent-receipt-'))
  await cp(join(fixtures, 'pack-agent-project'), root, { recursive: true })
  const skillDir = join(root, '.dsh', 'skills', 'runtime-proof')
  const skillPath = join(skillDir, 'SKILL.md')
  const skill = {
    name: 'runtime-proof',
    description: 'Runtime proof fixture from a pack-agent lock.',
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'project-dsh',
    provider: 'filesystem',
    resourceBase: { kind: 'directory', path: skillDir },
    path: skillPath,
    content: effectiveBody
  }
  return { root, skill }
}

function registryFor(skill) {
  return {
    async snapshot() {
      const summary = { ...skill }
      delete summary.content
      delete summary.path
      return { skills: [summary], complete: true }
    },
    async get(name) { return name === skill.name ? skill : undefined }
  }
}

test('maps the pinned pack-agent lock contract without importing ref or lockedAt', async () => {
  const { root } = await projectFixture()
  const expectation = await loadPackAgentExpectation({
    workspaceRoot: root,
    packLockPath: '.agent-pack/lock.json',
    skillName: 'runtime-proof'
  })
  assert.equal(expectation.schema, 'agent-pack/lock/v1')
  assert.equal(expectation.skillContentHash, 'sha256:47681252742bf479cdc60ac5bab695b25f54390168840f53cd0969c5ff9ca53e')
  assert.equal(expectation.skillFileCount, 2)
  assert.equal('ref' in expectation, false)
  assert.equal('lockedAt' in expectation, false)

  const provenance = JSON.parse(await readFile(join(fixtures, 'pack-agent-upstream.json'), 'utf8'))
  assert.equal(provenance.revision, 'e2db1f8f56b74b64597a01175c810358f2c0b450')
  assert.equal(provenance.lockSchema, expectation.schema)
})

test('inspects and verifies inline recorded evidence without filesystem access', async () => {
  const lockJson = await readFile(join(fixtures, 'pack-agent-project', '.agent-pack', 'lock.json'), 'utf8')
  const expectation = inspectPackAgentLockJson(lockJson, 'runtime-proof')
  const verdict = verifyRecordedPackCapability({
    lockJson,
    skillName: 'runtime-proof',
    observedContentSha256: '62db611d8dbf9ed5260d24bfc4692cfc4fe6c540654934e74aa7dcdf6e5de808',
    skillFileBodySha256: '62db611d8dbf9ed5260d24bfc4692cfc4fe6c540654934e74aa7dcdf6e5de808',
    directoryContentHash: expectation.skillContentHash,
    bundleContentHash: `sha256:${'0'.repeat(64)}`,
    fileCount: expectation.skillFileCount
  })
  assert.equal(verdict.verification.status, 'verified')
  assert.equal(verdict.verification.matchedHashMode, 'directory')
  assert.equal(verdict.disclosure.filesystemAccess, false)
})

test('recomputes both upstream hash modes and binds the DSH body to locked SKILL.md', async () => {
  const { root, skill } = await projectFixture()
  const observation = await inspectRegistryCapability({ registry: registryFor(skill), workspaceRoot: root, skillName: skill.name })
  assert.equal(observation.resourceClosure.packAgent.directoryContentHash, 'sha256:47681252742bf479cdc60ac5bab695b25f54390168840f53cd0969c5ff9ca53e')
  assert.equal(observation.resourceClosure.packAgent.bundleContentHash, 'sha256:6f7453ffacc8ca87be929e516b790f738a072274000bc56bdcd351699d08b0e9')
  assert.equal(observation.resourceClosure.packAgent.effectiveContentMatchesSkillFile, true)

  const expectation = await loadPackAgentExpectation({ workspaceRoot: root, packLockPath: '.agent-pack/lock.json', skillName: skill.name })
  const receipt = buildPackAgentCapabilityReceipt(observation, expectation, {
    provider: 'filesystem', source: 'project-dsh', modelInvocable: true, userInvocable: true
  })
  assert.equal(receipt.verification.status, 'verified')
  assert.equal(receipt.verification.matchedHashMode, 'directory')

  const bundleReceipt = buildPackAgentCapabilityReceipt(observation, {
    ...expectation,
    skillContentHash: observation.resourceClosure.packAgent.bundleContentHash
  }, {
    provider: 'filesystem', source: 'project-dsh', modelInvocable: true, userInvocable: true
  })
  assert.equal(bundleReceipt.verification.status, 'verified')
  assert.equal(bundleReceipt.verification.matchedHashMode, 'bundle')
})

test('issues a content-addressed receipt from a real lock fixture without leaking source paths', async () => {
  const { root, skill } = await projectFixture()
  const result = await issueRegistryCapabilityReceiptFromPack({
    registry: registryFor(skill),
    workspaceRoot: root,
    skillName: skill.name,
    packLockPath: '.agent-pack/lock.json',
    artifactDir: 'artifacts',
    expected: { provider: 'filesystem', source: 'project-dsh' }
  })
  assert.equal(result.ok, true)
  assert.equal(result.pack.matchedHashMode, 'directory')
  const path = join(root, result.artifact.path)
  await verifyCapabilityReceiptFile(path, { requireVerified: true })
  const serialized = await readFile(path, 'utf8')
  assert.equal(serialized.includes('C:/private/source'), false)
  assert.equal(serialized.includes('lockedAt'), false)
  assert.equal(serialized.includes(effectiveBody), false)
})

test('fails when the lock, file body, or effective DSH body diverges', async () => {
  const { root, skill } = await projectFixture()
  const lockPath = join(root, '.agent-pack', 'lock.json')
  const lock = JSON.parse(await readFile(lockPath, 'utf8'))
  lock.components.skills['runtime-proof'].contentHash = `sha256:${'0'.repeat(64)}`
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`)

  const lockMismatch = await issueRegistryCapabilityReceiptFromPack({
    registry: registryFor(skill), workspaceRoot: root, skillName: skill.name,
    packLockPath: '.agent-pack/lock.json', artifactDir: 'artifacts', expected: {}
  })
  assert.equal(lockMismatch.ok, false)
  assert(lockMismatch.findings.includes('expected-packAgentSkillContentHash-mismatch'))

  const changedSkill = { ...skill, content: `${effectiveBody}\n\nRuntime-only drift.` }
  const bodyMismatch = await issueRegistryCapabilityReceiptFromPack({
    registry: registryFor(changedSkill), workspaceRoot: root, skillName: skill.name,
    packLockPath: '.agent-pack/lock.json', artifactDir: 'artifacts', expected: {}
  })
  assert.equal(bodyMismatch.ok, false)
  assert(bodyMismatch.findings.includes('effective-content-does-not-match-skill-file'))
  assert(bodyMismatch.findings.includes('expected-contentSha256-mismatch'))
})

test('rejects unsafe and malformed pack lock inputs', async () => {
  const { root } = await projectFixture()
  await assert.rejects(() => loadPackAgentExpectation({ workspaceRoot: root, packLockPath: '../lock.json', skillName: 'runtime-proof' }), { code: 'unsafe-path' })
  const malformed = join(root, '.agent-pack', 'bad-lock.json')
  await writeFile(malformed, '{"schema":"other"}\n')
  await assert.rejects(() => loadPackAgentExpectation({ workspaceRoot: root, packLockPath: '.agent-pack/bad-lock.json', skillName: 'runtime-proof' }), { code: 'invalid-pack-lock-schema' })
  assert.equal(dirname(malformed), join(root, '.agent-pack'))
})
