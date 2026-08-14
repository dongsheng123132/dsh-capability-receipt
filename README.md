# dsh-capability-receipt

`dsh-capability-receipt` proves which skill DeepSeek Harness actually loaded. It hashes the effective instruction body returned by `ctx.skills.get()`, records the winning provider/source/invocation policy, and—when the resource base is local—hashes a bounded resource-directory closure. It can then compare that runtime observation with hashes pinned by a trusted source artifact and write a deterministic content-addressed receipt.

This is deliberately not another skill package format, dependency resolver, installer, registry, or evaluator. Use tools such as pack-agent for packaging and distribution; use this plugin for the missing last hop between a fixed source artifact and the effective capability inside DSH.

## DSH tools

- `dsh_capability_receipt_inspect`: returns structural fields and hashes without returning skill instructions, metadata, or absolute paths.
- `dsh_capability_receipt_issue`: requires `expectedContentSha256`, accepts optional resource/provider/source/invocation expectations, and writes only beneath an explicit workspace-relative `artifactDir`.

The plugin observes but never executes the target capability. A receipt fails closed when the DSH catalog is incomplete or changes during observation, when the loaded definition disagrees with its catalog entry, when an expectation mismatches, or when resources cannot be safely closed.

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
DSH_CHECKOUT=/path/to/deepseek-harness npm run smoke:dsh
```

Requires Node.js 22 or newer. No install lifecycle scripts are used.

## Security boundary

A verified receipt proves equality with caller-supplied expectations at one DSH runtime observation. It does not prove that the source artifact is trustworthy, that the skill is useful or safe, that the capability was executed, or that external model/tool behavior was correct. Pin trusted source commits and preserve their review/evaluation evidence separately.
