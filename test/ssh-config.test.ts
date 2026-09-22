import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

test("readSshConfig follows absolute Include directives", () => {
  const dir = mkdtempSync(join(tmpdir(), "fastvibe-ssh-include-"));
  const file = join(dir, "config");
  const included = join(dir, "config.new");
  writeFileSync(included, `
Host included
  HostName 10.0.0.9
  User builder
`);
  writeFileSync(file, `
Include ${included}

Host direct
  HostName 10.0.0.10
`);

  assert.deepEqual(readSshConfig(file), [
    {
      id: "ssh:included",
      label: "included",
      host: "included",
      hostName: "10.0.0.9",
      source: "config",
      user: "builder",
      port: undefined,
      identityFile: undefined,
    },
    {
      id: "ssh:direct",
      label: "direct",
      host: "direct",
      hostName: "10.0.0.10",
      source: "config",
      user: undefined,
      port: undefined,
      identityFile: undefined,
    },
  ]);
});

test("readSshConfig expands relative Include globs and stops include cycles", () => {
  const dir = mkdtempSync(join(tmpdir(), "fastvibe-ssh-include-"));
  const fragments = join(dir, "config.d");
  const file = join(dir, "config");
  mkdirSync(fragments);
  writeFileSync(file, "Include config.d/*.conf\n");
  writeFileSync(join(fragments, "10-first.conf"), `
Include config
Host first
  HostName first.example.com
`);
  writeFileSync(join(fragments, "20-second.conf"), `
Host second
  HostName second.example.com
`);

  assert.deepEqual(readSshConfig(file).map((host) => host.host), ["first", "second"]);
});

test("readSshConfig returns an empty list for a missing file", () => {
  assert.deepEqual(readSshConfig("/definitely/missing/fastvibe-ssh-config"), []);
});

test("readSshConfig ends a Host block at Match and keeps the first value, like OpenSSH", () => {
  const dir = mkdtempSync(join(tmpdir(), "fastvibe-ssh-"));
  const file = join(dir, "config");
  writeFileSync(file, `
Host foo
  HostName foo.example
  User alice

Match host bar.example
  User root
  Port 2222

Host baz
  User bob
  User carol
`);
  const hosts = readSshConfig(file);
  assert.equal(hosts.find((host) => host.id === "ssh:foo")?.user, "alice");
  assert.equal(hosts.find((host) => host.id === "ssh:foo")?.port, undefined);
  assert.equal(hosts.find((host) => host.id === "ssh:baz")?.user, "bob");
});
