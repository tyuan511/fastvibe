export type ChangeFileTreeNode<T> =
  | { kind: "directory"; name: string; path: string; children: ChangeFileTreeNode<T>[] }
  | { kind: "file"; name: string; path: string; file: T };

/** Build from change metadata alone, so deleted files and missing directories remain visible. */
export function buildChangeFileTree<T>(files: T[], pathOf: (file: T) => string): ChangeFileTreeNode<T>[] {
  const roots: ChangeFileTreeNode<T>[] = [];
  const directories = new Map<string, Extract<ChangeFileTreeNode<T>, { kind: "directory" }>>();
  for (const file of files) {
    const parts = pathOf(file).replace(/\\/g, "/").split("/");
    let children = roots;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const path = parts.slice(0, index + 1).join("/");
      let directory = directories.get(path);
      if (!directory) {
        directory = { kind: "directory", name: parts[index] || "/", path, children: [] };
        directories.set(path, directory);
        children.push(directory);
      }
      children = directory.children;
    }
    children.push({ kind: "file", name: parts[parts.length - 1], path: parts.join("/"), file });
  }
  function sort(nodes: ChangeFileTreeNode<T>[]): void {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
    for (const node of nodes) if (node.kind === "directory") sort(node.children);
  }
  sort(roots);
  return roots;
}
