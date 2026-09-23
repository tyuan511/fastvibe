import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("headless Agent HTTP and HTTPS fetches use the remote host's proxy", async () => {
  let connections = 0;
  let tunnels = 0;
  const proxy = createServer((_request, response) => {
    connections++;
    response.end("via-proxy");
  });
  proxy.on("connect", (_request, socket) => {
    tunnels++;
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.once("data", () => {
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 9\r\nConnection: close\r\n\r\nvia-proxy");
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));

  try {
    const address = proxy.address();
    assert.ok(address && typeof address !== "string");
    const moduleUrl = new URL("../src/agent/http-proxy.ts", import.meta.url).href;
    const script = `
      const { configureAgentHttpProxy } = await import(${JSON.stringify(moduleUrl)});
      configureAgentHttpProxy();
      const response = await fetch("http://unreachable.invalid/", { signal: AbortSignal.timeout(5000) });
      console.log(await response.text());
      try { await fetch("https://unreachable.invalid/", { signal: AbortSignal.timeout(5000) }); }
      catch { console.log("https-attempted"); }
    `;
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
      timeout: 8_000,
      env: {
        ...process.env,
        http_proxy: "",
        https_proxy: "",
        all_proxy: "",
        ALL_PROXY: "",
        HTTPS_PROXY: "",
        HTTP_PROXY: `http://127.0.0.1:${address.port}`,
        no_proxy: "",
        NO_PROXY: "",
        NODE_USE_ENV_PROXY: "",
      },
    });
    assert.equal(stdout.trim(), "via-proxy\nhttps-attempted");
    assert.equal(connections, 1);
    assert.equal(tunnels, 1);
  } finally {
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
});
