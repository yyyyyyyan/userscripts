# Changelog

All notable changes to Reload Until are documented here. The format is based on Keep a Changelog, and versions follow Semantic Versioning.

## [1.0.1] - 2026-11-04

### Fixed

- On sites with keyboard shortcuts, such as GitHub, typing in the settings panel no longer sets off the site's shortcuts instead of filling in the field.

### Security

- A page where a reload ends, or any page you open the settings on, can no longer read your watches by hooking the page's own JavaScript, because the script now runs apart from it.

## [1.0.0] - 2026-11-03

### Added

- Reloads a page until something you pick appears or disappears, then raises an alarm that stays on the page and in the tab title until you acknowledge it.
- The alarm also goes off when a reload ends on a different page, such as a sign-in page, or on a page without the element you said is always there.
- One **Alert style** setting picks how an alarm reaches you: on the page only, with one desktop notification, or with a desktop notification and a sound every minute while the tab stays open.
- The settings panel groups its options under **What to watch**, **When** and **How to alert**, and shows only the current site's watches.
- Pages you don't watch are left alone, and the script ignores clicks that a page fakes with its own scripts.
