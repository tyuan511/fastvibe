import { test } from "node:test";
import assert from "node:assert/strict";
import { describeUserAgent, relativeTime } from "../apps/website/lib/user-agent.ts";

/**
 * The console's device list names each session from its User-Agent. The point is that a
 * person can tell their laptop from their phone, so the cases that matter are the agents
 * that impersonate each other: Edge and Chrome on iOS both say "Safari", and every iOS
 * agent says "like Mac OS X".
 */

const UA = {
  chromeMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  safariMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  firefoxWin: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
  edgeWin: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
  safariIphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  chromeIphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1",
  safariIpad: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  chromeAndroid: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  chromeLinux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  operaMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0",
};

test("browsers and systems are named from their agents", () => {
  const cases: [string, string, string][] = [
    [UA.chromeMac, "Chrome", "macOS"],
    [UA.safariMac, "Safari", "macOS"],
    [UA.firefoxWin, "Firefox", "Windows"],
    [UA.edgeWin, "Edge", "Windows"],
    [UA.safariIphone, "Safari", "iOS"],
    [UA.chromeIphone, "Chrome", "iOS"],
    [UA.safariIpad, "Safari", "iPadOS"],
    [UA.chromeAndroid, "Chrome", "Android"],
    [UA.chromeLinux, "Chrome", "Linux"],
    [UA.operaMac, "Opera", "macOS"],
  ];
  for (const [ua, browser, os] of cases) {
    assert.deepEqual(describeUserAgent(ua), { browser, os }, ua);
  }
});

test("an agent it cannot place is reported as unknown, not guessed", () => {
  assert.deepEqual(describeUserAgent(null), { browser: null, os: null });
  assert.deepEqual(describeUserAgent(""), { browser: null, os: null });
  assert.deepEqual(describeUserAgent("SomethingElse/1.0"), { browser: null, os: null });
  assert.deepEqual(describeUserAgent("curl/8.4.0"), { browser: "Command line", os: null });
});

test("relative times read naturally and under a minute is 'just now'", () => {
  const now = new Date("2026-10-09T12:00:00Z");
  const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);
  assert.equal(relativeTime(ago(5), "en", now), "just now");
  assert.equal(relativeTime(ago(5), "zh", now, "刚刚"), "刚刚");
  assert.equal(relativeTime(ago(5 * 60), "en", now), "5 minutes ago");
  assert.equal(relativeTime(ago(3 * 3600), "en", now), "3 hours ago");
  assert.equal(relativeTime(ago(86400), "en", now), "yesterday");
  assert.equal(relativeTime(ago(3 * 86400), "en", now), "3 days ago");
  assert.equal(relativeTime(ago(40 * 86400), "en", now), "last month");
  assert.equal(relativeTime(ago(5 * 60), "zh", now), "5分钟前");
  assert.equal(relativeTime(ago(3 * 86400).toISOString(), "en", now), "3 days ago");
  // A clock a little ahead of the server must not say "in 0 minutes".
  assert.equal(relativeTime(new Date(now.getTime() + 20_000), "en", now), "just now");
});
