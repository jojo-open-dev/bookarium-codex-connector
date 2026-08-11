# Bookarium Codex Connector threat model

## Overview

The Bookarium Codex Connector is a per-user local service that allows the Bookarium web application to ask the learner's separately installed, ChatGPT-authenticated Codex CLI for a bounded educational explanation. The connector is not a general-purpose AI gateway: its intended public browser protocol is limited to loopback liveness, safe account metadata, and one study-question operation.

The assets that matter most are:

- the learner's Codex authentication state, which must remain owned and managed exclusively by the official Codex CLI;
- the browser pairing token and allowed Bookarium origin, which authorize use of the local connector;
- learner exercise context and generated explanations;
- the integrity of the connector package, installed files, lifecycle metadata, and startup registration;
- the integrity and availability of the local Codex subprocess and the loopback HTTP service; and
- the learner's files, processes, network access, and operating-system account, which the study flow must not expose to exercise content.

The primary runtime surfaces are the CLI, the HTTP bridge bound to `127.0.0.1:47321`, the newline-delimited App Server protocol over child-process stdio, and, in later milestones, per-user installation and startup lifecycle code. The npm package, GitHub Actions, and release workflow are privileged supply-chain surfaces even though they are not part of a normal browser request.

## Threat Model, Trust Boundaries, and Assumptions

### Trust boundaries

1. **Remote network to loopback service.** Network peers must not be able to reach the connector. The service must bind explicitly to `127.0.0.1`, never a wildcard or externally routed interface.
2. **Web page to local HTTP bridge.** Any page can attempt requests to localhost. Only the exactly configured Bookarium origin may receive CORS authorization. Account and study operations must also present the bearer pairing token; the initial pairing exchange instead requires a separate short-lived, single-use value.
3. **Bookarium content to Codex turn.** Exercise text, learner input, and generated prompt context are untrusted data. They must not change the connector's fixed tutor instructions, enable tools, approvals, file writes, or network access.
4. **Connector to official Codex CLI.** The connector may spawn `codex app-server` using an argument array and communicate over stdio. It must not read, parse, copy, log, or transmit Codex credential files or credential-store contents.
5. **Codex App Server to connector.** JSONL messages, notifications, errors, and server-initiated requests are untrusted protocol input. Framing, identifiers, sizes, lifecycle events, and unexpected host-action requests must be handled defensively.
6. **CLI arguments and environment to local files/processes.** Paths, origins, ports, configuration, PIDs, and lifecycle state may be malformed or manipulated by the current user or another same-user process. Later install/uninstall work must validate resolved ownership boundaries before replacement or deletion.
7. **npm/GitHub supply chain to learner machine.** Maintainers, dependencies, workflows, packed artifacts, registry identity, and release credentials can affect code executed by `npx`. Publication requires review, pinned automation, provenance, and explicit owner approval.

### Attacker-controlled inputs

- requests from unrelated or compromised websites, including hostile `Origin`, `Authorization`, methods, headers, bodies, and connection behavior;
- exercise data or learner-authored prompts containing instruction-injection content;
- malformed, oversized, delayed, reordered, or unsolicited App Server messages;
- CLI arguments and supported environment overrides supplied by an untrusted invocation;
- stale or adversarial lifecycle files, PID reuse, filesystem links/junctions, and partially completed installations; and
- malicious dependency or workflow changes proposed through the development and release supply chain.

### Operator- and developer-controlled inputs

The learner controls installation, Codex login, pairing, status, stopping, repair, update, and removal. Maintainers control package source, versions, dependency selection, CI, release approvals, the default Bookarium origin, protocol changes, and fixed tutor instructions. These inputs are trusted only to the extent required by their roles; normal learner actions must not require administrator rights, and a single maintainer workstation must not be the normal publication trust root.

### Required invariants and assumptions

