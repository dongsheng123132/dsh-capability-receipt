import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as plugin from '../index.js'

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
await mkdir(skillDir, { recursive: true })
await writeFile(skillPath, '# Runtime proof\n\nObserve the actual registry winner.\n')

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
    content: '# Runtime proof\n\nObserve the actual registry winner.\n'
  })
  await ctx.plugin(plugin, { workspaceRoot: root })

  const schemas = tools.schemas()
  assert(schemas.some(({ name }) => name === 'dsh_capability_receipt_inspect'))
  assert(schemas.some(({ name }) => name === 'dsh_capability_receipt_issue'))

  const signal = new AbortController().signal
  const inspection = await tools.execute({
    signal,
    callId: 'capability-inspect-smoke',
    name: 'dsh_capability_receipt_inspect',
    arguments: { skillName: 'runtime-proof' }
  })
  assert.equal(inspection.isError, false)
  assert.equal(inspection.value.kind, 'dsh.capability.observation')

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
  process.stdout.write(`${JSON.stringify({ ok: true, dshTools: schemas.filter(({ name }) => name.startsWith('dsh_capability_receipt_')).map(({ name }) => name), receiptSha256: issued.value.receiptSha256 })}\n`)
} finally {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}
