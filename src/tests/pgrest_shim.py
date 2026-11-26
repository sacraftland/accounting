"""A small stand-in for Supabase's REST + Auth, on the local test database.

The browser test swaps supabase-js for a tiny client (tests/fake_supabase.js)
that sends {table, ops} here. Every request runs as role "authenticated" with
the signed-in user's id in request.jwt.claims — exactly how Supabase runs it —
so RLS, grants, triggers and RPCs are the real ones from supabase/setup.sql.
Sign-up inserts into auth.users, so the invite-only gate trigger is real too.
Run: python3 tests/pgrest_shim.py <port> <db>
"""
import json, re, subprocess, sys, uuid, http.server, threading

DB = sys.argv[2] if len(sys.argv) > 2 else 'sbtest'
IDENT = re.compile(r'^[a-z_][a-z0-9_]*$')
_types, _fks, _procs = {}, {}, {}
lock = threading.Lock()

def lit(v):
    if v is None: return 'NULL'
    if isinstance(v, bool): return 'true' if v else 'false'
    if isinstance(v, (int, float)): return repr(v)
    if isinstance(v, (dict, list)): v = json.dumps(v, ensure_ascii=False)
    return "'" + str(v).replace("'", "''") + "'"

def ident(s):
    if not IDENT.match(s): raise ValueError('bad identifier ' + s)
    return s

def psql(sql, sub=None, role='authenticated'):
    if not sub and role == 'authenticated': role = 'anon'
    claims = json.dumps({'sub': sub, 'role': role}) if sub else ''
    script = ('\\set ON_ERROR_STOP 1\n\\o /dev/null\nbegin;\n'
              + (f"set local role {role};\n" if role else '')
              + f"select set_config('request.jwt.claims', {lit(claims)}, true);\n\\o\n"
              + sql.rstrip(';') + ";\ncommit;\n")
    p = subprocess.run(['runuser', '-u', 'postgres', '--', 'psql', '-X', '-q', '-t', '-A', '-d', DB],
                       input=script, capture_output=True, text=True)
    if p.returncode != 0:
        m = re.search(r'ERROR:\s+(.*)', p.stderr)
        raise RuntimeError(m.group(1).strip() if m else p.stderr.strip())
    out = '\n'.join(l for l in p.stdout.splitlines() if l.strip() and l.strip() not in ('COMMIT', 'BEGIN'))
    return json.loads(out) if out else None

def admin(sql): return psql(sql, None, None)

def coltypes(t):
    if t not in _types:
        rows = admin(f"select json_object_agg(attname, format_type(atttypid, atttypmod)) from pg_attribute "
                     f"where attrelid = 'public.{ident(t)}'::regclass and attnum > 0 and not attisdropped")
        _types[t] = rows or {}
    return _types[t]

def fk(base, other):
    """column on `base` pointing at `other`, or ('many', col on other pointing at base)"""
    key = (base, other)
    if key not in _fks:
        q = lambda a, b: admin(f"""select json_agg(a.attname) from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
            where c.contype = 'f' and c.conrelid = 'public.{a}'::regclass and c.confrelid = 'public.{b}'::regclass""") or []
        one = q(ident(base), ident(other))
        _fks[key] = ('one', one[0]) if one else ('many', (q(ident(other), ident(base)) or [None])[0])
    return _fks[key]

def split_top(s):
    parts, depth, cur = [], 0, ''
    for ch in s:
        if ch == '(': depth += 1
        if ch == ')': depth -= 1
        if ch == ',' and depth == 0: parts.append(cur.strip()); cur = ''
        else: cur += ch
    if cur.strip(): parts.append(cur.strip())
    return parts

