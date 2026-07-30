// BlueTeam.News — SSRF-safe outbound fetch.
//
// Article links and feed URLs come from untrusted (operator- or feed-supplied)
// input. A raw fetch() would happily request http://169.254.169.254/... or an
// internal service, and follow a redirect into one. Every outbound request to
// an untrusted URL goes through safeFetch:
//   1. scheme is http/https only
//   2. the hostname is DNS-resolved and every resulting address is checked
//      against private / loopback / link-local / metadata ranges
//   3. the connection is pinned to that exact vetted address (see
//      pinnedDispatcher below) — the OS/fetch never gets a second, unchecked
//      chance to resolve the hostname, which closes the DNS-rebind TOCTOU
//      between validation and connect
//   4. redirects are followed manually and each hop is re-validated + re-pinned
//   5. the body is read with a hard byte cap

import dns from 'node:dns/promises';
import net from 'node:net';
import { Agent, fetch as undiciFetch, Headers as UndiciHeaders } from 'undici';

const DNS_TIMEOUT_MS = 4000;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const o = Number(p);
    if (o > 255) return null;
    n = (n << 8) | o;
  }
  return n >>> 0;
}

function isBlockedIPv4(ip) {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // unparseable → fail closed
  const inRange = (base, bits) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (n & mask) === (ipv4ToInt(base) & mask);
  };
  return (
    inRange('0.0.0.0', 8) ||        // "this" network
    inRange('10.0.0.0', 8) ||       // private
    inRange('100.64.0.0', 10) ||    // CGNAT
    inRange('127.0.0.0', 8) ||      // loopback
    inRange('169.254.0.0', 16) ||   // link-local (incl. 169.254.169.254 metadata)
    inRange('172.16.0.0', 12) ||    // private
    inRange('192.0.0.0', 24) ||     // IETF protocol assignments
    inRange('192.0.2.0', 24) ||     // TEST-NET-1
    inRange('192.168.0.0', 16) ||   // private
    inRange('198.18.0.0', 15) ||    // benchmarking
    inRange('198.51.100.0', 24) ||  // TEST-NET-2
    inRange('203.0.113.0', 24) ||   // TEST-NET-3
    inRange('224.0.0.0', 4) ||      // multicast
    inRange('240.0.0.0', 4)         // reserved / broadcast
  );
}

// Parse an IPv6 literal (with optional zone id and embedded IPv4) to 16 bytes.
// Returns null on anything it can't confidently parse — callers fail closed.
function ipv6ToBytes(input) {
  const str = input.split('%')[0]; // drop zone id
  let head = str;
  let v4 = null;

  const v4match = str.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4match) {
    v4 = ipv4ToInt(v4match[1]);
    if (v4 === null) return null;
    head = str.slice(0, v4match.index);
    head = head.replace(/:$/, ''); // trim the ':' before the v4 tail
  }

  const halves = head.split('::');
  if (halves.length > 2) return null;
  const groupsOf = (s) => (s ? s.split(':').filter((x) => x !== '') : []);
  const left = groupsOf(halves[0]);
  const right = halves.length === 2 ? groupsOf(halves[1]) : [];

  const v4groups = v4 !== null ? 2 : 0;
  let groups;
  if (halves.length === 2) {
    const zeros = 8 - (left.length + right.length + v4groups);
    if (zeros < 0) return null;
    groups = [...left, ...Array(zeros).fill('0'), ...right];
  } else {
    if (left.length + v4groups !== 8) return null;
    groups = left;
  }

  const bytes = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const v = parseInt(g, 16);
    bytes.push((v >> 8) & 0xff, v & 0xff);
  }
  if (v4 !== null) {
    bytes.push((v4 >>> 24) & 0xff, (v4 >>> 16) & 0xff, (v4 >>> 8) & 0xff, v4 & 0xff);
  }
  return bytes.length === 16 ? bytes : null;
}

function isBlockedIPv6(ip) {
  const b = ipv6ToBytes(ip);
  if (!b) return true; // fail closed
  if (b.every((x) => x === 0)) return true;                              // :: unspecified
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true;  // ::1 loopback
  if ((b[0] & 0xfe) === 0xfc) return true;                               // fc00::/7 ULA
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;              // fe80::/10 link-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true;              // fec0::/10 deprecated site-local
  if (b[0] === 0xff) return true;                                        // ff00::/8 multicast
  // IPv4-transition prefixes can route to an IPv4 address encoded later in
  // the literal. Blocking only mapped-v4 leaves NAT64/6to4 as a possible path
  // to RFC1918 or link-local services on networks that provide a translator.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    const wellKnownNat64 = b.slice(4, 12).every((x) => x === 0);          // 64:ff9b::/96
    const localNat64 = b[4] === 0 && b[5] === 1;                          // 64:ff9b:1::/48
    if (wellKnownNat64 || localNat64) return true;
  }
  if (b[0] === 0x20 && b[1] === 0x02) return true;                       // 2002::/16 6to4
  // ::ffff:a.b.c.d (IPv4-mapped) and ::a.b.c.d (deprecated IPv4-compatible)
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) {
    return isBlockedIPv4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
  }
  if (b.slice(0, 12).every((x) => x === 0)) {
    return isBlockedIPv4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
  }
  return false;
}

