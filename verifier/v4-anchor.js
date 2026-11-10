'use strict';
// Isolated v4 anchor extension. No application imports, DB or export-owned trust roots.
const { ethers } = require('ethers');
const easArtifact = require('@ethereum-attestation-service/eas-contracts/artifacts/contracts/EAS.sol/EAS.json');
const registryArtifact = require('@ethereum-attestation-service/eas-contracts/artifacts/contracts/SchemaRegistry.sol/SchemaRegistry.json');
const policyFile = require('./v4-eas-policy.json');
// Chain-scoped EAS policy selection. `policyFile` is { default, policies }.
// The 84532 entry is the historical local-evidence era policy; 31337 is an
// explicitly LOCAL-TEST-ONLY entry for the distinct local EVM chain. Public
// deployment restrictions are unchanged: any chain without a pinned policy
// entry (including every public chain) is unsupported.
const policy = chainId => {
  const p = policyFile.policies && policyFile.policies[String(chainId)];
  if (!p) throw new AnchorIncomplete('unsupported EAS deployment (no pinned policy for chain ' + chainId + ')');
  return p;
};
const SCHEMA = 'string commitmentId,string commitmentDigest,string parties,string requestedOutcome,string providerObligation,string commercialTerms,string paymentTerms,string acceptanceCriteria,string deadline,string failureConditions,string recoveryPolicy,string refundsCompensation,string lifecycleState,uint64 anchoredAt';
const TYPES = [...Array(13).fill('string'), 'uint64'];
const SCHEMA_UID = ethers.solidityPackedKeccak256(['string', 'address', 'bool'], [SCHEMA, ethers.ZeroAddress, false]);
const AUTH_TYPES = { AnchorAuthorization: [
  { name: 'manifestHash', type: 'bytes32' }, { name: 'commitmentId', type: 'bytes32' },
  { name: 'schema', type: 'bytes32' }, { name: 'attester', type: 'address' },
  { name: 'recipient', type: 'address' }, { name: 'dataHash', type: 'bytes32' },
  { name: 'expiresAt', type: 'uint64' }
] };
class AnchorIncomplete extends Error {}
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const need = (ok, why) => { if (!ok) throw new Error('anchor: ' + why); };
const domain = a => ({ name: 'SAAX V4 Anchor Authorization', version: '1', chainId: a.chainId, verifyingContract: a.easAddress });
function message(a, m, digest32, expiresAt) {
  return { manifestHash: digest32, commitmentId: m.commitmentId, schema: a.schemaUid, attester: a.attester, recipient: a.recipient, dataHash: ethers.keccak256(a.attestationData), expiresAt };
}
async function verifyAnchor(exp, provider, digest32, execution) {
  const a = exp.anchor, m = exp.agreement;
  if (!a) throw new AnchorIncomplete('anchor record required');
  for (const k of ['chainId', 'easAddress', 'schemaUid', 'uid', 'txHash', 'blockHash', 'blockNumber', 'attester', 'recipient', 'attestationData', 'authorizations']) {
    if (a[k] == null) throw new AnchorIncomplete('anchor missing ' + k);
  }
  if (a.recordVersion !== 1) throw new AnchorIncomplete('unsupported anchor record version');
  need(a.chainId === m.custody.chainId, 'signed agreement chain mismatch');
  const pol = policy(a.chainId);
  if (!eq(a.easAddress, pol.easAddress)) throw new AnchorIncomplete('unsupported EAS deployment');
  need(exp.finality?.mode === 'local-synthetic', 'only local-synthetic EAS policy supported');
  need(Number((await provider.getNetwork()).chainId) === a.chainId, 'RPC chain mismatch');
  if (!eq(a.schemaUid, SCHEMA_UID)) throw new AnchorIncomplete('unsupported anchor schema');
  for (const k of ['uid', 'txHash', 'blockHash']) need(ethers.isHexString(a[k], 32), 'invalid ' + k);
  need(typeof a.blockNumber === 'string' && /^(0|[1-9][0-9]*)$/.test(a.blockNumber), 'blockNumber must be decimal string');
  need(ethers.isAddress(a.attester) && a.attester !== ethers.ZeroAddress && ethers.isAddress(a.recipient), 'invalid attester/recipient');
  need(ethers.isHexString(a.attestationData) && a.attestationData !== '0x', 'missing encoded data');
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const decoded = coder.decode(TYPES, a.attestationData);
  need(eq(coder.encode(TYPES, decoded), a.attestationData), 'noncanonical ABI data');
  need(decoded[0] === m.commitmentId && decoded[1] === digest32, 'commitment/digest binding mismatch');
  // Remaining legacy descriptive fields have NO invented v4 mapping. Both parties
  // authorize the exact bytes below, not their truth or fulfillment meaning.
  const receipt = await provider.send('eth_getTransactionReceipt', [a.txHash]);
  const tx = await provider.send('eth_getTransactionByHash', [a.txHash]);
  if (!receipt || !tx) throw new AnchorIncomplete('anchor transaction/receipt unavailable');
  need(receipt.status === '0x1', 'transaction reverted');
  const block = await provider.send('eth_getBlockByNumber', [receipt.blockNumber, false]);
  if (!block) throw new AnchorIncomplete('anchor block unavailable');
  need(eq(receipt.transactionHash, a.txHash) && eq(tx.hash, a.txHash) && eq(block.hash, a.blockHash) && eq(receipt.blockHash, block.hash) && eq(tx.blockHash, block.hash) && BigInt(receipt.blockNumber) === BigInt(a.blockNumber), 'noncanonical references');
  need(tx.transactionIndex === receipt.transactionIndex && eq(block.transactions[Number(BigInt(tx.transactionIndex))], tx.hash), 'transaction position mismatch');
  need(eq(tx.to, pol.easAddress) && eq(receipt.to, pol.easAddress) && eq(tx.from, a.attester), 'direct EAS attester/target mismatch');
  const tag = receipt.blockNumber;
  const latest = await provider.send('eth_getBlockByNumber', ['latest', false]);
  if (!latest) throw new AnchorIncomplete('current evaluation block unavailable');
  const eas = new ethers.Contract(pol.easAddress, easArtifact.abi, provider);
  const registry = new ethers.Contract(pol.registryAddress, registryArtifact.abi, provider);
  for (const at of [tag, latest.number]) {
    const code = await provider.send('eth_getCode', [pol.easAddress, at]);
    const regCode = await provider.send('eth_getCode', [pol.registryAddress, at]);
    if (!eq(ethers.keccak256(code), pol.runtimeCodeHash) || !eq(ethers.keccak256(regCode), pol.registryRuntimeCodeHash)) throw new AnchorIncomplete('unsupported EAS/registry runtime');
    need(eq(await eas.getSchemaRegistry({ blockTag: at }), pol.registryAddress), 'registry mismatch');
    const schema = await registry.getSchema(SCHEMA_UID, { blockTag: at });
    need(eq(schema.uid, SCHEMA_UID) && schema.schema === SCHEMA && schema.resolver === ethers.ZeroAddress && !schema.revocable, 'schema registration mismatch');
  }
  const iface = new ethers.Interface(easArtifact.abi);
  const call = iface.parseTransaction({ data: tx.input, value: tx.value });
  need(call?.name === 'attest', 'only direct single attest supported');
  const request = call.args[0];
  need(eq(request.schema, a.schemaUid) && eq(request.data.data, a.attestationData) && eq(request.data.recipient, a.recipient) && request.data.expirationTime === 0n && !request.data.revocable && request.data.refUID === ethers.ZeroHash && request.data.value === 0n && BigInt(tx.value) === 0n, 'attest calldata/policy mismatch');
  const logs = receipt.logs.filter(l => eq(l.address, pol.easAddress)).map(l => { try { return iface.parseLog(l); } catch (_) { return null; } }).filter(l => l?.name === 'Attested' && eq(l.args.uid, a.uid));
  need(logs.length === 1 && eq(logs[0].args.schemaUID, a.schemaUid) && eq(logs[0].args.attester, a.attester) && eq(logs[0].args.recipient, a.recipient), 'matching EAS event required');
  for (const at of [tag, latest.number]) {
    const att = await eas.getAttestation(a.uid, { blockTag: at });
    if (att.uid === ethers.ZeroHash) throw new AnchorIncomplete('attestation record unavailable');
    need(eq(att.uid, a.uid) && eq(att.schema, a.schemaUid) && eq(att.attester, a.attester) && eq(att.recipient, a.recipient) && eq(att.data, a.attestationData), 'actual attestation mismatch');
    need(att.time === BigInt(block.timestamp) && decoded[13] <= att.time, 'attestation/payload time mismatch');
    need(att.expirationTime === 0n && att.revocationTime === 0n && !att.revocable && att.refUID === ethers.ZeroHash, 'immutable nonexpiring unreferenced schema policy required');
  }
  need(Array.isArray(a.authorizations) && a.authorizations.length === 2, 'two anchor authority signatures required');
  for (const role of ['buyer', 'seller']) {
    const auths = a.authorizations.filter(x => x.role === role);
    need(auths.length === 1, 'exact anchor role required');
    const auth = auths[0];
    need(typeof auth.expiresAt === 'string' && /^(0|[1-9][0-9]*)$/.test(auth.expiresAt) && BigInt(auth.expiresAt) >= BigInt(block.timestamp), 'anchor authority expired at issuance');
    need(eq(ethers.verifyTypedData(domain(a), AUTH_TYPES, message(a, m, digest32, auth.expiresAt), auth.signature), m[role + 'AgentId']), 'unauthenticated ' + role + ' anchor authority');
  }
  if (execution) need(BigInt(block.number) < BigInt(execution.block.number) || (block.number === execution.block.number && BigInt(tx.transactionIndex) < BigInt(execution.tx.transactionIndex)), 'anchor must precede settlement');
  return { policy: pol.policy, uid: a.uid, executionContext: execution ? 'anchor creation and before settlement; immutable state also checked at current block' : 'anchor creation and current immutable validity', creationBlock: a.blockNumber, currentBlock: String(BigInt(latest.number)), limitations: ['Local official EAS only, trusted RPC, no public-chain finality.', 'Exact descriptive bytes are party-authorized, not independently proven truthful or fulfilled.'] };
}
module.exports = { verifyAnchor, AnchorIncomplete, SCHEMA, SCHEMA_UID, TYPES, AUTH_TYPES, domain, message };
