import type { GitHistory, GitHistoryEntry, GitHistoryScope } from "@shared/ipc";
const hash = (n: string): string => n.repeat(40);
const entry = (id: string, parents: string[], subject: string, refs: GitHistoryEntry["refs"] = [], isHead = false): GitHistoryEntry => ({
  hash: hash(id), parents: parents.map(hash), subject, body: `${subject}\n\nUpdate the workspace changes view and preserve staged content.`, author: "tyuan511", date: "2026-10-17T10:00:00+08:00", refs, isHead,
});
const commits = [
  entry("0", ["c"], "feat: add keyboard navigation to changes", [{ name: "feat/changes", kind: "local" }]),
  entry("a", ["b", "c"], "Merge branch 'feat/source-control'", [{ name: "main", kind: "local", current: true }, { name: "origin/main", kind: "remote" }], true),
  entry("b", ["d"], "chore: release v0.20.3", [{ name: "v0.20.3", kind: "tag" }]),
  entry("c", ["e"], "feat: improve workspace trees and terminal tools", [{ name: "origin/feat/source-control", kind: "remote" }]),
  entry("d", ["f"], "fix: show a model switch when the request is sent"),
  entry("e", ["f"], "feat: add split diff and commit details"),
  entry("f", ["1"], "chore: release v0.20.2", [{ name: "v0.20.2", kind: "tag" }]),
  entry("1", ["2"], "feat: upgrade the embedded SDK to 1.2.0"),
  entry("2", ["3"], "feat: support multiple project folders"),
  entry("3", ["4"], "feat: add schedule tasks and plugin settings"),
  entry("4", ["5"], "fix(mobile): open and download generated files"),
  entry("5", ["6"], "fix(chat): avoid large inline image responses"),
  entry("6", [], "feat: add the initial workspace"),
];
export function gitHistoryFixture(skip = 0, scope: GitHistoryScope = "all"): GitHistory {
  return { commits: (scope === "current" ? commits.slice(1) : commits).slice(skip, skip + 50), hasMore: false, head: hash("a"), branch: "main", tips: [hash("a"), hash("0")] };
}
