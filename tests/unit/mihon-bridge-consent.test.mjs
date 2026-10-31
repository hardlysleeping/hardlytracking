import { test } from "node:test";
import assert from "node:assert/strict";

import { loginSource } from "../../src/api/mihon-bridge.ts";
import { grantConsent } from "../../src/lib/webview/consent.ts";

/** A webview that records whether it was ever opened. */
function fakeDriver(setCookie = ["session=abc; Path=/; Domain=example.com"]) {
  const opened = [];
  return {
    opened,
    driver: {
      platform: "tauri",
      async open(page) {
        opened.push(page.url);
        return { setCookie, url: page.url };
      },
    },
  };
}

function fakeJar() {
  const rows = new Map();
  return {
    rows,
    jar: {
      async header(host) {
        const value = [...rows.values()].map((c) => `${c.name}=${c.value}`).join("; ");
        return value === "" ? undefined : value;
      },
      async remember(host, setCookie) {
        for (const raw of setCookie) {
          const [name, ...rest] = raw.split("=");
          rows.set(`${host}|${name}`, { name, value: rest.join("=").split(";")[0], domain: host });
        }
        return rows.size;
      },
      async list() {
        return [...rows.values()];
      },
      async clear() {
        rows.clear();
      },
    },
  };
}

const extensions = [
  { extensionId: "ext-1", sources: [{ id: "42", name: "Example", baseUrl: "https://example.com" }] },
];

function deps(overrides = {}) {
  const { driver, opened } = fakeDriver();
  const { jar, rows } = fakeJar();
  return {
    opened,
    rows,
    jar,
    deps: {
      client: { call: async () => ({}) },
      extensions,
      jar,
      driver,
      verify: async () => {},
      ...overrides,
    },
  };
}

test("a source that has not been allowed cookies is asked about, and nothing opens", async () => {
  const { deps: d, opened, rows } = deps({ consent: { isGranted: () => false, grant: () => {} } });
  const result = await loginSource({ sourceId: "42", baseUrl: "https://example.com" }, d);

  assert.equal(result.status, "consent");
  assert.equal(result.host, "example.com");
  assert.equal(result.question, "Allow this source to use cookies for example.com?");
  assert.deepEqual(opened, [], "the login page must not open before the answer");
  assert.equal(rows.size, 0, "and no cookie may be stored");
});

test("the grant is asked for by source and domain, not for the app as a whole", async () => {
  const asked = [];
  const { deps: d, opened } = deps({
    consent: {
      isGranted: (sourceId, domain) => {
        asked.push([sourceId, domain]);
        return false;
      },
      grant: () => {},
    },
  });
  await loginSource({ sourceId: "42", baseUrl: "https://example.com" }, d);
  assert.deepEqual(asked, [["42", "example.com"]]);
  assert.deepEqual(opened, []);
});

test("once granted, the page opens, cookies are kept and the login is proven", async () => {
  let grants = [];
  const { deps: d, opened, rows } = deps({
    consent: {
      isGranted: (sourceId, domain) =>
        grants.some((g) => g.sourceId === sourceId && g.domain === domain),
      grant: (sourceId, domain) => {
        grants = grantConsent(grants, sourceId, domain, 1);
      },
    },
  });

  const asked = await loginSource({ sourceId: "42", baseUrl: "https://example.com" }, d);
  assert.equal(asked.status, "consent");

  await d.consent.grant(asked.sourceId, asked.host);
  const result = await loginSource({ sourceId: "42", baseUrl: "https://example.com" }, d);

  assert.equal(result.status, "ok");
  assert.equal(opened.length, 1);
  assert.equal(rows.size, 1, "the cookie the page set is in the jar");
  assert.match(await d.jar.header("example.com"), /session=abc/);
});

test("a build with no gate still logs in — the parameter is the seam, not the rule", async () => {
  const { deps: d, opened } = deps();
  const result = await loginSource({ sourceId: "42", baseUrl: "https://example.com" }, d);
  assert.equal(result.status, "ok");
  assert.equal(opened.length, 1);
});
