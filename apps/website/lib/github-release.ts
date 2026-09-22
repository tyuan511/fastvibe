const REPOSITORY = "tyuan511/fastvibe";
const RELEASES_URL = `https://github.com/${REPOSITORY}/releases/latest`;
const API_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;

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

type GitHubAsset = {
  name: string;
  browser_download_url: string;
};

type GitHubRelease = {
  tag_name?: string;
  html_url?: string;
  published_at?: string;
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