def select_list(t, cols, alias):
    out = []
    for c in split_top(cols or '*'):
        m = re.match(r'^([a-z_]+)\((.*)\)$', c)
        if m:
            other, sub = m.group(1), m.group(2)
            kind, col = fk(t, other)
            inner = select_list(other, sub, 'e')
            if kind == 'one':
                out.append(f"(select to_jsonb(x) from (select {inner} from {ident(other)} e where e.id = {alias}.{ident(col)}) x) as {ident(other)}")
            else:
                out.append(f"(select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (select {inner} from {ident(other)} e where e.{ident(col)} = {alias}.id) x) as {ident(other)}")
        elif c == '*': out.append(f'{alias}.*')
        else: out.append(f'{alias}.{ident(c)}')
    return ', '.join(out)

def where(ops, alias):
    w = []
    for op, args in ops:
        if op in ('eq', 'neq', 'gt', 'gte', 'lt', 'lte'):
            sym = {'eq': '=', 'neq': '<>', 'gt': '>', 'gte': '>=', 'lt': '<', 'lte': '<='}[op]
            w.append(f"{alias}.{ident(args[0])} {sym} {lit(args[1])}")
        elif op == 'in':
            vals = ', '.join(lit(v) for v in args[1]) or 'NULL'
            w.append(f"{alias}.{ident(args[0])} in ({vals})")
        elif op == 'is':
            w.append(f"{alias}.{ident(args[0])} is {'null' if args[1] is None else lit(args[1])}")
        elif op == 'not' and args[1] == 'is':
            w.append(f"{alias}.{ident(args[0])} is not null")
    return (' where ' + ' and '.join(w)) if w else ''

def tail(ops, alias):
    o, lim = [], ''
    for op, args in ops:
        if op == 'order':
            asc = (args[1] or {}).get('ascending', True) if len(args) > 1 else True
            o.append(f"{alias}.{ident(args[0])} {'asc' if asc else 'desc'}")
        if op == 'limit': lim = f' limit {int(args[0])}'
    return (' order by ' + ', '.join(o) if o else '') + lim

def cast(src, c, ty):
    if ty.startswith('json'): return f"({src}->{lit(c)})::{ty}"
    if ty.endswith('[]'): return f"(select array_agg(x::{ty[:-2]}) from json_array_elements_text({src}->{lit(c)}) x)"
    return f"({src}->>{lit(c)})::{ty}"

def typed(t, cols, src='j'):
    ty = coltypes(t)
    return ', '.join(cast(src, c, ty[c]) for c in cols)

