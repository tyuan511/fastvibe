import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { openSync, closeSync, ftruncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteServer } from "../src/main/server/server.ts";
import { openMediaBody } from "../src/main/engine/media-file.ts";
import { readFilePreview } from "../src/main/engine/file-preview.ts";
import { fetchRemoteMedia, remoteMediaTarget } from "../src/main/engine/remote-media.ts";
import { mediaPathFromUrl, mediaPreviewUrl, parseByteRange } from "../src/shared/media-preview.ts";
import { registeredChannels } from "./registered-channels.ts";

/**
 * A preview is a URL plus a byte stream, never a base64 copy of the file.
 * These pin the three places that used to disagree: what the preview JSON contains,
 * which bytes a range reads, and that a remote client must present a credential
 * before those bytes move.
 */

const TOKEN = "a".repeat(64);
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "fastvibe-media-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a media URL round-trips a local path and a remote ref", () => {
  const local = "/Users/yuantang/Movies/片 名.mp4";
  assert.equal(mediaPathFromUrl(mediaPreviewUrl(local)), local);
  const remote = "remote:srv_abc123:/tmp/a&b.mp4";
  assert.equal(mediaPathFromUrl(mediaPreviewUrl(remote)), remote);
  assert.equal(mediaPathFromUrl(mediaPreviewUrl("relative.mp4")), null);
  assert.equal(mediaPathFromUrl("https://example.com/play?path=/tmp/a.mp4"), null);
});

test("byte ranges are one interval, and a backwards range is refused", () => {
  assert.equal(parseByteRange(null, 100), null);
  assert.deepEqual(parseByteRange("bytes=0-1", 100), { start: 0, end: 1 });
  assert.deepEqual(parseByteRange("bytes=0-", 100), { start: 0, end: 99 });
  assert.deepEqual(parseByteRange("bytes=-5", 100), { start: 95, end: 99 });
  assert.deepEqual(parseByteRange("bytes=0-1000", 100), { start: 0, end: 99 });
  assert.equal(parseByteRange("bytes=100-", 100), "invalid");
  assert.equal(parseByteRange("bytes=5-2", 100), "invalid");
  assert.equal(parseByteRange("bytes=0-1", 0), "invalid");
});

test("image and video previews name the file and do not inline it", async () => {
  await withDir(async (dir) => {
    const image = join(dir, "shot.png");
    const video = join(dir, "clip.mp4");
    await writeFile(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const fd = openSync(video, "w");
    try {
      ftruncateSync(fd, 32 * 1024 * 1024);
    } finally {
      closeSync(fd);
    }
    const photo = readFilePreview(image);
    const movie = readFilePreview(video);
    assert.equal(photo.kind, "image");
    assert.equal(movie.kind, "video");
    if (photo.kind !== "image" || movie.kind !== "video") return;
    assert.equal(photo.mimeType, "image/png");
    assert.equal(photo.size, 4);
    assert.equal(movie.mimeType, "video/mp4");
    assert.equal(movie.size, 32 * 1024 * 1024);
    assert.equal("dataUrl" in photo, false);
    assert.equal("dataUrl" in movie, false);
    const note = readFilePreview(join(dir, "missing-note.txt"));
    await writeFile(join(dir, "note.txt"), "hello\n");
    const text = readFilePreview(join(dir, "note.txt"));
    assert.equal(text.kind, "code");
    assert.equal(note.kind, "error");
  });
});

test("a range reads only that slice, and a symlink to a non-media file is refused", async () => {
  await withDir(async (dir) => {
    const video = join(dir, "clip.mp4");
    await writeFile(video, "abcdefghijklmnopqrstuvwxyz");
    const opened = openMediaBody(video, "GET", "bytes=0-3");
    assert.equal(opened.ok, true);
    if (!opened.ok || !opened.stream) return;
    const chunks: Buffer[] = [];
    for await (const chunk of opened.stream) chunks.push(chunk as Buffer);
    assert.equal(Buffer.concat(chunks).toString(), "abcd");
    assert.equal(opened.status, 206);
    const secret = join(dir, "secret.txt");
    const disguised = join(dir, "secret.mp4");
    await writeFile(secret, "nope");
    await symlink(secret, disguised);
    const refused = openMediaBody(disguised, "GET", null);
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.status, 403);
  });
});

test("remote media is a binary range stream and stays closed without the token", async () => {
  await withDir(async (dir) => {
    const accessFile = join(dir, "remote-access.json");
    const video = join(dir, "clip.mp4");
    await writeFile(video, "abcdefghijklmnopqrstuvwxyz");
    const server = new RemoteServer({
      accessFile,
      loopbackToken: TOKEN,
      channels: () => registeredChannels(),
      dispatch: async () => ({}),
      subscribe: () => () => undefined,
      log: silent,
    });
    const { port } = await server.start({ port: 0, host: "127.0.0.1" });
    try {
      assert.ok(port);
      const bare = await fetch(`http://127.0.0.1:${port}/api/media?path=${encodeURIComponent(video)}`);
      assert.equal(bare.status, 401);
      const wrong = await fetch(remoteMediaTarget({ port: port ?? 0, token: TOKEN }, video), {
        headers: { authorization: "Bearer nope" },
      });
      assert.equal(wrong.status, 401);
      const text = join(dir, "note.txt");
      await writeFile(text, "hello");
      const forbidden = await fetch(remoteMediaTarget({ port: port ?? 0, token: TOKEN }, text), {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(forbidden.status, 403);
      const streamed = await fetchRemoteMedia(
        { port: port ?? 0, token: TOKEN },
        `remote:srv_abc123:${video}`,
        "GET",
        "bytes=4-7",
      );
      assert.equal(streamed.status, 206);
      assert.equal(streamed.headers.get("content-type"), "video/mp4");
      assert.equal(await streamed.text(), "efgh");
      const offline = await fetchRemoteMedia(null, `remote:srv_abc123:${video}`, "GET", null);
      assert.equal(offline.status, 404);
    } finally {
      await server.stop();
    }
  });
});
