import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSshHosts, redactSshHosts, saveSshHost, type SecretBox } from "../src/main/ssh/ssh-hosts.ts";

const box: SecretBox = {
  available: () => true,
  seal: (plain) => Buffer.from(`sealed:${plain}`).toString("base64"),
  open: (sealed) => Buffer.from(sealed, "base64").toString().replace(/^sealed:/, ""),
};

function hostsFile(): string {
  return join(mkdtempSync(join(tmpdir(), "fastvibe-hosts-")), "ssh-hosts.json");
}

test("a saved password is sealed on disk and opened only in Main", () => {
  const file = hostsFile();
  saveSshHost(file, { id: "h", label: "h", host: "h.example", authMethod: "password", password: "hunter2" }, box);
  assert.equal(readFileSync(file, "utf8").includes("hunter2"), false);
  assert.equal(readSshHosts(file, box).saved[0]?.password, "hunter2");
  const shown = redactSshHosts(readSshHosts(file, box)).saved[0];
  assert.equal(shown?.password, undefined);
  assert.equal(shown?.hasPassword, true);
});

test("saving without a password keeps the one on file; switching to a key drops it", () => {
  const file = hostsFile();
  saveSshHost(file, { id: "h", label: "h", host: "h.example", authMethod: "password", password: "hunter2" }, box);
  saveSshHost(file, { id: "h", label: "renamed", host: "h.example", authMethod: "password" }, box);
  assert.equal(readSshHosts(file, box).saved[0]?.password, "hunter2");
  saveSshHost(file, { id: "h", label: "renamed", host: "h.example", authMethod: "default-key" }, box);
  assert.equal(readSshHosts(file, box).saved[0]?.password, undefined);
});

test("a plain password from an older file is sealed on the next read", () => {
  const file = hostsFile();
  writeFileSync(file, JSON.stringify({ version: 1, hosts: [{ id: "h", label: "h", host: "h.example", authMethod: "password", password: "hunter2" }] }));
  assert.equal(readSshHosts(file, box).saved[0]?.password, "hunter2");
  assert.equal(readFileSync(file, "utf8").includes("hunter2"), false);
});

test("without a keychain a sealed password survives an unrelated write", () => {
  const file = hostsFile();
  saveSshHost(file, { id: "h", label: "h", host: "h.example", authMethod: "password", password: "hunter2" }, box);
  const locked: SecretBox = { ...box, available: () => false };
  saveSshHost(file, { id: "other", label: "o", host: "o.example" }, locked);
  assert.equal(readSshHosts(file, box).saved.find((item) => item.id === "h")?.password, "hunter2");
});
