"""Render reviewed markdown in existing SAAX templates; keep visual shell/design."""
from pathlib import Path
import re, json, html
import markdown
ROOT = Path(__file__).resolve().parents[1]
LAND = ROOT / 'landing'
SLUG = 'signed-discovery-to-testnet-finance'
META = {
 'status': ('SAAX current status | Discovery beta and testnet finance', 'Verified SAAX status: public signed Discovery and buyer acceptance, Base-mainnet immediate payments, and operator-run Sepolia finance with explicit limits.'),
 'docs': ('SAAX integration guide | Signed Discovery, acceptance and verification', 'Integrate signed SAAX Discovery, free preflight and buyer-authorized commitments; distinguish live payments from verified testnet-only custody.'),
 'security': ('SAAX security | Trust, verification and custody limits', 'SAAX security boundaries: configured-key trust, exact signed financial terms, independent testnet verification, evaluator risk and unaudited custody.'),
 'protocol': ('SAAX Protocol — The Standard', 'The versioned SAAX commitment specification, public Discovery interfaces and bounded testnet financial integration, with deployment distinctions.'),
 'spec': ('SAAX Protocol — Commitment lifecycle specification', 'Versioned SAAX lifecycle, authority, evidence and settlement interfaces, with exact Discovery and testnet custody verification boundaries.'),
 'disputes': ('SAAX disputes | Recovery scope and evaluator dependence', 'How SAAX complaints and testnet on-chain disputes differ; buyer/seller initiation, evaluator resolution and limits on timeout refunds.'),
 'article': ('A chain ID is not authorization: verifying Discovery-to-testnet finance', 'Trace signed SAAX Discovery through buyer consent, real Sepolia custody and independent verification; exact network binding, bytecode and verdict checks.')
}
def source_text(path):
 # Editorial spacing only in newly reviewed documents, not historical articles.
 text=path.read_text(encoding='utf-8')
 for term in ['mainnet','Sepolia','profile','Custody','solc','optimizer','block','verified','funded','runtime is','is','or','HTTP','trial with card collected upfront, Developer','Business','Stripe:','source report']:
  text=re.sub(r'\b'+re.escape(term)+r'(?=\d)',term+' ',text)
 text=re.sub(r'(?<=\w)(?=\$)', ' ', text)
 return text
EXTRA_CSS = '''
/* Preserve the established palette, typography and layout; constrain long proof data. */
article{min-width:0;overflow-wrap:anywhere;}
article table{display:block;max-width:100%;overflow-x:auto;border-collapse:collapse;margin:1rem 0;}
article th,article td{padding:.6rem;border:1px solid var(--border);text-align:left;min-width:110px;}
article th{background:#161b22;} article pre{overflow-x:auto;max-width:100%;}
article pre code{white-space:pre;overflow-wrap:normal;}
nav.nav{flex-wrap:wrap;} .nav .links{flex-wrap:wrap;}
@media(max-width:640px){article h1{font-size:1.6rem;} .nav .links{gap:.8rem;}}
'''
def set_meta(text, title, description, url):
 text = re.sub(r'<title>.*?</title>', '<title>'+html.escape(title)+'</title>', text, count=1, flags=re.S)
 for key, value in [('description',description),('og:title',title),('og:description',description),('og:url',url),('og:type','article' if '/blog/' in url else 'website'),('twitter:title',title),('twitter:description',description)]:
  attr = 'property' if key.startswith('og:') else 'name'
  tag = '<meta '+attr+'="'+key+'" content="'+html.escape(value,quote=True)+'">'
  pat = r'<meta\s+(?:name|property)="'+re.escape(key)+r'"[^>]*>'
  if re.search(pat,text): text = re.sub(pat, lambda _:tag, text, count=1)
  else: text = text.replace('</head>',tag+'\n</head>')
 text = re.sub(r'<link rel="canonical"[^>]*>', '<link rel="canonical" href="'+url+'">', text, count=1)
 if '/* Preserve the established palette' not in text: text = text.replace('</style>',EXTRA_CSS+'\n</style>',1)
 return text
