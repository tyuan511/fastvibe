/**
 * Whether an address this machine is serving is one another device can open.
 *
 * Split out of `address-actions.tsx` for the same reason `qr-path.ts` sits beside its
 * component: this is the step that decides whether a control is drawn at all, and it can
 * be wrong while looking right. The pane it feeds showed a QR icon for `127.0.0.1:7777`
 * — a code that scans perfectly and then fails with 连接被拒绝 on the phone, which is the
 * one outcome worse than showing no code.
 *
 * Loopback is the whole of the question: it is a name for *this* machine, so every other
 * device that resolves it reaches itself. Anything else — a LAN address, an mDNS name, a
 * tunnel hostname — names something a phone can actually arrive at. A hostname is assumed
 * reachable: it is the user's own tunnel and the user's own DNS, and a resolution failure
 * is not something this function could distinguish from a working one anyway.
 *
 * The input is whatever the settings pane prints — `host:port`, with no scheme — because
 * it is handed the same string it shows the reader, so the code and the label cannot
 * disagree about which address they are talking about.
 */
export function isReachableFromAnotherDevice(address: string): boolean {
  const host = hostOf(address);
  // An address this cannot read is assumed reachable: refusing to draw a code for
  // something merely unrecognised would be its own kind of wrong, and nothing here is a
  // security boundary — the address is printed beside the icon either way.
  if (host === null) return true;
  if (host.kind === "ipv6") return !isIpv6Loopback(host.name);
  return !(host.name === "localhost" || /^127\.\d+\.\d+\.\d+$/.test(host.name));
}

type Host = { name: string; kind: "ipv4" | "ipv6" | "name" };

/**
 * The host part of `host`, `host:port`, `[v6]`, `[v6]:port` or a full URL.
 *
 * Hand-rolled rather than one `new URL` because the input is a string a human may have
 * typed into a host field, and the forms that matter here are the ones that make `URL`
 * throw: a bare `host:port` parses as a scheme (`192` …), a bare hostname has no
 * hostname, and a bracketless IPv6 literal has no URL at all.
 */
function hostOf(address: string): Host | null {
  const trimmed = address.trim();
  if (!trimmed) return null;

  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(trimmed);
  if (bracketed) return { name: bracketed[1]!.toLowerCase(), kind: "ipv6" };

  // Two or more colons and no brackets: an IPv6 literal, taken whole. `::1:7777` is
  // ambiguous by nature — it is a valid address, and there is no port to strip from it.
  if (!trimmed.includes("/") && trimmed.split(":").length >= 3) {
    return { name: trimmed.toLowerCase(), kind: "ipv6" };
  }

  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
    const name = url.hostname;
    if (name.startsWith("[")) return { name: name.slice(1, -1).toLowerCase(), kind: "ipv6" };
    return { name: name.toLowerCase(), kind: /^[\d.]+$/.test(name) ? "ipv4" : "name" };
  } catch {
    return null;
  }
}

/**
 * `::1` and the v4-mapped forms of loopback, in the spellings that reach here.
 *
 * Not a general IPv6 parser, and deliberately not one: the only question asked is whether
 * the address means 「this machine」, and a strict parser that misjudged a global address
 * would hide a code that works. Everything unrecognised is "other".
 */
function isIpv6Loopback(name: string): boolean {
  if (name === "::1" || name === "0:0:0:0:0:0:0:1") return true;
  // `::ffff:127.0.0.1` — the v4-mapped form. `::ffff:7f00:1` is the same address in
  // hexadecimal, so compare a mapped address's bytes rather than its text.
  const mapped = /^(?:::ffff:|::)(.+)$/.exec(name)?.[1];
  if (!mapped) return false;
  if (mapped.includes(".")) return /^127\.\d+\.\d+\.\d+$/.test(mapped);
  const groups = mapped.split(":").filter(Boolean);
  if (groups.length !== 2) return false;
  const high = Number.parseInt(groups[0]!, 16);
  const low = Number.parseInt(groups[1]!, 16);
  if (Number.isNaN(high) || Number.isNaN(low)) return false;
  // 127.0.0.0/8 is `7f00::` in the top two groups.
  return high === 0x7f00 && (low >>> 8) === 0;
}
