"""Build crawlable localized GitHub Pages documents from docs/index.html. No dependencies."""
from pathlib import Path
from html.parser import HTMLParser
from html import escape
import json,re,struct
import xml.etree.ElementTree as ET
ROOT=Path(__file__).resolve().parents[1]
DOCS=ROOT/'docs'
BASE='https://khoitd-voyager.github.io/mcp-spec-nav/'
URLS={'en':BASE,'vi':BASE+'vi/','zh':BASE+'zh/'}
LANG={'en':'en','vi':'vi','zh':'zh-CN'}
LOCALES={'en':'en_US','vi':'vi_VN','zh':'zh_CN'}
TITLES={'en':'mcp-spec-nav — Code search & navigation for AI agents','vi':'mcp-spec-nav — Tìm kiếm và điều hướng code cho AI','zh':'mcp-spec-nav — AI 智能体的代码搜索与导航'}
DESCRIPTIONS={
'en':'A local MCP server for AI coding agents. Search code, discover reusable functions, read implementations, and find callers across your repository.',
'vi':'MCP server chạy local cho AI coding agent. Tìm code, khám phá hàm có thể tái sử dụng, đọc implementation và kiểm tra callers trong repo.',
'zh':'为 AI 编程智能体提供本地 MCP 服务器。搜索代码、发现可复用函数、阅读实现并检查仓库中的调用方。'}
source=(DOCS/'index.html').read_text()
m=re.search(r'const siteTranslations=(.*?);\s*let siteLanguage=',source,re.S)
translations=json.loads(m.group(1))
translations.update({'Reuse code':{'vi':'Dùng lại code','zh':'复用代码'},'Check callers':{'vi':'Kiểm tra callers','zh':'检查调用方'},'Survey a change':{'vi':'Khảo sát thay đổi','zh':'梳理修改范围'}})
source=source[:m.start(1)]+json.dumps(translations,ensure_ascii=False)+source[m.end(1):]
source=re.sub(r' selected(?=[ >])','',source)
source=source.replace('<option value="real-large"','<option value="real-large" selected',1)
source=re.sub(r' aria-current="page"','',source)
# Language URLs determine the initial locale. A preview opened as a file still switches in place.
source=re.sub(r"let siteLanguage='en';try\{.*?\}catch\{\}","let siteLanguage=document.documentElement.lang.startsWith('zh')?'zh':document.documentElement.lang==='vi'?'vi':'en';",source,count=1)
old="siteLanguage=languageSelect.value;try{localStorage.setItem('spec-nav-language',siteLanguage);}catch{}applyLanguage();if(typeof renderBenchmarks==='function')renderBenchmarks(false);"
new="siteLanguage=languageSelect.value;if(location.protocol!=='file:'){location.assign({en:'"+BASE+"',vi:'"+BASE+"vi/',zh:'"+BASE+"zh/'}[siteLanguage]);return;}try{localStorage.setItem('spec-nav-language',siteLanguage);}catch{}applyLanguage();if(typeof renderBenchmarks==='function')renderBenchmarks(false);"
if old in source:source=source.replace(old,new)
# Include crawlable links as well as the compact language selector.
links='<div class="locale-links" aria-label="Available languages">'+ ' · '.join(f'<a href="{url}" lang="{LANG[k]}" hreflang="{LANG[k]}" data-locale="{k}">{label}</a>' for k,url,label in [('en',URLS['en'],'English'),('zh',URLS['zh'],'中文'),('vi',URLS['vi'],'Tiếng Việt')])+'</div>'
if 'class="locale-links"' not in source:source=source.replace('<footer>','<footer>'+links,1)
if '.locale-links{' not in source:source=source.replace('</style>','.locale-links{text-align:center;font-size:12px;padding:0 15px 16px}.locale-links a{padding:4px 8px}.locale-links a[aria-current="page"]{color:var(--accent);font-weight:700}</style>',1)
# Pre-render chart values so the results are readable without JavaScript.
benchmark=json.loads(re.search(r'const benchmarkData=(.*?);\s*let benchmarkVisible=',source,re.S).group(1))['real-large']
for key in ['correct','reuse','search','context','wrongEdits','toolCalls']:
 percentage=key in ['correct','reuse']
 for mode in ['baseline','mcp']:
  val=benchmark['metrics'][mode][key]
  label=f'{val:.0f}%' if percentage else f'{val:.1f}' if key in ['wrongEdits','toolCalls'] else f'{val:,.0f}'
  source=re.sub(r'(<span class="bar-number" id="value-'+key+'-'+mode+r'">).*?(</span>)',lambda m:m[1]+label+m[2],source)
