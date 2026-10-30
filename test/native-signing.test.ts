import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, readdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { NATIVE_SIGN_IDENTITY, signingOptions, signNativeApp, notarizeNativeApp } from "../scripts/lib/native-mac-signing.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
function fixture(fn: (directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "fv-native-signing-"));
  try { fn(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}
const details = "Executable=fixture\nAuthority=Developer ID Application: fixture\nflags=0x10000(runtime)\nTimestamp=Oct 30, 2026\n";

test("notarization is explicit and fails before building if credentials are incomplete", () => {
  assert.equal(signingOptions([], {}).signed, false);
  assert.equal(signingOptions(["--sign"], {}).identity, NATIVE_SIGN_IDENTITY);
  assert.throws(() => signingOptions(["--notarize"], {}), /requires APPLE_API_KEY/);
  fixture((directory) => {
    const key = join(directory, "AuthKey.p8"); writeFileSync(key, "fixture");
    const env = { APPLE_API_KEY: key, APPLE_API_KEY_ID: "fixture-id", APPLE_API_ISSUER: "fixture-issuer" };
    for (const name of Object.keys(env)) assert.throws(() => signingOptions(["--notarize"], { ...env, [name]: "" }), /requires/);
    assert.equal(signingOptions(["--notarize"], env).signed, true);
    assert.throws(() => signingOptions(["--notarize"], { ...env, APPLE_API_KEY: join(directory, "missing") }), /does not exist/);
  });
});

test("Developer ID signing hardens native executables while preserving upstream OfficeCLI bytes", () => {
  const calls: { command: string; args: string[] }[] = [];
  const run = (command: string, args: string[]) => { calls.push({ command, args }); return details; };
  signNativeApp("/fixture/Native.app", signingOptions(["--sign"], { APPLE_SIGN_KEYCHAIN: "/fixture/keychain" }), run);
  const signatures = calls.filter(({ args }) => args.includes("--sign"));
  assert.equal(signatures.length, 2);
  assert.deepEqual(signatures.map(({ args }) => args.at(-1)), ["/fixture/Native.app/Contents/MacOS/fastvibe-server", "/fixture/Native.app"]);
  for (const { args } of signatures) {
    assert.ok(args.includes("runtime") && args.includes("--timestamp") && args.includes("/fixture/keychain"));
    assert.ok(!args.includes("--deep") && !args.includes("--entitlements"));
  }
  assert.ok(calls.some(({ args }) => args.includes("--verify") && args.at(-1)?.endsWith("officecli")));
  assert.throws(() => signNativeApp("fixture.app", signingOptions(["--sign"], {}), () => "Signature=adhoc\n"), /lacks a timestamped/);
  assert.throws(() => signNativeApp("fixture.app", signingOptions(["--sign"], { APPLE_SIGN_IDENTITY: "-" }), run), /cannot use an ad-hoc/);
});

test("Apple acceptance must precede stapling, ticket validation and Gatekeeper assessment", () => {
  fixture((directory) => {
    const calls: string[][] = [];
    const id = "11111111-1111-1111-1111-111111111111";
    const run = (_: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "notarytool" && args[1] === "submit") return JSON.stringify({ id, status: "Accepted" });
      if (args[0] === "notarytool" && args[1] === "log") return '{"issues":null}';
      return "";
    };
    const options = { signed: true, notarize: true, credentials: ["--key", "/fixture/AuthKey.p8"] };
    assert.equal(notarizeNativeApp("fixture.app", join(directory, "final.zip"), options, run).status, "Accepted");
    const index = (first: string, second: string) => calls.findIndex((args) => args[0] === first && args[1] === second);
    assert.ok(index("notarytool", "submit") < index("stapler", "staple"));
    assert.ok(index("stapler", "staple") < index("stapler", "validate"));
    assert.ok(index("stapler", "validate") < index("--assess", "--type"));
    assert.deepEqual(readdirSync(directory).sort(), ["native-notarization-log.json", "native-notarization.json"]);
  });
});

test("rejected and failed submissions retain Apple diagnostics and never staple or assess", () => {
  for (const nonzero of [false, true]) fixture((directory) => {
    const calls: string[][] = [];
    const run = (_: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "notarytool" && args[1] === "submit") {
        const json = '{"id":"11111111-1111-1111-1111-111111111111","status":"Invalid"}';
        if (nonzero) throw Object.assign(new Error("notarytool failed"), { stdout: json });
        return json;
      }
      return '{"issues":[{"message":"invalid signature"}]}';
    };
    assert.throws(() => notarizeNativeApp("fixture.app", join(directory, "final.zip"), { signed: true, notarize: true, credentials: ["--key", "fixture"] }, run), /Invalid|failed/);
    assert.ok(existsSync(join(directory, "native-notarization-log.json")));
    assert.ok(!calls.some((args) => args[0] === "stapler" || args[0] === "--assess"));
    assert.ok(!existsSync(join(directory, "final.zip")));
    assert.ok(!readdirSync(directory).some((name) => name.startsWith(".native-notary-")));
  });
});

