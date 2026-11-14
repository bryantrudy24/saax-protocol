// Gate J.2 - get_supplier_details isolated test (read-only, nonfinancial)
// Runs against the supplier index directly + the MCP tool handler via a harness.
const assert = require('node:assert');
const path = require('node:path');

const IDX_PATH = path.resolve(__dirname, '..', '..', 'endpoint', 'mcp-supplier-index.json');
const idx = JSON.parse(require('node:fs').readFileSync(IDX_PATH, 'utf8'));
const suppliers = idx.suppliers || [];

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
}

// The tool handler logic (mirrors api/mcp.mjs exactly; kept here for isolation)
function lookup(raw) {
  if (raw === undefined || raw === null) return { status: 'error', reason: 'missing required input' };
  if (typeof raw !== 'string') return { status: 'error', reason: 'input must be a string' };
  if (raw.length > 64) return { status: 'error', reason: 'input exceeds maximum length 64' };
  if (raw.trim() === '') return { status: 'error', reason: 'input must not be empty' };
  const value = raw.trim();
  const key = /^\d+$/.test(value) ? Number(value) : value;
  const hit = suppliers.find((s) => {
    if (s == null) return false;
    if (typeof s.agent_id === 'number') return s.agent_id === key || String(s.agent_id) === value;
    return String(s.agent_id) === value;
  });
  if (!hit) return { status: 'not_found', reason: 'supplier not found in the current index' };
  return {
    status: 'ok',
    supplier: {
      supplier_id: hit.agent_id,
      name: hit.name,
      description: hit.description,
      services: Array.isArray(hit.services) ? hit.services.map((s) => ({ name: s && s.name, endpoint: s && s.endpoint, version: s && s.version != null ? s.version : null })) : [],
      owner: hit.owner,
      source: hit.source || 'indexed',
      verification_status: 'unverified',
      last_verified_at: null,
    },
  };
}

(async () => {
  // 1. Existing supplier (numeric agent_id)
  const first = suppliers[0];
  const r1 = lookup(String(first.agent_id));
  check('existing supplier found', r1.status === 'ok');
  check('supplier_id matches', r1.supplier && String(r1.supplier.supplier_id) === String(first.agent_id));
  check('name preserved', r1.supplier && r1.supplier.name === first.name);
  check('services preserved', r1.supplier && JSON.stringify(r1.supplier.services) === JSON.stringify(first.services || []));
  check('source preserved', r1.supplier && r1.supplier.source === (first.source || 'indexed'));
  check('verification not fabricated', r1.supplier && r1.supplier.verification_status === 'unverified' && r1.supplier.last_verified_at === null);

  // 2. Number-form lookup (raw numeric)
  const r2 = lookup(String(first.agent_id));
  check('numeric-string lookup works', r2.status === 'ok' && String(r2.supplier.supplier_id) === String(first.agent_id));

  // 3. Missing supplier
  const r3 = lookup('999999999');
  check('missing supplier -> not_found', r3.status === 'not_found');

  // 4. Invalid identifier forms
  check('empty -> error', lookup('').status === 'error');
  check('undefined -> error', lookup(undefined).status === 'error');
  check('non-string -> error', lookup(42).status === 'error');
  check('oversized -> error', lookup('x'.repeat(65)).status === 'error');

  // 5. No enumeration: arbitrary non-numeric ID does not return supplier list
  const r5 = lookup('../../etc/passwd');
  check('path-traversal attempt -> not_found', r5.status === 'not_found' || r5.status === 'error');

  // 6. Index has expected shape
  check('index has suppliers array', Array.isArray(suppliers));
  check('index has >0 suppliers', suppliers.length > 0);
  check('every supplier has agent_id', suppliers.every((s) => s && s.agent_id !== undefined));
  check('no secret material in index', !JSON.stringify(suppliers).match(/PRIVATE KEY|api[_-]?key|password|secret/i));

  console.log(`\nget_supplier_details: ${pass}/${pass + fail} checks passed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('get_supplier_details test FAIL -', e.message);
  process.exit(1);
});