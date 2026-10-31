/**
 * The startup service: the unit file, the installer, and the promise that it starts on its own.
 *
 *   node --experimental-strip-types --import ./register-ts.mjs service-unit.test.mjs
 *
 * A unit that is *almost* right fails in the least visible way possible: it installs, it reports
 * enabled, and then either points at a directory that does not exist, dies on its first restart, or
 * never starts at boot because lingering is off. None of that shows up until the machine reboots,
 * which is the worst time to find out. So the files are read and the invariants asserted:
 *
 *   1. the unit runs the server that is actually in this repo, from this repo's root;
 *   2. it restarts whatever happens, including a clean exit;
 *   3. the env file is optional — a machine with no overrides still starts;
 *   4. it is installed as a *user* service under default.target, which is what makes
 *      `systemctl --user enable` mean "at login", and what `loginctl enable-linger` turns into
 *      "at boot";
 *   5. the installer has every verb the README names, and rewrites the checkout path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const unit = readFileSync(join(ROOT, "deploy", "hardlytracking.service"), "utf8");
const installer = readFileSync(join(ROOT, "scripts", "service.sh"), "utf8");

/** The value of a key in a systemd section, or null. */
function setting(section, key) {
  const start = unit.indexOf(`[${section}]`);
  assert.notEqual(start, -1, `[${section}] must exist`);
  const body = unit.slice(start + section.length + 2);
  const end = body.indexOf("\n[");
  const scope = end === -1 ? body : body.slice(0, end);
  const line = scope.split("\n").find((row) => row.trim().startsWith(`${key}=`));
  return line === undefined ? null : line.trim().slice(key.length + 1);
}

test("the unit runs this repo's server, from this repo", () => {
  const exec = setting("Service", "ExecStart");
  assert.ok(exec, "ExecStart is required");
  const script = exec.split(/\s+/).pop();
  assert.ok(existsSync(join(ROOT, script)), `${script} must exist in the checkout`);
  assert.match(script, /^server\/proxy\.mjs$/, "the server is server/proxy.mjs, not a build output");

  const workdir = setting("Service", "WorkingDirectory");
  assert.equal(workdir, "%h/apps/hardlytracking", "a placeholder the installer rewrites to the real checkout");
  assert.match(installer, /sed -e "s#%h\/apps\/hardlytracking#\$REPO#g"/, "the installer must rewrite it");
});

test("a server, not a job: it comes back from anything", () => {
  assert.equal(setting("Service", "Restart"), "always");
  const delay = Number(setting("Service", "RestartSec"));
  assert.ok(delay > 0 && delay <= 10, `RestartSec must be a short positive number, got ${delay}`);
  assert.equal(setting("Service", "Type"), "simple");
});

test("a machine with no env file still starts", () => {
  const envFile = setting("Service", "EnvironmentFile");
  assert.ok(envFile, "EnvironmentFile is how HOST, PORT, RUNTIME_URL and the token get in");
  assert.ok(envFile.startsWith("-"), "the leading '-' makes a missing env file non-fatal");
  assert.match(envFile, /%h\/\.config\/hardlytracking\/env$/);
});

test("installed as a user service, which is what enable and linger act on", () => {
  assert.equal(setting("Install", "WantedBy"), "default.target");
  assert.match(installer, /systemctl --user enable "\$UNIT_NAME"/);
  assert.match(installer, /systemctl --user disable --now "\$UNIT_NAME"/, "uninstall stops it too");
  assert.match(installer, /loginctl enable-linger/, "boot without a login needs lingering, and the script says so");
});

test("the installer builds what the server serves, and reports what it did", () => {
  assert.match(installer, /dist\/index\.html/, "it must not install a unit that serves nothing");
  assert.match(installer, /npm run build/);
  for (const verb of ["install", "uninstall", "restart", "status", "logs"]) {
    assert.match(installer, new RegExp(`^\\s*${verb}\\)`, "m"), `missing the ${verb} verb`);
  }
});

test("the README tells a reader how to turn it on", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  assert.match(readme, /scripts\/service\.sh install/, "the command must be in the README");
});
