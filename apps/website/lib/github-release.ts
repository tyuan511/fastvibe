const REPOSITORY = "tyuan511/fastvibe";
const RELEASES_URL = `https://github.com/${REPOSITORY}/releases/latest`;
const MOBILE_RELEASES_URL = `https://github.com/${REPOSITORY}/releases`;
const API_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const MOBILE_API_URL = `https://api.github.com/repos/${REPOSITORY}/releases?per_page=100`;

export type DownloadAsset = {
  name: string;
  url: string;
  available: boolean;
};

export type LatestRelease = {
  version: string;
  isFallback: boolean;
  publishedAt: string | null;
  url: string;
  downloads: {
    macArm: DownloadAsset;
    macIntel: DownloadAsset;
    windows: DownloadAsset;
    linuxAppImage: DownloadAsset;
    linuxDeb: DownloadAsset;
  };
};

export type LatestMobileRelease = {
  version: string;
  isFallback: boolean;
  url: string;
  apkUrl: string;
  checksumUrl: string | null;
};

type GitHubAsset = {
  name: string;
  browser_download_url: string;
};

type GitHubRelease = {
  tag_name?: string;
  html_url?: string;
  published_at?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: GitHubAsset[];
};

const fallbackAsset = (name: string): DownloadAsset => ({
  name,
  url: RELEASES_URL,
  available: false,
});

const FALLBACK_RELEASE: LatestRelease = {
  version: "最新版本",
  isFallback: true,
  publishedAt: null,
  url: RELEASES_URL,
  downloads: {
    macArm: fallbackAsset("Apple Silicon (.dmg)"),
    macIntel: fallbackAsset("Intel Mac (.dmg)"),
    windows: fallbackAsset("Windows (.exe)"),
    linuxAppImage: fallbackAsset("Linux (.AppImage)"),
    linuxDeb: fallbackAsset("Linux (.deb)"),
  },
};

const FALLBACK_MOBILE_RELEASE: LatestMobileRelease = {
  version: "最新版本",
  isFallback: true,
  url: MOBILE_RELEASES_URL,
  apkUrl: MOBILE_RELEASES_URL,
  checksumUrl: null,
};

function asset(
  assets: GitHubAsset[],
  matcher: (name: string) => boolean,
  fallbackName: string,
): DownloadAsset {
  const match = assets.find(({ name }) => matcher(name));
  return match
    ? { name: match.name, url: match.browser_download_url, available: true }
    : fallbackAsset(fallbackName);
}

export async function getLatestRelease(): Promise<LatestRelease> {
  try {
    const response = await fetch(API_URL, {
      headers: { Accept: "application/vnd.github+json" },
      next: { revalidate: 600 },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) return FALLBACK_RELEASE;

    const release = (await response.json()) as GitHubRelease;
    const assets = release.assets ?? [];
    const tag = release.tag_name || FALLBACK_RELEASE.version;
    const releaseUrl = release.html_url || RELEASES_URL;

    return {
      version: tag,
      isFallback: false,
      publishedAt: release.published_at ?? null,
      url: releaseUrl,
      downloads: {
        macArm: asset(assets, (name) => /arm64.*\.dmg$/i.test(name), "Apple Silicon (.dmg)"),
        macIntel: asset(assets, (name) => /\.dmg$/i.test(name) && !/arm64/i.test(name), "Intel Mac (.dmg)"),
        windows: asset(assets, (name) => /\.exe$/i.test(name), "Windows (.exe)"),
        linuxAppImage: asset(assets, (name) => /\.AppImage$/i.test(name), "Linux (.AppImage)"),
        linuxDeb: asset(assets, (name) => /\.deb$/i.test(name), "Linux (.deb)"),
      },
    };
  } catch {
    return FALLBACK_RELEASE;
  }
}

function versionParts(version: string): [number, number, number] | null {
  const match = /^app-v(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareMobileReleases(left: GitHubRelease, right: GitHubRelease): number {
  const a = versionParts(left.tag_name ?? "");
  const b = versionParts(right.tag_name ?? "");
  if (!a || !b) return 0;
  return b[0] - a[0] || b[1] - a[1] || b[2] - a[2];
}

export async function getLatestMobileRelease(): Promise<LatestMobileRelease> {
  try {
    const response = await fetch(MOBILE_API_URL, {
      headers: { Accept: "application/vnd.github+json" },
      next: { revalidate: 600 },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) return FALLBACK_MOBILE_RELEASE;

    const releases = (await response.json()) as GitHubRelease[];
    const release = releases
      .filter((item) => !item.draft && !item.prerelease && versionParts(item.tag_name ?? ""))
      .sort(compareMobileReleases)
      .find((item) => item.assets?.some(({ name }) => /\.apk$/i.test(name)));
    if (!release) return FALLBACK_MOBILE_RELEASE;

    const apk = release.assets?.find(({ name }) => /\.apk$/i.test(name));
    if (!apk) return FALLBACK_MOBILE_RELEASE;
    const checksum = release.assets?.find(({ name }) => /\.sha256$/i.test(name));
    const version = release.tag_name?.slice("app-v".length) ?? "最新版本";

    return {
      version,
      isFallback: false,
      url: release.html_url ?? MOBILE_RELEASES_URL,
      apkUrl: apk.browser_download_url,
      checksumUrl: checksum?.browser_download_url ?? null,
    };
  } catch {
    return FALLBACK_MOBILE_RELEASE;
  }
}
