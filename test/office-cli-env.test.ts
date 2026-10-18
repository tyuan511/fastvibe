import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyOfficeCliEnv, releaseOfficeResident } from "../src/main/engine/office-cli.ts";
import { configureFastVibeUserData } from "../src/main/engine/paths.ts";

configureFastVibeUserData(mkdtempSync(join(tmpdir(), "office-env-")));

test("the bundled directory leads PATH, and the four switches are set", () => {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
  const added = applyOfficeCliEnv(env, {
    dir: "/app/officecli",
    binary: "/app/officecli/officecli",
    version: "v1.0.157",
  });
  assert.equal(added, "/app/officecli");
  assert.equal(env.PATH?.startsWith("/app/officecli:"), true);
  assert.match(env.PATH ?? "", /\/usr\/bin$/);
  assert.equal(env.OFFICECLI_SKIP_UPDATE, "1");
  assert.equal(env.OFFICECLI_NO_AUTO_INSTALL, "1");
  assert.equal(env.OFFICECLI_RESIDENT_FLUSH, "each");
  assert.ok(env.OFFICECLI_STATE_DIR?.endsWith("officecli-state"));
});

test("a machine with no binary is left alone", () => {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
  assert.equal(applyOfficeCliEnv(env, { dir: "/app", binary: null, version: null }), null);
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.OFFICECLI_SKIP_UPDATE, undefined);
});

test("only an Office file has a resident to release, and a failing close is swallowed", async () => {
  const install = { dir: "/app/officecli", binary: "/app/officecli/officecli", version: "v1.0.157" };
  const calls: string[][] = [];
  const run = async (_binary: string, args: string[]): Promise<void> => {
    calls.push(args);
  };
  await releaseOfficeResident("/work/deck.pptx", install, run);
  await releaseOfficeResident("/work/notes.txt", install, run);
  await releaseOfficeResident("/work/old.doc", install, run);
  assert.deepEqual(calls, [["close", "/work/deck.pptx"]]);
  await releaseOfficeResident("/work/a.docx", install, async () => {
    throw new Error("no resident");
  });
  await releaseOfficeResident("/work/a.docx", { dir: "/app", binary: null, version: null }, run);
  assert.equal(calls.length, 1);
});