source=re.sub(r'(<p class="bench-context" id="bench-context">).*?(</p>)',r'\g<1>immich@cc7fd67 · 10 large sessions · Recorded 2026-10-13\g<2>',source)
# Only replace metadata we own; keep styles and the functional script intact.
head=re.search(r'<head>(.*?)</head>',source,re.S).group(1)
head=re.sub(r'<meta charset="utf-8">','',head)
head=re.sub(r'<title>.*?</title>','',head,flags=re.S)
head=re.sub(r'<meta\b[^>]*\b(?:name|property)="(?:description|robots|twitter:[^"]+|og:[^"]+)"[^>]*>','',head)
head=re.sub(r'<link\b[^>]*\brel="(?:canonical|alternate)"[^>]*>','',head)
head=re.sub(r'<script type="application/ld\+json">.*?</script>','',head,flags=re.S)
size=(DOCS/'assets/social-preview.png').read_bytes()[16:24];width,height=struct.unpack('>II',size)
class Localize(HTMLParser):
 def __init__(self,locale):super().__init__(convert_charrefs=False);self.locale=locale;self.out=[];self.stack=[]
 def handle_starttag(self,tag,attrs):
  self.out.append(self.get_starttag_text())
  if tag not in ['meta','link','img','br','hr','input','source','wbr','area','base','embed','param','track','col']:self.stack.append(tag)
 def handle_startendtag(self,tag,attrs):self.out.append(self.get_starttag_text())
 def handle_endtag(self,tag):
  self.out.append('</'+tag+'>')
  if tag in self.stack:
   while self.stack:
    if self.stack.pop()==tag:break
 def handle_data(self,data):
  if 'script' in self.stack or 'style' in self.stack or 'code' in self.stack:self.out.append(data);return
  key=data.strip();value=translations.get(key,{}).get(self.locale,key) if self.locale!='en' else key
  self.out.append(escape(data.replace(key,value),quote=False) if key and value!=key else data)
 def handle_entityref(self,name):self.out.append('&'+name+';')
 def handle_charref(self,name):self.out.append('&#'+name+';')
 def handle_decl(self,decl):self.out.append('<!'+decl+'>')
 def handle_comment(self,text):self.out.append('<!--'+text+'-->')
