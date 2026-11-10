package ing.hardlysleep.hardlytracking;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * The on-device extension host: the same `/dalvik` protocol M-Extension-Server serves on a desktop,
 * answered from inside the app.
 *
 * Why this exists at all: an Android app can run a Mihon extension APK natively — ART loads the dex,
 * exactly as Mihon and Komikku do — so the phone needs no JVM, no emulation and no second process
 * (that is the *iPhone's* problem, and the reason it embeds OpenJDK Zero). All this needs to be is a
 * loopback server speaking the protocol the app already talks, plus a class loader.
 *
 * Served routes, deliberately the same three the bridge documents:
 *   GET  /capabilities          -> what this host can do
 *   POST /dalvik                -> {"method": ..., ...} one call, one JSON answer
 *   GET  /stop                  -> stop serving
 *
 * This build answers `sourcesManga` (install an APK from base64, then list the sources it exposes);
 * every other method answers an explicit "not implemented in this build" error rather than an empty
 * result, because an empty list reads as "this source has nothing" and sends the reader hunting a
 * bug that is not there.
 */
public final class DalvikServer {
    private static final String TAG = "HardlyTracking";

    private static DalvikServer instance;

    private final Context context;
    private ServerSocket socket;
    private Thread thread;
    private volatile boolean running;

    private DalvikServer(Context context) {
        this.context = context.getApplicationContext();
    }

    public static synchronized DalvikServer get(Context context) {
        if (instance == null) instance = new DalvikServer(context);
        return instance;
    }

    public int port() {
        return socket != null && running ? socket.getLocalPort() : 0;
    }

    public boolean running() {
        return running;
    }

    /** Start (or reuse) the listener on the given port; answers the port actually bound. */
    public synchronized int start(int wanted) throws Exception {
        if (running && socket != null) return socket.getLocalPort();
        ServerSocket created = new ServerSocket(wanted, 8, InetAddress.getByName("127.0.0.1"));
        socket = created;
        running = true;
        thread = new Thread(() -> serve(created), "dalvik-host");
        thread.setDaemon(true);
        thread.start();
        return created.getLocalPort();
    }

    public synchronized void stop() {
        running = false;
        try {
            if (socket != null) socket.close();
        } catch (Exception ignored) {
        }
        socket = null;
    }

    private void serve(ServerSocket server) {
        while (running) {
            try (Socket client = server.accept()) {
                handle(client);
            } catch (Exception error) {
                if (!running) return;
                Log.w(TAG, "dalvik connection: " + error.getMessage());
            }
        }
    }

    private void handle(Socket client) throws Exception {
        BufferedInputStream input = new BufferedInputStream(client.getInputStream());
        String requestLine = readLine(input);
        if (requestLine == null || requestLine.isEmpty()) return;
        String[] parts = requestLine.split(" ");
        String method = parts[0];
        String path = parts.length > 1 ? parts[1] : "/";

        int length = 0;
        String header;
        while ((header = readLine(input)) != null && !header.isEmpty()) {
            int colon = header.indexOf(':');
            if (colon > 0 && header.substring(0, colon).trim().equalsIgnoreCase("content-length")) {
                length = Integer.parseInt(header.substring(colon + 1).trim());
            }
        }
        byte[] body = new byte[length];
        int read = 0;
        while (read < length) {
            int next = input.read(body, read, length - read);
            if (next < 0) break;
            read += next;
        }

        int status = 200;
        String answer;
        try {
            answer = route(method, path, new String(body, StandardCharsets.UTF_8));
        } catch (Exception error) {
            status = 500;
            answer = new JSONObject().put("error", String.valueOf(error.getMessage())).toString();
        }
        byte[] bytes = answer.getBytes(StandardCharsets.UTF_8);
        OutputStream out = client.getOutputStream();
        String head = "HTTP/1.1 " + status + (status == 200 ? " OK" : " Error") + "\r\n"
                + "content-type: application/json\r\n"
                + "content-length: " + bytes.length + "\r\n"
                + "connection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.UTF_8));
        out.write(bytes);
        out.flush();
    }

    private String route(String method, String path, String body) throws Exception {
        if (path.equals("/capabilities")) {
            return new JSONObject()
                    .put("mangayomiMihonBridge", 1)
                    .put("sourceFactory", true)
                    .put("preferenceCallbacks", false)
                    .put("imageProxy", false)
                    .put("videoProxy", false)
                    .put("youtubeResolver", false)
                    .put("extensionHandles", true)
                    .put("platform", "android")
                    .put("webviewBridge", false)
                    .toString();
        }
        if (path.startsWith("/stop")) {
            stop();
            return new JSONObject().put("stopped", true).toString();
        }
        if (!path.equals("/dalvik") || !method.equals("POST")) {
            throw new IllegalStateException("no route " + method + " " + path);
        }
        return call(new JSONObject(body));
    }

    /** One `/dalvik` call. Only the methods below are implemented; the rest refuse by name. */
    private String call(JSONObject body) throws Exception {
        String method = body.optString("method", "");
        switch (method) {
            case "sourcesManga":
                return sources(body);
            default:
                throw new IllegalStateException("method not implemented in this build: " + method);
        }
    }

    /**
     * `sourcesManga`: with `data` (an APK, base64) install it and answer its sources; without, answer
     * every installed APK's sources. The id is the SHA-256 of the bytes, which is the same rule the
     * desktop host uses, so ids stay stable across installs.
     */
    private String sources(JSONObject body) throws Exception {
        JSONArray out = new JSONArray();
        String data = body.optString("data", "");
        if (!data.isEmpty()) {
            for (ExtensionSourceLoader.SourceRow row : ExtensionSourceLoader.install(context, data)) {
                out.put(row.toJson());
            }
            return out.toString();
        }
        for (ExtensionSourceLoader.SourceRow row : ExtensionSourceLoader.listInstalled(context)) {
            out.put(row.toJson());
        }
        return out.toString();
    }

    /** One CRLF-terminated header line, or null at the end of the stream. */
    private static String readLine(InputStream input) throws Exception {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        int byteRead;
        while ((byteRead = input.read()) != -1) {
            if (byteRead == '\n') break;
            if (byteRead != '\r') buffer.write(byteRead);
        }
        if (byteRead == -1 && buffer.size() == 0) return null;
        return buffer.toString("UTF-8");
    }
}
