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
| Reload Until | Your watches: page address, what to look for, timing and alarm settings, and whether an alarm is waiting for you to acknowledge it and which page raised it. While a watched page reloads, which page is reloading, until the reloaded page opens. | In your userscript manager's storage on your device. On the watched site only, the tab's session storage also holds the watched address while it reloads or while an alarm is waiting. | None. | Every website, because you can watch any page and a reload can end on another site. On a page without a watch, it reads its storage once, or twice if the page was reloaded, to check whether a watched page's reload ended there. It also checks the tab's session storage for a waiting alarm and adds its menu command, and does nothing else. |

Each script has a row here. Each script's README repeats its row under
**Privacy**.
