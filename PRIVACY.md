# Privacy

This page lists what each script stores, where it stores it, and what it
sends over the network.

## In general

- Scripts keep what they store on your own device. They do not write to any
  server. The row for each script below says what it stores and where.
- Scripts make no network requests unless a script's row below says otherwise.
- Scripts do not collect analytics, identifiers or browsing history, and they
  do not share anything with the author or with third parties.

## Per script

| Script | What it stores | Where | Network requests | Runs on |
|---|---|---|---|---|
| Per-Site Light/Dark Mode | One choice per site (light, dark or browser default). | In your userscript manager's storage on your device. | None. | Every website, because you can pick any site. It does nothing on a site until you choose. |
| Reload Until | Your watches: page address, what to look for, timing and alarm settings, and whether an alarm is waiting for you to acknowledge it. | In your userscript manager's storage on your device. | None. | Every website, because you can watch any page. On a page without a watch, it reads its storage once and adds its menu command, and does nothing else. |

Each script has a row here. Each script's README repeats its row under
**Privacy**.
