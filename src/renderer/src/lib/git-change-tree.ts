import { buildChangeFileTree, type ChangeFileTreeNode } from "./change-file-tree.ts";

export type GitTreeNode<T> =
  | { kind: "directory"; name: string; path: string; children: GitTreeNode<T>[]; files: T[] }
  | { kind: "file"; name: string; path: string; file: T };
export type GitTreeRow<T> = { id: string; node: GitTreeNode<T>; depth: number; parent?: string; position: number; siblings: number };

/** Compact only uninterrupted directory chains. Branch points and files keep their own rows. */
export function buildGitChangeTree<T>(files: T[], pathOf: (file: T) => string): GitTreeNode<T>[] {
  function compact(nodes: ChangeFileTreeNode<T>[]): GitTreeNode<T>[] {
    return nodes.map((node) => {
      if (node.kind === "file") return node;
      let tail = node;
      const names = [node.name];
      while (tail.children.length === 1 && tail.children[0].kind === "directory") {
        tail = tail.children[0];
        names.push(tail.name);
      }
      const children = compact(tail.children);
      return { kind: "directory", name: names.join("/"), path: tail.path, children, files: children.flatMap((child) => child.kind === "file" ? [child.file] : child.files) };
    });
  }
  return compact(buildChangeFileTree(files, pathOf));
}

export function flattenGitChangeTree<T>(nodes: GitTreeNode<T>[], collapsed: ReadonlySet<string>): GitTreeRow<T>[] {
  const rows: GitTreeRow<T>[] = [];
  function visit(children: GitTreeNode<T>[], depth: number, parent?: string): void {
    children.forEach((node, index) => {
      const id = `${node.kind}:${node.path}`;
      rows.push({ id, node, depth, parent, position: index + 1, siblings: children.length });
      if (node.kind === "directory" && !collapsed.has(node.path)) visit(node.children, depth + 1, id);
    });
  }
  visit(nodes, 0);
  return rows;
}

export function gitDirectoryPaths<T>(nodes: GitTreeNode<T>[]): string[] {
  return nodes.flatMap((node) => node.kind === "file" ? [] : [node.path, ...gitDirectoryPaths(node.children)]);
}
