#!/usr/bin/env node
'use strict';
// Read-only Base Sepolia V1 custody identity check. Run at the repository root:
//   node scripts/check-custody-identity.cjs [--address 0x...] [--rpc https://sepolia.base.org]
// No keys, transaction signing, deployment or repository writes. Requires the
// repository's pinned solc@0.8.26 and viem packages (npm ci before running).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const solc = require('solc');
const { keccak256, getAddress } = require('viem');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = 'contracts/SAAXEscrowCustodyV1.sol';
const ARTIFACT = 'data/escrow-custody-build.json';
const SOURCE_KEY = 'SAAXEscrowCustodyV1.sol'; // exactly scripts/_build-custody.cjs
const CONTRACT = 'SAAXEscrowCustodyV1';
const EXPECTED_CHAIN = 84532;
const DEFAULT_ADDRESS = '0x5a5472d751839cd4968cbf1b136baf862279ff5d'; // C5, see mainnet/mainnet-escrow-readiness.md §1.3
const DEFAULT_RPC = 'https://sepolia.base.org';
const DEPLOY_TX = '0xc7ebd72a34dc0ec4be065e24df5688a29ba61031cdc0b550f4eb59a184095c1e';
const VERSION = '0.8.26+commit.8a97fa7a';
// Git blob identities observed for these two files at revision 8e763985.
// Fail closed if the local checkout differs from the inspected inputs.
const SOURCE_BLOB = '195a455670791167e9ed67170749b8d2c304bd1f';
const ARTIFACT_BLOB = '76c2287a9a49e0f8a775aa9d6d286ca49b9a95af';
const hex = b => '0x' + b.toString('hex');
const sha256 = b => '0x' + crypto.createHash('sha256').update(b).digest('hex');
const gitBlob = b => crypto.createHash('sha1').update(Buffer.from(`blob ${b.length}\0`)).update(b).digest('hex');
const hash = b => keccak256(hex(b));
const assert = (ok, msg) => { if (!ok) throw new Error(msg); };
function bytes(s, label) {
  assert(typeof s === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(s), `${label}: invalid even-length hex`);
  return Buffer.from(s.slice(2), 'hex');
}
function opts(argv) {
  const a = { address: DEFAULT_ADDRESS, rpc: DEFAULT_RPC };
  for (let i = 0; i < argv.length; i += 2) {
    assert(['--address', '--rpc'].includes(argv[i]) && argv[i + 1], 'Usage: node scripts/check-custody-identity.cjs [--address 0x...] [--rpc https://...]');
    a[argv[i].slice(2)] = argv[i + 1];
  }
  a.address = getAddress(a.address);
  const u = new URL(a.rpc);
  assert(u.protocol === 'https:', 'RPC must be HTTPS');
  return a;
}

