import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

 type UtilityRequest = {
  id: number;
  method: "scan-jsonl" | "parse-jsonl";
  file: string;
  start?: number;
  mode?: "stats" | "entries";
};

type UtilityResponse = {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
};

const parentPort = process.parentPort;
if (!parentPort) throw new Error("transcript utility requires Electron utilityProcess");

async function scan(request: UtilityRequest): Promise<unknown> {
  const start = Math.max(0, Math.floor(request.start ?? 0));
  const withEntries = request.method === "parse-jsonl" || request.mode === "entries";
  const stream = createReadStream(request.file, { encoding: "utf8", ...(start > 0 ? { start } : {}) });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const entries: unknown[] = [];
  let lineCount = 0;
  let parsedCount = 0;
  let malformed = 0;
  let bytes = start;
  let firstId: string | undefined;
  let lastId: string | undefined;
  try {
    for await (const line of lines) {
      lineCount += 1;
      bytes += Buffer.byteLength(line, "utf8") + 1;
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as unknown;
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        parsedCount += 1;
        const id = (value as { id?: unknown }).id;
        if (typeof id === "string") {
          firstId ??= id;
          lastId = id;
        }
        if (withEntries) entries.push(value);
      } catch {
        malformed += 1;
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return withEntries
    ? { entries, lineCount, parsedCount, malformed, bytes, firstId, lastId }
    : { lineCount, parsedCount, malformed, bytes, firstId, lastId };
}

parentPort.on("message", async (event: unknown) => {
  const request = ((event as { data?: unknown })?.data ?? event) as UtilityRequest;
  let response: UtilityResponse;
  try {
    if (!request || typeof request.id !== "number" || typeof request.file !== "string") throw new Error("invalid utility request");
    if (request.method !== "scan-jsonl" && request.method !== "parse-jsonl") throw new Error("unknown utility method");
    response = { id: request.id, ok: true, result: await scan(request) };
  } catch (error) {
    response = { id: request?.id ?? -1, ok: false, error: String(error) };
  }
  parentPort.postMessage(response);
});
