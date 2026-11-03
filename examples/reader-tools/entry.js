/*
 * Reader Tools — the example plugin, and the acceptance test for the whole plugin system.
 *
 * It uses four things and nothing else: the host's read-only library call, its own storage, one UI
 * dialog, and one registered menu action. Everything it does is something a plugin author will do
 * first, so it is the smallest honest proof that the host, the bridge and the permissions work.
 */
ht.actions.registerSeriesAction({
  id: "show-info",
  title: "Show Extra Info",
  callback() {
    void run();
  },
});

async function run() {
  const seriesId = globalThis.__seriesId;
  const series = seriesId ? await ht.library.getSeries(seriesId) : null;
  const last = await ht.storage.get("last-question");
  await ht.storage.set("last-question", { at: Date.now() });
  if (series === null) {
    await ht.ui.toast("No series in view.");
    return;
  }
  const answered = await ht.ui.confirm(
    `${series.title} — ${series.readCount}/${series.chapterCount} chapters read` +
      (last ? ` (last asked ${new Date(last.at).toLocaleTimeString()})` : ""),
  );
  await ht.ui.toast(answered ? "Kept." : "Nothing to keep.");
  await ht.ui.openPanel("extra-info");
}

ht.events.on("library.opened", () => {
  /* A plugin may listen; nothing happens until the host pushes the event. */
});
