"""Tests the Linux backup program (tools/craftland-backup.py) against a stand-in for Supabase's
auth + REST endpoints that runs export_org on a real database with the backup user's permissions.
Run: python3 tests/test_backup_script.py"""
import http.server, threading, json, pathlib, subprocess, sys, tempfile, os, gzip, importlib.util, datetime

ROOT = pathlib.Path(__file__).resolve().parent.parent
DB = 'bkdb'
def sh(cmd, **kw): return subprocess.run(cmd, shell=True, check=True, capture_output=True, text=True, **kw)
def sql(q): return sh(f"runuser -u postgres -- psql -X -q -t -A -v ON_ERROR_STOP=1 -d {DB}", input=q).stdout.strip()
results = []
def check(name, cond, extra=''):
    results.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + name + (f'  [{extra}]' if extra and not cond else ''), flush=True)

subprocess.run('pg_ctlcluster 16 main start', shell=True, capture_output=True)
sh(f"runuser -u postgres -- dropdb --if-exists {DB}"); sh(f"runuser -u postgres -- createdb {DB}")
sh(f"runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -d {DB} -f {ROOT}/tests/supabase_sim.sql -f {ROOT}/supabase/setup.sql")
OWNER, BKU = '00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000b1'
org = sql(f"""insert into platform_admins values ('owner@example.com');
  insert into auth.users values ('{OWNER}', 'owner@example.com');
  select set_config('request.jwt.claims', '{{"sub":"{OWNER}"}}', false);
  select create_org('كرافت لاند', '300000000000003');""").splitlines()[-1]
sql(f"""select set_config('request.jwt.claims', '{{"sub":"{OWNER}"}}', false);
  select invite_member('{org}', 'backup@example.com', save_role('{org}', null, 'النسخ الاحتياطي', '{{"backup":["view"]}}'));
  insert into auth.users values ('{BKU}', 'backup@example.com');
  select set_config('request.jwt.claims', '{{"sub":"{BKU}"}}', false); select accept_invitations();
  insert into documents (org_id, branch_id, kind) select '{org}', branch_id, 'quote' from warehouses where org_id = '{org}' limit 1;""")
PASSWORD = 'Secret-123'
calls = []

class Fake(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def reply(self, code, body):
        b = body.encode() if isinstance(body, str) else body
        self.send_response(code); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'] or 0)) or b'{}'); calls.append((self.path, self.headers.get('apikey')))
        if self.headers.get('apikey') != 'pub-key': return self.reply(401, '{"message":"no api key"}')
        if self.path.startswith('/auth/v1/token'):
            ok = body.get('email') == 'backup@example.com' and body.get('password') == PASSWORD
            return self.reply(200, json.dumps({'access_token': BKU})) if ok else self.reply(400, '{"error":"invalid_grant","error_description":"Invalid login credentials"}')
        if self.path == '/rest/v1/rpc/export_org':
            uid = (self.headers.get('Authorization') or '').replace('Bearer ', '')
            try:
                out = sql(f"""begin; select set_config('request.jwt.claims', json_build_object('sub', '{uid}')::text, true) \\g /dev/null
                  set local role authenticated;
                  select export_org('{body['p_org']}', '{body['p_source']}')::text; commit;""")
                return self.reply(200, out.splitlines()[-1] if out else 'null')
            except subprocess.CalledProcessError as e:
                return self.reply(400, json.dumps({'message': e.stderr.strip()[-200:]}))
        self.reply(404, '{}')

srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8799), Fake); threading.Thread(target=srv.serve_forever, daemon=True).start()
tmp = pathlib.Path(tempfile.mkdtemp()); cfg = tmp / 'cfg'; cfg.mkdir(); bdir = tmp / 'backups'; usb = tmp / 'usb'; usb.mkdir()
src = (ROOT / 'tools' / 'craftland-backup.py').read_text(encoding='utf-8')
prog = tmp / 'craftland-backup.py'
prog.write_text(src.replace("URL = '__URL__'", 'URL = "http://127.0.0.1:8799"').replace("KEY = '__KEY__'", 'KEY = "pub-key"')
                .replace("ORG = '__ORG__'", f'ORG = "{org}"').replace("COMPANY = '__NAME__'", 'COMPANY = "كرافت لاند"'), encoding='utf-8')
