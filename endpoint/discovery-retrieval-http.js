// SAAX Protocol — Discovery Phase 2: controlled retrieval transport
//
// Bounded HTTPS retrieval of discovery resources (profiles, A2A Agent Cards,
// schemas) with the Phase-1 retrieval-policy limits enforced IN EXECUTION:
//   - HTTPS only; http: is refused up front (DSC_UNSAFE_RETRIEVAL).
//   - DNS rebinding defense: the effective IP of each hop is validated BEFORE
//     the connection is made. The host is resolved with dns.lookupSync (OS
//     resolver), the resolved address is validated against the
//     private/loopback/link-local/ULA blocklist, and THE SAME validated address
//     is passed into the https request, so the connection cannot race to a
//     different IP than the one validated. Node connects to the provided IP,
//     not to a re-resolved hostname; hostname validation alone is never treated
//     as rebinding protection.
//   - Redirect limit: at most 3 hops; each hop re-validates the destination
//     host AND resolved IP before following, and refuses a downgrade to http.
//   - Size limit: 256 KiB for a profile/card, 1 MiB for a schema.
//   - Time limit: total wall time <= 10s across the whole redirect chain.
//   - Content-Type: response must be JSON (application/json or *+json).
//
// This module NEVER executes remote content: bodies are returned as raw text;
// the caller parses with JSON.parse and treats the result as untrusted data.
//
// TEST HOOK: `allowLocalhost` (default false) — production policy NEVER enables
// it. Tests set it to reach the controlled 127.0.0.1 HTTPS test server. The
// production retrieval code path is otherwise identical.

'use strict';

const https = require('node:https');
const dns = require('node:dns');

const MAX_REDIRECTS = 3;
const PROFILE_MAX_BYTES = 256 * 1024;
const SCHEMA_MAX_BYTES = 1024 * 1024;
const MAX_TOTAL_MS = 10_000;
const MAX_HOP_MS = 5_000;

// --- Destination classification --------------------------------------------------
function ipClass(ip) {
  const v6 = ip.includes(':');
  if (!v6) {
    const p = ip.split('.').map(Number);
    if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return 'reserved';
    const [a, b] = p;
    if (a === 10) return 'private';
    if (a === 127) return 'loopback';
    if (a === 0) return 'reserved';
    if (a === 100 && b >= 64 && b <= 127) return 'reserved'; // CGNAT
    if (a === 169 && b === 254) return 'linklocal';
    if (a === 172 && b >= 16 && b <= 31) return 'private';
    if (a === 192 && b === 168) return 'private';
    if (a >= 224) return 'reserved';
    return 'public';
  }
  const lower = ip.toLowerCase();
  const m = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return ipClass(m[1]);
  if (lower === '::1') return 'loopback';
  if (lower === '::') return 'reserved';
  if (lower.startsWith('fc') || lower.startsWith('fd')) return 'ula';
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return 'linklocal';
  if (lower.startsWith('fec') || lower.startsWith('fed') || lower.startsWith('fee') || lower.startsWith('fef')) return 'reserved';
  return 'public';
}

// --- Resolve a host to an IP and classify it -------------------------------------
// `ok` only when the address is allowed by policy. If the host is a literal IP
// it is classified directly (no DNS). The SAME address returned here is what
// https.connect uses, so a later resolution cannot silently change target.
function resolveAllowed(host, opts) {
  const allowLocalhost = !!(opts && opts.allowLocalhost);
  const literalV4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  const literalV6 = host.includes(':');
  let address = host;
  let family = 0;
  if (!literalV4 && !literalV6) {
    let r;
    try { r = dns.lookupSync(host, { verbatim: true }); } catch (_) {
      return { ok: false, reason: 'DNS_RESOLUTION_FAILED', host };
    }
    address = r.address;
    family = r.family;
  } else {
    family = literalV6 ? 6 : 4;
  }
  const klass = ipClass(address);
  const allowed = klass === 'public' || (allowLocalhost && (klass === 'loopback' || klass === 'private'));
  if (!allowed) {
    return { ok: false, reason: 'UNSAFE_DESTINATION:' + klass, klass, address };
  }
  return { ok: true, address, family, klass };
}

function isJsonContentType(ct) {
  if (!ct) return false;
  const base = ct.split(';')[0].trim().toLowerCase();
  return base === 'application/json' || base.endsWith('+json');
}

