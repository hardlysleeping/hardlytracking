# The Android shell

HardlyTracking's phone build is the same Svelte app in a Capacitor WebView — `capacitor.config.ts`
plus the generated `android/` project — published as a signed, universal APK on the release page:

```
HardlyTracking_<version>_android.apk     # package ing.hardlysleep.hardlytracking, minSdk 23, targetSdk 35
```

`android/` is a normal Capacitor Android project (`npx cap add android` created it), so it is edited
through `android/app/build.gradle`, the manifest and `res/` — not hand-maintained Java, except where
noted below.

There is no Android emulator or device on the workstation, so an APK here is proven by its bytes
(`aapt2 dump badging`, `apksigner verify --print-certs`, the web assets inside the zip), not by a
launch. On-device behaviour is unproven until he installs one.

## Version, and why it comes from package.json

`android/app/build.gradle` reads `package.json` and stamps both fields:

- `versionName` = the semver in `package.json` (`0.7.3`)
- `versionCode` = `major*10000 + minor*100 + patch` (`703`)

Android refuses an update whose `versionCode` is not higher than the installed one, so this keeps the
phone build honest with the desktop installers and the IPA without a fifth file to bump. A manual
`versionCode` in gradle is how an update silently refuses to install.

## Signing

The keystore is the app's identity: an APK only installs over an existing one signed with the same
key, so losing it means every install must be uninstalled first. It lives **outside the repo** and is
never committed (`*.jks`, `*.keystore`, `keystore.properties` are in `android/.gitignore`).

| Where | What |
| --- | --- |
| `~/.android-keys/hardlytracking-release.jks` | the key (RSA 4096, alias `hardlytracking`, 10 000 days) |
| `~/.android-keys/hardlytracking.properties` | store/key password and path — the source of truth locally |
| `android/keystore.properties` | a git-ignored copy in the shape gradle reads |
| repository secrets | `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEYSTORE_ALIAS`, `ANDROID_KEYSTORE_KEY_PASSWORD` |

`build.gradle` reads the path and passwords from environment variables first
(`ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEYSTORE_ALIAS`,
`ANDROID_KEYSTORE_KEY_PASSWORD`) and falls back to `android/keystore.properties`. With neither, the
release build still compiles but comes out unsigned — installable nowhere, which is why CI refuses to
upload anything `apksigner` cannot verify.

Back the `.jks` up somewhere that is not this machine. There is no recovery.

## Build it locally

JDK **21** is required: Capacitor 7's Android plugins are compiled against a 21 toolchain and JDK 17
fails with `Cannot find a Java installation … {languageVersion=21}`. Temurin 21 lives at
`~/.local/java/jdk-21.0.13+9` (17 stays for other work).

```bash
cd ~/apps/hardlytracking
npm run build && npx cap sync android
export JAVA_HOME=$HOME/.local/java/jdk-21.0.13+9
export ANDROID_HOME=$HOME/Android/sdk
export ANDROID_KEYSTORE_PATH=$HOME/.android-keys/hardlytracking-release.jks
export ANDROID_KEYSTORE_ALIAS=hardlytracking
export ANDROID_KEYSTORE_PASSWORD=$(grep -oP '(?<=storePassword=).*' ~/.android-keys/hardlytracking.properties)
cd android && ./gradlew assembleRelease --no-daemon
```

Output: `android/app/build/outputs/apk/release/app-release.apk` (~4 MB — the APK carries the web
bundle, not a JVM; extensions come from a paired PC or the built-in archive source).

Prove it without a device:

```bash
BT=$ANDROID_HOME/build-tools/37.0.0
$BT/aapt2 dump badging app-release.apk | head -4
$BT/apksigner verify --print-certs app-release.apk | head -3
unzip -l app-release.apk | grep assets/public/index.html
adb install -r app-release.apk      # with a device attached
```

A debug-signed APK and this release-signed one cannot replace each other: `adb uninstall
ing.hardlysleep.hardlytracking` first when switching.

## CI

`.github/workflows/android-apk.yml` runs on a `v*` tag (attaches the APK to the release) and on
`workflow_dispatch` (artifact only). It runs `npm ci`, `npm run build`, `npx cap sync android`, decodes
the keystore from secrets into `$RUNNER_TEMP`, builds `assembleRelease`, then refuses to proceed unless
`aapt2` reports the package and the `package.json` version, `apksigner` proves the signature, and the
APK contains `assets/public/index.html`.

To cut an APK for the current version without a new tag:

```bash
gh workflow run android-apk.yml --ref master
gh run watch $(gh run list --workflow=android-apk.yml -L1 --json databaseId -q '.[0].databaseId')
gh release upload vX.Y.Z HardlyTracking_X.Y.Z_android.apk --clobber
```

## Shell details that are not Capacitor defaults

- `android.allowMixedContent` in `capacitor.config.ts` and `android:usesCleartextTraffic="true"` in the
  manifest: a phone pairs with a PC over plain http on a LAN/tailnet address, and the WebView's own
  origin is `https://localhost`, so without both the request is refused as mixed content.
- `AppTheme.NoActionBar` sets `android:windowBackground` to black; a dark app on a light window
  flashes white on every launch.
- Launcher icons and splash screens are generated from the iOS `AppIcon-512@2x.png`
  (`res/mipmap-*/ic_launcher*.png`, `res/drawable*/splash.png`), and the adaptive-icon XMLs were
  removed so the full-bleed square artwork is used as-is.
