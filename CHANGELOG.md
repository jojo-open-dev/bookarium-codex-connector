# Changelog

All notable changes to this project will be documented here.

## 0.1.0 - Unreleased Beta

### Added

- Extracted loopback connector with browser protocol version 1.
- Defensive Codex App Server JSONL adapter and fake-server test harness.
- Exact-origin, bearer-token, request-limit, and response-limit enforcement.
- Windows per-user install, managed start/status/stop/repair/uninstall lifecycle.
- Authenticated named-pipe process control and PID-reuse-safe shutdown.
- Verified current-user Startup-folder shortcut registration.
- Read-back-verified `bookarium-codex://connect` activation for a one-click, terminal-free start from Bookarium.
- Five-minute, single-use browser-fragment pairing restricted to the exact configured origin.
- Browser-token rotation and revocation through authenticated lifecycle control.
- Verifier-only pairing persistence with migration from the earlier plaintext-token state.
- Read-only Linux/Windows CI, immutable GitHub Action pins, dependency/secret checks, and an exact npm package allowlist.
- A manual, non-publishing release-candidate workflow with independent tar inspection, checksums, and source-commit manifest.
- Windows packed-tarball install/status/pair/revoke/uninstall smoke coverage in an isolated temporary profile.
- Support and local release-process documentation.

### Changed

- Make on-demand Windows activation the default and automatic sign-in startup an explicit `install --startup` option.
- Persist a verified shell-free Codex launch command during install and repair so later CLI and URI starts do not depend on the caller's `PATH`.
- Open the one-time pairing page through Windows' URL handler instead of `explorer.exe`, which could leave pairing pending without navigating the default browser.
- Document the normal returning-user flow as PowerShell activation followed by opening Bookarium.

### Security

- Bound active HTTP work, open connections, pending App Server requests, turn events, turn items, and aggregate streamed output.
- Fix the tutor-turn working directory to the connector's empty workspace and reject every non-passive App Server item type.
- Terminate and confirm App Server exit after unsafe activity, malformed protocol output, aggregate-limit violations, or turn timeout.
- Keep public publication blocked until compatible preventive tool/read isolation exists upstream or the owner explicitly accepts the residual risk.
