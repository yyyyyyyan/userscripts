# Contributing

This page explains how to report a bug and how to change a script. Outside
pull requests are welcome.

## Report a bug

If something breaks, [open an issue](https://github.com/yyyyyyyan/userscripts/issues/new/choose)
and include:

- The script name.
- Your userscript manager and its version.
- Your browser and its version.
- The address of the page where it happens.
- The steps that cause it.
- Any errors from the browser console. Open the developer tools and select
  **Console**.

To suggest a feature, use the feature form in the same place.

## Set up

You need Node.js and [prek](https://github.com/j178/prek).

1. Clone the repository.
2. Run `npm ci` to install the pinned tools.
3. Run `prek install` to run the checks before each commit.

## Check your work

- `prek run --all-files` formats, lints, type-checks and spell-checks
  everything.
- `npm test` runs the tooling tests.
- `npm run e2e` installs each script in Chromium with Violentmonkey and runs
  a smoke test against a local page.

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

## Describe your change

Every user-visible change needs a changelog fragment. Create one with:

```bash
node tools/changelog-add.mjs <slug> <section> <short-name> "<sentence>"
```

The section is one of `breaking`, `added`, `changed`, `deprecated`, `removed`,
`fixed` or `security`. The sentence says what changes for the user, in one
line that ends with a period. Changes with no visible effect, such as
reformatting, don't need a fragment; ask for the `no-changelog` label on the
pull request.

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
