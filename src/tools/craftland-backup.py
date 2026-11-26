#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""كرافت لاند — النسخ الاحتياطي التلقائي على كمبيوتر لينكس مخصص.

يسحب نسخة كاملة من بيانات الشركة كل ليلة ويحفظها مضغوطة في مجلد على هذا الكمبيوتر،
ويحتفظ بآخر 30 نسخة يومية + نسخة لكل شهر لمدة 12 شهراً، ويتحقق من سلامة كل ملف.
لا يحتاج أي مكتبة إضافية: Python 3.8+ فقط.

الأوامر:
  python3 craftland-backup.py setup      إعداد أول مرة (البريد وكلمة المرور ومجلد الحفظ)
  python3 craftland-backup.py run        نسخة الآن
  python3 craftland-backup.py install    تشغيل تلقائي كل ليلة (systemd)
  python3 craftland-backup.py status     آخر النسخ وموعد القادمة
  python3 craftland-backup.py verify [ملف]   التحقق من سلامة نسخة
  python3 craftland-backup.py uninstall  إيقاف التشغيل التلقائي
"""
import argparse, datetime, getpass, gzip, hashlib, json, os, pathlib, shutil, subprocess, sys, time, urllib.error, urllib.request

URL = '__URL__'.rstrip('/')
KEY = '__KEY__'          # publishable key (public by design) — never put a secret / service key here
ORG = '__ORG__'
COMPANY = '__NAME__'

HOME = pathlib.Path.home()
CFG_DIR = pathlib.Path(os.environ.get('CRAFTLAND_BACKUP_CONFIG', HOME / '.config' / 'craftland-backup'))
CRED, CONF = CFG_DIR / 'credentials.json', CFG_DIR / 'config.json'
DEFAULTS = {'dir': str(HOME / 'craftland-backups'), 'keep_daily': 30, 'keep_monthly': 12, 'mirror_dir': ''}
PREFIX = 'craftland-'


def conf():
    c = dict(DEFAULTS)
    if CONF.exists(): c.update(json.loads(CONF.read_text(encoding='utf-8')))
    return c


def log(msg, c=None):
    line = f"{datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}  {msg}"
    print(line, flush=True)
    try:
        d = pathlib.Path((c or conf())['dir']); d.mkdir(parents=True, exist_ok=True)
        with open(d / 'backup.log', 'a', encoding='utf-8') as f: f.write(line + '\n')
    except OSError: pass


def http(method, path, body=None, token=None, timeout=300):
    data = None if body is None else json.dumps(body).encode()
    r = urllib.request.Request(URL + path, data=data, method=method, headers={
        'apikey': KEY, 'Authorization': 'Bearer ' + (token or KEY), 'Content-Type': 'application/json', 'Accept': 'application/json'})
    try:
        with urllib.request.urlopen(r, timeout=timeout) as res: return res.read()
    except urllib.error.HTTPError as e:
        detail = e.read().decode('utf-8', 'replace')[:300]
        raise RuntimeError(f'الخادم رد بخطأ {e.code}: {detail}') from None
    except urllib.error.URLError as e:
        raise RuntimeError(f'تعذر الاتصال بالخادم: {e.reason}') from None


def login():
    if not CRED.exists(): raise RuntimeError('لم يتم الإعداد بعد — شغّل: python3 craftland-backup.py setup')
    cr = json.loads(CRED.read_text(encoding='utf-8'))
    tok = json.loads(http('POST', '/auth/v1/token?grant_type=password', {'email': cr['email'], 'password': cr['password']}, timeout=60))
    if not tok.get('access_token'): raise RuntimeError('فشل تسجيل الدخول — تحقق من البريد وكلمة المرور (شغّل setup من جديد)')
    return tok['access_token']


def check_backup(raw):
    b = json.loads(raw)
    if b.get('format') != 'craftland-backup' or b.get('version') != 1: raise RuntimeError('الملف المستلم ليس نسخة احتياطية صالحة')
    if b.get('org_id') != ORG: raise RuntimeError('النسخة لشركة أخرى')
    t = b.get('tables') or {}
    if 'accounts' not in t or not t['accounts']: raise RuntimeError('النسخة ناقصة: لا توجد شجرة حسابات')
    return b, sum(len(v) for v in t.values()), len(t)


def sha256(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''): h.update(chunk)
    return h.hexdigest()


def rotate(d, keep_daily, keep_monthly):
    files = sorted(d.glob(PREFIX + '*.json.gz'), reverse=True)          # newest first (names sort by date)
    month = lambda f: f.name[len(PREFIX):len(PREFIX) + 7]                # YYYY-MM
    keep, have, months = set(files[:keep_daily]), {month(f) for f in files[:keep_daily]}, {}
    for f in files[keep_daily:]:                                         # then one per older month
        m = month(f)
        if m not in have and m not in months and len(months) < keep_monthly: months[m] = f
    keep |= set(months.values())
    for f in files:
        if f not in keep:
            f.unlink(missing_ok=True); pathlib.Path(str(f) + '.sha256').unlink(missing_ok=True)


def run():
    c = conf(); d = pathlib.Path(c['dir']); d.mkdir(parents=True, exist_ok=True)
    last = None
    for attempt in range(1, 4):
        try:
            token = login()
            raw = http('POST', '/rest/v1/rpc/export_org', {'p_org': ORG, 'p_source': 'script'}, token)
            b, rows, tables = check_backup(raw)
            name = f"{PREFIX}{datetime.datetime.now().strftime('%Y-%m-%d_%H%M')}.json.gz"
            tmp = d / (name + '.part')
            with gzip.open(tmp, 'wb', compresslevel=6) as f: f.write(raw)
            with gzip.open(tmp, 'rb') as f: check_backup(f.read())          # read it back before trusting it
            final = d / name; os.replace(tmp, final)
            digest = sha256(final); pathlib.Path(str(final) + '.sha256').write_text(f'{digest}  {name}\n', encoding='utf-8')
            if c.get('mirror_dir'):
                m = pathlib.Path(c['mirror_dir'])
                if m.is_dir():
                    shutil.copy2(final, m / name); shutil.copy2(str(final) + '.sha256', m / (name + '.sha256')); rotate(m, c['keep_daily'], c['keep_monthly'])
                else: log(f'تنبيه: مجلد النسخة الثانية غير متاح ({m}) — حُفظت النسخة الأساسية فقط', c)
            rotate(d, c['keep_daily'], c['keep_monthly'])
            (d / 'last_ok.json').write_text(json.dumps({'at': datetime.datetime.now().isoformat(timespec='seconds'), 'file': name, 'rows': rows, 'tables': tables, 'sha256': digest}, ensure_ascii=False), encoding='utf-8')
            log(f'✓ نسخة ناجحة: {name} — {tables} جدول، {rows:,} سجل، {final.stat().st_size / 1024:,.0f} كيلوبايت', c)
            return 0
        except Exception as e:   # noqa: BLE001 — keep trying, then report
            last = e; log(f'✗ المحاولة {attempt}: {e}', c)
            for p in d.glob('*.part'): p.unlink(missing_ok=True)
            if attempt < 3: time.sleep(float(os.environ.get('CRAFTLAND_BACKUP_RETRY_WAIT', 30)) * attempt)
    log(f'✗ فشل النسخ الاحتياطي: {last}', c)
    return 1


def setup():
    print(f'إعداد النسخ الاحتياطي لـ «{COMPANY}»\n')
    print('استخدم حساب المستخدم المخصص للنسخ (صلاحية «النسخ الاحتياطي — عرض» فقط)، وليس حساب المالك.\n')
    email = input('البريد الإلكتروني لحساب النسخ: ').strip()
    while True:
        pw = getpass.getpass('كلمة المرور (لا تظهر أثناء الكتابة): ')
        if pw and pw == getpass.getpass('أعد كتابة كلمة المرور: '): break
        print('غير متطابقة، حاول مرة أخرى.')
    c = conf()
    c['dir'] = input(f"مجلد حفظ النسخ [{c['dir']}]: ").strip() or c['dir']
    c['mirror_dir'] = input('مجلد نسخة ثانية، مثل قرص خارجي (اختياري، Enter للتخطي): ').strip() or c.get('mirror_dir', '')
    CFG_DIR.mkdir(parents=True, exist_ok=True); os.chmod(CFG_DIR, 0o700)
    fd = os.open(CRED, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as f: json.dump({'email': email, 'password': pw}, f)
    CONF.write_text(json.dumps(c, ensure_ascii=False, indent=2), encoding='utf-8')
    print('\nأجرّب الدخول ونسخة أولى…')
    code = run()
    print('\nتم الإعداد ✓ — الخطوة التالية: python3 craftland-backup.py install' if code == 0 else '\nالإعداد حُفظ، لكن النسخة الأولى فشلت — راجع الرسالة أعلاه.')
    return code


UNIT = HOME / '.config' / 'systemd' / 'user'


def install():
    UNIT.mkdir(parents=True, exist_ok=True)
    me = pathlib.Path(__file__).resolve()
    (UNIT / 'craftland-backup.service').write_text(f"""[Unit]
