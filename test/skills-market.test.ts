import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  frontmatterOf,
  githubSourceOf,
  marketSkillDirName,
  metaDescriptionOf,
  parseSearchResults,
  safeRelativePath,
  stageFromArchive,
  SkillMarketError,
} from "../src/main/engine/skills-market.ts";
import { walkTarGzip } from "../src/main/engine/gzip-tar.ts";

/**
 * The market install path is a format parser plus a set of matching rules, and every one
 * of them is what stands between "installed" and "installed the wrong thing". These
 * tests speak to a tar.gz built here — GitHub's archive of `vercel-labs/agent-skills` is
 * the shape it reproduces: a `<repo>-HEAD/` root, the POSIX `prefix` field for long
 * paths, and a skill whose directory name is *not* the name skills.sh publishes.
 */

const SPLIT = 512;

function header(fields: {
  name: string;
  prefix?: string;
  size: number;
  type: string;
  linkname?: string;
}): Buffer {
  const block = Buffer.alloc(SPLIT);
  write(block, 0, 100, fields.name);
  write(block, 100, 8, "0000644");
  write(block, 108, 8, "0000000");
  write(block, 116, 8, "0000000");
  write(block, 124, 12, fields.size.toString(8).padStart(11, "0"));
  write(block, 136, 12, "00000000000");
  block[156] = fields.type.charCodeAt(0);
  write(block, 157, 100, fields.linkname ?? "");
  write(block, 257, 8, "ustar\0");
  write(block, 263, 8, "00");
  write(block, 345, 155, fields.prefix ?? "");
  // The checksum field is read as spaces, then written as an octal sum.
  write(block, 148, 8, "        ");
  let sum = 0;
  for (const byte of block) sum += byte;
  write(block, 148, 8, sum.toString(8).padStart(7, "0"));
  return block;
}

function write(block: Buffer, offset: number, length: number, value: string): void {
  const raw = Buffer.from(value, "utf8").subarray(0, length);
  block.set(raw, offset);
}

function data(bytes: Buffer): Buffer {
  const pad = Math.ceil(bytes.length / SPLIT) * SPLIT;
  return Buffer.concat([bytes, Buffer.alloc(pad - bytes.length)]);
}

/** One entry, split the way GNU tar splits a path longer than 100 bytes. */
function entry(path: string, content: string, type = "0"): Buffer[] {
  const bytes = Buffer.from(content, "utf8");
  const split = splitPath(path);
  return [
    header({ ...split, size: bytes.length, type, linkname: type === "2" ? content : "" }),
    ...(type === "2" ? [] : [data(bytes)]),
  ];
}

function splitPath(path: string): { name: string; prefix?: string } {
  if (path.length <= 100) return { name: path };
  const cut = path.lastIndexOf("/", path.length - 99 > 0 ? path.length - 99 : 1);
  return { name: path.slice(cut + 1), prefix: path.slice(0, cut) };
}

function directory(path: string): Buffer[] {
  return [header({ ...splitPath(path), size: 0, type: "5" })];
}

function buildArchive(entries: Buffer[][]): Buffer {
  return gzipSync(Buffer.concat([...entries.flat(), Buffer.alloc(SPLIT * 2)]));
}

async function fixture(files: Record<string, string>, extra: Buffer[][] = []): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fv-market-"));
  const archive = join(dir, "source.tar.gz");
  const blocks: Buffer[][] = [];
  for (const [path, content] of Object.entries(files)) blocks.push(...entry(path, content));
  await writeFile(archive, buildArchive([...blocks, ...extra]));
  return dir;
}

const SKILL_MD = "---\nname: vercel-react-best-practices\ndescription: React performance rules.\n---\n\n# Vercel React Best Practices\n";

