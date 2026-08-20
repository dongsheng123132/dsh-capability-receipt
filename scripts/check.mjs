import { access, readFile } from 'node:fs/promises'

const required = [
  '.codex-plugin/plugin.json',
  '.mcp.json',
  'bin/dsh-capability-receipt.mjs',
  'cordis.patch.yml',
  'index.js',
  'lib/capability-receipt.mjs',
  'LICENSE',
  'mcp-server.mjs',
  'README.md',
  'README.zh-CN.md',
  'SECURITY.md',
  'test/mcp-smoke.mjs',
  'test/stock-web-loader-smoke.mjs',
  'test/fixtures/pack-agent-upstream.json'
]

await Promise.all(required.map((file) => access(file)))
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const plugin = JSON.parse(await readFile('.codex-plugin/plugin.json', 'utf8'))
if (pkg.name !== plugin.name || pkg.version !== plugin.version) throw new Error('package/plugin identity mismatch')
if (pkg.scripts?.preinstall || pkg.scripts?.install || pkg.scripts?.postinstall) throw new Error('lifecycle scripts are forbidden')
if (pkg.peerDependencies?.['@deepseek-ai/dsh-tools'] || pkg.devDependencies?.['@deepseek-ai/dsh-tools']) throw new Error('host-private dsh-tools dependency is forbidden')
const entry = await readFile('index.js', 'utf8')
if (/from ['"]@deepseek-ai\/dsh-tools/.test(entry) || /export default/.test(entry)) throw new Error('entry must be host-neutral and namespace-loadable')
if (plugin.mcpServers !== './.mcp.json') throw new Error('formal MCP declaration is required')
process.stdout.write(`${JSON.stringify({ ok: true, requiredFiles: required.length, lifecycleScripts: false, hostNeutral: true, mcpDeclared: true })}\n`)
