# Releasing

This page describes how a script goes from merged changes to a new version on
Greasy Fork. The maintainer follows it for every release.

## Overview

A release has two stages. Preparing builds the changelog section and sets the
version in a release pull request. Publishing runs after that pull request
merges and copies the script to the `dist` branch, which Greasy Fork reads.

## Add a changelog entry

Every user-visible change records one fragment: a file holding one sentence, in
`scripts/<slug>/changelog.d/`. Add it in the same pull request as the change.

1. Run the command:

   ```bash
   node tools/changelog-add.mjs <slug> <section> <short-name> "<sentence>"
   ```

2. Commit the new file with the change.

[CONTRIBUTING.md](../CONTRIBUTING.md) lists the sections and the rules for the
sentence. The command checks them, and it refuses to overwrite an existing
fragment.

## Prepare a release

The prepare step turns a script's pending fragments into a new `CHANGELOG.md`
section, deletes those fragments and sets `@version`. The sections decide the
version:

- `breaking` makes a major release.
- `added`, `changed`, `deprecated` and `removed` make a minor release.
- `fixed` and `security` make a patch release.
- A script's first release is always 1.0.0.

Nobody edits `@version` by hand.

To prepare a release:

1. Create the release branch from an up-to-date `main`. Use the version the
   pending fragments call for. If you aren't sure, name it `release/<slug>` and
   rename it with `git branch -m` once step 2 prints the version.

   ```bash
   git switch -c release/<slug>-<version>
   ```

2. Run the prepare tool. It prints the new version:

   ```bash
   node tools/release-prepare.mjs <slug>
   ```

   The tool dates the section today in UTC. Pass `--date YYYY-MM-DD` to use
   another date. If there are no pending fragments or one is malformed, the
   tool prints an error, exits with status 1 and changes nothing.

3. Commit the changed files: the script, its `CHANGELOG.md` and the deleted
   fragments.

4. Open the pull request:

   ```bash
   gh pr create --title "release(<slug>): <version>"
   ```

5. Run the manual checklist in the pull request.

6. Squash-merge the pull request.
