# Contributing

This page explains how to report a bug and how to change a script. Outside
pull requests are welcome.

## Report a bug

If something breaks, [open an issue](https://github.com/yyyyyyyan/userscripts/issues/new/choose)
and include:

- The script name.
- Your userscript manager and its version.
- Your browser and its version.
- The address of the page where it happens, if you can share it.
- The steps that cause it.
- Any errors from the browser console. Open the developer tools and select
  **Console**.

To suggest a feature, use the feature form in the same place.

## Set up

You need Node.js 22 or later, [prek](https://github.com/j178/prek) and `unzip`.
The end-to-end tests use `unzip` to unpack Violentmonkey.

1. Clone the repository.
2. Run `npm ci` to install the pinned tools.
3. Run `prek install` to run the checks before each commit.
4. Run `npx playwright install chromium` to install the browser the
   end-to-end tests use.

## Check your work

- `prek run --all-files` formats, lints, type-checks and spell-checks
  everything.
- `npm test` runs the tooling tests.
- `npm run e2e` installs each script in Chromium with Violentmonkey and runs
  a smoke test against a local page.
- `node tools/check.mjs --base origin/main` checks the changelog fragment and
  `@version` rules against `main`, the way the pull request check does.

## Layout

Each script lives in `scripts/<slug>/`:

- `<slug>.user.js` is the source and also the file that gets published.
- `README.md` is the script's page on GitHub and Greasy Fork.
- `CHANGELOG.md` is assembled at release time.
- `changelog.d/` holds fragments for changes that aren't released yet.
- `images/` holds screenshots.

Tooling is in `tools/`, end-to-end tests are in `tests/e2e/`, and the writing
rules are in [docs/style.md](docs/style.md). Follow them in any text a user
reads.

## Add a script

1. Create `scripts/<slug>/<slug>.user.js`. The slug is permanent, so choose it
   with care.
2. Start the metadata block with these keys, in this order:
   - `@name`
   - `@namespace yyyyyyyan/<slug>`
   - `@version 0.0.0`
   - `@description`: one sentence of about 120 characters or fewer, starting
     with a verb
   - `@author yyyyyyyan`
   - `@license GPL-3.0-or-later`
   - `@homepageURL https://github.com/yyyyyyyan/userscripts/tree/main/scripts/<slug>`
   - `@supportURL https://github.com/yyyyyyyan/userscripts/issues`
3. Add `@match`, `@grant`, `@run-at` and `@noframes` as the script needs them.
   Keep `@grant` and `@match` minimal.
4. End the block with these two lines:

   ```javascript
   // @compatible   chrome Violentmonkey or Tampermonkey; enable "Allow User Scripts"
   // @compatible   firefox Violentmonkey or Tampermonkey
   ```

5. Never write `@downloadURL` or `@updateURL`.
6. Write `scripts/<slug>/README.md` with these sections, in this order:
   1. A one or two sentence summary and a screenshot.
   2. **How to use**, as numbered steps.
   3. **Settings**.
   4. **Where it runs and what it can access**, with each `@match` and
      `@grant` in plain words.
   5. **Limitations**.
   6. **Privacy**.
   7. Absolute links to the changelog and to support.

   Use only Markdown that GitHub and Greasy Fork both render. That rules out
   alert boxes, `<picture>` and bare URLs. Images use relative or `https` links.
7. Add a row for the script to the table in [PRIVACY.md](PRIVACY.md) and to the
   table in the root [README.md](README.md).
8. Add the script to the **Script** dropdown in both issue forms in
   `.github/ISSUE_TEMPLATE/`.
9. Add a smoke test in `tests/e2e/<slug>.spec.mjs`.

A new script has no changelog fragment and no `CHANGELOG.md`. It reaches
`1.0.0` through its first release.

## Describe your change

Every user-visible change needs a changelog fragment. Create one with:

```bash
node tools/changelog-add.mjs <slug> <section> <short-name> "<sentence>"
```

The command writes `scripts/<slug>/changelog.d/<short-name>.<section>.md`.
Follow these rules:

- The section is one of `breaking`, `added`, `changed`, `deprecated`,
  `removed`, `fixed` or `security`.
- The short name is lowercase words joined by hyphens, such as `csp-styling`.
- The sentence says what changes for the user, not how the code changed.
- The file holds one line, with no leading `- `. The sentence ends in `.`, `!`
  or `?`.

The section decides the next version. A `breaking` fragment makes a major
release. `added`, `changed`, `deprecated` and `removed` make a minor release.
`fixed` and `security` make a patch release. A script's first release is always
1.0.0.

Changes with no visible effect, such as reformatting, don't need a fragment;
ask for the `no-changelog` label on the pull request.

Don't edit `@version` by hand. Releases set it.

## Commits and pull requests

Commit however you like on your branch. The pull request title becomes the
commit on `main`, so it must follow
[Conventional Commits](https://www.conventionalcommits.org/), for example
`fix(reload-until): stop reloading after the page redirects`. Merges are
squash-only.

## Releases

The maintainer prepares and publishes releases. The steps are in
[docs/releasing.md](docs/releasing.md).
