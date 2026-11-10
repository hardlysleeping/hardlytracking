package ing.hardlysleep.hardlytracking;

import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;

/**
 * The extensions this *device* already has installed, so a library can reuse them instead of
 * downloading the same APKs again.
 *
 * Mihon, Tachiyomi and Komikku all install extensions as ordinary APKs with one package prefix
 * (`eu.kanade.tachiyomi.extension.<lang>.<name>`). Those packages are not private to the app that
 * installed them: `ApplicationInfo.sourceDir` is the base APK on `/data/app`, world-readable, so a
 * second app can hand those exact bytes to its own extension runtime. That is the whole feature —
 * one list call, one read call, and no re-download.
 *
 * Two deliberate limits:
 *
 * - **Nothing is written here.** The plugin reads the installed set and one APK's bytes; installing
 *   into our runtime stays with `DalvikServer`, exactly as it does for a repository download.
 * - **No signature check of our own.** The bytes are what the device already trusts (the extension
 *   is installed and running in the other app); re-verifying a signature we do not pin would only
 *   invent a reason to refuse a working extension.
 */
@CapacitorPlugin(name = "DeviceExtensions")
public class DeviceExtensionsPlugin extends Plugin {

    /** The one prefix Mihon-family extension packages share. */
    static final String PREFIX = "eu.kanade.tachiyomi.extension";

    /** Is this package an extension rather than some other app that happens to start similarly? */
    static boolean isExtension(String packageId) {
        return packageId != null
            && (packageId.equals(PREFIX) || packageId.startsWith(PREFIX + "."));
    }

    @PluginMethod
    public void list(PluginCall call) {
        PackageManager pm = getContext().getPackageManager();
        JSArray rows = new JSArray();
        for (ApplicationInfo info : pm.getInstalledApplications(0)) {
            if (!isExtension(info.packageName)) continue;
            String apk = info.sourceDir;
            if (apk == null || !new File(apk).canRead()) continue;
            try {
                PackageInfo pkg = pm.getPackageInfo(info.packageName, 0);
                JSObject row = new JSObject();
                row.put("packageId", info.packageName);
                row.put("versionName", pkg.versionName == null ? "" : pkg.versionName);
                row.put("versionCode", versionCode(pkg));
                rows.put(row);
            } catch (PackageManager.NameNotFoundException ignored) {
                // Uninstalled between the list and the read: it is simply not offered.
            }
        }
        JSObject answer = new JSObject();
        answer.put("extensions", rows);
        call.resolve(answer);
    }

    /** One APK's bytes, base64 — the same shape the runtime's install call takes. */
    @PluginMethod
    public void apk(PluginCall call) {
        String packageId = call.getString("packageId");
        if (!isExtension(packageId)) {
            call.reject("not an extension package: " + packageId);
            return;
        }
        try {
            ApplicationInfo info = getContext().getPackageManager().getApplicationInfo(packageId, 0);
            File file = new File(info.sourceDir);
            byte[] bytes = readAll(file);
            JSObject answer = new JSObject();
            answer.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP));
            call.resolve(answer);
        } catch (PackageManager.NameNotFoundException error) {
            call.reject("not installed: " + packageId);
        } catch (Exception error) {
            call.reject("could not read " + packageId + ": " + error.getMessage());
        }
    }

    private static long versionCode(PackageInfo pkg) {
        return Build.VERSION.SDK_INT >= 28 ? pkg.getLongVersionCode() : pkg.versionCode;
    }

    private static byte[] readAll(File file) throws Exception {
        try (InputStream in = new FileInputStream(file)) {
            byte[] buffer = new byte[8192];
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            int read;
            while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
            return out.toByteArray();
        }
    }
}
