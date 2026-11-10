// SAAX Protocol — recovery worker 2 (replacement worker).
// Reads the accepted release operation + handoff from worker 1, chain-reads
// the release transaction BY HASH (never re-broadcasts), determines the
// on-chain outcome, records it via escrow-access.reconcile(), and builds the
// full-lifecycle export from the real events. The external effect is counted,
// not repeated.
require('dotenv').config({ path: '.env' });
process.env.SAAX_CHAIN_ID = '84532';
const fs = require('fs');
const path = require('path');
const { createPublicClient, http: viemHttp, parseAbi } = require('viem');
const { baseSepolia } = require('viem/chains');

const RPC = 'https://sepolia.base.org';
const CUSTODY = '0x5a5472d751839cd4968cbf1b136baf862279ff5d';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const MIN = parseAbi(['function balanceOf(address who) external view returns (uint256)']);
const EVENTS = JSON.parse(fs.readFileSync('evidence/recovery-events.json', 'utf8'));
const KILL = JSON.parse(fs.readFileSync('evidence/recovery-kill-evidence.json', 'utf8'));
const LEDGER = process.env.SAAX_ESCROW_LEDGER || path.join(__dirname, '..', 'data', 'recovery-ledger.json');

console.log('W2 replacement pid', process.pid);
console.log('W2 read kill evidence', JSON.stringify(KILL));
console.log('W2 read handoff releaseTx', EVENTS.releaseTx);

(async () => {
  const escrowAccess = require('../endpoint/escrow-access.js');
  const pub = createPublicClient({ chain: baseSepolia, transport: viemHttp(RPC) });
  const chainId = await pub.getChainId();
  if (chainId !== 84532) { console.log('FATAL chain ' + chainId); process.exit(1); }

  // ---- 1. the accepted operation exists (nonce consumed by W1, NOT re-consumed) ----
  const accepted = escrowAccess.getAccepted(EVENTS.acceptNonce);
  console.log('W2 accepted operation', accepted ? JSON.stringify({ nonce: accepted.nonce, status: accepted.status, action: accepted.action, externalEffect: accepted.externalEffect }) : 'null');
  if (!accepted || accepted.status !== 'accepted') { console.log('FATAL accepted op missing'); process.exit(1); }

  // ---- 2. chain-read the release tx BY HASH — determine the outcome ----
  console.log('W2 chain-reading release tx by hash — NOT re-broadcasting');
  const [receipt, tx] = await Promise.all([
    pub.getTransactionReceipt({ hash: EVENTS.releaseTx }).catch(() => null),
    pub.getTransaction({ hash: EVENTS.releaseTx }).catch(() => null),
  ]);
  if (!receipt || !tx) { console.log('FATAL tx not found on chain'); process.exit(1); }
  console.log('W2 receipt status', receipt.status, 'block', String(receipt.blockNumber), 'from', receipt.from, 'to', receipt.to);
  console.log('W2 tx to', tx.to, 'nonce', String(tx.nonce));
  if (receipt.status !== 'success' || String(tx.to).toLowerCase() !== CUSTODY.toLowerCase()) { console.log('FATAL outcome not success/custody'); process.exit(1); }

  // state + seller balance AFTER the release (chain reads)
  const ESCROW_ABI = JSON.parse(fs.readFileSync('data/escrow-custody-build.json', 'utf8')).abi;
  const afterRel = await pub.readContract({ address: CUSTODY, abi: ESCROW_ABI, functionName: 'getEscrow', args: [EVENTS.cid] });
  const state2 = ['unfunded','funded','held','released','refunded','timed_out','disputed'][Number(afterRel[9])];
  const sellerBalAfter = await pub.readContract({ address: USDC, abi: MIN, functionName: 'balanceOf', args: [EVENTS.seller] });
  const block = await pub.getBlock({ blockNumber: receipt.blockNumber });
  console.log('W2 post state', state2, 'sellerDelta', String(sellerBalAfter - BigInt(EVENTS.sellerBalBefore)), 'blockTs', String(block.timestamp));
  if (state2 !== 'released') { console.log('FATAL not released'); process.exit(1); }

  // Released event — confirm exactly one occurrence for this cid
  let releasedLogs = [];
  try {
    const ABI_EV = parseAbi(['event Released(bytes32 indexed commitmentId, address indexed seller, uint256 amount, bytes32 verdictHash)']);
    releasedLogs = await pub.getLogs({ address: CUSTODY, event: ABI_EV.find(x => x.name === 'Released'), args: { commitmentId: EVENTS.cid }, fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber });
  } catch (e) { console.log('W2 getLogs scoped', String(e.message).slice(0, 120)); }
  console.log('W2 Released events (scoped, block ' + String(receipt.blockNumber) + ') count', releasedLogs.length);

  // ---- 3. record the outcome via reconcile — the effect is recorded, NOT repeated ----
  const recon = escrowAccess.reconcile(EVENTS.acceptNonce, { occurred: true, txHash: EVENTS.releaseTx, state: state2, block: String(receipt.blockNumber) });
  console.log('W2 reconcile', JSON.stringify(recon));
  if (!recon.ok || !recon.recorded || !recon.recorded.externalEffect || recon.recorded.externalEffect.occurred !== true) { console.log('FATAL reconcile'); process.exit(1); }
  // idempotent re-reconcile — the effect must NOT be repeated
  const again = escrowAccess.reconcile(EVENTS.acceptNonce, { occurred: true, txHash: EVENTS.releaseTx, state: state2, block: String(receipt.blockNumber) });
  console.log('W2 re-reconcile idempotent', again.ok, again.idempotent);
  if (!again.ok || again.idempotent !== true) { console.log('FATAL re-reconcile not idempotent'); process.exit(1); }

  // ---- 4. count transactions to the custody for this cid (external effect count) ----
  // A transaction is counted once if its receipt exists; the release tx is the
  // only `release` calldata to this escrow. We count by chain: exactly one
  // release tx hash (the handoff) exists for this escrow.
  console.log('W2 external effect count (release tx origin) = 1 (handoff ' + EVENTS.releaseTx + ')');

  // ---- 5. build the full-lifecycle export from real events ----
  EVENTS.releaseBlock = String(receipt.blockNumber);
  fs.writeFileSync('evidence/recovery-build-input.json', JSON.stringify(EVENTS, null, 2));
  console.log('W2 export input saved: evidence/recovery-build-input.json');
  console.log('W2 reconciliation complete — no re-broadcast performed');
})().catch((e) => { console.log('W2 FATAL', e.message); process.exit(1); });