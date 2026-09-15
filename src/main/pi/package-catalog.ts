import type { MarketPackage, MarketPackageQuery, MarketPackagePage } from "@shared/types";

/**
 * pi's public package catalog (https://pi.dev/packages) is a server-rendered
 * page — there is no JSON API. The list markup is stable and carries everything
 * the market needs in `data-package-*` attributes plus the card body, so the
 * catalog is read by parsing that HTML rather than by scraping visually.
 */
const CATALOG_URL = "https://pi.dev/packages";
const CACHE_TTL_MS = 5 * 60 * 1000;

type CacheEntry = { at: number; page: MarketPackagePage };
const cache = new Map<string, CacheEntry>();

export class PackageCatalogError extends Error {}

function cacheKey(query: Required<MarketPackageQuery>): string {
  return `${query.query}\u0000${query.type}\u0000${query.sort}\u0000${query.page}`;
}

export async function fetchPackageCatalog(query: MarketPackageQuery = {}): Promise<MarketPackagePage> {
  const normalized: Required<MarketPackageQuery> = {
    query: query.query?.trim() ?? "",
    type: query.type ?? "",
    sort: query.sort ?? "downloads",
    page: Math.max(1, Math.floor(query.page ?? 1)),
  };
  const key = cacheKey(normalized);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.page;

  const url = new URL(CATALOG_URL);
  if (normalized.query) url.searchParams.set("name", normalized.query);
  if (normalized.type) url.searchParams.set("type", normalized.type);
  url.searchParams.set("sort", normalized.sort);
  if (normalized.page > 1) url.searchParams.set("page", String(normalized.page));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let html: string;
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "text/html",
        "user-agent": "FastVibe",
      },
    });
    if (!response.ok) throw new PackageCatalogError(`插件市场返回 ${response.status}`);
    html = await response.text();
  } catch (error) {
    if (error instanceof PackageCatalogError) throw error;
    throw new PackageCatalogError("无法连接插件市场，请检查网络后重试");
  } finally {
    clearTimeout(timer);
  }

  const page = parseCatalogPage(html, normalized);
  cache.set(key, { at: Date.now(), page });
  return page;
}

export function parseCatalogPage(
  html: string,
  normalized: Required<MarketPackageQuery>,
): MarketPackagePage {
  const packages: MarketPackage[] = [];
  const articlePattern = /<article\b[^>]*data-package-card="true"[^>]*>([\s\S]*?)<\/article>/g;
  for (const match of html.matchAll(articlePattern)) {
    const block = match[0];
    const name = attribute(block, "data-package-name");
    if (!name) continue;
    packages.push({
      name,
      description: decodeEntities(text(block, /<p class="packages-desc">([\s\S]*?)<\/p>/)),
      author: decodeEntities(metaSpans(block)[0] ?? ""),
      types: (attribute(block, "data-package-types") ?? "").split(/\s+/).filter(Boolean),
      downloads: numberAttribute(block, "data-package-downloads"),
      updatedAt: numberAttribute(block, "data-package-date"),
      version: versionOf(block),
      npmUrl: linkHref(block, /href="(https:\/\/www\.npmjs\.com\/package\/[^"]+)"/),
      repoUrl: linkHref(block, /href="(https:\/\/github\.com\/[^"]+)"/),
    });
  }

  return {
    packages,
    query: normalized.query,
    type: normalized.type,
    sort: normalized.sort,
    page: normalized.page,
    total: totalCount(html),
    totalPages: totalPages(html),
  };
}

function attribute(block: string, name: string): string | undefined {
  const match = block.match(new RegExp(`${name}="([^"]*)"`));
  return match ? decodeEntities(match[1]) : undefined;
}

function numberAttribute(block: string, name: string): number | undefined {
  const value = attribute(block, name);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function text(block: string, pattern: RegExp): string {
  const match = block.match(pattern);
  return match ? match[1].replace(/<[^>]*>/g, "").trim() : "";
}

function linkHref(block: string, pattern: RegExp): string | undefined {
  const match = block.match(pattern);
  return match ? decodeEntities(match[1]) : undefined;
}

function metaSpans(block: string): string[] {
  const container = block.match(/<div class="packages-meta">([\s\S]*?)<\/div>/);
  if (!container) return [];
  return [...container[1].matchAll(/<span>([\s\S]*?)<\/span>/g)].map((item) =>
    item[1].replace(/<[^>]*>/g, "").trim(),
  );
}

function versionOf(block: string): string | undefined {
  const match = block.match(/package-version=([0-9][^"&]*)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function totalCount(html: string): number | undefined {
  const match = html.match(/class="packages-count">[^<]*\/\s*(\d+)/);
  return match ? Number(match[1]) : undefined;
}

function totalPages(html: string): number | undefined {
  const nav = html.match(/class="pagination-pages"[\s\S]*?<\/div>/);
  if (!nav) return undefined;
  let max = 0;
  for (const item of nav[0].matchAll(/page=(\d+)/g)) max = Math.max(max, Number(item[1]));
  const active = nav[0].match(/aria-current="page">(\d+)</);
  if (active) max = Math.max(max, Number(active[1]));
  return max || undefined;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_all, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_all, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (all, name: string) => ENTITIES[name.toLowerCase()] ?? all);
}
