import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { applyShellPath, applyShellPathAsync } from "../src/main/engine/shell-path.ts";
import { applyOfficeCliEnv } from "../src/main/engine/office-cli.ts";
import { configureFastVibeUserData } from "../src/main/engine/paths.ts";

configureFastVibeUserData(mkdtempSync(join(tmpdir(), "shell-path-")));

/** A fake login shell that prints whatever PATH it is told to, the way `-ilc` would. */
function fakeShell(path: string, delayMs = 0): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-shell-"));
  const shell = join(dir, "sh");
  writeFileSync(shell, `#!/bin/sh\n/bin/sleep ${delayMs / 1000}\nprintf '__FASTVIBE_PATH_START__%s__FASTVIBE_PATH_END__' '${path}'\n`);
  chmodSync(shell, 0o755);
  return shell;
}

const home = mkdtempSync(join(tmpdir(), "home-"));

test("the async probe merges the login shell's PATH exactly like the blocking one", { skip: process.platform === "win32" }, async () => {
  const shell = fakeShell(["/opt/shell/bin", "/usr/bin"].join(delimiter));
  const blocking: NodeJS.ProcessEnv = { SHELL: shell, PATH: "/usr/bin:/bin" };
  const async: NodeJS.ProcessEnv = { SHELL: shell, PATH: "/usr/bin:/bin" };
  applyShellPath(blocking, "linux", home);
  await applyShellPathAsync(async, "linux", home);
  assert.equal(async.PATH, blocking.PATH);
  assert.ok(async.PATH?.split(delimiter).includes("/opt/shell/bin"));
});

test("a shell that never answers costs the timeout, not the launch", { skip: process.platform === "win32" }, async () => {
  const env: NodeJS.ProcessEnv = { SHELL: fakeShell("/never", 5_000), PATH: "/usr/bin" };
  const started = Date.now();
  await applyShellPathAsync(env, "linux", home);
  assert.ok(Date.now() - started < 3_000);
  assert.equal(env.PATH?.includes("/never"), false);
  assert.equal(env.PATH?.endsWith("/usr/bin"), true);
});

test("the bundled OfficeCLI goes back in front once, after the shell's entries landed ahead of it", async () => {
  const install = { dir: "/app/officecli", binary: "/app/officecli/officecli", version: "v1.0.157" };
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
  applyOfficeCliEnv(env, install);
  await applyShellPathAsync(env, "linux", home, async () => ["/opt/user/bin"]);
  assert.notEqual(env.PATH?.split(":")[0], "/app/officecli");
  applyOfficeCliEnv(env, install);
  const entries = env.PATH?.split(":") ?? [];
  assert.equal(entries[0], "/app/officecli");
  assert.equal(entries.filter((entry) => entry === "/app/officecli").length, 1);
});
