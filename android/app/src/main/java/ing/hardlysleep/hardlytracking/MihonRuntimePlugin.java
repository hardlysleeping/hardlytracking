package ing.hardlysleep.hardlytracking;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The `MihonRuntime` plugin the web app already asks for.
 *
 * `src/lib/mihon-runtime.ts` calls `status()`/`start({port})` on every Capacitor build and treats a
 * loopback base as "this device runs extensions itself". On iOS that plugin starts an embedded JVM;
 * here it starts the loopback `/dalvik` host, which is all Android needs because ART runs the
 * extension dex natively.
 */
@CapacitorPlugin(name = "MihonRuntime")
public class MihonRuntimePlugin extends Plugin {

    private DalvikServer server() {
        return DalvikServer.get(getContext());
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject answer = new JSObject();
        answer.put("running", server().running());
        answer.put("port", server().port());
        call.resolve(answer);
    }

    @PluginMethod
    public void start(PluginCall call) {
        int wanted = call.getInt("port", 8747);
        try {
            int bound = server().start(wanted);
            JSObject answer = new JSObject();
            answer.put("port", bound);
            call.resolve(answer);
        } catch (Exception error) {
            call.reject("could not start the extension host: " + error.getMessage());
        }
    }

    @PluginMethod
    public void pause(PluginCall call) {
        // A phone does not need the server up while the app is in the background, but stopping it
        // would throw away every loaded extension; leaving it bound is the cheaper answer.
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        server().stop();
        call.resolve();
    }
}
