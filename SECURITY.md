# Security policy

## Supported versions

No production version is currently supported. Version 0.1.0 is an unreleased Beta while the connector and its experimental Codex App Server dependency are reviewed.

## Reporting a vulnerability

Use GitHub private vulnerability reporting for `jojobeee/bookarium-codex-connector` when it is enabled. Until then, contact the repository owner privately instead of opening a public issue. Do not include Codex/ChatGPT credentials, API keys, pairing tokens, authorization headers, full learner prompts, or other secrets in a report.

Include the affected connector version, operating system, reproduction steps with synthetic data, impact, and any suggested mitigation.

## Milestone 1 security posture

The connector binds to IPv4 loopback, requires an exact normalized browser origin plus a 256-bit bearer token for all non-liveness operations, caps requests and responses, uses App Server only over stdio, clears MCP configuration, starts ephemeral threads, rejects App Server host-action requests, and configures `approvalPolicy: never` with a read-only/no-network turn sandbox.

The Windows lifecycle installs only a manifest-hashed file whitelist under the current user's Local AppData, rejects traversal and filesystem links at owned boundaries, writes state atomically, and refuses to claim or delete a nonempty directory without a valid ownership marker. Startup is a read-back-verified current-user shortcut. Stop uses an installation-specific named pipe and 256-bit control secret; the PID is corroborating metadata and is never used alone to terminate a process.

Current Codex App Server documentation does not expose a stable per-thread switch that removes every built-in agent tool. The adapter treats any tool-execution event as a protocol violation and interrupts the turn, while fixed tutor instructions forbid tools. This is defense in depth, not proof that a tool process could never begin before its event is observed. The project must resolve or formally accept this upstream limitation during security review before public Beta publication.
