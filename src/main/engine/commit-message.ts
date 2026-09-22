export type CommitFileKind = "source" | "test" | "config" | "docs" | "lock" | "generated" | "binary" | "other";

export type CommitFileMaterial = {
  path: string;
  status: string;
  patch?: string;
  additions?: number;
  deletions?: number;
  kind?: CommitFileKind;
  omitted?: string;
};

export type CommitMessagePlan = {
  mode: "direct" | "hierarchical";
  overview: string;
  groups: string[];
  files: number;
};

export type CommitStatusPath = {
  path: string;
  displayPath: string;
  index: string;
  worktree: string;
};

/** Parse porcelain v1 -z, whose rename order is destination NUL source. */
export function parseCommitPorcelain(output: string): CommitStatusPath[] {
  const fields = output.split("\0");
  const files: CommitStatusPath[] = [];
  for (let index = 0; index < fields.length;) {
    const entry = fields[index++];
    if (!entry || entry.length < 4) continue;
    const indexStatus = entry[0];
    const worktreeStatus = entry[1];
    const path = entry.slice(3);
    if (indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C") {
      const oldPath = fields[index++] ?? "";
      files.push({ path, displayPath: oldPath ? `${oldPath} → ${path}` : path, index: indexStatus, worktree: worktreeStatus });
    } else {
      files.push({ path, displayPath: path, index: indexStatus, worktree: worktreeStatus });
    }
  }
  return files;
}

const LOCK_FILES = /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|uv\.lock|composer\.lock)$/i;
const GENERATED_PATHS = /(?:^|\/)(?:dist|build|out|coverage|vendor|generated|__generated__)(?:\/|$)|(?:\.min\.(?:js|css)|\.map)$/i;
const TEST_PATHS = /(?:^|\/)(?:test|tests|__tests__|spec)(?:\/|$)|(?:\.(?:test|spec)\.[^.]+)$/i;
const DOC_PATHS = /(?:^|\/)(?:docs?|documentation)(?:\/|$)|\.(?:md|mdx|rst|txt)$/i;
const CONFIG_FILES = /(?:^|\/)(?:package\.json|tsconfig[^/]*\.json|eslint[^/]*|vite\.config\.[^/]+|electron-vite\.config\.[^/]+|Dockerfile|docker-compose[^/]*|\.github\/[^/]+)|\.(?:ya?ml|toml|ini|env)$/i;
const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?|py|rb|rs|go|java|kt|swift|php|cs|cpp|cc|c|h|hpp|vue|svelte|css|scss|less|html|sql|graphql)$/i;

const KIND_WEIGHT: Record<CommitFileKind, number> = {
  source: 3,
  config: 3,
  test: 2,
  docs: 1,
  other: 1,
  lock: 0,
  generated: 0,
  binary: 0,
};

export function classifyCommitFile(path: string, patch = ""): CommitFileKind {
  if (LOCK_FILES.test(path)) return "lock";
  if (GENERATED_PATHS.test(path) || /@generated|do not edit/i.test(patch.slice(0, 800))) return "generated";
  if (patch.includes("Binary files ") || /^GIT binary patch$/m.test(patch)) return "binary";
  if (TEST_PATHS.test(path)) return "test";
  if (DOC_PATHS.test(path)) return "docs";
  if (CONFIG_FILES.test(path)) return "config";
  if (SOURCE_EXTENSIONS.test(path)) return "source";
  return "other";
}