(cfg / 'credentials.json').write_text(json.dumps({'email': 'backup@example.com', 'password': PASSWORD})); os.chmod(cfg / 'credentials.json', 0o600)
(cfg / 'config.json').write_text(json.dumps({'dir': str(bdir), 'keep_daily': 30, 'keep_monthly': 12, 'mirror_dir': str(usb)}))
env = {**os.environ, 'CRAFTLAND_BACKUP_CONFIG': str(cfg), 'CRAFTLAND_BACKUP_RETRY_WAIT': '0'}
run = lambda *a: subprocess.run([sys.executable, str(prog), *a], capture_output=True, text=True, env=env)

tpl = subprocess.run([sys.executable, str(ROOT / 'tools' / 'craftland-backup.py'), 'run'], capture_output=True, text=True)
check('the template refuses to run until downloaded from the app', tpl.returncode == 2 and 'قالب' in tpl.stdout, tpl.stdout)

r = run('run')
files = sorted(bdir.glob('craftland-*.json.gz'))
check('backup succeeds with the backup-only account', r.returncode == 0 and len(files) == 1, r.stdout + r.stderr)
b = json.loads(gzip.decompress(files[0].read_bytes())) if files else {}
check('file is a complete backup of this company', b.get('format') == 'craftland-backup' and b.get('org_id') == org and len(b['tables']['accounts']) > 50 and len(b['tables']['documents']) == 1)
check('fingerprint written and copy on the second disk', (pathlib.Path(str(files[0]) + '.sha256')).exists() and len(list(usb.glob('craftland-*.json.gz'))) == 1)
check('last success recorded and logged', json.loads((bdir / 'last_ok.json').read_text())['file'] == files[0].name and '✓ نسخة ناجحة' in (bdir / 'backup.log').read_text())
check('server logged a «script» backup', sql(f"select count(*) from backup_log where org_id = '{org}' and source = 'script'") == '1')
check('every call carried the publishable key', all(k == 'pub-key' for _, k in calls))
check('verify confirms the newest file', run('verify').returncode == 0)
st = run('status'); check('status shows the backups', st.returncode == 0 and 'عدد النسخ: 1' in st.stdout, st.stdout)
with open(files[0], 'ab') as f: f.write(b'x')
v = run('verify'); check('a damaged file is detected', v.returncode == 1 and 'تالف' in v.stdout, v.stdout)

# the backup account can export but cannot read the company's screens
seen = sql(f"""begin; select set_config('request.jwt.claims', '{{"sub":"{BKU}"}}', true) \\g /dev/null
  set local role authenticated; select count(*) from documents; commit;""").splitlines()[-1]
check('backup account sees no documents directly (export only)', seen == '0', seen)

PASSWORD = 'changed'
r = run('run'); check('wrong password: fails clearly after retries, exit code 1', r.returncode == 1 and 'فشل النسخ الاحتياطي' in r.stdout and r.stdout.count('المحاولة') == 3, r.stdout[-300:])
check('no half-written files left behind', not list(bdir.glob('*.part')))

# rotation: 30 newest daily + one per month for the 12 months before them
spec = importlib.util.spec_from_file_location('bk', prog); bk = importlib.util.module_from_spec(spec); spec.loader.exec_module(bk)
rot = tmp / 'rot'; rot.mkdir(); start = datetime.date(2026, 11, 26)
for i in range(500):
    d = start - datetime.timedelta(days=i); (rot / f'craftland-{d.isoformat()}_0230.json.gz').write_bytes(b'x')
bk.rotate(rot, 30, 12)
left = sorted(p.name for p in rot.glob('*.json.gz'))
months = {n[10:17] for n in left}
check('rotation keeps 30 daily + 12 monthly', len(left) == 42 and left[-1] == 'craftland-2026-11-26_0230.json.gz' and len(months) == 14, (len(left), sorted(months)))

srv.shutdown()
print(f'{sum(results)}/{len(results)} passed')
sys.exit(0 if all(results) else 1)
