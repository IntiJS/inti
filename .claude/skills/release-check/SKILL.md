---
name: release-check
description: >-
  Full pre-release verification of this repository, the same checks CI runs plus docs, version
  and secrets. Use when the user asks "is it ready to release", "run the release checks",
  "pre-release check", "run what CI runs", "verify everything", or before publishing to npm or
  tagging a version.
---

# Release check

Run every step, even after a failure, and report a table: step, result, and what failed.
Do not fix anything unless the user asks; do not commit, tag, push or publish.

Steps 1 to 5 are the jobs of `.github/workflows/ci.yml`. Run long steps in the background and read
the summary; under load, rerun a failing test file alone before concluding it is broken.

1. **Build** (job `build-and-test`): `npm run build`, then `npm run build:docs` and
   `npm run build -w @intijs/demo-site`.
2. **Tests**: `npm test` (`bun test packages/`).
3. **Astro majors** (job `astro-compat`): `node scripts/astro-compat.mjs 5`, then `6` and `7`.
4. **Scaffolder** (job `create-inti`): `node scripts/create-inti-check.mjs`.
5. **Real projects** (jobs `genui`, `cloudflare`, `wordpress`): `npm run test:genui`,
   `npm run test:cloudflare`, `npm run test:wordpress` (Docker). Also `npm run test:kitsuden`
   (Docker and a Kitsuden image; not in CI). Report a step skipped for a missing Docker as skipped.
6. **Versions.** Every published package and the root `package.json` share the version at the top
   of `CHANGELOG.md`; the adapters, genui, cloudflare and mcp (as a peer) and cli (as a
   dependency) accept that `@intijs/core` version.
7. **License boundary.** No MIT package depends on or imports `@intijs/ee`
   (`bun test packages/core/tests/ee-boundary.test.ts`); every package here is MIT.
8. **Docs.** `README.md`, `AGENTS.md`, `llms.txt` and `CONTRIBUTING.md` agree on adapters
   (which write, which only read), packages and commands; every relative link in `README.md`
   resolves; the docs use `github.com/intijs/inti`, not the old remote name.
9. **English only.** Search tracked text for Spanish prose:
   ```bash
   git grep -nIwiE 'para|los|las|que|con|una|del|está|también|cuando|según|ningún' -- \
     ':!package-lock.json' ':!*.json' | head -50
   ```
   Persisted names kept for compatibility (old Kitsuden keys the adapter still reads) are fine.
10. **Secrets.** No `.env` file is tracked (`git ls-files | grep -E '(^|/)\.env'` prints only
    `.env.example`), and no key or token is in the tree:
    ```bash
    git grep -nIE '(sk-ant-|sk_live_|ghp_|github_pat_|AKIA[0-9A-Z]{16}|kitsuden_agent_[A-Za-z0-9]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY)' | head
    ```
    Never print a matching value: name the file and line only.
11. **Clean tree.** `git status --short` shows only intended changes: no `dist/`, `.inti/`,
    `coverage/`, `*.tgz`, logs, `bun.lock` or `pnpm-lock.yaml`, and no `.claude/settings.local.json`.