export function countPatchLines(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

function topDirectory(path: string): string {
  const slash = path.indexOf("/");
  return slash > 0 ? path.slice(0, slash) : "root";
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  if (limit <= 40) return text.slice(0, Math.max(0, limit));
  const head = Math.ceil((limit - 34) * 0.65);
  const tail = Math.floor((limit - 34) * 0.35);
  return `${text.slice(0, head)}\n... omitted for budget ...\n${text.slice(-tail)}`;
}

/**
 * Keep hunk boundaries visible and sample across a file instead of taking only its
 * beginning. The first and last hunks always win; the largest middle hunks follow.
 */
export function samplePatch(patch: string, budget: number): string {
  if (patch.length <= budget) return patch;
  if (budget <= 0) return "";
  const firstHunk = patch.search(/^@@/m);
  if (firstHunk < 0) return clip(patch, budget);
  const header = patch.slice(0, firstHunk);
  const hunks = patch.slice(firstHunk).split(/(?=^@@)/m).filter(Boolean);
  const chosen: number[] = [];
  const add = (index: number): void => {
    if (index >= 0 && index < hunks.length && !chosen.includes(index)) chosen.push(index);
  };
  add(0);
  add(hunks.length - 1);
  [...hunks.keys()].sort((a, b) => hunks[b].length - hunks[a].length).forEach(add);

  let output = clip(header, Math.min(header.length, Math.max(160, Math.floor(budget * 0.15))));
  for (const index of chosen) {
    const remaining = budget - output.length - 2;
    if (remaining <= 80) break;
    const slots = Math.max(1, chosen.length - chosen.indexOf(index));
    output += `\n\n${clip(hunks[index], Math.min(remaining, Math.max(300, Math.floor(remaining / slots))))}`;
  }
  return clip(output, budget);
}

function metadataLine(file: CommitFileMaterial): string {
  const stats = typeof file.additions === "number" || typeof file.deletions === "number"
    ? ` (+${file.additions ?? 0} -${file.deletions ?? 0})`
    : "";
  const kind = file.kind ?? classifyCommitFile(file.path, file.patch);
  const omitted = file.omitted ? ` [${file.omitted}]` : KIND_WEIGHT[kind] === 0 ? ` [${kind}: metadata only]` : "";
  return `${file.status.padEnd(2, " ")} ${file.path}${stats}${omitted}`;
}

function allocateBudgets(files: CommitFileMaterial[], available: number, perFileCap: number): Map<string, number> {
  const eligible = files.filter((file) => KIND_WEIGHT[file.kind ?? classifyCommitFile(file.path, file.patch)] > 0 && file.patch);
  const result = new Map<string, number>();
  if (eligible.length === 0 || available <= 0) return result;
  const base = Math.min(600, Math.floor(available / eligible.length));
  let remaining = available;
  for (const file of eligible) {
    const amount = Math.min(base, perFileCap, file.patch?.length ?? 0);
    result.set(file.path, amount);
    remaining -= amount;
  }
  const weighted = eligible.map((file) => {
    const kind = file.kind ?? classifyCommitFile(file.path, file.patch);
    const churn = (file.additions ?? 0) + (file.deletions ?? 0);
    return { file, weight: KIND_WEIGHT[kind] * Math.sqrt(churn + 1) };
  });
  while (remaining > 0) {
    const open = weighted.filter(({ file }) => (result.get(file.path) ?? 0) < Math.min(perFileCap, file.patch?.length ?? 0));
    if (open.length === 0) break;
    const totalWeight = open.reduce((sum, item) => sum + item.weight, 0) || open.length;
    let spent = 0;
    let roundRemaining = remaining;
    for (const item of open) {
      if (roundRemaining <= 0) break;
      const current = result.get(item.file.path) ?? 0;
      const cap = Math.min(perFileCap, item.file.patch?.length ?? 0);
      const share = Math.min(roundRemaining, Math.max(1, Math.floor(remaining * ((item.weight || 1) / totalWeight))));
      const next = Math.min(cap, current + share);
      result.set(item.file.path, next);
      spent += next - current;
      roundRemaining -= next - current;
    }
    if (spent === 0) break;
    remaining -= spent;
  }
  return result;
}

function renderFiles(files: CommitFileMaterial[], budget: number, perFileCap: number): string {
  const metadata = files.map(metadataLine).join("\n");
  const base = `Files:\n${metadata}`;
  const candidates = files.filter((file) => file.patch && KIND_WEIGHT[file.kind ?? classifyCommitFile(file.path, file.patch)] > 0);
  const wrapperCost = candidates.reduce((sum, file) => sum + file.path.length + 7, 24);
  const budgets = allocateBudgets(files, Math.max(0, budget - base.length - wrapperCost), perFileCap);
  const details: string[] = [];
  for (const file of files) {
    const allowance = budgets.get(file.path) ?? 0;
    if (!allowance || !file.patch) continue;
    details.push(`### ${file.path}\n${samplePatch(file.patch, allowance)}`);
  }
  const rendered = `${base}${details.length ? `\n\nSampled diffs:\n${details.join("\n\n")}` : ""}`;
  return rendered.length <= budget ? rendered : clip(rendered, budget);
}

/** Build a deterministic direct prompt or at most eight directory-based summary groups. */
export function buildCommitMessagePlan(
  input: CommitFileMaterial[],
  options: { directBudget?: number; groupBudget?: number; maxGroups?: number } = {},
): CommitMessagePlan {
  const directBudget = options.directBudget ?? 80_000;
  const groupBudget = options.groupBudget ?? 36_000;
  const maxGroups = options.maxGroups ?? 8;
  const files = input.map((file) => {
    const patch = file.patch ?? "";
    const stats = typeof file.additions === "number" && typeof file.deletions === "number"
      ? { additions: file.additions, deletions: file.deletions }
      : countPatchLines(patch);
    return { ...file, ...stats, kind: file.kind ?? classifyCommitFile(file.path, patch) };
  });
  const fullOverview = [
    `Changed files: ${files.length}`,
    ...files.map(metadataLine),
  ].join("\n");
  const rawSize = fullOverview.length + files.reduce((sum, file) => {
    const kind = file.kind ?? classifyCommitFile(file.path, file.patch);
    return sum + (KIND_WEIGHT[kind] > 0 ? file.patch?.length ?? 0 : 0);
  }, 0);
  const churn = files.reduce((sum, file) => sum + (file.additions ?? 0) + (file.deletions ?? 0), 0);
  const hierarchical = rawSize > directBudget || files.length > 80 || churn > 8_000;
  if (!hierarchical) {
    return { mode: "direct", overview: fullOverview, groups: [renderFiles(files, directBudget, 6_000)], files: files.length };
  }

  const metadataSize = files.reduce((sum, file) => sum + metadataLine(file).length + 1, 0);
  if (metadataSize > maxGroups * Math.floor(groupBudget * 0.65)) {
    throw new Error(`Too many changed paths to summarize safely (${files.length})`);
  }
  const byDirectory = new Map<string, CommitFileMaterial[]>();
  for (const file of files) {
    const key = topDirectory(file.path);
    const group = byDirectory.get(key) ?? [];
    group.push(file);
    byDirectory.set(key, group);
  }
  const targetMetadata = Math.max(400, Math.floor(groupBudget * 0.45));
  const chunks: CommitFileMaterial[][] = [];
  for (const directoryFiles of byDirectory.values()) {
    let chunk: CommitFileMaterial[] = [];
    let size = 0;
    for (const file of directoryFiles) {
      const nextSize = metadataLine(file).length + 1;
      if (chunk.length > 0 && size + nextSize > targetMetadata) {
        chunks.push(chunk);
        chunk = [];
        size = 0;
      }
      chunk.push(file);
      size += nextSize;
    }
    if (chunk.length > 0) chunks.push(chunk);
  }
  const bucketCount = Math.min(maxGroups, Math.max(1, chunks.length));
  const buckets = Array.from({ length: bucketCount }, () => [] as CommitFileMaterial[]);
  const bucketSizes = new Array(bucketCount).fill(0) as number[];
  chunks
    .map((chunk) => ({ chunk, size: chunk.reduce((sum, file) => sum + metadataLine(file).length + 1, 0) }))
    .sort((a, b) => b.size - a.size)
    .forEach(({ chunk, size }) => {
      let target = 0;
      for (let index = 1; index < bucketSizes.length; index += 1) {
        if (bucketSizes[index] < bucketSizes[target]) target = index;
      }
      buckets[target].push(...chunk);
      bucketSizes[target] += size;
    });
  const kindCounts = new Map<CommitFileKind, number>();
  const areaCounts = new Map<string, number>();
  for (const file of files) {
    const kind = file.kind ?? classifyCommitFile(file.path, file.patch);
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
    const area = topDirectory(file.path);
    areaCounts.set(area, (areaCounts.get(area) ?? 0) + 1);
  }
  const overview = [
    `Changed files: ${files.length}`,
    `Kinds: ${[...kindCounts].map(([kind, count]) => `${kind} ${count}`).join(", ")}`,
    `Areas: ${[...areaCounts].slice(0, 20).map(([area, count]) => `${area} ${count}`).join(", ")}${areaCounts.size > 20 ? `, and ${areaCounts.size - 20} more` : ""}`,
  ].join("\n");
  const groups = buckets.filter((bucket) => bucket.length > 0).map((group) => renderFiles(group, groupBudget, 4_000));
  return { mode: "hierarchical", overview, groups, files: files.length };
}
