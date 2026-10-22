import { createWriteStream } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { TarArchiveError, walkTarGzip } from "./gzip-tar.ts";
import type { SkillMarketDetail, SkillMarketEntry, SkillMarketTarget } from "../../shared/types.ts";

/**
 * skills.sh — the directory the `npx skills` CLI and https://skills.sh both sit on.
 *
 * FastVibe used to reach it only through the `find-skills` skill, which shells out to
 * `npx skills add`. That works, and it is also the whole reason the feature felt
 * second-hand: the agent has to guess global-or-project, the CLI writes to whichever
 * directory its `--agent` flag maps to (which is not always the one FastVibe reads —
 * `universal` lands in `~/.config/agents/skills`), the download needs a Node toolchain
 * on PATH, and nothing on screen ever showed what was available.
 *
 * This module is the product version of the same two steps: **search the index, then
 * fetch and write the skill**, into the directory 设置 → 技能 already owns, so an
 * installed row is deletable there and looks exactly like one the user wrote by hand.
 *
 * Two facts about the index shape the design:
 *
 * - `/api/search` answers with slug, source and install count only — no description. So
 *   a description is fetched from the skill's own page when the reader asks for one
 *   (`fetchMarketSkillDetail`), never for all thirty rows at once.
 * - `skillId` is **not** the directory name inside the repository: skills.sh publishes
 *   the SKILL.md `name:`, and `vercel-labs/agent-skills` keeps `react-best-practices/`
 *   on disk under the name `vercel-react-best-practices`. Matching therefore reads the
 *   frontmatter of every SKILL.md in the archive and falls back to the directory name.
 */

const SITE = "https://www.skills.sh";
const SEARCH_URL = `${SITE}/api/search`;
/** GitHub's archive endpoint: no token, no rate-limit bucket shared with the API. */
const ARCHIVE_URL = "https://codeload.github.com";
/** A source archive is fetched whole, so a huge repository is refused, not extracted. */
const MAX_DOWNLOAD_BYTES = 48 * 1024 * 1024;
const MAX_SKILL_FILES = 400;
const MAX_SKILL_BYTES = 24 * 1024 * 1024;
const SEARCH_TTL_MS = 5 * 60 * 1000;
const SEARCH_LIMIT = 30;
const FETCH_TIMEOUT_MS = 20_000;

export class SkillMarketError extends Error {}

const searchCache = new Map<string, { at: number; entries: SkillMarketEntry[] }>();

/** `owner/repo` is the only shape FastVibe can fetch itself; a bare host is not. */
export function githubSourceOf(source: string): { owner: string; repo: string } | null {
  const match = /^([\w.-]+)\/([\w.-]+)$/.exec(source.trim());
  if (!match) return null;
  const [, owner, repo] = match;
  if (!owner || !repo || owner === "." || repo === ".") return null;
  return { owner, repo: repo.replace(/\.git$/, "") };
}

export function marketPageUrl(source: string, skillId: string): string {
  return `${SITE}/${source}/${skillId}`;
}

export async function searchMarketSkills(query: string, options: { refresh?: boolean } = {}): Promise<SkillMarketEntry[]> {
  const needle = query.trim();
  if (needle.length < 2) throw new SkillMarketError("至少输入 2 个字符");
  const key = needle.toLowerCase();
  const hit = searchCache.get(key);
  if (!options.refresh && hit && Date.now() - hit.at < SEARCH_TTL_MS) return hit.entries;
  const url = new URL(SEARCH_URL);
  url.searchParams.set("q", needle);
  url.searchParams.set("limit", String(SEARCH_LIMIT));
  const body = await readResponse(url, "application/json");
  const entries = parseSearchResults(body);
  searchCache.set(key, { at: Date.now(), entries });
  return entries;
}

/**
 * The index replies with `{skills: [{id, source, skillId, name, installs}]}`.
 * Anything shaped differently (the site changed, a captive network answered an HTML
 * login page) is a market failure, not an empty result — an empty list would tell the
 * reader there is no such skill.
 */
export function parseSearchResults(json: string): SkillMarketEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new SkillMarketError("技能市场返回了无法解析的内容");
  }
  const rows = (parsed as { skills?: unknown }).skills;
  if (!Array.isArray(rows)) throw new SkillMarketError("技能市场返回了无法解析的内容");
  const entries: SkillMarketEntry[] = [];
  for (const row of rows) {
    const entry = row as Partial<{ id: string; source: string; skillId: string; name: string; installs: number }>;
    if (!entry.source || !entry.skillId) continue;
    entries.push({
      id: entry.id ?? `${entry.source}/${entry.skillId}`,
      source: entry.source,
      skillId: entry.skillId,
      name: entry.name ?? entry.skillId,
      installs: Number.isFinite(entry.installs) ? Number(entry.installs) : 0,
      pageUrl: marketPageUrl(entry.source, entry.skillId),
      installable: githubSourceOf(entry.source) !== null,
    });
  }
  return entries;
}

