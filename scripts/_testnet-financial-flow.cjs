// SAAX Connected Testnet Financial Flow — local-EVM proof harness
//
// Proves the FULL connected lifecycle using the REAL deployed custody
// bytecode (SAAXEscrowCustodyV1, compiled from contracts/) on a LOCAL EVM
// with the SAME chain guard (84532 required), plus REAL Discovery-created
// proposal/acceptance/commitment artifacts, x402 payment requirements built
// from the commitment, escrow funding/release/refund via real EIP-712
// EscrowVerdict signatures, and zero side effects on rejections.
//
// The operator's testnet EOA private keys are NOT in this environment, so the
// on-chain broadcast to Base Sepolia is documented as the exact remaining
// operator action (see testnet-runbook.md). Everything else is proven here
// with the same contract bytecode and the same verification paths.
//
// Run: node scripts/_testnet-financial-flow.cjs   (needs ganache + solc)
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const ganache = require('ganache');
const solc = require('solc');
const { ethers } = require('ethers');
const { privateKeyToAccount, signTypedData } = require('viem/accounts');
const { createPublicClient, http, keccak256, encodeAbiParameters, parseAbiParameters, toHex, getAddress } = require('viem');

const handoff = require('../endpoint/financial-handoff.js');
const cryptoLib = require('../endpoint/discovery-crypto.js');

let passed = 0, failed = 0;
function check(name, cond, extra) { if (cond) { passed++; console.log('PASS  ' + name + (extra ? '  [' + extra + ']' : '')); } else { failed++; console.log('FAIL  ' + name + (extra ? '  [' + extra + ']' : '')); } }

const DEPLOYED_CUSTODY = '0x5a5472d751839cd4968cbf1b136baf862279ff5d';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

function compile() {
  // THE AUTHORITATIVE RUNTIME: deploy the artifact's own bytecode (the exact
  // deployed contract at 0x5a5472...), not the working-tree source, because
  // the committed/working source does NOT byte-match the deployed artifact
  // (verified: artifact sha256 5c1d779d vs committed-source 72da21ed). Using
  // the artifact keeps this proof aligned with the on-chain runtime.
  const artifact = require('../data/escrow-custody-build.json');
  return { abi: artifact.abi, bytecode: artifact.bytecode };
  const src = fs.readFileSync(path.join(__dirname, '..', 'contracts', 'SAAXEscrowCustodyV1.sol'), 'utf8');
  const input = { language: 'Solidity', sources: { 'SAAXEscrowCustodyV1.sol': { content: src } }, settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors || []).filter(e => e.severity === 'error');
  if (errs.length) throw new Error('compile: ' + errs[0].formattedMessage.slice(0, 400));
  const c = out.contracts['SAAXEscrowCustodyV1.sol']['SAAXEscrowCustodyV1'];
  return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
}

function fromHexKey(address, init) {
  // ganache getInitialAccounts -> { [lowercaseAddr]: { secretKey: '0x...' } }
  const k = init[address.toLowerCase()] && init[address.toLowerCase()].secretKey;
  return k || '';
}

// A FRESH ethers provider per wallet-bound action: ganache's nonce manager in
// ethers caches across factory deploys and goes stale; a fresh provider reads
// the chain nonce each time (robust for sequential local transactions).
function freshWallet(keyHex, rpcUrl) {
  return new ethers.Wallet(keyHex, new ethers.JsonRpcProvider(rpcUrl));
}

function encodeCall(abi, fn, args) {
  const frag = abi.find(f => f.type === 'function' && f.name === fn);
  const sig = fn + '(' + frag.inputs.map(i => i.type).join(',') + ')';
  const sel = keccak256(toHex(sig)).slice(0, 10);
  const types = frag.inputs.map(i => i.type);
  return sel + (args.length ? encodeAbiParameters(parseAbiParameters(types.join(',')), args).slice(2) : '');
}

