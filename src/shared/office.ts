/**
 * Office documents, and the OfficeCLI binary FastVibe ships to render and edit them.
 *
 * Two halves live here because both halves are read from three places that cannot import
 * each other:
 *
 * - the **build scripts** (`scripts/fetch-officecli.mjs`, `scripts/sync-officecli.mjs`) need
 *   the platform → asset table and the manifest shape;
 * - the **main process / headless Agent** need the same table to find the binary it shipped
 *   with, and the extension set to decide what a preview of `report.docx` is;
 * - the **renderer** needs the extension set, and has no `node:path` to derive it with.
 *
 * One table, so a build cannot fetch an asset the runtime would then look for under a
 * different name — which is exactly the failure `test/officecli-manifest.test.ts` pins.
 *
 * Nothing here touches the disk or Electron.
 */

/** Formats OfficeCLI renders and edits. It does not accept anything else. */
export type OfficeFormat = "docx" | "xlsx" | "pptx";

/**
 * Formats that *look* previewable but are not: the pre-2007 binary Office files, the ODF
 * family, and the macro-enabled Office variants.
 *
 * OfficeCLI refuses all of them, and reading one as text (which is what the preview used to
 * fall through to) produced a screen of mojibake for a file that is a zip or an OLE
 * container. Naming them is also what stops the pane from offering to install anything for a
 * format no version of the tool will ever render.
 */
const UNSUPPORTED_OFFICE_EXTENSIONS = [
  ".doc",
  ".xls",
  ".ppt",
  ".docm",
  ".xlsm",
  ".pptm",
  ".odt",
  ".ods",
  ".odp",
] as const;

const OFFICE_EXTENSIONS: Record<string, OfficeFormat> = {
  ".docx": "docx",
  ".xlsx": "xlsx",
  ".pptx": "pptx",
};

