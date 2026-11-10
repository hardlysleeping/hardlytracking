package ing.hardlysleep.hardlytracking;

import android.content.Context;
import android.util.Log;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Enumeration;
import java.util.List;

import dalvik.system.DexClassLoader;
import dalvik.system.DexFile;
import eu.kanade.tachiyomi.source.Source;

/**
 * Installs an extension APK and reads the sources it declares.
 *
 * The APK is ordinary Android code, so the only unusual thing here is that it was not installed by
 * the system: we keep the bytes under `files/extensions/<sha256>.apk` and load them with a
 * `DexClassLoader` whose parent is the app's own loader (an extension is compiled `compileOnly`
 * against the API this app carries, so those classes resolve from the host).
 *
 * The class name is not declared anywhere we can rely on, so the dex is enumerated and every class
 * that implements `Source` with a no-arg constructor is one source. That is the same rule Mihon's
 * own loader applies, and it is why the extension API has to be a real dependency of this app
 * rather than a set of reflection stubs.
 */
public final class ExtensionSourceLoader {
    private static final String TAG = "HardlyTracking";

    private ExtensionSourceLoader() {
    }

    /** One source, in the shape the bridge's `sourcesManga` answer uses. */
    public static final class SourceRow {
        public final String id;
        public final String name;
        public final String lang;
        public final String baseUrl;

        SourceRow(String id, String name, String lang, String baseUrl) {
            this.id = id;
            this.name = name;
            this.lang = lang;
            this.baseUrl = baseUrl;
        }

        JSONObject toJson() throws Exception {
            return new JSONObject()
                    .put("id", id)
                    .put("name", name)
                    .put("lang", lang)
                    .put("baseUrl", baseUrl == null ? JSONObject.NULL : baseUrl);
        }
    }

    /** Where installed APKs live. One file per sha256, so installing twice is one file. */
    public static File store(Context context) {
        File dir = new File(context.getFilesDir(), "extensions");
        if (!dir.exists() && !dir.mkdirs()) Log.w(TAG, "could not create " + dir);
        return dir;
    }

    /** Write the APK (base64) under its hash and answer the sources it declares. */
    public static List<SourceRow> install(Context context, String base64) throws Exception {
        byte[] bytes = Base64.getDecoder().decode(base64);
        File apk = new File(store(context), sha256(bytes) + ".apk");
        try (FileOutputStream out = new FileOutputStream(apk)) {
            out.write(bytes);
        }
        return sourcesIn(context, apk);
    }

    /** Every installed APK's sources, in install order. A broken APK is skipped, not fatal. */
    public static List<SourceRow> listInstalled(Context context) {
        List<SourceRow> rows = new ArrayList<>();
        File[] files = store(context).listFiles((dir, name) -> name.endsWith(".apk"));
        if (files == null) return rows;
        for (File apk : files) {
            try {
                rows.addAll(sourcesIn(context, apk));
            } catch (Exception error) {
                Log.w(TAG, "extension " + apk.getName() + ": " + error.getMessage());
            }
        }
        return rows;
    }

    /** Load one APK and instantiate every `Source` it declares. */
    private static List<SourceRow> sourcesIn(Context context, File apk) throws Exception {
        List<SourceRow> rows = new ArrayList<>();
        DexClassLoader loader = new DexClassLoader(
                apk.getAbsolutePath(),
                context.getCodeCacheDir().getAbsolutePath(),
                null,
                context.getClassLoader());
        DexFile dex = new DexFile(apk);
        try {
            Enumeration<String> entries = dex.entries();
            while (entries.hasMoreElements()) {
                String className = entries.nextElement();
                Class<?> found;
                try {
                    found = Class.forName(className, false, loader);
                } catch (Throwable ignored) {
                    continue;
                }
                if (!Source.class.isAssignableFrom(found) || found.isInterface()
                        || java.lang.reflect.Modifier.isAbstract(found.getModifiers())) {
                    continue;
                }
                try {
                    Source source = (Source) found.getDeclaredConstructor().newInstance();
                    rows.add(new SourceRow(
                            String.valueOf(source.getId()),
                            source.getName(),
                            source instanceof eu.kanade.tachiyomi.source.CatalogueSource
                                    ? ((eu.kanade.tachiyomi.source.CatalogueSource) source).getLang()
                                    : "",
                            null));
                } catch (Throwable error) {
                    // A source whose constructor needs something we do not provide is reported, not
                    // guessed at: the row is absent rather than a broken one on the shelf.
                    Log.w(TAG, className + " did not construct: " + error);
                }
            }
        } finally {
            dex.close();
        }
        return rows;
    }

    static String sha256(byte[] bytes) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        StringBuilder hex = new StringBuilder();
        for (byte b : digest.digest(bytes)) hex.append(String.format("%02x", b));
        return hex.toString();
    }
}
