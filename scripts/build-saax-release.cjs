'use strict';
// Build an isolated complete SAAX deployment package from the verified Git tree.
// Runtime/config bytes are taken from production base71183c7b, never dirty files.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const RELEASE = path.join(ROOT, '.output', 'deployment-package');
const BASE = '71183c7b';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const excluded = [ /(^|\/)node_modules\//, /(^|\/)\.env(?:[./]|$)/, /(^|\/)\.output/, /(^|\/)\.vercel\//,
  /(^|\/)workshop\//, /(^|\/)daily-logs\//, /(^|\/)evidence\//, /(^|\/)tests\//,
  /(^|\/)audit\//, /(^|\/)review\//, /(^|\/)pilot\//, /(^|\/)handoff-staging\//,
  /(?:^|\/)[^/]*private[^/]*jwk/i, /\.(?:exe|tgz|zip|tar|log)$/i ];
const allowed = p => ['api/','endpoint/','data/','abis/','worker/','verifier/','mainnet/','scripts/','spec/','conformance/','landing/'].some(x => p.startsWith(x)) ||
  ['package.json','package-lock.json','vercel.json','.npmrc'].includes(p);
// Bound the tree query to package roots: this repository also tracks large,
// unrelated historical trees, which must not fill the subprocess buffer.
const packageRoots = ['api','endpoint','data','abis','worker','verifier','mainnet','scripts','spec','conformance','landing',
 'package.json','package-lock.json','vercel.json','.npmrc'];
const entries = execFileSync('git', ['ls-tree','-r','--name-only',BASE,'--',...packageRoots],
 { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim().split('\n');
const changedRuntime = execFileSync('git',['diff','--name-only',BASE,'--','api','endpoint','data','worker','verifier','mainnet','package.json','package-lock.json','vercel.json','spec'],{cwd:ROOT,encoding:'utf8'}).trim();
if(changedRuntime) throw Error('Website release must not alter production runtime/config: '+changedRuntime);
fs.mkdirSync(RELEASE,{recursive:true});
// Only discard files in THIS task-owned package directory; never the source worktree.
for(const entry of fs.readdirSync(RELEASE)) fs.rmSync(path.join(RELEASE,entry),{recursive:true,force:true});
const records=[];
for(const relative of entries) {
 if(!allowed(relative)||excluded.some(p=>p.test(relative)))continue;
 const absolute=path.join(RELEASE,relative);let bytes;
 if(relative.startsWith('landing/')) {
  if(!fs.existsSync(path.join(ROOT,relative)))throw Error('Tracked public file missing '+relative);
  bytes=fs.readFileSync(path.join(ROOT,relative));
 } else bytes=execFileSync('git',['show',BASE+':'+relative],{cwd:ROOT,maxBuffer:20*1024*1024});
 fs.mkdirSync(path.dirname(absolute),{recursive:true});fs.writeFileSync(absolute,bytes);
 records.push({path:relative,bytes:bytes.length,sha256:sha(bytes),source:relative.startsWith('landing/')?'reviewed website':'exact production '+BASE});
}
// New public documents/assets, explicitly only under landing.
function addLanding(folder) {
 for(const entry of fs.readdirSync(folder,{withFileTypes:true})) {
  const file=path.join(folder,entry.name);
  if(entry.isDirectory()){addLanding(file);continue;}
  const relative=path.relative(ROOT,file).replace(/\\/g,'/');
  if(records.some(r=>r.path===relative))continue;
  if(!/\.(?:html|md|txt|json|xml|png|jpg|svg|ico|webp)$/i.test(relative))throw Error('Unexpected landing package type '+relative);
  const bytes=fs.readFileSync(file);const dst=path.join(RELEASE,relative);fs.mkdirSync(path.dirname(dst),{recursive:true});fs.writeFileSync(dst,bytes);
  records.push({path:relative,bytes:bytes.length,sha256:sha(bytes),source:'reviewed new website file'});
 }
}
addLanding(path.join(ROOT,'landing'));
// Remove ONLY non-runtime operational script copies. Preserve the two actual
// imports used by current MCP/routing, verified from inspected source.
const scriptKeep=new Set(['scripts/rank-suppliers.js','scripts/shrinkage.js']);
for(let i=records.length-1;i>=0;i--) {
 if(records[i].path.startsWith('scripts/')&&!scriptKeep.has(records[i].path)) {
  fs.rmSync(path.join(RELEASE,records[i].path));records.splice(i,1);
 }
}
const needed=['api/route.mjs','api/mcp.mjs','api/discovery.mjs','api/receipt.mjs','api/checkout.mjs','api/stripe/webhook.mjs',
 'api/lib/supabase.mjs','api/lib/welcome-email.mjs','endpoint/route-server.js','endpoint/preflight-core.js','endpoint/acceptance-core.js',
 'endpoint/supabase-acceptance-store.js','endpoint/supabase-proposal-store.js','endpoint/mcp-supplier-index.json',
 'scripts/rank-suppliers.js','scripts/shrinkage.js','spec/examples/discovery/profile-live-signed.json','data/escrow-custody-build.json',
 'abis/IdentityRegistry.json','abis/ReputationRegistry.json','mainnet/design/support/v4-journal-writer.js',
 'package.json','package-lock.json','vercel.json','landing/blog/signed-discovery-to-testnet-finance.html'];
for(const p of needed)if(!fs.existsSync(path.join(RELEASE,p)))throw Error('INCOMPLETE PACKAGE: '+p);
const violations=[];
for(const r of records) {
 const p=r.path;if(excluded.some(rx=>rx.test(p)))violations.push(p);
 if(/\.(?:js|mjs|cjs|json|txt|md|html|sql)$/.test(p)) {
  const text=fs.readFileSync(path.join(RELEASE,p),'utf8');
  if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)||/"d"\s*:\s*"[A-Za-z0-9_-]{30,}/.test(text)||
    /postgres(?:ql)?:\/\/[^\s/:]+:[^\s@]+@/.test(text)) violations.push(p+' private material pattern');
 }
}
if(violations.length)throw Error('Release contains forbidden file/material: '+violations.join(', '));
// Ignore task-generated release metadata/build output, not required assets.
fs.writeFileSync(path.join(RELEASE,'.vercelignore'),'.vercel\nnode_modules\n.output*\n.env*\n');
fs.mkdirSync(path.join(RELEASE,'.vercel'),{recursive:true});
fs.writeFileSync(path.join(RELEASE,'.vercel/project.json'),JSON.stringify({projectId:'prj_o2g1a69CbitjPwtT3DAxevJkaX5v',
 orgId:'team_R2j8Z5qJD4ZTPCER2rBPx1S0',projectName:'ax-router'},null,2));
const report={createdAt:new Date().toISOString(),productionRuntimeBase:BASE,sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim(),
 project:'ax-router',projectId:'prj_o2g1a69CbitjPwtT3DAxevJkaX5v',orgId:'team_R2j8Z5qJD4ZTPCER2rBPx1S0',root:'.',
 rollback:{id:'dpl_GbuLCGj1vC1J5AJBn892vrrJC1Mq',url:'https://ax-router-ilbtgr5jf-bryant-s-projects5.vercel.app'},
 package:RELEASE,files:records.length,totalBytes:records.reduce((s,r)=>s+r.bytes,0),required:needed,secretFindings:violations,records};
fs.writeFileSync(path.join(ROOT,'.output-deployment-package.json'),JSON.stringify(report,null,2)+'\n');
console.log('COMPLETE SAAX PACKAGE '+records.length+' files, '+report.totalBytes+' bytes; runtime/config source='+BASE+'; secret findings=0');
