/*
 * A probe, not a plugin anyone should install: it records what the host answers so a live check can
 * read the other end of the bridge out of IndexedDB. Every call here is a permitted one; the refusals
 * are proven by the unit suite (`plugins-bridge.test.mjs`, `plugins-install.test.mjs`).
 */
(async () => {
  const result = {};
  try {
    await ht.storage.set("boot", { startedAt: Date.now() });
    result.storage = "ok";
  } catch (error) {
    result.storage = String(error);
  }
  try {
    const rows = await ht.library.query({ limit: 3 });
    result.library = { count: rows.length, first: rows[0] ? rows[0].title : null };
    await ht.storage.set("library", result.library);
  } catch (error) {
    result.library = String(error);
  }
  try {
    const ready = await fetch("https://example.com/").then(() => "REACHED THE NETWORK").catch((error) => "blocked: " + error.name);
    result.network = ready;
  } catch (error) {
    result.network = "blocked: " + String(error);
  }
  try {
    result.parent = typeof parent.document;
  } catch (error) {
    result.parent = "blocked: " + error.name;
  }
  await ht.storage.set("probe", result);
})();
