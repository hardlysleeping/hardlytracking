# The on-device runtime (iOS)

The standalone iPhone requirement: airplane mode, open the app, keep reading — with Mihon/Komikku
extension APKs the phone installed itself, no server, no Suwayomi, no desktop, no LAN.

```
WKWebView (the app, unchanged)
      │  fetch → CapacitorHttp → native URLSession
      ▼
http://127.0.0.1:8747/dalvik            ← the same protocol the desktop host speaks
      │
MihonRuntime.mm  (ObjC++, in this process)
      │  JNI
      ▼
OpenJDKRuntime.framework (OpenJDK Zero, interpreter-only — iOS forbids JIT)
      │  mextensionserver.EmbeddedBridge
      ▼
MExtensionServer.jar  → runs the APK's Dalvik bytecode
```

Nothing above `DalvikClient` knows the host is local. `src/lib/mihon-runtime.ts` is the only place
that knows a native runtime exists, and it answers `null` on every build that has none.

## What is in the tree, and what is not

| Path | What it is |
|---|---|
| `plugins/mihon-runtime/ios/Classes/MihonRuntime.{h,mm}` | **ours**: the JNI host. Dedicated 8 MiB thread, `dlopen` with `RTLD_GLOBAL`, the VM options this runtime needs, the four bridge calls |
| `plugins/mihon-runtime/ios/Classes/MihonRuntimePlugin.swift` | **ours**: the Capacitor plugin (`MihonRuntime`) and the background/resume lifecycle |
| `plugins/mihon-runtime/ios/PrepareEmbeddedRuntime.sh` | **ours**: downloads the pinned JVM + server jar, checks SHA-256, links the device slice, assembles the Java home |
| `plugins/mihon-runtime/ios/RuntimeSources/` | **ours**: framework `Info.plist`, exports shim, simulator stub, two `java.util.logging` stubs |
| `plugins/mihon-runtime/ios/Frameworks/`, `Runtime/` | **not committed** (git-ignored): built by the script, hundreds of megabytes |
| `MExtensionServer.jar` | **not ours**: M-Extension-Server, MPL-2.0, release `ios-runtime-v9` |
| `OpenJDK.xcframework` + `java_bundle-device.zip` | **not ours**: OpenJDK Zero build, release `embedded-openjdk-ios13-v16` |

Licences and why nothing upstream was copied are in `plugins/mihon-runtime/ios/THIRD_PARTY_NOTICES.md`. The
upstream ObjC++ bridge lives in a Flutter plugin whose repository has no licence file, so it was not
vendored; the host here was written against the server's published entry point
(`mextensionserver.EmbeddedBridge`) and the JVM's JNI interface.

## Why the constraints are not preferences

- **The plugin is a local npm package, not only a pod.** `cap sync` builds the app's
  `packageClassList` by scanning the iOS source of every package in `package.json`; a pod alone
  compiles into the app and is **never registered**, which presents as "the runtime does not start"
  with nothing in the log. The workflow asserts the class is in that list before it archives.
- **One thread, 8 MiB stack.** The Zero interpreter splits the current native stack between the Java
  operand stack and native frames, and the server's own threads inherit from whoever created the VM.
  A dispatch worker dies during `java.lang` bootstrap.
- **`RTLD_GLOBAL`.** The static Zero build resolves its module image and JDK natives through
  `dlsym(RTLD_DEFAULT, …)`. A private handle is not enough, and a missing export must be reported
  before a VM exists rather than as a crash inside it.
- **No signal handlers.** HotSpot owns SIGSEGV/SIGBUS on this build; an app-level handler turns a
  recoverable VM signal into a termination.
- **A trust store from the bundle.** There is no system CA store to point at; the Java home shipped
  with the runtime carries `cacerts`.
- **Device arch only.** `EXCLUDED_ARCHS[sdk=iphonesimulator*]`, and the simulator slice is a stub that
  answers "a simulator cannot host this". Simulator results never count in the release matrix.

## Building it

There is no iOS SDK on the Linux workstation: `pod install` and `xcodebuild` run on the macOS runner.

```
gh workflow run ios-ipa.yml --ref master      # the only build path
```

The workflow installs a JDK (the logging shim needs `javac`), runs `pod install` — which triggers
`prepare_command` and the ~hundreds-of-megabyte download + link — archives unsigned, then **verifies
the runtime is inside the app** before packing the IPA:

- `App.app/Frameworks/OpenJDKRuntime.framework/OpenJDKRuntime` (and its `lib/lib/modules`)
- `MExtensionServer.jar` + `java-logging-shim.jar` in the runtime resource bundle

A framework that is linked but not embedded, or a jar no resource bundle copied, produces an app that
launches and then cannot open a single source — which is why the check is on bytes, not on the log.

## What is still unproven

The on-device half of the gate (`/capabilities` answers on a physical iPhone, a real extension
browses) needs the owner's phone, and the release matrix rows EXT/SRC/HTTP/WEB/OFF/BAK/UPD stay red
until it runs. The build half — an unsigned IPA that carries the runtime — is what CI proves.
