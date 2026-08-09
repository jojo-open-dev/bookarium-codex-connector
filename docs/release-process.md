# Release process

Status: local release-candidate process only. Public npm publication is intentionally not implemented or authorized.

## Continuous integration

Pull requests and pushes to `main` run read-only CI on GitHub-hosted Linux and Windows runners. CI installs with lifecycle scripts disabled, checks JavaScript syntax and repository text hygiene, enforces immutable full-SHA action references, scans tracked text for high-confidence secret formats, runs `npm audit`, verifies the exact npm file allowlist, and executes the fake-App-Server test suite. No CI job receives a write-capable repository token or publication credential.

GitHub-hosted action revisions are pinned to full reviewed commit SHAs. Dependabot may propose action or npm updates, but those changes must receive normal review. Repository settings should also require full-SHA action pinning, restrict allowed actions to GitHub-owned actions, require CODEOWNER review for workflows and release files, and enable GitHub secret scanning and push protection.

## Local release candidate

From a clean reviewed commit:

```powershell
New-Item -ItemType Directory -Force release-candidate
npm ci --ignore-scripts --no-audit --no-fund
npm run lint
npm run check:secrets
npm audit --audit-level=low
npm test
npm pack --pack-destination release-candidate --json > release-candidate/pack-report.json
Get-Content release-candidate/pack-report.json | node scripts/repository-checks.mjs pack
node scripts/repository-checks.mjs artifact release-candidate/pack-report.json
```

The artifact check decompresses the tarball, rejects links and unexpected paths, compares every file to a reviewed allowlist, scans packed content for high-confidence secrets and developer-local absolute paths, and writes `release-manifest.json` plus `SHA256SUMS`.

The manual `Build local release candidate` workflow performs the same checks for one explicit 40-character reviewed commit. It uses the `local-release-candidate` GitHub environment and retains the result for 14 days. That workflow has read-only permissions and cannot create a tag, GitHub release, npm package, or provenance statement.

## Security and clean-machine gates

A repository-wide Codex Security scan is required for each release candidate. Valid findings must be fixed and regression-tested, or recorded as explicit release blockers with an accountable owner decision. The current high-severity blocker is App Server's lack of a preventive per-turn switch for all built-in tools. A compatibility review of installed `codex-cli 0.146.0`, current stable `0.147.0`, and `0.148.0-alpha.8` found that their generated App Server schemas expose neither restricted readable roots nor a built-in-tool disable control. The official upstream request for the latter remains open ([openai/codex#6049](https://github.com/openai/codex/issues/6049)). No network, no approvals, an empty working directory, fail-closed item handling, and confirmed process termination reduce impact but do not eliminate the event-observation race or prove filesystem-read isolation.

The release owner must choose among waiting for compatible upstream controls, approving a separately scoped external process-isolation boundary, disabling the explanation endpoint, or explicitly accepting the residual risk. Risk acceptance does not remediate the finding. Publication remains blocked until that decision and the clean-machine gate are complete.

Before publication, run the exact tarball on a clean Windows 10/11 virtual machine with the supported minimum Node.js and a separately installed official Codex CLI. Verify official ChatGPT sign-in, automatic browser pairing, a real Bookarium explanation, restart persistence, rotation/revocation, and narrow uninstall that leaves Codex and its authentication intact. An isolated temporary profile on a development machine is useful evidence, but it does not replace this clean-VM gate.

## Publication remains disabled

Do not add `npm publish`, `id-token: write`, repository write permissions, a release/tag action, or an npm credential until the owner explicitly approves Milestone 5. Before that approval, verify npm scope/name ownership, configure a protected `npm-production` environment with required reviewers, configure npm trusted publishing for the exact repository/workflow, review all pinned action SHAs, and require a reviewed version tag. Publication must use GitHub OIDC/provenance rather than a long-lived npm token and must verify the registry artifact after publishing.
