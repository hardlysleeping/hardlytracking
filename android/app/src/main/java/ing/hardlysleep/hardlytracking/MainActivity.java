package ing.hardlysleep.hardlytracking;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Before super: a plugin registered after the bridge is built is not in the bridge.
        registerPlugin(MihonRuntimePlugin.class);
        registerPlugin(FolderPickerPlugin.class);
        registerPlugin(DeviceExtensionsPlugin.class);
        registerPlugin(DownloadsFolderPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
