// Isolated keep-offline panel: memory categories, no library rows, no downloads.
import { mount } from "svelte";
import "../../src/app.css";
import KeepOfflinePanel from "../../src/components/KeepOfflinePanel.svelte";
import { categories } from "../../src/state/categories.svelte";
import { settings } from "../../src/state/settings.svelte";
import { downloads } from "../../src/state/downloads.svelte";

const written: Array<{ key: string; value: unknown }> = [];
settings.store = { setPref: async (key: string, value: unknown) => written.push({ key, value }), getPref: async () => undefined } as never;
settings.set = ((key: string, value: unknown) => {
  (settings as unknown as Record<string, unknown>)[key] = value;
  void settings.store?.setPref(`settings.${key}`, value);
}) as never;

categories.items = [
  { id: "fixture-a", name: "Fixture category A", hidden: false, pinned: false, order: 0 },
  { id: "fixture-b", name: "Fixture category B", hidden: false, pinned: false, order: 1 },
] as never;

// The keep pass itself is not run here: it would fetch. Counting the call proves the button is wired.
let calls = 0;
downloads.keepLibraryOffline = async () => {
  calls += 1;
  return { queued: 3, titles: 1 };
};

(window as unknown as { keep: unknown }).keep = {
  written,
  calls: () => calls,
  settings,
  categories,
};

mount(KeepOfflinePanel, { target: document.querySelector("#qa") as HTMLElement });
