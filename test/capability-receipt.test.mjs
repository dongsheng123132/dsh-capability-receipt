import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  buildCapabilityReceipt,
  inspectRegistryCapability,
  issueRegistryCapabilityReceipt,
  observeResourceClosure,
  sha256,
  verifyCapabilityReceiptFile
} from '../lib/capability-receipt.mjs'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-capability-receipt-'))
  const skillDir = join(root, '.dsh', 'skills', 'demo-skill')
  await mkdir(join(skillDir, 'references'), { recursive: true })
  const skillPath = join(skillDir, 'SKILL.md')
  await writeFile(skillPath, '# Demo\n\nDo the bounded thing.\n')
  await writeFile(join(skillDir, 'references', 'policy.md'), 'policy-v1\n')
  const skill = {
    name: 'demo-skill',
    description: 'Route demo work.',
    whenToUse: 'When demo work is requested.',
    invocation: { modelInvocable: true, userInvocable: false },
    source: 'project-dsh',
    provider: 'filesystem',
    resourceBase: { kind: 'directory', path: skillDir },
    path: skillPath,
    metadata: { owner: 'example' },
    content: '# Demo\n\nDo the bounded thing.\n'
  }
  return { root, skillDir, skillPath, skill }
}

function registryFor(skill, { complete = true, mutateCatalog = false } = {}) {
  let snapshots = 0
  return {
    async snapshot() {
      snapshots += 1
      const summary = { ...skill }
      delete summary.content
      delete summary.path
      delete summary.metadata
      if (mutateCatalog && snapshots > 1) summary.description = `${summary.description} changed`
      return { skills: [summary], complete }
    },
    async get(name) { return name === skill.name ? skill : undefined }
  }
}

test('observes the effective DSH body and bounded resource closure without disclosing source', async () => {
  const { root, skill } = await fixture()
  const observation = await inspectRegistryCapability({ registry: registryFor(skill), workspaceRoot: root, skillName: skill.name })
  assert.equal(observation.skill.contentSha256, sha256(skill.content))
  assert.equal(observation.resourceClosure.status, 'complete')
  assert.equal(observation.resourceClosure.fileCount, 2)
  assert.equal(observation.catalog.stable, true)
  assert.equal(observation.catalog.entryConsistent, true)
  const serialized = JSON.stringify(observation)
  assert.equal(serialized.includes(skill.content), false)
  assert.equal(serialized.includes(skill.resourceBase.path), false)
  assert.equal(serialized.includes('"owner":"example"'), false)
})

test('body-only edits change the effective content hash while catalog digest stays fixed', async () => {
  const { root, skill } = await fixture()
  const first = await inspectRegistryCapability({ registry: registryFor(skill), workspaceRoot: root, skillName: skill.name })
  const edited = { ...skill, content: `${skill.content}One more rule.\n` }
  const second = await inspectRegistryCapability({ registry: registryFor(edited), workspaceRoot: root, skillName: skill.name })
  assert.notEqual(first.skill.contentSha256, second.skill.contentSha256)
  assert.equal(first.catalog.sha256, second.catalog.sha256)
})

test('issues a deterministic verified receipt and replays the same content-addressed file', async () => {
  const { root, skill } = await fixture()
  const observation = await inspectRegistryCapability({ registry: registryFor(skill), workspaceRoot: root, skillName: skill.name })
  const options = {
    registry: registryFor(skill),
    workspaceRoot: root,
    skillName: skill.name,
    artifactDir: 'artifacts',
    expected: {
      contentSha256: observation.skill.contentSha256,
      resourceClosureSha256: observation.resourceClosure.sha256,
      provider: 'filesystem',
      source: 'project-dsh',
      modelInvocable: true,
      userInvocable: false
    }
  }
  const first = await issueRegistryCapabilityReceipt(options)
  const second = await issueRegistryCapabilityReceipt(options)
  assert.equal(first.ok, true)
  assert.equal(first.artifact.replayed, false)
  assert.equal(second.artifact.replayed, true)
  assert.equal(first.receiptSha256, second.receiptSha256)
  const verified = await verifyCapabilityReceiptFile(join(root, first.artifact.path), { requireVerified: true })
  assert.equal(verified.ok, true)
})

test('fails receipt verification on pinned expectation mismatch or unstable catalog', async () => {
  const { root, skill } = await fixture()
  const mismatchObservation = await inspectRegistryCapability({ registry: registryFor(skill), workspaceRoot: root, skillName: skill.name })
  const mismatch = buildCapabilityReceipt(mismatchObservation, { contentSha256: '0'.repeat(64), provider: 'other' })
  assert.equal(mismatch.verification.status, 'failed')
  assert.deepEqual(mismatch.verification.findings, ['expected-contentSha256-mismatch', 'expected-provider-mismatch'])

  const unstable = await inspectRegistryCapability({ registry: registryFor(skill, { complete: false, mutateCatalog: true }), workspaceRoot: root, skillName: skill.name })
  const receipt = buildCapabilityReceipt(unstable, { contentSha256: unstable.skill.contentSha256 })
  assert.equal(receipt.verification.status, 'failed')
  assert(receipt.verification.findings.includes('catalog-incomplete'))
  assert(receipt.verification.findings.includes('catalog-changed-during-observation'))
})

test('fails closed for remote resource bases, symlinks, and byte caps', async (t) => {
  const remote = await observeResourceClosure({ resourceBase: { kind: 'url', url: 'https://example.test/skill/' } })
  assert.deepEqual(remote, { status: 'unavailable', kind: 'url', code: 'non-local-resource-base' })

  const { root, skillDir, skill } = await fixture()
  const target = join(root, 'outside.txt')
  const link = join(skillDir, 'linked.txt')
  await writeFile(target, 'outside')
  try {
    await symlink(target, link, 'file')
  } catch (error) {
    if (error.code === 'EPERM') return t.skip('Windows symlink privilege is unavailable')
    throw error
  }
  const linked = await observeResourceClosure(skill)
  assert.equal(linked.status, 'error')
  assert.equal(linked.code, 'resource-symlink')
  await unlink(link)

  const capped = await observeResourceClosure({ ...skill, resourceBase: { kind: 'directory', path: root }, path: undefined }, { maxFiles: 100, maxFileBytes: 2, maxTotalBytes: 100 })
  assert.equal(capped.status, 'error')
  assert.equal(capped.code, 'resource-file-limit')
})

test('detects receipt tampering', async () => {
  const { root, skill } = await fixture()
  const observation = await inspectRegistryCapability({ registry: registryFor(skill), workspaceRoot: root, skillName: skill.name })
  const result = await issueRegistryCapabilityReceipt({
    registry: registryFor(skill), workspaceRoot: root, skillName: skill.name, artifactDir: 'artifacts',
    expected: { contentSha256: observation.skill.contentSha256 }
  })
  const path = join(root, result.artifact.path)
  const receipt = JSON.parse(await readFile(path, 'utf8'))
  receipt.observation.skill.provider = 'tampered'
  await writeFile(path, JSON.stringify(receipt))
  await assert.rejects(() => verifyCapabilityReceiptFile(path), { code: 'receipt-hash-mismatch' })
})
