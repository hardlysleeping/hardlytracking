# Third-party code in the iOS build

The iOS shell runs Mihon/Komikku extension APKs on-device. Two public artefacts make that possible;
neither is committed to this repository — `PrepareEmbeddedRuntime.sh` downloads them, verifies their
SHA-256, and the pod embeds the result in the app.

| Artefact | Source | Licence |
|---|---|---|
| `MExtensionServer.jar` | [kodjodevf/M-Extension-Server](https://github.com/kodjodevf/M-Extension-Server) release `ios-runtime-v11` | Mozilla Public License 2.0 |
| `OpenJDK.xcframework` + `java_bundle-device.zip` | [1Selxo/Mangatan](https://github.com/1Selxo/Mangatan) release `embedded-openjdk-ios13-v16` | GPL-2.0 with the Classpath Exception (OpenJDK) |

The ObjC++ bridge, the pod, the build script, the framework's `Info.plist`, the exports shim and the
`java.util.logging` stubs in `RuntimeSources/` are this project's own code. They were written against
the server's published entry point (`mextensionserver.EmbeddedBridge`, MPL-2.0) and the JVM's JNI
interface; no third-party source was copied into them.

The extension APKs themselves are installed by the user from repositories the user adds. Nothing in
this directory ships an extension, a source, or a catalogue.

MPL-2.0 requires the source of the MPL-covered files to be available: it is, at the upstream
repository and in the release the jar was built from. GPL-2.0+CE obligations for OpenJDK are met by
the same upstream publication of its source.
