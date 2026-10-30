#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * The on-device extension runtime, as the iOS shell calls it.
 *
 * Every function is asynchronous and answers on the runtime's own worker thread: loading the JVM and
 * creating the VM take seconds, and the Zero interpreter needs a thread with a JVM-sized stack, so
 * none of this may run on the UI thread or on a dispatch worker.
 *
 * A completion carries an `NSError` with a human sentence when something failed — a missing runtime
 * file, a framework that would not load, a VM that refused to start, a bridge entry point that is
 * gone. The app shows that sentence instead of a blank shelf.
 */
typedef void (^MihonRuntimeStartCompletion)(int32_t port, NSError *_Nullable error);
typedef void (^MihonRuntimeCompletion)(NSError *_Nullable error);
typedef void (^MihonRuntimeStatusCompletion)(BOOL running, NSError *_Nullable error);

/** Start the loopback server, creating the VM on first use. Answers with the port it bound. */
FOUNDATION_EXPORT void MihonRuntimeStart(int32_t port, MihonRuntimeStartCompletion completion);

/** Stop serving but keep the VM loaded, for the app going to the background. */
FOUNDATION_EXPORT void MihonRuntimePause(MihonRuntimeCompletion completion);

/** Stop serving. The VM stays loaded for the life of the process; only a relaunch unloads it. */
FOUNDATION_EXPORT void MihonRuntimeStop(MihonRuntimeCompletion completion);

FOUNDATION_EXPORT void MihonRuntimeIsRunning(MihonRuntimeStatusCompletion completion);

NS_ASSUME_NONNULL_END