export async function fetchMarketSkillDetail(entry: SkillMarketTarget): Promise<SkillMarketDetail> {
  const pageUrl = marketPageUrl(entry.source, entry.skillId);
  const html = await readResponse(pageUrl, "text/html");
  return { description: metaDescriptionOf(html), pageUrl };
}

/** `<meta name="description" content="…">` — the page's own one-liner for the skill. */
export function metaDescriptionOf(html: string): string {
  const match =
    /<meta\s+name="description"\s+content="([^"]*)"/i.exec(html) ??
    /<meta\s+content="([^"]*)"\s+name="description"/i.exec(html);
  if (!match) return "";
  return decodeBasicEntities(match[1]).replace(/\s+/g, " ").trim();
}

/**
 * Download a skill from its repository and stage it for installation.
 *
 * `stagingRoot` is a directory the caller owns and will remove; the skill lands in
 * `stagingRoot/<name>`, which `SkillManager.installStaged` then moves into place.
 * Everything is decided before a single file is written, so a repository that turns out
 * to hold no such skill costs a download and changes nothing on disk.
 */
export async function stageMarketSkill(
  target: SkillMarketTarget,
  stagingRoot: string,
  signal?: AbortSignal,
): Promise<{ dir: string; name: string; description: string; files: number; skipped: number }> {
  const source = githubSourceOf(target.source);
  if (!source) throw new SkillMarketError("这个来源不是 GitHub 仓库，请在 skills.sh 页面查看安装方式");
  const skillId = validatedSkillId(target.skillId);

  await mkdir(stagingRoot, { recursive: true });
  const archive = join(stagingRoot, "source.tar.gz");
  try {
    await downloadFile(archiveUrlFor(source), archive, signal);
    return await stageFromArchive(archive, skillId, stagingRoot);
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof TarArchiveError) throw new SkillMarketError(`压缩包读取失败：${error.message}`);
    throw error;
  } finally {
    await rm(archive, { force: true }).catch(() => undefined);
  }
}

/**
 * Pick the skill out of an already-downloaded archive and write it to `stagingRoot`.
 *
 * Split from the download so the matching rules — the whole reason an install can be
 * trusted — are testable against an archive built in a test instead of whatever GitHub
 * serves today.
 */
export async function stageFromArchive(
  archive: string,
  requested: string,
  stagingRoot: string,
): Promise<{ dir: string; name: string; description: string; files: number; skipped: number }> {
  const skillId = validatedSkillId(requested);
  const found = await locateSkill(archive, skillId);
  if (!found) throw new SkillMarketError(await missingSkillMessage(archive, skillId));
  return stageSkillDirectory(archive, found, stagingRoot);
}

function validatedSkillId(value: string): string {
  const skillId = value.trim();
  if (!/^[\w.\u0080-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD-]{1,120}$/.test(skillId) || skillId === "." || skillId === "..") {
    throw new SkillMarketError("技能名不合法");
  }
  return skillId;
}

function archiveUrlFor(source: { owner: string; repo: string }): string {
  return `${ARCHIVE_URL}/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/tar.gz/HEAD`;
}

type SkillHit = {
  /** The directory inside the archive that holds the skill, with its trailing slash. */
  prefix: string;
  name: string;
  description: string;
};

/** Read every SKILL.md frontmatter and pick the one the market calls `skillId`. */
/**
 * Find the skill the market calls `skillId`.
 *
 * A SKILL.md **without** frontmatter is remembered rather than silently ignored:
 * matching it by directory name would install a file the SDK cannot load, and telling
 * the reader "this repository has no such skill" would be the wrong diagnosis.
 */
