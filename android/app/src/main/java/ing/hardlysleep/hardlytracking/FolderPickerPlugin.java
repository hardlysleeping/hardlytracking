package ing.hardlysleep.hardlytracking;

import android.content.Intent;
import android.net.Uri;
import androidx.documentfile.provider.DocumentFile;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Locale;

/**
 * Pick a folder on Android and hand the app its comics.
 *
 * `<input type="file" webkitdirectory>` is a desktop Chrome feature: on Android the same attribute
 * opens an ordinary file picker with no way to choose a directory, which is what "Add folder does
 * nothing" was. Android's own answer is the Storage Access Framework, and that is all this is: open
 * `ACTION_OPEN_DOCUMENT_TREE`, walk the tree with `DocumentFile`, copy every comic into our cache and
 * answer with `{name, path}` pairs — a path under our own cache, which `Filesystem.readFile` can read
 * without any further permission.
 */
@CapacitorPlugin(name = "FolderPicker")
public class FolderPickerPlugin extends Plugin {

    private static final String[] EXTENSIONS = {".cbz", ".cbr", ".zip", ".pdf"};

    @PluginMethod
    public void pick(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "pickedFolder");
    }

    @ActivityCallback
    private void pickedFolder(PluginCall call, androidx.activity.result.ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != android.app.Activity.RESULT_OK || result.getData() == null
                || result.getData().getData() == null) {
            call.reject("No folder was chosen.");
            return;
        }
        Uri tree = result.getData().getData();
        try {
            getContext().getContentResolver().takePersistableUriPermission(
                    tree, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (SecurityException ignored) {
            // A provider that will not persist still serves this one read.
        }
        DocumentFile root = DocumentFile.fromTreeUri(getContext(), tree);
        if (root == null) {
            call.reject("That folder could not be opened.");
            return;
        }
        JSArray files = new JSArray();
        try {
            walk(root, "", files);
        } catch (Exception error) {
            call.reject(error.getMessage());
            return;
        }
        JSObject answer = new JSObject();
        answer.put("files", files);
        call.resolve(answer);
    }

    /** Depth-first, copying each comic into the cache so its bytes have a real path. */
    private void walk(DocumentFile dir, String prefix, JSArray out) throws Exception {
        for (DocumentFile child : dir.listFiles()) {
            String name = child.getName() == null ? "unnamed" : child.getName();
            if (child.isDirectory()) {
                walk(child, prefix + name + "/", out);
                continue;
            }
            if (!isComic(name)) continue;
            String relative = prefix + name;
            File target = new File(getContext().getCacheDir(), "import/" + relative);
            File parent = target.getParentFile();
            if (parent != null && !parent.exists() && !parent.mkdirs()) {
                throw new Exception("Could not make room for " + relative);
            }
            try (InputStream in = getContext().getContentResolver().openInputStream(child.getUri());
                 OutputStream stream = new FileOutputStream(target)) {
                if (in == null) continue;
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = in.read(buffer)) > 0) stream.write(buffer, 0, read);
            }
            JSObject row = new JSObject();
            // The relative path is what identifies the book: two files called `vol 1.cbz` in two
            // subfolders are two books, which is the same rule the folder input uses.
            row.put("name", relative);
            row.put("path", target.getAbsolutePath());
            out.put(row);
        }
    }

    private boolean isComic(String name) {
        String lower = name.toLowerCase(Locale.ROOT);
        for (String extension : EXTENSIONS) if (lower.endsWith(extension)) return true;
        return false;
    }
}
