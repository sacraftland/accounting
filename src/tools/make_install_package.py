#!/usr/bin/env python3
"""Builds the complete installation package: craftland-install-<date>.zip

  python3 tools/make_install_package.py [out_dir] [--privacy path/to/privacy.html] [--version label]

Contents: the app without connection keys, the full database (setup + migrations + owner + check),
the guides (Markdown + one formatted HTML page), the backup program, the full source, VERSION and SHA256SUMS.
"""
import argparse, datetime, hashlib, io, json, pathlib, re, subprocess, sys, zipfile
import markdown

ROOT = pathlib.Path(__file__).resolve().parent.parent
INST = ROOT / 'tools' / 'install'
SKIP = {'clone-screens', 'deploy', '__pycache__', 'node_modules', '.git', 'dist'}


def build_app_without_keys():
    """Build index.html with an empty SUPABASE_CONFIG (the installer fills it in)."""
    subprocess.run([sys.executable, str(ROOT / 'app' / 'build.py')], check=True, capture_output=True)
    html = (ROOT / 'app' / 'index.html').read_text(encoding='utf-8')
    m = re.search(r"const SUPABASE_CONFIG = \{\s*url: '([^']*)',\s*anonKey: '([^']*)',", html)
    if not m or m.group(1) or m.group(2): raise SystemExit('index.html still carries connection keys — refusing to package')
    return html


