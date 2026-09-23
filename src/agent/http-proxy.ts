import { EnvHttpProxyAgent, install, setGlobalDispatcher } from "undici";

/**
 * The embedded pi SDK does not run its CLI's HTTP dispatcher setup. Install the same
 * environment-aware dispatcher before the headless Agent creates its runtime, so
 * model requests and other fetch calls use the remote host's proxy variables.
 */
export function configureAgentHttpProxy(): void {
  const httpProxy = process.env.http_proxy || process.env.HTTP_PROXY;
  const httpsProxy = process.env.https_proxy || process.env.HTTPS_PROXY;
  if (!httpProxy && !httpsProxy) return;

  setGlobalDispatcher(new EnvHttpProxyAgent({ httpProxy, httpsProxy, noProxy: process.env.no_proxy || process.env.NO_PROXY }));
  // Node's built-in fetch can use a different Undici version from this dispatcher.
  // Give SDK and app fetch calls the same implementation and proxy behavior.
  install();
}
