// SAAX Protocol — Day 8: Storage adapter (Supabase REST + in-memory fallback)
//
// The idempotency and rate-limit modules accept an injected store client with
// the shape:
//   { from(table).select(...).eq(...).gte(...).lt(...).maybeSingle().limit(n),
//     from(table).insert(row), from(table).update(patch).eq(...),
//     from(table).delete().in(col, values), rpc(fn, params) }
//
// This module builds that client against Supabase's PostgREST endpoint with the
// project URL + service-role key. If the URL/key are not configured (operator
// setup item), it returns null and the caller falls back to its in-memory
// store — the brief's sanctioned route-around: "or in-memory with periodic
// flush". NO external spend; the Supabase project queries are read/write on
// the operator's own tables (already verified RLS: server-internal = service
// role only).
//
// DAY 8 CLOSURE — schema-scoped PostgREST access (Item 1 RPC fix):
//   The ax_router tables AND the acquire_idempotency RPC live in the ax_router
//   schema. PostgREST resolves RPC names and tables through the schema declared
//   in the request profile (Accept-Profile/Content-Profile) — NOT by baking the
//   schema into the function/table name. The client therefore carries
//   `db: { schema: 'saax_router' }` (implemented as the profile headers below) and
//   callers use the BARE function name: rpc('acquire_idempotency', ...).
//   The previous 'saax_router_acquire_idempotency' name 404'd in Supabase mode
//   (no such function in the search path) — a live break, now fixed.
const crypto = require('crypto');

// Day 8 migration: the store layer moved from the Supabase platform to a
// self-hosted Docker stack (Postgres + PostgREST, PGRST_DB_SCHEMA=ax_router).
// Preference order: POSTGREST_URL + SAAX_POSTGREST_KEY (Docker) > SUPABASE_URL +
// service key (platform, kept for rollback). Both speak PostgREST, so the
// client is identical — only the endpoint/credential resolution changed.
const POSTGREST_URL = process.env.POSTGREST_URL || process.env.SAAX_POSTGREST_URL || '';
const POSTGREST_KEY = process.env.SAAX_POSTGREST_KEY || process.env.POSTGREST_KEY || '';
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.SAAX_SUPABASE_URL || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SAAX_SUPABASE_KEY || '';

// Resolve which PostgREST endpoint to use: Docker self-hosted takes precedence
// when configured; otherwise the Supabase platform endpoint (rollback).
const STORE_BASE_URL = POSTGREST_URL || SUPABASE_URL;
const STORE_KEY = (POSTGREST_URL ? POSTGREST_KEY : '') || SERVICE_KEY;

// Schema for the ax_router tables + RPC (set in the client config).
// LIVE project exposes ax_router (verified); saax_router 406s (PGRST106).
const DEFAULT_SCHEMA = 'ax_router';

function isConfigured() {
  return !!(STORE_BASE_URL && STORE_KEY);
}