def run(req):
    sub = req.get('sub')
    if 'rpc' in req:
        fn, args = ident(req['rpc']), req.get('args') or {}
        if fn not in _procs:
            _procs[fn] = admin(f"select to_json(proretset) from pg_proc where proname = {lit(fn)} and pronamespace = 'public'::regnamespace limit 1")
        call = f"{fn}(" + ', '.join(f"{ident(k)} => {lit(v)}" for k, v in args.items()) + ")"
        sql = f"select coalesce(json_agg(r), '[]') from {call} r" if _procs[fn] else f"select to_json({call})"
        return psql(sql, sub)
    t, ops = ident(req['table']), req['ops']
    names = [o[0] for o in ops]
    sel = next((o[1][0] if o[1] else '*' for o in ops if o[0] == 'select'), None)
    single = 'single' in names; maybe = 'maybeSingle' in names
    mut = next((o for o in ops if o[0] in ('insert', 'upsert', 'update', 'delete')), None)
    if mut is None:
        sql = f"select coalesce(json_agg(r), '[]') from (select {select_list(t, sel, 't0')} from {t} t0{where(ops, 't0')}{tail(ops, 't0')}) r"
        rows = psql(sql, sub)
    else:
        kind, args = mut
        ret = 'returning *'
        if kind in ('insert', 'upsert'):
            rows_in = args[0] if isinstance(args[0], list) else [args[0]]
            stmts = []
            for r in rows_in:
                cols = [ident(c) for c in r.keys() if r[c] is not None or kind == 'upsert']
                cols = [c for c in cols if c in coltypes(t)]
                j = lit(r)
                ins = f"insert into {t} ({', '.join(cols)}) select {typed(t, cols)} from (select {j}::json j) s"
                conf = (args[1] or {}).get('onConflict') if len(args) > 1 and isinstance(args[1], dict) else None
                if kind == 'upsert' and conf:
                    keys = [ident(k.strip()) for k in conf.split(',')]
                    upd = ', '.join(f"{c} = excluded.{c}" for c in cols if c not in keys and c != 'id')
                    ins += f" on conflict ({', '.join(keys)}) do update set {upd}" if upd else f" on conflict ({', '.join(keys)}) do nothing"
                elif kind == 'upsert' and 'id' in cols:
                    upd = ', '.join(f"{c} = excluded.{c}" for c in cols if c != 'id')
                    ins += f" on conflict (id) do update set {upd}"
                stmts.append(f"({ins} {ret})")
            sql = ("with " + ', '.join(f"m{i} as {s}" for i, s in enumerate(stmts)) +
                   " select coalesce(json_agg(r), '[]') from (" + ' union all '.join(f"select * from m{i}" for i in range(len(stmts))) + ") r")
        elif kind == 'update':
            row = args[0]; cols = [ident(c) for c in row.keys() if c in coltypes(t)]
            sets = ', '.join(f"{c} = {cast(lit(row) + '::json', c, coltypes(t)[c])}" for c in cols)
            sql = f"with m as (update {t} t0 set {sets}{where(ops, 't0')} {ret}) select coalesce(json_agg(m), '[]') from m"
        else:
            sql = f"with m as (delete from {t} t0{where(ops, 't0')} {ret}) select coalesce(json_agg(m), '[]') from m"
        rows = psql(sql, sub)
        if sel is None: return None
        if sel not in ('*', None) and rows:
            ids = [r['id'] for r in rows if 'id' in r]
            if ids:
                rows = psql(f"select coalesce(json_agg(r), '[]') from (select {select_list(t, sel, 't0')} from {t} t0 where t0.id in ({', '.join(lit(i) for i in ids)})) r", sub)
    if single:
        if len(rows) != 1: raise RuntimeError('JSON object requested, multiple (or no) rows returned')
        return rows[0]
    if maybe:
        if len(rows) > 1: raise RuntimeError('JSON object requested, multiple (or no) rows returned')
        return rows[0] if rows else None
    return rows

def auth(req):
    a = req['action']; email = (req.get('email') or '').strip().lower()
    if a == 'signup':
        exists = admin(f"select to_json(id) from auth.users where lower(email) = {lit(email)}")
        if exists: return {'user': {'id': exists, 'email': email, 'identities': []}, 'session': None}
        uid = str(uuid.uuid4())
        try: admin(f"insert into auth.users (id, email) values ({lit(uid)}, {lit(email)})")
        except RuntimeError: raise RuntimeError('Database error saving new user')
        return {'user': {'id': uid, 'email': email, 'identities': [{}]}, 'session': {'user': {'id': uid, 'email': email}}}
    if a == 'signin':
        uid = admin(f"select to_json(id) from auth.users where lower(email) = {lit(email)}")
        if not uid: raise RuntimeError('Invalid login credentials')
        return {'user': {'id': uid, 'email': email}, 'session': {'user': {'id': uid, 'email': email}}}
    raise RuntimeError('unsupported')

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_OPTIONS(self):
        self.send_response(204); self.cors(); self.end_headers()
    def cors(self):
        self.send_header('Access-Control-Allow-Origin', '*'); self.send_header('Access-Control-Allow-Headers', '*'); self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        try:
            with lock: data = auth(req) if self.path == '/auth' else run(req)
            body = {'data': data, 'error': None}
        except Exception as e:
            body = {'data': None, 'error': {'message': str(e)}}
        b = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(200); self.cors(); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8790
    http.server.ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
