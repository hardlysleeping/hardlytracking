/**
 * The bridge between the app and the JVM in its own process.
 *
 * This is the whole of the "standalone iPhone" requirement: no server, no Suwayomi, no desktop. The
 * app loads a framework containing an OpenJDK Zero interpreter (an interpreter-only JVM, because iOS
 * forbids JIT), creates a VM inside this process, and asks the server jar inside the app bundle to
 * serve the same `/dalvik` protocol it serves on a desktop. `DalvikClient` then talks to
 * `http://127.0.0.1:<port>` and nothing above it knows the difference.
 *
 * Three constraints shape this file, and none of them are preferences:
 *
 * 1. **The VM needs a big stack.** Zero splits the current native stack between its Java operand
 *    stack and C frames, and it creates the server's threads from whichever thread made the VM. A
 *    dispatch worker gets a few hundred KB, which dies during `java.lang` bootstrap, so everything
 *    here runs on one dedicated 8 MiB thread.
 * 2. **The framework must be loaded RTLD_GLOBAL.** The static Zero build resolves its own module
 *    image and JDK natives through `dlsym(RTLD_DEFAULT, …)`, so a plain `dlopen` handle is not enough
 *    and a missing export must be reported before a VM is created.
 * 3. **The VM owns SIGSEGV/SIGBUS.** Nothing here installs a signal handler; an app-level handler
 *    turns a recoverable VM signal into a crash.
 *
 * A failure never throws and never leaves the app without a library: the completion carries a
 * sentence the UI can show, and the app falls back to whatever other host it has.
 */
#import "MihonRuntime.h"

#import <TargetConditionals.h>

#if !TARGET_OS_SIMULATOR

#include <jni.h>
#include <dlfcn.h>
#include <os/lock.h>

#include <cstdio>
#include <string>
#include <vector>

static NSString *const MihonRuntimeErrorDomain = @"ing.hardlysleep.hardlytracking.mihon-runtime";

/** The one thread the VM is created on, and the only thread that may touch it. */
@interface MihonRuntimeWorker : NSThread
- (void)enqueue:(dispatch_block_t)block;
@end

@implementation MihonRuntimeWorker {
  NSCondition *_condition;
  NSMutableArray *_pending;
}

- (instancetype)init {
  self = [super init];
  if (self != nil) {
    _condition = [[NSCondition alloc] init];
    _pending = [[NSMutableArray alloc] init];
    self.name = @"ing.hardlysleep.hardlytracking.mihon-runtime";
    // Constraint 1 above: this stack is shared with the Java operand stack.
    self.stackSize = 8 * 1024 * 1024;
  }
  return self;
}

- (void)enqueue:(dispatch_block_t)block {
  [_condition lock];
  [_pending addObject:[block copy]];
  [_condition signal];
  [_condition unlock];
}

- (void)main {
  while (!self.cancelled) {
    dispatch_block_t block = nil;
    [_condition lock];
    while (_pending.count == 0 && !self.cancelled) {
      [_condition wait];
    }
    if (_pending.count > 0) {
      block = (dispatch_block_t)_pending.firstObject;
      [_pending removeObjectAtIndex:0];
    }
    [_condition unlock];
    if (block != nil) {
      @autoreleasepool {
        block();
      }
    }
  }
}

@end

namespace {

/** The server's published JNI entry point (MPL-2.0, M-Extension-Server). */
const char *const kBridgeClassName = "mextensionserver/EmbeddedBridge";

using LoadJvmFunctions = void (*)(void);
using CreateJavaVM = jint (*)(JavaVM **, void **, void *);

JavaVM *gVM = nullptr;
jclass gBridgeClass = nullptr;
jmethodID gStartMethod = nullptr;
jmethodID gPauseMethod = nullptr;
jmethodID gStopMethod = nullptr;
jmethodID gIsRunningMethod = nullptr;
void *gFramework = nullptr;
LoadJvmFunctions gLoadJvmFunctions = nullptr;
CreateJavaVM gCreateJavaVM = nullptr;
os_unfair_lock gVMLock = OS_UNFAIR_LOCK_INIT;

NSError *RuntimeError(NSInteger code, NSString *message) {
  return [NSError errorWithDomain:MihonRuntimeErrorDomain
                             code:code
                         userInfo:@{NSLocalizedDescriptionKey : message}];
}

void Trace(NSString *text) {
  fprintf(stderr, "[MihonRuntime] %s\n", text.UTF8String);
}

MihonRuntimeWorker *Worker(void) {
  static MihonRuntimeWorker *worker = nil;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    worker = [[MihonRuntimeWorker alloc] init];
    [worker start];
  });
  return worker;
}

