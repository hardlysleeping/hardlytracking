package ing.hardlysleep.hardlytracking;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.util.Base64;

import androidx.documentfile.provider.DocumentFile;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.InputStream;
import java.util.Locale;

/**
 * Another app's download folder, read where it lies.
 *
 * `FolderPickerPlugin` answers "add these comics to *my* library" and copies every file into the
 * app's cache, because a copy is what our own library needs. This plugin answers a different
 * question — "what is already in Mihon's download folder?" — and therefore copies nothing:
 * `DocumentFile` handles are all it hands back, and bytes are read one chapter or one page at a
 * time on demand.
 *
 * The tree is the layout Mihon writes: `<root>/<manga title>/<chapter>/001.jpg…` (or a
 * `<chapter>.cbz` file when the user turned on "save as CBZ"). This plugin does not interpret those
 * names; it lists what is there and leaves naming to `src/lib/files/mihon-downloads.ts`, where it can
 * be tested without a device.
 *
 * The picked tree is remembered with a persisted URI grant, so the choice survives a relaunch. Only
 * a read grant is taken, and nothing here ever writes or deletes: another app owns that tree.
 */
@CapacitorPlugin(name = "DownloadsFolder")
public class DownloadsFolderPlugin extends Plugin {

    private static final String PREFS = "hardlytracking.downloads";
    private static final String KEY_URI = "tree";

    @PluginMethod
    public void saved(PluginCall call) {
        String uri = prefs().getString(KEY_URI, null);
        JSObject answer = new JSObject();
        if (uri == null) {
            answer.put("folder", org.json.JSONObject.NULL);
            call.resolve(answer);
            return;
        }
        DocumentFile root = DocumentFile.fromTreeUri(getContext(), Uri.parse(uri));
        if (root == null || !root.exists() || !root.canRead()) {
            prefs().edit().remove(KEY_URI).apply();
            answer.put("folder", org.json.JSONObject.NULL);
            call.resolve(answer);
            return;
        }
        answer.put("folder", describe(root));
        call.resolve(answer);
    }

