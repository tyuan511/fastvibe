import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { additionalResourceFolders, folderResourceHints } from "../src/main/engine/project-folder-resources.ts";
import { buildProjectFoldersPrompt } from "../src/shared/project-folders.ts";

async function skill(dir: string, name: string, description = `${name} skill`): Promise<void> {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`);
}

/** Two repositories side by side, each with its own AGENTS.md and project skill. */
async function workspace() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "fastvibe-folders-")));
  const api = join(base, "api");
  const web = join(base, "web");
  for (const repo of [api, web]) await mkdir(join(repo, ".git"), { recursive: true });
  await writeFile(join(api, "AGENTS.md"), "api rules");
  await writeFile(join(web, "AGENTS.md"), "web rules");
  await skill(join(api, ".agents", "skills"), "api-deploy");
  await skill(join(web, ".agents", "skills"), "web-release");
  return { base, api, web };
}

test("the folders that count are the project's, minus the primary and the session's own", () => {
  const project = { cwd: "/p/api", folders: ["/p/web", "/p/docs"] };
  assert.deepEqual(additionalResourceFolders(project, "/p/api"), ["/p/web", "/p/docs"]);
  // A worktree chat runs in a copy of the primary: the primary is still not "another" folder.
  assert.deepEqual(additionalResourceFolders(project, "/wt/api-1"), ["/p/web", "/p/docs"]);
  assert.deepEqual(additionalResourceFolders(project, "/p/web"), ["/p/docs"]);
  assert.deepEqual(additionalResourceFolders({ ...project, kind: "remote" }, "/p/api"), []);
  assert.deepEqual(additionalResourceFolders(undefined, "/p/api"), []);
});

test("another folder's instructions and skills are found, up to its own repository only", async () => {
  const { base, api, web } = await workspace();
  // Above both repositories: not something the user pointed the project at.
  await writeFile(join(base, "AGENTS.md"), "parent rules");
  await skill(join(web, ".pi", "skills"), "web-pi", "Line one\n  line two");
  const nested = join(web, "packages", "ui");
  await mkdir(nested, { recursive: true });
  await writeFile(join(nested, "CLAUDE.md"), "ui rules");

  const hints = folderResourceHints(nested, api);
  assert.deepEqual(hints.instructions, [join(web, "AGENTS.md"), join(nested, "CLAUDE.md")]);
  assert.deepEqual(hints.skills.map((item) => item.name), ["web-release"]);

  const top = folderResourceHints(web, api);
  assert.deepEqual(top.instructions, [join(web, "AGENTS.md")]);
  assert.deepEqual(top.skills.map((item) => [item.name, item.description]), [
    ["web-release", "web-release skill"],
    ["web-pi", "Line one line two"],
  ]);
  assert.equal(top.skills[0]?.path, join(web, ".agents", "skills", "web-release", "SKILL.md"));

  // Outside any repository a folder is only itself.
  const loose = join(base, "notes");
  await mkdir(loose);
  await writeFile(join(loose, "AGENTS.md"), "notes");
  assert.deepEqual(folderResourceHints(loose, api).instructions, [join(loose, "AGENTS.md")]);
});

test("what the session already loads from its own ancestors is not named again", async () => {
  const { base } = await workspace();
  const mono = join(base, "mono");
  const a = join(mono, "packages", "a");
  const b = join(mono, "packages", "b");
  await mkdir(join(mono, ".git"), { recursive: true });
  await mkdir(a, { recursive: true });
  await mkdir(b, { recursive: true });
  await writeFile(join(mono, "AGENTS.md"), "mono rules");
  await writeFile(join(b, "AGENTS.md"), "b rules");
  await skill(join(mono, ".agents", "skills"), "mono-skill");
  await skill(join(b, ".agents", "skills"), "b-skill");

  const hints = folderResourceHints(b, a);
  assert.deepEqual(hints.instructions, [join(b, "AGENTS.md")]);
  assert.deepEqual(hints.skills.map((item) => item.name), ["b-skill"]);
});

test("the prompt names another folder's files and says to read them only when working there", () => {
  const prompt = buildProjectFoldersPrompt("/p/api", [
    { path: "/p/api", primary: true, repository: true, branch: "main" },
    {
      path: "/p/web",
      primary: false,
      repository: true,
      resources: {
        instructions: ["/p/web/AGENTS.md"],
        skills: [{ name: "web-release", description: "Cut a web release", path: "/p/web/.agents/skills/web-release/SKILL.md" }],
      },
    },
  ]) ?? "";
  assert.match(prompt, /- \/p\/web \(additional folder; git repository\)\n {2}- instructions: \/p\/web\/AGENTS\.md\n {2}- skill web-release: Cut a web release \(\/p\/web\/\.agents\/skills\/web-release\/SKILL\.md\)/);
  assert.match(prompt, /are not loaded/);

  const bare = buildProjectFoldersPrompt("/p/api", [
    { path: "/p/api", primary: true, repository: true },
    { path: "/p/web", primary: false, repository: true, resources: { instructions: [], skills: [] } },
  ]) ?? "";
  assert.doesNotMatch(bare, /are not loaded/);
});