/** `App.app/Frameworks/OpenJDKRuntime.framework/OpenJDKRuntime`. */
NSString *FrameworkBinaryPath(void) {
  NSString *frameworks = NSBundle.mainBundle.privateFrameworksPath;
  if (frameworks == nil) {
    frameworks = [NSBundle.mainBundle.bundlePath stringByAppendingPathComponent:@"Frameworks"];
  }
  NSString *framework = [frameworks stringByAppendingPathComponent:@"OpenJDKRuntime.framework"];
  return [framework stringByAppendingPathComponent:@"OpenJDKRuntime"];
}

/** The `-Djava.home` the VM is given: the framework's own `lib`, holding modules and security. */
NSString *JavaHomePath(void) {
  return [[FrameworkBinaryPath() stringByDeletingLastPathComponent] stringByAppendingPathComponent:@"lib"];
}

/** The pod's resource bundle: the server jar, the logging shim jar and `lib/security/cacerts`. */
NSString *RuntimeResourcesPath(void) {
  NSMutableArray<NSBundle *> *candidates = [NSMutableArray array];
  Class pluginClass = NSClassFromString(@"MihonRuntimePlugin");
  if (pluginClass != Nil) {
    NSBundle *host = [NSBundle bundleForClass:pluginClass];
    if (host != nil) [candidates addObject:host];
  }
  [candidates addObject:NSBundle.mainBundle];
  for (NSBundle *bundle in candidates) {
    NSString *path = [bundle pathForResource:@"MihonRuntime_runtime" ofType:@"bundle"];
    if (path != nil) {
      NSBundle *runtime = [NSBundle bundleWithPath:path];
      if (runtime != nil) return runtime.resourcePath;
      return path;
    }
  }
  return NSBundle.mainBundle.resourcePath;
}

/** Where the server keeps its own working state: `Library/Application Support/MihonExtensions`. */
NSString *ApplicationSupportDirectory(NSError **error) {
  NSFileManager *files = NSFileManager.defaultManager;
  NSURL *support = [files URLForDirectory:NSApplicationSupportDirectory
                                 inDomain:NSUserDomainMask
                        appropriateForURL:nil
                                   create:YES
                                    error:error];
  if (support == nil) return nil;
  NSURL *directory = [support URLByAppendingPathComponent:@"MihonExtensions" isDirectory:YES];
  if (![files createDirectoryAtURL:directory withIntermediateDirectories:YES attributes:nil error:error]) {
    return nil;
  }
  return directory.path;
}

/**
 * Everything the VM needs on disk, checked before a VM is created.
 *
 * A missing file here is a packaging bug, and the sentence names it: "the embedded Mihon runtime is
 * incomplete: … is missing" is far more useful on a phone than a JNI error code.
 */
BOOL VerifyRuntimeFiles(NSError **error) {
  NSFileManager *files = NSFileManager.defaultManager;
  NSString *resources = RuntimeResourcesPath();
  NSString *home = JavaHomePath();

  NSArray<NSString *> *required = @[
    [resources stringByAppendingPathComponent:@"MExtensionServer.jar"],
    [resources stringByAppendingPathComponent:@"java-logging-shim.jar"],
    [resources stringByAppendingPathComponent:@"lib/security/cacerts"],
    [home stringByAppendingPathComponent:@"lib/modules"],
    [home stringByAppendingPathComponent:@"conf/security/java.security"],
    [home stringByAppendingPathComponent:@"lib/tzdb.dat"],
  ];
  for (NSString *path in required) {
    if (![files fileExistsAtPath:path]) {
      if (error != nullptr) {
        NSString *name = [path stringByReplacingOccurrencesOfString:NSBundle.mainBundle.bundlePath withString:@""];
        *error = RuntimeError(1, [NSString stringWithFormat:@"The embedded Mihon runtime is incomplete: %@ is missing.", name]);
      }
      return NO;
    }
  }
  return YES;
}