    @PluginMethod
    public void pick(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "picked");
    }

    @ActivityCallback
    private void picked(PluginCall call, androidx.activity.result.ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != android.app.Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.reject("no folder was chosen");
            return;
        }
        Uri uri = result.getData().getData();
        try {
            getContext().getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (SecurityException ignored) {
            // Some providers hand back a grant that cannot be persisted; the tree still works now.
        }
        prefs().edit().putString(KEY_URI, uri.toString()).apply();
        DocumentFile root = DocumentFile.fromTreeUri(getContext(), uri);
        if (root == null) {
            call.reject("that folder cannot be read");
            return;
        }
        JSObject answer = new JSObject();
        answer.put("folder", describe(root));
        call.resolve(answer);
    }

    @PluginMethod
    public void forget(PluginCall call) {
        prefs().edit().remove(KEY_URI).apply();
        call.resolve();
    }

    /**
     * The folder, one level at a time: series folders, and each one's chapter folders or files.
     *
     * One level rather than a full recursive walk: a Mihon downloads tree is thousands of documents,
     * and a scan that reads every page name up front takes seconds on a phone. Chapter pages are
     * listed by `chapter`, when something is actually opened.
     */
    @PluginMethod
    public void scan(PluginCall call) {
        DocumentFile root = root();
        if (root == null) {
            call.reject("no download folder has been chosen");
            return;
        }
        JSArray series = new JSArray();
        for (DocumentFile entry : root.listFiles()) {
            if (!entry.isDirectory() || !entry.canRead()) continue;
            if (isIgnored(entry.getName())) continue;
            JSObject row = new JSObject();
            row.put("title", entry.getName() == null ? "" : entry.getName());
            row.put("path", entry.getUri().toString());
            JSArray chapters = new JSArray();
            for (DocumentFile child : entry.listFiles()) {
                if (!child.canRead()) continue;
                String name = child.getName();
                if (name == null || isIgnored(name)) continue;
                boolean folder = child.isDirectory();
                String ext = extensionOf(name);
                if (!folder && !isChapterFile(ext)) continue;
                if (folder && isEmptyFolder(child)) continue;
                JSObject chapter = new JSObject();
                chapter.put("name", folder ? name : stripExtension(name));
                chapter.put("path", child.getUri().toString());
                chapter.put("kind", folder ? "folder" : "file");
                if (!folder) {
                    chapter.put("ext", ext);
                    chapter.put("bytes", child.length());
                }
                chapters.put(chapter);
            }
            if (chapters.length() == 0) continue;
            row.put("chapters", chapters);
            series.put(row);
        }
        JSObject answer = new JSObject();
        answer.put("folder", describe(root));
        answer.put("series", series);
        call.resolve(answer);
    }

    /** One chapter folder's page documents, in name order — the folder's own listing, no copy. */
    @PluginMethod
    public void chapter(PluginCall call) {
        DocumentFile folder = document(call);
        if (folder == null) {
            call.reject("that chapter is not readable");
            return;
        }
        if (!folder.isDirectory()) {
            call.reject("not a chapter folder: " + folder.getName());
            return;
        }
        JSArray pages = new JSArray();
        for (DocumentFile page : folder.listFiles()) {
            String name = page.getName();
            if (name == null || !page.isFile() || !isImage(extensionOf(name))) continue;
            JSObject row = new JSObject();
            row.put("name", name);
            row.put("path", page.getUri().toString());
            pages.put(row);
        }
        JSObject answer = new JSObject();
        answer.put("pages", pages);
        call.resolve(answer);
    }

    /** One document's bytes, base64 — a page, or a chapter's CBZ. */
    @PluginMethod
    public void file(PluginCall call) {
        DocumentFile document = document(call);
        if (document == null || !document.isFile()) {
            call.reject("that file is not readable");
            return;
        }
        try (InputStream in = getContext().getContentResolver().openInputStream(document.getUri())) {
            if (in == null) {
                call.reject("could not open " + document.getName());
                return;
            }
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
            JSObject answer = new JSObject();
            answer.put("base64", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
            call.resolve(answer);
        } catch (Exception error) {
            call.reject("could not read " + document.getName() + ": " + error.getMessage());
        }
    }

    // ---- plumbing ----------------------------------------------------------------

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private DocumentFile root() {
        String uri = prefs().getString(KEY_URI, null);
        if (uri == null) return null;
        DocumentFile root = DocumentFile.fromTreeUri(getContext(), Uri.parse(uri));
        if (root == null || !root.canRead()) return null;
        return root;
    }

    private DocumentFile document(PluginCall call) {
        String path = call.getString("path");
        if (path == null || path.isEmpty()) return null;
        return DocumentFile.fromSingleUri(getContext(), Uri.parse(path));
    }

    private static JSObject describe(DocumentFile folder) {
        JSObject row = new JSObject();
        row.put("path", folder.getUri().toString());
        row.put("name", folder.getName() == null ? "" : folder.getName());
        return row;
    }

    /** A folder Mihon leaves behind for its own bookkeeping: never a chapter. */
    private static boolean isIgnored(String name) {
        String lower = name.toLowerCase(Locale.US);
        return name.startsWith(".") || lower.equals(".nomedia") || lower.equals("covers");
    }

    /** A directory with no readable child is not a chapter — Mihon leaves empty ones behind. */
    private static boolean isEmptyFolder(DocumentFile folder) {
        for (DocumentFile child : folder.listFiles()) {
            if (child.isFile()) return false;
        }
        return true;
    }

    private static String extensionOf(String name) {
        int dot = name.lastIndexOf('.');
        return dot < 0 ? "" : name.substring(dot + 1).toLowerCase(Locale.US);
    }

    private static String stripExtension(String name) {
        int dot = name.lastIndexOf('.');
        return dot <= 0 ? name : name.substring(0, dot);
    }

    private static boolean isChapterFile(String ext) {
        return ext.equals("cbz") || ext.equals("cbr") || ext.equals("zip") || ext.equals("pdf");
    }

    private static boolean isImage(String ext) {
        switch (ext) {
            case "jpg":
            case "jpeg":
            case "png":
            case "webp":
            case "gif":
            case "avif":
            case "heic":
            case "bmp":
                return true;
            default:
                return false;
        }
    }
}
