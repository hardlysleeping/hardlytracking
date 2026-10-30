#!/usr/bin/env bash
# One command, one place: build the unsigned IPA on GitHub and drop it at
# ~/IPA/HardlyTracking-unsigned.ipa. No version in the name, no new folder.
set -euo pipefail

REPO=hardlysleeping/hardlytracking
WORKFLOW=ios-ipa.yml
DEST="$HOME/IPA/HardlyTracking-unsigned.ipa"
TAG=ios-0.1.0

mkdir -p "$HOME/IPA"
cd "$(dirname "$0")/.."

echo "sha: $(git rev-parse --short HEAD)"
gh workflow run "$WORKFLOW" --repo "$REPO"
sleep 8
RUN=$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --limit 1 --json databaseId -q '.[0].databaseId')
echo "run: https://github.com/$REPO/actions/runs/$RUN"

gh run watch "$RUN" --repo "$REPO" --exit-status --interval 20 >/dev/null

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
gh run download "$RUN" --repo "$REPO" -D "$TMP"
IPA=$(find "$TMP" -name '*.ipa' | head -1)
[ -n "$IPA" ] || { echo "no .ipa in the artifact" >&2; exit 1; }
cp -f "$IPA" "$DEST"

if [ "${1:-}" = "--release" ]; then
  gh release upload "$TAG" "$DEST" --repo "$REPO" --clobber
fi

ls -l "$DEST"
echo "IPA: $DEST"
