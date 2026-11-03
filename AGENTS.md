# AGENTS.md

Guidance for coding agents working in this repository: a collection of
userscripts for Violentmonkey and Tampermonkey, published to Greasy Fork.
There is no `CLAUDE.md`; this file is the single source.

## Layout

```text
scripts/<slug>/
  <slug>.user.js      source == published file
  README.md           also the Greasy Fork page
  CHANGELOG.md        assembled at release
  changelog.d/        pending fragments: <short-name>.<section>.md
  images/
tests/e2e/            Playwright + Violentmonkey
tools/                release and check tooling (Node, no deps)
docs/                 style.md (house style), releasing.md
.github/              workflows, issue forms, dependabot
README.md COPYING CONTRIBUTING.md SECURITY.md PRIVACY.md AGENTS.md
```

The `dist` branch holds only what Greasy Fork reads. The release workflow
writes it and nothing else does.

## Invariants

- Never rename a published slug or path, or change `@namespace`.
- Never hand-edit `@version` or `dist`. A new script starts at `@version 0.0.0`;
  only `tools/release-prepare.mjs` moves it.
- Every user-visible change has a changelog fragment.
- Keep `@grant` and `@match` minimal, and explain each in the script README.
- No remote code. Disclose all network access in the README and `PRIVACY.md`.
- Do not write `@downloadURL` or `@updateURL`.
- Support Violentmonkey and Tampermonkey only. Never call `GM_getTab`,
  `GM_saveTab` or `GM_getTabs`; Violentmonkey does not have them.
- Comments in code state a non-obvious why, or they are not written.

## Commands

```bash
npm ci                                  # install pinned dev tools
prek run --all-files                    # format, lint, type-check, spell-check
npm test                                # unit and tooling tests
npm run e2e                             # Playwright + Violentmonkey smoke tests
node tools/changelog-add.mjs <slug> <section> <short-name> "<sentence>"
node tools/release-prepare.mjs <slug>   # assemble changelog, set @version
```

Sections are `breaking added changed deprecated removed fixed security`. A
fragment is one complete sentence ending in `.`, `!` or `?`.

## Writing

All user-facing text follows `docs/style.md`. Read it before editing a
README, a changelog entry or an issue form.

## Commits and pull requests

- Commits on a branch are free-form.
- PR titles use Conventional Commits (`feat(reload-until): ...`), because the
  title becomes the squash commit on `main`. Release PRs use
  `release(<slug>): <version>`.
- Work on a branch in a worktree. Do not push to `main` directly.
