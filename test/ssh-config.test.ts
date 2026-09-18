import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readSshConfig } from "../src/main/ssh/ssh-config.ts";

test("readSshConfig returns concrete host aliases and ignores pattern blocks", () => {
  const dir = mkdtempSync(join(tmpdir(), "fastvibe-ssh-"));
  const file = join(dir, "config");
  writeFileSync(file, `
Host dev staging
  HostName 10.0.0.8
  User deploy
  Port 2222
  IdentityFile ~/.ssh/id_ed25519

Host *
  ServerAliveInterval 30

Host !bastion *.internal
  User ignored
`);

  assert.deepEqual(readSshConfig(file), [
    {
      id: "ssh:dev",
      label: "dev",
      host: "dev",
      hostName: "10.0.0.8",
      source: "config",
      user: "deploy",
      port: 2222,
      identityFile: join(process.env.HOME ?? "", ".ssh", "id_ed25519"),
    },
    {
      id: "ssh:staging",
      label: "staging",
      host: "staging",
      hostName: "10.0.0.8",
      source: "config",
      user: "deploy",
      port: 2222,
      identityFile: join(process.env.HOME ?? "", ".ssh", "id_ed25519"),
    },
  ]);
});

test("readSshConfig returns an empty list for a missing file", () => {
  assert.deepEqual(readSshConfig("/definitely/missing/fastvibe-ssh-config"), []);
});
