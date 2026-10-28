#!/usr/bin/env python3
"""ShareCost — dependency-free shared ledger server."""
import argparse
import datetime as dt
import hashlib
import hmac
import json
import mimetypes
import os
from pathlib import Path
import re
import secrets
import sqlite3
import time
from decimal import Decimal, InvalidOperation
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
DB = Path(os.environ.get('SHARECOST_DB', ROOT / 'data' / 'sharecost.sqlite3'))
CATEGORIES = ['餐饮', '购物', '交通', '住房', '娱乐', '旅行', '健康', '日用', '工资', '其他']
SCHEMA = '''
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,password TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS books(id TEXT PRIMARY KEY,name TEXT NOT NULL,currency TEXT NOT NULL,budget INTEGER NOT NULL,owner_id TEXT NOT NULL,invite TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS members(book_id TEXT NOT NULL,user_id TEXT NOT NULL,PRIMARY KEY(book_id,user_id));
CREATE TABLE IF NOT EXISTS entries(id TEXT PRIMARY KEY,book_id TEXT NOT NULL,creator_id TEXT NOT NULL,payer_id TEXT NOT NULL,kind TEXT NOT NULL,amount INTEGER NOT NULL,category TEXT NOT NULL,note TEXT NOT NULL,date TEXT NOT NULL,created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS shares(entry_id TEXT NOT NULL,user_id TEXT NOT NULL,amount INTEGER NOT NULL,PRIMARY KEY(entry_id,user_id));
CREATE TABLE IF NOT EXISTS settlements(id TEXT PRIMARY KEY,book_id TEXT NOT NULL,from_id TEXT NOT NULL,to_id TEXT NOT NULL,amount INTEGER NOT NULL,date TEXT NOT NULL,creator_id TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS entries_book ON entries(book_id);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires);
'''

class ApiError(Exception):
    def __init__(self, message, status=400):
        self.message, self.status = message, status

def connect():
    db = sqlite3.connect(DB, timeout=10)
    db.row_factory = sqlite3.Row
    return db

def init_db():
    DB.parent.mkdir(parents=True, exist_ok=True)
    with connect() as db:
        db.executescript(SCHEMA)
        db.execute('PRAGMA journal_mode=WAL')
    os.chmod(DB, 0o600)

def uid():
    return secrets.token_hex(12)

def password_hash(password, salt=None):
    salt = salt or secrets.token_hex(16)
    return salt + ':' + hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 310000).hex()

def money(value, allow_zero=False):
    try:
        value = Decimal(str(value))
        if not value.is_finite() or value < 0 or value > 100000000 or value * 100 != (value * 100).to_integral_value():
            raise ValueError()
        cents = int(value * 100)
        if not allow_zero and cents == 0:
            raise ValueError()
        return cents
    except (InvalidOperation, ValueError, TypeError):
        raise ApiError('请输入有效金额，最多两位小数，且不超过一亿元')

def clean(value, label, maximum=80):
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > maximum:
        raise ApiError(f'{label}不能为空，且最多 {maximum} 个字符')
    return value.strip()

def get_balances(db, book_id):
    balances = {r['user_id']: 0 for r in db.execute('SELECT user_id FROM members WHERE book_id=?', (book_id,))}
    for entry in db.execute('SELECT * FROM entries WHERE book_id=?', (book_id,)):
        sign = 1 if entry['kind'] == 'expense' else -1
        balances[entry['payer_id']] += sign * entry['amount']
        for share in db.execute('SELECT * FROM shares WHERE entry_id=?', (entry['id'],)):
            balances[share['user_id']] -= sign * share['amount']
    for s in db.execute('SELECT * FROM settlements WHERE book_id=?', (book_id,)):
        balances[s['from_id']] += s['amount']
        balances[s['to_id']] -= s['amount']
    return balances

def transfers(balances):
    debtors = [[u, -v] for u, v in balances.items() if v < 0]
    creditors = [[u, v] for u, v in balances.items() if v > 0]
    result = []
    for debtor in debtors:
        for creditor in creditors:
            amount = min(debtor[1], creditor[1])
            if amount:
                result.append(dict(from_id=debtor[0], to_id=creditor[0], amount=amount))
                debtor[1] -= amount
                creditor[1] -= amount
    return result

