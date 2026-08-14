import { access, readFile } from 'node:fs/promises'

const required = [
  '.codex-plugin/plugin.json',
  'bin/dsh-capability-receipt.mjs',
  'cordis.patch.yml',
  'index.js',
  'lib/capability-receipt.mjs',
  'LICENSE',
  'README.md',
  'README.zh-CN.md',
  'test/fixtures/pack-agent-upstream.json'
]

await Promise.all(required.map((file) => access(file)))
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const plugin = JSON.parse(await readFile('.codex-plugin/plugin.json', 'utf8'))
if (pkg.name !== plugin.name || pkg.version !== plugin.version) throw new Error('package/plugin identity mismatch')
if (pkg.scripts?.preinstall || pkg.scripts?.install || pkg.scripts?.postinstall) throw new Error('lifecycle scripts are forbidden')
process.stdout.write(`${JSON.stringify({ ok: true, requiredFiles: required.length, lifecycleScripts: false })}\n`)
