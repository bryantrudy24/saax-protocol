'use strict';
/**
 * SAAX Pilot Journal Phase A — endpoint journal hook (initiated / observed).
 *
 * LOCAL INTEGRATION ONLY (Phase A): journals are written ONLY when
 * SAAX_ESCROW_JOURNAL_DIR is set; without it behavior is byte-identical to
 * before (no journal IO, no new side effects).
 *
 * Integration points (wired in endpoint/escrow-access.js):
 *   - acceptOperation: after durable acceptance (nonce consumed), append an
 *     INTENT entry (transition 'intent', observed=false, resultingState
 *     'Accepted'). The access-auth recovered signer IS the authorizing party
 *     (by); the endpoint does not hold that party's private key, so the
 *     journal entry is attested by the operator journal key
 *     (SAAX_JOURNAL_SIGNER_KEY) with authorization evidence (the verified
 *     access auth). The endpoint's attestation is never presented as the
 *     actor's own authorization. An 'intent' entry records that an action was
 *     ACCEPTED — it is NOT a confirmed lifecycle transition and cannot
 *     satisfy 'funded'/'release'/'refund'/'dispute'.
 *   - reconcile: when the endpoint confirms an on-chain transition
 *     (externalEffect occurred), append a CONFIRMED entry (transition =
 *     the actual lifecycle transition, observed=true) with:
 *       - by        = the AUTHORIZING party per the contract path (for
 *                     evaluator transitions: the evaluator authority; for
 *                     fund/mutual/timeout: per the transition authority map),
 *                     derived from the ledger record's role identity and the
 *                     transition authority — NOT from tx.from alone.
 *       - submitter = tx.from (the account that submitted the transaction;
 *                     may be a relayer, distinct from the authorizing party).
 *       - recoveredSigner = the authorizing party from the on-chain action.
 *     If the sender cannot be recovered (no SAAX_JOURNAL_RPC), the entry is
 *     NOT fabricated; journalGap() reports the missing transition.
 *
 * Missing records are REPORTED, never fabricated: journalGap() compares what
 * the durable ledger implies (complete operations with occurred effects)
 * against what the journal actually contains.
 *
 * Retry precision: identical acceptance retries return the recorded result at
 * the ledger layer (escrow-access.js acceptOperation idempotent path) and do
 * NOT re-append a journal entry. Repeated observation of the same on-chain
 * event is rejected by the writer's stable eventId dedup (same transition +
 * role + by + action + state + txHash => same eventId => DUPLICATE_EVENT).
 * Persistence is atomic (tmp + rename) and restart-safe (restore validates
 * the whole chain and the eventId dedup set is rebuilt from content).
 */

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const writer = require('../mainnet/design/support/v4-journal-writer');

const DIR = (process.env.SAAX_ESCROW_JOURNAL_DIR || '').trim();
const RPC = (process.env.SAAX_JOURNAL_RPC || '').trim();

// Map a ledger action to its CONFIRMED lifecycle transition (if any).
// Accepted intent (transition 'intent') is recorded separately at accept time.
const ACTION_TO_TRANSITION = {
  fund: 'funded',
  release: 'release',
  refund: 'refund',
  mutualRefund: 'mutual-refund',
  mutualRelease: 'mutual-release',
  resolve: 'release',
  'initiate dispute': 'dispute',
  dispute: 'dispute',
};

// Derive the AUTHORIZING role for a ledger action (v4 transition authority).
function authorizingRoleFor(action) {
  const a = String(action || '').toLowerCase();
  if (a === 'fund') return 'buyer';
  if (a === 'release' || a === 'refund' || a === 'resolve') return 'evaluator';
  if (a === 'mutualRefund' || a === 'mutualRelease') return 'buyer+seller';
  if (a === 'dispute' || a === 'initiate dispute') return 'buyer|seller';
  return null;
}

function enabled() { return !!DIR; }
function journalPathFor(commitmentId) { return path.join(DIR, String(commitmentId).toLowerCase() + '.json'); }

function loadSaved(commitmentId) {
  const p = journalPathFor(commitmentId);
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  return null;
}

function save(commitmentId, snap) {
  const p = journalPathFor(commitmentId);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(snap, null, 2), 'utf8');
  fs.renameSync(tmp, p); // atomic on same volume
}

// operator attestation key (loaded lazily; never printed)
let _operatorWallet;
function operatorWallet() {
  const key = (process.env.SAAX_JOURNAL_SIGNER_KEY || '').trim();
  if (!key) return null;
  if (!_operatorWallet) _operatorWallet = new ethers.Wallet(key);
  return _operatorWallet;
}

