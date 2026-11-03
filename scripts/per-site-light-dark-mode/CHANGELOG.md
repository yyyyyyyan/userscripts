# Changelog

All notable changes to Per-Site Light/Dark Mode are documented here. The format is based on Keep a Changelog, and versions follow Semantic Versioning.

## [1.0.1] - 2026-11-03

### Fixed

- On sites that pick their theme the moment they start loading, such as react.dev, Status now names the userscript manager setting that makes the script run first.
- Status no longer says your choice applied when a page only asked for your theme and nothing on it could switch.

## [1.0.0] - 2026-11-03

### Added

- Select Light, Dark or Browser default for any site from your userscript manager's menu, and the site then uses its own matching theme.
- A choice also covers the site's subdomains, and a theme you set with the site's own switch still wins.
- Select Status in the same menu to see in plain words whether your choice applied and what to try if it didn't.
