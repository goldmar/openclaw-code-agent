# Contributing to openclaw-code-agent

Thank you for your interest in contributing! This guide covers everything you need to get started.

---

## Prerequisites

- **Node.js** 22
- **pnpm** 10+ — install with `npm install -g pnpm`

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

`pnpm verify` is the contributor and release gate. It runs typecheck, build, and the full test suite in the same order CI uses.

### Individual commands

```bash
pnpm run typecheck
pnpm run build
pnpm run test
```

Tests use Node's built-in test runner (`node --test`) via `tsx` for TypeScript support.
All `*.test.ts` files under `tests/` are discovered and run automatically.

---

## All CI checks must pass before merging

Every PR must pass `pnpm verify` locally and in CI. The current automated checks are:

| Check | Command | Notes |
|-------|---------|-------|
| Verify | `pnpm verify` | Canonical typecheck + build + test gate on Node 22 |
| Bundle size | — | `dist/index.js` must be < 500 KB |
| Lockfile integrity | — | `pnpm-lock.yaml` must be in sync with `package.json` |

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

Claude Code and other coding agents use branches with the `agent/` prefix when running
in isolated git worktrees. **Do not delete these branches manually** — they are managed
by the agent orchestration layer and cleaned up automatically when the session ends.

If you see stale `agent/*` branches after a session, you can safely delete them once you
confirm the associated agent session has completed:

```bash
# List remote agent branches
git branch -r | grep 'origin/agent/'

# Delete a specific stale branch (only when the session is confirmed finished)
git push origin --delete agent/<session-id>
```

---

## Submitting a PR

1. Fork the repo and create a branch from `main` using the naming convention above
2. Make your changes and verify all CI checks pass locally
3. Open a pull request against `main` — the PR template will guide you
4. All CI checks must be green before the PR can be merged
5. At least one review approval is required

---

## Release process

Releases are handled via the `release.yml` GitHub Actions workflow:

- **Tag push**: push a `v*` tag (e.g. `v2.3.2`) to trigger an automated release
- **Manual dispatch**: use the "Release" workflow in the Actions tab and supply the version

The workflow runs the full CI gate (`pnpm verify`), publishes to npm using
Trusted Publishing (OIDC — no secrets or tokens required), and creates a GitHub release
with notes extracted from `CHANGELOG.md`.

**One-time npm setup (repo maintainers only):** On npmjs.com, go to the `openclaw-code-agent`
package → Settings → Trusted Publishers, and add a GitHub Actions publisher for this
repository (`goldmar/openclaw-code-agent`, workflow `release.yml`). After that, releases
are fully automated with no stored credentials.
