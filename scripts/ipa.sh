#!/usr/bin/env bash
# One command, one place: build the unsigned IPA on Codemagic, check it, and (with --release) put it
# where people download it. No version in the name at the sideload path, no new folder.
#
#   ./scripts/ipa.sh                 # build the current commit, verify, leave the file in /tmp
#   ./scripts/ipa.sh --release       # ...and copy to ~/IPA + upload both release slots
#   ./scripts/ipa.sh --build <id>    # reuse a Codemagic build instead of dispatching one
#
# Codemagic is the primary iOS build service; `.github/workflows/ios-ipa.yml` is the fallback and
# uploads the same two slots itself. GitHub's macOS arm64 pool refused to allocate a runner four
# times in a row on 0.7.16 while this service built the same tag without waiting.
set -euo pipefail

APP_ID=6aefa30ff9882de26d15662e   # Codemagic "hardlytracking" (the second registration is dead)
WORKFLOW=ios-unsigned
REPO=hardlysleeping/hardlytracking
DEST="$HOME/IPA/HardlyTracking-unsigned.ipa"
TOKEN_FILE="$HOME/.config/codemagic/token"
COOKIES=$(mktemp -t cmjar.XXXXXX)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK" "$COOKIES"' EXIT

RELEASE=0
BUILD_ID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --release) RELEASE=1 ;;
    --build) BUILD_ID=${2:?--build needs an id}; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

[ -s "$TOKEN_FILE" ] || { echo "no Codemagic token at $TOKEN_FILE" >&2; exit 1; }
TOKEN=$(cat "$TOKEN_FILE")

cd "$(dirname "$0")/.."
SHA=$(git rev-parse HEAD)
echo "sha: $(git rev-parse --short HEAD)  version: $(node -p "require('./package.json').version")"

api() { curl -fsS -H "X-Auth-Token: $TOKEN" "$@"; }

# The dispatch names a workflow that must exist in codemagic.yaml on this commit, or the API answers
# nothing useful and the build never starts.
if [ -z "$BUILD_ID" ]; then
  BUILD_ID=$(api -X POST https://api.codemagic.io/builds \
    -H 'Content-Type: application/json' \
    --data "{\"appId\":\"$APP_ID\",\"workflowId\":\"$WORKFLOW\",\"branch\":\"master\"}" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("buildId",""))')
  [ -n "$BUILD_ID" ] || { echo "Codemagic accepted no build" >&2; exit 1; }
fi
echo "build: https://codemagic.io/app/$APP_ID/build/$BUILD_ID"

# Poll to a terminal state. Codemagic queues before it builds, so the first minutes say "waiting".
for _ in $(seq 1 180); do
  STATE=$(api "https://api.codemagic.io/builds/$BUILD_ID")
  STATUS=$(printf '%s' "$STATE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["build"]["status"])')
  case "$STATUS" in
    finished|failed|timeout|canceled) break ;;
  esac
  sleep 20
done
printf '%s' "$STATE" | python3 -c '
import json,sys
b=json.load(sys.stdin)["build"]
print("status:", b["status"])
for a in (b.get("buildActions") or []):
    print(" ", a.get("status"), a.get("name"))
'
[ "$STATUS" = "finished" ] || { echo "build ended as $STATUS" >&2; exit 1; }

# The commit it reports is the annotated tag object when a tag was built, so compare the peeled
# commit. A build of the wrong source is the failure that looks like success.
GOT=$(printf '%s' "$STATE" | python3 -c 'import json,sys; print((json.load(sys.stdin)["build"].get("commit") or {}).get("hash",""))')
if [ -n "$GOT" ] && [ "$(git rev-parse "$GOT^{commit}")" != "$SHA" ]; then
  echo "note: this build is $(git rev-parse --short "$GOT^{commit}"), HEAD is $(git rev-parse --short HEAD)"
fi

URL=$(printf '%s' "$STATE" | python3 -c '
import json,sys
arts=json.load(sys.stdin)["build"].get("artefacts") or []
ipa=[a for a in arts if (a.get("name") or "").endswith(".ipa")]
print(ipa[0]["url"] if ipa else "")
')
[ -n "$URL" ] || { echo "the build published no .ipa" >&2; exit 1; }

# The artefact URL needs the token and a cookie jar; a bare curl saves a FORBIDDEN JSON with .ipa on
# the end, which unzips to nothing and reads as a broken app.
IPA="$WORK/HardlyTracking-unsigned.ipa"
curl -fL -b "$COOKIES" -c "$COOKIES" -H "X-Auth-Token: $TOKEN" "$URL" -o "$IPA" \
  || { echo "download failed (the sign-in redirect was not followed?)" >&2; exit 1; }
SIZE=$(wc -c < "$IPA" | tr -d ' ')
echo "ipa: $SIZE bytes  sha256 $(sha256sum "$IPA" | cut -d' ' -f1)"

# Read the bundle instead of trusting the build status.
rm -rf "$WORK/app"
unzip -q -o "$IPA" -d "$WORK/app"
APP=$(find "$WORK/app/Payload" -maxdepth 1 -name '*.app' -print -quit)
[ -n "$APP" ] || { echo "the ipa has no Payload/*.app" >&2; exit 1; }
WANT=$(node -p "require('./package.json').version")
python3 - "$APP" "$WANT" <<'PY'
import json, os, plistlib, sys
app, want = sys.argv[1], sys.argv[2]
p = plistlib.load(open(os.path.join(app, "Info.plist"), "rb"))
print("bundle:", p["CFBundleIdentifier"], "| version:", p["CFBundleShortVersionString"], "| build:", p["CFBundleVersion"])
print("min ios:", p.get("MinimumOSVersion"), "| family:", p.get("UIDeviceFamily"))
assert p["CFBundleShortVersionString"] == want, f"bundle says {p['CFBundleShortVersionString']}, repo says {want}"
plugins = json.load(open(os.path.join(app, "capacitor.config.json"))).get("packageClassList") or []
print("plugins:", plugins)
assert "MihonRuntimePlugin" in plugins, "the runtime plugin is not registered"
assert os.path.isfile(os.path.join(app, "Frameworks", "MihonRuntime.framework", "MihonRuntime")), "no MihonRuntime.framework"
assert os.path.isfile(os.path.join(app, "Frameworks", "OpenJDKRuntime.framework", "OpenJDKRuntime")), "no OpenJDKRuntime.framework"
assert not os.path.exists(os.path.join(app, "_CodeSignature")), "the build is signed; this slot is unsigned"
print("checks: version, plugin registration, both frameworks, unsigned")
PY

if [ "$RELEASE" = 0 ]; then
  cp "$IPA" /tmp/HardlyTracking-unsigned.ipa
  echo "ipa: /tmp/HardlyTracking-unsigned.ipa (pass --release to update ~/IPA and both release slots)"
  exit 0
fi

mkdir -p "$(dirname "$DEST")"
cp -f "$IPA" "$DEST"
gh release upload ios-0.1.0 "$DEST" --repo "$REPO" --clobber
cp -f "$IPA" "$WORK/HardlyTracking_${WANT}_unsigned.ipa"
gh release upload "v$WANT" "$WORK/HardlyTracking_${WANT}_unsigned.ipa" --repo "$REPO" --clobber
ls -l "$DEST"
echo "IPA: $DEST"