for name in ['status','docs','security','protocol','spec','disputes']:
 p=LAND/(name+'.html'); old=p.read_text(encoding='utf-8')
 md=source_text(LAND/(name+'.md'))
 (LAND/(name+'.md')).write_text(md,encoding='utf-8',newline='\n')
 body=markdown.markdown(md,extensions=['tables','fenced_code','toc'],output_format='html')
 result=re.sub(r'(<article[^>]*>).*?(</article>)',lambda m:m.group(1)+'\n'+body+'\n'+m.group(2),old,count=1,flags=re.S)
 result=set_meta(result,*META[name],'https://saax-protocol.com/'+name)
 p.write_text(result,encoding='utf-8',newline='\n')
 print('rendered',p.relative_to(ROOT))
# New article inherits existing blog layout, not a new visual design.
old=(LAND/'blog/unknown-payment-outcomes-agent-recovery.html').read_text(encoding='utf-8')
md=(LAND/'blog'/f'{SLUG}.md').read_text(encoding='utf-8')
body=markdown.markdown(md,extensions=['tables','fenced_code','toc'],output_format='html')
article=re.sub(r'(<article[^>]*>).*?(</article>)',lambda m:m.group(1)+'\n'+body+'\n'+m.group(2),old,count=1,flags=re.S)
article=re.sub(r'<script type="application/ld\+json">.*?</script>','',article,flags=re.S)
url='https://saax-protocol.com/blog/'+SLUG
article=set_meta(article,*META['article'],url)
ld={'@context':'https://schema.org','@type':'TechArticle','headline':META['article'][0],'description':META['article'][1],
 'url':url,'mainEntityOfPage':url,'datePublished':'2026-11-06','dateModified':'2026-11-06','inLanguage':'en',
 'author':{'@type':'Organization','name':'SAAX Protocol','url':'https://saax-protocol.com'},
 'publisher':{'@type':'Organization','name':'SAAX Protocol','url':'https://saax-protocol.com',
 'logo':{'@type':'ImageObject','url':'https://saax-protocol.com/assets/logo-full-light.png'}},
 'about':['Signed discovery','Buyer acceptance','Base Sepolia','EIP-712 verification'],
 'isAccessibleForFree':True}
article=article.replace('</head>','<script type="application/ld+json">\n'+json.dumps(ld,ensure_ascii=False,indent=2)+'\n</script>\n</head>')
(LAND/'blog'/f'{SLUG}.html').write_text(article,encoding='utf-8',newline='\n')
# Existing blog index; add one item and one source link, never duplicate.
p=LAND/'blog/index.md'; txt=p.read_text(encoding='utf-8')
if '/blog/'+SLUG not in txt: txt=txt.replace('## Protocols','## Implementation\n\n- ['+META['article'][0]+'](/blog/'+SLUG+') — 2026-11-06\n\n## Protocols')
p.write_text(txt,encoding='utf-8',newline='\n')
p=LAND/'blog/index.html';txt=p.read_text(encoding='utf-8')
if '/blog/'+SLUG not in txt:
 item='<h2>Implementation</h2><ul class="post-list"><li><a href="/blog/'+SLUG+'">'+html.escape(META['article'][0])+'</a><span class="date">2026-11-06</span></li></ul>\n'
 txt=txt.replace('</h1>','</h1>\n'+item,1)
p.write_text(txt,encoding='utf-8',newline='\n')
# Unique exact canonical sitemap entry, dates only for touched routes.
p=LAND/'sitemap.xml';txt=p.read_text(encoding='utf-8')
if url not in txt:txt=txt.replace('</urlset>','  <url><loc>'+url+'</loc><lastmod>2026-11-06</lastmod></url>\n</urlset>')
for route in ['/','/docs','/status','/security','/spec','/protocol','/disputes','/blog']:
 target='https://saax-protocol.com'+route
 txt=txt.replace('<loc>'+target+'</loc></url>','<loc>'+target+'</loc><lastmod>2026-11-06</lastmod></url>')