// Read the final TWO bytes as an unsigned big-endian length L. The preceding
// L bytes, and ONLY those bytes, must decode into one complete CBOR map.
// Runtime = executable [N-L-2] || CBOR [L] || length [2]. Never use a magic
// constant such as 0x33 or scan backward for a2/IPFS: both can occur in code.
function decodeCbor(buf) {
  let p = 0;
  function read(n) { assert(Number.isSafeInteger(n) && n >= 0 && p + n <= buf.length, 'CBOR truncated'); const b = buf.subarray(p, p + n); p += n; return b; }
  function uint(add) {
    if (add < 24) return add;
    if (add === 24) return read(1)[0];
    if (add === 25) return read(2).readUInt16BE(0);
    if (add === 26) return read(4).readUInt32BE(0);
    if (add === 27) { const n = read(8).readBigUInt64BE(0); assert(n <= BigInt(Number.MAX_SAFE_INTEGER), 'CBOR integer too large'); return Number(n); }
    throw new Error('CBOR indefinite/reserved additional information not supported');
  }
  function item(depth = 0) {
    assert(depth < 32, 'CBOR nesting too deep');
    const head = read(1)[0], major = head >> 5;
    if (major === 7 && head === 0xf4) return false;
    if (major === 7 && head === 0xf5) return true;
    const n = uint(head & 31);
    if (major === 0) return n;
    if (major === 1) return -1 - n;
    if (major === 2) return read(n);
    if (major === 3) { const b = read(n); const text = new TextDecoder('utf-8', { fatal: true }).decode(b); return text; }
    if (major === 4) return Array.from({ length: n }, () => item(depth + 1));
    if (major === 5) {
      const map = new Map();
      for (let i = 0; i < n; i++) { const k = item(depth + 1); assert(typeof k === 'string' && !map.has(k), 'CBOR map key invalid/duplicate'); map.set(k, item(depth + 1)); }
      return map;
    }
    throw new Error(`Unsupported CBOR major type ${major}`);
  }
  const value = item();
  assert(p === buf.length && value instanceof Map, 'CBOR must consume exactly one map');
  return value;
}
function base58(buf) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt('0x' + (buf.length ? buf.toString('hex') : '00')), s = '';
  while (n > 0n) { s = alphabet[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b !== 0) break; s = '1' + s; }
  return s;
}
function describe(code, label) {
  assert(code.length > 2, `${label}: empty/short runtime`);
  const L = code.readUInt16BE(code.length - 2);
  assert(L > 0 && L + 2 <= code.length, `${label}: impossible CBOR length ${L}`);
  const executable = code.subarray(0, code.length - L - 2);
  const metadata = code.subarray(code.length - L - 2, code.length - 2);
  const map = decodeCbor(metadata);
  const solcVersion = map.get('solc');
  const ipfs = map.get('ipfs');
  assert(Buffer.isBuffer(solcVersion) && solcVersion.length === 3, `${label}: solc must be 3 bytes`);
  assert(Buffer.isBuffer(ipfs) && ipfs.length > 0, `${label}: ipfs must be bytes`);
  return {
    label, fullBytes: code.length, executableBytes: executable.length, metadataBytes: L,
    trailerBytes: 2, arithmetic: `${executable.length} + ${L} + 2 = ${code.length}`,
    trailerHex: hex(code.subarray(code.length - 2)), metadataHex: hex(metadata),
    fullKeccak256: hash(code), fullSha256: sha256(code),
    executableKeccak256: hash(executable), executableSha256: sha256(executable),
    metadataKeccak256: hash(metadata), metadataSha256: sha256(metadata),
    cbor: Object.fromEntries([...map].map(([k, v]) => [k, Buffer.isBuffer(v) ? hex(v) : v])),
    solc: [...solcVersion].join('.'), ipfsMultihash: hex(ipfs), ipfsCidV0: base58(ipfs),
    _full: code, _executable: executable, _metadata: metadata,
  };
}
// The checked-in V1 artifact has creation bytecode only, not a separate
// deployedBytecode field. Its init program is the V1 builder's simple
// CODECOPY+RETURN prefix. Verify the exact prefix, offset and length BEFORE
// treating any creation subarray as runtime; reject unknown init-code shapes.
function extractArtifactRuntime(creation) {
  const match = creation.toString('hex').match(/^60808060405234601857465f5561([0-9a-f]{4})908161([0-9a-f]{4})8239f35b5f80fdfe/);
  assert(match, 'artifact creation init prefix unrecognized; cannot independently extract runtime');
  const runtimeBytes = parseInt(match[1], 16), offset = parseInt(match[2], 16);
  assert(offset === match[0].length / 2, `artifact CODECOPY offset ${offset} != prefix ${match[0].length / 2}`);
  assert(offset + runtimeBytes === creation.length, 'artifact creation size differs from init CODECOPY runtime extent');
  return { runtime: creation.subarray(offset), initBytes: offset, runtimeBytes };
}
function compile(source, explicitEvm) {
  const settings = { optimizer: { enabled: true, runs: 200 }, viaIR: true,
    outputSelection: { '*': { '*': ['evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences', 'evm.bytecode.linkReferences', 'metadata'] } } };
  if (explicitEvm) settings.evmVersion = explicitEvm;
  const input = { language: 'Solidity', sources: { [SOURCE_KEY]: { content: source } }, settings };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors || []).filter(e => e.severity === 'error');
  assert(!errors.length, errors.map(e => e.formattedMessage).join('\n'));
  const c = out.contracts?.[SOURCE_KEY]?.[CONTRACT];
  assert(c, 'compiled V1 contract missing');
  return { settings, input, metadata: JSON.parse(c.metadata),
    immutableReferences: c.evm.deployedBytecode.immutableReferences,
    linkReferences: c.evm.bytecode.linkReferences,
    creation: bytes('0x' + c.evm.bytecode.object, 'compiled creation'),
    runtime: bytes('0x' + c.evm.deployedBytecode.object, 'compiled runtime') };
}
async function rpc(url, method, params) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20000) });
  assert(response.ok, `RPC HTTP ${response.status} (${method})`);
  const data = await response.json();
  assert(!data.error && data.result !== undefined && data.result !== null, `RPC ${method}: ${JSON.stringify(data.error || data)}`);
  return data.result;
}
function compare(a, b) {
  return { full: a._full.equals(b._full), executable: a._executable.equals(b._executable),
    metadata: a._metadata.equals(b._metadata) };
}
function publicRow(d) {
  const { _full, _executable, _metadata, ...row } = d;
  return row;
}
async function main() {
  const { address, rpc: rpcUrl } = opts(process.argv.slice(2));
  const version = solc.version();
  assert(version.startsWith(VERSION), `expected pinned ${VERSION}, got ${version}`);
  // Compile the actual Git object, not a silently CRLF-converted checkout.
  // Record both forms: source line endings change Solidity metadata hashes.
  const sourceBytes = execFileSync('git', ['show', '8e763985:' + SOURCE], { cwd: ROOT });
  const artifactBytes = execFileSync('git', ['show', '8e763985:' + ARTIFACT], { cwd: ROOT });
  const checkoutSource = fs.readFileSync(path.join(ROOT, SOURCE));
  const checkoutArtifact = fs.readFileSync(path.join(ROOT, ARTIFACT));
  assert(gitBlob(sourceBytes) === SOURCE_BLOB, `source is not inspected 8e763985 blob ${SOURCE_BLOB}`);
  assert(gitBlob(artifactBytes) === ARTIFACT_BLOB, `artifact is not inspected 8e763985 blob ${ARTIFACT_BLOB}`);
  assert(checkoutSource.toString('utf8').replace(/\r\n/g, '\n') === sourceBytes.toString('utf8'), 'checkout source differs beyond Git line endings');
  assert(checkoutArtifact.toString('utf8').replace(/\r\n/g, '\n') === artifactBytes.toString('utf8'), 'checkout artifact differs beyond Git line endings');
  const source = sourceBytes.toString('utf8');
  const artifact = JSON.parse(artifactBytes.toString('utf8'));
  assert(artifact.source === SOURCE, `artifact source path mismatch: ${artifact.source}`);
  assert(artifact.abi?.find(e => e.type === 'constructor')?.inputs?.length === 0, 'V1 constructor is not zero-arg');
  assert(/constructor\s*\(\s*\)\s*\{\s*chainId\s*=\s*block\.chainid\s*;\s*\}/.test(source), 'source constructor changed: inspect before interpreting chainId');
  const artifactCreation = bytes(artifact.bytecode, 'artifact creation');
  const extracted = extractArtifactRuntime(artifactCreation);
  const defaultBuild = compile(source); // scripts/_build-custody.cjs omits evmVersion
  const cancunBuild = compile(source, 'cancun'); // explicit requested replay
  const crlfBuild = compile(source.replace(/\n/g, '\r\n'));
  const chainId = Number(BigInt(await rpc(rpcUrl, 'eth_chainId', [])));
  assert(chainId === EXPECTED_CHAIN, `wrong network: ${chainId}, expected ${EXPECTED_CHAIN}`);
  const blockTag = await rpc(rpcUrl, 'eth_blockNumber', []);
  const onchain = bytes(await rpc(rpcUrl, 'eth_getCode', [address, blockTag]), 'eth_getCode');
  const deployTx = await rpc(rpcUrl, 'eth_getTransactionByHash', [DEPLOY_TX]);
  const deployReceipt = await rpc(rpcUrl, 'eth_getTransactionReceipt', [DEPLOY_TX]);
  const reads = {
    chainIdCall: await rpc(rpcUrl, 'eth_call', [{ to: address, data: '0x' + keccak256(hex(Buffer.from('chainId()'))).slice(2, 10) }, blockTag]),
    chainIdSlot0: await rpc(rpcUrl, 'eth_getStorageAt', [address, '0x0', blockTag]),
  };
  assert(onchain.length > 0, `no contract code at ${address} at ${blockTag}`);
  const expectedChain = BigInt(EXPECTED_CHAIN);
  const storedChain = BigInt(reads.chainIdCall), slotChain = BigInt(reads.chainIdSlot0);
  const rows = [describe(onchain, 'onchain'), describe(extracted.runtime, 'artifact runtime'),
    describe(defaultBuild.runtime, 'recompiled default EVM (artifact builder)'),
    describe(cancunBuild.runtime, 'recompiled explicit cancun'),
    describe(crlfBuild.runtime, 'recompiled CRLF source default EVM')];
  const [live, art, def, can, crlf] = rows;
  const comparisons = {
    'onchain_vs_artifact': compare(live, art),
    'onchain_vs_recompiled_default': compare(live, def),
    'onchain_vs_recompiled_cancun': compare(live, can),
    'artifact_vs_recompiled_default': compare(art, def),
    'artifact_vs_recompiled_cancun': compare(art, can),
    'recompiled_default_vs_cancun': compare(def, can),
    'onchain_vs_recompiled_crlf': compare(live, crlf),
    creationArtifactVsDefault: artifactCreation.equals(defaultBuild.creation),
    creationArtifactVsCancun: artifactCreation.equals(cancunBuild.creation),
    creationArtifactVsCrlf: artifactCreation.equals(crlfBuild.creation),
    deploymentInputEqualsArtifactCreation: String(deployTx.input).toLowerCase() === hex(artifactCreation),
    deploymentReceiptSuccessAndAddress: deployReceipt.status === '0x1' && String(deployReceipt.contractAddress).toLowerCase() === address.toLowerCase(),
    constructorChainIdMatchesRpcAndSlot0: storedChain === expectedChain && slotChain === expectedChain,
  };
  const result = {
    source: { repository: 'bryantrudy24/solvent-applied-saax-protocol', inspectedRevision: '8e763985',
      path: SOURCE, gitBlobSha1: SOURCE_BLOB, sha256: sha256(sourceBytes), compiler: version,
      artifact: ARTIFACT, artifactGitBlobSha1: ARTIFACT_BLOB, artifactCompiledAt: artifact.compiledAt,
      sourceKey: SOURCE_KEY, builderSettings: defaultBuild.settings, explicitCancunSettings: cancunBuild.settings,
      checkoutSha256: sha256(checkoutSource), canonicalLineEndings: 'LF Git blob',
      libraries: defaultBuild.linkReferences, immutableInputs: defaultBuild.immutableReferences,
      metadataSettings: defaultBuild.metadata.settings.metadata,
      actualEvmVersion: defaultBuild.metadata.settings.evmVersion,
      constructorArgs: 0, chainIdSource: 'block.chainid assigned to storage slot 0 (not immutable)' },
    chain: { rpc: rpcUrl, chainId, blockTag, address, chainIdCall: reads.chainIdCall,
      chainIdSlot0: reads.chainIdSlot0, runtimeHex: hex(onchain), deployment: {
        transactionHash: DEPLOY_TX, blockNumber: Number(BigInt(deployReceipt.blockNumber)),
        blockHash: deployReceipt.blockHash, deployer: deployTx.from,
        contractAddress: deployReceipt.contractAddress, status: deployReceipt.status,
        constructorArgumentsHex: '0x'
      } },
    artifactCreation: { bytes: artifactCreation.length, sha256: sha256(artifactCreation), keccak256: hash(artifactCreation),
      initBytes: extracted.initBytes, extractedRuntimeBytes: extracted.runtimeBytes,
      arithmetic: `${extracted.initBytes} + ${extracted.runtimeBytes} = ${artifactCreation.length}` },
    recompiledCreation: {
      default: { bytes: defaultBuild.creation.length, sha256: sha256(defaultBuild.creation), keccak256: hash(defaultBuild.creation) },
      cancun: { bytes: cancunBuild.creation.length, sha256: sha256(cancunBuild.creation), keccak256: hash(cancunBuild.creation) },
    },
    compiledMetadata: defaultBuild.metadata,
    runtimes: rows.map(publicRow), comparisons,
  };
  console.log(JSON.stringify(result, null, 2));
  // Mismatch is a finding, not silently promoted to identity. Explicit
  // cancun full-code match is shown separately; builder's omitted evmVersion
  // may give different metadata despite identical executable instructions.
  if (!comparisons.onchain_vs_artifact.full || !comparisons.artifact_vs_recompiled_default.full ||
      !comparisons.creationArtifactVsDefault || !comparisons.deploymentInputEqualsArtifactCreation ||
      !comparisons.deploymentReceiptSuccessAndAddress || !comparisons.constructorChainIdMatchesRpcAndSlot0) {
    process.exitCode = 1;
  }
}
module.exports = { decodeCbor, describe, extractArtifactRuntime, compile, compare };
if (require.main === module) main().catch(e => { console.error('IDENTITY CHECK INCOMPLETE: ' + (e.stack || e)); process.exitCode = 2; });