test("the long-name split round-trips through the walker", async () => {
  const long = `repo-HEAD/skills/react-best-practices/references/${"x".repeat(90)}/rule.md`;
  const dir = await fixture({ "repo-HEAD/skills/react-best-practices/SKILL.md": SKILL_MD });
  try {
    const archive = join(dir, "source.tar.gz");
    await writeFile(archive, buildArchive([...entry(long, "rule"), ...entry("repo-HEAD/skills/react-best-practices/SKILL.md", SKILL_MD)]));
    const seen: string[] = [];
    for await (const item of walkTarGzip(archive, () => false)) seen.push(item.path);
    assert.ok(seen.includes(long), "a prefix-field path must come back whole");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("GNU long names and PAX path overrides both come back whole", async () => {
  // GitHub's own archives use the prefix field (covered above). Other archive makers use
  // a long-name block or a PAX header, and a parser that misses either silently drops
  // the skill it sits on — the SKILL.md would never be read, so the install would say
  // "this repository has no such skill".
  const deep = `repo-HEAD/skills/web-design-guidelines/references/${"very-long-directory-".repeat(6)}rule.md`;
  const blocks: Buffer[][] = [
    ...longNameEntry(deep, "a rule"),
    ...paxEntry("repo-HEAD/skills/web-design-guidelines/SKILL.md", SKILL_MD),
  ];
  const dir = await mkdtemp(join(tmpdir(), "fv-market-"));
  const archive = join(dir, "source.tar.gz");
  await writeFile(archive, buildArchive(blocks));
  const staging = join(dir, "staging");
  try {
    const paths: string[] = [];
    for await (const item of walkTarGzip(archive, () => false)) paths.push(item.path);
    assert.ok(paths.includes(deep), `long-name block must survive: ${paths.join(" ")}`);
    const staged = await stageFromArchive(archive, "vercel-react-best-practices", staging);
    assert.equal(staged.name, "vercel-react-best-practices");
    assert.equal(staged.files, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** An entry whose name lives in the block before it, the way GNU tar writes it. */
function longNameEntry(path: string, content: string): Buffer[][] {
  const name = Buffer.from(path, "utf8");
  return [
    [header({ name: "././@LongLink", size: name.length + 1, type: "L" }), data(Buffer.concat([name, Buffer.from([0])]))],
    ...entry(path.slice(0, 99), content),
  ];
}

/** An entry whose real path is declared by the PAX record before it. */
function paxEntry(path: string, content: string): Buffer[][] {
  const record = ` ${path.length} path=${path}\n`;
  const bytes = Buffer.from(record, "utf8");
  return [
    [header({ name: "PaxHeaders.0/SKILL.md", size: bytes.length, type: "x" }), data(bytes)],
    ...entry(path, content),
  ];
}

test("an install matches the SKILL.md name, not the directory it happens to live in", async () => {
  const dir = await fixture({
    // skills.sh publishes `vercel-react-best-practices`; the repository's folder is `react-best-practices`.
    "agent-skills-HEAD/skills/react-best-practices/SKILL.md": SKILL_MD,
    "agent-skills-HEAD/skills/react-best-practices/rules/async.md": "async rule",
    "agent-skills-HEAD/skills/web-design-guidelines/SKILL.md": "---\nname: web-design-guidelines\ndescription: Design.\n---\n",
  });
  const staging = join(dir, "staging");
  try {
    const staged = await stageFromArchive(join(dir, "source.tar.gz"), "vercel-react-best-practices", staging);
    assert.equal(staged.name, "vercel-react-best-practices");
    assert.equal(staged.files, 2);
    assert.equal(staged.description, "React performance rules.");
    assert.equal(await readFile(join(staged.dir, "SKILL.md"), "utf8"), SKILL_MD);
    assert.equal(await readFile(join(staged.dir, "rules/async.md"), "utf8"), "async rule");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a SKILL.md without frontmatter is refused as what it is", async () => {
  // The SDK reads name + description from the same block, so installing it would add a
  // row that never works — and "找不到该技能" would send the reader looking in the wrong place.
  const dir = await fixture({ "repo-HEAD/skills/pdf/SKILL.md": "# pdf skill, no frontmatter\n" });
  const staging = join(dir, "staging");
  try {
    await assert.rejects(
      () => stageFromArchive(join(dir, "source.tar.gz"), "pdf", staging),
      /没有 name \/ description 头/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a skill whose frontmatter has no name falls back to its directory", async () => {
  const dir = await fixture({ "repo-HEAD/skills/pdf/SKILL.md": "---\ndescription: Only a description\n---\n" });
  const staging = join(dir, "staging");
  try {
    const staged = await stageFromArchive(join(dir, "source.tar.gz"), "pdf", staging);
    assert.equal(staged.name, "pdf");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a missing skill says what the repository does hold", async () => {
  const dir = await fixture({
    "repo-HEAD/skills/one/SKILL.md": "---\nname: one\ndescription: a\n---\n",
    "repo-HEAD/skills/two/SKILL.md": "---\nname: two\ndescription: b\n---\n",
  });
  const staging = join(dir, "staging");
  try {
    await assert.rejects(
      () => stageFromArchive(join(dir, "source.tar.gz"), "nope", staging),
      (error: unknown) => {
        assert.ok(error instanceof SkillMarketError);
        assert.match((error as Error).message, /找不到「nope」/);
        assert.match((error as Error).message, /one、two/);
        return true;
      },
    );
    // The failed install must not leave a half directory behind for the pane to list.
    assert.deepEqual(await readdir(staging).catch(() => []), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a link inside the archive is skipped, never followed", async () => {
  const blocks: Buffer[][] = [
    ...entry("repo-HEAD/skills/pdf/SKILL.md", "---\nname: pdf\ndescription: d\n---\n"),
    ...entry("repo-HEAD/skills/pdf/escape", "/etc/passwd", "2"),
  ];
  const dir = await mkdtemp(join(tmpdir(), "fv-market-"));
  const archive = join(dir, "source.tar.gz");
  await writeFile(archive, buildArchive(blocks));
  const staging = join(dir, "staging");
  try {
    const staged = await stageFromArchive(archive, "pdf", staging);
    assert.equal(staged.skipped, 1);
    assert.deepEqual(await readdir(staged.dir), ["SKILL.md"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("what a clean install reports as skipped is only this skill\u2019s own links", async () => {
  // The walker yields every header it read. Counting the ones outside the skill is how a
  // repository with 35 unrelated directories reported "36 skipped" for a clean install.
  const blocks: Buffer[][] = [
    ...entry("repo-HEAD/skills/pdf/SKILL.md", "---\nname: pdf\ndescription: d\n---\n"),
    ...directory("repo-HEAD/skills/pdf/references"),
    ...entry("repo-HEAD/skills/pdf/references/a.md", "a"),
    ...entry("repo-HEAD/README.md", "readme"),
    ...directory("repo-HEAD/docs"),
    ...entry("repo-HEAD/docs/escape", "/etc/passwd", "2"),
  ];
  const dir = await mkdtemp(join(tmpdir(), "fv-market-"));
  const archive = join(dir, "source.tar.gz");
  await writeFile(archive, buildArchive(blocks));
  try {
    const staged = await stageFromArchive(archive, "pdf", join(dir, "staging"));
    assert.equal(staged.files, 2);
    assert.equal(staged.skipped, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the search index shape is read, and a page of HTML is not mistaken for no results", () => {
  const json = JSON.stringify({
    skills: [
      { id: "anthropics/skills/frontend-design", source: "anthropics/skills", skillId: "frontend-design", name: "frontend-design", installs: 1015978 },
      { id: "developer.paddle.com/paddle-webhooks", source: "developer.paddle.com", skillId: "paddle-webhooks", name: "paddle-webhooks", installs: 2160 },
      { source: "", skillId: "", name: "junk" },
    ],
  });
  const entries = parseSearchResults(json);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].installs, 1015978);
  assert.equal(entries[0].installable, true);
  assert.equal(entries[0].pageUrl, "https://www.skills.sh/anthropics/skills/frontend-design");
  // A bare host is not a repository FastVibe can fetch — the row says so instead of failing on click.
  assert.equal(entries[1].installable, false);
  assert.throws(() => parseSearchResults("<html><body>sign in</body></html>"), SkillMarketError);
  assert.throws(() => parseSearchResults(JSON.stringify({ error: "no skills" })), SkillMarketError);
});

test("only a GitHub owner/repo is fetchable", () => {
  assert.deepEqual(githubSourceOf("vercel/next.js"), { owner: "vercel", repo: "next.js" });
  assert.deepEqual(githubSourceOf("  vercel-labs/agent-skills  "), { owner: "vercel-labs", repo: "agent-skills" });
  assert.equal(githubSourceOf("developer.paddle.com"), null);
  assert.equal(githubSourceOf("skills.volces.com"), null);
  assert.equal(githubSourceOf("a/b/c"), null);
  // A full URL is not the shape the index answers with; it is refused, not guessed at.
  assert.equal(githubSourceOf("https://github.com/foo/bar"), null);
});

test("the description comes from the page's own meta tag", () => {
  const html = '<html><head><meta name="description" content="React &amp; Next.js guidelines from Vercel.  This&nbsp;triggers on tasks."/></head></html>';
  assert.equal(metaDescriptionOf(html), "React & Next.js guidelines from Vercel. This triggers on tasks.");
  assert.equal(metaDescriptionOf("<html></html>"), "");
});

test("frontmatter is read without a YAML parser, and folded text keeps its first line", () => {
  assert.deepEqual(frontmatterOf(SKILL_MD), { name: "vercel-react-best-practices", description: "React performance rules." });
  assert.deepEqual(
    frontmatterOf('---\nname: "quoted-skill"\ndescription: "a \\"quoted\\" one"\n---\n\nbody\n'),
    { name: "quoted-skill", description: 'a "quoted" one' },
  );
  assert.deepEqual(
    frontmatterOf("---\nname: folded\ndescription: >\n  first line\n  second line\n---\n"),
    { name: "folded", description: "first line" },
  );
  // A nested map after the two fields must not touch them. `metadata:` with no value is
  // what every SKILL.md in vercel-labs/agent-skills carries, and reading it as the name
  // is how the most-installed skill in the index stopped matching at all.
  assert.deepEqual(
    frontmatterOf("---\nname: real-name\ndescription: d\nlicense: MIT\nmetadata:\n  author: vercel\n  version: \"1.0.0\"\n---\n"),
    { name: "real-name", description: "d" },
  );
  assert.equal(frontmatterOf("# no frontmatter here"), null);
  // A reply that quotes SKILL.md is not frontmatter unless it starts the file.
  assert.equal(frontmatterOf("# title\n---\nname: not-read\ndescription: nope\n---\n"), null);
});

test("an archive path is only ever a path below the directory being written", () => {
  const root = "/skills/react-best-practices";
  assert.equal(safeRelativePath("rules/async.md", root), "rules/async.md");
  // A `..` segment is refused even where it would fold back inside: a source archive
  // never contains one, so accepting it would only widen what a crafted tar could ask for.
  assert.equal(safeRelativePath("./a/../b.md", root), null);
  assert.equal(safeRelativePath("../escape.md", root), null);
  assert.equal(safeRelativePath("rules/../../escape.md", root), null);
  // tar itself strips a leading slash when extracting; the containment check below the
  // join is what makes it safe, so an absolute entry lands inside and cannot escape.
  assert.equal(safeRelativePath("/absolute.md", root), "absolute.md");
  assert.equal(safeRelativePath("C:/Windows/system32", root), null);
  assert.equal(safeRelativePath("a\u0000b.md", root), null);
  assert.equal(safeRelativePath("SKILL.md\u0000.txt", root), null);
  assert.equal(safeRelativePath("", root), null);
});

test("a skill directory is named so the pane can still delete it", () => {
  assert.equal(marketSkillDirName("vercel-react-best-practices"), "vercel-react-best-practices");
  assert.equal(marketSkillDirName("  适童化装修指南  "), "适童化装修指南");
  assert.equal(marketSkillDirName("a/b:c*d"), "a-b-c-d");
  assert.equal(marketSkillDirName("..hidden"), "hidden");
  assert.throws(() => marketSkillDirName("../.."), SkillMarketError);
});
