# Security policy

## Supported versions

No production version is currently supported. Version 0.1.0 is an unreleased Beta while the connector and its experimental Codex App Server dependency are reviewed.

## Reporting a vulnerability

Use GitHub private vulnerability reporting for `jojobeee/bookarium-codex-connector` when it is enabled. Until then, contact the repository owner privately instead of opening a public issue. Do not include Codex/ChatGPT credentials, API keys, pairing tokens, authorization headers, full learner prompts, or other secrets in a report.

Include the affected connector version, operating system, reproduction steps with synthetic data, impact, and any suggested mitigation.

## Current security posture

The connector binds to IPv4 loopback and requires an exact normalized browser origin plus a 256-bit bearer token for account and study operations. The unauthenticated pairing endpoint still requires that exact origin and a separate 256-bit, five-minute, single-use value. Requests and responses are capped. App Server is used only over stdio, MCP configuration is cleared, tutor threads are ephemeral, host-action requests are rejected, and turns use `approvalPolicy: never` with a read-only/no-network sandbox.

The installer carries one-time pairing material only in the Bookarium URL fragment and never prints it. Pairing state stores SHA-256 verifiers rather than plaintext one-time or browser tokens. While the service runs, issuance and revocation require the authenticated named pipe; the HTTP exchange requires the exact origin and one-time value. Mutations are serialized by the running service: pending rotation preserves existing access, successful exchange replaces it, replay fails, and revocation clears active and pending authorization.

The Windows lifecycle installs only a manifest-hashed file whitelist under the current user's Local AppData, rejects traversal and filesystem links at owned boundaries, writes state atomically, and refuses to claim or delete a nonempty directory without a valid ownership marker. Startup is a read-back-verified current-user shortcut. Stop uses an installation-specific named pipe and 256-bit control secret; the PID is corroborating metadata and is never used alone to terminate a process.

Current Codex App Server documentation does not expose a stable per-thread switch that removes every built-in agent tool. The adapter treats any tool-execution event as a protocol violation and interrupts the turn, while fixed tutor instructions forbid tools. This is defense in depth, not proof that a tool process could never begin before its event is observed. The project must resolve or formally accept this upstream limitation during security review before public Beta publication.
