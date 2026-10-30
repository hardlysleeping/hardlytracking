// The static Zero library registers its JNI natives through an internal `loadfunctions` entry
// point. With -all_load it is linked into the framework but not exported from it, so this shim
// re-exports it under the name the bridge looks up before it creates a VM.

extern "C" void loadfunctions(void);

extern "C" __attribute__((visibility("default"))) void MExtensionServerOpenJDKLoadFunctions(void) {
  loadfunctions();
}
