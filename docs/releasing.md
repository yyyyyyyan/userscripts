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

1. Create the release branch from an up-to-date `main`. Always name it
   `release/<slug>`:

   ```bash
   git switch -c release/<slug>
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

5. If this is the script's first release, or something manager-specific
   changed, run the manual checklist in the pull request.

6. Update the branch from `main`, then squash-merge the pull request. Merge
   release pull requests one at a time and wait for each publish run to finish
   before you merge the next. The `release` concurrency group keeps only one
   pending run, so a third queued run is dropped.

## Manual release checklist

Automated tests don't cover real sites or Tampermonkey, so the owner runs this
checklist before each script's 1.0.0. Later releases repeat it only when
something manager-specific changed. Paste it into the pull request description
and fill in the script-specific list.

```markdown
## Manual checks

- [ ] Installed the script from the pull request in Tampermonkey on Chromium.
- [ ] Installed the same file in Violentmonkey on Firefox.
- [ ] Ran the steps under **How to use** in the script's README in both.
- [ ] Checked each real site on the script's list:
  - [ ] <site>
```

For Per-Site Light/Dark Mode, the script-specific list is below. The sites are
the ones its README names as tested. The release waits until each item is
checked:

- [ ] Sites, each with **Dark for** selected while the browser is in light:
  - [ ] react.dev
  - [ ] developer.mozilla.org
  - [ ] github.com
  - [ ] docs.python.org
  - [ ] w3.org
  - [ ] wiki.archlinux.org
- [ ] In Tampermonkey, on at least one of those sites, the theme applies and
  **Status** reports it.
- [ ] Form controls and scroll bars follow the choice, in Chromium and in
  Firefox.
- [ ] In Firefox, on a site with a strict Content Security Policy, the theme
  applies or **Status** reports that the script could not run inside the page.
  This path has no automated test.

### Extra checks for Reload Until

The automated tests run Reload Until in Violentmonkey on Chromium only. Add
these lines to its checklist:

```markdown
- [ ] Firefox and Chromium, after **Allow desktop notifications** in the
      settings panel: an alarm's desktop notification stays on screen until
      you click it, and **Acknowledge** closes it.
- [ ] Firefox and Chromium, on a site where notifications aren't allowed: the
      alarm still shows a desktop notification (from the userscript manager).
- [ ] Firefox: an alarm with the insistent alert style repeats its desktop
      notification about once a minute, and **Acknowledge** stops it.
- [ ] Firefox: on a site with a strict Content Security Policy, such as
      github.com, the settings panel and the alarm are styled.
- [ ] Firefox: a reload that a server redirects to another site raises the
      alarm on the page where it ended.
- [ ] Tampermonkey: an alarm shows its desktop notification, and
      **Acknowledge** clears the alarm on the page.
```

While the repository is private, raw files need a sign-in, so a pull request's
file can't be installed from its address. Install from a local copy instead:
check out the release branch and paste the script file into a new script in your
userscript manager.

When every box is checked, reply "checked" in the pull request. Squash-merge
only after that reply. When the checklist doesn't apply, merge once the checks
pass.

## Publish

The `release` workflow (`.github/workflows/release.yml`) runs on every push to
`main` that changes `scripts/`. It finds the releases in the pushed commits: a
script whose `@version` rose to 1.0.0 or more and whose `CHANGELOG.md` gained a
section for that version. For each release it:

1. Copies `<slug>.user.js`, the README as `<slug>.md` and the images into the
   `dist` branch.
2. Commits there with the message `<Name> <version>`, followed by the changelog
   section. Greasy Fork shows that message as the script's changelog.
3. Pushes `dist`, then tags the release commit on `main` as
   `<slug>-v<version>`.

Greasy Fork reads `dist`, so a README change reaches it only with the next
release of that script.

## Publish a script for the first time

1. Make the repository public. Do this once, before the first script.
2. Merge the script's release pull request and wait for the publish run to
   finish.
3. On Greasy Fork, import
   `https://raw.githubusercontent.com/yyyyyyyan/userscripts/dist/<slug>.user.js`
   with the sync type set to **Automatic**.
4. Set the additional info sync address to
   `https://raw.githubusercontent.com/yyyyyyyan/userscripts/dist/<slug>.md`.
5. In a normal pull request, replace "Coming soon" in the root `README.md`
   table with the script's Greasy Fork install link.
6. Make a follow-up patch release. If Greasy Fork shows the new version, the
   webhook works.

## Recover from a failed publish run

If a run fails partway, running it again fails too. It stops with "nothing to
commit" because `dist` already has the release, or with a tag that already
exists. Finish by hand from a checkout of `main`:

1. Check `dist` on GitHub for the `<Name> <version>` commit. If it's missing,
   rebuild it. `<before>` is the commit before the release, and `<release>` is
   the release commit:

   ```bash
   git fetch origin
   git worktree add --detach ../dist origin/dist
   node tools/release-publish.mjs --before <before> --after <release> --dist ../dist
   git -C ../dist push origin HEAD:refs/heads/dist
   ```

2. Create the missing tag on the release commit and push it:

   ```bash
   git tag <slug>-v<version> <release>
   git push origin <slug>-v<version>
   ```
