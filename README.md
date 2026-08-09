# Bookarium Codex Connector

Bookarium Codex Connector is a local, loopback-only bridge between the Bookarium web app and the user's separately installed, ChatGPT-authenticated official Codex CLI. It is a Bookarium project, not official OpenAI software.

> Beta: the connector is under active development and Codex App Server is an experimental upstream integration. Do not publish this package yet.

## Current state

The extracted connector and Windows lifecycle are implemented. Browser protocol version 1 remains:

- `GET /readyz` returns minimal unauthenticated liveness.
- `GET /v1/account` requires the exact allowed origin and bearer pairing token, and returns only safe account type/plan metadata.
- `POST /v1/ask` applies the same authorization, accepts a bounded JSON study prompt, and starts a fresh ephemeral Codex tutor interaction.

The service binds only to `127.0.0.1:47321`. Codex App Server is spawned without a shell and communicates over JSONL stdio. MCP servers are cleared, approval policy is `never`, the sandbox is read-only, network access is disabled, and server-initiated host actions are rejected.

On Windows 10/11, `install`, `start`, `status`, `stop`, `repair`, and `uninstall` operate below the current user's application-data directory without elevation. Startup uses one verified shortcut in the current user's Startup folder. Process control uses an authenticated named pipe, so stop never signals a process based on a reusable PID alone. See [the startup decision](docs/windows-startup.md).

Professional browser-fragment pairing and rotation/revocation are the next milestone. Until that flow and its Bookarium frontend change are complete, the package is not ready for learner installation even though its Windows lifecycle is functional.

## Development

Requirements: Node.js 20.18.1 or newer. A real local run additionally needs the official `codex` executable and an existing ChatGPT sign-in managed by Codex.

```powershell
npm install
npm test
npm run pack:check
```

The Windows commands are:

```powershell
bookarium-codex-connector install
bookarium-codex-connector status
bookarium-codex-connector stop
bookarium-codex-connector start
bookarium-codex-connector repair
bookarium-codex-connector uninstall
```

The current-user install root is `%LOCALAPPDATA%\Bookarium\Codex Connector`. Uninstall removes only a connector tree with a valid ownership marker and a startup shortcut whose target/arguments match recorded metadata. It leaves Node.js, Codex, Codex configuration, and Codex authentication untouched.

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
