# Security Hardening Proposal: Preventive Codex File-Read Isolation

## Decision

We need to decide what must sit between browser-controlled study text and the
learner's other files before the connector can be published. The current
adapter can detect a tool event and terminate Codex, but detection happens after
the tool may have started. The release decision therefore needs a preventive
read boundary, removal of the explanation path, or explicit acceptance of the
remaining high-severity risk.

## Executive Recommendation

The complete choice is:

- **Option 1: Keep the publication gate.** Preserve the current runtime and do
  not publish while we wait. This limits exposure but does not fix local risk.
- **Option 2: Require verified restricted roots.** Pin support to a released
  Codex version whose Windows App Server accepts and enforces a restricted
  `readOnly.access` policy. This is my recommended target.
- **Option 3: Add an external OS sandbox broker.** Put Codex in AppContainer or
  an equivalent native Windows isolation boundary that grants only explicitly
  required resources. This is stronger and independent of the turn protocol,
  but it changes packaging and authentication assumptions substantially.
- **Option 4: Disable explanations.** Remove the browser-to-turn path while
  retaining safe account/pairing behavior. This is the only immediate option
  that removes the attack path without waiting or accepting the risk, but it
  removes the connector's main product value.

I recommend Option 2 under the current product constraints, with Option 1 as
the mandatory interim state. We must not implement Option 2 based only on the
documentation: the stable `0.147.0` and alpha `0.148.0-alpha.9` schemas inspected
on 2026-08-12 do not contain the documented field. A release should wait until
the exact Windows binary accepts the policy and a hostile-read test proves the
boundary. If timing rules out waiting, Option 4 should win unless the project is
prepared to fund and support the native isolation work in Option 3.

## Evidence

I inspected the sealed scan, the current source at revision
`04401b29bc4902ad334f16b1e64d0af920aa5976`, current official documentation,
generated released schemas, and Microsoft isolation documentation. The
following evidence map keeps observed facts separate from the design inference.

