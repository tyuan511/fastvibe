import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import {
  TunnelRunner,
  authtokenInConfig,
  findExecutable,
  probeTunnelTools,
} from "../src/main/server/tunnel.ts";

/**
 * The tunnel runner, against stand-ins for the real binaries.
 *
 * Neither `cloudflared` nor `ngrok` can be a test dependency — they are third-party
 * downloads, one of them needs an account, and both talk to the internet — so what is
 * exercised here is everything above the process boundary: the patterns that find a URL
 * in each tool's output, the phases the pane renders, and the four ways a run can end.
 * The `launch` seam stands a Node script in for the binary, so the code under test is
 * the same code the app runs.
 *
 * The cases are chosen for what fails silently. A URL read out of the wrong line shows a
 * dead link next to a QR code that scans perfectly; a missed exit leaves 启动中… on
 * screen forever; a status written by a process that has already been replaced reports a
 * tunnel as broken while its successor is up.
 */

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** A fake binary: a Node script piped exactly as the real spawn pipes one. */
function script(source: string) {
  return () =>
    spawn(process.execPath, ["-e", source], { stdio: ["ignore", "pipe", "pipe"] });
}

/** Stay alive until signalled, the way a tunnel that is up does. */
const ALIVE = "setInterval(() => {}, 1000);";

/** The banner cloudflared prints around a quick tunnel's hostname, on stderr. */
const CLOUDFLARED_BANNER = `
process.stderr.write("2026-09-18T00:00:01Z INF Requesting new quick Tunnel on trycloudflare.com...\\n");
process.stderr.write("+--------------------------------------------------------+\\n");
process.stderr.write("|  Your quick Tunnel has been created! Visit it at:      |\\n");
process.stderr.write("|    https://fluffy-panda-rides-again.trycloudflare.com  |\\n");
process.stderr.write("+--------------------------------------------------------+\\n");
${ALIVE}
`;

/** What ngrok writes with `--log=stdout --log-format=json`. */
const NGROK_JSON = `
process.stdout.write(JSON.stringify({ lvl: "info", msg: "starting web service", addr: "http://localhost:4040" }) + "\\n");
process.stdout.write(JSON.stringify({ lvl: "info", msg: "started tunnel", name: "command_line", addr: "http://localhost:7777", url: "https://8f3a-203-0-113-7.ngrok-free.app" }) + "\\n");
${ALIVE}
`;

/**
 * ngrok with no authtoken, which is the failure most users meet first.
 *
 * The error's own text carries a URL — the dashboard page that issues the token — and
 * that is the trap: a pattern loose enough to accept a reserved domain reads *that*
 * link out of the failure and reports it as the tunnel.
 */
const NGROK_NO_TOKEN = `
process.stdout.write(JSON.stringify({
  lvl: "eror",
  msg: "authentication failed",
  err: "The authtoken you specified is properly formed, but it is invalid. Sign up at https://dashboard.ngrok.com/get-started/your-authtoken to get one. ERR_NGROK_4018",
}) + "\\n");
setTimeout(() => process.exit(1), 30);
`;

/**
 * A runner whose binary is a script and whose credential is assumed present.
 *
 * Both halves have to be stubbed together. Leaving the credential real would have these
 * cases pass or fail on whether the machine running them happens to have an ngrok
 * authtoken, and the refusal path is tested explicitly below instead.
 */
function runner(source: string, startTimeoutMs = 4_000): TunnelRunner {
  return new TunnelRunner({
    log: silent,
    startTimeoutMs,
    launch: script(source),
    credential: () => true,
  });
}

