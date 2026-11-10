'use strict';
/**
 * F3C — Complete V3-export producer + separate-process verification (LOCAL ONLY).
 *
 * Produces NEW V4-format exports from ACTUAL integrated V3-custody records on
 * the local EVM (chain 31337), then verifies each in a SEPARATE PROCESS via
 * verifier/verify-export.js (formatVersion 4 -> verify-v4.js CLI) against a
 * READ-ONLY RPC proxy — no app DB access, no participant keys in the child.
 *
 * Outcomes exercised (the V3 contract's genuine settlement surface):
 *   A. Fulfilled release            -> custody.release (evaluator, head-bound)
 *   B. Affirmative nonfulfillment   -> custody.refundVerdict (evaluator refund)
 *   C. Mutual settlement            -> custody.mutualRelease / mutualRefund
 *   D. Disputed resolution          -> custody.raiseDispute + custody.resolve
 *   E. Headless timeout             -> custody.refundTimeout (no checkpoint)
 *
 * BOTH payout directions are exercised for mutual (release->seller,
 * refund->buyer) and disputed (resolve release->seller, resolve refund->buyer).
 *
 * Each export carries: formatVersion 4 + agreement + commitmentDigest +
 * authorizations + lifecycle (funding+settlement refs) + finality
 * (local-synthetic) + journal (issue -> funded -> settlement via the shared
 * writer) + anchor (genuine EAS 1.7.1, local 31337) + evidence (signed
 * deliverable when the outcome is a release).
 *
 * New evidence in evidence/f3c-v4-exports/. Historical fixtures untouched.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');
const { ethers } = require('ethers');
const helpers = require('./test-custody-v2-realsafe.cjs');
const canonical = require('../mainnet/design/support/v4-canonical');
const signatures = require('../mainnet/design/support/v4-signatures');
const journalWriter = require('../mainnet/design/support/v4-journal-writer');
const v3sig = require('./v3-signing.cjs');
const av = require('../verifier/v4-anchor');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'evidence/f3c-v4-exports');
fs.mkdirSync(OUT, { recursive: true });

let passed = 0, failed = 0;
const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  — ' + detail : '')); }
}

function child(file, rpc) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'verifier/verify-export.js'), file, '--rpc', rpc], {
      cwd: ROOT,
      env: Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'].filter(k => process.env[k]).map(k => [k, process.env[k]])),
    });
    let text = '';
    p.stdout.on('data', v => { text += v; });
    p.stderr.on('data', v => { text += v; });
    p.on('error', reject);
    p.on('exit', code => resolve({ code, text }));
  });
}

(async () => {
  const CHAIN = 31337;
  const revision = require('child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const { provider, hre, accounts } = await helpers.startEvm(CHAIN);
  const [deployer, buyer, seller, evaluatorEOA, attester, , stranger] = accounts;

  const deploy = async (art, args = []) => { const c = await new ethers.ContractFactory(art.abi, art.bytecode, deployer).deploy(...args); await c.waitForDeployment(); return c; };

  // ——— Official EAS 1.7.1 ———
  const regArt = require('@ethereum-attestation-service/eas-contracts/artifacts/contracts/SchemaRegistry.sol/SchemaRegistry.json');
  const easArt = require('@ethereum-attestation-service/eas-contracts/artifacts/contracts/EAS.sol/EAS.json');
  const registry = await deploy(regArt);
  const eas = await deploy(easArt, [registry.target]);

  // ——— Token + V3 custody (real deployed address) ———
  const token = await deploy(hre.artifacts.readArtifactSync('MockUSDC'));
  const policy = '0x' + 'ab'.repeat(32);
  const v3art = require('../data/escrow-custody-v3-build.json');
  const custody = await deploy({ abi: v3art.abi, bytecode: v3art.bytecode }, [1000000, 10000000, true, 1, policy]);
  const custodyAddr = custody.target;
  check('V3 custody deployed with real address', ethers.isAddress(custodyAddr));

  await (await registry.register(av.SCHEMA, ethers.ZeroAddress, false)).wait();
  await (await token.mint(buyer.address, 1000000)).wait();
  await (await token.connect(buyer).approve(custodyAddr, 1000000)).wait();

  const block = await provider.send('eth_getBlockByNumber', ['latest', false]);
  const t = Number(BigInt(block.timestamp));
  const iso = n => new Date(n * 1000).toISOString().replace('.000Z', 'Z');
  const ref = r => ({ txHash: r.hash, blockHash: r.blockHash });

  // ——— Read-only RPC proxy ———
  const allow = new Set(['eth_chainId', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call', 'eth_blockNumber']);
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const answer = async q => {
      try {
        if (!allow.has(q.method)) throw new Error('read-only method unavailable');
        return { jsonrpc: '2.0', id: q.id, result: await hre.network.provider.send(q.method, q.params) };
      } catch (e) { return { jsonrpc: '2.0', id: q.id, error: { code: -32000, message: e.message } }; }
    };
    try { const q = JSON.parse(body); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(Array.isArray(q) ? await Promise.all(q.map(answer)) : await answer(q))); }
    catch (_) { res.statusCode = 400; res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const rpc = 'http://127.0.0.1:' + server.address().port;
  check('RPC proxy up (read-only methods only)', allow.size === 7 && server.address().port > 0);

  async function makeEscrow(label) {
    const cid = ethers.zeroPadValue(ethers.toBeHex(7000 + Math.floor(Math.random() * 900)), 32);
    const deliverablePayload = JSON.stringify({
      deliverable: 'f3c-' + label, format: 'application/json',
      fields: { sha256: 'true', units: 'exact' }, value: 'the-digital-deliverable',
    });
    const deliverableHash = '0x' + crypto.createHash('sha256').update(deliverablePayload, 'utf8').digest('hex');
    const m = {
      commitmentId: cid, buyerAgentId: buyer.address, sellerAgentId: seller.address,
      capability: 'f3c-' + label, price: { amount: '1000', currency: 'USDC', decimals: 6 }, acceptanceCriteria: { type: 'hash-equals', value: deliverableHash },
      deadline: iso(t + 1000), cancelCondition: 'signed-restricted-policy', manifestVersion: 4,
      terms: { schemaVersion: canonical.SCHEMA_VERSION, hashingVersion: canonical.HASHING_VERSION, signatureDomainVersion: canonical.SIGNATURE_DOMAIN_VERSION, policyId: '1', minReleaseTime: '0' },
      evaluator: evaluatorEOA.address, evaluatorPermittedDecisions: ['release', 'refund'],
      policy: { version: 'saax-custody-policy-v1', digest: policy, profilesDocVersion: 'transaction-profiles-v1', profilesDocDigest: '0x' + 'bc'.repeat(32) },
      profile: 'OBJECTIVE_DIGITAL', custody: { chainId: CHAIN, custodyAddress: custodyAddr, token: token.target, principal: '1000', fees: '0', reserve: '0', version: 3 },
      consents: { buyer: { accepted: true, ref: 'f3c-buyer' }, seller: { accepted: true, ref: 'f3c-seller' }, sellerTimeoutConsent: { acceptedBySeller: true, effect: 'refund to original buyer at/after cutoff' } },
      evidenceRequirements: { sources: ['synthetic'], submissionMechanism: 'hash-reference', minimumCount: 1, maxAge: 300, verdictRequired: true, acceptedIssuers: [seller.address], requiredTypes: ['deliverable-hash'] },
      deadlines: { delivery: iso(t + 500), resolution: iso(t + 1000), finalCutoff: iso(t + 2000) }, fallbackDisposition: { rule: 'refund-original-buyer-at-cutoff' },
    };
    const built = canonical.buildV4Manifest(m);
    m.signatureHex = built.signature.slice('COSE_Sign1:'.length);
    const digest = '0x' + built.manifestHash.slice(7);
    const authorizations = [];
    for (const [role, signer] of [['buyer', buyer], ['seller', seller]]) {
      const message = { manifestHash: digest, role, nonce: '1', expiresAt: String(t + 900) };
      authorizations.push({ role, walletType: 'EOA', nonce: message.nonce, expiresAt: message.expiresAt, signature: await signer.signTypedData(signatures.agreementDomain(custodyAddr, CHAIN), signatures.COMMITMENT_CONSENT_TYPES, message) });
    }
    const data = ethers.AbiCoder.defaultAbiCoder().encode(av.TYPES, [cid, digest, ...Array(10).fill(''), 'issued', BigInt(t)]);
    const req = { recipient: ethers.ZeroAddress, expirationTime: 0, revocable: false, refUID: ethers.ZeroHash, data, value: 0 };
    const attReceipt = await (await eas.connect(attester).attest({ schema: av.SCHEMA_UID, data: req })).wait();
    const attEvent = attReceipt.logs.map(l => { try { return eas.interface.parseLog(l); } catch (_) { return null; } }).find(l => l?.name === 'Attested');
    const anchor = { recordVersion: 1, chainId: CHAIN, easAddress: eas.target, schemaUid: av.SCHEMA_UID, uid: attEvent.args.uid, txHash: attReceipt.hash, blockHash: attReceipt.blockHash, blockNumber: String(attReceipt.blockNumber), attester: attester.address, recipient: req.recipient, attestationData: data, authorizations: [] };
    for (const [role, signer] of [['buyer', buyer], ['seller', seller]]) {
      const expiresAt = String(t + 900);
      anchor.authorizations.push({ role, expiresAt, signature: await signer.signTypedData(av.domain(anchor), av.AUTH_TYPES, av.message(anchor, m, digest, expiresAt)) });
    }
    const funding = await (await custody.connect(buyer).fund(cid, digest, token.target, buyer.address, seller.address, evaluatorEOA.address, 1000, t + 1000, t + 2000, 0, 1, policy, digest)).wait();
    return { cid, m, digest, built, authorizations, anchor, funding, deliverablePayload, deliverableHash };
  }

  async function journalFor(cid, digest, funding) {
    const jw = journalWriter.createJournalWriter({ chainId: CHAIN, custodyAddress: custodyAddr, commitmentId: cid, manifestHash: digest });
    await jw.append({ transition: 'issue', role: 'buyer', by: buyer.address, contractAction: 'sign-agreement', resultingState: 'Issued', at: new Date((t - 5) * 1000).toISOString(), signerWallets: [buyer] });
    await jw.append({ transition: 'funded', role: 'buyer', by: buyer.address, contractAction: 'fund', resultingState: 'Funded', at: new Date(t * 1000).toISOString(), signerWallets: [buyer], txHash: funding.hash, blockHash: funding.blockHash });
    return jw;
  }
  async function evidenceFor({ deliverablePayload, deliverableHash, cid, digest }) {
    const msg = {
      recordVersion: 1, commitmentId: cid, manifestHash: digest,
      criterionId: 'deliverable-hash', itemId: 'f3c-item', type: 'deliverable-hash',
      issuer: seller.address, payloadHash: deliverableHash, at: new Date(t * 1000).toISOString(), amount: '0',
    };
    const s = ethers.Signature.from(await seller.signTypedData(signatures.evidenceDomain(custodyAddr, CHAIN), signatures.EVIDENCE_ITEM_TYPES, msg));
    return {
      recordVersion: 1, time: new Date(t * 1000).toISOString(), commitmentId: cid, manifestHash: digest,
      domain: signatures.evidenceDomain(custodyAddr, CHAIN),
      items: [{ itemId: 'f3c-item', criterionId: 'deliverable-hash', type: 'deliverable-hash', issuer: seller.address, payloadHash: deliverableHash, payload: deliverablePayload, at: new Date(t * 1000).toISOString(), amount: '0', signedBy: seller.address, sigs: [{ v: s.v, r: s.r, s: s.s }] }],
      findings: {},
    };
  }
  // Nonfulfillment evidence: a seller-signed item whose payload does NOT match
  // the signed acceptance criterion (hash differs) — the Phase C verifier
  // reports criterion: not-satisfied as a legitimate finding, and the
  // evaluator's refund verdict stays consistent with the signed policy.
  async function nonfulfillmentEvidenceFor({ cid, digest }) {
    const badPayload = JSON.stringify({ deliverable: 'f3c-nonfulfillment', value: 'not-delivered' });
    const badHash = '0x' + crypto.createHash('sha256').update(badPayload, 'utf8').digest('hex');
    const msg = {
      recordVersion: 1, commitmentId: cid, manifestHash: digest,
      criterionId: 'deliverable-hash', itemId: 'f3c-nonfulfillment', type: 'deliverable-hash',
      issuer: seller.address, payloadHash: badHash, at: new Date(t * 1000).toISOString(), amount: '0',
    };
    const s = ethers.Signature.from(await seller.signTypedData(signatures.evidenceDomain(custodyAddr, CHAIN), signatures.EVIDENCE_ITEM_TYPES, msg));
    return {
      recordVersion: 1, time: new Date(t * 1000).toISOString(), commitmentId: cid, manifestHash: digest,
      domain: signatures.evidenceDomain(custodyAddr, CHAIN),
      items: [{ itemId: 'f3c-nonfulfillment', criterionId: 'deliverable-hash', type: 'deliverable-hash', issuer: seller.address, payloadHash: badHash, payload: badPayload, at: new Date(t * 1000).toISOString(), amount: '0', signedBy: seller.address, sigs: [{ v: s.v, r: s.r, s: s.s }] }],
      findings: {},
    };
  }

  async function settleAndFinalize(base) {
    const fn = custody.connect(stranger)[base.contractAction];
    if (typeof fn !== 'function') throw new Error('unknown contract action: ' + base.contractAction);
    const settlement = await (await fn(...base.settleArgs, { gasLimit: 1000000 })).wait();
    // Mutual transitions carry BOTH parties' signatures on the journal entry
    // (per the shared writer's 'buyer+seller' role rule); evaluator/timeout
    // entries carry the writer attestation key (deployer) only.
    const journalSigners = base.role === 'buyer+seller' ? [buyer, seller] : [deployer];
    await base.jw.append({ transition: base.transition, role: base.role, by: base.by, contractAction: base.contractAction, resultingState: base.resultingState, at: new Date((t + 1) * 1000).toISOString(), signerWallets: journalSigners, txHash: settlement.hash, blockHash: settlement.blockHash, authorization: base.authorization });
    const exp = {
      formatVersion: 4, agreement: base.m, commitmentDigest: base.built.manifestHash, authorizations: base.authorizations,
      lifecycleProfile: 'full', lifecycle: { funding: ref(base.funding), settlement: ref(settlement) },
      finality: { mode: 'local-synthetic' }, anchor: base.anchor, journal: base.jw.snapshot(),
      ...(base.evidence ? { evidence: base.evidence } : {}),
    };
    return { exp, settlement };
  }

  async function runOutcome(name, exp, opts) {
    const file = path.join(OUT, name + '.json');
    fs.writeFileSync(file, JSON.stringify(exp, null, 2) + '\n');
    const result = await child(file, rpc);
    fs.writeFileSync(path.join(OUT, 'separate-process-' + name + '.txt'), result.text + '\nEXIT_CODE=' + result.code + '\n');
    const okCode = result.code === 0;
    const okVerdict = /VERDICT: VERIFIED_WITH_LIMITATIONS/.test(result.text);
    check('separate-process ' + name + ': exit 0 + VERIFIED_WITH_LIMITATIONS', okCode && okVerdict, result.text.match(/VERDICT: [^\n]+/)?.[0] || ('exit=' + result.code));
    if (opts.needCheckpoint) {
      const escrow = await custody.getEscrow(exp.agreement.commitmentId);
      const head = escrow[10];
      check('on-chain V3 ' + name + ': committedHead recorded', head !== ethers.ZeroHash, String(head).slice(0, 18));
      if (head !== ethers.ZeroHash && exp.journal) {
        const last = exp.journal.events[exp.journal.events.length - 1];
        const ok = !!last.prevHash && String(last.prevHash).toLowerCase() === String(head).toLowerCase();
        check('on-chain V3 ' + name + ': journal prefix tail == committedHead', ok, (last.prevHash || '').slice(0, 18) + ' vs ' + String(head).slice(0, 18));
      }
    } else if (opts.needHeadless) {
      const escrow = await custody.getEscrow(exp.agreement.commitmentId);
      check('on-chain V3 ' + name + ': committedHead zero (headless)', escrow[10] === ethers.ZeroHash, String(escrow[10]).slice(0, 18));
    }
  }

  // ---- A. Fulfilled release (evaluator, head-bound) ----
  {
    const es = await makeEscrow('release');
    const jw = await journalFor(es.cid, es.digest, es.funding);
    const head = jw.snapshot().tailHash;
    const sig = helpers.rawSign(ethers, 3, v3sig.v3VerdictDigest(ethers, custodyAddr, CHAIN, es.cid, es.digest, 'release', 11, t, head));
    const base = { ...es, jw, transition: 'release', role: 'evaluator', by: evaluatorEOA.address, contractAction: 'release', resultingState: 'Released',
      settleArgs: [es.cid, es.digest, head, 11, t, sig.v, sig.r, sig.s, '0x'],
      authorization: { kind: 'evaluator-verdict', agreedEvaluator: evaluatorEOA.address, chainId: CHAIN, custody: custodyAddr, note: 'EOA evaluator verdict bound to the frozen journal head; journal attests the record, not the authorization' },
      evidence: await evidenceFor(es) };
    const { exp } = await settleAndFinalize(base);
    await runOutcome('release', exp, { needCheckpoint: true });
  }

  // ---- B. Affirmative nonfulfillment: evaluator refund (refundVerdict) ----
  {
    const es = await makeEscrow('refund');
    const jw = await journalFor(es.cid, es.digest, es.funding);
    const head = jw.snapshot().tailHash;
    const sig = helpers.rawSign(ethers, 3, v3sig.v3VerdictDigest(ethers, custodyAddr, CHAIN, es.cid, es.digest, 'refund', 12, t, head));
    const base = { ...es, jw, transition: 'refund', role: 'evaluator', by: evaluatorEOA.address, contractAction: 'refundVerdict', resultingState: 'Refunded',
      settleArgs: [es.cid, es.digest, head, 12, t, sig.v, sig.r, sig.s, '0x'],
      authorization: { kind: 'evaluator-verdict', agreedEvaluator: evaluatorEOA.address, chainId: CHAIN, custody: custodyAddr, note: 'EOA evaluator verdict bound to the frozen journal head; journal attests the record, not the authorization' } };
    const { exp } = await settleAndFinalize({ ...base, evidence: await nonfulfillmentEvidenceFor(es) });
    await runOutcome('refund', exp, { needCheckpoint: true });
  }

  // ---- C. Mutual settlement — BOTH directions ----
  for (const [mName, action, nonce] of [['mutual-release', 'release', 13], ['mutual-refund', 'refund', 14]]) {
    const es = await makeEscrow(mName);
    const jw = await journalFor(es.cid, es.digest, es.funding);
    const head = jw.snapshot().tailHash;
    const d = v3sig.v3MutualDigest(ethers, custodyAddr, CHAIN, es.cid, es.digest, action, nonce, t, head);
    // Sign with the ACTUAL party wallets (derived from the funded escrow's
    // buyer/seller identities), never by remembered Hardhat index.
    const bSig = ethers.Signature.from(await buyer.signTypedData(v3sig.v3Domain(CHAIN, custodyAddr), v3sig.MUTUAL_TYPES, { commitmentId: es.cid, commitmentDigest: es.digest, action, nonce, issuedAt: t, preSettlementHead: head }));
    const sSig = ethers.Signature.from(await seller.signTypedData(v3sig.v3Domain(CHAIN, custodyAddr), v3sig.MUTUAL_TYPES, { commitmentId: es.cid, commitmentDigest: es.digest, action, nonce, issuedAt: t, preSettlementHead: head }));
    const fn = mName === 'mutual-release' ? 'mutualRelease' : 'mutualRefund';
    // mutualRelease(id,digest,head,nonce,issuedAt,bv,br,bs,sv,sr,ss)
    const settleArgs = [es.cid, es.digest, head, nonce, t, bSig.v, bSig.r, bSig.s, sSig.v, sSig.r, sSig.s];
    const base = { ...es, jw, transition: mName, role: 'buyer+seller', by: buyer.address, contractAction: fn,
      resultingState: action === 'release' ? 'Released' : 'Refunded', settleArgs,
      authorization: { kind: 'mutual-consent', note: 'both parties signed the mutual resolution' },
      evidence: action === 'release' ? await evidenceFor(es) : undefined };
    const { exp } = await settleAndFinalize(action === 'release' ? base : { ...base, evidence: await nonfulfillmentEvidenceFor(es) });
    await runOutcome(mName, exp, { needCheckpoint: true });
  }

  // ---- D. Disputed resolution — BOTH directions ----
  for (const [dName, resolution, nonce] of [['resolve-release', 'release', 15], ['resolve-refund', 'refund', 16]]) {
    const es = await makeEscrow(dName);
    const jw = await journalFor(es.cid, es.digest, es.funding);
    const disputeTx = await (await custody.connect(buyer).raiseDispute(es.cid, es.digest, 'f3c-dispute')).wait();
    await jw.append({ transition: 'dispute', role: 'buyer', by: buyer.address, contractAction: 'raiseDispute', resultingState: 'Disputed', at: new Date((t + 0.5) * 1000).toISOString(), signerWallets: [buyer], txHash: disputeTx.hash, blockHash: disputeTx.blockHash });
    const head = jw.snapshot().tailHash;
    // The contract's resolve path signs "resolve:<resolution>" (design keeps
    // the disputed-resolution verdict distinct from a bare release/refund).
    const d = v3sig.v3VerdictDigest(ethers, custodyAddr, CHAIN, es.cid, es.digest, 'resolve:' + resolution, nonce, t, head);
    const sig = helpers.rawSign(ethers, 3, d);
    // resolve(id,digest,resolution,head,nonce,issuedAt,v,r,s,sigBytes)
    const settleArgs = [es.cid, es.digest, resolution, head, nonce, t, sig.v, sig.r, sig.s, '0x'];
    const base = { ...es, jw, transition: resolution, role: 'evaluator', by: evaluatorEOA.address, contractAction: 'resolve',
      resultingState: resolution === 'release' ? 'Released' : 'Refunded', settleArgs,
      authorization: { kind: 'evaluator-verdict', agreedEvaluator: evaluatorEOA.address, chainId: CHAIN, custody: custodyAddr, note: 'dispute resolved under EOA evaluator verdict bound to the frozen journal head; journal attests the record, not the authorization' },
      evidence: resolution === 'release' ? await evidenceFor(es) : undefined };
    const { exp } = await settleAndFinalize(resolution === 'release' ? base : { ...base, evidence: await nonfulfillmentEvidenceFor(es) });
    await runOutcome(dName, exp, { needCheckpoint: true });
  }

  // ---- E. Headless timeout (refundTimeout) ----
  {
    const es = await makeEscrow('timeout');
    const jw = await journalFor(es.cid, es.digest, es.funding);
    await hre.network.provider.send('evm_increaseTime', [3000]);
    await hre.network.provider.send('evm_mine', []);
    const settle = await (await custody.connect(stranger).refundTimeout(es.cid, es.digest, { gasLimit: 1000000 })).wait();
    await jw.append({ transition: 'timeout-refund', role: 'open', by: buyer.address, contractAction: 'refundTimeout', resultingState: 'Refunded', at: new Date((t + 2600) * 1000).toISOString(), signerWallets: [deployer], txHash: settle.hash, blockHash: settle.blockHash, authorization: { kind: 'timeout-rule', note: 'headless timeout: permissionless, fixed beneficiary' } });
    const exp = { formatVersion: 4, agreement: es.m, commitmentDigest: es.built.manifestHash, authorizations: es.authorizations, lifecycleProfile: 'full', lifecycle: { funding: ref(es.funding), settlement: ref(settle) }, finality: { mode: 'local-synthetic' }, anchor: es.anchor, journal: jw.snapshot(), evidence: await nonfulfillmentEvidenceFor(es) };
    await runOutcome('timeout', exp, { needHeadless: true });
  }

  fs.writeFileSync(path.join(OUT, 'run-record.json'), JSON.stringify({
    command: 'node scripts/_f3c-v4-export-producer.cjs', revision, chainId: CHAIN,
    easPackage: require('@ethereum-attestation-service/eas-contracts/package.json').version,
    safePackage: require('@safe-global/safe-contracts/package.json').version,
    ethersVersion: require('ethers').version,
    network: 'in-process local EVM (NOT public Base Sepolia)', noPublicFinality: true,
    outcomes: ['release', 'refund', 'mutual-release', 'mutual-refund', 'resolve-release', 'resolve-refund', 'timeout'],
    outputs: fs.readdirSync(OUT).filter(f => /\.(json|txt)$/.test(f)),
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ results, passed, failed, revision, chainId: CHAIN }, null, 2) + '\n');
  console.log('f3c_v4_export_passed=' + passed + ' failed=' + failed);
  await new Promise(r => server.close(r));
  provider.destroy();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });