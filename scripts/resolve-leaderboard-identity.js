// SAAX Protocol — Day 3: Resolve identity (URI + owner) for leaderboard supplier ids,
// then fetch their registration files (https URI) for name/description/services.
const { JsonRpcProvider, Contract } = require('ethers');
const fs = require('fs');

const RPC = process.env.SAAX_RPC_URL || 'https://base-rpc.publicnode.com';
const IDENTITY_REGISTRY = process.env.SAAX_IDENTITY_REGISTRY || '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const ids = [1380, 2290, 55985, 51085, 7522];

async function main() {
  const provider = new JsonRpcProvider(RPC);
  const idr = new Contract(IDENTITY_REGISTRY, JSON.parse(fs.readFileSync('abis/IdentityRegistry.json', 'utf8')), provider);
  const out = [];
  for (const id of ids) {
    try {
      const uri = await idr.tokenURI(id);
      let owner = null;
      try { owner = await idr.ownerOf(id); } catch (e) { /* owner may not exist for all */ }
      out.push({ id, uri, owner });
    } catch (e) {
      out.push({ id, error: String(e).slice(0, 120) });
    }
  }
  console.log(JSON.stringify(out, null, 1));
  fs.writeFileSync('data/leaderboard-identity-day3.json', JSON.stringify(out, null, 1));
  process.exit(0);
}
main().catch(e => { console.error('FATAL', String(e)); process.exit(1); });