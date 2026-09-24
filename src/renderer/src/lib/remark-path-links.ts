import type { Plugin } from "unified";

/**
 * Turns Unix-looking file paths in prose into links. Code, existing links and math
 * are deliberately left alone: a command or an example URL must remain copyable as
 * written rather than becoming an action by accident.
 */
export const remarkPathLinks: Plugin = () => (tree) => {
  rewriteChildren((tree as MdNode).children ?? [], undefined);
};

const PATH = /(?:^|(?<=[\s("'`]))((?:\/|(?:\.\.?\/)?)[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)/g;
const PATH_LIKE = /^(?:\/|(?:\.\.?\/)?)[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/;

/** Exact path check used for Markdown inline-code spans, such as `src/main/app.ts`. */
export function isPathLike(value: string): boolean {
  return PATH_LIKE.test(value);
}

/**
 * Collect the same path-shaped tokens that the Markdown plugin can turn into links.
 * This is intentionally independent from the AST rewrite: validation is asynchronous
 * and must happen before the renderer is allowed to make any of those tokens clickable.
 */
export function collectPathCandidates(value: string): string[] {
  const candidates = new Set<string>();
  let fence: { marker: "`" | "~"; length: number } | undefined;
  for (const line of value.split(/\r?\n/)) {
    const fenceMatch = /^( {0,3})(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[2]![0] === fence.marker && fenceMatch[2]!.length >= fence.length) fence = undefined;
      continue;
    }
    if (fenceMatch) {
      fence = { marker: fenceMatch[2]![0] as "`" | "~", length: fenceMatch[2]!.length };
      continue;
    }
    // Indented code blocks are also skipped by remarkPathLinks. Inline code inside
    // prose remains eligible because it is not a full indented block.
    if (/^(?: {4}|\t)/.test(line)) continue;
    PATH.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PATH.exec(line))) candidates.add(match[1]!);
  }
  return [...candidates];
}

function rewriteChildren(nodes: MdNode[], parentType: string | undefined): void {
  if (parentType === "link" || parentType === "linkReference" || parentType === "inlineCode" || parentType === "code" || parentType === "math" || parentType === "inlineMath") return;
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (node.type === "text" && node.value) {
      const replacement = pathLinks(node.value);
      if (replacement) nodes.splice(index, 1, ...replacement);
      index += replacement ? replacement.length - 1 : 0;
      continue;
    }
    if (node.children) rewriteChildren(node.children, node.type);
  }
}

function pathLinks(value: string): MdNode[] | undefined {
  PATH.lastIndex = 0;
  const result: MdNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = PATH.exec(value))) {
    const path = match[1];
    const start = match.index + match[0].length - path.length;
    if (start > cursor) result.push({ type: "text", value: value.slice(cursor, start) });
    result.push({ type: "link", url: `fvpath:${encodeURIComponent(path)}`, children: [{ type: "text", value: path }] });
    cursor = start + path.length;
  }
  if (result.length === 0) return undefined;
  if (cursor < value.length) result.push({ type: "text", value: value.slice(cursor) });
  return result;
}

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}
