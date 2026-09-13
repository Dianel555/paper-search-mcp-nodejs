import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import type { LookupAddress } from 'node:dns';

export interface PublicUrlValidation {
  url: string;
  hostname: string;
  addresses: LookupAddress[];
}

export interface PublicUrlValidationOptions {
  lookup?: (hostname: string) => Promise<LookupAddress[]>;
}

const PRIVATE_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
  'metadata.google.com'
]);

function isPrivateIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return true;
  }

  const [first, second] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && (second === 0 || second === 168)) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51) ||
    (first === 203 && second === 0) ||
    first >= 224
  );
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0];
  const dottedMapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dottedMapped) return isPrivateIpv4(dottedMapped[1]);
  const groups = expandIpv6Groups(normalized);
  if (groups.length !== 8 || groups.some(group => !Number.isInteger(group) || group < 0 || group > 0xffff)) {
    return true;
  }

  const firstGroup = groups[0];
  if ((firstGroup & 0xfe00) === 0xfc00 || // fc00::/7, including fd00::/8
      (firstGroup & 0xffc0) === 0xfe80 || // fe80::/10
      (firstGroup & 0xffc0) === 0xfec0 || // deprecated site-local fec0::/10
      (firstGroup & 0xff00) === 0xff00 || // ff00::/8 multicast
      (groups[0] === 0x2001 && groups[1] === 0x0db8)) { // documentation range
    return true;
  }

  // IPv4-mapped IPv6 may use dotted-decimal, compressed, or fully expanded
  // notation. Treat IPv4-compatible forms conservatively as non-public too.
  const mapped = groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff;
  const compatible = groups.slice(0, 6).every(group => group === 0);
  if (mapped) {
    const addressV4 = `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
    return isPrivateIpv4(addressV4);
  }
  if (compatible) {
    // ::/96 contains unspecified and IPv4-compatible addresses; rejecting it
    // avoids allowing a private IPv4 destination through alternate notation.
    return true;
  }

  // The loopback address is commonly written in fully expanded form.
  return groups.every((group, index) => group === 0 || (index === 7 && group === 1));
}

function expandIpv6Groups(address: string): number[] {
  const [left, right] = address.split('::');
  const leftGroups = left ? left.split(':').filter(Boolean).map(group => Number.parseInt(group, 16)) : [];
  const rightGroups = right ? right.split(':').filter(Boolean).map(group => Number.parseInt(group, 16)) : [];
  const missing = Math.max(0, 8 - leftGroups.length - rightGroups.length);
  return [...leftGroups, ...Array.from({ length: missing }, () => 0), ...rightGroups];
}

export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return !isPrivateIpv4(address);
  if (version === 6) return !isPrivateIpv6(address);
  return false;
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

export function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

export function getHeaderValue(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();

  if (typeof (headers as { get?: (key: string) => unknown }).get === 'function') {
    const value = (headers as { get: (key: string) => unknown }).get(name);
    if (value !== undefined && value !== null) return String(value);
  }

  if (typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (key.toLowerCase() === wanted && value !== undefined && value !== null) {
        return Array.isArray(value) ? value.join(', ') : String(value);
      }
    }
  }

  return undefined;
}

/**
 * Resolve and validate every address used for a public HTTP(S) request.
 * All resolved addresses must be public so a mixed DNS answer cannot bypass
 * the SSRF guard.
 */
export async function validatePublicHttpUrl(
  value: string,
  options: PublicUrlValidationOptions = {}
): Promise<PublicUrlValidation> {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Only valid HTTP(S) URLs are allowed');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only HTTP(S) URLs are allowed');
  }
  if (parsed.username || parsed.password) {
    throw new Error('URLs containing userinfo are not allowed');
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (!hostname || PRIVATE_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error('Private or local network targets are not allowed');
  }

  let addresses: LookupAddress[];
  const literalVersion = isIP(hostname);
  if (literalVersion) {
    addresses = [{ address: hostname, family: literalVersion }];
  } else {
    const lookup = options.lookup || (async (host: string) =>
      dns.lookup(host, { all: true, verbatim: true }));
    try {
      addresses = await lookup(hostname);
    } catch {
      throw new Error('Unable to resolve public target host');
    }
  }

  if (!addresses.length || addresses.some(address => !isPublicAddress(address.address))) {
    throw new Error('Private or non-public network targets are not allowed');
  }

  return { url: parsed.toString(), hostname, addresses };
}

/**
 * Pin an Axios/Node request to the addresses checked immediately before it.
 * This prevents a second DNS lookup from rebinding a validated hostname.
 */
export function createPinnedLookup(addresses: LookupAddress[]) {
  return (
    _hostname: string,
    optionsOrCallback: { all?: boolean } | ((error: Error | null, address?: string | LookupAddress[], family?: number) => void),
    maybeCallback?: (error: Error | null, address?: string | LookupAddress[], family?: number) => void
  ) => {
    const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    if (!callback) return;
    const address = addresses[0];
    if (!address) {
      callback(new Error('No validated public address available'));
      return;
    }
    if (options?.all) {
      callback(null, [address]);
    } else {
      callback(null, address.address, address.family);
    }
  };
}

export function disposeResponseBody(body: unknown): void {
  if (body && typeof (body as { destroy?: () => void }).destroy === 'function') {
    (body as { destroy: () => void }).destroy();
  }
}
