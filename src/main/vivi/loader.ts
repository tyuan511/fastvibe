import { app, protocol } from "electron";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../engine/logger";

type ViviResourceRequest = { url: string };

export function getViviModelPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "vivi", "vivi.glb")
    : join(app.getAppPath(), "resources", "vivi", "vivi.glb");
}

/** Register the private model scheme before any pet renderer loads. */
export function registerViviScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: "vivi-resource",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  }]);
}

export function registerViviProtocol(): void {
  protocol.handle("vivi-resource", async (request: ViviResourceRequest) => {
    if (new URL(request.url).hostname !== "model") return new Response("Not found", { status: 404 });
    try {
      const data = await readFile(getViviModelPath());
      return new Response(data, { headers: { "content-type": "model/gltf-binary", "cache-control": "public, max-age=31536000, immutable" } });
    } catch (error) {
      log.warn(`Vivi model unavailable: ${String(error)}`);
      return new Response("Vivi model unavailable", { status: 404 });
    }
  });
}