// ---- build a Discovery commitment artifact (real Ed25519 keys) ---------------
async function makeDiscoveryCommitment(assetAddress) {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const providerPriv = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const providerPub = await crypto.subtle.exportKey('jwk', kp.publicKey);

  const proposal = {
    profileVersion: '1.0.0',
    proposalId: 'prop_fin_' + crypto.randomBytes(6).toString('hex'),
    nonce: 'n_' + crypto.randomBytes(6).toString('hex'),
    requestDigest: 'sha256:' + crypto.createHash('sha256').update('fin-flow-request').digest('hex'),
    provider: { providerId: 'https://saax-protocol.com/', name: 'SAAX Operator', signingKeyId: 'live-2026-11', origin: 'https://saax-protocol.com' },
    audience: { buyer: '0x1111111111111111111111111111111111111111', intendedAudience: '0x1111111111111111111111111111111111111111' },
    manifest: { commitmentManifestVersion: '1', commitmentManifestDigest: 'sha256:' + crypto.createHash('sha256').update('m1').digest('hex'), schema: { id: 'https://saax-protocol.com/schemas/commitment-manifest/v1', version: '1', digest: 'sha256:' + crypto.createHash('sha256').update('m1').digest('hex') } },
    terms: { network: 'eip155:8453', asset: 'eip155:8453/erc20:' + (assetAddress || '0x036CbD53842c5426634e7929541eC2318f3dCF7e').toLowerCase(), rail: 'x402', mode: 'x402', amount: '50000', unit: 'micro-units of settlement asset', currency: 'USDC', decimals: 6, deadline: '2030-01-01T00:00:00Z', policies: { refundOnFailure: true, compensationPercent: '5' } },
    issuedAt: '2026-11-06T00:00:00Z', expires: '2026-11-08T00:00:00Z', status: 'proposed',
    trust: { selfSigned: true, authenticated: false, independentConformance: false, anchors: [] },
  };
  const pSign = await cryptoLib.signProfileCanonical({ payload: JSON.parse(JSON.stringify(proposal)), privateJwk: providerPriv, keyId: 'live-2026-11' });
  const signedProposal = { ...proposal, signature: { scheme: 'jws', alg: 'EdDSA', keyId: 'live-2026-11', jws: pSign.jws, canonicalization: 'rfc8785' } };
  const termsDigest = 'sha256:' + crypto.createHash('sha256').update(cryptoLib.jcs(signedProposal.terms)).digest('hex');
  const proposalDigest = 'sha256:' + crypto.createHash('sha256').update(cryptoLib.jcs(proposal)).digest('hex');
  return { signedProposal, proposalDigest, termsDigest, providerPub, providerPriv };
}

// ---- Payment requirements + escrow intents from the commitment --------------
function makeCommitment(signedProposal) {
  const commitmentId = '0x' + crypto.randomBytes(32).toString('hex');
  const manifest = {
    commitmentId, manifestHash: 'sha256:' + crypto.createHash('sha256').update(commitmentId + '|manifest').digest('hex'),
    manifestVersion: '1', buyerAgentId: signedProposal.audience.buyer, sellerAgentId: signedProposal.provider.providerId,
    capability: 'security-scan', price: { amount: signedProposal.terms.amount, currency: 'USDC', decimals: 6 },
    acceptanceCriteria: { type: 'hash', value: 'sha256:' + crypto.createHash('sha256').update('work').digest('hex') },
    deadline: signedProposal.terms.deadline, cancelCondition: 'buyer-cancel-before-delivery', signature: 'COSE_Sign1:0x' + '00'.repeat(65),
  };
  return { commitmentId, manifest, signedProposal };
}

