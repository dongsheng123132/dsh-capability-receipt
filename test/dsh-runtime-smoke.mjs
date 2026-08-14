import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const pluginEntry = process.env.PLUGIN_ENTRY
const plugin = pluginEntry
  ? await import(pathToFileURL(resolve(pluginEntry)).href)
  : await import('../index.js')

const checkout = process.env.DSH_CHECKOUT
if (!checkout) throw new Error('DSH_CHECKOUT must point to a built DeepSeek Harness checkout.')

const importBuilt = async (relativePath) => import(pathToFileURL(resolve(checkout, relativePath)).href)
const { Context } = await importBuilt('vendor/cordis/lib/index.js')
const { default: SystemPrompt } = await importBuilt('packages/core/system-prompt/lib/index.js')
const { default: ToolRuntime } = await importBuilt('packages/core/tools/lib/index.js')
const { default: SkillRegistry } = await importBuilt('packages/skill/skill/lib/index.js')

const root = await mkdtemp(join(tmpdir(), 'dsh-capability-runtime-'))
const skillDir = join(root, '.dsh', 'skills', 'runtime-proof')
const skillPath = join(skillDir, 'SKILL.md')
const skillContent = '# Runtime proof\n\nObserve the actual registry winner.'
await mkdir(join(skillDir, 'references'), { recursive: true })
await writeFile(skillPath, `---\nname: runtime-proof\ndescription: Real DSH registry smoke fixture.\nversion: 1.0.0\n---\n\n${skillContent}\n`)
await writeFile(join(skillDir, 'references', 'policy.md'), 'runtime-policy-v1\n')

const ctx = new Context()
try {
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)
  const skills = ctx.get('skills')
  const tools = ctx.get('tools')
  assert(skills)
  assert(tools)
  skills.register({
    name: 'runtime-proof',
    description: 'Real DSH registry smoke fixture.',
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'runtime-smoke',
    provider: 'runtime-smoke',
    resourceBase: { kind: 'directory', path: skillDir },
    path: skillPath,
    content: skillContent
  })
  await ctx.plugin(plugin, { workspaceRoot: root })

  const schemas = tools.schemas()
  assert(schemas.some(({ name }) => name === 'dsh_capability_receipt_inspect'))
  assert(schemas.some(({ name }) => name === 'dsh_capability_receipt_issue'))
  assert(schemas.some(({ name }) => name === 'dsh_capability_receipt_issue_from_pack'))

  const signal = new AbortController().signal
  const inspection = await tools.execute({
    signal,
    callId: 'capability-inspect-smoke',
    name: 'dsh_capability_receipt_inspect',
    arguments: { skillName: 'runtime-proof' }
  })
  assert.equal(inspection.isError, false)
  assert.equal(inspection.value.kind, 'dsh.capability.observation')

  await mkdir(join(root, '.agent-pack'), { recursive: true })
  await writeFile(join(root, '.agent-pack', 'lock.json'), `${JSON.stringify({
    schema: 'agent-pack/lock/v1',
    packName: 'runtime-smoke-pack',
    packVersion: '1.0.0',
    lockedAt: '2026-08-14T00:00:00.000Z',
    components: {
      skills: {
        'runtime-proof': {
          version: '1.0.0',
          contentHash: inspection.value.resourceClosure.packAgent.directoryContentHash,
          fileCount: inspection.value.resourceClosure.fileCount
        }
      },
      rules: {}, mcp: {}, experiences: {}, hooks: {}, subagents: {}, memory: {}
    }
  }, null, 2)}\n`)

  const issued = await tools.execute({
    signal,
    callId: 'capability-issue-smoke',
    name: 'dsh_capability_receipt_issue',
    arguments: {
      skillName: 'runtime-proof',
      artifactDir: 'artifacts',
      expectedContentSha256: inspection.value.skill.contentSha256,
      expectedResourceClosureSha256: inspection.value.resourceClosure.sha256,
      expectedProvider: 'runtime-smoke',
      expectedSource: 'runtime-smoke',
      expectedModelInvocable: true,
      expectedUserInvocable: true
    }
  })
  assert.equal(issued.isError, false)
  assert.equal(issued.value.ok, true)

  const issuedFromPack = await tools.execute({
    signal,
    callId: 'capability-pack-issue-smoke',
    name: 'dsh_capability_receipt_issue_from_pack',
    arguments: {
      skillName: 'runtime-proof',
      packLockPath: '.agent-pack/lock.json',
      artifactDir: 'pack-artifacts',
      expectedProvider: 'runtime-smoke',
      expectedSource: 'runtime-smoke',
      expectedModelInvocable: true,
      expectedUserInvocable: true
    }
  })
  assert.equal(issuedFromPack.isError, false)
  assert.equal(issuedFromPack.value.ok, true)
  assert.equal(issuedFromPack.value.pack.matchedHashMode, 'directory')
  process.stdout.write(`${JSON.stringify({
    ok: true,
    dshTools: schemas.filter(({ name }) => name.startsWith('dsh_capability_receipt_')).map(({ name }) => name),
    receiptSha256: issued.value.receiptSha256,
    packReceiptSha256: issuedFromPack.value.receiptSha256
  })}\n`)
} finally {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}
