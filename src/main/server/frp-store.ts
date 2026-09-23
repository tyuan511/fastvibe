import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  frpProblems,
  readFrpConfig,
  renderFrpcToml,
  type FrpConfig,
  type FrpSettingsInput,
} from "../../shared/frp.ts";

/**
 * Where the frp tunnel's settings live.
 *
 * Their own file, like `remote-access.json` and for the same reason: the token is a
 * credential for the user's server, and `settings.json` is handed whole to every renderer
 * and re-broadcast on every write — to a phone, once remote access is on. No method
 * serves this file; the pane gets `frpView`, which has a `hasToken` in place of it.
 */

export function readFrpSettings(file: string): FrpConfig | null {
  try {
    if (!existsSync(file)) return null;
    return readFrpConfig(JSON.parse(readFileSync(file, "utf8")) as unknown);
  } catch {
    // A corrupt file is a tunnel that needs setting up again, not a crash at launch.
    return null;
  }
}

/**
 * Save the pane's form, keeping what the pane cannot send back.
 *
 * Refuses an invalid config rather than storing it: the start path would only refuse it
 * again later, at a moment with less context. The proxy name is minted on the first save
 * and then kept (see `FrpConfig.proxyName`).
 */
export function saveFrpSettings(file: string, input: FrpSettingsInput): FrpConfig {
  const previous = readFrpSettings(file);
  const next: FrpConfig = {
    serverAddr: String(input.serverAddr ?? "").trim(),
    serverPort: input.serverPort,
    token: typeof input.token === "string" ? input.token : (previous?.token ?? ""),
    mode: input.mode === "tcp" ? "tcp" : "http",
    domain: String(input.domain ?? "").trim(),
    vhostPort: input.vhostPort ?? null,
    remotePort: input.remotePort ?? null,
    publicUrl: String(input.publicUrl ?? "").trim(),
    proxyName: previous?.proxyName ?? `fastvibe-${randomBytes(3).toString("hex")}`,
  };
  const problem = frpProblems(next)[0];
  if (problem) throw new Error(problem.message);
  writePrivate(file, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** Render the config frpc reads, next to the settings and just as private. */
export function writeFrpcConfig(file: string, config: FrpConfig, localPort: number): void {
  writePrivate(file, renderFrpcToml(config, localPort));
}

/**
 * Write through a temp file, 0600 from the first byte.
 *
 * `mode` on `writeFileSync` only applies when the file is created, so an existing file
 * with looser permissions is tightened explicitly — the same belt-and-braces `store.ts`
 * uses for the password hash.
 */
function writePrivate(file: string, text: string): void {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}
