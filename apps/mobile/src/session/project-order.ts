export type RecentProject = {
  cwd: string;
  name: string;
};

export type ProjectUse = {
  project?: string;
  updatedAt: number;
  createdAt: number;
  kind?: string;
};

/** Keep the server's order for projects that have never had a usable chat. */
export function orderProjectsByRecentUse(projects: RecentProject[], conversations: ProjectUse[]): RecentProject[] {
  const recent = new Map<string, number>();
  for (const conversation of conversations) {
    if (!conversation.project || conversation.kind === "side-chat") continue;
    const usedAt = Math.max(conversation.updatedAt, conversation.createdAt);
    if (!Number.isFinite(usedAt)) continue;
    recent.set(conversation.project, Math.max(recent.get(conversation.project) ?? 0, usedAt));
  }

  return projects
    .map((project, index) => ({ project, index }))
    .sort((left, right) => {
      const leftUsedAt = recent.get(left.project.cwd);
      const rightUsedAt = recent.get(right.project.cwd);
      if (leftUsedAt === undefined && rightUsedAt === undefined) return left.index - right.index;
      if (leftUsedAt === undefined) return 1;
      if (rightUsedAt === undefined) return -1;
      return rightUsedAt - leftUsedAt || left.index - right.index;
    })
    .map(({ project }) => project);
}
