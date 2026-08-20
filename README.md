# dsh-capability-receipt

[![CI](https://github.com/dongsheng123132/dsh-capability-receipt/actions/workflows/ci.yml/badge.svg)](https://github.com/dongsheng123132/dsh-capability-receipt/actions/workflows/ci.yml)
[![MIT license](https://img.shields.io/github/license/dongsheng123132/dsh-capability-receipt)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-%E2%89%A522-339933?logo=nodedotjs&logoColor=white)](package.json)
[![Awesome DSH Plugins](https://img.shields.io/badge/Awesome_DSH-verified_lab-0969da)](https://github.com/dongsheng123132/awesome-dsh-plugins#2origin-plugin-lab)

`dsh-capability-receipt` proves which skill DeepSeek Harness actually loaded. It hashes the effective instruction body returned by `ctx.skills.get()`, records the winning provider/source/invocation policy, and—when the resource base is local—hashes a bounded resource-directory closure. It can then compare that runtime observation with hashes pinned by a trusted source artifact and write a deterministic content-addressed receipt.

This is deliberately not another skill package format, dependency resolver, installer, registry, evaluator, per-turn summary, or event audit ledger. Use [pack-agent](https://github.com/sakikoTGW/pack-agent) for packaging and distribution; use this plugin for the missing last hop between a fixed source artifact and the effective capability inside DSH.

Version 0.3.0 is host-neutral: the DSH entry does not import a private ToolRuntime helper and exposes no default export, so the stock Cordis loader preserves the module-level `inject = ['tools', 'skills']` contract in the built `web` profile.

## DSH tools

- `dsh_capability_receipt_inspect`: returns structural fields and hashes without returning skill instructions, metadata, or absolute paths.
- `dsh_capability_receipt_issue`: requires `expectedContentSha256`, accepts optional resource/provider/source/invocation expectations, and writes only beneath an explicit workspace-relative `artifactDir`.
- `dsh_capability_receipt_issue_from_pack`: reads a workspace-relative pack-agent `agent-pack/lock/v1`, recomputes pack-agent's directory and portable-bundle skill hashes, requires the effective DSH body to equal the locked `SKILL.md` body, checks optional provider/source/invocation expectations, and writes the same receipt format.

The plugin observes but never executes the target capability. A receipt fails closed when the DSH catalog is incomplete or changes during observation, when the loaded definition disagrees with its catalog entry, when an expectation mismatches, or when resources cannot be safely closed.

## MCP proof surface

The formal `.mcp.json` declaration exposes two stdio tools:

- `capability_receipt_inspect_lock` parses one explicit inline pack-agent lock and returns only identities and hashes.
- `capability_receipt_verify_recorded` compares an explicit recorded DSH content/resource digest envelope with that lock and returns a content-addressed verdict.

This MCP surface is intentionally proof-only and in-memory. It cannot inspect the live DSH registry, read files, access the network, execute a capability, or write a receipt. Live observation and artifact issuance remain DSH ToolRuntime responsibilities, sharing the same core verifier.

## pack-agent bridge

After pack-agent has exported/installed a pack, issue a receipt against its lock without translating it into another manifest:

```text
pack-agent .agent-pack/lock.json
          │ skill contentHash + fileCount
          ▼
dsh_capability_receipt_issue_from_pack
          │ recompute pack-agent hash + compare loaded SKILL.md body
          ▼
content-addressed DSH runtime receipt
```

Required inputs are `skillName`, `packLockPath`, and `artifactDir`. The lock's `ref` and `lockedAt` are not copied into the receipt. The bridge currently pins the hash contract observed at pack-agent commit `e2db1f8f56b74b64597a01175c810358f2c0b450`; the fixture records the exact upstream Git blobs. Both directory-source and portable-bundle path forms are recognized, and the matched form is explicit in `verification.matchedHashMode`.

## Install in DSH

Pin a reviewed commit in an isolated DSH profile:

```bash
dsh plugin --profile capability-proof add \
  github:owner/dsh-capability-receipt#<commit>
```

The package declares its DSH bundle and ships `cordis.patch.yml`, so a successful plugin install adds the layer to that profile automatically.

## Offline receipt verification

The CLI never discovers or loads skills. It only verifies an already-issued artifact:

```bash
dsh-capability-receipt verify \
  --receipt artifacts/capability-receipt-<sha256>.json \
  --require-verified
```

stdout is one JSON result. Failures go to stderr and exit with code `4`; usage errors exit with code `1`.

## Resource safety

Directory closure defaults to at most 256 regular files, 1 MiB per file, and 8 MiB total. Symbolic links and special files are rejected. URL and opaque resource bases are disclosed as unavailable rather than fetched. Limits may be lowered or raised in trusted DSH plugin configuration.

## Development

```bash
npm install
npm test
npm run check
npm run smoke:plugin
npm run smoke:mcp
DSH_CHECKOUT=/path/to/deepseek-harness npm run smoke:dsh
```

Requires Node.js 22 or newer. No install lifecycle scripts are used.

## Security boundary

A verified receipt proves equality with caller-supplied expectations or one pack-agent lock at one DSH runtime observation. A pack lock is evidence input, not a signature or trust anchor: the bridge verifies its equality to runtime files and the effective body, but does not prove who produced the lock. It also does not prove that the skill is useful or safe, that the capability was executed, or that external model/tool behavior was correct. Pin trusted source commits and preserve their review/evaluation evidence separately.
