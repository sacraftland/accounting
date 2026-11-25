# Builds app/index.html — one self-contained file — from the parts.
import json, re, pathlib
here = pathlib.Path(__file__).parent
prim = (here.parent / 'design' / 'primitives.html').read_text()
css = re.search(r'<style>(.*?)</style>', prim, re.S).group(1)
sprite = re.search(r'(<svg width="0".*?</svg>\n)', prim, re.S).group(1)
chart = json.loads((here / 'chart.json').read_text())
html = f'''<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#2f2a24">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22%3E%3Crect width=%2232%22 height=%2232%22 rx=%228%22 fill=%22%234f6b3a%22/%3E%3Cpath d=%22M9 8h11a3 3 0 0 1 3 3v13H12a3 3 0 0 1-3-3z%22 fill=%22none%22 stroke=%22white%22 stroke-width=%222%22/%3E%3C/svg%3E">
<title>دفتر</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>{css}
{(here / 'app.css').read_text()}</style>
</head>
<body>
{sprite}<div id="app"></div>
<div class="toasts" id="toasts" aria-live="polite"></div>
<noscript><p style="padding:24px">هذا التطبيق يحتاج تفعيل JavaScript.</p></noscript>
<script>
{(here / 'config.js').read_text()}
{(here / 'qr.js').read_text()}
const CHART = {json.dumps(chart, ensure_ascii=False)};
{(here / 'data.js').read_text()}
{(here / 'app.js').read_text().replace('// @@OPS@@', (here / 'ops.js').read_text(), 1)}
</script>
</body>
</html>
'''
(here / 'index.html').write_text(html)
import sys
if len(sys.argv) > 2:  # python3 build.py <supabase-url> <anon-key>  → writes them into the built file
    html = html.replace("url: '',", f"url: '{sys.argv[1]}',", 1).replace("anonKey: '',", f"anonKey: '{sys.argv[2]}',", 1); (here / 'index.html').write_text(html)
print('index.html', len(html.splitlines()), 'lines', round(len(html.encode())/1024), 'KB')