/** Constraint 2: load the framework globally and prove the exports the VM resolves through it. */
BOOL LoadFramework(NSError **error) {
  if (gFramework != nullptr && gLoadJvmFunctions != nullptr && gCreateJavaVM != nullptr) return YES;

  NSString *binary = FrameworkBinaryPath();
  if (![NSFileManager.defaultManager fileExistsAtPath:binary]) {
    if (error != nullptr) {
      *error = RuntimeError(10, @"The on-device Mihon runtime framework is not in the app bundle.");
    }
    return NO;
  }

  dlerror();
  void *handle = dlopen(binary.UTF8String, RTLD_NOW | RTLD_GLOBAL);
  if (handle == nullptr) {
    const char *details = dlerror();
    if (error != nullptr) {
      *error = RuntimeError(11, [NSString stringWithFormat:@"The on-device Mihon runtime could not be loaded: %s",
                                                           details == nullptr ? "unknown loader error" : details]);
    }
    return NO;
  }

  const char *const requiredSymbols[] = {
      "JDK_Canonicalize",
      "JIMAGE_Open",
      "JIMAGE_Close",
      "JIMAGE_FindResource",
      "JIMAGE_GetResource",
      "VerifyClassForMajorVersion",
  };
  for (const char *symbol : requiredSymbols) {
    dlerror();
    if (dlsym(RTLD_DEFAULT, symbol) == nullptr) {
      if (error != nullptr) {
        *error = RuntimeError(12, [NSString stringWithFormat:@"The on-device Mihon runtime does not expose %s.", symbol]);
      }
      dlclose(handle);
      return NO;
    }
  }

  dlerror();
  LoadJvmFunctions loadJvmFunctions = (LoadJvmFunctions)dlsym(handle, "MExtensionServerOpenJDKLoadFunctions");
  const char *loadError = dlerror();
  dlerror();
  CreateJavaVM createJavaVM = (CreateJavaVM)dlsym(handle, "JNI_CreateJavaVM");
  const char *createError = dlerror();
  if (loadJvmFunctions == nullptr || createJavaVM == nullptr || loadError != nullptr || createError != nullptr) {
    if (error != nullptr) {
      *error = RuntimeError(13, @"The on-device Mihon runtime is missing its JNI entry points.");
    }
    dlclose(handle);
    return NO;
  }

  gFramework = handle;
  gLoadJvmFunctions = loadJvmFunctions;
  gCreateJavaVM = createJavaVM;
  return YES;
}

/** A pending Java exception as a sentence, cleared so the thread can keep working. */
NSString *ExceptionText(JNIEnv *environment, NSString *fallback) {
  jthrowable thrown = environment->ExceptionOccurred();
  if (thrown == nullptr) return fallback;
  environment->ExceptionClear();

  NSString *text = fallback;
  jclass throwable = environment->FindClass("java/lang/Throwable");
  if (throwable != nullptr) {
    jmethodID describe = environment->GetMethodID(throwable, "toString", "()Ljava/lang/String;");
    if (describe != nullptr) {
      jstring rendered = (jstring)environment->CallObjectMethod(thrown, describe);
      if (!environment->ExceptionCheck() && rendered != nullptr) {
        const char *utf8 = environment->GetStringUTFChars(rendered, nullptr);
        if (utf8 != nullptr) {
          text = [NSString stringWithUTF8String:utf8];
          environment->ReleaseStringUTFChars(rendered, utf8);
        }
        environment->DeleteLocalRef(rendered);
      } else {
        environment->ExceptionClear();
      }
    }
    environment->DeleteLocalRef(throwable);
  } else {
    environment->ExceptionClear();
  }
  environment->DeleteLocalRef(thrown);
  return text;
}

BOOL CacheEntryPoints(JNIEnv *environment, NSError **error) {
  jclass local = environment->FindClass(kBridgeClassName);
  if (local == nullptr) {
    if (error != nullptr) {
      *error = RuntimeError(2, ExceptionText(environment, @"The embedded Mihon bridge class could not be loaded."));
    }
    return NO;
  }
  gBridgeClass = (jclass)environment->NewGlobalRef(local);
  environment->DeleteLocalRef(local);
  if (gBridgeClass == nullptr) {
    if (error != nullptr) {
      *error = RuntimeError(3, @"The embedded Mihon bridge class could not be retained.");
    }
    return NO;
  }

  gStartMethod = environment->GetStaticMethodID(gBridgeClass, "start", "(ILjava/lang/String;)I");
  gPauseMethod = environment->GetStaticMethodID(gBridgeClass, "pause", "()V");
  gStopMethod = environment->GetStaticMethodID(gBridgeClass, "stop", "()V");
  gIsRunningMethod = environment->GetStaticMethodID(gBridgeClass, "isRunning", "()Z");
  if (gStartMethod == nullptr || gPauseMethod == nullptr || gStopMethod == nullptr || gIsRunningMethod == nullptr) {
    if (error != nullptr) {
      *error = RuntimeError(4, ExceptionText(environment, @"The embedded Mihon bridge entry points are invalid."));
    }
    return NO;
  }
  return YES;
}

