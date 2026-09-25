# Contributing to openclaw-code-agent

Thank you for your interest in contributing! This guide covers everything you need to get started.

---

## Prerequisites

- **Node.js** 24.16.0+ on Node 24 or 26.1.0+ on Node 26, matching the pinned OpenClaw SDK
- **pnpm** 11 — the repo pins `pnpm@11.15.1` in `packageManager`; use `corepack enable` or `npm install -g pnpm@11.15.1`

---

## Local development

### Install dependencies

```bash
pnpm install
```

### Canonical local validation

```bash
pnpm verify
```

`pnpm verify` is the contributor and release gate. It runs the static guardrails (including the npm-shrinkwrap check), typecheck, build, the ClawHub static scan of the packed files, and the full test suite, in the same order CI uses.

For release prep, validate manifest/package version parity too:

```bash
pnpm run validate:release-metadata -- <version>
```

For preparation-only release work, stop at a PR-ready branch. Do not push a `v*` tag, manually dispatch the release workflow, or run `npm publish` unless a maintainer explicitly asks for publishing. Use `npm pack --dry-run` when package or release metadata changed.

### Individual commands

```bash
pnpm run typecheck
pnpm run build
pnpm run test
```

Tests use Node's built-in test runner (`node --test`) via `tsx` for TypeScript support.
All `*.test.ts` files under `tests/` are discovered and run automatically. `scripts/run-tests.mjs` runs each file in its own process with a temporary OpenClaw home, and every test file must start with `import "./test-env";` (enforced by `pnpm check-static-guardrails`) so no test can touch your real `~/.openclaw`.

---

## All CI checks must pass before merging

Every PR must pass `pnpm verify` locally and in CI. The current automated checks are:

| Check | Command | Notes |
|-------|---------|-------|
| Verify | `pnpm verify` | Canonical guardrails + typecheck + build + ClawHub scan + test gate on Node 24.16.0 and 26.1.0 |
| Bundle size | — | Complete `dist/` bundle must be <= 700 KB |
| Lockfile integrity | `pnpm install --frozen-lockfile` | `pnpm-lock.yaml` must be in sync with `package.json` |
| npm consumer install | `pnpm verify:npm-consumer` | The packed package must install with its `npm-shrinkwrap.json` dependency graph |
| Security audit | `pnpm run audit:prod` | Production dependency advisories |
| Dependency review | — | GitHub Dependency Review of dependency changes |
| CodeQL | — | GitHub code scanning |
| Workflow sanity | — | Workflow files: no tabs, actionlint |

If the lockfile check fails, regenerate it locally:

```bash
pnpm install
git add pnpm-lock.yaml
git commit -m "chore: update pnpm lockfile"
```

> This repo standardizes on `pnpm`. Commit `pnpm-lock.yaml` alongside any changes to `package.json`.

---

## Branch naming conventions

| Prefix | Purpose | Example |
|--------|---------|---------|
| `feat/` | New features | `feat/codex-streaming` |
| `fix/` | Bug fixes | `fix/agent-timeout-crash` |
| `chore/` | Maintenance, deps, tooling | `chore/update-esbuild` |
| `docs/` | Documentation only | `docs/add-api-reference` |
| `ci/` | CI/CD changes | `ci/add-size-check` |
| `refactor/` | Code refactors (no behaviour change) | `refactor/extract-session-manager` |

---

## Worktree branches (`agent/*`)

OpenClaw Code Agent creates `agent/<session-name>` branches for its isolated git worktrees.
**Do not delete these branches manually while they are in use.** OCA removes them once the
worktree is resolved (merged, dismissed, released, or finished without changes), through its
maintenance schedules or `agent_worktree_cleanup`; the `manual` strategy keeps them until you
act. Remote copies exist only for branches pushed for a PR.

If you see stale `agent/*` branches, check `agent_worktree_status` first, then delete them
once the associated session is confirmed finished:

```bash
# List remote agent branches
git branch -r | grep 'origin/agent/'

# Delete a specific stale branch (only when the session is confirmed finished)
git push origin --delete agent/<session-name>
```

---

## Submitting a PR

1. Fork the repo and create a branch from `main` using the naming convention above
2. Make your changes and verify all CI checks pass locally
3. Open a pull request against `main` — the PR template will guide you
4. All CI checks must be green before the PR can be merged
5. Resolve every review conversation and wait for all required checks before merging

---

## Release process

Releases are handled only through a manual dispatch of the `release.yml` GitHub Actions workflow. Supply the version without a leading `v` and the full `main` commit SHA to release.

The workflow verifies that the selected commit belongs to `main`, runs the full CI and security gates on Node.js 24.16.0, validates package/plugin/changelog/lockfile metadata, and packs one artifact. The jobs that follow run in the protected `release` environment, which requires a reviewer's approval: one job creates or verifies the immutable `v<version>` tag, then separate jobs publish that exact tarball to npm (GitHub OIDC Trusted Publishing with provenance; the job holds no other credential and installs nothing) and to ClawHub (the environment's `CLAWHUB_TOKEN` secret and the ClawHub CLI pinned in `.github/release-tools/`). A final job creates or updates the matching GitHub release. Safe retries verify existing artifact digests before skipping a registry or release upload. See the release checklist in [docs/DEVELOPMENT.md](../docs/DEVELOPMENT.md#releasing).

The npm trust relationship must match:

- repository: `goldmar/openclaw-code-agent`
- workflow: `release.yml`
- environment: `release`

npm then authenticates the npm publish job through OIDC. Do not add an `NPM_TOKEN` secret. `CLAWHUB_TOKEN` must be a secret of the `release` environment; only the environment-gated ClawHub job reads it, so no repository-level copy is needed.
