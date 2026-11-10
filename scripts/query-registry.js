// SAAX Protocol — Day 1: ERC-8004 Identity Registry query layer (Base mainnet)
// Reads agent identities via tokenURI(uint256) + ownerOf(uint256), resolves
// registration files (https, ipfs, data: URIs), outputs normalized agent records.
// READ-ONLY on-chain; no wallet, no writes, no settlement.
const { JsonRpcProvider, Contract, getBytes } = require('ethers');
const fs = require('fs');

const RPC = process.env.SAAX_RPC_URL || 'https://mainnet.base.org';
const IDENTITY_REGISTRY = process.env.SAAX_IDENTITY_REGISTRY || '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const MSAAX_PROBE = parseInt(process.env.SAAX_MSAAX_PROBE || '120', 10); // probe window for sequential enumeration

function log(...a) { console.log(...a); }

// Resolve any registration URI to a JSON document (read-only, no platform automation)
async function resolveUri(uri) {
  if (!uri) return null;
  if (uri.startsWith('data:')) {
    const m = uri.match(/^data:application\/json;base64,(.+)$/);
    if (!m) return null;
    try { return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')); } catch { return null; }
  }
  if (uri.startsWith('ipfs://')) {
    const hash = uri.replace('ipfs://', '');
    const urls = [
      `https://ipfs.io/ipfs/${hash}`,
      `https://cloudflare-ipfs.com/ipfs/${hash}`,
      `https://dweb.link/ipfs/${hash}`,
    ];
    for (const u of urls) {
      try {
        const r = await fetch(u, { method: 'GET' });
        if (r.ok) return await r.json();
      } catch { /* try next gateway */ }
    }
    return null;
  }
  if (/^https?:\/\//.test(uri)) {
    try {
      const r = await fetch(uri, { method: 'GET' });
      if (r.ok) {
        const t = await r.text();
        try { return JSON.parse(t); } catch { return null; }
      }
    } catch { return null; }
  }
  return null;
}

async function main() {
  log(`SAAX Protocol — Day 1 Registry Query Foundation`);
  log(`RPC: ${RPC}`);
  log(`IdentityRegistry: ${IDENTITY_REGISTRY}`);
  log(`Probe window: 0..${MSAAX_PROBE - 1}`);

  const provider = new JsonRpcProvider(RPC);
  const abi = JSON.parse(fs.readFileSync(__dirname + '/../abis/IdentityRegistry.json', 'utf8'));
  const reg = new Contract(IDENTITY_REGISTRY, abi, provider);

  const chainId = await provider.send('eth_chainId', []);
  log(`chainId: ${chainId} (expected 0x2105 = Base mainnet)`);
  if (chainId !== '0x2105') { throw new Error(`unexpected chain ${chainId}`); }

  // Sequential probe for live agents
  const agents = [];
  let reverts = 0;
  for (let id = 0; id < MSAAX_PROBE; id++) {
    let uri, owner;
    try { uri = await reg.tokenURI(id); } catch (e) { reverts++; continue; }
    try { owner = await reg.ownerOf(id); } catch (e) { owner = null; }
    if (!uri) { reverts++; continue; }
    agents.push({ agentId: id, uri: String(uri), owner: owner ? String(owner) : null });
  }
  log(`Probed ${MSAAX_PROBE} ids; found ${agents.length} live agents (${reverts} reverts/skips)`);

  // Resolve registration files
  const resolved = [];
  for (const a of agents) {
    const doc = await resolveUri(a.uri);
    const rec = {
      agent_id: a.agentId,
      owner: a.owner,
      token_uri: a.uri.slice(0, 200),
      name: doc && doc.name ? String(doc.name) : null,
      description: doc && doc.description ? String(doc.description) : null,
      services: doc && doc.services ? doc.services : [],
      supported_trust: doc && doc.trust ? doc.trust : null,
      active: true,
    };
    resolved.push(rec);
    log(`[${a.agentId}] ${rec.name || '(unnamed)'} <- ${a.uri.slice(0, 50)}`);
  }

  fs.writeFileSync(__dirname + '/../data/agents-day1.json', JSON.stringify(resolved, null, 2));
  log(`Saved ${resolved.length} resolved agents to data/agents-day1.json`);
  log(`DONE`);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });