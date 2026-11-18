# Cutting a release

What actually has to happen, in order, from a clean `master`. Every step below was run for `v0.5.3`;
the numbers are from that release.

## 1. The version lives in three files

    package.json                       "version"
    src-tauri/tauri.conf.json          "version"          (the desktop installers)
    src-tauri/Cargo.toml               version            (the crate; the installers ignore it)
    ios/App/App.xcodeproj/project.pbxproj   MARKETING_VERSION, twice (Debug and Release)

`Cargo.toml` drifted to 0.5.1 while 0.5.4 shipped, because nothing builds from it directly — bump it
with the rest so `grep 0.5.` does not tell two stories.

`CFBundleVersion` is not among them: the IPA workflow sets the build number itself, which is why the
same release can be build 24, 25 or 26 while the marketing version stays put.

One commit, one annotated tag:

    git commit -m "0.5.3"
    git tag -a v0.5.3 -m "0.5.3: <one line about what is new>"
    git push origin master --follow-tags

## 2. The tag starts the desktop build, and the desktop build writes the release

`desktop.yml` runs on `push: tags: v*`. Its `release` job creates the release page if the tag has none,
uploads every installer it collected with `--clobber`, and then forces `--draft=false`. There is nothing
to publish by hand for Windows, Linux or macOS.

Two things that job will not do:

- **It does not run if any platform leg fails.** With `fail-fast: false` the other legs still finish,
  but `release` is skipped, so a partial release is never published. That is deliberate.
- **It publishes whatever the legs produced**, so a leg that was cancelled for reasons outside the build
  (see §5) leaves the release missing that platform rather than failing loudly.

## 3. Build the IPA on Codemagic, then attach it

**Codemagic is the iOS build service; `ios-ipa.yml` is the fallback.** The API token lives at
`~/.config/codemagic/token` (never printed) and the app is registered against this repo, so a tag needs
no GitHub macOS runner:

    TOKEN=$(cat ~/.config/codemagic/token)
    curl -sS -X POST https://api.codemagic.io/builds \
      -H "X-Auth-Token: $TOKEN" -H 'Content-Type: application/json' \
      --data '{"appId":"6aefa30ff9882de26d15662e","workflowId":"ios-unsigned","tag":"v0.7.16"}'

That returns a `buildId`; `GET https://api.codemagic.io/builds/<buildId>` gives the status, the commit
and the `artefacts[]` URL. The commit it reports is the **annotated tag object** (`git rev-parse
v0.7.16`), not the release commit — compare it with `git rev-parse 'v0.7.16^{}'` before believing the
right code was built. Codemagic's `mac_mini_m2` pool is what keeps this off GitHub's macOS queue, which
refused to hand out a runner four times in a row on 0.7.16 while Codemagic built the same tag.

Download needs the token **and** a cookie jar, or a bare `curl` saves a small `FORBIDDEN` JSON with an
`.ipa` name:

    curl -fL -b /tmp/cm.jar -c /tmp/cm.jar -H "X-Auth-Token: $TOKEN" '<artefact-url>' \
      -o /tmp/HardlyTracking-unsigned.ipa

Then attach it to both download slots, because the build service cannot write this repo's releases:

    gh release upload ios-0.1.0 /tmp/HardlyTracking-unsigned.ipa --clobber
    cp /tmp/HardlyTracking-unsigned.ipa "/tmp/HardlyTracking_${VERSION}_unsigned.ipa"
    gh release upload "v$VERSION" "/tmp/HardlyTracking_${VERSION}_unsigned.ipa" --clobber
    cp /tmp/HardlyTracking-unsigned.ipa ~/IPA/HardlyTracking-unsigned.ipa

`ios-ipa.yml` is the fallback: `workflow_dispatch` only, and it now uploads to the same two slots itself
(`gh release upload … --clobber`, then it asks the releases API for the asset size and compares it with
the file it built, so a silent upload failure fails the run). Use it when Codemagic itself is
unavailable, and say which one produced the artefact.

Check the version and build inside the bundle — unpacking `Payload/App.app/Info.plist` is enough:

    unzip -q -o ~/IPA/HardlyTracking-unsigned.ipa 'Payload/*.app/Info.plist' -d /tmp/check
    python3 -c "import plistlib,glob; d=plistlib.load(open(glob.glob('/tmp/check/Payload/*.app/Info.plist')[0],'rb')); print(d['CFBundleShortVersionString'], d['CFBundleVersion'])"

## 4. Verify anonymously, then say so

A release nobody can download is not a release, and `gh` is authenticated, so it proves nothing:

    curl -s -o /dev/null -L -w '%{http_code} %{size_download}\n' \
      https://github.com/hardlysleeping/hardlytracking/releases/download/v0.5.3/HardlyTracking_0.5.3_unsigned.ipa

Expect `200` and the full byte count (58,889,203 for 0.5.3). The repo is public, so no auth is needed
and none should be used.

## 5. macOS legs can be cancelled without failing

On 0.5.3 both macOS jobs sat in the queue for fifteen minutes with **no runner assigned**
(`runner_name` empty in the jobs API) and were then cancelled, which skipped the `release` job and left
no release page at all. Nothing in the build was wrong — the log has no steps, only a cancellation.

The fix is a re-run, which picks up runners immediately:

    gh run rerun <run-id> --failed

Diagnose it with the jobs API rather than the console: `runner_name` empty plus
`started_at → completed_at` of exactly the queue window means "never scheduled", not "broke".

## 6. After the release

- `master == origin/master`, tree clean, all four gates green (`npm test`, `tsc --noEmit`,
  `svelte-check --threshold error`, `npm run build`).
- The IPA in `~/IPA/` is the same file that is on the release (compare `sha256sum`).
- Nothing in `docs/` claims a version that the tag does not have.
