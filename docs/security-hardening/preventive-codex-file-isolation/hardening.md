# Security Hardening Review: Preventive Codex File Isolation

## Evidence Basis

This review is anchored to completed scan
`7b58f511-4efb-46ad-9b7c-f990c4a3545f` and its remaining high-severity
finding, “Built-in Codex tools are blocked only after activity can begin”
(`csf_14395776f874dfb1031885b2`). I also inspected the current connector
source, the current official App Server documentation, generated schemas from
the current stable and alpha Codex CLIs, and current Microsoft isolation
documentation.

The source has moved since the sealed scan. That drift includes useful reactive
hardening, but it does not add a preventive built-in-tool denial or restricted
read boundary. This document therefore proposes a decision; it does not claim
the finding is fixed.

## Constraints

We want a one-time install and simple per-session activation for nontechnical
Windows users. The connector must remain current-user, loopback-only,
read-only/no-network for tool execution, and must never copy or parse Codex
credentials. We also keep the agreed public-release block unless a preventive
control is verified or the owner explicitly accepts the residual risk.

## Opportunity Portfolio

| Opportunity | Evidence | Options | Recommendation | Proposal |
| --- | --- | --- | --- | --- |
| Put filesystem denial before any built-in tool can read | High-severity reactive tool-isolation finding (`csf_14395776f874dfb1031885b2`), current source, released App Server schemas, Windows isolation references | Keep the gate; version-gate restricted roots; add an OS sandbox broker; remove explanations | Target restricted roots, but only after a released Windows CLI accepts and passes hostile-read canaries; remain unpublished until then | [Full proposal](proposals/preventive-file-read-isolation.md) |

## Recommendation Summary

I recommend the version-gated restricted-root design because it is the smallest
change that could directly stop a tool from reading arbitrary user files while
preserving the simple user flow. The important qualification is that it is not
available in the stable or alpha schemas inspected on 2026-08-12, despite being
described in the documentation. We should therefore treat support as absent
until the exact released Windows binary accepts the field and enforcement tests
prove that an outside-root canary cannot be read.

Until that gate passes, the existing unpublished state remains the correct
interim control. If a release must happen before upstream support arrives, the
honest immediate choice is to disable the explanation endpoint. A custom OS
sandbox could preserve explanations, but its packaging, authentication, and
Windows Home implications make it a larger product decision rather than a quick
patch.

## Next Decisions

- Decide whether we can wait for a verified upstream restricted-read release.
- If we cannot wait, choose between removing explanations and funding an OS
  isolation prototype.
- After an option is selected, write its implementation plan and re-check the
  current source revision before changing runtime behavior.
