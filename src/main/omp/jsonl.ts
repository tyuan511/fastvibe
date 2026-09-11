export class JsonlDecoder {
  #buffer = "";
  #chunks = new Map<
    string,
    { count: number; byteLength: number; parts: Array<string | undefined> }
  >();

  push(chunk: string): unknown[] {
    this.#buffer += chunk;
    const frames: unknown[] = [];

    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line.trim()) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        frames.push({
          type: "response",
          command: "parse",
          success: false,
          error: `Malformed JSONL: ${line.slice(0, 200)}`,
        });
        continue;
      }

      const reassembled = this.#maybeReassemble(parsed);
      if (reassembled !== undefined) frames.push(reassembled);
    }

    return frames;
  }

  reset(): void {
    this.#buffer = "";
    this.#chunks.clear();
  }

  #maybeReassemble(frame: unknown): unknown | undefined {
    if (!isRecord(frame) || frame.type !== "rpc_chunk") return frame;

    const chunkId = String(frame.chunkId ?? "");
    const index = Number(frame.index);
    const count = Number(frame.count);
    const byteLength = Number(frame.byteLength);
    const data = String(frame.data ?? "");

    if (!chunkId || !Number.isInteger(index) || count < 1) return undefined;

    let entry = this.#chunks.get(chunkId);
    if (!entry) {
      entry = { count, byteLength, parts: Array.from({ length: count }) };
      this.#chunks.set(chunkId, entry);
    }

    entry.parts[index] = data;
    if (entry.parts.some((part) => part === undefined)) return undefined;

    this.#chunks.delete(chunkId);
    const bytes = Buffer.concat(entry.parts.map((part) => Buffer.from(part ?? "", "base64")));
    if (bytes.length !== entry.byteLength) return undefined;
    return JSON.parse(bytes.toString("utf8"));
  }
}

export function encodeFrame(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
