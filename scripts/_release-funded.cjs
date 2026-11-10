// SAAX Protocol — real release of the EXISTING funded escrow on Base Sepolia
// via the deployed custody contract's EIP-712 verdict scheme. The evaluator
// (SAAX_SIGNER_PRIVATE_KEY, 0x59B41A... the escrow's on-chain evaluator)
// signs EscrowVerdict(commitmentId, commitmentDigest, action=release, nonce,
// issuedAt) under domain { name:'SAAX Escrow Custody V1', version:'1',
// chainId:84532, verifyingContract: custody }. Broadcast + receipt verify +
// terminal state + seller balance delta. No re-funding.
const dotenv = require('dotenv');
dotenv.config({ path: '.env' });
process.env.SAAX_CHAIN_ID = '84532';
const { createWalletClient, createPublicClient, http: viemHttp, keccak256, encodeAbiParameters, parseAbiParameters, toHex, parseAbi } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { baseSepolia } = require('viem/chains');

const RPC = 'https://sepolia.base.org';
const CUSTODY = '0x5a5472d751839cd4968cbf1b136baf862279ff5d';
const CID = '0xf8944632c46b2c77c18e03e4191cd7333b8a984ad76a92d7524ef084d4e7e5f3';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const BUYER = '0xFec898A99e35d2E3a06bCfb54c4A8886DA19cA13';
const SELLER = '0x983040F7D8Cd31807C0D5c00c0aD591B8Fc98271';
const EVALUATOR_ADDR = '0x59B41Af94Ea81b0C4e920C3aF2EB6377Dd547A70';
const ESCROW_ABI = JSON.parse(require('fs').readFileSync('data/escrow-custody-build.json', 'utf8')).abi;
const MIN = parseAbi(['function balanceOf(address who) external view returns (uint256)']);

const DOMAIN = { name: 'SAAX Escrow Custody V1', version: '1', chainId: BigInt(84532), verifyingContract: CUSTODY };
const TYPES = { EscrowVerdict: [
  { name: 'commitmentId', type: 'bytes32' }, { name: 'commitmentDigest', type: 'bytes32' },
  { name: 'action', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'issuedAt', type: 'uint256' },
] };

