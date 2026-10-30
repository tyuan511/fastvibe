import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Same personal Developer ID as the Electron release, explicitly selected on hosts
// that also carry a company certificate. Never pick the first keychain identity.
export const NATIVE_SIGN_IDENTITY = "Developer ID Application: tang yuan (J24Y9W38D8)";

export function signingOptions(args, env = process.env) {
  const notarize = args.includes("--notarize");
  const signed = notarize || args.includes("--sign");
  if (notarize) {
    for (const name of ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"]) {
      if (!env[name]) throw new Error(`--notarize requires ${name}; refusing an unnotarized package`);
    }
    if (!existsSync(env.APPLE_API_KEY)) throw new Error("APPLE_API_KEY file does not exist");
  }
  return {
    signed, notarize,
    identity: signed ? env.APPLE_SIGN_IDENTITY || NATIVE_SIGN_IDENTITY : "-",
    keychain: signed ? env.APPLE_SIGN_KEYCHAIN || "" : "",
    credentials: notarize ? ["--key", env.APPLE_API_KEY, "--key-id", env.APPLE_API_KEY_ID, "--issuer", env.APPLE_API_ISSUER] : [],
  };
}

export function runAppleCommand(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: options.timeout ?? 120_000 });
  if (result.error || result.status !== 0) {
    // Do not interpolate credential-bearing arguments or the environment into errors.
    const error = new Error(`${command} ${args[0]} failed${result.error ? `: ${result.error.message}` : ` (${result.status})`}\n${result.stderr || ""}`);
    error.stdout = result.stdout || "";
    throw error;
  }
  return options.display ? `${result.stdout || ""}${result.stderr || ""}` : result.stdout || "";
}

export function signNativeApp(app, options, run = runAppleCommand) {
  if (options.signed && options.identity === "-") throw new Error("Developer ID signing cannot use an ad-hoc identity");
  const flags = ["--force", "--sign", options.identity];
  if (options.signed) flags.push("--options", "runtime", "--timestamp");
  if (options.keychain) flags.push("--keychain", options.keychain);
  // The pinned OfficeCLI already has a timestamped Developer ID signature with
  // hardened runtime. Keep those bytes and its upstream entitlements unchanged.
  run("/usr/bin/codesign", ["--verify", "--strict", join(app, "Contents/Resources/officecli/mac-arm64/officecli")]);
  run("/usr/bin/codesign", [...flags, join(app, "Contents/MacOS/fastvibe-server")]);
  // Signing the bundle signs its main executable with its Info.plist identity.
  run("/usr/bin/codesign", [...flags, app]);
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  if (options.signed) {
    for (const path of [app, join(app, "Contents/MacOS/fastvibe-server")]) {
      // codesign emits its display output on stderr.
      const details = run("/usr/bin/codesign", ["--display", "--verbose=4", path], { display: true });
      if (!details.includes("Authority=Developer ID Application:") || !/flags=.*\bruntime\b/.test(details) || !/\nTimestamp=/.test(details)) {
        throw new Error(`native executable lacks a timestamped Developer ID hardened-runtime signature: ${path}`);
      }
    }
  }
}

export function notarizeNativeApp(app, archive, options, run = runAppleCommand) {
  if (!options.notarize || !options.signed || !options.credentials.length) throw new Error("notarization requires signed mode and Apple API credentials");
  const directory = mkdtempSync(join(dirname(archive), ".native-notary-"));
  const report = join(dirname(archive), "native-notarization.json");
  const log = join(dirname(archive), "native-notarization-log.json");
  try {
    const submission = join(directory, "submission.zip");
    run("/usr/bin/ditto", ["-c", "-k", "--norsrc", "--keepParent", app, submission]);
    let output;
    let failed;
    try {
      output = run("/usr/bin/xcrun", ["notarytool", "submit", submission, ...options.credentials, "--wait", "--timeout", "20m", "--output-format", "json"], { timeout: 25 * 60_000 });
    } catch (error) {
      output = error.stdout || "";
      failed = error;
    }
    writeFileSync(report, output);
    let result;
    try { result = JSON.parse(output); } catch { throw failed || new Error("notarytool returned invalid JSON"); }
    if (typeof result.id !== "string" || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(result.id)) {
      throw failed || new Error("notarytool did not return a valid submission ID");
    }
    const details = run("/usr/bin/xcrun", ["notarytool", "log", result.id, ...options.credentials]);
    writeFileSync(log, details);
    const issues = JSON.parse(details).issues || [];
    if (issues.length) console.log(`Apple notarization log has ${issues.length} issue(s); see ${log}`);
    if (failed || result.status !== "Accepted") throw failed || new Error(`Apple notarization was ${result.status || "not accepted"}; see ${log}`);
    run("/usr/bin/xcrun", ["stapler", "staple", app]);
    run("/usr/bin/xcrun", ["stapler", "validate", app]);
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
    run("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", app]);
    return result;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
