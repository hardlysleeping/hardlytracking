import Foundation
import Capacitor
import UIKit

/**
 The on-device extension runtime, as the web app calls it.

 The app asks `start` once, gets the loopback port back, and from then on every `/dalvik` call goes to
 `http://127.0.0.1:<port>` through CapacitorHttp. Nothing else in the web app knows this exists.

 Answers always come back on the main thread: the bridge does its work on a dedicated JVM thread, and
 a Capacitor call is not a safe thing to resolve from there.
 */
@objc(MihonRuntimePlugin)
public class MihonRuntimePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MihonRuntimePlugin"
    public let jsName = "MihonRuntime"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
    ]

    /// The port the server bound, once it has bound one.
    private var boundPort: Int32?

    override public func load() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(didEnterBackground),
            name: UIApplication.didEnterBackgroundNotification,
            object: nil)
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(didBecomeActive),
            name: UIApplication.didBecomeActiveNotification,
            object: nil)
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    /// Stop serving while the app is in the background. The VM stays loaded: recreating it would cost
    /// seconds and re-read the module image for nothing.
    @objc private func didEnterBackground() {
        guard boundPort != nil else { return }
        MihonRuntimePause { _ in }
    }

    /// Serve again on return, on the same port the app already points at.
    @objc private func didBecomeActive() {
        guard let port = boundPort else { return }
        MihonRuntimeStart(port) { _, _ in }
    }

    @objc func start(_ call: CAPPluginCall) {
        let requested = Int32(call.getInt("port") ?? 8747)
        guard requested > 0, requested <= 65535 else {
            call.reject("A port between 1 and 65535 is required.")
            return
        }
        MihonRuntimeStart(requested) { [weak self] port, error in
            DispatchQueue.main.async {
                if let error = error {
                    call.reject(error.localizedDescription)
                    return
                }
                self?.boundPort = port
                call.resolve(["port": Int(port)])
            }
        }
    }

    @objc func status(_ call: CAPPluginCall) {
        let known = boundPort ?? 0
        MihonRuntimeIsRunning { running, error in
            DispatchQueue.main.async {
                if let error = error {
                    call.reject(error.localizedDescription)
                    return
                }
                call.resolve(["running": running, "port": Int(known)])
            }
        }
    }

    @objc func pause(_ call: CAPPluginCall) {
        MihonRuntimePause { error in
            DispatchQueue.main.async {
                if let error = error {
                    call.reject(error.localizedDescription)
                    return
                }
                call.resolve()
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        MihonRuntimeStop { [weak self] error in
            DispatchQueue.main.async {
                if let error = error {
                    call.reject(error.localizedDescription)
                    return
                }
                self?.boundPort = nil
                call.resolve()
            }
        }
    }
}
