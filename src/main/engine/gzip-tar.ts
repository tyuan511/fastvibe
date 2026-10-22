import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";

/**
 * A read-only tar.gz walker, in enough of the format to survive what source
 * archives actually contain — and nothing more.
 *
 * FastVibe already shells out to `tar` for the computer-use driver download, but that
 * is a macOS-only path. Installing a skill runs on Linux headless Agents and on
 * Windows too, and there the answer to "is there a `tar`" is not a yes the app can
 * bank on. Node ships zlib, and the pieces of tar this app needs are small:
 *
 * - the POSIX `prefix` field, which is how GitHub's archives spell long paths (a
 *   measured `codeload` tarball stores 61 paths over 100 characters this way and no
 *   `L`/`PAX` blocks at all);
 * - GNU long names (`L`) and PAX `path=` overrides, which other archive makers use;
 * - the entry types, so that a symlink or a device node is *seen* as one rather than
 *   silently read as a file — a caller that only ever writes regular files cannot
 *   follow a link out of the directory it was handed.
 *
 * Nothing is ever written here: the walker hands out headers and, for the entries the
 * caller asked for, their bytes. Deciding what a path means is the caller's job, and
 * that is where the containment checks live.
 */

export type TarEntryKind = "file" | "directory" | "link" | "other";

export type TarEntry = {
  /** Archive-internal path, with the long-name and PAX overrides already applied. */
  path: string;
  kind: TarEntryKind;
  /** Declared size in bytes; for entries the caller skipped, the walker never reads them. */
  size: number;
  /** The bytes, or null when `read` said it did not want this entry. */
  content: Buffer | null;
};

export type TarLimits = {
  /** Hard ceiling on decompressed bytes; a tar bomb is refused, not extracted. */
  maxTotalBytes?: number;
  maxEntries?: number;
  /** Per-entry ceiling for the entries whose content is materialised. */
  maxEntryBytes?: number;
};

export class TarArchiveError extends Error {}

const BLOCK = 512;
const END_OF_ARCHIVE = "this stream ended in the middle of an entry";

/**
 * Pull the bytes of one gzip'd tar file out of `file`.
 *
 * `read` is asked about every entry *before* its body is touched, so a caller that
 * wants one directory reads that directory and discards every body it walked past —
 * the whole archive is never held in memory.
 */
export async function* walkTarGzip(
  file: string,
  read: (entry: { path: string; kind: TarEntryKind; size: number }) => boolean,
  limits: TarLimits = {},
): AsyncGenerator<TarEntry> {
  const source = new BlockReader(createReadStream(file).pipe(createGunzip()), limits);
  let entries = 0;
  let pendingName: string | null = null;
  let paxPath: string | null = null;
  try {
    for (;;) {
      const header = await source.read(512);
      if (!header || isZeroBlock(header)) return;
      const fields = parseHeader(header);
      // A long-name or PAX block renames the entry that follows it, and wins over the
      // header's own (possibly truncated) name.
      const override = paxPath ?? pendingName;
      paxPath = null;
      pendingName = null;
      const type = fields.type;
      if (type === "L" || type === "K") {
        const long = await source.read(fields.size);
        if (!long) throw new TarArchiveError(END_OF_ARCHIVE);
        await source.skip(padding(fields.size));
        if (type === "L") pendingName = utf8Z(long);
        continue;
      }
      if (type === "x" || type === "g") {
        const block = await source.read(fields.size);
        if (!block) throw new TarArchiveError(END_OF_ARCHIVE);
        await source.skip(padding(fields.size));
        if (type === "x") {
          const override = paxPathOf(block.toString("utf8"));
          if (override) paxPath = override;
        }
        continue;
      }
      const path = override ?? (fields.prefix ? `${fields.prefix}/${fields.name}` : fields.name);
      const kind = kindOf(type);
      const wanted = read({ path, kind, size: fields.size });
      if (wanted && fields.size > (limits.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES)) {
        throw new TarArchiveError(`技能文件过大：${path}`);
      }
      let content: Buffer | null = null;
      if (wanted) {
        content = await source.read(fields.size);
        if (!content) throw new TarArchiveError(END_OF_ARCHIVE);
        await source.skip(padding(fields.size));
      } else {
        // The body is discarded, not just the padding — leaving it in the stream would
        // read the next file's bytes as a header.
        await source.skip(fields.size + padding(fields.size));
      }
      if (++entries > (limits.maxEntries ?? DEFAULT_MAX_ENTRIES)) {
        throw new TarArchiveError("压缩包内文件过多");
      }
      yield { path, kind, size: fields.size, content };
    }
  } finally {
    source.destroy();
  }
}

/**
 * Only "file" is ever written to disk by a caller. Hardlink and symlink share one
 * kind because both are a pointer to something else, and a skill installer must
 * refuse them rather than follow them out of the directory it owns.
 */
function kindOf(type: string): TarEntryKind {
  if (type === "0" || type === "7") return "file";
  if (type === "5") return "directory";
  if (type === "1" || type === "2") return "link";
  return "other";
}