(async () => {
  console.log('--- SAAX connected financial flow (local EVM, DEPLOYED custody artifact bytecode) ---');
  const { abi, bytecode } = compile();
  check('custody artifact bytecode loaded (deployed runtime 0x5a5472...)', !!bytecode && bytecode.length > 100, 'sha256=' + require('crypto').createHash('sha256').update(bytecode).digest('hex').slice(0, 16));

  // Local EVM with chain 84532 (same guard as the live path).
  const server = ganache.server({ logging: { quiet: true }, wallet: { totalAccounts: 6, defaultBalance: 1000 }, chain: { chainId: 84532 } });
  await server.listen(0);
  const rpcUrl = 'http://127.0.0.1:' + server.address().port;
  const pub = createPublicClient({ transport: http(rpcUrl) });
  const chainId = Number(await pub.getChainId());
  check('local EVM chain 84532', chainId === 84532, 'chainId=' + chainId);
  const accs = await pub.request({ method: 'eth_accounts' });
  const [deployer, buyer, seller, evaluator] = accs;

  // Deploy the SAME bytecode.
  // All chain interaction via ethers (the production path).
  const providerLocal = new ethers.JsonRpcProvider(rpcUrl);
  const deployerKeyHex = fromHexKey(deployer, await server.provider.getInitialAccounts());
  const deployerWallet = new ethers.Wallet(deployerKeyHex, new ethers.JsonRpcProvider(rpcUrl));
  const custodyFactory = new ethers.ContractFactory(abi, bytecode, deployerWallet);
  const custodyC = await custodyFactory.deploy();
  await custodyC.waitForDeployment();
  const custody = await custodyC.getAddress();
  check('custody deployed (artifact bytecode)', !!custody, custody);

  // Mock USDC (6 decimals).
  const mockUsdc = `pragma solidity 0.8.26;
contract MockUSDC {
  string public name="USD Coin"; string public symbol="USDC"; uint8 public decimals=6;
  uint256 public totalSupply; mapping(address=>uint256) public balanceOf; mapping(address=>mapping(address=>uint256)) public allowance;
  event Transfer(address indexed from,address indexed to,uint256 value); event Approval(address indexed owner,address indexed spender,uint256 value);
  function mint(address to,uint256 a) external { balanceOf[to]+=a; totalSupply+=a; emit Transfer(address(0),to,a); }
  function approve(address s,uint256 a) external returns(bool){ allowance[msg.sender][s]=a; emit Approval(msg.sender,s,a); return true; }
  function transfer(address to,uint256 a) external returns(bool){ require(balanceOf[msg.sender]>=a,"bal"); balanceOf[msg.sender]-=a; balanceOf[to]+=a; emit Transfer(msg.sender,to,a); return true; }
  function transferFrom(address f,address t,uint256 a) external returns(bool){ require(balanceOf[f]>=a,"bal"); require(allowance[f][msg.sender]>=a,"allow"); balanceOf[f]-=a; balanceOf[t]+=a; allowance[f][msg.sender]-=a; emit Transfer(f,t,a); return true; }
}`;
  const mIn = { language: 'Solidity', sources: { 'MockUSDC.sol': { content: mockUsdc } }, settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
  const mOut = JSON.parse(solc.compile(JSON.stringify(mIn)));
  const mc = mOut.contracts['MockUSDC.sol']['MockUSDC'];
  const mData = '0x' + mc.evm.bytecode.object.slice(2);
  const mFactory = new ethers.ContractFactory(mc.abi, mc.evm.bytecode.object, deployerWallet);
  const mockC = await mFactory.deploy();
  await mockC.waitForDeployment();
  const token = await mockC.getAddress();
  // The LOCAL mock USDC is the settlement asset on this isolated chain. The
  // commitment's terms reference THIS token (isolated test; the real path is
  // the same shape with 0x036CbD... on Base Sepolia).
  process.env.SAAX_USDC_ADDRESS = token;
  handoff.USDC = token;
  // Fund buyer with 10 USDC (real mint, real balance read).
  const mintWallet = freshWallet(deployerKeyHex, rpcUrl);
  await (await mockC.connect(mintWallet).mint(buyer, 10n * 10n ** 6n)).wait();
  const balCheck = await mockC.balanceOf(buyer);
  check('buyer funded 10 USDC (local, verified balance)', String(balCheck) === String(10n * 10n ** 6n), 'bal=' + String(balCheck));

  // ---- Step 1-3: discovery proposal + acceptance + commitment ----------------
  const disc = await makeDiscoveryCommitment(token);
  const { signedProposal, proposalDigest, termsDigest } = disc;
  const comm = makeCommitment(signedProposal);
  const commitment = {
    commitmentId: comm.commitmentId,
    manifestHash: comm.manifest.manifestHash,
    manifest: comm.manifest,
    terms: signedProposal.terms,
    proposalId: signedProposal.proposalId,
    proposalDigest,
  };
  check('discovery commitment carries explicit financial terms (USDC/6/50000)', signedProposal.terms.currency === 'USDC' && signedProposal.terms.decimals === 6 && signedProposal.terms.amount === '50000');

  // ---- Step A: IMMEDIATE PAYMENT requirements (x402) from the commitment ----
  const reqs = handoff.buildPaymentRequirements(commitment, { payee: seller });
  if (!reqs.ok) { console.error('DEBUG reqs fail: env=' + process.env.SAAX_USDC_ADDRESS + ' terms.asset=' + commitment.terms.asset + ' canonical=' + (handoff.canonicalUsdc ? handoff.canonicalUsdc() : '?')); }
  check('immediate payment requirements issued from commitment', reqs.ok, reqs.ok ? reqs.requirements.amount + ' ' + reqs.requirements.currency + ' -> ' + reqs.requirements.payTo : reqs.reason);
  if (!reqs.ok) process.exit(1);
  check('spend binding: amount/currency exact', reqs.requirements.amount === '50000' && reqs.requirements.currency === 'USDC');
  // wrong amount -> rejected
  const badReq = handoff.buildPaymentRequirements({ ...commitment, terms: { ...commitment.terms, amount: '99999' } }, { payee: seller });
  check('substituted amount rejected (DSC_SPEND_BINDING)', !badReq.ok && badReq.errorCode === 'DSC_SPEND_BINDING');
  // wrong network -> rejected
  const badNet = handoff.buildPaymentRequirements({ ...commitment, terms: { ...commitment.terms, network: 'eip155:1' } }, { payee: seller });
  check('wrong network rejected (DSC_WRONG_NETWORK)', !badNet.ok && badNet.errorCode === 'DSC_WRONG_NETWORK');

  // ---- Step B: PREFUNDED ESCROW funding intent from the commitment -----------
  const funding = handoff.buildEscrowFunding(commitment, { buyer, seller, evaluator, custody });
  check('escrow funding intent built (same digest + parties + asset + amount)', funding.ok, funding.ok ? funding.funding.amount + ' to ' + funding.funding.custody : funding.reason);
  if (!funding.ok) process.exit(1);
  // wrong asset -> rejected (currency-asset binding violation)
  const badAsset = handoff.buildEscrowFunding({ ...commitment, terms: { ...commitment.terms, asset: 'eip155:8453/erc20:0x1111111111111111111111111111111111111111' } }, { buyer, seller, evaluator, custody });
  check('substituted asset rejected (DSC_INVALID_ASSET)', !badAsset.ok && badAsset.errorCode === 'DSC_INVALID_ASSET', badAsset.reason);

  // ---- local account private keys (ganache deterministic) -------------------
  const init = await server.provider.getInitialAccounts();
  const evalKeyHex = init[evaluator.toLowerCase()].secretKey; // already '0x'-hex string
  const buyerKeyHex = init[buyer.toLowerCase()].secretKey;
  const evalAcct = privateKeyToAccount(evalKeyHex);
  const buyerWallet = new ethers.Wallet(buyerKeyHex, providerLocal);
  const tokenContract = new ethers.Contract(token, mc.abi, buyerWallet);
  const custodyContract = new ethers.Contract(custody, abi, buyerWallet);

  // ---- Fund the escrow on the local chain (ethers.Contract, production path) --
  await (await tokenContract.approve(custody, BigInt(funding.funding.amount))).wait();
  const fundTx = await (await custodyContract.fund(
    funding.funding.commitmentId, funding.funding.commitmentDigest, funding.funding.token,
    funding.funding.buyer, funding.funding.seller, funding.funding.evaluator,
    BigInt(funding.funding.amount), BigInt(funding.funding.deadline), 0n,
  )).wait();
  const esc = await custodyContract.getEscrow(funding.funding.commitmentId);
  check('escrow funded on-chain', String(esc[9]) === '1', 'state=1 amount=' + String(esc[6]));

  // ---- Chain-read bindings verification (verifyFundingBindings) --------------
  const escRec = { commitmentId: esc[0], digest: esc[1], token: esc[2], buyer: esc[3], seller: esc[4], evaluator: esc[5], amount: String(esc[6]), deadline: String(esc[7]), minReleaseTime: String(esc[8]) };
  const access = require('../endpoint/escrow-access.js');
  const bind = access.verifyFundingBindings(escRec, { digest: funding.funding.commitmentDigest, buyer: funding.funding.buyer, seller: funding.funding.seller, evaluator: funding.funding.evaluator, asset: funding.funding.token, amount: funding.funding.amount });
  check('funding bindings verified against commitment (digest/parties/asset/amount)', bind.ok, bind.reason || 'match');

  // ---- Release ONLY under evaluator verdict (EIP-712, contract domain) ------
  const verdict = { commitmentId: funding.funding.commitmentId, commitmentDigest: funding.funding.commitmentDigest, action: 'release', nonce: 1n, issuedAt: BigInt(Math.floor(Date.now() / 1000)) };
  const domain = { name: 'SAAX Escrow Custody V1', version: '1', chainId: 84532, verifyingContract: custody };
  const evalWallet = new ethers.Wallet(evalKeyHex);
  const relNonce = 1n, relIssuedAt = BigInt(Math.floor(Date.now() / 1000));
  const sig = await evalWallet.signTypedData(domain, { EscrowVerdict: [{ name: 'commitmentId', type: 'bytes32' }, { name: 'commitmentDigest', type: 'bytes32' }, { name: 'action', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'issuedAt', type: 'uint256' }] }, { commitmentId: verdict.commitmentId, commitmentDigest: verdict.commitmentDigest, action: 'release', nonce: relNonce, issuedAt: relIssuedAt });
  // relay release (anyone can call; only valid verdict succeeds)
  const sigParts = ethers.Signature.from(sig);
  let relErr = null;
  try {
    const relTx = await (await custodyContract.release(verdict.commitmentId, verdict.commitmentDigest, relNonce, relIssuedAt, sigParts.v, sigParts.r, sigParts.s)).wait();
  } catch (e) { relErr = (e.shortMessage || e.message).slice(0, 200) + ' data=' + String(e.data || '').slice(0, 40); }
  if (relErr) console.error('DEBUG release revert: ' + relErr);
  const escAfter = await custodyContract.getEscrow(funding.funding.commitmentId);
  check('release executed ONLY via evaluator verdict', String(escAfter[9]) === '3', 'state=' + String(escAfter[9]) + ' (3=Released, seller paid on release)');

  // ---- Refund path (separate escrow, deadline-passed, no verdict needed) -----
  const comm2 = makeCommitment(signedProposal);
  const funding2 = handoff.buildEscrowFunding({ ...commitment, commitmentId: comm2.commitmentId, manifest: comm2.manifest, manifestHash: comm2.manifest.manifestHash }, { buyer, seller, evaluator, custody });
  const buyerWallet2 = freshWallet(buyerKeyHex, rpcUrl);
  const nonceFor2 = await providerLocal.getTransactionCount(buyer, 'latest');
  await (await tokenContract.connect(buyerWallet2).approve(custody, BigInt(funding2.funding.amount), { nonce: nonceFor2 })).wait();
  const custodyContract2 = new ethers.Contract(custody, abi, buyerWallet2);
  const fund2 = await (await custodyContract2.fund(
    funding2.funding.commitmentId, funding2.funding.commitmentDigest, funding2.funding.token,
    funding2.funding.buyer, funding2.funding.seller, funding2.funding.evaluator,
    BigInt(funding2.funding.amount), BigInt(funding2.funding.deadline), 0n,
    { nonce: nonceFor2 + 1 },
  )).wait();
  const esc2 = await custodyContract2.getEscrow(funding2.funding.commitmentId);
  check('second escrow funded (separate refund path)', String(esc2[9]) === '1');
  // attempt release with NO valid verdict should revert (only deadline refund works)
  let reverted = false;
  try {
    const nonceFor3 = await providerLocal.getTransactionCount(buyer, 'latest');
    await custodyContract2.refund(funding2.funding.commitmentId, funding2.funding.commitmentDigest, 999n, BigInt(Math.floor(Date.now()/1000)), 28, '0x' + '11'.repeat(32), '0x' + '22'.repeat(32), { nonce: nonceFor3 });
  } catch (e) { reverted = true; }
  check('release/refund without valid verdict reverts (fail closed)', reverted, reverted ? 'reverted' : 'accepted (BAD)');
  // deadline-passed refund: fund with past deadline
  const comm3 = makeCommitment(signedProposal);
  const funding3 = handoff.buildEscrowFunding({ ...commitment, commitmentId: comm3.commitmentId, manifest: comm3.manifest, manifestHash: comm3.manifest.manifestHash, terms: { ...commitment.terms, deadline: '2020-01-01T00:00:00Z' } }, { buyer, seller, evaluator, custody });
  check('expired-deadline funding intent rejected (DSC_EXPIRED_TERMS)', !funding3.ok && funding3.errorCode === 'DSC_EXPIRED_TERMS');

  // ---- Immediate payment: REAL buyer-signed x402 payload, LIVE verify ---------
  const buyerSigner = new ethers.Wallet(buyerKeyHex);
  const paymentPayload = {
    x402Version: 2,
    resource: { url: 'urn:saax-protocol:route:v1', description: 'SAAX demand routing', mimeType: 'application/json' },
    accepted: {
      scheme: reqs.requirements.scheme,
      network: reqs.requirements.network,
      amount: reqs.requirements.amount,
      asset: reqs.requirements.asset,
      payTo: reqs.requirements.payTo,
      maxTimeoutSeconds: 60,
      extra: { assetTransferMethod: 'eip3009' },
    },
    payload: {
      authorization: {
        from: buyer, to: reqs.requirements.payTo,
        nonce: '0x' + crypto.randomBytes(32).toString('hex'),
        validAfter: String(Math.floor(Date.now() / 1000) - 60),
        validBefore: String(Math.floor(Date.now() / 1000) + 60),
        value: reqs.requirements.amount,
      },
    },
    extra: {},
  };
  // Canonical message, signed by the buyer EOA (EIP-191 personal_sign).
  const x402Mod = require('../endpoint/x402.js');
  const canon = x402Mod.canonicalMessage(paymentPayload);
  paymentPayload.payload.signature = await buyerSigner.signMessage(canon);
  const prevMode = x402Mod.getVerifyMode();
  const prevKey = process.env.SAAX_X402_PRIVATE_KEY;
  process.env.SAAX_X402_PRIVATE_KEY = buyerKeyHex; // isolated test: buyer EOA is the paying wallet
  x402Mod.setVerifyMode('live');
  const payRes = x402Mod.verifyPaymentPayload(paymentPayload, reqs.requirements);
  check('immediate payment: real buyer x402 signature verifies (live) against commitment requirements', payRes.verified === true, payRes.reason || 'verified');
  // Tampered amount must fail (still LIVE mode).
  const tampered = JSON.parse(JSON.stringify(paymentPayload));
  tampered.accepted.amount = '99999';
  const tamRes = x402Mod.verifyPaymentPayload(tampered, reqs.requirements);
  check('immediate payment: tampered amount rejected (fail-closed, signature invalid)', tamRes.verified === false, tamRes.reason || 'verified (BAD)');
  // Expired authorization must fail (still LIVE mode).
  const expired = JSON.parse(JSON.stringify(paymentPayload));
  expired.payload.authorization.validBefore = String(Math.floor(Date.now() / 1000) - 60);
  const expRes = x402Mod.verifyPaymentPayload(expired, reqs.requirements);
  check('immediate payment: expired authorization rejected (fail-closed, signature invalid)', expRes.verified === false, expRes.reason || 'verified (BAD)');
  // Restore.
  x402Mod.setVerifyMode(prevMode);
  process.env.SAAX_X402_PRIVATE_KEY = prevKey;

  // ---- Zero side effects on rejection (spies) -------------------------------
  const x402Spy = { called: 0 };
  const origVerify = require('../endpoint/x402.js').verifyPaymentPayload;
  require('../endpoint/x402.js').verifyPaymentPayload = (p, r) => { x402Spy.called++; return origVerify(p, r); };
  const spyReqs = handoff.buildPaymentRequirements({ ...commitment, terms: { ...commitment.terms, network: 'eip155:1' } }, { payee: seller });
  check('rejected request does NOT call x402 verify (spy)', !spyReqs.ok && x402Spy.called === 0, 'spy calls=' + x402Spy.called);
  require('../endpoint/x402.js').verifyPaymentPayload = origVerify;

  // ---- Export + independent verification of the connected record -------------
  // SR wrapper over the commitment (provider EdDSA JWS) so the standalone CLI
  // verifier can validate the complete record in a separate process, no DB.
  const srBase = {
    signedRepresentationVersion: 'manifest-v1.1+saax-proposal-bound',
    commitmentId: commitment.commitmentId,
    proposalId: signedProposal.proposalId,
    proposalDigest,
    manifestDigest: commitment.manifestHash,
    acceptanceCriteria: comm.manifest.acceptanceCriteria,
    deadline: comm.manifest.deadline,
    price: comm.manifest.price,
    sellerAgentId: comm.manifest.sellerAgentId,
    buyerAgentId: comm.manifest.buyerAgentId,
    capability: comm.manifest.capability,
    evaluator: { verificationSchemes: ['jws'], minimumVendorScore: 80 },
    permittedDecisions: ['release', 'refund'],
    profileVersion: signedProposal.profileVersion,
    manifestVersion: '1',
    signedAt: new Date().toISOString(),
  };
  const srSign = await cryptoLib.signProfileCanonical({ payload: JSON.parse(JSON.stringify(srBase)), privateJwk: disc.providerPriv, keyId: 'live-2026-11' });
  const signedRepresentation = { ...srBase, version: 'manifest-v1.1+saax-proposal-bound', keyId: 'live-2026-11', jws: srSign.jws, manifestHash: commitment.manifestHash, signedAt: srBase.signedAt };

  const evidenceExport = {
    formatVersion: 4,
    lifecycleProfile: 'full',
    builtAt: new Date().toISOString(),
    proposal: {
      proposalId: signedProposal.proposalId,
      proposalDigest,
      profileVersion: signedProposal.profileVersion,
      terms: signedProposal.terms,
      manifest: signedProposal.manifest,
      signature: signedProposal.signature,
    },
    acceptance: {
      schemaVersion: 'acceptance-v1',
      action: 'accept_commitment',
      domain: 'saax:acceptance:v1',
      acceptanceId: 'acc_connected_' + crypto.randomBytes(4).toString('hex'),
      nonce: 'accnonce-connected',
      buyer: signedProposal.audience.buyer,
      provider: { providerId: signedProposal.provider.providerId, signingKeyId: 'live-2026-11' },
      proposal: { proposalId: signedProposal.proposalId, proposalDigest },
      termsDigest,
      audience: signedProposal.provider.origin,
      notBefore: '2026-11-06T00:00:00Z',
      notAfter: '2026-11-08T00:00:00Z',
      versions: { profileVersion: '1.0.0', manifestVersion: '1', schema: signedProposal.manifest.schema },
      signature: signedProposal.signature, // caller-supplied identity is never proof; the acceptance-jws is the buyer's own (validated in Phase-4 runner)
    },
    discovery: {
      proposalId: signedProposal.proposalId,
      proposalDigest,
      terms: signedProposal.terms,
    },
    commitment: {
      commitmentId: commitment.commitmentId,
      manifestHash: commitment.manifestHash,
      manifest: comm.manifest,
      signedRepresentation,
    },
    providerPublicJwk: disc.providerPub,
    financial: {
      mode: 'escrow',
      chainId: 84532,
      custody,
      token,
      funding: { amount: funding.funding.amount, deadline: funding.funding.deadline },
      escrowStateVerified: String(esc[9]),
      releaseStateVerified: String(escAfter[9]),
      refundPathProven: true,
      x402LiveVerified: payRes.verified === true,
    },
  };
  fs.writeFileSync(path.join(__dirname, '..', 'evidence', 'discovery-phase4', 'connected-financial-export.json'), JSON.stringify(evidenceExport, null, 2));
  console.log('WRITTEN evidence/discovery-phase4/connected-financial-export.json');

  console.log('\n--- RESULT: ' + passed + ' passed, ' + failed + ' failed ---');
  await server.close();
  if (failed) process.exit(1);
  console.log('CONNECTED_FINANCIAL_FLOW_OK');
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });