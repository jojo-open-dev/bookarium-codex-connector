# Bookarium Codex Connector

Bookarium Codex Connector is a local, loopback-only bridge between the Bookarium web app and the user's separately installed, ChatGPT-authenticated official Codex CLI. It is a Bookarium project, not official OpenAI software.

> Beta: the connector is under active development and Codex App Server is an experimental upstream integration. Do not publish this package yet.

## Current state

The extracted connector, Windows lifecycle, and connector-side browser pairing are implemented. Browser protocol version 1 provides:

- `GET /readyz` returns minimal unauthenticated liveness.
- `POST /v1/pair` accepts a short-lived, single-use pairing code only from the exact allowed origin and returns a new browser bearer token.
- `GET /v1/account` requires the exact allowed origin and bearer pairing token, and returns only safe account type/plan metadata.
- `POST /v1/ask` applies the same authorization, accepts a bounded JSON study prompt, and starts a fresh ephemeral Codex tutor interaction.

The service binds only to `127.0.0.1:47321`. Codex App Server is spawned without a shell and communicates over JSONL stdio. Tutor requests are pinned by the connector to `gpt-5.6-luna` with `medium` reasoning; the browser cannot choose or override either setting. MCP servers are cleared, approval policy is `never`, network access is disabled, the sandbox is read-only, and the turn working directory is the connector's empty temporary workspace. Server-initiated host actions and every non-passive turn item fail closed; unsafe, malformed, oversized, or timed-out turns terminate the App Server before the connector accepts more work.

On Windows 10/11, lifecycle and pairing commands operate below the current user's application-data directory without elevation. Installation verifies and records a shell-free native or npm Codex launcher so later starts do not depend on the terminal or browser's inherited `PATH`. It registers the per-user `bookarium-codex://connect` protocol for user-initiated, on-demand startup. The handler contains only the fixed installed `start-managed` command: it accepts no browser-supplied command, path, origin, prompt, or secret. Automatic sign-in startup is optional through `install --startup`. Process control uses an authenticated named pipe, so stop never signals a process based on a reusable PID alone. See [the Windows activation decision](docs/windows-startup.md).

`install` starts the connector and opens the exact configured Bookarium origin with 256 bits of one-time pairing material in the URL fragment. The request expires after five minutes and is consumed atomically. A successful `pair` operation replaces the prior browser token; `revoke` immediately removes browser authorization. The connector persists only SHA-256 token verifiers, not either plaintext pairing value.

On later visits, the user activates the installed connector from PowerShell and then opens Bookarium:

```powershell
Start-Process 'bookarium-codex://connect'
```

Windows launches the fixed registered connector command, and Bookarium reuses the saved browser token. The website's **Connect Codex** button can invoke the same activation as a recovery option, but it is not required for the normal PowerShell-first flow. A normal webpage never executes Node.js or a shell command directly. The connector remains running after activation until it is stopped or the user session ends.

Read-only Linux/Windows CI and a manual local-release-candidate workflow verify source hygiene, immutable action pins, tests, dependency audit, the exact npm file allowlist, and the packed archive. They contain no publication step or write-capable token. See [the release process](docs/release-process.md).

The matching Bookarium frontend fragment handling, activation fallback, and bounded readiness polling exist on its separate approved branch. A clean Windows VM end-to-end test and resolution or explicit owner acceptance of the documented App Server tool-isolation limitation are still required. Until those gates are complete, the package is not ready for learner installation or publication.

## Pairing protocol

The connector opens `${allowedOrigin}/#bookarium-codex-pairing=<code>`. The Bookarium page must read the fragment locally, immediately remove it from browser history, and send `POST http://127.0.0.1:47321/v1/pair` with `Content-Type: application/json`, its normal browser `Origin`, and exactly this body:

```json
{"pairingCode":"<43-character base64url code>"}
```

A successful response is `{"token":"<43-character base64url bearer token>","version":1}`. The page stores that token locally and sends it as `Authorization: Bearer <token>` to `/v1/account` and `/v1/ask`. Missing, malformed, expired, or already consumed pairing codes receive the same generic rejection.

## On-demand activation contract

The Windows installer registers this fixed URI:

```text
bookarium-codex://connect
```

The normal returning-user sequence is:

```powershell
Start-Process 'bookarium-codex://connect'
```

Then open Bookarium in the browser. Installation and browser pairing are not repeated.

As a fallback, the Bookarium frontend may open the URI only from an explicit user action. It must then poll `GET http://127.0.0.1:47321/readyz` for up to 30 seconds and, after protocol version 1 becomes ready, call `/v1/account` with the browser's existing bearer token. Activation carries no parameters and does not authorize the caller. If readiness never appears, the UI should offer install/repair guidance; if `/v1/account` rejects the saved token, the UI should offer the existing pairing flow.

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

`install` registers on-demand activation but does not enable automatic Windows sign-in startup by default. Use `install --startup` only when the user explicitly prefers automatic background startup. The legacy `--no-startup` option remains accepted and is equivalent to the default.

After the one-time installation and pairing, start the connector for a study session and then visit Bookarium:

```powershell
Start-Process 'bookarium-codex://connect'
```

Use `pair` to connect a new browser or rotate browser authorization without reinstalling. Existing access remains valid while the five-minute request is pending and stops after the replacement succeeds. Use `revoke` to invalidate browser access immediately. `status` reports paired/unpaired and pending state without displaying secrets.

The current-user install root is `%LOCALAPPDATA%\Bookarium\Codex Connector`. Uninstall removes only a connector tree with a valid ownership marker, the exact read-back-verified per-user protocol handler, and any startup shortcut whose target/arguments match recorded metadata. It leaves Node.js, Codex, Codex configuration, and Codex authentication untouched.

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

See [SECURITY.md](SECURITY.md) and [THREAT_MODEL.md](THREAT_MODEL.md).
