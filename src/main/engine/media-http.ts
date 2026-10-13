import type { IncomingMessage, ServerResponse } from "node:http";
import { openMediaBody } from "./media-file.ts";

/** Write one local media file to an HTTP response, honoring `Range`. */
export function pipeMediaHttp(request: IncomingMessage, response: ServerResponse, filePath: string): void {
  const opened = openMediaBody(filePath, request.method ?? "GET", headerValue(request.headers.range));
  if (!opened.ok) {
    response.writeHead(opened.status, opened.headers ?? { "cache-control": "no-store" });
    response.end();
    return;
  }
  response.writeHead(opened.status, opened.headers);
  const stream = opened.stream;
  if (!stream) {
    response.end();
    return;
  }
  const stop = (): void => {
    stream.destroy();
  };
  request.on("close", stop);
  stream.on("error", stop);
  stream.on("close", () => request.removeListener("close", stop));
  stream.pipe(response);
}

function headerValue(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}