type Header = { name: string; prefix: string; size: number; type: string };

function parseHeader(block: Buffer): Header {
  const field = (start: number, end: number) => text(block.subarray(start, end));
  const sizeText = field(124, 136);
  const size = parseSize(block.subarray(124, 136), sizeText);
  return {
    name: field(0, 100),
    prefix: field(345, 500),
    size,
    type: String.fromCharCode(block[156] === 0 ? 48 : block[156]),
  };
}

/** Octal, ASCII. GNU also writes base-256 for huge files; those are not skills. */
function parseSize(raw: Buffer, text: string): number {
  if (raw[0] & 0x80) {
    // Base-256 (two's complement, big endian) — only positive sizes are archived sane.
    let value = 0;
    for (const byte of raw) value = value * 256 + byte;
    if (value > Number.MAX_SAFE_INTEGER) throw new TarArchiveError("压缩包内文件大小超出支持范围");
    return value;
  }
  const octal = Number.parseInt(text || "0", 8);
  if (!Number.isFinite(octal) || octal < 0) throw new TarArchiveError(`压缩包格式无法解析: ${JSON.stringify(text)}`);
  return octal;
}

function text(raw: Buffer): string {
  return raw.toString("utf8").replace(/\0[\s\S]*$/s, "").trim();
}

function utf8Z(block: Buffer): string {
  return block.toString("utf8").replace(/\0+$/s, "");
}

/** PAX records are `<length> <key>=<value>\n`; only `path` matters here. */
function paxPathOf(records: string): string | null {
  for (const line of records.split("\n")) {
    const space = line.indexOf(" ");
    if (space < 0) continue;
    const pair = line.slice(space + 1);
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    if (pair.slice(0, eq) === "path") return pair.slice(eq + 1);
  }
  return null;
}

function padding(size: number): number {
  return size % BLOCK === 0 ? 0 : BLOCK - (size % BLOCK);
}

function isZeroBlock(block: Buffer): boolean {
  for (const byte of block) if (byte !== 0) return false;
  return true;
}

const DEFAULT_MAX_ENTRIES = 4000;
const DEFAULT_MAX_ENTRY_BYTES = 16 * 1024 * 1024;

/**
 * A pull-based reader over an async byte stream that only ever hands out whole
 * requests: `read(n)` returns exactly n bytes (or null at a clean end), `skip(n)`
 * discards them. The tar format is block-aligned, so this stays cheap.
 */
class BlockReader {
  #stream: NodeJS.ReadableStream & { read: (n?: number) => Buffer | null };
  #iterator: AsyncIterator<Uint8Array | string>;
  #buffered: Buffer[] = [];
  #bufferedBytes = 0;
  #totalBytes = 0;
  #maxTotal: number;
  #ended = false;

  constructor(stream: NodeJS.ReadableStream, limits: TarLimits) {
    const readable = stream as NodeJS.ReadableStream & { read: (n?: number) => Buffer | null };
    this.#stream = readable;
    this.#maxTotal = limits.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    // Node's async iterator pulls in whatever the stream produces; buffering is
    // bounded by the read-then-request loop below, never by an unbounded pipeline.
    this.#iterator = readable[Symbol.asyncIterator]();
  }

  async #fill(): Promise<boolean> {
    if (this.#ended) return false;
    const { value, done } = await this.#iterator.next();
    if (done || !value) {
      this.#ended = true;
      return false;
    }
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    this.#buffered.push(chunk);
    this.#bufferedBytes += chunk.length;
    this.#totalBytes += chunk.length;
    if (this.#totalBytes > this.#maxTotal) throw new TarArchiveError("压缩包过大，已停止读取");
    return true;
  }

  async read(size: number): Promise<Buffer | null> {
    if (size === 0) return Buffer.alloc(0);
    const parts: Buffer[] = [];
    let taken = 0;
    while (taken < size) {
      if (!this.#bufferedBytes && !(await this.#fill())) return null;
      const head = this.#buffered[0];
      const want = size - taken;
      if (head.length <= want) {
        parts.push(head);
        this.#buffered.shift();
        this.#bufferedBytes -= head.length;
        taken += head.length;
      } else {
        parts.push(head.subarray(0, want));
        this.#buffered[0] = head.subarray(want);
        this.#bufferedBytes -= want;
        taken += want;
      }
    }
    return Buffer.concat(parts);
  }

  async skip(size: number): Promise<void> {
    let left = size;
    while (left > 0) {
      if (!this.#bufferedBytes && !(await this.#fill())) throw new TarArchiveError(END_OF_ARCHIVE);
      const head = this.#buffered[0];
      const take = Math.min(left, head.length);
      if (take === head.length) {
        this.#buffered.shift();
      } else {
        this.#buffered[0] = head.subarray(take);
      }
      this.#bufferedBytes -= take;
      left -= take;
    }
  }

  destroy(): void {
    const stream = this.#stream as { destroy?: () => void; removeAllListeners?: () => void };
    stream.removeAllListeners?.();
    stream.destroy?.();
  }
}

const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