- The official Codex CLI is installed separately and is responsible for its own authentication cache and upstream communication.
- The connector runs as the current operating-system user and never requests elevation.
- The public listener is loopback-only. Port discovery alone grants no authority.
- `/readyz` reveals only minimal protocol liveness. All browser endpoints require the exact configured origin except liveness; account and study endpoints additionally require a high-entropy bearer token, while pairing requires the short-lived one-time value.
- Pairing material is never placed in the npm command, logs, error messages, test snapshots, or Codex prompts. The later one-time pairing value is short-lived, single-use, and carried in a URL fragment.
- The browser receives no Codex access token, refresh token, API key, or credential-store content.
- App Server runs over stdio, behind an adapter, with an empty MCP configuration. Tutor turns use no approvals, a read-only sandbox, and disabled network access.
- Prompt, request body, response, frame, aggregate turn output, item/event count, pending App Server request, connection, time, and active HTTP-work limits fail closed.
- Unsafe or unknown turn items, malformed protocol output, aggregate-limit violations, and turn timeouts require confirmed App Server termination before the connector accepts more work.
- Server-initiated host actions are rejected rather than exposed to the browser.
- Stop and uninstall act only on the process and paths proven to belong to this connector installation.
- Version 0.1.0 remains Beta because the upstream App Server interface can change.

A malicious process already running as the same operating-system user may be able to inspect that user's browser storage, process memory, or connector files. Preventing a fully compromised local user account is out of scope, but the connector must not make such compromise easier or turn a browser-only attacker into local code execution. Compromise of the official Codex binary, Node.js runtime, operating system, browser, or OpenAI service is also out of scope; safe failure and credential non-disclosure remain in scope.

## Attack Surface, Mitigations, and Attacker Stories

### Browser and localhost HTTP service

A malicious webpage can probe common localhost ports, submit simple requests, attempt permissive CORS preflights, spoof malformed origins, reuse a leaked token, slow-stream a request body, or exploit inconsistent routing. Relevant controls are explicit loopback binding, exact normalized origin comparison, token comparison, restrictive preflight headers, `Cache-Control: no-store`, strict methods/content types/body sizes, endpoint-specific body rejection, bounded concurrency/timeouts, and generic errors that omit secrets.

DNS rebinding, `null`/opaque origins, wildcard origins, origin suffix matching, and treating liveness as authorization are realistic browser-to-localhost failure classes. A remote peer reaching an accidentally wildcard-bound listener or an unrelated origin receiving authenticated CORS access would violate a primary security boundary.

### Pairing and browser-held authorization

An attacker may try to obtain pairing material from shell history, query-string telemetry, referrers, browser history, logs, or replay of the initial pairing request. The connector-side professional-pairing design uses 256 random bits, places only a five-minute one-time value in a URL fragment, locks the resulting connection to the exact Bookarium origin, persists only token verifiers, consumes successful exchanges atomically, and supports rotation and revocation. The frontend must remove the fragment from browser history immediately after reading it. Pairing/token concerns remain behind an interface so the development-only static-token runner does not affect the managed lifecycle.

### Exercise prompt and Codex execution

Exercise content can contain instructions such as requests to run a command, inspect files, browse, reveal secrets, or ignore tutor rules. The connector must treat all exercise content as data, add fixed tutor instructions, start a fresh ephemeral interaction according to product behavior, configure no MCP servers, reject host-action requests, set approval policy to never, and enforce read-only/no-network execution. Prompt instructions are defense in depth; sandbox, tool, approval, and transport configuration are the security boundary.

Relevant failure classes include prompt injection crossing into tool execution, accidentally inheriting user MCP configuration, broad filesystem reads, writable sandboxes, network-enabled turns, approval forwarding, unbounded output, and cross-request response confusion. The App Server adapter must fix the working directory to its empty workspace, correlate response and turn identifiers, reject malformed frames safely, bound aggregate data and event counts, terminate on non-passive items or unsafe failures, and fail pending work when the child exits.

The current official App Server contract documents sandbox and approval controls but no per-turn switch that removes all built-in tools. Its newer restricted-read field is also rejected by the currently tested installed Codex CLI. Process termination after an unsafe event is reactive, so a tool may begin and the read-only sandbox may permit reads outside the working directory before its event is observed. Public Beta publication remains blocked until compatible preventive upstream controls exist or the owner explicitly accepts this residual risk.

### Codex authentication and privacy

