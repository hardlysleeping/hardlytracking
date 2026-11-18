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

## 3. The IPA is a separate run, but it publishes itself

`ios-ipa.yml` is `workflow_dispatch` only, because macOS minutes are not free. It uploads the IPA to
**both** the stable `ios-0.1.0` download and the release for the version it just built, so a tag plus
one dispatch produces a downloadable IPA with no hand step:

    gh workflow run ios-ipa.yml --ref v0.7.16 -f ref=v0.7.16

The upload is a build step (`gh release upload … --clobber`) and it verifies itself by asking the
releases API for the asset size, so a silent failure fails the run. It used to be manual: 0.5.1
shipped with no IPA at all, 0.5.2 and 0.5.3 were fixed up by hand, and 0.7.13–0.7.15 each needed it
too. Keep a copy locally as well, because `~/IPA/HardlyTracking-unsigned.ipa` is what gets sideloaded:

    gh run download <run-id> -n HardlyTracking-unsigned-ipa -D /tmp/ipa
    cp /tmp/ipa/HardlyTracking-unsigned.ipa ~/IPA/HardlyTracking-unsigned.ipa

`scripts/ipa.sh` does the dispatch, the watch and the copy in one command. Check the version and build
inside the bundle — unpacking `Payload/App.app/Info.plist` is enough:

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
