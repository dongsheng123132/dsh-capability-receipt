import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  inspectRegistryCapability,
  issueRegistryCapabilityReceipt,
  issueRegistryCapabilityReceiptFromPack
} from './lib/capability-receipt.mjs'

export const name = 'dsh-capability-receipt'
export const inject = ['tools', 'skills']

const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

function base(config, args) {
  return {
    workspaceRoot: config.workspaceRoot ?? process.cwd(),
    cwd: args.cwd,
    skillName: args.skillName,
    limits: {
      maxFiles: config.maxFiles,
      maxFileBytes: config.maxFileBytes,
      maxTotalBytes: config.maxTotalBytes
    }
  }
}

export function createDefinitions(ctx, config = {}) {
  return [
    defineTool({
      name: 'dsh_capability_receipt_inspect',
      description: 'Inspect the winning skill definition actually loaded by DSH. Returns hashes and structural policy only; never returns the skill body, metadata, or absolute paths.',
      parameters: {
        skillName: { type: 'string', required: true, description: 'Exact DSH skill name.' },
        cwd: { type: 'string', description: 'Optional workspace-relative lookup directory.' }
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute(args) {
        return inspectRegistryCapability({ registry: ctx.skills, ...base(config, args) })
      }
    }),
    defineTool({
      name: 'dsh_capability_receipt_issue',
      description: 'Compare the effective DSH skill with a pinned content hash and optional source, provider, invocation, and resource-closure expectations; write one deterministic receipt inside artifactDir. Does not execute the capability.',
      parameters: {
        skillName: { type: 'string', required: true, description: 'Exact DSH skill name.' },
        cwd: { type: 'string', description: 'Optional workspace-relative lookup directory.' },
        artifactDir: { type: 'string', required: true, description: 'Only directory that may be written, relative to workspaceRoot.' },
        expectedContentSha256: { type: 'string', required: true, description: 'Trusted SHA-256 of the effective instruction body.' },
        expectedResourceClosureSha256: { type: 'string', description: 'Trusted SHA-256 of the bounded local resource closure.' },
        expectedProvider: { type: 'string', description: 'Expected winning DSH skill provider.' },
        expectedSource: { type: 'string', description: 'Expected winning DSH skill source.' },
        expectedModelInvocable: { type: 'boolean', description: 'Expected model invocation policy.' },
        expectedUserInvocable: { type: 'boolean', description: 'Expected user invocation policy.' }
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute(args) {
        return issueRegistryCapabilityReceipt({
          registry: ctx.skills,
          ...base(config, args),
          artifactDir: args.artifactDir,
          expected: {
            contentSha256: args.expectedContentSha256,
            resourceClosureSha256: args.expectedResourceClosureSha256,
            provider: args.expectedProvider,
            source: args.expectedSource,
            modelInvocable: args.expectedModelInvocable,
            userInvocable: args.expectedUserInvocable
          }
        })
      }
    }),
    defineTool({
      name: 'dsh_capability_receipt_issue_from_pack',
      description: 'Verify the effective DSH skill against a workspace-local pack-agent agent-pack/lock/v1 entry. Recomputes the exact pack-agent directory and portable-bundle hashes, requires the loaded body to equal the locked SKILL.md body, and writes one deterministic receipt. Does not install or execute the capability.',
      parameters: {
        skillName: { type: 'string', required: true, description: 'Exact DSH skill name and pack-agent lock component key.' },
        cwd: { type: 'string', description: 'Optional workspace-relative DSH lookup directory.' },
        packLockPath: { type: 'string', required: true, description: 'pack-agent agent-pack/lock/v1 JSON file relative to workspaceRoot.' },
        artifactDir: { type: 'string', required: true, description: 'Only directory that may be written, relative to workspaceRoot.' },
        expectedProvider: { type: 'string', description: 'Expected winning DSH skill provider.' },
        expectedSource: { type: 'string', description: 'Expected winning DSH skill source.' },
        expectedModelInvocable: { type: 'boolean', description: 'Expected model invocation policy.' },
        expectedUserInvocable: { type: 'boolean', description: 'Expected user invocation policy.' }
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute(args) {
        return issueRegistryCapabilityReceiptFromPack({
          registry: ctx.skills,
          ...base(config, args),
          packLockPath: args.packLockPath,
          artifactDir: args.artifactDir,
          expected: {
            provider: args.expectedProvider,
            source: args.expectedSource,
            modelInvocable: args.expectedModelInvocable,
            userInvocable: args.expectedUserInvocable
          }
        })
      }
    })
  ]
}

export function apply(ctx, config = {}) {
  for (const definition of createDefinitions(ctx, config)) ctx.tools.register(definition)
}

export default apply
