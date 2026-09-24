import assert from "node:assert/strict";
import { test } from "node:test";
import {
  consentRootsForCall,
  protectedFolderRoot,
  protectedRootsInCommand,
  rememberProtectedFolders,
} from "../resources/extensions/mac-folder-consent.ts";

const HOME = "/Users/me";

test("a file inside Desktop, Documents or Downloads belongs to that folder", () => {
  assert.equal(protectedFolderRoot(`${HOME}/Desktop/notes.txt`, HOME), `${HOME}/Desktop`);
  assert.equal(protectedFolderRoot(`${HOME}/Documents/proj/a.ts`, HOME), `${HOME}/Documents`);
  assert.equal(protectedFolderRoot(`${HOME}/Downloads`, HOME), `${HOME}/Downloads`);
});

test("a name that only starts with the folder is not that folder", () => {
  assert.equal(protectedFolderRoot(`${HOME}/Documents-backup/a`, HOME), null);
  assert.equal(protectedFolderRoot(`${HOME}/code/fastvibe`, HOME), null);
});

test("iCloud, a cloud provider and an external volume are one grant each", () => {
  assert.equal(
    protectedFolderRoot(`${HOME}/Library/Mobile Documents/com~apple~CloudDocs/a`, HOME),
    `${HOME}/Library/Mobile Documents`,
  );
  assert.equal(
    protectedFolderRoot(`${HOME}/Library/CloudStorage/Dropbox/a`, HOME),
    `${HOME}/Library/CloudStorage/Dropbox`,
  );
  assert.equal(protectedFolderRoot("/Volumes/Backup/docs/a", HOME), "/Volumes/Backup");
  assert.equal(protectedFolderRoot("/Volumes", HOME), null);
});

test("a shell command names the folder it is about to read", () => {
  assert.deepEqual(protectedRootsInCommand("ls ~/Desktop/a", `${HOME}/code`, HOME), [`${HOME}/Desktop`]);
  assert.deepEqual(protectedRootsInCommand('cat "$HOME/Documents/a"', `${HOME}/code`, HOME), [`${HOME}/Documents`]);
  assert.deepEqual(protectedRootsInCommand("ls ${HOME}/Downloads/a", `${HOME}/code`, HOME), [`${HOME}/Downloads`]);
  assert.deepEqual(protectedRootsInCommand("ls /Volumes/USB/a", `${HOME}/code`, HOME), ["/Volumes/USB"]);
});

test("a bare folder name counts only when cwd makes it the protected one", () => {
  assert.deepEqual(protectedRootsInCommand("ls Desktop", HOME, HOME), [`${HOME}/Desktop`]);
  assert.deepEqual(protectedRootsInCommand("ls Desktop", `${HOME}/code`, HOME), []);
});

test("the working directory is enough when the tool will read it", () => {
  assert.deepEqual(
    consentRootsForCall("read", { path: "a.ts" }, `${HOME}/Documents/proj`, HOME),
    [`${HOME}/Documents`],
  );
  assert.deepEqual(consentRootsForCall("web_search", { query: "x" }, `${HOME}/Documents/proj`, HOME), []);
  assert.deepEqual(consentRootsForCall("bash", { command: "ls" }, `${HOME}/Desktop`, HOME), [`${HOME}/Desktop`]);
  assert.deepEqual(consentRootsForCall("bash", { command: "ls" }, `${HOME}/code`, HOME), []);
});

test("two files in one folder are one stat, and a denial is not asked again", () => {
  const memory = new Set<string>();
  const seen: string[] = [];
  const stat = (path: string): void => {
    seen.push(path);
  };
  rememberProtectedFolders([`${HOME}/Desktop`, `${HOME}/Desktop`], { platform: "darwin", stat, memory });
  rememberProtectedFolders([`${HOME}/Desktop`], { platform: "darwin", stat, memory });
  assert.deepEqual(seen, [`${HOME}/Desktop`]);
});

test("a grant that fails the first stat is retried once, a missing folder is not", () => {
  const denied = new Set<string>();
  let denies = 0;
  rememberProtectedFolders([`${HOME}/Documents`], {
    platform: "darwin",
    memory: denied,
    stat: () => {
      denies += 1;
      const error = new Error("denied") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    },
  });
  assert.equal(denies, 2);
  rememberProtectedFolders([`${HOME}/Documents`], {
    platform: "darwin",
    memory: denied,
    stat: () => {
      denies += 1;
    },
  });
  assert.equal(denies, 2);

  let missing = 0;
  rememberProtectedFolders([`${HOME}/Downloads`], {
    platform: "darwin",
    memory: new Set(),
    stat: () => {
      missing += 1;
      const error = new Error("gone") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
  });
  assert.equal(missing, 1);
});

test("other platforms never stat", () => {
  let calls = 0;
  rememberProtectedFolders([`${HOME}/Desktop`], {
    platform: "linux",
    stat: () => {
      calls += 1;
    },
  });
  assert.equal(calls, 0);
});
