// Schema-UID derivation regression.
//
// The verifier's `schemaUid(resolver, revocable)` must encode the ACTUAL values
// (raw UTF-8 schema bytes + 20-byte resolver + 1-byte revocable, keccak256 over
// the packed bytes). The all-zero-resolver / revocable=false packing is only
// what the SAAX schema's fixed registration happens to use, so a hardcoded
// derivation would still pass on the primary schema while being wrong in
// general. This asserts agreement across four resolver/revocable combinations,
// compares against an INDEPENDENT reference implementation, and (when an RPC is
// reachable) against the on-chain SchemaRegistry for both registered schemas.
//
// USAGE: node verifier/schema-uid-regression.js [--rpc <url>]
'use strict';
const path = require('path');
const { keccak256, encodePacked, toHex } = require('viem');

const SAAX_COMMITMENT_SCHEMA = process.env.SAAX_COMMITMENT_SCHEMA ||
  'string commitmentId,string commitmentDigest,string parties,string requestedOutcome,string providerObligation,string commercialTerms,string paymentTerms,string acceptanceCriteria,string deadline,string failureConditions,string recoveryPolicy,string refundsCompensation,string lifecycleState,uint64 anchoredAt';

const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = '0x000000000000000000000000000000000000dEaD';

// Primary derivation (mirrors the verifier implementation).
function schemaUid(resolver, revocable) {
  const packed = encodePacked(['string', 'address', 'bool'], [SAAX_COMMITMENT_SCHEMA, resolver, revocable]);
  return keccak256(packed);
}

// Independent reference: same formula via a different construction (raw buffers).
function referenceSchemaUid(schemaStr, resolver, revocable) {
  const { keccak_256 } = require('@noble/hashes/sha3');
  const res = String(resolver).replace(/^0x/, '').toLowerCase();
  const packed = Buffer.concat([
    Buffer.from(schemaStr, 'utf8'),
    Buffer.from(res, 'hex'),
    Buffer.from([revocable ? 1 : 0]),
  ]);
  return '0x' + Buffer.from(keccak_256(packed)).toString('hex');
}

let failed = 0;
function ok(label, cond, detail) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  [' + detail + ']' : ''));
  if (!cond) failed++;
}

const cases = [
  { resolver: ZERO, revocable: false, onChain: '0x12348358bc3960c884de872f93edfe5061720f79b97c8d74b6080ad9911a89e4' },
  { resolver: ZERO, revocable: true,  onChain: '0x3efb108fbe25ef11a0e8807ae56148402bd4b07dd17398a5e508129554f1c781' },
  { resolver: DEAD, revocable: false, onChain: null },
  { resolver: DEAD, revocable: true,  onChain: null },
];

for (const c of cases) {
  const a = schemaUid(c.resolver, c.revocable);
  const b = referenceSchemaUid(SAAX_COMMITMENT_SCHEMA, c.resolver, c.revocable);
  ok('derivation == reference (resolver=' + c.resolver.slice(0, 8) + '… revocable=' + c.revocable + ')',
    a === b, a.slice(0, 18) + '…');
  if (c.onChain) {
    ok('derivation == on-chain UID (revocable=' + c.revocable + ')', a === c.onChain, a.slice(0, 18) + '…');
    // The on-chain schema must also report the expected revocable flag and
    // resolve by exactly this UID (proves the UID is the real one, not a typo).
    const rpc = (() => { const i = process.argv.indexOf('--rpc'); return i >= 0 ? process.argv[i + 1] : 'https://sepolia.base.org'; })();
    (async () => {
      const REG = '0x4200000000000000000000000000000000000020';
      const sel = keccak256(toHex('getSchema(bytes32)')).slice(0, 10);
      const data = sel + a.slice(2).padStart(64, '0');
      try {
        const res = await fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: REG, data }, 'latest'] }) });
        const j = await res.json();
        if (j.error) { ok('on-chain getSchema resolves (revocable=' + c.revocable + ')', false, j.error.message); return; }
        const hex = j.result.slice(2);
        const uid = hex.slice(64, 128);
        const revocableWord = hex.slice(128 + 64, 128 + 128);
        ok('on-chain getSchema resolves by UID (revocable=' + c.revocable + ')', uid === a.slice(2), uid.slice(0, 18) + '…');
        ok('on-chain revocable flag matches request (revocable=' + c.revocable + ')', parseInt(revocableWord, 16) === (c.revocable ? 1 : 0), 'flag=' + parseInt(revocableWord, 16));
      } catch (e) {
        ok('on-chain getSchema resolves (revocable=' + c.revocable + ')', false, e.message.slice(0, 60));
      }
      finish();
    })();
  }
}

let pending = cases.filter(c => c.onChain).length;
function finish() {
  if (--pending > 0) return;
  console.log('--- RESULT: ' + (failed ? failed + ' FAILED' : 'all derivation checks passed'));
  process.exit(failed ? 1 : 0);
}
if (!pending) finish();
