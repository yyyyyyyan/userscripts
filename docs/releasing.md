# Releasing

This page describes how a script goes from merged changes to a new version on
Greasy Fork. The maintainer follows it for every release.

## Overview

A release has two stages. Preparing builds the changelog section and sets the
version in a release pull request. Publishing runs after that pull request
merges and copies the script to the `dist` branch, which Greasy Fork reads.
