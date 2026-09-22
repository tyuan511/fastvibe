import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SshHostKeyScan } from "@shared/remote-host";
import { explicitHostArgs, sshDestination, type SshHostProfile } from "./ssh-tunnel.ts";

/** What a scan saw, held in Main so a trust writes exactly the keys the user was shown. */
export type CapturedHostKey = SshHostKeyScan & { lines: string[] };

type Run = (binary: string, args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const run: Run = (binary, args) => new Promise((resolve) => {
  const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGTERM"), 20_000);
  child.once("error", (error) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: stderr || error.message }); });
  child.once("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
});

/**
 * Record the key a host presents, the way OpenSSH itself would receive it.
 *
 * `ssh-keyscan` would be the obvious tool, but it dials the host directly: it ignores
 * ProxyJump, HostKeyAlias and HashKnownHosts, so what it records is not what a later
 * `ssh` looks up. Instead this runs the real `ssh` with every authentication method off
 * and `StrictHostKeyChecking=accept-new` pointed at a throwaway file. The key exchange
 * writes the host's key there before authentication is even attempted, and the login is
 * then refused — nothing runs on the host and no credential leaves this machine.
 */
export async function captureHostKey(host: SshHostProfile, options?: { sshBinary?: string; run?: Run }): Promise<CapturedHostKey> {
  const exec = options?.run ?? run;
  const ssh = options?.sshBinary?.trim() || "ssh";
  const dir = mkdtempSync(join(tmpdir(), "fastvibe-hostkey-"));
  const scratch = join(dir, "known_hosts");
  try {
    // `-o` options are first-wins, so ours precede the profile's own known-hosts file.
    const result = await exec(ssh, [
      "-T",
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", `UserKnownHostsFile=${scratch}`,
      "-o", "GlobalKnownHostsFile=/dev/null",
      "-o", "PubkeyAuthentication=no",
      "-o", "PasswordAuthentication=no",
      "-o", "KbdInteractiveAuthentication=no",
      "-o", "GSSAPIAuthentication=no",
      "-o", "HostbasedAuthentication=no",
      "-o", "ControlMaster=no",
      "-o", "ControlPath=none",
      "-o", "ConnectTimeout=10",
      ...explicitHostArgs(host),
      sshDestination(host),
      "exit",
    ]);
    const lines = existsSync(scratch)
      ? readFileSync(scratch, "utf8").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"))
      : [];
    if (!lines.length) {
      const reason = result.stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
      throw new Error(reason ? `无法读取主机指纹：${reason}` : "无法读取主机指纹");
    }
    const fingerprint = await exec("ssh-keygen", ["-l", "-E", "sha256", "-f", scratch]);
    const keys = fingerprint.stdout
      .split(/\r?\n/)
      .map((line) => /^\d+\s+(SHA256:\S+)\s+.*\(([^)]+)\)\s*$/.exec(line.trim()))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => ({ fingerprint: match[1], type: match[2] }));
    if (!keys.length) throw new Error("无法计算主机指纹");
    return { hostId: "", keys, lines, knownHostsFile: await userKnownHostsFile(host, ssh, exec) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The first `UserKnownHostsFile` OpenSSH would use for this host — where a trust belongs. */
async function userKnownHostsFile(host: SshHostProfile, ssh: string, exec: Run): Promise<string> {
  const fallback = join(homedir(), ".ssh", "known_hosts");
  const result = await exec(ssh, ["-G", ...explicitHostArgs(host), sshDestination(host)]);
  const line = result.stdout.split(/\r?\n/).find((item) => item.toLowerCase().startsWith("userknownhostsfile "));
  const first = line?.split(/\s+/)[1];
  if (!first || first === "/dev/null" || first === "none") return fallback;
  return expandPath(first);
}

function expandPath(value: string): string {
  const home = homedir();
  const expanded = value.replace(/%d/g, home);
  if (expanded === "~") return home;
  if (expanded.startsWith("~/")) return join(home, expanded.slice(2));
  return expanded;
}

/** Append the captured lines to the user's known_hosts, creating it the way OpenSSH would. */
export function writeTrustedHostKey(scan: CapturedHostKey): void {
  const file = scan.knownHostsFile;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const separator = existing && !existing.endsWith("\n") ? "\n" : "";
  appendFileSync(file, `${separator}${scan.lines.join("\n")}\n`, { mode: 0o600 });
  if (!existing) chmodSync(file, 0o600);
}
