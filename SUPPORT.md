# Support

Bookarium Codex Connector `0.1.0` is an unreleased Beta. It supports Windows 10/11 with Node.js 20.18.1 or newer and a separately installed official Codex CLI signed in through ChatGPT.

## Self-service checks

Run these commands without administrator privileges:

```powershell
bookarium-codex-connector status
bookarium-codex-connector repair
bookarium-codex-connector pair
bookarium-codex-connector revoke
bookarium-codex-connector stop
bookarium-codex-connector uninstall
```

`status` reports package/protocol versions, process health, loopback address, allowed origin, safe Codex account metadata, pairing state, and startup state. It never prints pairing or control secrets.

`repair` verifies the installed package and recreates lifecycle configuration without rotating browser authorization. `uninstall` removes only Bookarium-owned connector files and startup registration; it leaves Node.js, Codex, Codex configuration, and Codex authentication untouched.

## Getting help

Before requesting support, note the connector version, Windows version, command attempted, and the concise error message. Do not send Codex/ChatGPT credentials, API keys, authorization headers, pairing fragments or tokens, full learner prompts, `%LOCALAPPDATA%` state files, or Codex authentication files.

Report suspected vulnerabilities privately using the process in [SECURITY.md](SECURITY.md), not through a public support issue.