async function recoverTxSender(txHash) {
  if (!RPC) return null;
  const provider = new ethers.JsonRpcProvider(RPC);
  try { const tx = await provider.getTransaction(txHash); return tx ? tx.from : null; }
  catch (_) { return null; }
}

/**
 * Append an entry to the durable journal for a commitment.
 * kind: 'intent' (accepted intent, NOT confirmed) | 'observed' (confirmed
 * on-chain transition).
 * For observed: by = the AUTHORIZING party (per the transition authority /
 * recovered from the on-chain action); submitter = tx.from (possibly a
 * relayer, kept distinct).
 */
async function append({ chainId, custodyAddress, commitmentId, manifestHash, transition, role, by, contractAction, resultingState, at, kind = 'intent', recoveredSigner, submitter, txHash, blockHash, authorization }) {
  if (!enabled()) return { ok: true, skipped: true };
  const wallet = operatorWallet();
  const saved = loadSaved(commitmentId) || { commitmentId, manifestHash, events: [], tailHash: '0x' + '00'.repeat(32) };
  const jw = writer.createJournalWriter({ chainId, custodyAddress, commitmentId, manifestHash });
  if (saved.events.length) jw.restore(saved); // validates chain + tail; refuses broken state
  try {
    if (kind === 'intent') {
      // Intent entry: accepted, NOT confirmed. by = the authorizing party
      // (access-auth recovered signer). resultingState MUST mark intent.
      const entry = await jw.append({
        transition: 'intent', role, by, contractAction, resultingState,
        at, observed: false,
        signerWallets: wallet ? [wallet] : [],
        ...(authorization ? { authorization } : {}),
        expectByEqualsSigner: false, // endpoint attests; by is the recovered/authorizing party
      });
      save(commitmentId, jw.snapshot());
      return { ok: true, entry, kind: 'intent' };
    }
    // Observed (confirmed): by = authorizing party; submitter = tx.from.
    if (!isAddress0(recoveredSigner)) throw new Error('observed entry requires the authorizing signer');
    const byAuthorizer = recoveredSigner;
    const entry = await jw.append({
      transition, role, by: byAuthorizer, contractAction, resultingState,
      at, observed: true,
      signerWallets: wallet ? [wallet] : [],
      recoveredSigner: byAuthorizer,
      ...(submitter ? { submitter } : {}),
      txHash, blockHash,
      ...(authorization ? { authorization } : {}),
      expectByEqualsSigner: false,
    });
    save(commitmentId, jw.snapshot());
    return { ok: true, entry, kind: 'observed' };
  } catch (e) {
    // surface; never leave a partial write (append validated before mutating)
    return { ok: false, error: e.message, code: e.code };
  }
}

function isAddress0(v) { return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v); }

/**
 * Observed-entry convenience: recovers the on-chain sender when RPC is set.
 * by = authorizing party (caller supplies, derived from the ledger role /
 * transition authority); submitter = recovered tx.from.
 */
async function appendObserved({ chainId, custodyAddress, commitmentId, manifestHash, transition, role, authorizer, contractAction, resultingState, at, txHash, blockHash }) {
  if (!enabled()) return { ok: true, skipped: true };
  const sender = await recoverTxSender(txHash);
  if (!sender) return { ok: false, missingEvidence: 'tx sender not recoverable (no SAAX_JOURNAL_RPC or tx not found); observed entry NOT fabricated' };
  return append({ chainId, custodyAddress, commitmentId, manifestHash, transition, role, by: authorizer, contractAction, resultingState, at, kind: 'observed', recoveredSigner: authorizer, submitter: sender, txHash, blockHash });
}

/**
 * Report journal gaps relative to the durable ledger for a commitment.
 * Returns { missing: [...] } naming transitions the ledger implies (complete
 * operations with occurred external effects) that the journal lacks.
 * Only CONFIRMED transitions count; intent entries are excluded (they are
 * accepted intent, not evidence of lifecycle progression).
 * Never fabricates entries.
 */
function journalGap(commitmentId, ledgerOperations) {
  if (!enabled()) return { missing: [] };
  const saved = loadSaved(commitmentId);
  if (!saved) return { missing: (ledgerOperations || []).map(op => op.action || 'unknown') };
  const present = new Set((saved.events || [])
    .filter(e => writer.CONFIRMED_TRANSITIONS.has(e.transition))
    .map(e => e.transition));
  const missing = (ledgerOperations || [])
    .filter(op => op && op.status === 'complete' && op.externalEffect && op.externalEffect.occurred)
    .map(op => ACTION_TO_TRANSITION[String(op.action || '').toLowerCase()] || op.action)
    .filter(a => a && !present.has(a));
  return { missing };
}

module.exports = { enabled, append, appendObserved, journalGap, journalPathFor, ACTION_TO_TRANSITION, authorizingRoleFor };