export function isBlockedIP(addr) {
  const fam = net.isIP(addr);
  if (fam === 4) return isBlockedIPv4(addr);
  if (fam === 6) return isBlockedIPv6(addr);
  return true; // not an IP literal → fail closed
}

// Node's URL implementation retains square brackets in `.hostname` for an
// IPv6 literal. net.isIP/dns.lookup expect the bare address, while URL Host
// headers must keep the brackets; normalize only at the validation/connect
// boundary and leave the URL object untouched.
function bareHostname(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

// Resolve `host` and vet every returned address against the SSRF blocklist,
// failing closed on timeout/empty/blocked. Shared by assertPublicUrl (which
// only needs a yes/no) and safeFetch (which also needs the vetted address
// itself, to pin the connection — see resolvePinnedAddress below).
async function resolveVettedAddresses(host) {
  // dns.lookup has no built-in timeout and is NOT covered by the caller's fetch
  // abort signal (it runs before the fetch). An unbounded lookup would stall the
  // pipeline worker, so race it against a hard deadline and fail closed.
  let addrs;
  try {
    addrs = await withTimeout(dns.lookup(host, { all: true }), DNS_TIMEOUT_MS);
  } catch {
    throw new Error(`blocked: DNS lookup failed or timed out for ${host}`);
  }
  if (!addrs.length) throw new Error(`blocked: no DNS records for ${host}`);
  for (const a of addrs) {
    if (isBlockedIP(a.address)) throw new Error(`blocked: ${host} resolves to private ${a.address}`);
  }
  return addrs;
}

// Validate `u` is safe to fetch and return the single address the connection
// must be pinned to (the IP literal itself, or the first vetted DNS result).
// This is the ONLY resolution that happens for a given hop — assertPublicUrl
// and safeFetch both funnel through here so the address that gets vetted is
// exactly the address that gets connected to, with no second independent
// lookup in between for a DNS-rebind attacker to win.
async function assertPublicUrlPinned(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error('blocked: invalid URL');
  }
  // URL userinfo is almost always accidental in this application, is sent as
  // credentials by HTTP clients, and can leak verbatim when callers include a
  // rejected URL in an error log. Reject it before DNS or fetch with a generic
  // message that never echoes the secret-bearing input.
  if (u.username || u.password) {
    throw new Error('blocked: URL credentials are not allowed');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`blocked: scheme ${u.protocol}`);
  }

  const host = bareHostname(u.hostname);
  if (net.isIP(host)) {
    if (isBlockedIP(host)) throw new Error(`blocked: private address ${host}`);
    return { u, pinnedIp: host };
  }

  const addrs = await resolveVettedAddresses(host);
  return { u, pinnedIp: addrs[0].address };
}

/** Validate a URL is safe to fetch; throws (message prefixed "blocked:") otherwise. */
export async function assertPublicUrl(rawUrl) {
  const { u } = await assertPublicUrlPinned(rawUrl);
  return u;
}

// Use Undici's supported Agent/connect surface instead of implementing its
// low-level Dispatcher handler protocol. The latter changed between the
// versions bundled in Node 22/24 and Node 26; a custom lookup is stable, leaves
// body/backpressure semantics to Undici, and still pins the socket to the exact
// address vetted above. TLS SNI and Host continue to use the original URL host.
const MAX_PINNED_DISPATCHERS = 64;
const pinnedDispatchers = new Map();
let transportFetch = undiciFetch;

function createPinnedLookup(pinnedIp) {
  const family = net.isIP(pinnedIp);
  if (!family) throw new Error('blocked: invalid pinned address');
  return (_hostname, options, callback) => {
    if (options?.all) callback(null, [{ address: pinnedIp, family }]);
    else callback(null, pinnedIp, family);
  };
}

function pinnedDispatcher(origin, pinnedIp) {
  const key = `${origin}\u0000${pinnedIp}`;
  const existing = pinnedDispatchers.get(key);
  if (existing) {
    pinnedDispatchers.delete(key);
    pinnedDispatchers.set(key, existing);
    return existing;
  }

  const dispatcher = new Agent({
    connections: 2,
    pipelining: 1,
    connect: { lookup: createPinnedLookup(pinnedIp) },
  });
  pinnedDispatchers.set(key, dispatcher);

  if (pinnedDispatchers.size > MAX_PINNED_DISPATCHERS) {
    const [oldestKey, oldest] = pinnedDispatchers.entries().next().value;
    pinnedDispatchers.delete(oldestKey);
    oldest.close().catch(() => {});
  }
  return dispatcher;
}

/** Close outbound connection pools during graceful process shutdown. */
export async function closeOutboundDispatchers() {
  const closing = [...pinnedDispatchers.values()].map(dispatcher => dispatcher.close());
  pinnedDispatchers.clear();
  await Promise.allSettled(closing);
}

/** Test-only transport injection; production always uses the pinned Undici fetch. */
export function _setTransportFetchForTests(implementation = undiciFetch) {
  transportFetch = implementation;
}