class Handler(BaseHTTPRequestHandler):
    server_version = 'ShareCost'

    def log_message(self, fmt, *args):
        # Do not log invite codes, request bodies or credentials.
        pass

    def send_json(self, obj, status=200, cookie=None):
        payload = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        if cookie:
            self.send_header('Set-Cookie', cookie)
        self.end_headers()
        self.wfile.write(payload)

    def body(self):
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length > 65536 or length <= 0:
                raise ValueError()
            result = json.loads(self.rfile.read(length))
            if not isinstance(result, dict):
                raise ValueError()
            return result
        except (ValueError, UnicodeDecodeError):
            raise ApiError('请求格式不正确')

    def token(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get('Cookie', ''))
            return cookie['sharecost_session'].value
        except (KeyError, Exception):
            return ''

    def user(self, db):
        user = db.execute('SELECT u.id,u.name,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?', (hashlib.sha256(self.token().encode()).hexdigest(), int(time.time()))).fetchone()
        if not user:
            raise ApiError('请先登录', 401)
        return dict(user)

    def member(self, db, book_id, user_id):
        if not db.execute('SELECT 1 FROM members WHERE book_id=? AND user_id=?', (book_id, user_id)).fetchone():
            raise ApiError('你无权访问这个账本', 403)
        return db.execute('SELECT * FROM books WHERE id=?', (book_id,)).fetchone()

    def do_GET(self):
        try:
            path = urlparse(self.path).path
            if path == '/api/me':
                with connect() as db:
                    self.send_json({'user': self.user(db)})
            elif path == '/api/books':
                with connect() as db:
                    user = self.user(db)
                    books = [dict(r) for r in db.execute('SELECT b.* FROM books b JOIN members m ON m.book_id=b.id WHERE m.user_id=? ORDER BY b.rowid', (user['id'],))]
                    self.send_json({'books': books})
            elif re.fullmatch(r'/api/books/[a-f0-9]+', path):
                with connect() as db:
                    user = self.user(db)
                    book_id = path.rsplit('/', 1)[1]
                    book = dict(self.member(db, book_id, user['id']))
                    members = [dict(r) for r in db.execute('SELECT u.id,u.name FROM users u JOIN members m ON m.user_id=u.id WHERE m.book_id=? ORDER BY m.rowid', (book_id,))]
                    entries = [dict(r) for r in db.execute('SELECT * FROM entries WHERE book_id=? ORDER BY date DESC,created DESC,rowid DESC', (book_id,))]
                    all_shares = {}
                    for r in db.execute('SELECT s.* FROM shares s JOIN entries e ON e.id=s.entry_id WHERE e.book_id=?', (book_id,)):
                        all_shares.setdefault(r['entry_id'], []).append({'user_id': r['user_id'], 'amount': r['amount']})
                    for e in entries:
                        e['shares'] = all_shares.get(e['id'], [])
                    settlements = [dict(r) for r in db.execute('SELECT * FROM settlements WHERE book_id=? ORDER BY rowid DESC', (book_id,))]
                    balances = get_balances(db, book_id)
                    self.send_json(dict(book=book, members=members, entries=entries, settlements=settlements, balances=balances, transfers=transfers(balances)))
            elif path.startswith('/api/'):
                raise ApiError('接口不存在', 404)
            else:
                files = {'/': 'index.html', '/app.js': 'app.js', '/i18n.js': 'i18n.js', '/config.js': 'config.js', '/backend.js': 'backend.js', '/style.css': 'style.css'}
                filename = files.get(path)
                if not filename:
                    raise ApiError('页面不存在', 404)
                data = (ROOT / 'web' / filename).read_bytes()
                self.send_response(200)
                self.send_header('Content-Type', mimetypes.guess_type(filename)[0] + '; charset=utf-8')
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Cache-Control', 'no-cache')
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.send_header('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
                self.end_headers()
                self.wfile.write(data)
        except ApiError as e:
            self.send_json({'error': e.message}, e.status)

    def do_POST(self):
        try:
            origin = self.headers.get('Origin')
            if origin and (urlparse(origin).netloc != self.headers.get('Host') or urlparse(origin).scheme not in ('http', 'https')):
                raise ApiError('请求来源无效', 403)
            if 'application/json' not in self.headers.get('Content-Type', ''):
                raise ApiError('请使用 JSON 请求', 415)
            path = urlparse(self.path).path
            data = self.body()
            with connect() as db:
                if path in ('/api/register', '/api/login'):
                    # Bound password work per source IP, shared across both endpoints.
                    now = time.time()
                    with self.server.rate_lock:
                        attempts = [t for t in self.server.attempts.get(self.client_address[0], []) if now - t < 60]
                        if len(attempts) >= 20:
                            raise ApiError('尝试过于频繁，请一分钟后再试', 429)
                        self.server.attempts[self.client_address[0]] = attempts + [now]
                    email = clean(data.get('email'), '邮箱', 160).lower()
                    password = data.get('password', '')
                    if not isinstance(password, str) or not 8 <= len(password) <= 128:
                        raise ApiError('密码需要 8–128 个字符')
                    if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', email):
                        raise ApiError('请输入有效邮箱')
                    if path == '/api/register':
                        name = clean(data.get('name'), '昵称', 24)
                        user_id = uid()
                        try:
                            db.execute('INSERT INTO users VALUES(?,?,?,?)', (user_id, name, email, password_hash(password)))
                        except sqlite3.IntegrityError:
                            raise ApiError('该邮箱已经注册，请直接登录')
                    else:
                        row = db.execute('SELECT * FROM users WHERE email=?', (email,)).fetchone()
                        expected = row['password'] if row else password_hash('dummy-password', '0' * 32)
                        if not hmac.compare_digest(password_hash(password, expected.split(':')[0]), expected) or not row:
                            raise ApiError('邮箱或密码不正确', 401)
                        user_id = row['id']
                    token = secrets.token_urlsafe(32)
                    db.execute('DELETE FROM sessions WHERE expires<?', (int(time.time()),))
                    db.execute('INSERT INTO sessions VALUES(?,?,?)', (hashlib.sha256(token.encode()).hexdigest(), user_id, int(time.time()) + 604800))
                    db.commit()
                    self.send_json({'ok': True}, cookie=f'sharecost_session={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800')
                    return
                user = self.user(db)
                if path == '/api/logout':
                    db.execute('DELETE FROM sessions WHERE token=?', (hashlib.sha256(self.token().encode()).hexdigest(),))
                    db.commit()
                    self.send_json({'ok': True}, cookie='sharecost_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0')
                    return
                if path == '/api/books':
                    name = clean(data.get('name'), '账本名称', 32)
                    currency = data.get('currency', 'CNY')
                    if currency not in ['CNY', 'CAD', 'USD', 'EUR', 'HKD', 'JPY']:
                        raise ApiError('不支持该币种')
                    book_id = uid()
                    db.execute('INSERT INTO books VALUES(?,?,?,?,?,?)', (book_id, name, currency, money(data.get('budget', 0), True), user['id'], secrets.token_hex(6).upper()))
                    db.execute('INSERT INTO members VALUES(?,?)', (book_id, user['id']))
                    result = {'id': book_id}
                elif path == '/api/join':
                    invite = clean(data.get('invite'), '邀请码', 32).upper()
                    book = db.execute('SELECT id FROM books WHERE invite=?', (invite,)).fetchone()
                    if not book:
                        raise ApiError('邀请码不正确，请向账本创建者确认')
                    db.execute('INSERT OR IGNORE INTO members VALUES(?,?)', (book['id'], user['id']))
                    result = {'id': book['id']}
                else:
                    # Serialize balance reads and writes to prevent duplicate over-settlement.
                    db.execute('BEGIN IMMEDIATE')
                    book_id = data.get('book_id')
                    book = self.member(db, book_id, user['id'])
                    if path == '/api/budget':
                        if book['owner_id'] != user['id']:
                            raise ApiError('只有账本创建者可以设置预算', 403)
                        db.execute('UPDATE books SET budget=? WHERE id=?', (money(data.get('budget'), True), book_id))
                    elif path == '/api/invite/rotate':
                        if book['owner_id'] != user['id']:
                            raise ApiError('只有账本创建者可以更换邀请码', 403)
                        db.execute('UPDATE books SET invite=? WHERE id=?', (secrets.token_hex(6).upper(), book_id))
                    elif path in ('/api/entries', '/api/entries/update'):
                        entry_id = data.get('id') if path.endswith('/update') else uid()
                        if path.endswith('/update'):
                            old = db.execute('SELECT * FROM entries WHERE id=? AND book_id=?', (entry_id, book_id)).fetchone()
                            if not old or user['id'] not in (old['creator_id'], book['owner_id']):
                                raise ApiError('只有记录者或账本创建者可以修改', 403)
                        amount = money(data.get('amount'))
                        kind = data.get('kind')
                        if kind not in ('expense', 'income') or data.get('category') not in CATEGORIES:
                            raise ApiError('请选择有效的收支类型和分类')
                        payer = data.get('payer_id')
                        self.member(db, book_id, payer)
                        date = data.get('date', '')
                        try:
                            if dt.date.fromisoformat(date).isoformat() != date:
                                raise ValueError()
                        except (ValueError, TypeError):
                            raise ApiError('日期无效')
                        note = data.get('note', '')
                        if not isinstance(note, str) or len(note) > 200:
                            raise ApiError('备注最多 200 个字符')
                        participants = data.get('participants')
                        if not isinstance(participants, list) or not participants or len(participants) > 100 or any(not isinstance(p, str) for p in participants) or len(set(participants)) != len(participants):
                            raise ApiError('请至少选择一位分摊成员，成员不能重复')
                        for p in participants:
                            self.member(db, book_id, p)
                        if data.get('split_mode') == 'custom':
                            custom = data.get('custom', {})
                            if not isinstance(custom, dict):
                                raise ApiError('分摊格式不正确')
                            shares = {p: money(custom.get(p, 0), True) for p in participants}
                            if sum(shares.values()) != amount:
                                raise ApiError('各成员分摊金额之和必须等于总金额')
                        elif data.get('split_mode') == 'equal':
                            base, extra = divmod(amount, len(participants))
                            shares = {p: base + (i < extra) for i, p in enumerate(participants)}
                        else:
                            raise ApiError('分摊方式无效')
                        if path.endswith('/update'):
                            db.execute('DELETE FROM shares WHERE entry_id=?', (entry_id,))
                            db.execute('UPDATE entries SET payer_id=?,kind=?,amount=?,category=?,note=?,date=? WHERE id=?', (payer, kind, amount, data['category'], note, date, entry_id))
                        else:
                            db.execute('INSERT INTO entries VALUES(?,?,?,?,?,?,?,?,?,?)', (entry_id, book_id, user['id'], payer, kind, amount, data['category'], note, date, time.time_ns()))
                        db.executemany('INSERT INTO shares VALUES(?,?,?)', [(entry_id, p, value) for p, value in shares.items()])
                    elif path == '/api/entries/delete':
                        entry = db.execute('SELECT * FROM entries WHERE id=? AND book_id=?', (data.get('id'), book_id)).fetchone()
                        if not entry:
                            raise ApiError('账单不存在', 404)
                        if user['id'] not in (entry['creator_id'], book['owner_id']):
                            raise ApiError('只有记录者或账本创建者可以删除', 403)
                        db.execute('DELETE FROM shares WHERE entry_id=?', (entry['id'],))
                        db.execute('DELETE FROM entries WHERE id=?', (entry['id'],))
                    elif path == '/api/settlements':
                        from_id, to_id = data.get('from_id'), data.get('to_id')
                        if user['id'] not in (from_id, to_id, book['owner_id']):
                            raise ApiError('只有转账双方或账本创建者可以确认结算', 403)
                        amount = money(data.get('amount'))
                        balances = get_balances(db, book_id)
                        if from_id == to_id or amount > min(-balances.get(from_id, 0), balances.get(to_id, 0)):
                            raise ApiError('待结算金额已变化，请刷新后重试')
                        db.execute('INSERT INTO settlements VALUES(?,?,?,?,?,?,?)', (uid(), book_id, from_id, to_id, amount, dt.date.today().isoformat(), user['id']))
                    else:
                        raise ApiError('接口不存在', 404)
                    result = {'ok': True}
                db.commit()
                self.send_json(result)
        except ApiError as e:
            self.send_json({'error': e.message}, e.status)
        except (sqlite3.Error, TypeError, KeyError) as e:
            self.send_json({'error': '操作未完成，请刷新后重试'}, 400)

def main():
    import threading
    parser = argparse.ArgumentParser(description='ShareCost 共享记账')
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    init_db()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.attempts, server.rate_lock = {}, threading.Lock()
    print(f'\n  ShareCost 已启动 → http://{args.host}:{args.port}\n  按 Ctrl+C 停止。\n', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()

if __name__ == '__main__':
    main()
