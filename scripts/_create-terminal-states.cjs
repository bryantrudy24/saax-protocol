// SAAX Protocol — create refunded + disputed terminal escrows for the
// terminal-state access tests (Item 2). Modeled on _release-funded.cjs:
// fund fresh escrows (buyer), refund one via evaluator refund verdict,
// dispute the other via buyer raiseDispute. Chain-guarded to 84532.
const dotenv = require('dotenv');
dotenv.config({ path: '.env' });
process.env.SAAX_CHAIN_ID = '84532';
const { createWalletClient, createPublicClient, http: viemHttp, keccak256, toHex, encodeAbiParameters, parseAbiParameters, parseAbi } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { baseSepolia } = require('viem/chains');

const RPC = 'https://sepolia.base.org';
const CUSTODY = '0x5a5472d751839cd4968cbf1b136baf862279ff5d';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const BUYER = '0xFec898A99e35d2E3a06bCfb54c4A8886DA19cA13';
const SELLER = '0x983040F7D8Cd31807C0D5c00c0aD591B8Fc98271';
const EVALUATOR_ADDR = '0x59B41Af94Ea81b0C4e920C3aF2EB6377Dd547A70';
const AMOUNT = 50000n;
const ESCROW_ABI = JSON.parse(require('fs').readFileSync('data/escrow-custody-build.json', 'utf8')).abi;

const DOMAIN = { name: 'SAAX Escrow Custody V1', version: '1', chainId: BigInt(84532), verifyingContract: CUSTODY };
const TYPES = { EscrowVerdict: [
  { name: 'commitmentId', type: 'bytes32' }, { name: 'commitmentDigest', type: 'bytes32' },
  { name: 'action', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'issuedAt', type: 'uint256' },
] };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freshVerdictNonce(pub) {
  let nonce = BigInt(Math.floor(Date.now() / 1000));
  let used = await pub.readContract({ address: CUSTODY, abi: ESCROW_ABI, functionName: 'usedVerdictNonce', args: [nonce] });
  while (used) { nonce += 1n; used = await pub.readContract({ address: CUSTODY, abi: ESCROW_ABI, functionName: 'usedVerdictNonce', args: [nonce] }); }
  return nonce;
}

async function waitReceipt(pub, txHash, label) {
  let receipt = null;
  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    receipt = await pub.getTransactionReceipt({ hash: txHash }).catch(() => null);
    if (receipt && (receipt.status === 'success' || receipt.status === 'reverted')) break;
  }
  if (!receipt) { console.log('FATAL: no receipt for ' + label + ' ' + txHash); process.exit(1); }
  if (receipt.status !== 'success') { console.log('FATAL: ' + label + ' REVERTED ' + txHash); process.exit(1); }
  console.log(label, 'OK tx=' + txHash + ' block=' + String(receipt.blockNumber) + ' gas=' + String(receipt.gasUsed) + ' logs=' + receipt.logs.length);
  return receipt;
}