async function locateSkill(archive: string, skillId: string): Promise<SkillHit | null> {
  const wanted = normalizeName(skillId);
  const hits: SkillHit[] = [];
  const unreadable: string[] = [];
  for await (const entry of walkTarGzip(archive, ({ path, kind }) => kind === "file" && path.endsWith("/SKILL.md"))) {
    if (entry.kind !== "file" || !entry.content) continue;
    const hit = skillHitOf(entry.path, entry.content.toString("utf8"));
    if (!hit) {
      unreadable.push(entry.path);
      continue;
    }
    hits.push(hit);
    if (normalizeName(hit.name) === wanted) return hit;
  }
  const byDirectory = hits.find((hit) => normalizeName(directoryBasename(hit.prefix)) === wanted);
  if (byDirectory) return byDirectory;
  if (unreadable.some((path) => normalizeName(directoryBasename(path.slice(0, path.length - "SKILL.md".length))) === wanted)) {
    throw new SkillMarketError(`「${skillId}」的 SKILL.md 没有 name / description 头，FastVibe 加载不了它`);
  }
  return null;
}

function skillHitOf(path: string, markdown: string): SkillHit | null {
  const prefix = path.slice(0, path.length - "SKILL.md".length);
  const front = frontmatterOf(markdown);
  if (!front) return null;
  const name = front.name || directoryBasename(prefix);
  return { prefix, name, description: front.description ?? "" };
}

/**
 * The `---` block at the top of SKILL.md, read line by line.
 *
 * Deliberately not a YAML parser: the only two fields that matter are `name` and
 * `description`, both scalars. A description written as a block or folded scalar
 * (`|` / `>`, or wrapped onto the next line) is read as its first non-empty line,
 * which is what a row in a results list wants anyway.
 */
export function frontmatterOf(markdown: string): { name: string; description: string } | null {
  const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(markdown);
  if (!match) return null;
  const out = { name: "", description: "" };
  let key = "";
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line);
    if (pair) {
      const raw = pair[2].trim();
      // `|` / `>` (with the chomping modifiers) means the value is the indented block
      // that follows, so it is left empty here and picked up from the next line.
      const scalar = isBlockScalar(raw) ? "" : stripQuotes(raw);
      key = pair[1].toLowerCase();
      // Only the two fields this app reads. Anything else — `license`, or a nested
      // `metadata:` map whose own lines follow indented — must leave `out` alone:
      // writing them here is how `metadata:` with no value wiped the name of every
      // skill in vercel-labs/agent-skills, which is the whole install matching on.
      if (key === "name" || key === "description") out[key] = scalar;
      else key = "";
      continue;
    }
    const folded = line.trim();
    // An indented continuation of the scalar above — a folded or block description —
    // and only its first line, which is the half a results row shows anyway.
    if (folded && !folded.startsWith("#") && /^[ \t]/.test(line) && key && !out[key as "name" | "description"]) {
      out[key as "name" | "description"] = stripQuotes(folded);
    }
  }
  return out.name || out.description ? out : null;
}

/** `|`, `>`, and their `-`/`+`/digit chomping modifiers. */
function isBlockScalar(value: string): boolean {
  return /^[|>][-+\d]*$/.test(value);
}