/**
 * Create the VM once, or attach this worker to it.
 *
 * The options are not tunable knobs: each one is a requirement of running this server on Zero. The
 * class path is the server jar, the logging shim goes on the boot class path so it wins over the
 * module, `java.home` is the framework's own `lib`, the trust store is the one shipped in the bundle
 * (the system store does not exist here), and `-Xss8m` is the same stack reason as the worker.
 */
BOOL EnsureJavaVM(JNIEnv **environment, NSError **error) {
  os_unfair_lock_lock(&gVMLock);
  if (gVM != nullptr) {
    jint attached = gVM->AttachCurrentThread((void **)environment, nullptr);
    os_unfair_lock_unlock(&gVMLock);
    if (attached != JNI_OK) {
      if (error != nullptr) *error = RuntimeError(5, @"The embedded Java runtime could not attach its worker.");
      return NO;
    }
    return YES;
  }

  BOOL ready = VerifyRuntimeFiles(error) && LoadFramework(error);
  if (!ready) {
    os_unfair_lock_unlock(&gVMLock);
    return NO;
  }

  NSString *resources = RuntimeResourcesPath();
  NSString *home = JavaHomePath();
  NSString *applicationDirectory = ApplicationSupportDirectory(error);
  if (applicationDirectory == nil) {
    os_unfair_lock_unlock(&gVMLock);
    return NO;
  }
  NSString *temporaryDirectory = [NSTemporaryDirectory() stringByAppendingPathComponent:@"MihonExtensions"];
  if (![NSFileManager.defaultManager createDirectoryAtPath:temporaryDirectory
                               withIntermediateDirectories:YES
                                                attributes:nil
                                                     error:error]) {
    os_unfair_lock_unlock(&gVMLock);
    return NO;
  }

  std::vector<std::string> optionStrings = {
      std::string("-Djava.class.path=") + [resources stringByAppendingPathComponent:@"MExtensionServer.jar"].UTF8String,
      std::string("-Xbootclasspath/a:") + [resources stringByAppendingPathComponent:@"java-logging-shim.jar"].UTF8String,
      std::string("-Djava.home=") + home.UTF8String,
      std::string("-Djava.io.tmpdir=") + temporaryDirectory.UTF8String,
      std::string("-Duser.home=") + applicationDirectory.UTF8String,
      std::string("-Djavax.net.ssl.trustStore=") + [resources stringByAppendingPathComponent:@"lib/security/cacerts"].UTF8String,
      "-Djavax.net.ssl.trustStorePassword=changeit",
      "-Djava.awt.headless=true",
      "-Dfile.encoding=UTF-8",
      "-Djava.net.preferIPv4Stack=true",
      "-Dorg.slf4j.simpleLogger.defaultLogLevel=warn",
      "-XX:+UseSerialGC",
      "-Xms128m",
      "-Xmx512m",
      "-XX:NewSize=64m",
      "-XX:MaxNewSize=256m",
      "-Xss8m",
  };

  std::vector<JavaVMOption> options(optionStrings.size());
  for (size_t index = 0; index < optionStrings.size(); index++) {
    options[index].optionString = const_cast<char *>(optionStrings[index].c_str());
    options[index].extraInfo = nullptr;
  }

  JavaVMInitArgs arguments = {};
  arguments.version = JNI_VERSION_1_8;
  arguments.nOptions = (jint)options.size();
  arguments.options = options.data();
  arguments.ignoreUnrecognized = JNI_FALSE;

  Trace(@"creating the embedded Java VM");
  gLoadJvmFunctions();
  jint created = gCreateJavaVM(&gVM, (void **)environment, &arguments);
  if (created != JNI_OK || gVM == nullptr || *environment == nullptr) {
    gVM = nullptr;
    os_unfair_lock_unlock(&gVMLock);
    if (error != nullptr) {
      *error = RuntimeError(6, [NSString stringWithFormat:@"The embedded Java runtime could not start (JNI %d).", created]);
    }
    return NO;
  }

  BOOL cached = CacheEntryPoints(*environment, error);
  os_unfair_lock_unlock(&gVMLock);
  return cached;
}

void DetachWorker(void) {
  if (gVM != nullptr) gVM->DetachCurrentThread();
}

}  // namespace

