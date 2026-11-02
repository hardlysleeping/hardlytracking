# Cutting a release

What actually has to happen, in order, from a clean `master`. Every step below was run for `v0.5.3`;
the numbers are from that release.

## 1. The version lives in three files

    package.json                       "version"
    src-tauri/tauri.conf.json          "version"          (the desktop installers)
    ios/App/App.xcodeproj/project.pbxproj   MARKETING_VERSION, twice (Debug and Release)

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

## 3. The IPA is a separate, manual step — twice over

`ios-ipa.yml` is `workflow_dispatch` only, because macOS minutes are not free, and it uploads an
**artifact**, never a release asset. A tag therefore does *not* produce a downloadable IPA:

    gh workflow run ios-ipa.yml --ref v0.5.3 -f ref=v0.5.3
    gh run download <run-id> -n HardlyTracking-unsigned-ipa -D /tmp/ipa
    cp /tmp/ipa/HardlyTracking-unsigned.ipa ~/IPA/HardlyTracking-unsigned.ipa
    gh release upload v0.5.3 /tmp/HardlyTracking_0.5.3_unsigned.ipa --clobber

0.5.1 shipped with no IPA on its release page for exactly this reason, and the IPA existed only as a CI
artifact that nobody would find; 0.5.2 and 0.5.3 were fixed up by hand. Check the version
and build inside the bundle before uploading — unpacking `Payload/App.app/Info.plist` is enough:

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
