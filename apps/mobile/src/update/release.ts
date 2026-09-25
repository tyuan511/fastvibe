/**
 * Finding the newest Android build on GitHub Releases.
 *
 * The repository's releases are shared with the desktop app and its agent runtime,
 * which ship several times a day, so neither `releases/latest` (a desktop version)
 * nor the first page of `releases` (a phone release a few weeks old has scrolled off
 * it) can answer "what is the newest phone build". The tags can: every phone release
 * is an `app-v<version>` tag, and `git/matching-refs` lists exactly those.
 *
 * A tag is not yet a release — CI pushes the tag, then spends ten minutes building
 * before it publishes — so the newest tag without a published APK is skipped in
 * favour of the one below it.
 *
 * Pure: no React Native imports, so the root test runner can load it.
 */

export const RELEASE_REPO = "tyuan511/fastvibe";
export const RELEASE_TAG_PREFIX = "app-v";

const API = "https://api.github.com";
/** Tags tried, newest first, before giving up on finding a published build. */
const MAX_TAGS_TRIED = 3;

export type AppRelease = {
  version: string;
  tag: string;
  /** The release body, markdown as written in the workflow. */
  notes: string;
  pageUrl: string;
  apkUrl: string;
  apkName: string;
  /** Bytes, as GitHub reports them; used to tell a finished download from a cut one. */
  apkSize: number;
};

type Version = [number, number, number];

export function parseVersion(raw: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Negative when `a` is older than `b`. Unparseable versions sort below everything. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return left ? 1 : right ? -1 : 0;
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

/** `refs/tags/app-v0.2.0` → `0.2.0`; anything else (`app-v0.2.0-rc1`, a desktop tag) → null. */
export function versionFromRef(ref: string): string | null {
  const prefix = `refs/tags/${RELEASE_TAG_PREFIX}`;
  if (!ref.startsWith(prefix)) return null;
  const version = ref.slice(prefix.length);
  return parseVersion(version) ? version : null;
}

/** Phone versions named by `git/matching-refs`, newest first. */
export function versionsFromRefs(refs: unknown): string[] {
  if (!Array.isArray(refs)) return [];
  const versions = refs
    .map((entry) => (entry && typeof entry === "object" ? versionFromRef(String((entry as { ref?: unknown }).ref ?? "")) : null))
    .filter((version): version is string => version !== null);
  return [...new Set(versions)].sort((a, b) => compareVersions(b, a));
}

/** A `releases/tags/<tag>` body as an installable release, or null when it has no APK to offer. */
export function releaseFromPayload(version: string, payload: unknown): AppRelease | null {
  if (!payload || typeof payload !== "object") return null;
  const release = payload as {
    tag_name?: unknown;
    draft?: unknown;
    prerelease?: unknown;
    body?: unknown;
    html_url?: unknown;
    assets?: unknown;
  };
  if (release.draft === true || release.prerelease === true) return null;
  if (!Array.isArray(release.assets)) return null;
  const apk = release.assets.find(
    (asset) =>
      asset &&
      typeof asset === "object" &&
      typeof (asset as { name?: unknown }).name === "string" &&
      (asset as { name: string }).name.toLowerCase().endsWith(".apk") &&
      typeof (asset as { browser_download_url?: unknown }).browser_download_url === "string",
  ) as { name: string; browser_download_url: string; size?: unknown } | undefined;
  if (!apk) return null;
  return {
    version,
    tag: typeof release.tag_name === "string" ? release.tag_name : `${RELEASE_TAG_PREFIX}${version}`,
    notes: typeof release.body === "string" ? release.body.trim() : "",
    pageUrl: typeof release.html_url === "string" ? release.html_url : `https://github.com/${RELEASE_REPO}/releases`,
    apkUrl: apk.browser_download_url,
    apkName: apk.name,
    apkSize: typeof apk.size === "number" ? apk.size : 0,
  };
}

type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

const HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

/**
 * The newest published phone build strictly newer than `currentVersion`, or null when
 * this install is current. Throws on a network or API failure, so a caller can tell
 * "up to date" from "could not check".
 */
export async function findNewerRelease(currentVersion: string, fetchImpl: Fetch): Promise<AppRelease | null> {
  const refsResponse = await fetchImpl(
    `${API}/repos/${RELEASE_REPO}/git/matching-refs/tags/${RELEASE_TAG_PREFIX}`,
    { headers: HEADERS },
  );
  if (!refsResponse.ok) throw new Error(`GitHub 返回 ${refsResponse.status}`);
  const newer = versionsFromRefs(await refsResponse.json()).filter(
    (version) => compareVersions(version, currentVersion) > 0,
  );

  for (const version of newer.slice(0, MAX_TAGS_TRIED)) {
    const response = await fetchImpl(
      `${API}/repos/${RELEASE_REPO}/releases/tags/${RELEASE_TAG_PREFIX}${version}`,
      { headers: HEADERS },
    );
    // 404: the tag is pushed but CI has not published it yet (or the build failed).
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`GitHub 返回 ${response.status}`);
    const release = releaseFromPayload(version, await response.json());
    if (release) return release;
  }
  return null;
}
