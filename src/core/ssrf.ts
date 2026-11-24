import { lookup } from "node:dns/promises";
import { Effect, Result } from "effect";
import * as IpNetwork from "effect/net/IpNetwork";
import * as NetAddress from "effect/net/NetAddress";
import { SsrfBlockedError } from "./errors.ts";

/**
 * Hop-safe SSRF guard built on Effect's `effect/net` (`NetAddress`, `IpNetwork`).
 * Refuses non-http(s) schemes, localhost/metadata hostnames, double-dot/trailing-dot
 * bypass tricks, and any IP literal or DNS-resolved address falling in non-public ranges.
 */

const BLOCKED_V4_NETWORKS = [
  "0.0.0.0/8",       // current network / unspecified
  "10.0.0.0/8",      // RFC 1918
  "100.64.0.0/10",   // RFC 6598 CGNAT
  "127.0.0.0/8",     // loopback
  "169.254.0.0/16",  // link-local & cloud metadata
  "172.16.0.0/12",   // RFC 1918
  "192.0.0.0/24",    // IETF protocol assignments
  "192.0.2.0/24",    // TEST-NET-1
  "192.168.0.0/16",  // RFC 1918
  "198.18.0.0/15",   // benchmarking
  "198.51.100.0/24", // TEST-NET-2
  "203.0.113.0/24",  // TEST-NET-3
  "224.0.0.0/4",     // multicast
  "240.0.0.0/4",     // reserved / broadcast
].map((cidr) => IpNetwork.fromStringUnsafe(cidr));

const BLOCKED_V6_NETWORKS = [
  "::/96",           // IPv4-compatible (deprecated) + unspecified + loopback
  "::1/128",         // loopback
  "::ffff:0:0/96",   // IPv4-mapped (checked recursively via extracted IPv4 too)
  "64:ff9b::/96",    // NAT64 well-known
  "64:ff9b:1::/48",  // NAT64 local-use
  "100::/64",        // discard-only
  "2001::/32",       // Teredo tunneling
  "2001:db8::/32",   // documentation
  "2002::/16",       // 6to4 tunneling
  "fc00::/7",        // unique local (ULA)
  "fe80::/10",       // link-local
  "ff00::/8",        // multicast
].map((cidr) => IpNetwork.fromStringUnsafe(cidr));

const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.goog",
  "metadata",
  "instance-data",
]);

function normalizeHost(raw: string): string {
  let host = raw.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  // Strip IPv6 zone index if present
  const zone = host.indexOf("%");
  if (zone >= 0) host = host.slice(0, zone);
  return host;
}

export function isNonPublicIp(rawIp: string): string | null {
  const host = normalizeHost(rawIp);
  const v4 = NetAddress.ipv4FromString(host);
  if (Result.isSuccess(v4)) {
    const addr = v4.success;
    if (
      NetAddress.isUnspecified(addr) ||
      NetAddress.isLoopback(addr) ||
      NetAddress.isPrivate(addr) ||
      NetAddress.isLinkLocal(addr) ||
      NetAddress.isMulticast(addr) ||
      NetAddress.isBroadcast(addr) ||
      BLOCKED_V4_NETWORKS.some((net) => IpNetwork.contains(net, addr))
    ) {
      return `non-public IPv4 ${host}`;
    }
    return null;
  }

  const v6 = NetAddress.ipv6FromString(host);
  if (Result.isSuccess(v6)) {
    const addr = v6.success;
    if (
      NetAddress.isUnspecified(addr) ||
      NetAddress.isLoopback(addr) ||
      NetAddress.isLinkLocal(addr) ||
      NetAddress.isUniqueLocal(addr) ||
      NetAddress.isMulticast(addr) ||
      NetAddress.isIpv4Mapped(addr) ||
      BLOCKED_V6_NETWORKS.some((net) => IpNetwork.contains(net, addr))
    ) {
      return `non-public IPv6 ${host}`;
    }
    return null;
  }

  return null;
}

export function validatePublicUrlSyntax(input: URL | string): URL | SsrfBlockedError {
  let url: URL;
  try {
    url = input instanceof URL ? input : new URL(input);
  } catch {
    return new SsrfBlockedError({ url: String(input), reason: "invalid URL" });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return new SsrfBlockedError({ url: url.href, reason: `disallowed scheme ${url.protocol}` });
  }
  if (url.username || url.password) {
    return new SsrfBlockedError({ url: url.href, reason: "embedded credentials not allowed" });
  }
  const host = normalizeHost(url.hostname);
  if (!host) {
    return new SsrfBlockedError({ url: url.href, reason: "missing host" });
  }
  // Reject double-dot or trailing-dot hostnames used to bypass suffix rules.
  const stripped = host.replace(/\.+$/, "");
  if (
    !stripped ||
    stripped.includes("..") ||
    BLOCKED_HOSTS.has(stripped) ||
    stripped.endsWith(".localhost") ||
    stripped.endsWith(".local") ||
    stripped.endsWith(".internal") ||
    stripped.endsWith(".home.arpa")
  ) {
    return new SsrfBlockedError({ url: url.href, reason: `disallowed host ${host}` });
  }
  const ipReason = isNonPublicIp(host);
  if (ipReason) {
    return new SsrfBlockedError({ url: url.href, reason: ipReason });
  }
  return url;
}

export function assertPublicUrl(
  input: URL | string,
  options?: { readonly resolveDns?: boolean },
): Effect.Effect<URL, SsrfBlockedError> {
  return Effect.gen(function* () {
    const checked = validatePublicUrlSyntax(input);
    if (checked instanceof SsrfBlockedError) return yield* Effect.fail(checked);
    const host = normalizeHost(checked.hostname);
    // If hostname is already a valid public IP literal, no DNS lookup needed.
    const isLiteral =
      Result.isSuccess(NetAddress.ipv4FromString(host)) ||
      Result.isSuccess(NetAddress.ipv6FromString(host));
    if (isLiteral || options?.resolveDns === false) return checked;

    const records = yield* Effect.tryPromise({
      try: () => lookup(host, { all: true, verbatim: true }),
      catch: () => new SsrfBlockedError({ url: checked.href, reason: `DNS lookup failed for ${host}` }),
    });
    if (!records.length) {
      return yield* Effect.fail(new SsrfBlockedError({ url: checked.href, reason: `no DNS records for ${host}` }));
    }
    for (const record of records) {
      const reason = isNonPublicIp(record.address);
      if (reason) {
        return yield* Effect.fail(new SsrfBlockedError({ url: checked.href, reason: `${host} resolved to ${reason}` }));
      }
    }
    return checked;
  });
}