| Evidence | Finding or document | What it establishes |
| --- | --- | --- |
| `F1` | `csf_14395776f874dfb1031885b2` — Built-in Codex tools are blocked only after activity can begin | **Observed:** a paired prompt reaches a turn without a preventive empty-tool boundary; event handling occurs after activity may start. |
| `S1` | Current adapter in `src/app-server/client.mjs` and policy in `src/constants.mjs` | **Observed:** the connector clears MCP servers, fixes an empty workspace, uses no approvals, read-only/no-network tool policy, rejects host actions, and terminates on non-passive items. |
| `D1` | [Official Codex App Server documentation](https://learn.chatgpt.com/docs/app-server) | **Observed:** the current page describes restricted read roots and `externalSandbox`, but does not document a turn-level control that removes every built-in tool. |
| `X1` | Generated `TurnStartParams` schemas for Codex `0.147.0` and `0.148.0-alpha.9` | **Observed experiment:** both released schemas describe `readOnly` with `type` and `networkAccess` only; neither contains `access`, `readableRoots`, `includePlatformDefaults`, or a built-in-tool denial field. |
| `W1` | [Microsoft application isolation](https://learn.microsoft.com/en-us/windows/security/book/application-security-application-isolation), [Windows Sandbox](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/), and [job objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) | **Observed:** AppContainer is an OS boundary but requires packaging/capability work; Windows Sandbox is VM-isolated but excludes Home and starts clean; job objects provide process limits, not this filesystem access policy. |

From F1, S1, and X1, I infer that policy ownership is currently split at the
wrong time. The connector owns the desired no-file rule, while the only
enforceable control it can apply today still allows broad reads. The adapter
then learns about a violation through a later event. This inference is why more
prompt wording or faster termination cannot close the finding: both remain
downstream of the possible read.

## Current Design And Failure Mode

The relevant actor is not an arbitrary internet site. The prompt must come from
the exact allowed Bookarium origin with a valid pairing token, or from study
content handled by that paired page. That narrows reachability, but it does not
make the prompt trustworthy. A compromised frontend or malicious exercise can
ask the model to inspect a local file.

The adapter starts the official App Server under the learner's Windows account.
It gives the turn an empty working directory, clears MCP configuration, forbids
approvals, disables tool network access, and requests a read-only sandbox. If
Codex emits a tool or other non-passive item, the connector fails the request,
terminates the child, and waits for exit before admitting more work. These are
meaningful controls: they prevent writes, block direct tool egress, avoid
approval forwarding, and keep unsafe output away from the normal response.

What gives me pause is the ordering. A read-only sandbox can still read files
available to the current user. A built-in command or file-inspection tool can
begin before its `item/started` notification is processed. At that point file
content may already have entered the Codex turn and can consequently reach the
OpenAI service or the generated answer, even if the connector kills the process
moments later. The current kill behavior limits duration; it cannot undo the
read.

The [before architecture](../diagrams/preventive-file-read-isolation-before.mmd)
shows that late control edge. The dangerous edge is from the built-in tool to
other user-readable files; the dashed notification edge reaches the connector
only after the potential sink.

## Desired Invariants

- Browser-controlled text cannot cause a process to read outside the empty,
  connector-owned study workspace.
- File denial is enforced before the first read, not inferred from a later
  protocol notification.
- Tool subprocesses have no network, writes, approval path, MCP servers, or
  host-action broker.
- The official Codex process continues to own and use its authentication state;
  the connector never reads, parses, copies, or transmits credentials.
- Unsupported, ignored, or rejected isolation configuration fails closed and
  never silently falls back to broad read access.
- Every supported Codex/Windows combination passes an outside-root read canary
  before it is eligible for public release.
- Reactive event rejection and confirmed process termination remain as defense
  in depth after a preventive boundary is added.

## Constraints And Non-Goals

The intended user installs once, activates from PowerShell when needed, and then
uses the website. We should preserve that flow, avoid administrator rights, and
support ordinary nontechnical Windows users. The loopback/origin/pairing design,
the official Codex authentication owner, and the read-only/no-network policy
are non-negotiable.

We are not trying to protect a machine whose Windows account is already fully
compromised, replace Codex authentication, or prove that the OpenAI service and
official Codex binary are trustworthy. We are specifically preventing a
browser-controlled study turn from gaining a new path to unrelated local files.
No latency or memory measurements were supplied, so resource statements below
are mechanism-based and paired with measurement plans.

## Before Architecture

The current architecture keeps the browser and App Server separated, but the
tool process inherits a read boundary wider than the connector's intended empty
workspace. See the distributable
[before diagram](../diagrams/preventive-file-read-isolation-before.mmd).

| Change | Before | After | Security consequence | Cost |
| --- | --- | --- | --- | --- |
| This row establishes the common baseline | Tool may read as the learner before the connector sees the event | Varies by option below | The read must be denied or the entry point removed before publication | None; descriptive only |

## Options

### Option 1: Keep the publication gate

The strongest case for Option 1 is honesty and reversibility. We keep all
current reactive controls and continue local development/testing, but make no
claim that file reads are preventively isolated. Public npm publication remains
blocked. This costs almost no engineering time and avoids inventing a weak
Windows sandbox under release pressure.

This option does not protect a developer or tester who deliberately runs the
current connector. It only limits the number of exposed users and gives us time
to wait for a supported upstream control. We should therefore describe it as an
interim release decision, not remediation. Rollback is simply continuation of
the current state; moving away from it requires passing another option's
acceptance tests.

The [Option 1 diagram](../diagrams/preventive-file-read-isolation-publication-gate-after.mmd)
makes that distinction explicit: the public distribution edge is cut, while the
local attack path remains.

| Change | Before | After | Security consequence | Cost |
| --- | --- | --- | --- | --- |
| Distribution | Potential public Beta release | Publication remains blocked | Fewer users are exposed | Release delay |
| Runtime boundary | Reactive kill after tool event | Unchanged | F1 remains technically valid | No implementation cost |
| Rollout | Release candidate | Internal/local testing only | No unsupported security claim | Ongoing coordination and status messaging |

### Option 2: Require verified restricted roots

The attractive part of Option 2 is that it puts policy at the existing sandbox
boundary. Once a released Windows App Server supports it, every tutor turn would
send a restricted `readOnly.access` policy whose readable roots are limited to
the empty connector workspace and only any proven platform roots required for
the sandbox itself. Built-in tools could still be selected, but the sensitive
read would fail inside the sandbox before file content reaches the turn.

The connector would persist an exact, shell-free Codex binary path as it does
today, require a reviewed compatible version, and send the restrictive field on
every turn. Parser rejection, unknown version, or missing capability would stop
the request and keep the service unavailable; there would be no compatibility
fallback to ordinary `readOnly`. Reactive non-passive-item rejection, no MCP,
no approvals, no tool network, and confirmed child termination would remain.

We should be precise about the evidence gap. D1 documents this shape, while X1
shows that neither currently released schema carries it. The documentation's
platform-default note is macOS-specific, so we also do not yet know which
Windows runtime roots are included or required. A version check alone is not
enough. Release CI must run the exact packaged Windows binary against canary
files: an allowed harmless file inside the workspace and a unique secret outside
it. The outside file must be unreadable, its marker must never appear in App
Server frames or the browser answer, and the test must prove no writes or tool
network access. A capability or schema probe should also fail the installation
before activation if the contract is absent.

Performance and memory effects should be small because we add policy parsing
and OS access checks, not a new process. Reliability may initially regress if
Codex needs platform files that the Windows restricted policy excludes; that is
the correct fail-closed behavior, but it can make explanations unavailable.
Rollout should therefore start with opt-in release-candidate machines, then a
pinned minimum version, and only then public availability. Rollback must disable
the explanation operation or return to the unpublished gate, never fall back to
broad reads.

The [Option 2 diagram](../diagrams/preventive-file-read-isolation-version-gated-restricted-roots-after.mmd)
shows the important separation: official Codex retains its own authentication
channel, while the tool sandbox receives only the restricted workspace view.

| Change | Before | After | Security consequence | Cost |
| --- | --- | --- | --- | --- |
| Read policy | Full user-readable scope under read-only mode | Explicit restricted roots on every tutor turn | Outside-root reads are denied before content enters the turn | Requires upstream Windows support and exact compatibility gate |
| Unsupported CLI | Current read-only policy still runs | Explanation fails closed | No silent security downgrade | More support cases during Codex version drift |
| Validation | Reactive event tests | Read-denial canaries plus existing tests | Proves effect rather than field presence | Windows CI/smoke maintenance |
| Processes | Connector plus App Server | Unchanged process topology | No new privileged broker | Minimal expected latency/memory change; must measure |

### Option 3: Add an external OS sandbox broker

Option 3 is the independent architectural answer. A small native Windows broker
would launch the official Codex App Server inside AppContainer, a carefully
constructed restricted token, or an equivalently strong OS boundary. The outer
boundary would deny unrelated user files regardless of which App Server fields
exist. We would keep Codex's internal read-only/no-network sandbox as a second
layer unless the proven broker design requires `externalSandbox`.

The strongest case is defense across upstream versions: the connector owns the
boundary and can test it directly. The principal concern is that a correct
Windows isolation profile is not a wrapper flag. AppContainer requires package
identity/capabilities and explicit resource grants. Codex still needs its binary,
runtime files, authentication state, and service network connection, while tool
subprocesses must not gain access to unrelated files or network. A job object is
useful for containing and killing the process tree, but Microsoft documents that
its security limits do not supply the needed per-process filesystem boundary.

Windows Sandbox is strong VM isolation, but it is not a practical implementation
of the current user flow: it is unavailable on Windows Home, host applications
are not installed inside it, state is disposable, and Codex would need a
separate installation/login experience. A second Windows account has similar
credential and launch problems. That leaves a native AppContainer/restricted
token prototype as the plausible direction, with feasibility still unknown.

This option adds at least one native component, packaging/signing work, OS-version
compatibility tests, process IPC, and a larger incident-response surface. It may
add startup latency and memory depending on whether the broker is persistent;
we have not measured either. Reliability failure modes include broken Codex
updates, insufficient runtime grants, and broker/app-server lifecycle splits.
Rollout should begin as a disposable prototype that never touches real Codex
credentials, then use a dedicated test authentication profile. If the prototype
cannot preserve the install-once/activate flow without copying credentials or
requiring elevation, we should reject the option rather than weaken the boundary.

The [Option 3 diagram](../diagrams/preventive-file-read-isolation-os-sandbox-broker-after.mmd)
places the new authority at process creation. That is its security advantage and
also why it carries the largest engineering and support cost.

| Change | Before | After | Security consequence | Cost |
| --- | --- | --- | --- | --- |
| Boundary owner | Upstream turn sandbox | Connector-owned native OS broker plus upstream sandbox | Read denial can remain effective across App Server protocol changes | New trusted native component |
| Packaging | Pure Node/npm package plus official Codex | Native/MSIX or equivalent artifacts | Enables AppContainer-style capabilities | Signing, architecture, update, and Windows-version matrix |
| Authentication | Official Codex runs normally as current user | Isolated Codex must receive only its necessary auth access | Can protect other user data if grants are exact | Feasibility and credential-store compatibility are unresolved |
| Lifecycle | Existing child termination | Broker must own the full isolated process tree | Stronger containment if correct | More IPC, startup, recovery, and observability work |

### Option 4: Disable explanations

Option 4 removes the dangerous capability instead of sandboxing it. The
connector would keep pairing, status, lifecycle, and safe `account/read`
metadata if those remain useful, but `/v1/ask` would not create an App Server
turn. The frontend would clearly state that explanations are unavailable in
this release. Because browser-controlled text never reaches agent execution,
F1's attack path disappears.

This option is immediately implementable, easy to test, and introduces no new
performance or memory burden. Reliability actually improves because the long
turn path disappears. Its cost is product-level: the connector no longer does
the main thing users install it for. That may make a public package confusing or
unnecessary, so a cleaner rollout might be to keep the entire connector private
until explanations can return.

Rollback is safe only when another preventive option has passed. Re-enabling the
endpoint behind the old read-only sandbox would recreate the finding. The
[Option 4 diagram](../diagrams/preventive-file-read-isolation-disable-explanations-after.mmd)
shows the cut at the HTTP operation, before any tutor thread exists.

| Change | Before | After | Security consequence | Cost |
| --- | --- | --- | --- | --- |
| `/v1/ask` | Starts a Codex tutor turn | Returns a fixed unavailable response or is absent | Browser text cannot trigger tool/file activity | Core explanation feature removed |
| App Server use | Account and tutor operations | Safe account metadata only | F1 is addressed by removing its entry point | Connector value and messaging must be reconsidered |
| Re-enable | Possible under current policy | Gated on Option 2 or 3 acceptance | Prevents accidental regression | Requires an explicit later release decision |

## Comparison

The table summarizes mechanism-based effects; none of the resource effects were
benchmark-measured.

| Dimension | Option 1: gate | Option 2: restricted roots | Option 3: OS broker | Option 4: disable explanations |
| --- | --- | --- | --- | --- |
| Security | Limits distribution; local attack path remains | Directly addresses arbitrary file reads if Windows enforcement passes | Potentially strongest independent isolation; correctness/feasibility unproven | Removes the vulnerable operation entirely |
| Performance | Neutral runtime | Likely small policy/access-check overhead | Extra launch/IPC and possibly process overhead | Improves by removing tutor turns |
| Memory | Neutral | Likely neutral | Higher if broker/profile machinery is resident | Lower during use |
| Reliability | Current behavior retained | Fail-closed version drift can make explanations unavailable | More components and update interactions | Simpler runtime, but feature unavailable by design |
| Operability | Ongoing release gate tracking | Version allowlist, capability probes, Windows canary CI | Native build/signing/support/telemetry burden | Simple technically; high product/support communication cost |
| Migration | None while waiting | Incremental adapter/install/test changes after upstream support | Foundational packaging and lifecycle migration | Small code change, large product change |

Option 2 best matches the current constraints because the enforcement point is
already part of the Codex sandbox and no new privileged component is introduced.
Option 3 becomes preferable if upstream support remains unavailable for a
business-critical period and a prototype proves that AppContainer can preserve
Codex authentication and the no-admin flow. Option 4 becomes preferable if a
public release date matters more than explanations. Option 1 is not a competing
technical fix; it is the safe state while those facts settle.

## Recommendation

I recommend we continue with Option 1 today and prepare to implement Option 2
only when all of its entry gates are met. The recommendation is conditional:

- a released, non-alpha Codex Windows binary exposes and accepts restricted
  read access;
- its generated schema or other authoritative contract describes the field;
- outside-root canary tests fail closed across every supported Windows setup;
- the platform-default readable set contains no user-content locations; and
- unsupported versions cannot start the explanation path.

This is deliberately stricter than “the request returned success.” We need
evidence that the OS denies the read. If upstream does not supply that evidence
within the product's acceptable schedule, I would return to this review and
choose between Option 3 and Option 4 rather than normalize the current residual
risk.

## Evidence Coverage And Residual Risk

| Evidence | Option 1 | Option 2 | Option 3 | Option 4 |
| --- | --- | --- | --- | --- |
| `F1` — Built-ins start before reactive denial | Mitigates public exposure; finding remains | Addresses file-read impact if enforced; built-in selection can still occur | Addresses through a process-creation boundary if grants are correct | Addresses by removing the turn entry point |
| `S1` — Current defense-in-depth controls | Preserved | Preserved | Preserved inside the outer boundary | Mostly no longer exercised for tutor turns |
| `D1` — Documented restricted roots | No dependency | Required but insufficient by itself | Optional; `externalSandbox` may be relevant | No dependency |
| `X1` — Released schema mismatch | Explains why we wait | Blocks implementation today | Motivates independence from protocol | No dependency |
| `W1` — Windows isolation constraints | No dependency | Windows enforcement semantics still need proof | Central feasibility evidence and open risk | No dependency |

Even after Option 2, a built-in tool may consume compute or cause an unsafe
event; reactive termination remains necessary. Restricted roots also do not
protect files accidentally placed inside the allowed workspace. Option 3 would
add broker compromise and overbroad capability grants as new risks. Option 4
leaves ordinary account metadata and local lifecycle surfaces, but those are
covered by separate controls and are not the F1 file-read path.

## Migration And Rollout

For Option 2, we would first add contract fixtures and a release-candidate probe
without changing the default production path. Once a stable compatible CLI
exists, the installer/repair flow would reject older versions for explanations,
the adapter would send the restricted policy on every turn, and tests would
exercise allowed and denied canaries with the fake App Server plus an opt-in
real Windows smoke. We would then trial the exact packed artifact on a clean
Windows VM before considering publication.

During that migration, the existing publication gate, fixed instructions,
empty workspace, no MCP, no approvals, no network, passive-item allowlist, and
confirmed termination remain mandatory. Rollback means disabling explanations
and restoring the release gate. It never means omitting `access` and continuing
with broad `readOnly`.

Option 3 needs a separate prototype milestone before an implementation plan.
Option 4 can roll out as a single compatibility-breaking feature flag or route
removal, but the frontend and nontechnical documentation must change in the
same release so users are not asked to install a connector that cannot explain
anything.

## Validation Plan

- Recompute the source revision and review any drift in the App Server,
  lifecycle, prerequisite, and release boundaries before implementation.
- Generate schemas from the exact candidate stable Codex package and require
  the restricted-read shape; confirm that `runtimeWorkspaceRoots` or empty
  `dynamicTools` are not misused as security controls.
- Put a unique harmless marker in the connector workspace and a distinct marker
  in a temporary outside-root directory. Through a hostile tutor prompt, prove
  the inside marker can be read only if the test intentionally permits it and
  the outside marker never appears in protocol frames, model output, logs, or
  browser responses.
- Test common outside locations, including Documents, Desktop, profile config,
  temporary directories outside the connector workspace, and connector state.
  Use synthetic canaries only; never real credentials.
- Prove no file write, network call, approval, MCP action, or host request can
  start, and retain the existing coalesced-event/process-exit regression tests.
- Measure 50 cold and 200 warm explanation starts on the same Windows image.
  Compare median/p95 startup latency and peak connector/App Server working set
  with the current baseline. Treat more than 250 ms added p95 or 25 MiB added
  steady-state memory as a review trigger, not an automatic security rollback.
- Run clean-VM install, PowerShell activation, browser pairing, explanation,
  stop, repair, upgrade/downgrade rejection, reboot behavior, and uninstall.
- Attempt unsupported and malformed policy versions and verify a fixed,
  non-sensitive unavailable response with no tutor turn.

## Implementation Work Packages

No implementation work package is authorized yet. If Option 2 is selected after
upstream support exists, the likely packages are:

- capability/version admission in `src/lifecycle/prerequisites.mjs` and its
  install/repair callers;
- fail-closed restricted policy construction in `src/app-server/client.mjs`;
- fake protocol fixtures and unit/integration coverage;
- opt-in real Windows canary smoke that uses isolated temporary directories and
  synthetic data only;
- release checks and nontechnical support/security documentation.

The implementation plan should be written only after selection and a fresh
drift check.

## Open Questions

- Which stable Codex version first exposes restricted read access in its
  generated Windows App Server schema?
- What exact Windows roots does `includePlatformDefaults` add, if the field is
  supported on Windows, and can any contain user content?
- Does restricted read enforcement cover every built-in execution and
  file-inspection path, including child processes and direct filesystem APIs?
- Can the connector perform a lightweight capability check without creating a
  real tutor turn or touching authentication content?
- If upstream support is delayed, is preserving explanations valuable enough to
  justify a signed native AppContainer broker and a larger Windows support
  matrix?