for locale,url in URLS.items():
 metadata=f'<title>{escape(TITLES[locale])}</title><meta name="description" content="{escape(DESCRIPTIONS[locale],quote=True)}"><meta name="robots" content="index,follow,max-image-preview:large"><link rel="canonical" href="{url}">'
 for lang,target in URLS.items():metadata+=f'<link rel="alternate" hreflang="{LANG[lang]}" href="{target}">'
 metadata+=f'<link rel="alternate" hreflang="x-default" href="{BASE}">'
 props={'og:type':'website','og:title':TITLES[locale],'og:description':DESCRIPTIONS[locale],'og:url':url,'og:site_name':'mcp-spec-nav','og:locale':LOCALES[locale],'og:image':BASE+'assets/social-preview.png','og:image:width':str(width),'og:image:height':str(height),'og:image:type':'image/png','og:image:alt':'mcp-spec-nav — Give your agent a map of your code.'}
 for name,value in props.items():metadata+=f'<meta property="{name}" content="{escape(value,quote=True)}">'
 for lang,value in LOCALES.items():
  if lang!=locale:metadata+=f'<meta property="og:locale:alternate" content="{value}">'
 for name,value in {'twitter:card':'summary_large_image','twitter:title':TITLES[locale],'twitter:description':DESCRIPTIONS[locale],'twitter:image':BASE+'assets/social-preview.png','twitter:image:alt':props['og:image:alt']}.items():metadata+=f'<meta name="{name}" content="{escape(value,quote=True)}">'
 schema={'@context':'https://schema.org','@type':['SoftwareApplication','SoftwareSourceCode'],'@id':url+'#software','name':'mcp-spec-nav','url':url,'description':DESCRIPTIONS[locale],'applicationCategory':'DeveloperApplication','operatingSystem':'Any OS with Node.js 18+','softwareVersion':'0.3.0','inLanguage':LANG[locale],'isAccessibleForFree':True,'license':'https://opensource.org/license/mit','image':BASE+'assets/social-preview.png','downloadUrl':'https://github.com/khoitd-voyager/mcp-spec-nav/releases','codeRepository':'https://github.com/khoitd-voyager/mcp-spec-nav','author':{'@type':'Person','name':'khoitd-voyager','url':'https://github.com/khoitd-voyager'},'offers':{'@type':'Offer','price':'0','priceCurrency':'USD'}}
 metadata+='<script type="application/ld+json">'+json.dumps(schema,ensure_ascii=False)+'</script>'
 page=re.sub(r'<head>.*?</head>','<head><meta charset="utf-8">'+metadata+head+'</head>',source,count=1,flags=re.S)
 page=page.replace('<html lang="en">','<html lang="'+LANG[locale]+'">',1)
 parser=Localize(locale);parser.feed(page);page=''.join(parser.out)
 # A selected option is meaningful before the JS initialization runs.
 page=re.sub(r'(<option value="'+locale+'")',r'\1 selected',page,count=1)
 page=page.replace(f'data-locale="{locale}"',f'data-locale="{locale}" aria-current="page"')
 if locale!='en':
  page=page.replace('10 large sessions · Recorded','10 '+translations['large sessions'][locale]+' · '+translations['Recorded'][locale])
 prefix='https://github.com/khoitd-voyager/mcp-spec-nav/blob/main/'
 targets={
 'en':{'readme':'README.md#english','tools':'README.md#tool-reference','desktop':'README.md#option-2-install-as-a-claude-desktop-extension','languages':'README.md#supported-languages--ngôn-ngữ-hỗ-trợ','benchmark':'bench/README.en.md'},
 'vi':{'readme':'README.md#tiếng-việt','tools':'README.md#các-tool-dùng-để-làm-gì','desktop':'README.md#cách-2-cài-thành-extension-cho-claude-desktop','languages':'README.md#supported-languages--ngôn-ngữ-hỗ-trợ','benchmark':'bench/README.md'},
 'zh':{'readme':'README.zh-CN.md','tools':'README.zh-CN.md#工具参考','desktop':'README.zh-CN.md#方式二安装为-claude-desktop-扩展','languages':'README.zh-CN.md#支持的语言','benchmark':'bench/README.zh-CN.md'}}
 page=re.sub(r'(id="bench-source" href=")[^"]*(")',lambda m:m[1]+benchmark['sources'][locale]+m[2],page)
 for key,target in targets[locale].items():
  page=re.sub(r'(data-doc="'+key+r'" href=")[^"]*(")',lambda m:m[1]+prefix+target+m[2],page)
 dest=DOCS/'index.html' if locale=='en' else DOCS/locale/'index.html';dest.parent.mkdir(parents=True,exist_ok=True);dest.write_text(page)
# Sitemap includes reciprocal locale alternates.
ET.register_namespace('','http://www.sitemaps.org/schemas/sitemap/0.9');ET.register_namespace('xhtml','http://www.w3.org/1999/xhtml')
ns='http://www.sitemaps.org/schemas/sitemap/0.9';sm=ET.Element('{'+ns+'}urlset')
for locale,url in URLS.items():
 u=ET.SubElement(sm,'{'+ns+'}url');ET.SubElement(u,'{'+ns+'}loc').text=url
 for lang,target in {**URLS,'x-default':BASE}.items():ET.SubElement(u,'{http://www.w3.org/1999/xhtml}link',{'rel':'alternate','hreflang':LANG.get(lang,lang),'href':target})
ET.indent(sm);(DOCS/'sitemap.xml').write_bytes(ET.tostring(sm,encoding='utf-8',xml_declaration=True))
(DOCS/'robots.txt').write_text('# Crawlers read robots.txt at the domain root, not a project subdirectory.\n# Copy these directives to https://khoitd-voyager.github.io/robots.txt to activate.\nUser-agent: *\nAllow: /mcp-spec-nav/\n\nSitemap: '+BASE+'sitemap.xml\n')
print('Built English, Vietnamese, Chinese pages; SEO metadata, sitemap and robots template.')
