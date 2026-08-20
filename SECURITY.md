# Security policy

The MCP server is proof-only and in-memory. It has no filesystem or network API, executes no capability, writes no artifact, and accepts only explicit structured lock and digest inputs. It never returns skill bodies, business content, metadata, absolute paths, environment variables, or secrets.

The DSH tools observe the winning skill registry entry but do not execute it. Local resource closure is bounded by file count and byte limits; symbolic links, special files, traversal, unstable reads, and destinations outside the explicit workspace-relative `artifactDir` fail closed. Content-addressed receipts are atomically installed and read back before success is reported.

A verified receipt establishes equality only with caller-supplied hashes or the supplied pack-agent lock at one observation. The lock is evidence input, not a signature or trust anchor, and the receipt does not prove usefulness, safety, authorship, or downstream behavior.

Report vulnerabilities privately through GitHub Security Advisories.