// Minimal PostgREST client (the subset the modules use). Each method returns
// { data, error } so call sites can branch on failure (fail-open).
function buildSupabaseClient(url, key, schemaName) {
  // Reliability remediation (Phase 6 finding): a trailing space in
  // SUPABASE_URL/POSTGREST_URL (e.g. from a copy-pasted Vercel secret) made
  // every URL this client builds invalid ("Failed to parse URL from
  // https://….supabase.co /rest/v1/rpc/...") — breaking acquire_idempotency,
  // reconcile_idempotency, and the hourly sweep. Trim surrounding whitespace
  // so the custom client is robust to the same env quirk supabase-js handles.
  const base = String(url).trim().replace(/\/+$/, '');
  const auth = { apikey: key, Authorization: 'Bearer ' + key };
  const schema = schemaName || DEFAULT_SCHEMA;
  // Every request is schema-scoped via PostgREST profile headers (equivalent to
  // the official client's db: { schema } init option).
  const scoped = { ...auth, 'Accept-Profile': schema, 'Content-Profile': schema };
  // Day 8 migration: the Supabase platform REST gateway prefixes endpoints with
  // /rest/v1 (https://<ref>.supabase.co/rest/v1/...). A SELF-HOSTED PostgREST
  // serves at the root (/rpc/..., /<table>). The prefix is therefore applied
  // ONLY for the Supabase platform URL; Docker PostgREST (POSTGREST_URL) gets
  // bare paths.
  const isPlatform = /supabase\.co/i.test(base);
  const PREFIX = isPlatform ? '/rest/v1' : '';

  function urlFor(table) {
    return base + PREFIX + '/' + table;
  }
  function qs(params) {
    const parts = [];
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null) continue;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    }
    return parts.length ? '?' + parts.join('&') : '';
  }

  function filtersFor(filters) {
    // filters: [{ col, op, val }] where op in {eq,neq,gt,gte,lt,lte,in,like}
    const parts = [];
    for (const f of filters) {
      const opMap = { eq: 'eq', neq: 'neq', gt: 'gt', gte: 'gte', lt: 'lt', lte: 'lte', in: 'in', like: 'like' };
      const op = opMap[f.op] || f.op;
      parts.push(f.col + '=' + op + '.' + f.val);
    }
    return parts;
  }

  function from(table) {
    const chain = {
      _filters: [],
      _limit: null,
      _single: false,
      _cols: '*',
      select(cols) { this._cols = cols; return this; },
      eq(col, v) { this._filters.push({ col, op: 'eq', val: v }); return this; },
      neq(col, v) { this._filters.push({ col, op: 'neq', val: v }); return this; },
      gt(col, v) { this._filters.push({ col, op: 'gt', val: v }); return this; },
      gte(col, v) { this._filters.push({ col, op: 'gte', val: v }); return this; },
      lt(col, v) { this._filters.push({ col, op: 'lt', val: v }); return this; },
      lte(col, v) { this._filters.push({ col, op: 'lte', val: v }); return this; },
      in(col, vals) { this._filters.push({ col, op: 'in', val: '(' + vals.map(v => encodeURIComponent(String(v))).join(',') + ')' }); return this; },
      maybeSingle() { this._single = true; return this; },
      limit(n) { this._limit = n; return this; },
      async _execSelect() {
        const params = { select: this._cols };
        const flt = filtersFor(this._filters);
        for (const f of flt) params[f.split('=')[0]] = f.split('=')[1];
        if (this._limit) params.limit = String(this._limit);
        if (this._single) params.limit = '1';
        const res = await fetch(urlFor(table) + qs(params), { headers: scoped });
        if (res.status >= 400) {
          return { data: null, error: new Error('GET /' + table + ' -> ' + res.status + ' ' + (await res.text()).slice(0, 200)) };
        }
        const body = await res.json();
        if (this._single) return { data: body && body[0] ? body[0] : null, error: null };
        return { data: body, error: null };
      },
      then(resolve, reject) { return this._execSelect().then(resolve, reject); },
      catch(reject) { return this._execSelect().catch(reject); },
      async insert(row) {
        const res = await fetch(urlFor(table), {
          method: 'POST',
          headers: { ...scoped, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify(row),
        });
        if (res.status >= 400) {
          return { data: null, error: new Error('POST /' + table + ' -> ' + res.status + ' ' + (await res.text()).slice(0, 200)) };
        }
        return { data: null, error: null };
      },
      update(patch) {
        // Chainable .update(patch).eq(col, val) — the modules (idempotency.js,
        // ratelimit.js) call .update(...).eq(...). Returns the fetch result.
        // Reliability remediation (fault-injection finding): the chained
        // .eq(col,val) filter MUST be included in the PATCH URL. The previous
        // implementation read `self._filters` (empty at update() call time) and
        // silently DROPPED the filter added by .eq(), so markVerified /
        // markSettled / markFailed sent `PATCH /idempotency_keys` with NO
        // filter — updating every row (or being ignored). Filter-chain state is
        // now collected on the returned chain object and merged at exec time.
        const self = this;
        const chain = {
          _filters: self._filters ? self._filters.slice() : [],
          _exec: async () => {
            const params = {};
            const all = filtersFor(self._filters).concat(filtersFor(chain._filters));
            for (const f of all) {
              const parts = f.split('=');
              params[parts[0]] = parts.slice(1).join('=');
            }
            const res = await fetch(urlFor(table) + qs(params), {
              method: 'PATCH',
              headers: { ...scoped, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
              body: JSON.stringify(patch),
            });
            if (res.status >= 400) {
              return { data: null, error: new Error('PATCH /' + table + ' -> ' + res.status + ' ' + (await res.text()).slice(0, 200)) };
            }
            return { data: null, error: null };
          },
          eq(col, v) { chain._filters = chain._filters.concat([{ col, op: 'eq', val: v }]); return chain; },
          then(resolve, reject) { return chain._exec().then(resolve, reject); },
          catch(reject) { return chain._exec().catch(reject); },
        };
        return chain;
      },
      delete() {
        // Chainable .delete().in(col, vals) — the sweep in idempotency.js /
        // ratelimit.js calls .delete().in(...). Same pattern as update.
        // Reliability remediation (usage-audit finding): the previous
        // implementation read `this._filters` inside the arrow `_exec`, where
        // `this` is the BUILDER chain (whose _filters stays []), so the
        // .in(...) filter appended to the RETURNED chain was never read and
        // every DELETE went out FILTERLESS (PostgREST 400 "DELETE requires a
        // WHERE clause" — the observed hourly sweep failures). The chain's
        // filters are now read via the named `chain` reference, matching the
        // update() fix.
        const self = this;
        const chain = {
          _filters: self._filters ? self._filters.slice() : [],
          _exec: async () => {
            const all = filtersFor(self._filters).concat(filtersFor(chain._filters));
            if (all.length === 0) {
              // SAFETY GUARD: a filterless DELETE would target the whole table.
              // PostgREST rejects it server-side (400 "DELETE requires a WHERE
              // clause"), but we must never even attempt a broad delete from
              // application code. Fail closed with an explicit error instead.
              return { data: null, error: new Error('DELETE /' + table + ' refused: no filter chained (would delete all rows)') };
            }
            const params = {};
            for (const f of all) params[f.split('=')[0]] = f.split('=')[1];
            const res = await fetch(urlFor(table) + qs(params), {
              method: 'DELETE',
              headers: { ...scoped, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
            });
            if (res.status >= 400) {
              return { data: null, error: new Error('DELETE /' + table + ' -> ' + res.status + ' ' + (await res.text()).slice(0, 200)) };
            }
            return { data: null, error: null };
          },
          in(col, vals) { chain._filters = chain._filters.concat([{ col, op: 'in', val: '(' + vals.map(v => encodeURIComponent(String(v))).join(',') + ')' }]); return chain; },
          eq(col, v) { chain._filters = chain._filters.concat([{ col, op: 'eq', val: v }]); return chain; },
          gte(col, v) { chain._filters = chain._filters.concat([{ col, op: 'gte', val: v }]); return chain; },
          then(resolve, reject) { return chain._exec().then(resolve, reject); },
          catch(reject) { return chain._exec().catch(reject); },
        };
        return chain;
      },
    };
    return chain;
  }

  async function rpc(fn, params) {
    const res = await fetch(base + PREFIX + '/rpc/' + fn, {
      method: 'POST',
      headers: { ...scoped, 'Content-Type': 'application/json' },
      body: JSON.stringify(params || {}),
    });
    if (res.status >= 400) {
      const txt = (await res.text()).slice(0, 300);
      return { data: null, error: new Error('RPC ' + fn + ' -> ' + res.status + ' ' + txt) };
    }
    const body = await res.json();
    return { data: body, error: null };
  }

  return { from, rpc, isConfigured: () => true, url: base, schema };
}

// Build the store client: Supabase when configured, else null (in-memory).
function buildStoreClient() {
  if (!isConfigured()) return null;
  return buildSupabaseClient(STORE_BASE_URL, STORE_KEY);
}

module.exports = { buildStoreClient, buildSupabaseClient, isConfigured, POSTGREST_URL, SUPABASE_URL, STORE_BASE_URL, SERVICE_KEY, DEFAULT_SCHEMA };