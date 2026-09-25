import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareVersions,
  findNewerRelease,
  releaseFromPayload,
  versionsFromRefs,
} from "../apps/mobile/src/update/release.ts";

/**
 * The phone's updater shares a release list with the desktop app, which tags `v*`
 * and `agent-runtime-v*` several times a day. Everything here is about never
 * mistaking one of those for a phone build, and never offering a tag CI has not
 * finished publishing.
 */

test("versions compare numerically, not as strings", () => {
  assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
  assert.ok(compareVersions("1.0.0", "0.99.99") > 0);
  assert.equal(compareVersions("0.2.0", "v0.2.0"), 0);
  assert.ok(compareVersions("0.1.0", "garbage") > 0);
});

test("only app-v tags with a plain version are phone releases", () => {
  const refs = [
    { ref: "refs/tags/app-v0.1.0" },
    { ref: "refs/tags/app-v0.10.0" },
    { ref: "refs/tags/app-v0.2.0" },
    { ref: "refs/tags/app-v0.3.0-rc1" },
    { ref: "refs/tags/v0.13.0" },
    { ref: "refs/tags/agent-runtime-v5" },
  ];
  assert.deepEqual(versionsFromRefs(refs), ["0.10.0", "0.2.0", "0.1.0"]);
  assert.deepEqual(versionsFromRefs({ message: "Not Found" }), []);
});

test("a release without an APK, or a prerelease, offers nothing", () => {
  const apk = { name: "FastVibe-app-v0.2.0.apk", browser_download_url: "https://x/a.apk", size: 42 };
  const sha = { name: "FastVibe-app-v0.2.0.apk.sha256", browser_download_url: "https://x/a.sha256", size: 1 };
  assert.equal(releaseFromPayload("0.2.0", { assets: [sha] }), null);
  assert.equal(releaseFromPayload("0.2.0", { prerelease: true, assets: [apk] }), null);
  const release = releaseFromPayload("0.2.0", { tag_name: "app-v0.2.0", body: " notes \n", assets: [sha, apk] });
  assert.equal(release?.apkUrl, "https://x/a.apk");
  assert.equal(release?.apkSize, 42);
  assert.equal(release?.notes, "notes");
});

type Route = { status: number; body: unknown };

function fakeFetch(routes: Record<string, Route>) {
  const asked: string[] = [];
  const impl = async (url: string) => {
    asked.push(url);
    const route = routes[url] ?? { status: 404, body: { message: "Not Found" } };
    return { ok: route.status >= 200 && route.status < 300, status: route.status, json: async () => route.body };
  };
  return { impl, asked };
}

const REFS = "https://api.github.com/repos/tyuan511/fastvibe/git/matching-refs/tags/app-v";
const tagUrl = (version: string) => `https://api.github.com/repos/tyuan511/fastvibe/releases/tags/app-v${version}`;
const published = (version: string) => ({
  status: 200,
  body: {
    tag_name: `app-v${version}`,
    assets: [{ name: `FastVibe-app-v${version}.apk`, browser_download_url: `https://x/${version}.apk`, size: 1 }],
  },
});

test("a tag still building falls back to the newest published one", async () => {
  const { impl } = fakeFetch({
    [REFS]: { status: 200, body: [{ ref: "refs/tags/app-v0.2.0" }, { ref: "refs/tags/app-v0.3.0" }] },
    [tagUrl("0.2.0")]: published("0.2.0"),
  });
  const release = await findNewerRelease("0.1.0", impl);
  assert.equal(release?.version, "0.2.0");
});

test("an install already on the newest version asks for no release at all", async () => {
  const { impl, asked } = fakeFetch({
    [REFS]: { status: 200, body: [{ ref: "refs/tags/app-v0.2.0" }] },
    [tagUrl("0.2.0")]: published("0.2.0"),
  });
  assert.equal(await findNewerRelease("0.2.0", impl), null);
  assert.deepEqual(asked, [REFS]);
});

test("an API failure throws instead of reading as up to date", async () => {
  const { impl } = fakeFetch({ [REFS]: { status: 403, body: { message: "rate limit" } } });
  await assert.rejects(findNewerRelease("0.1.0", impl));
});
