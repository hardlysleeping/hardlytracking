package java.util.logging;

/**
 * A logger that discards everything, patched onto the boot class path beside {@link Level}.
 *
 * The extension server logs startup detail and per-request noise. None of it is wanted on a phone,
 * and none of it may throw while the server starts.
 */
public final class Logger {

    private Logger() {}

    public static Logger getLogger(String name) {
        return new Logger();
    }

    public boolean isLoggable(Level level) {
        return false;
    }

    public void log(Level level, String message) {}

    public void log(Level level, String message, Throwable error) {}
}