(async () => {
  const pub = createPublicClient({ chain: baseSepolia, transport: viemHttp(RPC) });
  const chainId = await pub.getChainId();
  console.log('chainId', chainId);
  if (chainId !== 84532) { console.log('FATAL: not Base Sepolia'); process.exit(1); }

  const signerKey = process.env.SAAX_SIGNER_PRIVATE_KEY;
  const buyerKey = process.env.SAAX_TEST_BUYER_KEY;
  if (!signerKey || !buyerKey) { console.log('FATAL: missing signer/buyer key in .env'); process.exit(1); }
  const signerAcct = privateKeyToAccount(signerKey);
  const buyerAcct = privateKeyToAccount(buyerKey);
  console.log('signer', signerAcct.address, 'buyer', buyerAcct.address);
  if (signerAcct.address.toLowerCase() !== EVALUATOR_ADDR.toLowerCase()) { console.log('FATAL: signer addr mismatch'); process.exit(1); }
  if (buyerAcct.address.toLowerCase() !== BUYER.toLowerCase()) { console.log('FATAL: buyer addr mismatch'); process.exit(1); }
  const wsSigner = createWalletClient({ account: signerAcct, chain: baseSepolia, transport: viemHttp(RPC) });
  const wsBuyer = createWalletClient({ account: buyerAcct, chain: baseSepolia, transport: viemHttp(RPC) });

  // Buyer must approve custody to pull USDC (allowance was 0 on-chain; the
  // prior funded escrows predate an allowance reset or used a prior approval).
  const approveCall = '0x' + keccak256(toHex('approve(address,uint256)')).slice(2, 10)
    + encodeAbiParameters(parseAbiParameters('address,uint256'), [CUSTODY, 2n ** 256n - 1n]).slice(2);
  let bNonce0 = await pub.getTransactionCount({ address: buyerAcct.address });
  const approveTx = await wsBuyer.sendTransaction({ to: USDC, data: approveCall, account: buyerAcct, nonce: BigInt(bNonce0), gas: 1000000n, maxFeePerGas: 3000000000n, maxPriorityFeePerGas: 1000000000n });
  console.log('approve tx', approveTx);
  await waitReceipt(pub, approveTx, 'approve');

  // Two fresh CIDs (keccak of unique strings — distinct digests)
  const cidRefund = keccak256(toHex('saax-terminal-refund-' + Date.now()));
  const cidDispute = keccak256(toHex('saax-terminal-dispute-' + Date.now() + '-2'));
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  const fundCall = (cid) => '0x' + keccak256(toHex('fund(bytes32,bytes32,address,address,address,address,uint256,uint256,uint64)')).slice(2, 10)
    + encodeAbiParameters(
        parseAbiParameters('bytes32,bytes32,address,address,address,address,uint256,uint256,uint64'),
        [cid, cid, USDC, BUYER, SELLER, EVALUATOR_ADDR, AMOUNT, deadline, 0n]
      ).slice(2);

  // --- Refund escrow: fund (buyer), refund via evaluator verdict ---
  console.log('\n=== REFUND ESCROW ===');
  console.log('cid', cidRefund);
  let bNonce = await pub.getTransactionCount({ address: buyerAcct.address });
  let tx = await wsBuyer.sendTransaction({ to: CUSTODY, data: fundCall(cidRefund), account: buyerAcct, nonce: BigInt(bNonce), gas: 1000000n, maxFeePerGas: 3000000000n, maxPriorityFeePerGas: 1000000000n });
  console.log('fund tx', tx);
  const fundTxRefund = tx;
  await waitReceipt(pub, tx, 'fund-refund');
  const escrowAfterFund = await pub.readContract({ address: CUSTODY, abi: ESCROW_ABI, functionName: 'getEscrow', args: [cidRefund] });
  console.log('post-fund state', ['unfunded','funded','held','released','refunded','timed_out','disputed'][Number(escrowAfterFund[9])]);

  const refundNonce = await freshVerdictNonce(pub);
  const issuedAt = BigInt(Math.floor(Date.now() / 1000));
  const sig = await wsSigner.signTypedData({
    domain: DOMAIN, types: TYPES, primaryType: 'EscrowVerdict',
    message: { commitmentId: cidRefund, commitmentDigest: cidRefund, action: 'refund', nonce: refundNonce, issuedAt },
  });
  const v = parseInt(sig.slice(130, 132), 16);
  const r = '0x' + sig.slice(2, 66);
  const s = '0x' + sig.slice(66, 130);
  const refundCall = '0x' + keccak256(toHex('refund(bytes32,bytes32,uint256,uint256,uint8,bytes32,bytes32)')).slice(2, 10)
    + encodeAbiParameters(parseAbiParameters('bytes32,bytes32,uint256,uint256,uint8,bytes32,bytes32'), [cidRefund, cidRefund, refundNonce, issuedAt, v, r, s]).slice(2);
  const sNonce = await pub.getTransactionCount({ address: signerAcct.address });
  tx = await wsSigner.sendTransaction({ to: CUSTODY, data: refundCall, account: signerAcct, nonce: BigInt(sNonce), gas: 1000000n, maxFeePerGas: 3000000000n, maxPriorityFeePerGas: 1000000000n });
  console.log('refund tx', tx);
  const refundTxHash = tx;
  await waitReceipt(pub, tx, 'refund');
  const escrowRefunded = await pub.readContract({ address: CUSTODY, abi: ESCROW_ABI, functionName: 'getEscrow', args: [cidRefund] });
  console.log('post-refund state', ['unfunded','funded','held','released','refunded','timed_out','disputed'][Number(escrowRefunded[9])], 'refundedAt', String(escrowRefunded[13]));

  // --- Dispute escrow: fund (buyer), raiseDispute (buyer) ---
  console.log('\n=== DISPUTE ESCROW ===');
  console.log('cid', cidDispute);
  bNonce = await pub.getTransactionCount({ address: buyerAcct.address });
  tx = await wsBuyer.sendTransaction({ to: CUSTODY, data: fundCall(cidDispute), account: buyerAcct, nonce: BigInt(bNonce), gas: 1000000n, maxFeePerGas: 3000000000n, maxPriorityFeePerGas: 1000000000n });
  console.log('fund tx', tx);
  const fundTxDispute = tx;
  await waitReceipt(pub, tx, 'fund-dispute');
  const escrowAfterFund2 = await pub.readContract({ address: CUSTODY, abi: ESCROW_ABI, functionName: 'getEscrow', args: [cidDispute] });
  console.log('post-fund state', ['unfunded','funded','held','released','refunded','timed_out','disputed'][Number(escrowAfterFund2[9])]);

  const disputeCall = '0x' + keccak256(toHex('raiseDispute(bytes32,bytes32,string)')).slice(2, 10)
    + encodeAbiParameters(parseAbiParameters('bytes32,bytes32,string'), [cidDispute, cidDispute, 'disputed for terminal-state access test']).slice(2);
  bNonce = await pub.getTransactionCount({ address: buyerAcct.address });
  tx = await wsBuyer.sendTransaction({ to: CUSTODY, data: disputeCall, account: buyerAcct, nonce: BigInt(bNonce), gas: 1000000n, maxFeePerGas: 3000000000n, maxPriorityFeePerGas: 1000000000n });
  console.log('dispute tx', tx);
  const disputeTxHash = tx;
  await waitReceipt(pub, tx, 'dispute');
  const escrowDisputed = await pub.readContract({ address: CUSTODY, abi: ESCROW_ABI, functionName: 'getEscrow', args: [cidDispute] });
  console.log('post-dispute state', ['unfunded','funded','held','released','refunded','timed_out','disputed'][Number(escrowDisputed[9])], 'disputedBy', escrowDisputed[10], 'disputeAt', String(escrowDisputed[11]));

  // Save
  const out = {
    custody: CUSTODY, amount: String(AMOUNT), deadline: String(deadline),
    refunded: { cid: cidRefund, digest: cidRefund, fundTx: fundTxRefund, refundTx: refundTxHash, refundNonce: String(refundNonce), issuedAt: String(issuedAt), state: ['unfunded','funded','held','released','refunded','timed_out','disputed'][Number(escrowRefunded[9])], refundedAt: String(escrowRefunded[13]) },
    disputed: { cid: cidDispute, digest: cidDispute, fundTx: fundTxDispute, disputeTx: disputeTxHash, state: ['unfunded','funded','held','released','refunded','timed_out','disputed'][Number(escrowDisputed[9])], disputedBy: escrowDisputed[10], disputeAt: String(escrowDisputed[11]) },
  };
  require('fs').writeFileSync('evidence/terminal-state-escrows.json', JSON.stringify(out, null, 2));
  console.log('\nsaved evidence/terminal-state-escrows.json');
})().catch((e) => { console.log('FATAL', e.message); process.exit(1); });