test("native CI requires notarization for tag pushes and keeps secrets out of PR builds", () => {
  const workflow = readFileSync(join(root, ".github/workflows/native-bundles.yml"), "utf8");
  assert.match(workflow, /if: github.event_name != 'pull_request' && \(github.event_name != 'workflow_dispatch' \|\| inputs.notarize\)/);
  assert.match(workflow, /package-native-macos\.mjs --no-build --notarize/);
  assert.match(workflow, /if: github.event_name == 'push' && startsWith\(github.ref, 'refs\/tags\/native-v'\)/);
  assert.match(workflow, /if: always\(\) && github.event_name != 'pull_request'/);
  const packager = readFileSync(join(root, "scripts/package-native-macos.mjs"), "utf8");
  assert.ok(packager.indexOf("notarizeNativeApp(app,") < packager.lastIndexOf('run("/usr/bin/ditto"'));
  assert.ok(packager.lastIndexOf('run("/usr/bin/ditto"') < packager.indexOf('createHash("sha256")'));
});

test("Apple acceptance alone cannot bypass ticket or Gatekeeper failures", () => {
  for (const failAt of ["staple", "validate", "--assess"]) fixture((directory) => {
    const calls: string[][] = [];
    const run = (_: string, args: string[]) => {
      calls.push(args);
      if (args[1] === "submit") return '{"id":"11111111-1111-1111-1111-111111111111","status":"Accepted"}';
      if (args[1] === "log") return '{"issues":null}';
      if (args.includes(failAt)) throw new Error(`fixture failure at ${failAt}`);
      return "";
    };
    assert.throws(() => notarizeNativeApp("fixture.app", join(directory, "final.zip"), { signed: true, notarize: true, credentials: ["--key", "fixture"] }, run), /fixture failure/);
    assert.ok(existsSync(join(directory, "native-notarization.json")));
    assert.ok(!existsSync(join(directory, "final.zip")));
    if (failAt !== "--assess") assert.ok(!calls.some((args) => args[0] === "--assess"));
  });
});

test("temporary CI credentials are private and removed even if restoring keychains fails", () => {
  if (process.platform === "win32") return;
  fixture((directory) => {
    const bin = join(directory, "bin"); mkdirSync(bin);
    const security = join(bin, "security");
    writeFileSync(security, `#!/usr/bin/env node
const fs=require('node:fs');const a=process.argv.slice(2);
fs.appendFileSync(process.env.SIGN_TEST_LOG,JSON.stringify(a)+'\\n');
if(a[0]==='list-keychains'&&!a.includes('-s')) process.stdout.write('    "/fixture/login keychain-db"\\n');
if(a[0]==='create-keychain') fs.writeFileSync(a.at(-1),'fixture');
if(a[0]==='delete-keychain') fs.rmSync(a[1],{force:true});
if(a[0]==='list-keychains'&&a.includes('-s')&&process.env.FAIL_RESTORE) process.exit(1);
`); chmodSync(security, 0o755);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: directory,
      GITHUB_ENV: join(directory, "env"), GITHUB_OUTPUT: join(directory, "output"), SIGN_TEST_LOG: join(directory, "calls"),
      APPLE_CERT_P12: Buffer.from("fixture cert").toString("base64"), APPLE_CERT_PASSWORD: "fixture-password",
      APPLE_API_KEY_P8: "fixture p8", APPLE_API_KEY_ID: "fixture-id", APPLE_API_ISSUER: "fixture-issuer" };
    const script = join(root, "scripts/prepare-native-signing.sh");
    const missing = spawnSync("bash", [script], { env: { ...env, APPLE_API_KEY_P8: "" }, encoding: "utf8" });
    assert.notEqual(missing.status, 0);
    assert.ok(!existsSync(env.SIGN_TEST_LOG));
    const prepared = spawnSync("bash", [script], { env, encoding: "utf8" });
    assert.equal(prepared.status, 0, prepared.stderr);
    const work = join(directory, "fastvibe-native-signing");
    assert.equal(statSync(join(work, "AuthKey.p8")).mode & 0o777, 0o600);
    assert.ok(!existsSync(join(work, "certificate.p12")));
    assert.match(readFileSync(env.GITHUB_OUTPUT, "utf8"), /enabled=true/);
    const cleaned = spawnSync("bash", [script, "cleanup"], { env: { ...env, FAIL_RESTORE: "1" }, encoding: "utf8" });
    assert.notEqual(cleaned.status, 0);
    assert.ok(!existsSync(work));
    const calls = readFileSync(env.SIGN_TEST_LOG, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(calls.some((a) => a[0] === "list-keychains" && a.at(-1) === "/fixture/login keychain-db"));
    assert.ok(calls.some((a) => a[0] === "delete-keychain"));
  });
});
