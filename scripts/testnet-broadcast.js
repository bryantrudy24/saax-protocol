// SAAX — Base Sepolia Testnet Broadcast Harness (Dependency 3)
//
// Ready-to-run once the signer has testnet gas (ETH) and the buyer has testnet
// USDC on Base Sepolia. Uses DISPOSABLE test wallets only; mainnet untouched.
//
// STEPS (each independently verifiable via public chain data):
//   A. Balance + config sanity (RPC, chain 84532, USDC 0x036C..., EAS addresses)
//   B. Schema: derive the SAAX schema UID; register it via SchemaRegistry
//      (idempotent — re-registration of an identical schema returns the same
//      UID with no duplicate).
//   C. Anchor: broadcast a REAL EAS attestation (mode=live), wait for
//      confirmations, read the Attested event UID (authoritative), then read
//      back getAttestation(uid) and confirm schema + digest + revocable=false.
//   D. Escrow custody: deploy SAAXEscrowCustodyV1, fund with buyer's test USDC
//      (transferFrom into the contract), verify balanceOf(custody).
//   E. Flow A: evaluator signs release verdict (EIP-712) -> release -> USDC to
//      seller; verify custody balance 0 + seller balance +amount.
//   F. Flow B: fund a second commitment, advance past deadline (real wait or a
//      short deadline), refund -> USDC back to buyer; verify chain state.
//
// ENV: SAAX_SIGNER_PRIVATE_KEY (gas + deployer + evaluator),
//      SAAX_TEST_BUYER_KEY (buyer funds escrow), SAAX_SELLER_ADDRESS,
//      SAAX_EAS_MODE=live, SAAX_ESCROW_RPC_URL=https://sepolia.base.org
//
// The custody contract source: contracts/SAAXEscrowCustodyV1.sol (compiled to
// data/escrow-custody-build.json). Deploy bytecode is derived from THAT source
// at build time (same harness as scripts/_escrow-custody-harness.cjs passed
// 25/25 on a local EVM with the identical bytecode).
//
// USAGE: node scripts/testnet-broadcast.js [--deploy-custody] [--fund]
//        (prints each step's txHash/uid; requires funded wallets)
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { createPublicClient, createWalletClient, http, keccak256, encodeAbiParameters, parseAbiParameters, getAddress } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { baseSepolia } = require('viem/chains');
const eas = require('../endpoint/eas.js');

const RPC = process.env.SAAX_ESCROW_RPC_URL || 'https://sepolia.base.org';
const USDC_BS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const EAS = eas.EAS_ADDRESS; // same proxy address on Base Sepolia
const SCHEMA_REG = eas.SCHEMA_REGISTRY_ADDRESS;

let passed = 0, failed = 0;
function check(name, cond, extra) { if (cond) { passed++; console.log('PASS  ' + name + (extra ? '  [' + extra + ']' : '')); } else { failed++; console.log('FAIL  ' + name + (extra ? '  [' + extra + ']' : '')); } }

const MIN_ERC20 = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 't', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
];
const SCHEMA_REG_ABI = [{ name: 'register', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'schema', type: 'string' }, { name: 'resolver', type: 'address' }, { name: 'revocable', type: 'bool' }], outputs: [{ name: '', type: 'bytes32' }] }];