p.write_text(txt,encoding='utf-8',newline='\n')
# Replace stale top-level LLM summary with compact current route-based content.
llms='''# SAAX Protocol

> A versioned commitment specification and implementation for agent commerce. Read status before acting: deployment and maturity are component-specific.

## Current verified state (2026-11-06)
- Specification: public, versioned protocol v1.0.3; Discovery profile1.0.0 and acceptance-v1 are separate formats.
- Signed Discovery, free preflight and configured-buyer acceptance: beta, publicly deployed, no payment/service execution. Configured-key provider trust requires independent onboarding; not permissionless publisher authentication.
- Existing x402/MPP USDC immediate payments: public beta on Base mainnet8453, non-custodial.
- Custody finance: testnet preview, operator-run Base Sepolia84532 only, not public financial endpoints or mainnet custody. A separately signed profile, authenticated evaluator and complete independent export verification were demonstrated with deterministic local SHA256 evidence and real test USDC.
- Verification/receipts: beta and format-specific. Discovery JWS is real crypto; general COSE/JWS evidence hooks retain structural/attesting-verifier limits. Live /receipt currently has a store-schema error.
- Recovery: implemented specific issuance/broadcast reconciliation scenarios, not universal or unattended recovery. Disputed V1 funds can remain frozen indefinitely if evaluator disappears; no guaranteed refunds.
- Unreleased custody/governance candidates: under development/security review. No completed independent audit or external adoption claimed.

## Core documentation
- [Current status](https://saax-protocol.com/status)
- [Integration and Discovery quickstart](https://saax-protocol.com/docs#discovery-quickstart)
- [Protocol overview](https://saax-protocol.com/protocol)
- [Versioned specification](https://saax-protocol.com/spec)
- [Conformance](https://saax-protocol.com/conformance)
- [Security](https://saax-protocol.com/security)
- [Terms](https://saax-protocol.com/terms)
- [Privacy](https://saax-protocol.com/privacy)
- [Disputes](https://saax-protocol.com/disputes)
- [Full documentation text](https://saax-protocol.com/llms-full.txt)

## Public interfaces
- Signed profile: https://saax-protocol.com/.well-known/saax.json (current production signed terms identify8453; do not reinterpret as testnet).
- Free preflight: POST https://saax-protocol.com/prepare-commitment
- Buyer acceptance: POST https://saax-protocol.com/accept-commitment (onboarded buyer keys required; no funds move).
- MCP: https://www.saax-protocol.com/mcp ; verified initialize/tools/list/ping/protocol-info,13 tools including prepare_commitment/accept_commitment.
- Mainnet immediate-payment HTTP route: https://saax-protocol.com/route (separate existing settlement host: https://settlement.saax-protocol.com).

## Essays
'''
for p in sorted((LAND/'blog').glob('*.md')):
 if p.stem=='index':continue
 title=p.read_text(encoding='utf-8').splitlines()[0].lstrip('# ').strip()
 llms+='- ['+title+'](https://saax-protocol.com/blog/'+p.stem+')\n'
(LAND/'llms.txt').write_text(llms,encoding='utf-8',newline='\n')
full='# SAAX Protocol — full documentation\n\nVerified current snapshot:2026-11-06. Public specification and component-specific implementation status. Internal tests are not an audit.\n\n'
for name in ['status','docs','protocol','spec','security','disputes']:
 full+='\n\n---\n\nSource: https://saax-protocol.com/'+name+'\n\n'+(LAND/(name+'.md')).read_text(encoding='utf-8')
for p in sorted((LAND/'blog').glob('*.md')):
 full+='\n\n---\n\nSource: https://saax-protocol.com/blog'+('' if p.stem=='index' else '/'+p.stem)+'\n\n'+p.read_text(encoding='utf-8')
full='\n'.join(line.rstrip() for line in full.splitlines())+'\n'
(LAND/'llms-full.txt').write_text(full,encoding='utf-8',newline='\n')
print('article, blog index, sitemap and llms files rendered')