/** Test-only view of the lookup contract, without opening a socket. */
export function _createPinnedLookupForTests(pinnedIp) {
  return createPinnedLookup(pinnedIp);
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// Fetch strips credential-bearing headers when a redirect crosses origins. Our
// redirect loop is manual (so every hop can be SSRF-vetted), therefore it must
// reproduce that boundary explicitly. `apiKey` is NVD's credential header; the
// x-api-key spelling is common for operator-configured integrations.
const CROSS_ORIGIN_CREDENTIAL_HEADERS = [
  'authorization', 'proxy-authorization', 'cookie', 'cookie2', 'apikey', 'x-api-key',
];
const REQUEST_BODY_HEADERS = [
  'content-encoding', 'content-language', 'content-length', 'content-location',
  'content-type', 'transfer-encoding',
];

function deleteHeaders(headers, names) {
  for (const name of names) headers.delete(name);
}

/**
 * fetch() that validates the URL (and every redirect hop) against the SSRF
 * blocklist. Returns the final Response with its body unread — read it with
 * readCapped() to enforce a size limit.
 *
 * Each hop's connection is pinned to the exact IP just vetted (see
 * assertPublicUrlPinned/pinnedDispatcher above), so a hostname that resolves
 * to a public address on validation and a private one on connect (DNS
 * rebinding) cannot slip through between the check and the request.
 */
export async function safeFetch(url, options = {}, { maxRedirects = 3 } = {}) {
  let current = url;
  let requestOptions = { ...options, headers: new UndiciHeaders(options.headers || {}) };
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const { u, pinnedIp } = await assertPublicUrlPinned(current);
    const dispatcher = pinnedDispatcher(u.origin, pinnedIp);
    const res = await transportFetch(current, { ...requestOptions, redirect: 'manual', dispatcher });
    if (REDIRECT_STATUSES.has(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) return res;
      try { await res.body?.cancel(); } catch { /* already closed */ }
      const next = new URL(loc, current);
      const headers = new UndiciHeaders(requestOptions.headers || {});

      if (next.origin !== new URL(current).origin) {
        deleteHeaders(headers, CROSS_ORIGIN_CREDENTIAL_HEADERS);
      }

      // Match Fetch redirect semantics: 301/302 rewrite POST to GET; 303
      // rewrites every method except GET/HEAD. 307/308 preserve method + body.
      const method = String(requestOptions.method || 'GET').toUpperCase();
      const rewriteToGet = ((res.status === 301 || res.status === 302) && method === 'POST')
        || (res.status === 303 && method !== 'GET' && method !== 'HEAD');
      if (rewriteToGet) {
        deleteHeaders(headers, REQUEST_BODY_HEADERS);
        requestOptions = { ...requestOptions, method: 'GET', body: undefined, headers };
      } else {
        requestOptions = { ...requestOptions, headers };
      }

      current = next.href;
      continue;
    }
    return res;
  }
  throw new Error('blocked: too many redirects');
}

// Match a charset= param in a Content-Type header value, e.g.
// "text/xml; charset=ISO-8859-1" → "ISO-8859-1".
const CONTENT_TYPE_CHARSET_RE = /charset=["']?([\w-]+)/i;

// Match the `encoding="..."` attribute of an XML prolog, e.g.
// <?xml version="1.0" encoding="windows-1252"?>. Only looked at when the
// Content-Type didn't already give us a charset — the prolog is always
// within the first ~100 bytes of a well-formed feed.
const XML_PROLOG_ENCODING_RE = /^﻿?<\?xml[^>]*\bencoding=["']([\w-]+)["']/i;

// Resolve the charset a response body should be decoded with: Content-Type's
// charset param wins, then the XML prolog's encoding attribute (sniffed from
// the first chunk), defaulting to UTF-8. Returns a label TextDecoder accepts,
// or 'utf-8' if the declared one is missing/unsupported — never throws, since
// mis-declared feeds should degrade to (possibly mojibake'd) UTF-8, not fail.
function resolveCharset(res, firstChunk) {
  const ct = res.headers?.get?.('content-type') || '';
  const ctMatch = ct.match(CONTENT_TYPE_CHARSET_RE);
  if (ctMatch) return ctMatch[1];

  if (firstChunk?.length) {
    // The prolog is ASCII-range, so a Latin1 decode of just the sniff window
    // is safe regardless of the body's real encoding.
    const sniff = firstChunk.subarray(0, 200).toString('latin1');
    const xmlMatch = sniff.match(XML_PROLOG_ENCODING_RE);
    if (xmlMatch) return xmlMatch[1];
  }
  return 'utf-8';
}

/** Read a Response body to a string, aborting if it exceeds maxBytes. */
export async function readCapped(res, maxBytes = 2_000_000) {
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* already closed */ }
      throw new Error('blocked: response too large');
    }
    chunks.push(Buffer.from(value));
  }
  const body = Buffer.concat(chunks);
  const charset = resolveCharset(res, chunks[0]);
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    // Unsupported/garbled charset label — fail soft to UTF-8 rather than
    // throwing away an otherwise-good response.
    return body.toString('utf-8');
  }
}