function stripQuotes(value: string): string {
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1) {
    const inner = value.slice(1, -1);
    return quote === '"' ? inner.replace(/\\(["\\])/g, "$1") : inner.replace(/''/g, "'");
  }
  return value;
}

async function missingSkillMessage(archive: string, skillId: string): Promise<string> {
  const names: string[] = [];
  for await (const entry of walkTarGzip(archive, ({ path, kind }) => kind === "file" && path.endsWith("/SKILL.md"))) {
    if (entry.kind !== "file" || !entry.content) continue;
    const hit = skillHitOf(entry.path, entry.content.toString("utf8"));
    if (hit?.name) names.push(hit.name);
  }
  const listed = names.slice(0, 12).join("、");
  return names.length
    ? `仓库里找不到「${skillId}」。这个仓库的技能有：${listed}${names.length > 12 ? " 等" : ""}`
    : `仓库里没有任何 SKILL.md（${skillId}）`;
}

/** Copy one skill directory out of the archive, keeping only regular files. */
async function stageSkillDirectory(
  archive: string,
  hit: SkillHit,
  stagingRoot: string,
): Promise<{ dir: string; name: string; description: string; files: number; skipped: number }> {
  const name = marketSkillDirName(hit.name);
  const dir = join(stagingRoot, name);
  await mkdir(dir, { recursive: true });
  let files = 0;
  let bytes = 0;
  let skipped = 0;
  try {
    for await (const entry of walkTarGzip(
      archive,
      // Everything under the skill's directory, links included: a symlink is the one
      // entry type that would take the install outside the directory it was given, so
      // it has to be *seen* in order to be counted as skipped.
      ({ path, kind }) => path.startsWith(hit.prefix) && (kind === "file" || kind === "link"),
      { maxEntries: MAX_SKILL_FILES * 4, maxEntryBytes: MAX_SKILL_BYTES },
    )) {
      // The walker hands out every header it read, wanted or not; only this skill's own
      // entries mean anything here. Counting the rest is how a clean install of a
      // repository with 35 unrelated directories reported "36 skipped".
      if (!entry.path.startsWith(hit.prefix)) continue;
      if (entry.kind === "link") {
        skipped += 1;
        continue;
      }
      if (entry.kind !== "file" || !entry.content) continue;
      const relative = entry.path.slice(hit.prefix.length);
      const safe = safeRelativePath(relative, dir);
      if (!safe) {
        skipped += 1;
        continue;
      }
      if (files >= MAX_SKILL_FILES || bytes + entry.content.length > MAX_SKILL_BYTES) {
        throw new SkillMarketError("技能内容过大");
      }
      const dest = join(dir, safe);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, entry.content);
      files += 1;
      bytes += entry.content.length;
    }
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  if (!files) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw new SkillMarketError("技能目录是空的");
  }
  return { dir, name, description: hit.description, files, skipped };
}

/**
 * A path from the archive, judged before it is ever joined to a directory.
 *
 * Absolute paths, `..` hops, drive letters and control characters are refused rather
 * than normalised — `resolve` would fold `a/../../b` out of the staging root, and a
 * skill that needs that is not a skill FastVibe should be writing. The final containment
 * check is made against `root`, so the answer cannot depend on who calls it next.
 */
export function safeRelativePath(relative: string, root: string): string | null {
  const cleaned = relative.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!cleaned || cleaned.includes("\0")) return null;
  const parts = cleaned.split("/").filter((part) => part && part !== ".");
  if (!parts.length || parts.some((part) => part === "..")) return null;
  if (parts.some((part) => /[<>:"|?*]/.test(part) || /[\u0000-\u001f]/.test(part))) return null;
  if (/^[a-zA-Z]:/.test(parts[0])) return null;
  const rebuilt = parts.join(sep);
  const base = resolve(root);
  const target = resolve(base, rebuilt);
  if (target === base || !target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)) return null;
  return rebuilt;
}

/**
 * The directory name for an installed skill: the name SKILL.md declares, kept readable
 * (a Chinese skill name stays Chinese — the market index has plenty of them), with
 * whatever cannot be a filename replaced.
 */
export function marketSkillDirName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .replace(/[\s.]+$/, "")
    .slice(0, 64)
    .replace(/-+/g, "-");
  if (!cleaned || /^[-\s]+$/.test(cleaned)) throw new SkillMarketError("技能名称无法用作目录名");
  return cleaned;
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

function directoryBasename(prefix: string): string {
  const parts = prefix.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] ?? "";
}

function decodeBasicEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_all, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_all, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function readResponse(url: string | URL, accept: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { accept, "user-agent": "FastVibe" },
    });
    if (!response.ok) {
      if (response.status === 400) throw new SkillMarketError("技能市场要求更具体的关键词（至少 2 个字符）");
      throw new SkillMarketError(`技能市场返回 ${response.status}`);
    }
    return await response.text();
  } catch (error) {
    if (error instanceof SkillMarketError) throw error;
    throw new SkillMarketError("无法连接技能市场，请检查网络后重试");
  } finally {
    clearTimeout(timer);
  }
}

async function downloadFile(url: string, dest: string, signal?: AbortSignal): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "follow", headers: { "user-agent": "FastVibe" } });
    if (!response.ok) {
      if (response.status === 404) throw new SkillMarketError("GitHub 上找不到这个仓库，或它没有默认分支");
      throw new SkillMarketError(`下载失败：HTTP ${response.status}`);
    }
    if (!response.body) throw new SkillMarketError("下载失败：没有响应内容");
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > MAX_DOWNLOAD_BYTES) throw new SkillMarketError("仓库过大，请在 skills.sh 页面用命令行安装");
    const file = createWriteStream(dest);
    const reader = response.body.getReader();
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > MAX_DOWNLOAD_BYTES) throw new SkillMarketError("仓库过大，请在 skills.sh 页面用命令行安装");
        if (!file.write(value)) await new Promise<void>((res) => file.once("drain", () => res()));
      }
    } finally {
      file.end();
      await new Promise<void>((res, reject) => {
        file.on("finish", () => res());
        file.on("error", reject);
      });
    }
    if (!received) throw new SkillMarketError("下载失败：文件为空");
  } catch (error) {
    if (error instanceof SkillMarketError) throw error;
    if (controller.signal.aborted) throw new SkillMarketError("下载超时或已取消");
    throw new SkillMarketError("无法下载技能，请检查网络后重试");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