/** Poll until `check` holds, so an `exit` that lands after `start()` can be observed. */
async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((settle) => setTimeout(settle, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

test("cloudflared's quick-tunnel hostname is read out of its banner", async () => {
  const tunnel = runner(CLOUDFLARED_BANNER);
  try {
    const status = await tunnel.start("cloudflared", 7777);
    assert.equal(status.phase, "online");
    assert.equal(status.url, "https://fluffy-panda-rides-again.trycloudflare.com");
    assert.equal(status.error, null);
    assert.equal(status.provider, "cloudflared");
  } finally {
    await tunnel.stop();
  }
});

test("ngrok's url comes from the named field, not from any https in the line", async () => {
  const tunnel = runner(NGROK_JSON);
  try {
    const status = await tunnel.start("ngrok", 7777);
    assert.equal(status.phase, "online");
    assert.equal(status.url, "https://8f3a-203-0-113-7.ngrok-free.app");
  } finally {
    await tunnel.stop();
  }
});

test("a rejected authtoken is flagged as such, with ngrok's own words kept alongside", async () => {
  const tunnel = runner(NGROK_NO_TOKEN);
  const status = await tunnel.start("ngrok", 7777);
  assert.equal(status.phase, "error");
  // The dashboard link in the error text must not have been mistaken for the tunnel.
  assert.equal(status.url, null);
  // The flag is what the pane switches on: it is the one failure with a single command
  // that fixes it, so it gets that command rather than a sentence to interpret.
  assert.equal(status.needsAuth, true);
  assert.match(status.error ?? "", /authtoken/);
  // And the tool's own words survive: ERR_NGROK_4018 and the signup link are in here,
  // and neither is something the app could have written.
  assert.match(status.output.join("\n"), /ERR_NGROK_4018/);
});

test("the refusal ends the run at once, instead of waiting out the start timeout", async () => {
  /*
   * The shape that made this necessary: ngrok with no authtoken does **not** exit. It
   * logs the refusal and drops into a reconnect loop, so the run used to sit in
   * 启动中… for the whole timeout and then blame the clock, with the real reason
   * buried in the output. A four-second timeout against a process that never dies is
   * what proves the stream is what ended it.
   */
  const tunnel = runner(`${NGROK_NO_TOKEN.replace("setTimeout(() => process.exit(1), 30);", "")}\n${ALIVE}`, 4_000);
  const began = Date.now();
  const status = await tunnel.start("ngrok", 7777);
  const took = Date.now() - began;
  assert.equal(status.phase, "error");
  assert.equal(status.needsAuth, true);
  assert.ok(took < 2_000, `should fail on the log line, not the timeout (took ${took}ms)`);
  // And the process it gave up on is gone, rather than reconnecting behind a pane that
  // has already shown the answer.
  const after = await tunnel.stop();
  assert.equal(after.phase, "off");
});

test("no credential on this machine is refused before anything is spawned", async () => {
  let spawned = false;
  const tunnel = new TunnelRunner({
    log: silent,
    startTimeoutMs: 500,
    credential: () => false,
    launch: () => {
      spawned = true;
      throw new Error("must not reach the binary");
    },
  });
  const status = await tunnel.start("ngrok", 7777);
  assert.equal(spawned, false, "the point is to not start a process that cannot work");
  assert.equal(status.phase, "error");
  assert.equal(status.needsAuth, true);
});

test("a credential check that cannot tell does not block the run", async () => {
  // `null` means the question was unanswerable — an unreadable config file, say. That is
  // not evidence the user has not set anything up, and refusing on it would lock people
  // out of a tunnel that works.
  const tunnel = new TunnelRunner({
    log: silent,
    startTimeoutMs: 4_000,
    credential: () => null,
    launch: script(NGROK_JSON),
  });
  try {
    const status = await tunnel.start("ngrok", 7777);
    assert.equal(status.phase, "online");
    assert.equal(status.needsAuth, false);
  } finally {
    await tunnel.stop();
  }
});

test("cloudflared is never asked for a credential it does not need", async () => {
  // A quick tunnel needs no account, so the provider declares no credential at all and
  // a `false` answer has nothing to apply to.
  const tunnel = new TunnelRunner({
    log: silent,
    startTimeoutMs: 4_000,
    credential: () => false,
    launch: script(CLOUDFLARED_BANNER),
  });
  try {
    const status = await tunnel.start("cloudflared", 7777);
    assert.equal(status.phase, "online");
  } finally {
    await tunnel.stop();
  }
});

test("an authtoken is read out of either config layout, and an empty key is not one", () => {
  // v2, and what an upgraded install still carries.
  assert.equal(authtokenInConfig("authtoken: 2abcDEF_realtoken\n"), true);
  // v3's nested form.
  assert.equal(authtokenInConfig('version: "3"\nagent:\n    authtoken: 2abcDEF\n'), true);
  // What a half-finished `ngrok config edit` leaves: the key with nothing after it.
  assert.equal(authtokenInConfig("version: 3\nagent:\n  authtoken:\n"), false);
  assert.equal(authtokenInConfig('version: "3"\nregion: us\n'), false);
  // Not a token: the word appearing inside some other value.
  assert.equal(authtokenInConfig("# run ngrok config add-authtoken <token>\n"), false);
});

test("NGROK_AUTHTOKEN alone counts as configured", async () => {
  // The env var overrides the config file in the agent itself, so a machine with no
  // config at all is still set up — and the pane must not tell that user to run a
  // command they do not need.
  const before = process.env.NGROK_AUTHTOKEN;
  process.env.NGROK_AUTHTOKEN = "2abcDEF_from_the_environment";
  try {
    const tools = await probeTunnelTools();
    assert.equal(tools.ngrok.authenticated, true);
    // Cloudflare never needs one, which is `null` rather than `false`: the question does
    // not apply, and `false` would put a credential block on screen for it.
    assert.equal(tools.cloudflared.authenticated, null);
  } finally {
    if (before === undefined) delete process.env.NGROK_AUTHTOKEN;
    else process.env.NGROK_AUTHTOKEN = before;
  }
});

test("a tool that prints nothing fails with the timeout rather than hanging on 启动中", async () => {
  const tunnel = runner(ALIVE, 300);
  const status = await tunnel.start("cloudflared", 7777);
  assert.equal(status.phase, "error");
  assert.equal(status.url, null);
  assert.match(status.error ?? "", /没有返回公网地址/);
  // The reason is the timeout alone. The kill it provokes must not overwrite it with a
  // second sentence about a signal, which is the whole point of retiring the run first.
  assert.doesNotMatch(status.error ?? "", /信号|退出码/);
});

test("a tunnel that dies after coming up says so, instead of leaving a dead url up", async () => {
  const tunnel = runner(`${CLOUDFLARED_BANNER}\nsetTimeout(() => process.exit(7), 40);`);
  const online = await tunnel.start("cloudflared", 7777);
  assert.equal(online.phase, "online");
  await waitFor(() => tunnel.status.phase === "error", "the exit to be noticed");
  assert.match(tunnel.status.error ?? "", /隧道已断开/);
  assert.equal(tunnel.status.url, null);
});

test("stopping ends the run, and the kill it causes is not reported as a failure", async () => {
  const tunnel = runner(CLOUDFLARED_BANNER);
  await tunnel.start("cloudflared", 7777);
  const status = await tunnel.stop();
  assert.equal(status.phase, "off");
  assert.equal(status.url, null);
  assert.equal(status.error, null);
  // The child's `exit` arrives after `stop()` has already settled; a run that is over
  // must not be able to write an error over the state the user is looking at.
  await new Promise((settle) => setTimeout(settle, 80));
  assert.equal(tunnel.status.phase, "off");
  assert.equal(tunnel.status.error, null);
});

test("restarting does not let the old process report over the new one", async () => {
  const tunnel = runner(CLOUDFLARED_BANNER);
  try {
    await tunnel.start("cloudflared", 7777);
    const second = await tunnel.start("cloudflared", 7777);
    assert.equal(second.phase, "online");
    await new Promise((settle) => setTimeout(settle, 80));
    assert.equal(tunnel.status.phase, "online");
    assert.equal(tunnel.status.error, null);
  } finally {
    await tunnel.stop();
  }
});

test("a binary that is not installed is a sentence, not a crash", async () => {
  // No `launch` override: this is the real spawn path, against a name nothing has.
  const tunnel = new TunnelRunner({ log: silent, startTimeoutMs: 500 });
  const status = await tunnel.start("cloudflared", 7777);
  assert.equal(status.phase, "error");
  assert.match(status.error ?? "", /cloudflared/);
});

test("PATH is searched the way a shell searches it", () => {
  const dir = mkdtempSync(join(tmpdir(), "fastvibe-tunnel-"));
  const file = join(dir, "cloudflared");
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
  const env = { PATH: `${join(dir, "nope")}${delimiter}${dir}` };
  assert.equal(findExecutable("cloudflared", env, "darwin"), file);
  assert.equal(findExecutable("ngrok", env, "darwin"), null);
  // An empty PATH is the GUI-launch case before `applyShellPath` has run, and has to be
  // an answer rather than a throw.
  assert.equal(findExecutable("cloudflared", {}, "darwin"), null);
});

test("on Windows the name on PATH carries an extension", () => {
  const dir = mkdtempSync(join(tmpdir(), "fastvibe-tunnel-win-"));
  const file = join(dir, "cloudflared.exe");
  writeFileSync(file, "binary");
  const env = { Path: dir, PATHEXT: ".COM;.EXE;.CMD" };
  // Compared folded, because PATHEXT is upper case and the extension is tried exactly as
  // it is written there. Windows' own filesystem is case-insensitive, so the path that
  // comes back is one `spawn` can use either way — which is the property being checked.
  assert.equal(findExecutable("cloudflared", env, "win32")?.toLowerCase(), file.toLowerCase());
  // `Path`, not `PATH`: Windows spells it either way, and the lookup is case-insensitive
  // about the variable's own name.
  assert.equal(findExecutable("cloudflared", env, "linux"), null);
});
