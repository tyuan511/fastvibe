import assert from "node:assert/strict";
import test from "node:test";
import { checkFrpDns } from "../src/main/server/frp-dns.ts";
import { frpDnsVerdict, isFrpDomain } from "../src/shared/frp.ts";

const records: Record<string, string[]> = {
  "fv.example.com": ["203.0.113.7"],
  "frp.example.com": ["203.0.113.7", "2001:db8::7"],
  "cdn.example.com": ["104.16.1.1"],
};
const resolve = async (host: string): Promise<string[]> => {
  const found = records[host];
  if (!found) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
  return found;
};

test("a domain on the server's address matches, whether the server is an IP or a name", async () => {
  assert.equal((await checkFrpDns({ domain: "fv.example.com", serverAddr: "203.0.113.7" }, resolve)).verdict, "match");
  assert.equal((await checkFrpDns({ domain: "FV.example.com", serverAddr: "frp.example.com" }, resolve)).verdict, "match");
});

test("a domain elsewhere is a mismatch, and one with no record is unresolved", async () => {
  const cdn = await checkFrpDns({ domain: "cdn.example.com", serverAddr: "203.0.113.7" }, resolve);
  assert.equal(cdn.verdict, "mismatch");
  assert.deepEqual(cdn.domainAddresses, ["104.16.1.1"]);
  assert.equal((await checkFrpDns({ domain: "new.example.com", serverAddr: "203.0.113.7" }, resolve)).verdict, "unresolved");
});

test("a server that cannot be resolved leaves nothing to compare against", async () => {
  const result = await checkFrpDns({ domain: "fv.example.com", serverAddr: "gone.example.com" }, resolve);
  assert.equal(result.verdict, "resolved");
});

test("a lookup that never answers is reported as unresolved, not left hanging", { timeout: 10_000 }, async () => {
  const result = await checkFrpDns({ domain: "fv.example.com", serverAddr: "203.0.113.7" }, () => new Promise(() => undefined));
  assert.equal(result.verdict, "unresolved");
});

test("only a real domain is looked up", async () => {
  await assert.rejects(() => checkFrpDns({ domain: "203.0.113.7", serverAddr: "x" }, resolve));
  await assert.rejects(() => checkFrpDns({ domain: "not a domain", serverAddr: "x" }, resolve));
  assert.equal(isFrpDomain("fv.example.com"), true);
  assert.equal(isFrpDomain("::1"), false);
});

test("the verdict compares addresses case-insensitively", () => {
  assert.equal(frpDnsVerdict(["2001:DB8::7"], ["2001:db8::7"]), "match");
  assert.equal(frpDnsVerdict([], ["1.2.3.4"]), "unresolved");
});
