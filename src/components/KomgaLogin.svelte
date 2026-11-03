<script lang="ts">
  import ServerLogin from "./ServerLogin.svelte";
  import { clearKomga, komgaBaseUrl, komgaConfigured, probeKomga, setKomgaSettings } from "../lib/komga";
  let { onchange }: { onchange: () => Promise<void> } = $props();
</script>

<ServerLogin name="Komga" configured={komgaConfigured} savedAddress={komgaBaseUrl} probe={probeKomga} save={setKomgaSettings} logout={clearKomga} {onchange} />