/** Extension of a path, without `node:path`: the renderer imports this module too. */
function extensionOf(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

/** What OfficeCLI can render this file as, or null when it is not one of the three. */
export function officeFormatOf(filePath: string): OfficeFormat | null {
  return OFFICE_EXTENSIONS[extensionOf(filePath)] ?? null;
}

/** Whether this file is an Office document that FastVibe will not be able to preview. */
export function isUnsupportedOfficeFile(filePath: string): boolean {
  return (UNSUPPORTED_OFFICE_EXTENSIONS as readonly string[]).includes(extensionOf(filePath));
}

/** The extensions a reply may show inline as an Office document (`present`, `@shared/inline-media`). */
export const OFFICE_FILE_EXTENSIONS = [".docx", ".xlsx", ".pptx"] as const;

/** The delimited table files the app keeps parsing itself, because OfficeCLI does not take them. */
export const CSV_FILE_EXTENSIONS = [".csv", ".tsv"] as const;

// ---------------------------------------------------------------------------
// The OfficeCLI binary: one platform table for the fetcher and the runtime.
// ---------------------------------------------------------------------------

/**
 * Where the binary lives inside `resources/officecli/`, and which release asset it came from.
 *
 * The keys are what electron-builder's `${os}-${arch}` macros expand to (`mac` / `win` /
 * `linux`, `arm64` / `x64`), so `extraResources` can name the directory without knowing which
 * build is running. `*-alpine-*` is not a desktop target: those are the musl builds the headless
 * Agent runs on a slim server image (see `docs/agent-runtime.md`).
 */
export type OfficeCliPlatform = {
  /** Directory under `resources/officecli/`, and the key in `scripts/officecli.json`. */
  key: string;
  /** Release asset to download. */
  asset: string;
  /** File name the binary is stored and looked up under. */
  binary: string;
  /** Which install this platform is shipped for. */
  usedBy: ("desktop" | "agent")[];
};

export const OFFICECLI_PLATFORMS: readonly OfficeCliPlatform[] = [
  { key: "mac-arm64", asset: "officecli-mac-arm64", binary: "officecli", usedBy: ["desktop"] },
  { key: "mac-x64", asset: "officecli-mac-x64", binary: "officecli", usedBy: ["desktop"] },
  { key: "win-x64", asset: "officecli-win-x64.exe", binary: "officecli.exe", usedBy: ["desktop"] },
  { key: "win-arm64", asset: "officecli-win-arm64.exe", binary: "officecli.exe", usedBy: ["desktop"] },
  { key: "linux-x64", asset: "officecli-linux-x64", binary: "officecli", usedBy: ["desktop", "agent"] },
  { key: "linux-arm64", asset: "officecli-linux-arm64", binary: "officecli", usedBy: ["desktop", "agent"] },
  { key: "linux-alpine-x64", asset: "officecli-linux-alpine-x64", binary: "officecli", usedBy: ["agent"] },
  { key: "linux-alpine-arm64", asset: "officecli-linux-alpine-arm64", binary: "officecli", usedBy: ["agent"] },
];

/** electron-builder's `${os}` for a Node platform string. */
export function officeCliOsName(platform: NodeJS.Platform | string): "mac" | "win" | "linux" | null {
  if (platform === "darwin") return "mac";
  if (platform === "win32") return "win";
  if (platform === "linux") return "linux";
  return null;
}

/**
 * The platform key for a running process, or null when OfficeCLI is not shipped for it.
 *
 * `musl` is the Agent's call only: a desktop Electron process is always the glibc build. The
 * runtime cannot detect libc from inside Electron reliably, so it is passed in where it is
 * known (the Agent bootstrap) rather than guessed.
 */
export function officeCliPlatformKey(
  platform: NodeJS.Platform | string,
  arch: string,
  options?: { musl?: boolean },
): string | null {
  const os = officeCliOsName(platform);
  if (!os) return null;
  const normalized = arch === "amd64" ? "x64" : arch === "aarch64" ? "arm64" : arch;
  if (normalized !== "arm64" && normalized !== "x64") return null;
  if (os === "linux" && options?.musl) return `linux-alpine-${normalized}`;
  return `${os}-${normalized}`;
}

/** The directory name and file name the binary for this key is stored under. */
export function officeCliPlatform(key: string): OfficeCliPlatform | null {
  return OFFICECLI_PLATFORMS.find((item) => item.key === key) ?? null;
}

/** Every key a desktop installer has to carry, for the manifest test and the fetcher. */
export function officeCliDesktopKeys(): string[] {
  return OFFICECLI_PLATFORMS.filter((item) => item.usedBy.includes("desktop")).map((item) => item.key);
}

/** Every key an Agent runtime package may have to carry. */
export function officeCliAgentKeys(): string[] {
  return OFFICECLI_PLATFORMS.filter((item) => item.usedBy.includes("agent")).map((item) => item.key);
}

// ---------------------------------------------------------------------------
// scripts/officecli.json
// ---------------------------------------------------------------------------

export type OfficeCliAsset = {
  /** Release asset name, e.g. `officecli-mac-arm64`. */
  asset: string;
  /** Lowercase hex SHA256 from that release's own `SHA256SUMS`. */
  sha256: string;
};

/**
 * The pinned OfficeCLI release.
 *
 * The hashes are copied out of the release's `SHA256SUMS` and committed by
 * `pnpm sync:officecli`. A build never trusts what it downloads alongside the binary: the
 * checksum it verifies against is the one in this file, so a mirror serving a swapped asset
 * (or a stale `SHA256SUMS` paired with a stale binary) fails the build instead of shipping it.
 */
export type OfficeCliManifest = {
  version: string;
  /** `owner/repo` on GitHub. */
  repository: string;
  /** OfficeCLI's own download mirror, tried before GitHub. */
  mirror: string;
  license: string;
  assets: Record<string, OfficeCliAsset>;
};

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Read a manifest, refusing a malformed or incomplete one rather than half-trusting it. */
export function parseOfficeCliManifest(raw: unknown): OfficeCliManifest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("officecli 清单必须是对象");
  const value = raw as Record<string, unknown>;
  const version = typeof value.version === "string" ? value.version.trim() : "";
  const repository = typeof value.repository === "string" ? value.repository.trim() : "";
  if (!/^v\d+\.\d+\.\d+$/.test(version)) throw new Error(`officecli 清单的 version 无效：${version || "(空)"}`);
  if (!repository) throw new Error("officecli 清单缺少 repository");
  const mirror = typeof value.mirror === "string" ? value.mirror.trim().replace(/\/+$/, "") : "";
  if (!/^https:\/\//.test(mirror)) throw new Error("officecli 清单的 mirror 必须是 https 地址");
  const license = typeof value.license === "string" ? value.license.trim() : "";
  if (!license) throw new Error("officecli 清单缺少 license");
  const rawAssets = value.assets;
  if (typeof rawAssets !== "object" || rawAssets === null || Array.isArray(rawAssets)) {
    throw new Error("officecli 清单缺少 assets");
  }
  const assets: Record<string, OfficeCliAsset> = {};
  for (const [key, entry] of Object.entries(rawAssets as Record<string, unknown>)) {
    const platform = officeCliPlatform(key);
    if (!platform) throw new Error(`officecli 清单里有一个未知的平台：${key}`);
    if (typeof entry !== "object" || entry === null) throw new Error(`officecli 清单的 ${key} 不是对象`);
    const row = entry as Record<string, unknown>;
    const asset = typeof row.asset === "string" ? row.asset.trim() : "";
    const sha256 = typeof row.sha256 === "string" ? row.sha256.trim().toLowerCase() : "";
    if (asset !== platform.asset) throw new Error(`officecli 清单的 ${key} 指向了另一个资产名：${asset}`);
    if (!SHA256_HEX.test(sha256)) throw new Error(`officecli 清单的 ${key} 缺少有效的 SHA256`);
    assets[key] = { asset, sha256 };
  }
  return { version, repository, mirror, license, assets };
}

/**
 * What `pnpm sync:officecli` reads out of a release's own `SHA256SUMS`.
 *
 * A line is `<hex>  <filename>`; only the filenames this build cares about are kept, and a
 * known platform whose asset is missing from the release is an error — silently shipping the
 * other seven would leave one installer without a binary.
 */
export function assetsFromChecksumSums(text: string, options?: { strict?: boolean }): Record<string, OfficeCliAsset> {
  const byAsset = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})[* ]+(\S+)\s*$/.exec(line.trim());
    if (!match) continue;
    const hash = (match[1] ?? "").toLowerCase();
    const name = (match[2] ?? "").trim();
    if (hash && name) byAsset.set(name, hash);
  }
  const assets: Record<string, OfficeCliAsset> = {};
  const missing: string[] = [];
  for (const platform of OFFICECLI_PLATFORMS) {
    const hash = byAsset.get(platform.asset);
    if (hash) assets[platform.key] = { asset: platform.asset, sha256: hash };
    else missing.push(platform.key);
  }
  if (missing.length > 0 && options?.strict !== false) {
    throw new Error(`SHA256SUMS 里缺少这些平台的资产：${missing.join(", ")}`);
  }
  return assets;
}

