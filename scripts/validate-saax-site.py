from pathlib import Path
from html.parser import HTMLParser
from urllib.parse import urlsplit, unquote
import json, re, hashlib, subprocess, xml.etree.ElementTree as ET
ROOT=Path(__file__).resolve().parents[1]; LAND=ROOT/'landing'; problems=[]; results=[]
SLUG='signed-discovery-to-testnet-finance'
class Page(HTMLParser):
 def __init__(self):
  super().__init__(convert_charrefs=True);self.links=[];self.ids=set();self.meta={};self.canonical=[];self.h1=0;self.ld=[];self.in_ld=False;self.stack=[];self.bad=[]
 def handle_starttag(self,t,a):
  d=dict(a)
  if t=='a' and 'href'in d:self.links.append(d['href'])
  if 'id'in d:self.ids.add(d['id'])
  if t=='meta':self.meta[d.get('name',d.get('property',''))]=d.get('content','')
  if t=='link' and d.get('rel')=='canonical':self.canonical.append(d.get('href'))
  if t=='h1':self.h1+=1
  if t=='script' and d.get('type')=='application/ld+json':self.in_ld=True;self.ld.append('')
  if t not in ['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']:self.stack.append(t)
 def handle_endtag(self,t):
  if t=='script':self.in_ld=False
  if self.stack and self.stack[-1]==t:self.stack.pop()
  elif t in self.stack:self.bad.append('misnested '+t);self.stack=self.stack[:self.stack.index(t)]
  else:self.bad.append('unexpected close '+t)
 def handle_data(self,d):
  if self.in_ld:self.ld[-1]+=d
pages={}
for f in LAND.rglob('*.html'):
 p=Page();p.feed(f.read_text(encoding='utf-8'));pages[f]=p
# Scope main checks to changed/current pages plus new article. Old collateral not silently rewritten.
targets=['index','docs','status','security','spec','protocol','disputes','blog/index','blog/'+SLUG]
for name in targets:
 f=LAND/(name+'.html');p=pages[f];text=f.read_text(encoding='utf-8')
 route='/' if name=='index' else '/blog' if name=='blog/index' else '/'+name
 canonical='https://saax-protocol.com'+route
 if p.canonical!=[canonical]:problems.append((name,'canonical',p.canonical))
 if p.h1!=1:problems.append((name,'h1',p.h1))
 if not p.meta.get('description'):problems.append((name,'missing description'))
 if p.stack or p.bad:problems.append((name,'html structure',p.stack,p.bad[:5]))
 if '\ufffd' in text:problems.append((name,'unicode replacement character'))
 for data in p.ld:
  try:json.loads(data)
  except Exception as e:problems.append((name,'invalid JSON-LD',str(e)))
 for link in p.links:
  u=urlsplit(link)
  if u.scheme in ['mailto','tel']:continue
  if u.netloc and u.netloc not in ['saax-protocol.com','www.saax-protocol.com']:continue
  path=u.path
  if path in ['/receipt','/route','/mcp','/checkout','/.well-known/saax.json']:continue
  if not path:path=route
  target=LAND/'index.html' if path=='/' else LAND/'blog/index.html' if path=='/blog' else LAND/(path.lstrip('/')+'.html')
  if path.startswith('/assets/') or '.'in path.rsplit('/',1)[-1]:target=LAND/path.lstrip('/')
  if not target.exists():problems.append((name,'missing internal link',link));continue
  if u.fragment and target.suffix=='.html':
   tp=pages.get(target)
   if tp and unquote(u.fragment) not in tp.ids:problems.append((name,'missing fragment',link))
 results.append({'page':route,'descriptionLength':len(p.meta.get('description','')),'canonical':canonical,'links':len(p.links),'sha256':hashlib.sha256(f.read_bytes()).hexdigest()})
article=(LAND/'blog'/f'{SLUG}.html').read_text(encoding='utf-8')
for required in ['AI disclosure','84532','8453','0.001','EIP-712','configured-key','operator-controlled','testnet preview','78 release','79 refund']:
 if required not in article:problems.append(('article','required truthful bound missing',required))
if 'mainnet escrow is available' in article:problems.append(('article','false maturity claim'))
# Forbidden partner name must not appear in touched public pages; do not print it.
for name in targets:
 if 'coin'+'stancy' in (LAND/(name+'.html')).read_text(encoding='utf-8').lower():problems.append((name,'prohibited partner mention'))
urls=ET.parse(LAND/'sitemap.xml').getroot().findall('{http://www.sitemaps.org/schemas/sitemap/0.9}url')
locs=[u.find('{http://www.sitemaps.org/schemas/sitemap/0.9}loc').text for u in urls]
if len(locs)!=len(set(locs)):problems.append(('sitemap','duplicate URLs'))
if 'https://saax-protocol.com/blog/'+SLUG not in locs:problems.append(('sitemap','article absent'))
for aslug in ['what-agent-payment-authorization-actually-authorizes','what-escrow-security-review-actually-verifies']:
 if 'https://saax-protocol.com/blog/'+aslug not in locs:problems.append(('sitemap','article absent '+aslug))
# Production logic/config/legal disclosure assets must be byte-preserved from base.
protected=['api','endpoint','contracts','data','worker','abis','package.json','package-lock.json','vercel.json','spec/examples/discovery/profile-live-signed.json','landing/terms.html','landing/terms.md','landing/privacy.html','landing/privacy.md']
changed=subprocess.check_output(['git','diff','--name-only','2f211ef2','--']+protected,cwd=ROOT,text=True).strip()
if changed:problems.append(('protected-production-or-legal-diff',changed))
report={'checkedAt':'2026-11-06','pass':not problems,'pages':results,'sitemapUrls':len(locs),'problems':problems,
 'protectedBase':'2f211ef2','design':'existing templates, palette, typography; responsive overflow constraints only'}
(ROOT/'.output-site-validation.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
print(json.dumps(report,indent=2));raise SystemExit(1 if problems else 0)