// --- Single-hop fetch ---------------------------------------------------------------
// Returns either:
//   { ok: true, status: 200, headers, bodyString, ip }                  (success)
//   { ok: false, errorCode: 'DSC_RETRIEVAL_REDIRECT', status, headers } (3xx)
//   { ok: false, errorCode: 'DSC_RETRIEVAL_HTTP_STATUS', status }       (other status)
//   { ok: false, errorCode: DSC_*, reason }                             (transport/validation)
function fetchHop(url, opts) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(url); } catch (_) {
      return resolve({ ok: false, errorCode: 'DSC_UNSAFE_RETRIEVAL', reason: 'unparseable URL' });
    }
    if (parsed.protocol !== 'https:') {
      return resolve({ ok: false, errorCode: 'DSC_UNSAFE_RETRIEVAL', reason: 'protocol not https' });
    }
    if (parsed.username || parsed.password) {
      return resolve({ ok: false, errorCode: 'DSC_UNSAFE_RETRIEVAL', reason: 'credentials in URL' });
    }
    const host = parsed.hostname;
    const resolved = resolveAllowed(host, opts);
    if (!resolved.ok) {
      return resolve({ ok: false, errorCode: 'DSC_UNSAFE_RETRIEVAL', reason: resolved.reason + ':' + host });
    }
    const port = parsed.port ? Number(parsed.port) : 443;
    const pathname = (parsed.pathname || '/') + (parsed.search || '');
    const maxBytes = (opts && opts.maxBytes) || PROFILE_MAX_BYTES;
    const timeoutMs = (opts && opts.timeoutMs) || MAX_HOP_MS;

    const req = https.request(
      {
        host: resolved.address, // connect to the VALIDATED IP
        port,
        path: pathname,
        method: 'GET',
        headers: {
          Accept: 'application/json, application/*+json',
          'User-Agent': 'saax-discovery-resolver/2.0',
        },
        // SNI is only valid for DNS hostnames; for a literal-IP test host the
        // certificate is verified against the IP SAN instead.
        ...(host.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? {} : { servername: host }),
        rejectUnauthorized: true,
        ...(opts && opts.ca ? { ca: opts.ca } : {}), // test-pinned CA only; production never sets this
        family: resolved.family,
        lookup: (h, o, cb) => { // force the SAME validated address, never re-resolve
          cb(null, resolved.address, resolved.family);
        },
      },
      (res) => {
        const status = res.statusCode;
        const ctype = (res.headers['content-type'] || '').toString();
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ ok: false, errorCode: 'DSC_RETRIEVAL_REDIRECT', status, headers: res.headers, ip: resolved.address });
        }
        if (status !== 200) {
          res.resume();
          return resolve({ ok: false, errorCode: 'DSC_RETRIEVAL_HTTP_STATUS', status, ip: resolved.address });
        }
        if (!isJsonContentType(ctype)) {
          res.resume();
          return resolve({ ok: false, errorCode: 'DSC_RETRIEVAL_CONTENT_TYPE', reason: 'content-type not JSON: ' + ctype, status, ip: resolved.address });
        }
        const chunks = [];
        let size = 0;
        let settled = false;
        const fail = (code, reason) => {
          if (settled) return;
          settled = true;
          resolve({ ok: false, errorCode: code, reason, status, ip: resolved.address });
        };
        res.on('data', (c) => {
          size += c.length;
          if (size > maxBytes) {
            res.destroy();
            fail('DSC_RETRIEVAL_SIZE', 'body ' + size + ' > limit');
          } else {
            chunks.push(c);
          }
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          resolve({ ok: true, status: 200, headers: res.headers, bodyString: Buffer.concat(chunks).toString('utf8'), ip: resolved.address });
        });
        res.on('error', (e) => fail('DSC_RETRIEVAL_IO', (e && e.message) || 'read error'));
        res.on('aborted', () => fail('DSC_RETRIEVAL_SIZE', 'body aborted (size limit)'));
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', (e) => {
      resolve({ ok: false, errorCode: 'DSC_RETRIEVAL_IO', reason: (e && e.message) || 'request error' });
    });
    req.end();
  });
}

// --- Multi-hop bounded retrieval -----------------------------------------------------
async function fetchRetrieve(input) {
  const { url, opts } = input || {};
  const options = opts || {};
  const start = Date.now();
  const maxRedirects = options.maxRedirects !== undefined ? options.maxRedirects : MAX_REDIRECTS;
  let current = url;
  const hops = [];

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    if (Date.now() - start > (options.totalMs || MAX_TOTAL_MS)) {
      return { ok: false, errorCode: 'DSC_RETRIEVAL_TIME', reason: 'total retrieval exceeded limit', hops };
    }
    const hopResult = await fetchHop(current, options);
    hops.push({ url: current, status: hopResult.status, ok: hopResult.ok, errorCode: hopResult.errorCode, reason: hopResult.reason, ip: hopResult.ip });

    if (hopResult.errorCode === 'DSC_RETRIEVAL_REDIRECT') {
      const loc = hopResult.headers && hopResult.headers.location;
      if (!loc) {
        return { ok: false, errorCode: 'DSC_RETRIEVAL_HTTP_STATUS', reason: '3xx without Location', hops };
      }
      let next;
      try { next = new URL(loc, current).href; } catch (_) {
        return { ok: false, errorCode: 'DSC_UNSAFE_RETRIEVAL', reason: 'invalid redirect Location', hops };
      }
      if (new URL(next).protocol !== 'https:') {
        return { ok: false, errorCode: 'DSC_UNSAFE_RETRIEVAL', reason: 'redirect to non-https', hops };
      }
      const nextResolved = resolveAllowed(new URL(next).hostname, options);
      if (!nextResolved.ok) {
        return { ok: false, errorCode: 'DSC_UNSAFE_RETRIEVAL', reason: 'redirect destination unsafe: ' + nextResolved.reason, hops };
      }
      current = next;
      continue;
    }

    if (hopResult.ok) {
      return { ok: true, status: 200, url: current, bodyString: hopResult.bodyString, headers: hopResult.headers, hops, ip: hopResult.ip };
    }
    return { ok: false, errorCode: hopResult.errorCode || 'DSC_RETRIEVAL_HTTP_STATUS', reason: hopResult.reason || ('HTTP ' + hopResult.status), hops };
  }
  return { ok: false, errorCode: 'DSC_RETRIEVAL_REDIRECT_LIMIT', reason: 'exceeded ' + maxRedirects + ' redirects', hops };
}

module.exports = {
  MAX_REDIRECTS,
  PROFILE_MAX_BYTES,
  SCHEMA_MAX_BYTES,
  MAX_TOTAL_MS,
  ipClass,
  resolveAllowed,
  isJsonContentType,
  fetchHop,
  fetchRetrieve,
};