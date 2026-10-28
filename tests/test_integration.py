"""Real HTTP flows against a temporary database; no third-party packages."""
import concurrent.futures
from http.cookiejar import CookieJar
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.error import HTTPError
from urllib.request import build_opener, HTTPCookieProcessor, Request

ROOT = Path(__file__).resolve().parents[1]

class LedgerFlow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            cls.port = sock.getsockname()[1]
        cls.url = f'http://127.0.0.1:{cls.port}'
        cls.env = dict(os.environ, SHARECOST_DB=str(Path(cls.temp.name) / 'test.sqlite3'))
        cls.start_server()

    @classmethod
    def start_server(cls):
        cls.process = subprocess.Popen([sys.executable, str(ROOT / 'server.py'), '--port', str(cls.port)], env=cls.env, stdout=subprocess.DEVNULL)
        for _ in range(100):
            try:
                if build_opener().open(cls.url).status == 200:
                    return
            except OSError:
                time.sleep(.05)
        raise RuntimeError('Server did not start')

    @classmethod
    def tearDownClass(cls):
        cls.process.terminate()
        cls.process.wait()
        cls.temp.cleanup()

    def client(self):
        return build_opener(HTTPCookieProcessor(CookieJar()))

    def request(self, client, path, data=None, status=200, headers=None):
        req = Request(self.url + '/api' + path, data=json.dumps(data).encode() if data is not None else None, headers=headers or {'Content-Type': 'application/json'})
        try:
            res = client.open(req)
        except HTTPError as e:
            res = e
        self.assertEqual(res.status, status, res.read().decode() if res.status != status else '')
        return json.loads(res.read())

    def test_complete_shared_ledger_flow(self):
        a, b, c = [self.client() for _ in range(3)]
        self.request(a, '/me', status=401)
        for client, label in [(a,'alice'),(b,'bob'),(c,'cara')]:
            self.request(client, '/register', dict(name=label, email=f'{label}@example.com', password='a-password-123'))
        aid, bid, cid = [self.request(client, '/me')['user']['id'] for client in (a,b,c)]
        self.request(self.client(), '/login', dict(email='alice@example.com',password='wrong-password'), status=401)
        self.request(self.client(), '/register', dict(name='dup',email='alice@example.com',password='a-password-123'), status=400)
        book = self.request(a, '/books', dict(name='共同生活',currency='CNY',budget='5000'))['id']
        self.request(b, '/books/'+book, status=403)
        self.request(b, '/entries', dict(book_id=book), status=403)
        invite = self.request(a, '/books/'+book)['book']['invite']
        self.request(b, '/join', dict(invite='WRONG'), status=400)
        for client in (b,c):
            self.request(client, '/join', dict(invite=invite))
        entry = dict(book_id=book,amount='100.00',payer_id=aid,kind='expense',category='餐饮',note='三人午餐',date='2026-10-28',participants=[aid,bid,cid],split_mode='equal')
        self.request(a, '/entries', entry)
        data = self.request(b, '/books/'+book)
        self.assertEqual(sorted(s['amount'] for s in data['entries'][0]['shares']), [3333,3333,3334])
        self.assertEqual(data['balances'], {aid:6666,bid:-3333,cid:-3333})
        self.assertEqual(sum(data['balances'].values()), 0)
        expense_id = data['entries'][0]['id']
        self.request(b, '/entries/delete', dict(book_id=book,id=expense_id), status=403)
        self.request(b, '/entries/update', dict(entry,id=expense_id), status=403)
        self.request(b, '/budget', dict(book_id=book,budget=50), status=403)
        self.request(a, '/budget', dict(book_id=book,budget='6000'))
        self.request(a, '/entries', dict(entry,amount='0.001'), status=400)
        self.request(a, '/entries', dict(entry,amount='NaN'), status=400)
        self.request(a, '/entries', dict(entry,amount=True), status=400)
        self.request(a, '/entries', dict(entry,participants=[aid,aid]), status=400)
        self.request(a, '/entries', dict(entry,date='2026-02-30'), status=400)
        self.request(a, '/entries', dict(entry,split_mode='custom',custom={aid:'10',bid:'20',cid:'30'}), status=400)
        self.request(a, '/entries/update', dict(entry,id=expense_id,amount='120',split_mode='custom',custom={aid:'20',bid:'40',cid:'60'}))
        data = self.request(a, '/books/'+book)
        self.assertEqual(data['balances'], {aid:10000,bid:-4000,cid:-6000})
        self.request(c, '/settlements', dict(book_id=book,from_id=bid,to_id=aid,amount='40'), status=403)
        self.request(b, '/settlements', dict(book_id=book,from_id=bid,to_id=aid,amount='40'))
        self.request(b, '/settlements', dict(book_id=book,from_id=bid,to_id=aid,amount='40'), status=400)
        # Two concurrent confirmations of the same debt: exactly one succeeds.
        def settle_once(_):
            req = Request(self.url+'/api/settlements',data=json.dumps(dict(book_id=book,from_id=cid,to_id=aid,amount='60')).encode(), headers={'Content-Type':'application/json'})
            try:
                return c.open(req).status
            except HTTPError as e:
                return e.code
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            self.assertEqual(sorted(pool.map(settle_once,range(2))), [200,400])
        self.assertEqual(self.request(a, '/books/'+book)['transfers'], [])
        # Shared income reverses the expense direction, personal income has no debt.
        self.request(b, '/entries', dict(entry,amount='30',kind='income',payer_id=bid,participants=[aid,bid,cid]))
        data = self.request(a, '/books/'+book)
        self.assertEqual(data['balances'], {aid:1000,bid:-2000,cid:1000})
        income_id = next(e['id'] for e in data['entries'] if e['kind']=='income')
        self.request(a, '/entries/delete', dict(book_id=book,id=income_id))
        self.assertEqual(self.request(a, '/books/'+book)['transfers'], [])
        self.request(a, '/invite/rotate',dict(book_id=book))
        self.request(b, '/join',dict(invite=invite),status=400)
        self.request(a, '/budget',dict(book_id=book,budget=0),status=403,headers={'Content-Type':'application/json','Origin':'http://untrusted.example'})
        # Database and login session survive process restart.
        self.process.terminate()
        self.process.wait()
        self.start_server()
        data = self.request(a, '/books/'+book)
        self.assertEqual(data['book']['budget'],600000)
        self.assertEqual(len(data['settlements']),2)
        self.assertEqual(len(data['entries']),1)
        self.request(a, '/logout', {})
        self.request(a, '/me', status=401)
        self.request(a, '/login',dict(email='alice@example.com',password='a-password-123'))
        self.assertEqual(self.request(a, '/me')['user']['id'],aid)

if __name__ == '__main__':
    unittest.main()
