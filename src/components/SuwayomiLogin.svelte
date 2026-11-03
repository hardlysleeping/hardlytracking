<script lang="ts">
  import ServerLogin from "./ServerLogin.svelte";
  import { clearSuwayomi, suwayomiBaseUrl, suwayomiConfigured, probeSuwayomi, setSuwayomiSettings } from "../lib/suwayomi";
  let { onchange }: { onchange: () => Promise<void> } = $props();
</script>

<ServerLogin name="Suwayomi" configured={suwayomiConfigured} savedAddress={suwayomiBaseUrl} probe={probeSuwayomi} save={setSuwayomiSettings} logout={clearSuwayomi} {onchange} requireCredentials={false} />
