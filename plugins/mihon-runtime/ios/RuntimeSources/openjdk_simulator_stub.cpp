// Simulator slice of OpenJDKRuntime.
//
// The embedded OpenJDK Zero interpreter is device-architecture only, so there is nothing to run on a
// simulator. This stub exists so that the framework resolves in a simulator build and the app can
// answer "this device cannot host the runtime" instead of failing to link. No simulator run is ever
// counted as a pass in the release matrix.

extern "C" __attribute__((visibility("default"))) void MExtensionServerOpenJDKLoadFunctions(void) {}

extern "C" __attribute__((visibility("default"))) int JNI_CreateJavaVM(void **, void **, void *) {
  return -1;
}
