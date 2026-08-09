# Bookarium Codex Connector

Bookarium Codex Connector is a local, loopback-only bridge between the Bookarium web app and the user's separately installed, ChatGPT-authenticated official Codex CLI. It is a Bookarium project, not official OpenAI software.

> Beta: the connector is under active development and Codex App Server is an experimental upstream integration. Do not publish this package yet.

## Current milestone

Milestone 1 runs from a checked-out repository and preserves browser protocol version 1:

- `GET /readyz` returns minimal unauthenticated liveness.
- `GET /v1/account` requires the exact allowed origin and bearer pairing token, and returns only safe account type/plan metadata.
- `POST /v1/ask` applies the same authorization, accepts a bounded JSON study prompt, and starts a fresh ephemeral Codex tutor interaction.

The service binds only to `127.0.0.1:47321`. Codex App Server is spawned without a shell and communicates over JSONL stdio. MCP servers are cleared, approval policy is `never`, the sandbox is read-only, network access is disabled, and server-initiated host actions are rejected.

The professional installer, Windows startup registration, browser-fragment pairing, rotation/revocation, and complete uninstall flow belong to later milestones. The `install`, `start`, `status`, `stop`, `repair`, and `uninstall` command names are reserved but intentionally fail without changing the system until those lifecycle boundaries are implemented and tested.

## Development

Requirements: Node.js 20.18.1 or newer. A real local run additionally needs the official `codex` executable and an existing ChatGPT sign-in managed by Codex.

```powershell
npm install
npm test
npm run pack:check
```

The test suite uses a fake App Server and never reads real Codex credentials. The internal checked-out-repository runner accepts the allowed origin and a 32-byte base64url pairing token through process environment only:

```powershell
$env:BOOKARIUM_CODEX_ALLOWED_ORIGIN = 'http://localhost:5173'
$env:BOOKARIUM_CODEX_PAIRING_TOKEN = '<43-character base64url token>'
npm start
```

This runner is for development, not learner onboarding. Do not paste a real long-lived token into a shared terminal transcript. Stop it with Ctrl+C.

## Privacy

The connector runs locally and asks the locally authenticated Codex CLI to send the bounded learning question to OpenAI. Requests may count against the user's ChatGPT/Codex allowance. Bookarium does not need or receive the user's Codex credential or API key, and the connector does not read Codex credential files.

A study request contains the prompt prepared by Bookarium, which can include the current book/chapter, exercise title and type, and a bounded representation of the current exercise item. Full prompts, authorization headers, pairing tokens, and Codex credentials are excluded from normal logs.

See [SECURITY.md](SECURITY.md), [PROJECT_HANDOFF.md](PROJECT_HANDOFF.md), and [THREAT_MODEL.md](THREAT_MODEL.md).
