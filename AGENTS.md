# Repository guidance

Read `THREAT_MODEL.md` before changing runtime, lifecycle, pairing, or release code.

Security boundaries must fail closed. Never read Codex authentication files, expose App Server directly to the browser, bind outside `127.0.0.1`, log secrets or full prompts, weaken the read-only/no-network policy, or publish without explicit owner approval.

Use Node built-ins where practical, keep browser, App Server, pairing, and lifecycle code separated, and add tests with each behavior. Tests must use the fake App Server and isolated temporary directories; they must not depend on real Codex credentials.