The connector needs only the safe account type and plan metadata returned by `account/read`. Reading `~/.codex/auth.json`, querying an OS credential store, forwarding tokens to Bookarium, or logging App Server authentication data is prohibited. Full learner prompts are also excluded from default logs. A ChatGPT-authenticated account is required for the subscription-based Bookarium flow; API-key authentication must not be silently accepted as equivalent.

### CLI, process, installation, and filesystem lifecycle

Malformed origins, ports, paths, PID files, and stale installation state are realistic local inputs. Later lifecycle milestones must use platform APIs or spawned argument arrays, canonicalize and validate every owned path, avoid shell interpolation, write restrictive per-user files, identify the process beyond a reusable PID, recover from partial installation, and make uninstall narrow and idempotent. Symlinks, junctions, traversal, environment-variable redirection, unsafe archive extraction, and broad recursive deletion are high-risk classes for the installer even though those surfaces are not implemented in Milestone 1.

### Package and release supply chain

`npx` executes published package contents on the learner's machine, making dependency confusion, registry takeover, malicious lifecycle scripts, unpinned actions, leaked npm credentials, and unexpected packed files material threats. Controls include a small dependency surface, lockfile review, automated tests, `npm pack --dry-run`, secret/dependency scanning, reviewed tags, protected GitHub environments, npm trusted publishing with provenance, exact user-facing versions, and explicit owner approval. This repository must not publish during implementation work.

### Availability and abuse

A paired browser could send concurrent or slow requests, repeatedly restart Codex, or cause large buffered output across many frames or item identifiers. The bridge enforces fixed connection and active-request limits before authentication work, one active tutor turn, a separate pending App Server request limit, hard request/turn/startup timeouts, aggregate response/item/event caps, and confirmed child termination for unsafe turns. Local denial of service is less severe than boundary bypass but still matters because it can strand the connector, consume the learner's allowance, or require manual repair.

## Severity Calibration (Critical, High, Medium, Low)

### Critical

- A browser-controlled exercise or HTTP request can cause arbitrary command execution, file writes outside connector-owned paths, or credential extraction on a default installation without further local consent.
- The published package or release workflow can be taken over in a way that executes attacker code for all installing learners, such as unauthenticated publication or a directly exploitable trusted-publishing misconfiguration.
- The connector transmits reusable Codex/ChatGPT credentials to Bookarium, another website, logs, or an attacker-controlled endpoint.

### High

- Binding beyond loopback, origin-policy bypass, or bearer-token bypass lets an unrelated website or remote peer invoke authenticated explanations and consume the learner's Codex allowance.
- Prompt content can enable network access, arbitrary tools, approval forwarding, or writes despite the intended sandbox.
- Install, update, stop, repair, or uninstall can overwrite/delete arbitrary same-user files or terminate an unrelated process through traversal, junction/symlink abuse, unsafe environment expansion, or PID reuse.
- A reusable pairing secret is predictably generated or broadly disclosed through the normal install flow.

### Medium

- Malformed App Server messages can crash or wedge the connector consistently, mix one request's answer into another, or bypass documented prompt/response/concurrency bounds without reaching code execution or secrets.
- CORS, caching, or error behavior leaks safe-but-private account metadata or learner questions to an otherwise unauthorized local website under limited preconditions.
- Crash recovery, stale state, or update rollback failures require manual repair or leave an obsolete connector running, while owned-file boundaries remain intact.
- Unbounded requests can consume a meaningful portion of the learner's Codex allowance after the attacker has obtained valid browser authorization.

### Low

- Minimal liveness or version details are exposed from the fixed loopback port beyond the documented `/readyz` response, without enabling authenticated use.
- Error handling, help text, or status output is confusing or overly detailed but does not expose secrets, paths with sensitive content, or authority.
- A local same-user attacker who already controls the learner's browser storage or connector data can disrupt the service, with no new privilege, durable credential, or cross-boundary capability gained.
- Developer-only test or documentation issues have no path into the packed artifact, CI credentials, or runtime behavior.

Repository: codex-security-target/v1:sha256:746ae8bbfd40b23cacf11ea84986ecbfb624edbfa50f0fa5e09d19a2803229c9
Version: 1a2ef2370ff1558c005bfc74f70d9b3b8081b2ea
