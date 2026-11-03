/**
 * What the proxy tells the runtime the extension's user-agent is.
 *
 * The runtime applies `User-Agent` from a `/dalvik` call to the *extension's* HTTP client, so a
 * browser's own UA reaching it is not cosmetic: the extension then browses as Chrome, and a site
 * that blocks browser user-agents answers an HTML challenge page that the extension reads as JSON.
 * MangaDex did exactly that — `getPopularManga` answered `<!doctype html>`, the runtime surfaced a
 * Jackson "Unexpected JSON token" 500, and the source looked empty.
 *
 * So the rule is: a forwarded call carries **no** `user-agent` unless the app asked for one, and
 * then it carries exactly the app's, sent as `x-hardlytracking-user-agent` because a tab cannot set
 * `User-Agent` itself.
 *
 * A real proxy process against a recording stand-in for the runtime — not a source-text assertion,
 * because the thing that broke was a header on the wire.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";

const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const APP_UA = "Tachiyomi Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";

/** A runtime that records what it received, headers and body. */
async function recordingRuntime() {
  const seen = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({ url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}`, seen, close: () => new Promise((done) => server.close(done)) };
}

/**
 * The proxy, on a port of its own, pointed at that runtime.
 *
 * The port is drawn well above the developer's own services: the first version of this test drew
 * 8400–8799, which contains the real `:8460`. On a collision the proxy exits with `EADDRINUSE`, the
 * readiness loop gave up quietly, and the assertions either ran against the live app or against
 * nothing — a test that can pass by talking to the wrong process is worse than no test. Collisions
 * now fail loudly, with the child's stderr, and `stop()` waits for the process to be gone.
 */
async function startProxy(runtimeUrl) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const port = 18000 + Math.floor(Math.random() * 1000);
    const child = spawn(process.execPath, ["server/proxy.mjs"], {
      cwd: new URL("../..", import.meta.url).pathname,
      env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DALVIK_URL: runtimeUrl },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let tick = 0; tick < 100 && !ready; tick += 1) {
      if (child.exitCode !== null) break;
      ready = await fetch(`${base}/api/health`).then(
        (answer) => answer !== null,
        () => false,
      );
      if (!ready) await sleep(100);
    }
    if (ready) {
      return {
        base,
        stop: async () => {
          child.kill("SIGTERM");
          await Promise.race([once(child, "exit"), sleep(5000)]);
        },
      };
    }
    child.kill("SIGKILL");
    await Promise.race([once(child, "exit"), sleep(2000)]);
    if (!/EADDRINUSE/.test(stderr)) {
      throw new Error(`the proxy never answered on ${base}: ${stderr.trim().slice(0, 400)}`);
    }
  }
  throw new Error("no free port for the proxy after eight attempts");
}

test("the runtime never inherits the browser's user-agent", async () => {
  const runtime = await recordingRuntime();
  const proxy = await startProxy(runtime.baseUrl);
  try {
    const answer = await fetch(`${proxy.base}/api/dalvik/dalvik`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": BROWSER_UA },
      body: JSON.stringify({ method: "sourcesManga" }),
    });
    assert.equal(answer.status, 200);
    const call = runtime.seen.at(-1);
    assert.equal(call.url, "/dalvik");
    assert.equal(call.headers["user-agent"], undefined, "a forwarded browser UA makes the extension browse as Chrome");
    assert.equal(call.headers.host, new URL(runtime.baseUrl).host, "the runtime is addressed by its own host, not the proxy's port");
  } finally {
    await proxy.stop();
    await runtime.close();
  }
});

test("a user-agent the app means to send is the one that arrives", async () => {
  const runtime = await recordingRuntime();
  const proxy = await startProxy(runtime.baseUrl);
  try {
    await fetch(`${proxy.base}/api/dalvik/dalvik`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": BROWSER_UA,
        "x-hardlytracking-user-agent": APP_UA,
      },
      body: JSON.stringify({ method: "sourcesManga" }),
    });
    const call = runtime.seen.at(-1);
    assert.equal(call.headers["user-agent"], APP_UA);
    assert.equal(call.headers["x-hardlytracking-user-agent"], undefined, "the private header is plumbing, not a header the runtime sees");
  } finally {
    await proxy.stop();
    await runtime.close();
  }
});

test("the call body crosses the hop intact, and the app's own token does not", async () => {
  const runtime = await recordingRuntime();
  const proxy = await startProxy(runtime.baseUrl);
  const payload = JSON.stringify({ method: "getPopularManga", extensionId: "deadbeef", sourceId: "1", page: 2 });
  try {
    await fetch(`${proxy.base}/api/dalvik/dalvik`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hardlytracking-token": "lan-secret" },
      body: payload,
    });
    const call = runtime.seen.at(-1);
    // `node:http` does not set `content-length` for us (it is hop-by-hop here), so the body arrives
    // chunked — and a transport change that silently dropped the body would look like an empty
    // source, which is the bug this whole file exists for.
    assert.equal(call.body, payload);
    assert.equal(call.headers["x-hardlytracking-token"], undefined, "the LAN token is the app's secret, not the runtime's");
  } finally {
    await proxy.stop();
    await runtime.close();
  }
});
