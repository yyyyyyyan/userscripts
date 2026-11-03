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
| Reload Until | Your watches: page address, what to look for, timing and alarm settings, whether an alarm is waiting for you to acknowledge it and which page raised it, and, if the script paused a watch, why. Whether it has shown its one-time tip about where to find the settings. A storage format number. For a moment while a watched page reloads, which page is reloading. The page the reload ends on removes it. If the reload fails, it stays until the next reload replaces it. | In your userscript manager's storage on your device. On the watched site only, the tab's session storage also holds the watched address while it reloads or while an alarm is waiting, and whether you hid the details in its box on the page. | None. The only requests it causes are the reloads of the pages you watch. | Every website, because you can watch any page and a reload can end on another site. On a page without a watch, it adds its menu command and checks its storage for a watch on the page and for whether it has shown its tip. It also checks the tab's session storage for a waiting alarm. If the page was reloaded, it checks its storage and the tab's session storage for a watched page's reload that ended there. In older browsers without the Navigation API, that check may wait three seconds and read the storage once more. It does nothing else, with one exception: on the first page it runs on after you install it, it shows a tip about where to find its settings and stores that it did. It never shows that tip again. On a page with a watch, even one that is turned off, it also checks the page's address twice a second until the page reloads or closes, to follow the site's in-page navigation. |

Each script has a row here. Each script's README repeats its row under
**Privacy**.