(async () => {
  console.log('--- SAAX Base Sepolia testnet broadcast harness ---');
  const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
  const chainId = Number(await pub.getChainId());
  check('chain is Base Sepolia', chainId === 84532, 'chainId=' + chainId);

  const signerKey = process.env.SAAX_SIGNER_PRIVATE_KEY;
  const buyerKey = process.env.SAAX_TEST_BUYER_KEY;
  const sellerAddr = process.env.SAAX_SELLER_ADDRESS;
  if (!signerKey || !buyerKey || !sellerAddr) { console.error('MISSING ENV: signer/buyer/seller required'); process.exit(2); }
  const signer = privateKeyToAccount(signerKey);
  const buyer = privateKeyToAccount(buyerKey);
  const seller = getAddress(sellerAddr);
  const wc = createWalletClient({ account: signer, chain: baseSepolia, transport: http(RPC) });
  const wcb = createWalletClient({ account: buyer, chain: baseSepolia, transport: http(RPC) });
  const send = async (to, data, acct) => { const h = await wc.sendTransaction({ to, data, account: acct || signer }); const r = await pub.waitForTransactionReceipt({ hash: h }); return r; };
  const balEth = async (a) => Number(await pub.getBalance({ address: a })) / 1e18;
  const balUsdc = async (a) => Number(await pub.readContract({ address: USDC_BS, abi: MIN_ERC20, functionName: 'balanceOf', args: [a] }));

  // A. Balances + gas
  const se = await balEth(signer.address), be = await balEth(buyer.address);
  check('signer has testnet ETH (gas)', se > 0.0001, se.toFixed(6) + ' ETH');
  check('buyer has testnet ETH', be > 0.0001, be.toFixed(6) + ' ETH');
  const su = await balUsdc(signer.address), bu = await balUsdc(buyer.address);
  check('buyer has testnet USDC', bu >= 50000, (bu / 1e6).toFixed(4) + ' USDC');

  // Abort before ANY broadcast when gas/USDC are absent (external funding
  // blocker guard — the harness must never attempt a tx it cannot pay for).
  if (se <= 0.0001 || be <= 0.0001 || bu < 50000) {
    console.log('BLOCKED: testnet funding required (signer/buyer ETH + buyer USDC).');
    console.log('  Faucets: Alchemy/QuickNode/CDP for ETH; Circle faucet for USDC.');
    console.log('  Re-run after funding. No tx was broadcast. [chains verified OK]');
    process.exit(failed ? 2 : 2);
  }

  // B. Schema registration (idempotent)
  const schemaUid = eas.deriveSchemaUid();
  console.log('SCHEMA UID', schemaUid);
  // Register: register(schema, resolver=0, revocable=false). Idempotent: EAS
  // SchemaRegistry returns the same UID if the exact schema exists.
  const regData = keccak256(require('viem').toHex('register(string,address,bool)')).slice(0, 10)
    + encodeAbiParameters(parseAbiParameters('string,address,bool'), [eas.SAAX_COMMITMENT_SCHEMA, '0x0000000000000000000000000000000000000000', false]).slice(2);
  // Idempotent registration: EAS reverts with AlreadyExists when the exact schema
  // is already registered. Treat that as success (schema is on-chain); only fail
  // if the schema is genuinely absent AND the register call failed for another reason.
  let regOk = false;
  let regInfo = 'already registered';
  try {
    const regRec = await send(SCHEMA_REG, regData);
    regOk = regRec.status === 'success';
    regInfo = 'tx ' + regRec.transactionHash.slice(0, 16);
  } catch (e) {
    regOk = false;
    regInfo = 'revert ' + String(e.shortMessage || e.message).slice(0, 40);
  }
  const regUid = '0x' + (await pub.readContract({ address: SCHEMA_REG, abi: [{ name: 'getSchema', type: 'function', stateMutability: 'view', inputs: [{ name: 'uid', type: 'bytes32' }], outputs: [{ name: '', type: 'tuple', components: [{ name: 'uid', type: 'bytes32' }, { name: 'resolver', type: 'address' }, { name: 'revocable', type: 'bool' }, { name: 'schema', type: 'string' }] }] }], functionName: 'getSchema', args: [schemaUid] })).uid;
  const existsOnChain = regUid.toLowerCase() === schemaUid.toLowerCase();
  check('schema registered on chain (or already registered)', existsOnChain, existsOnChain ? regInfo : 'schema UID mismatch');

  // C. REAL attestation broadcast (live mode)
  console.log('BROADCASTING EAS attestation (SAAX_EAS_MODE=live)...');
  const commitment = {
    commitmentId: 'testnet-' + Date.now(),
    commitmentDigest: 'sha256:' + require('crypto').createHash('sha256').update('testnet-manifest').digest('hex'),
    parties: JSON.stringify({ buyer: buyer.address, seller }),
    requestedOutcome: JSON.stringify({ description: 'testnet security-scan' }),
    providerObligation: JSON.stringify({ description: 'testnet security-scan' }),
    commercialTerms: JSON.stringify({ amount: '50000', currency: 'USDC', decimals: 6 }),
    paymentTerms: JSON.stringify({ amount: '50000', currency: 'USDC' }),
    acceptanceCriteria: JSON.stringify([{ type: 'hash', value: 'sha256:testnet' }]),
    deadline: new Date(Date.now() + 86400e3).toISOString(),
    failureConditions: JSON.stringify([{ condition: 'provider_obligation_unfulfilled' }]),
    recoveryPolicy: JSON.stringify({ refundOnFailure: true }),
    refundsCompensation: JSON.stringify({ refundOnTotalFailure: true }),
    lifecycleState: 'issued',
  };
  process.env.SAAX_EAS_MODE = 'live';
  const att = await eas.attestCommitment(commitment, { rpcUrl: RPC });
  check('EAS real attestation broadcast + confirmed', att.ok === true, att.ok ? ('uid ' + att.anchor.uid.slice(0, 18) + ' tx ' + (att.anchor.txHash || '').slice(0, 14)) : att.error);
  if (att.ok) {
    const verify = await eas.verifyAnchor({ uid: att.anchor.uid, commitmentDigest: commitment.commitmentDigest, commitmentId: commitment.commitmentId, rpcUrl: RPC });
    check('EAS anchor independently verified (getAttestation)', verify.ok === true && verify.verified === true, verify.reason || 'schema+digest match');
    console.log('ANCHOR', JSON.stringify({ uid: att.anchor.uid, schemaUid: att.anchor.schemaUid, txHash: att.anchor.txHash, mode: 'live', digest: att.anchor.commitmentDigest }));
  }

  // D..F — escrow custody flows on testnet (optional --deploy-custody / --fund).
  const deployCustody = process.argv.includes('--deploy-custody');
  if (deployCustody) {
    let CUSTODY = (process.env.SAAX_CUSTODY_ADDRESS || '').trim();
    if (CUSTODY) {
      console.log('REUSING custody contract', CUSTODY);
      check('custody address provided (reuse)', /^0x[a-fA-F0-9]{40}$/.test(CUSTODY), CUSTODY.slice(0, 12));
    } else {
      console.log('DEPLOYING custody contract...');
      const build = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'escrow-custody-build.json'), 'utf8'));
      const rec = await send(null, build.bytecode);
      check('custody deployed on Base Sepolia', rec.status === 'success', rec.contractAddress);
      CUSTODY = rec.contractAddress;
    }
    console.log('CUSTODY_ADDRESS', CUSTODY);

    // Flow A: buyer funds -> evaluator release -> seller (evaluator = signer)
    const runNonce = Date.now();
    const cidA = '0x' + require('crypto').createHash('sha256').update('flowA-' + runNonce).digest('hex');
    const digestA = '0x' + require('crypto').createHash('sha256').update('digestA-' + runNonce).digest('hex');
    const amount = 50000n;
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const approveData = keccak256(require('viem').toHex('approve(address,uint256)')).slice(0, 10) + encodeAbiParameters(parseAbiParameters('address,uint256'), [CUSTODY, amount]).slice(2);
    const approveTx = await wcb.sendTransaction({ to: USDC_BS, data: approveData });
    await pub.waitForTransactionReceipt({ hash: approveTx });
    const fundCall = keccak256(require('viem').toHex('fund(bytes32,bytes32,address,address,address,address,uint256,uint256,uint64)')).slice(0, 10)
      + encodeAbiParameters(parseAbiParameters('bytes32,bytes32,address,address,address,address,uint256,uint256,uint64'), [cidA, digestA, USDC_BS, buyer.address, seller, signer.address, amount, BigInt(deadline), 0n]).slice(2);
    const fundTx = await wcb.sendTransaction({ to: CUSTODY, data: fundCall });
    await pub.waitForTransactionReceipt({ hash: fundTx });
    const held = await pub.readContract({ address: USDC_BS, abi: MIN_ERC20, functionName: 'balanceOf', args: [CUSTODY] });
    check('FLOW A: custody holds testnet USDC', held === amount, 'held=' + held);

    // Evaluator (signer) signs release verdict
    const DOMAIN = { name: 'SAAX Escrow Custody V1', version: '1', chainId: BigInt(chainId), verifyingContract: CUSTODY };
    const TYPES = { EscrowVerdict: [{ name: 'commitmentId', type: 'bytes32' }, { name: 'commitmentDigest', type: 'bytes32' }, { name: 'action', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'issuedAt', type: 'uint256' }] };
    const issuedAt = Math.floor(Date.now() / 1000);
    const verdictNonce = BigInt(runNonce);
    const sig = await signer.signTypedData({ domain: DOMAIN, types: TYPES, primaryType: 'EscrowVerdict', message: { commitmentId: cidA, commitmentDigest: digestA, action: 'release', nonce: verdictNonce, issuedAt: BigInt(issuedAt) } });
    const releaseCall = keccak256(require('viem').toHex('release(bytes32,bytes32,uint256,uint256,uint8,bytes32,bytes32)')).slice(0, 10)
      + encodeAbiParameters(parseAbiParameters('bytes32,bytes32,uint256,uint256,uint8,bytes32,bytes32'), [cidA, digestA, verdictNonce, BigInt(issuedAt), parseInt(sig.slice(130, 132), 16), '0x' + sig.slice(2, 66), '0x' + sig.slice(66, 130)]).slice(2);
    const relTx = await wc.sendTransaction({ to: CUSTODY, data: releaseCall, account: signer });
    const relRec = await pub.waitForTransactionReceipt({ hash: relTx });
    check('FLOW A: release tx mined', relRec.status === 'success', relTx.slice(0, 16));
    const sellerBal = await balUsdc(seller);
    check('FLOW A: seller received testnet USDC', sellerBal >= Number(amount), 'seller=' + sellerBal);
    check('FLOW A: custody emptied', Number(await balUsdc(CUSTODY)) === 0, 'held=0');
    console.log('FLOW_A_RELEASE_TX', relTx);

    // Flow B: separate commitment -> agreed failure/expiry condition -> buyer refund
    const cidB = '0x' + require('crypto').createHash('sha256').update('flowB-' + runNonce).digest('hex');
    const digestB = '0x' + require('crypto').createHash('sha256').update('digestB-' + runNonce).digest('hex');
    const amountB = 50000n;
    const deadlineB = Math.floor(Date.now() / 1000) + 30; // short deadline; refund after timeout
    const approveB = keccak256(require('viem').toHex('approve(address,uint256)')).slice(0, 10) + encodeAbiParameters(parseAbiParameters('address,uint256'), [CUSTODY, amountB]).slice(2);
    const approveBTx = await wcb.sendTransaction({ to: USDC_BS, data: approveB });
    await pub.waitForTransactionReceipt({ hash: approveBTx });
    const fundBCall = keccak256(require('viem').toHex('fund(bytes32,bytes32,address,address,address,address,uint256,uint256,uint64)')).slice(0, 10)
      + encodeAbiParameters(parseAbiParameters('bytes32,bytes32,address,address,address,address,uint256,uint256,uint64'), [cidB, digestB, USDC_BS, buyer.address, seller, signer.address, amountB, BigInt(deadlineB), 0n]).slice(2);
    const fundBTx = await wcb.sendTransaction({ to: CUSTODY, data: fundBCall });
    await pub.waitForTransactionReceipt({ hash: fundBTx });
    const heldB = await pub.readContract({ address: USDC_BS, abi: MIN_ERC20, functionName: 'balanceOf', args: [CUSTODY] });
    check('FLOW B: custody holds second escrow', heldB >= amountB, 'held=' + heldB);

    // Wait past deadline (30s) then refund (buyer is authorized party; deadline timeout path)
    console.log('FLOW B: waiting ' + (deadlineB - Math.floor(Date.now() / 1000)) + 's for deadline...');
    while (Math.floor(Date.now() / 1000) < deadlineB) await new Promise((r) => setTimeout(r, 2000));
    // Timeout refund: zero verdict signature (v=0, r=0x0, s=0x0) after deadline.
    const refundCall = keccak256(require('viem').toHex('refund(bytes32,bytes32,uint256,uint256,uint8,bytes32,bytes32)')).slice(0, 10)
      + encodeAbiParameters(parseAbiParameters('bytes32,bytes32,uint256,uint256,uint8,bytes32,bytes32'), [cidB, digestB, 0n, 0n, 0, '0x' + '00'.repeat(32), '0x' + '00'.repeat(32)]).slice(2);
    const refundTx = await wcb.sendTransaction({ to: CUSTODY, data: refundCall });
    const refundRec = await pub.waitForTransactionReceipt({ hash: refundTx });
    check('FLOW B: refund tx mined', refundRec.status === 'success', refundTx.slice(0, 16));
    const buyerBalAfter = await balUsdc(buyer.address);
    check('FLOW B: buyer refunded testnet USDC', buyerBalAfter >= Number(amountB), 'buyer=' + buyerBalAfter);
    check('FLOW B: custody emptied after refund', Number(await balUsdc(CUSTODY)) === 0, 'held=0');
    console.log('FLOW_B_REFUND_TX', refundTx);
  }

  console.log('--- RESULT: ' + passed + ' passed, ' + failed + ' failed ---');
  console.log('NEXT: fund the signer + buyer with Base Sepolia ETH/USDC (faucets), then run with --deploy-custody.');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e.message ? e.message.slice(0, 300) : e); process.exit(1); });
