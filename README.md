# Bookarium Codex Connector

Bookarium Codex Connector is a local, loopback-only bridge between the Bookarium web app and the user's separately installed, ChatGPT-authenticated official Codex CLI. It is a Bookarium project, not official OpenAI software.

> Beta: the connector is under active development and Codex App Server is an experimental upstream integration. Do not publish this package yet.

## Current state

The extracted connector, Windows lifecycle, and connector-side browser pairing are implemented. Browser protocol version 1 provides:

- `GET /readyz` returns minimal unauthenticated liveness.
- `POST /v1/pair` accepts a short-lived, single-use pairing code only from the exact allowed origin and returns a new browser bearer token.
- `GET /v1/account` requires the exact allowed origin and bearer pairing token, and returns only safe account type/plan metadata.
- `POST /v1/ask` applies the same authorization, accepts a bounded JSON study prompt, and starts a fresh ephemeral Codex tutor interaction.

The service binds only to `127.0.0.1:47321`. Codex App Server is spawned without a shell and communicates over JSONL stdio. MCP servers are cleared, approval policy is `never`, the sandbox is read-only, network access is disabled, and server-initiated host actions are rejected.

On Windows 10/11, lifecycle and pairing commands operate below the current user's application-data directory without elevation. Startup uses one verified shortcut in the current user's Startup folder. Process control uses an authenticated named pipe, so stop never signals a process based on a reusable PID alone. See [the startup decision](docs/windows-startup.md).

`install` starts the connector and opens the exact configured Bookarium origin with 256 bits of one-time pairing material in the URL fragment. The request expires after five minutes and is consumed atomically. A successful `pair` operation replaces the prior browser token; `revoke` immediately removes browser authorization. The connector persists only SHA-256 token verifiers, not either plaintext pairing value.

The matching Bookarium frontend fragment handling remains intentionally deferred to a separately approved frontend branch. Until that integration and the remaining release/security work are complete, the package is not ready for learner installation.

## Pairing protocol

The connector opens `${allowedOrigin}/#bookarium-codex-pairing=<code>`. The Bookarium page must read the fragment locally, immediately remove it from browser history, and send `POST http://127.0.0.1:47321/v1/pair` with `Content-Type: application/json`, its normal browser `Origin`, and exactly this body:

```json
{"pairingCode":"<43-character base64url code>"}
```

A successful response is `{"token":"<43-character base64url bearer token>","version":1}`. The page stores that token locally and sends it as `Authorization: Bearer <token>` to `/v1/account` and `/v1/ask`. Missing, malformed, expired, or already consumed pairing codes receive the same generic rejection.

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
bookarium-codex-connector pair
bookarium-codex-connector revoke
bookarium-codex-connector stop
bookarium-codex-connector start
bookarium-codex-connector repair
bookarium-codex-connector uninstall
```

Use `pair` to connect a new browser or rotate browser authorization without reinstalling. Existing access remains valid while the five-minute request is pending and stops after the replacement succeeds. Use `revoke` to invalidate browser access immediately. `status` reports paired/unpaired and pending state without displaying secrets.

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