Description=Craft Land backup
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart={sys.executable} {me} run
Nice=10
""", encoding='utf-8')
    (UNIT / 'craftland-backup.timer').write_text("""[Unit]
Description=Craft Land nightly backup

[Timer]
OnCalendar=*-*-* 02:30
RandomizedDelaySec=15m
Persistent=true

[Install]
WantedBy=timers.target
""", encoding='utf-8')
    ok = True
    for cmd in (['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', '--now', 'craftland-backup.timer']):
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode: ok = False; print('تعذر:', ' '.join(cmd), r.stderr.strip())
    r = subprocess.run(['loginctl', 'enable-linger', getpass.getuser()], capture_output=True, text=True)
    if r.returncode: print(f'لتعمل النسخ حتى بدون تسجيل دخول، نفّذ مرة واحدة: sudo loginctl enable-linger {getpass.getuser()}')
    if ok: print('✓ النسخ التلقائي مفعّل: كل ليلة الساعة 2:30 تقريباً (بتوقيت هذا الكمبيوتر).\n  لو كان الجهاز مطفأ وقتها، تُعمل النسخة أول ما يشتغل.')
    else: print(f'بديل بدون systemd — أضف هذا السطر عبر crontab -e:\n30 2 * * * {sys.executable} {me} run')
    return 0 if ok else 1


def uninstall():
    subprocess.run(['systemctl', '--user', 'disable', '--now', 'craftland-backup.timer'], capture_output=True)
    for n in ('craftland-backup.service', 'craftland-backup.timer'): (UNIT / n).unlink(missing_ok=True)
    subprocess.run(['systemctl', '--user', 'daemon-reload'], capture_output=True)
    print('أُوقف النسخ التلقائي. النسخ المحفوظة لم تُحذف.'); return 0


def status():
    c = conf(); d = pathlib.Path(c['dir']); files = sorted(d.glob(PREFIX + '*.json.gz'), reverse=True)
    print(f"الشركة: {COMPANY}\nالمجلد: {d}\nعدد النسخ: {len(files)}")
    if (d / 'last_ok.json').exists():
        l = json.loads((d / 'last_ok.json').read_text(encoding='utf-8')); print(f"آخر نسخة ناجحة: {l['at']} — {l['file']} ({l['rows']:,} سجل)")
    else: print('لا توجد نسخة ناجحة بعد.')
    r = subprocess.run(['systemctl', '--user', 'list-timers', 'craftland-backup.timer', '--no-pager'], capture_output=True, text=True)
    print(r.stdout.strip() or 'التشغيل التلقائي غير مفعّل (شغّل install).')
    return 0


def verify(path=None):
    d = pathlib.Path(conf()['dir'])
    p = pathlib.Path(path) if path else next(iter(sorted(d.glob(PREFIX + '*.json.gz'), reverse=True)), None)
    if not p or not p.exists(): print('لا يوجد ملف للتحقق.'); return 1
    s = pathlib.Path(str(p) + '.sha256')
    if s.exists() and s.read_text().split()[0] != sha256(p): print(f'✗ {p.name}: البصمة لا تطابق — الملف تالف أو معدّل'); return 1
    with gzip.open(p, 'rb') as f: b, rows, tables = check_backup(f.read())
    print(f"✓ {p.name} سليم — {b['org'].get('name_ar')} — {b.get('exported_at', '')[:16]} — {tables} جدول، {rows:,} سجل")
    return 0


def main():
    ap = argparse.ArgumentParser(description='النسخ الاحتياطي لكرافت لاند')
    ap.add_argument('cmd', choices=['setup', 'run', 'install', 'uninstall', 'status', 'verify'])
    ap.add_argument('file', nargs='?')
    a = ap.parse_args()
    if '__URL__' in URL or '__ORG__' in ORG: print('هذا الملف قالب — حمّله من التطبيق: الإعدادات ← النسخ الاحتياطي'); return 2
    return {'setup': setup, 'run': run, 'install': install, 'uninstall': uninstall, 'status': status, 'verify': lambda: verify(a.file)}[a.cmd]()


if __name__ == '__main__':
    sys.exit(main())
