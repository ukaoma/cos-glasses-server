#!/bin/sh
# Golden revisions for controlSnapshotRevision (server/lib/work-activity.ts), computed by COS Control's own Swift.
#
# swift/ holds, unchanged except for trimming unrelated members, COS Control's JSONValue, WorkMeetingReference,
# TaskRow and WorkSource.taskSnapshot from ctl249 at ec9c1e0 (0.5.250), plus a main.swift that prints
# "<source id> <revision>" for each row. rows.mjs writes the rows (the Swift goldens of 2026-09-30 and 12 edge rows:
# unreadable meeting refs, control and format characters, a missing text, a 2,049-byte record id).
#
# Run on a Mac with Xcode or the Swift toolchain; work-activity.test.ts compares the server to expected.txt.
set -eu
cd "$(dirname "$0")"
node rows.mjs > rows.json
out="$(mktemp -d)"
swiftc -O swift/*.swift -o "$out/snapshot"
"$out/snapshot" rows.json > expected.txt
rm -rf "$out"
