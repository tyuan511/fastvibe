/**
 * Download the computer-control worker and its native library into the data directory.
 *
 * Neither is in the installer. A packaged app fetches them the first time 电脑操控 is
 * turned on, checks the pinned checksum before unpacking, and tries the GitHub mirror
 * when the official host does not answer. A dev tree that already has the files
 * (predev fetch, or the npm package) skips the piece it already has.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { chmod, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  cuaMirrorUrl,
  type CuaArtifact,
  type CuaPlatformSpec,
} from "./cua-driver-spec.ts";

const execFileAsync = promisify(execFile);

export type CuaDownloadProgress = {
  received: number;
  total: number;
};

export async function installCuaDriver(options: {
  root: string;
  spec: CuaPlatformSpec;
  signal: AbortSignal;
  onProgress: (progress: CuaDownloadProgress) => void;
  skipWorker?: boolean;
  skipNative?: boolean;
}): Promise<{ worker: string; nativeDir: string }> {
  const { root, spec, signal } = options;
  await mkdir(root, { recursive: true });
  const worker = join(root, spec.workerName);
  const nativeDir = join(root, "native");
  const wanted = spec.artifacts.filter((item) => {
    if (item.kind === "worker" && options.skipWorker) return false;
    if (item.kind === "native" && options.skipNative) return false;
    return true;
  });

  let completed = 0;
  const lengths: number[] = wanted.map(() => 0);
  const report = (index: number, received: number, total: number): void => {
    lengths[index] = total;
    const known = lengths.every((length) => length > 0);
    options.onProgress({
      received: completed + received,
      total: known ? lengths.reduce((sum, length) => sum + length, 0) : 0,
    });
  };

  for (const [index, artifact] of wanted.entries()) {
    signal.throwIfAborted();
    const archive = join(root, `.partial-${artifact.filename}`);
    await downloadVerified(artifact, archive, signal, (received, total) => report(index, received, total));
    completed += statSync(archive).size;
    report(index, 0, lengths[index]);
    if (artifact.kind === "worker") await installWorker(archive, worker, spec, signal);
    else await installNative(archive, nativeDir, spec);
    await rm(archive, { force: true });
  }

  if (!options.skipWorker && !existsSync(worker)) {
    throw new Error(`worker missing after unpack (${worker})`);
  }
  if (!options.skipNative && !existsSync(join(nativeDir, spec.nativeLib))) {
    throw new Error(`native library missing after unpack (${nativeDir})`);
  }
  return { worker, nativeDir };
}

async function downloadVerified(
  artifact: CuaArtifact,
  dest: string,
  signal: AbortSignal,
  onProgress: (received: number, total: number) => void,
): Promise<void> {
  const urls = [artifact.url, cuaMirrorUrl(artifact.url)];
  let last = "download failed";
  for (const [index, url] of urls.entries()) {
    signal.throwIfAborted();
    try {
      const actual = await downloadOne(url, dest, signal, index === 0 ? 20_000 : 60_000, onProgress);
      if (actual !== artifact.sha256) {
        await rm(dest, { force: true });
        throw new Error(`checksum mismatch for ${artifact.filename}`);
      }
      return;
    } catch (error) {
      await rm(dest, { force: true }).catch(() => undefined);
      if (signal.aborted) throw error;
      last = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(last);
}

/**
 * One attempt. A transfer that goes quiet is aborted so the mirror can be tried
 * instead of waiting out a blocked host. The official URL gets the short fuse.
 */
async function downloadOne(
  url: string,
  dest: string,
  parent: AbortSignal,
  stallMs: number,
  onProgress: (received: number, total: number) => void,
): Promise<string> {
  const attempt = new AbortController();
  const onParentAbort = (): void => attempt.abort(parent.reason);
  if (parent.aborted) attempt.abort(parent.reason);
  else parent.addEventListener("abort", onParentAbort, { once: true });

  let lastByte = Date.now();
  let stalled = false;
  const stall = setInterval(() => {
    if (Date.now() - lastByte >= stallMs) {
      stalled = true;
      attempt.abort();
    }
  }, 1_000);

  try {
    await mkdir(dirname(dest), { recursive: true });
    const response = await fetch(url, { signal: attempt.signal, redirect: "follow" });
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    const total = Number(response.headers.get("content-length") || 0);
    const hash = createHash("sha256");
    const file = createWriteStream(dest);
    const reader = response.body.getReader();
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        lastByte = Date.now();
        hash.update(value);
        received += value.byteLength;
        onProgress(received, total);
        if (!file.write(value)) await new Promise<void>((resolve) => file.once("drain", () => resolve()));
      }
    } finally {
      file.end();
      await new Promise<void>((resolve, reject) => {
        file.on("finish", () => resolve());
        file.on("error", reject);
      });
    }
    return hash.digest("hex");
  } catch (error) {
    if (stalled && !parent.aborted) throw new Error("download stalled");
    throw error;
  } finally {
    clearInterval(stall);
    parent.removeEventListener("abort", onParentAbort);
  }
}

async function installWorker(
  archive: string,
  dest: string,
  spec: CuaPlatformSpec,
  signal: AbortSignal,
): Promise<void> {
  const tmp = join(dirname(dest), ".unpack-worker");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    if (spec.workerMember) {
      await execFileAsync("tar", ["-xzf", archive, "-C", tmp, spec.workerMember], { signal });
      const universal = join(tmp, spec.workerMember);
      if (!existsSync(universal)) throw new Error(`archive has no ${spec.workerMember}`);
      await rm(dest, { force: true });
      if (spec.lipo) {
        await execFileAsync("lipo", ["-thin", spec.lipo, universal, "-output", dest], { signal });
      } else {
        await rename(universal, dest);
      }
    } else {
      await execFileAsync("tar", ["-xf", archive, "-C", tmp], { signal });
      const found = findNamed(tmp, spec.workerName);
      if (!found) throw new Error(`archive has no ${spec.workerName}`);
      await rm(dest, { force: true });
      await rename(found, dest);
    }
    if (process.platform !== "win32") await chmod(dest, 0o755);
    if (process.platform === "darwin") {
      await execFileAsync("xattr", ["-d", "com.apple.quarantine", dest]).catch(() => undefined);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function installNative(archive: string, dest: string, spec: CuaPlatformSpec): Promise<void> {
  const tmp = join(dirname(dest), ".unpack-native");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    await execFileAsync("tar", ["-xzf", archive, "-C", tmp]);
    const pkg = findNamed(tmp, "package.json");
    const lib = findNamed(tmp, spec.nativeLib);
    if (!pkg || !lib) throw new Error("native archive is missing the library");
    const src = dirname(pkg);
    if (!existsSync(join(src, spec.nativeLib)) || !existsSync(join(src, spec.nativeAddon))) {
      throw new Error("native archive layout is not a platform package");
    }
    rmSync(dest, { recursive: true, force: true });
    await rename(src, dest);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function findNamed(dir: string, name: string, depth = 4): string | null {
  if (depth < 0 || !existsSync(dir)) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findNamed(path, name, depth - 1);
      if (found) return found;
    } else if (entry.name === name) {
      return path;
    }
  }
  return null;
}
