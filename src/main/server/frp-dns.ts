import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { frpDnsVerdict, isFrpDomain, isFrpHost, type FrpDnsCheck } from "../../shared/frp.ts";

/**
 * Resolve an frp domain and the frps server address, and say whether they agree.
 *
 * Uses the system resolver (`getaddrinfo`), the one every other program on this machine
 * uses, so a record in `/etc/hosts` counts here exactly as it does in a browser. That is
 * also its limit: it answers for *this* machine's resolver, not the phone's — a fresh
 * record can already resolve here and not yet on a carrier's DNS, which is why the pane
 * says a mismatch or a miss may be propagation rather than a mistake.
 *
 * Free of Electron so a test can drive it with a fake resolver.
 */

export type Resolve = (host: string) => Promise<string[]>;

const LOOKUP_TIMEOUT_MS = 5_000;

async function systemResolve(host: string): Promise<string[]> {
  const addresses = await lookup(host, { all: true });
  return addresses.map((entry) => entry.address);
}

/** Addresses, IPv4 first, or none — a failed or slow lookup is an answer, not an error. */
async function resolveQuietly(host: string, resolve: Resolve): Promise<string[]> {
  if (isIP(host)) return [host];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = await Promise.race([
      resolve(host),
      new Promise<string[]>((settle) => {
        timer = setTimeout(() => settle([]), LOOKUP_TIMEOUT_MS);
      }),
    ]);
    const unique = [...new Set(addresses)];
    return [...unique.filter((address) => isIP(address) === 4), ...unique.filter((address) => isIP(address) !== 4)];
  } catch {
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function checkFrpDns(
  payload: { domain?: unknown; serverAddr?: unknown },
  resolve: Resolve = systemResolve,
): Promise<FrpDnsCheck> {
  const domain = typeof payload.domain === "string" ? payload.domain.trim().toLowerCase() : "";
  const serverAddr = typeof payload.serverAddr === "string" ? payload.serverAddr.trim().toLowerCase() : "";
  // Only names the form would accept are looked up: this runs on every pause in typing,
  // and a half-typed `fastvibe.exam` is not worth a trip to the resolver.
  if (!isFrpDomain(domain)) throw new Error("域名格式无效");
  const [domainAddresses, serverAddresses] = await Promise.all([
    resolveQuietly(domain, resolve),
    isFrpHost(serverAddr) ? resolveQuietly(serverAddr, resolve) : Promise.resolve([]),
  ]);
  return {
    domain,
    verdict: frpDnsVerdict(domainAddresses, serverAddresses),
    domainAddresses,
    serverAddresses,
  };
}