def guide_html(version):
    order = ['README.md'] + [f'docs/{p.name}' for p in sorted((INST / 'docs').glob('*.md'))]
    md = markdown.Markdown(extensions=['tables', 'fenced_code', 'toc'])
    parts, toc = [], []
    titles = {i: re.search(r'^#\s+(.+)$', (INST / rel).read_text(encoding='utf-8'), re.M).group(1) for i, rel in enumerate(order)}
    for i, rel in enumerate(order):
        text = (INST / rel).read_text(encoding='utf-8')
        title = re.search(r'^#\s+(.+)$', text, re.M).group(1)
        sid = f's{i}'; toc.append(f'<li><a href="#{sid}">{title}</a></li>')
        body = md.reset().convert(text)
        body = re.sub(r'<code>(?:docs/)?(\d)-[^<]+?\.md</code>', lambda m: f'<a href="#s{int(m.group(1))}">«{titles[int(m.group(1))]}»</a>', body)
        body = re.sub(r'<code>([^<]*[\u0600-\u06ff][^<]*)</code>', r'<code class="ar">\1</code>', body)   # Arabic file names read right-to-left
        parts.append(f'<section id="{sid}">{body}</section>')
    return f'''<!DOCTYPE html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>كرافت لاند — دليل التثبيت</title>
<style>
  :root {{ --ink:#2f2a24; --muted:#6f665c; --line:#e6ddd0; --soft:#f6f1e9; --accent:#4f6b3a; }}
  * {{ box-sizing: border-box; }}
  body {{ margin:0; font: 15px/1.85 "IBM Plex Sans Arabic", "Segoe UI", Tahoma, sans-serif; color:var(--ink); background:#fbf8f3; }}
  header {{ background:var(--ink); color:#fff; padding:28px 32px; }}
  header h1 {{ margin:0; font-size:24px; }} header p {{ margin:4px 0 0; opacity:.8; }}
  .wrap {{ display:grid; grid-template-columns: 260px minmax(0, 1fr); gap:32px; max-width:1180px; margin:0 auto; padding:24px 32px 64px; }}
  nav {{ position:sticky; top:16px; align-self:start; background:#fff; border:1px solid var(--line); border-radius:12px; padding:16px; }}
  nav b {{ display:block; margin-bottom:8px; }} nav ul {{ margin:0; padding:0; list-style:none; display:grid; gap:6px; }} nav a {{ color:var(--ink); text-decoration:none; }} nav a:hover {{ color:var(--accent); }}
  section {{ background:#fff; border:1px solid var(--line); border-radius:12px; padding:8px 28px 20px; margin-bottom:24px; }}
  h1 {{ font-size:22px; border-bottom:2px solid var(--line); padding-bottom:8px; }} h2 {{ font-size:18px; margin-top:28px; color:var(--accent); }} h3 {{ font-size:16px; }}
  table {{ border-collapse:collapse; width:100%; margin:12px 0; font-size:14px; }} th, td {{ border:1px solid var(--line); padding:8px 10px; text-align:start; vertical-align:top; }} th {{ background:var(--soft); }}
  code {{ background:var(--soft); border-radius:5px; padding:1px 6px; font-size:13px; direction:ltr; unicode-bidi:isolate; }} code.ar {{ direction:rtl; }}
  pre {{ background:var(--ink); color:#f6f1e9; border-radius:10px; padding:14px 16px; overflow-x:auto; direction:ltr; text-align:left; }} pre code {{ background:none; color:inherit; padding:0; }}
  blockquote {{ margin:12px 0; padding:8px 16px; background:#fff8e6; border-inline-start:4px solid #e0a526; border-radius:6px; }}
  a {{ color:var(--accent); }}
  @media (max-width: 900px) {{ .wrap {{ grid-template-columns: 1fr; padding:16px; }} nav {{ position:static; }} }}
  @media print {{ nav, header {{ display:none; }} .wrap {{ display:block; }} section {{ break-inside:auto; border:0; }} }}
</style></head><body>
<header><h1>كرافت لاند — دليل التثبيت والتشغيل</h1><p>{version}</p></header>
<div class="wrap"><nav><b>المحتويات</b><ul>{''.join(toc)}</ul></nav><main>{''.join(parts)}</main></div>
</body></html>'''


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('out', nargs='?', default=str(ROOT / 'dist'))
    ap.add_argument('--privacy'); ap.add_argument('--version')
    a = ap.parse_args()
    today = datetime.date.today().isoformat()
    migrations = sorted((ROOT / 'supabase').glob('[01][0-9]_*.sql'))
    level = int(migrations[-1].name[:2])
    label = a.version or today
    version = f'الإصدار {label} — مستوى قاعدة البيانات {level}'
    files = {}                                                        # path in zip -> bytes
    put = lambda p, data: files.__setitem__(p, data if isinstance(data, bytes) else data.encode('utf-8'))

    put('README.md', (INST / 'README.md').read_text(encoding='utf-8'))
    for p in sorted((INST / 'docs').glob('*.md')): put(f'docs/{p.name}', p.read_text(encoding='utf-8'))
    put('دليل-التثبيت.html', guide_html(version))
    put('app/index.html', build_app_without_keys())
    if a.privacy: put('app/privacy.html', pathlib.Path(a.privacy).read_bytes())
    setup = '\n\n'.join(p.read_text(encoding='utf-8') for p in migrations)
    if setup != (ROOT / 'supabase' / 'setup.sql').read_text(encoding='utf-8'): raise SystemExit('supabase/setup.sql is out of date — regenerate it first')
    put('database/setup.sql', setup)
    for p in migrations: put(f'database/migrations/{p.name}', p.read_bytes())
    for n in ('owner.sql', 'check.sql'): put(f'database/{n}', (INST / 'database' / n).read_bytes())
    put('tools/craftland-backup.py', (ROOT / 'tools' / 'craftland-backup.py').read_bytes())
    for p in sorted(ROOT.rglob('*')):
        rel = p.relative_to(ROOT)
        if p.is_dir() or any(part in SKIP for part in rel.parts) or rel.as_posix() == 'app/index.html' or p.suffix in ('.pyc', '.png', '.zip'): continue
        put(f'source/{rel.as_posix()}', p.read_bytes())
    put('VERSION.txt', f'كرافت لاند — حزمة التثبيت\n{version}\nتاريخ البناء: {datetime.datetime.now().isoformat(timespec="minutes")}\n'
        f'مستوى قاعدة البيانات: {level} (آخر ملف: {migrations[-1].name})\nعدد الملفات: {len(files) + 2}\n')
    put('SHA256SUMS.txt', ''.join(f'{hashlib.sha256(b).hexdigest()}  {n}\n' for n, b in sorted(files.items())))

    out = pathlib.Path(a.out); out.mkdir(parents=True, exist_ok=True)
    zpath = out / f'craftland-install-{label}.zip'
    with zipfile.ZipFile(zpath, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        now = datetime.datetime.now().timetuple()[:6]
        for n, b in files.items():
            zi = zipfile.ZipInfo('craftland-install/' + n, date_time=now)
            zi.external_attr = (0o755 if n.endswith(('.py', '.sh')) else 0o644) << 16; zi.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(zi, b)
    print(json.dumps({'zip': str(zpath), 'files': len(files), 'bytes': zpath.stat().st_size, 'level': level}, ensure_ascii=False))


if __name__ == '__main__':
    main()