void MihonRuntimeStart(int32_t port, MihonRuntimeStartCompletion completion) {
  [Worker() enqueue:^{
    @autoreleasepool {
      NSError *error = nil;
      JNIEnv *environment = nullptr;
      if (!EnsureJavaVM(&environment, &error)) {
        completion(0, error);
        return;
      }
      NSString *applicationDirectory = ApplicationSupportDirectory(&error);
      if (applicationDirectory == nil) {
        DetachWorker();
        completion(0, error);
        return;
      }
      jstring directory = environment->NewStringUTF(applicationDirectory.UTF8String);
      jint bound = environment->CallStaticIntMethod(gBridgeClass, gStartMethod, (jint)port, directory);
      if (environment->ExceptionCheck()) {
        NSError *failure = RuntimeError(7, ExceptionText(environment, @"The embedded Mihon server refused to start."));
        environment->DeleteLocalRef(directory);
        DetachWorker();
        completion(0, failure);
        return;
      }
      environment->DeleteLocalRef(directory);
      DetachWorker();
      if (bound <= 0) {
        completion(0, RuntimeError(8, @"The embedded Mihon server did not report a port."));
        return;
      }
      completion((int32_t)bound, nil);
    }
  }];
}

void MihonRuntimePause(MihonRuntimeCompletion completion) {
  [Worker() enqueue:^{
    @autoreleasepool {
      JNIEnv *environment = nullptr;
      NSError *error = nil;
      if (!EnsureJavaVM(&environment, &error)) {
        completion(error);
        return;
      }
      environment->CallStaticVoidMethod(gBridgeClass, gPauseMethod);
      NSError *failure = environment->ExceptionCheck()
                             ? RuntimeError(9, ExceptionText(environment, @"The embedded Mihon server could not pause."))
                             : nil;
      DetachWorker();
      completion(failure);
    }
  }];
}

void MihonRuntimeStop(MihonRuntimeCompletion completion) {
  [Worker() enqueue:^{
    @autoreleasepool {
      JNIEnv *environment = nullptr;
      NSError *error = nil;
      if (!EnsureJavaVM(&environment, &error)) {
        completion(error);
        return;
      }
      environment->CallStaticVoidMethod(gBridgeClass, gStopMethod);
      NSError *failure = environment->ExceptionCheck()
                             ? RuntimeError(10, ExceptionText(environment, @"The embedded Mihon server could not stop."))
                             : nil;
      DetachWorker();
      completion(failure);
    }
  }];
}

void MihonRuntimeIsRunning(MihonRuntimeStatusCompletion completion) {
  [Worker() enqueue:^{
    @autoreleasepool {
      // Before the VM exists the answer is simply "not running": asking must not pay for a JVM.
      if (gVM == nullptr) {
        completion(NO, nil);
        return;
      }
      JNIEnv *environment = nullptr;
      NSError *error = nil;
      if (!EnsureJavaVM(&environment, &error)) {
        completion(NO, error);
        return;
      }
      jboolean running = environment->CallStaticBooleanMethod(gBridgeClass, gIsRunningMethod);
      NSError *failure = environment->ExceptionCheck()
                             ? RuntimeError(11, ExceptionText(environment, @"The embedded Mihon server state could not be read."))
                             : nil;
      DetachWorker();
      completion(running == JNI_TRUE, failure);
    }
  }];
}

#else  // TARGET_OS_SIMULATOR

// The Zero interpreter is device-arch only, so there is nothing to start here. Saying so is the
// point: a simulator build must fail loudly, not pretend it has a runtime.
static NSError *MihonRuntimeSimulatorError(void) {
  return [NSError errorWithDomain:@"ing.hardlysleep.hardlytracking.mihon-runtime"
                             code:100
                         userInfo:@{
                           NSLocalizedDescriptionKey :
                               @"The embedded Mihon runtime is built for a device only; a simulator cannot host it."
                         }];
}

void MihonRuntimeStart(int32_t port, MihonRuntimeStartCompletion completion) {
  (void)port;
  completion(0, MihonRuntimeSimulatorError());
}

void MihonRuntimePause(MihonRuntimeCompletion completion) { completion(MihonRuntimeSimulatorError()); }

void MihonRuntimeStop(MihonRuntimeCompletion completion) { completion(MihonRuntimeSimulatorError()); }

void MihonRuntimeIsRunning(MihonRuntimeStatusCompletion completion) { completion(NO, MihonRuntimeSimulatorError()); }

#endif