/** Stable JSON for `scripts/officecli.json`: platform order is the table's, keys are sorted. */
export function serializeOfficeCliManifest(manifest: OfficeCliManifest): string {
  const assets = OFFICECLI_PLATFORMS.filter((item) => manifest.assets[item.key]).map((item) => {
    const entry = manifest.assets[item.key]!;
    return `    "${item.key}": {\n      "asset": "${entry.asset}",\n      "sha256": "${entry.sha256}"\n    }`;
  });
  return [
    "{",
    `  "version": "${manifest.version}",`,
    `  "repository": "${manifest.repository}",`,
    `  "mirror": "${manifest.mirror}",`,
    `  "license": "${manifest.license}",`,
    "  \"assets\": {",
    `${assets.join(",\n")}`,
    "  }",
    "}",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The static snapshot cache key.
// ---------------------------------------------------------------------------

/**
 * What identifies one rendered snapshot.
 *
 * `(realpath, mtime, size, officecli version)` — the first three say *this exact file at this
 * moment*, the last says the renderer changed, which it does: a new OfficeCLI version can
 * redraw the same document differently, and the cached page must not keep being served then.
 *
 * The path is part of the key because the rendered page keeps the document's own title and
 * file name, and a cache hit on identical bytes of a *renamed* file would show the wrong name.
 */
export type OfficeSnapshotIdentity = {
  realPath: string;
  mtimeMs: number;
  size: number;
  version: string;
};

/** Fields of the identity, in the order the digest is taken over. Keep it append-only. */
export function officeSnapshotSeed(identity: OfficeSnapshotIdentity): string {
  return [
    identity.version,
    identity.realPath,
    // Whole milliseconds only: a float's last digits change across a filesystem and a copy,
    // and would thrash the cache for a file nobody edited.
    String(Math.round(identity.mtimeMs)),
    String(identity.size),
  ].join("\n");
}