(async () => {
  const pub = createPublicClient({ chain: baseSepolia, transport: viemHttp(RPC) });
  const chainId = await pub.getChainId();
  console.log('chainId', chainId);
  if (chainId !== 84532) { console.log('FATAL: not Base Sepolia'); process.exit(1); }

  // Pre-state
  const escrow = await pub.readContract({ address: CUSTODY, abi: ESCROW_ABI, functionName: 'getEscrow', args: [CID] });
  const state = ['unfunded','funded','held','released','refunded','timed_out','disputed'][Number(escrow[9])];
  const sellerBalBefore = await pub.readContract({ address: USDC, abi: MIN, functionName: 'balanceOf', args: [SELLER] });
  const custodyBalBefore = await pub.readContract({ address: USDC, abi: MIN, functionName: 'balanceOf', args: [CUSTODY] });
  console.log('pre-state:', state, 'amount', escrow[6].toString(), 'evaluator', escrow[5], 'sellerBal', String(sellerBalBefore), 'custodyBal', String(custodyBalBefore));
  if (state !== 'funded') { console.log('FATAL: escrow not funded (' + state + ')'); process.exit(1); }
  if (String(escrow[5]).toLowerCase() !== EVALUATOR_ADDR.toLowerCase()) { console.log('FATAL: on-chain evaluator != signer evaluator'); process.exit(1); }

  // Fresh nonce: find an unused verdict nonce
  let nonce = BigInt(Math.floor(Date.now() / 1000));
  let used = await pub.readContract({ address: CUSTODY, abi: ESCROW_ABI, functionName: 'usedVerdictNonce', args: [nonce] });
  while (used) { nonce += 1n; used = await pub.readContract({ address: CUSTODY, abi: ESCROW_ABI, functionName: 'usedVerdictNonce', args: [nonce] }); }
  const issuedAt = BigInt(Math.floor(Date.now() / 1000));
  console.log('verdict nonce', String(nonce), 'issuedAt', String(issuedAt));

  // Sign the contract-scheme verdict with the evaluator (signer) key
  const key = process.env.SAAX_SIGNER_PRIVATE_KEY;
  const account = privateKeyToAccount(key);
  if (account.address.toLowerCase() !== EVALUATOR_ADDR.toLowerCase()) { console.log('FATAL: signer key addr mismatch', account.address); process.exit(1); }
  const ws = createWalletClient({ account, chain: baseSepolia, transport: viemHttp(RPC) });
  const sig = await ws.signTypedData({
    domain: DOMAIN, types: TYPES, primaryType: 'EscrowVerdict',
    message: { commitmentId: CID, commitmentDigest: CID, action: 'release', nonce, issuedAt },
  });
  console.log('verdict signature', sig.slice(0, 20) + '...');
  const v = parseInt(sig.slice(130, 132), 16);
  const r = '0x' + sig.slice(2, 66);
  const s = '0x' + sig.slice(66, 130);

  // Broadcast release
  const relCall = keccak256(toHex('release(bytes32,bytes32,uint256,uint256,uint8,bytes32,bytes32)')).slice(0, 10)
    + encodeAbiParameters(parseAbiParameters('bytes32,bytes32,uint256,uint256,uint8,bytes32,bytes32'), [CID, CID, nonce, issuedAt, v, r, s]).slice(2);
  const signerNonce = await pub.getTransactionCount({ address: account.address });
  const txHash = await ws.sendTransaction({ to: CUSTODY, data: relCall, account, nonce: BigInt(signerNonce), gas: 1000000n, maxFeePerGas: 3000000000n, maxPriorityFeePerGas: 1000000000n });
  console.log('release tx', txHash);

  // Receipt verify
  let receipt = null;
  for (let i = 0; i < 30; i++) {
    await new Promise(r2 => setTimeout(r2, 3000));
    receipt = await pub.getTransactionReceipt({ hash: txHash }).catch(() => null);
    if (receipt && receipt.status === 'success') break;
    if (receipt && receipt.status === 'reverted') { console.log('REVERTED'); break; }
  }
  if (!receipt || receipt.status !== 'success') {
    console.log('FATAL: release not confirmed success', receipt && receipt.status);
    process.exit(1);
  }
  console.log('receipt status', receipt.status, 'block', String(receipt.blockNumber), 'gasUsed', String(receipt.gasUsed), 'logs', receipt.logs.length);
  for (const l of receipt.logs) {
    try {
      const parsed = { address: l.address };
      if (String(l.address).toLowerCase() === CUSTODY.toLowerCase()) parsed.escrowEvent = 'custody log ' + l.topics[0].slice(0, 18);
      if (String(l.address).toLowerCase() === USDC.toLowerCase()) parsed.usdcEvent = 'transfer log ' + l.topics[0].slice(0, 18);
      console.log('  log', JSON.stringify(parsed));
    } catch (e) {}
  }

  // Post-state
  const escrow2 = await pub.readContract({ address: CUSTODY, abi: ESCROW_ABI, functionName: 'getEscrow', args: [CID] });
  const state2 = ['unfunded','funded','held','released','refunded','timed_out','disputed'][Number(escrow2[9])];
  const sellerBalAfter = await pub.readContract({ address: USDC, abi: MIN, functionName: 'balanceOf', args: [SELLER] });
  const custodyBalAfter = await pub.readContract({ address: USDC, abi: MIN, functionName: 'balanceOf', args: [CUSTODY] });
  const block = await pub.getBlock({ blockNumber: receipt.blockNumber });
  console.log('post-state:', state2, 'sellerBalAfter', String(sellerBalAfter), 'delta', String(sellerBalAfter - sellerBalBefore), 'custodyBalAfter', String(custodyBalAfter), 'blockTs', String(block.timestamp));
  console.log('RESULT RELEASE_OK state=' + state2 + ' tx=' + txHash + ' block=' + String(receipt.blockNumber) + ' sellerDelta=' + String(sellerBalAfter - sellerBalBefore));
  // Save evidence
  const evidence = {
    txHash, block: String(receipt.blockNumber), blockTs: String(block.timestamp),
    custody: CUSTODY, cid: CID, evaluator: EVALUATOR_ADDR, nonce: String(nonce), issuedAt: String(issuedAt),
    preState: state, postState: state2, sellerBalBefore: String(sellerBalBefore), sellerBalAfter: String(sellerBalAfter),
    sellerDelta: String(sellerBalAfter - sellerBalBefore), custodyBalBefore: String(custodyBalBefore), custodyBalAfter: String(custodyBalAfter),
    verdictSignature: sig, v, r, s, receiptStatus: receipt.status, gasUsed: String(receipt.gasUsed),
  };
  require('fs').writeFileSync('evidence/integrated-release-evidence.json', JSON.stringify(evidence, null, 2));
  console.log('evidence saved: evidence/integrated-release-evidence.json');
})().catch((e) => { console.log('FATAL', e.message); process.exit(1); });