import type { Plugin } from "unified";

/**
 * Single-dollar inline math, but only when it looks like math.
 *
 * `remark-math`'s default treats any `$…$` pair as math, which is wrong for this app
 * in particular: a reply about shell, config or money is full of `$` — `$HOME/.config`,
 * `$PATH`, `$5 到 $10` — and every one of those came out as a garbled formula.
 * Turning the option off is not the answer either: `$O(n\log n)$` is exactly what
 * people type in a chat about code.
 *
 * So the plugin keeps `remark-math`'s tokenizer — the pairing is already done and
 * correct — and judges the *result*: every `inlineMath` node it produced is re-read
 * from the source and kept only when it satisfies Pandoc's `tex_math_dollars` rules,
 * i.e. `isInlineMathText` below. Display math (`$$…$$`) is never touched; its fences
 * are unambiguous, and neither is math inside code, which never becomes such a node.
 */
export const remarkStrictInlineMath: Plugin = () => (tree, file) => {
  const source = String(file);
  forEachNode(childrenOf(tree), (parent, index, node) => {
    const math = node.type === "inlineMath" || node.type === "math";
    if (!math) return;
    const raw = sourceOf(source, node);
    // An empty `$$` is a `math` node with no value — a display block that would say
    // nothing. Left alone it draws an empty row; as text it reads back as written.
    const empty = (node.value ?? "").trim().length === 0;
    const after = node.position?.end?.offset;
    const keep =
      !empty &&
      // Only the single-dollar form is ambiguous; a display node is kept as it is.
      (node.type === "math" ||
        isInlineMathText(raw ?? `$${node.value ?? ""}$`, typeof after === "number" ? source[after] : undefined));
    if (keep) return;
    // Put back the literal text the reader wrote, so `$HOME` shows as `$HOME`.
    parent[index] = { type: "text", value: raw ?? `$${node.value ?? ""}$` };
  });
};

/**
 * Whether a `$…$` run is math, by Pandoc's three rules:
 *
 * 1. no whitespace after the opening `$` (`$ x$` is prose),
 * 2. no whitespace before the closing `$` (`$HOME 和 $PATH` is not math),
 * 3. no digit right after the closing `$` (`$5 and $10` is a price range).
 *
 * `$HOME/.config 复制到 $XDG_CONFIG_HOME` fails 2, `$PATH 和 $HOME` fails 2,
 * `$5 到 $10` fails 2, `$1.5M revenue` fails 2 — while `$O(n\log n)$`, `$d_k$` and
 * `$x^2 + y^2 = 1$` pass all three. An explicit pair the author wrote uneconomically
 * (`$5$`) is still read as math; that is the same call Pandoc makes.
 *
 * A run with nothing between its fences is not math either way, and a doubled run
 * (`$$…$$`) skips the three rules: only the single-dollar form is ambiguous.
 *
 * `after` is the character following the run, when the source position is known.
 */
export function isInlineMathText(text: string, after?: string): boolean {
  const fence = text.startsWith("$$") ? 2 : 1;
  // `$`, `$$` — the closing fence, if it is there at all, is the opening one.
  if (text.length <= fence * 2 - 1) return false;
  if (fence === 2) return text.endsWith("$$") && text.length > 4;
  const closing = text.length - 1;
  if (text[closing] !== "$") return false;
  if (/\s/.test(text[1])) return false;
  if (/\s/.test(text[closing - 1])) return false;
  return after === undefined || !/\d/.test(after);
}

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  position?: { start?: { offset?: number }; end?: { offset?: number } };
}

function childrenOf(tree: unknown): MdNode[] {
  return (tree as MdNode | undefined)?.children ?? [];
}

function forEachNode(nodes: MdNode[], visit: (parent: MdNode[], index: number, node: MdNode) => void): void {
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    visit(nodes, index, node);
    // `node` may have been replaced by the visit; its replacement is text with no children.
    const children = nodes[index].children;
    if (children) forEachNode(children, visit);
  }
}

/** The raw `$…$` a node came from, or undefined when its position is unknown. */
function sourceOf(source: string, node: MdNode): string | undefined {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (typeof start !== "number" || typeof end !== "number" || end <= start) return undefined;
  return source.slice(start, end);
}
