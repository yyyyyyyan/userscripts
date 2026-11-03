# Security policy

This page explains how to report a security problem in one of these scripts
and which versions get fixes.

## Report a vulnerability

Use GitHub's private vulnerability reporting:

1. Open the [new advisory form](https://github.com/yyyyyyyan/userscripts/security/advisories/new).
2. Name the script and the version you tested.
3. Describe what an attacker can do and how to reproduce it.

Please don't open a public issue for a vulnerability. You will get a reply in
the advisory thread, and a fix is released as a new version of the script.

## Supported versions

Only the latest release of each script receives security fixes. If you run an
older version, update first and check whether the problem is still there.

## What counts

Problems that matter here include a script running on pages it should not
match, leaking data to a page or to the network, or running code it fetched
from somewhere else. Scripts in this repository are not meant to do any of
those things.
