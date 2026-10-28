import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

test('Supabase SQL enforces membership, exact splits, ownership and settlements in PostgreSQL',async()=>{
  const db=new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated;
      create schema auth;
      create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb);
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
      $$;
      grant usage on schema auth to authenticated;`);
    const migration=await fs.readFile(new URL('../supabase/migrations/202610280001_sharecost.sql',import.meta.url),'utf8');
    const optimization=await fs.readFile(new URL('../supabase/migrations/202610280003_profile_rewrite_compat.sql',import.meta.url),'utf8');
    await db.exec(migration);
    await db.exec(optimization);
    const a='10000000-0000-0000-0000-000000000001',b='20000000-0000-0000-0000-000000000002',c='30000000-0000-0000-0000-000000000003',outsider='40000000-0000-0000-0000-000000000004';
    for(const [id,name] of [[a,'Alex'],[b,'Jamie'],[c,'Sam'],[outsider,'Outsider']])
      await db.query('insert into auth.users values($1,$2,$3)',[id,name+'@example.com',JSON.stringify({name})]);
    async function call(actor,path,data){
      await db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor||'']);
      await db.exec('set role authenticated');
      try{return (await db.query('select public.sharecost_api($1,$2::jsonb) as result',[path,data===undefined?null:JSON.stringify(data)])).rows[0].result;}
      finally{await db.exec('reset role');}
    }
    assert.equal((await call(null,'/books')).status,401);
    await db.exec('set role anon');
    await assert.rejects(()=>db.query("select public.sharecost_api('/books')"),/permission denied/);
    await db.exec('reset role');
    await db.exec('set role authenticated');
    await assert.rejects(()=>db.query('select * from sharecost_private.books'),/permission denied/);
    await db.exec('reset role');

    const book=(await call(a,'/books',{name:'Shared life',currency:'CNY',budget:'5000'})).id;
    assert(book,'Ledger creation must succeed');
    assert.equal((await call(outsider,'/books/'+book)).status,403);
    assert.equal((await call(outsider,'/budget',{book_id:book,budget:0,user_id:a})).status,403,'Payload cannot impersonate the owner');
    const invite=(await call(a,'/books/'+book)).book.invite;
    for(const actor of [b,c])assert.equal((await call(actor,'/join',{invite})).id,book);
    assert.equal((await call(b,'/join',{invite:'INVALID'})).status,400);
    const entry={book_id:book,amount:'100.00',payer_id:a,kind:'expense',category:'餐饮',note:'Lunch',date:'2026-10-28',participants:[a,b,c],split_mode:'equal'};
    assert.equal((await call(a,'/entries',entry)).ok,true);
    let snapshot=await call(b,'/books/'+book);
    assert.deepEqual(snapshot.entries[0].shares.map(s=>s.amount),[3334,3333,3333]);
    assert.deepEqual(snapshot.balances,{[a]:6666,[b]:-3333,[c]:-3333});
    assert.equal(snapshot.transfers.reduce((s,t)=>s+t.amount,0),6666);
    const id=snapshot.entries[0].id;
    assert.equal((await call(b,'/entries/delete',{book_id:book,id})).status,403);
    assert.equal((await call(b,'/entries/update',{...entry,id})).status,403);
    assert.equal((await call(b,'/budget',{book_id:book,budget:2})).status,403);
    for(const patch of [{amount:'0.001'},{amount:'NaN'},{amount:true},{kind:null},{date:'2026-02-30'},{participants:[a,a]},{participants:[outsider]},{payer_id:outsider},{participants:[]},{split_mode:'custom',custom:{[a]:1,[b]:2,[c]:3}}])
      assert.equal((await call(a,'/entries',{...entry,...patch})).status,400,JSON.stringify(patch));
    assert.equal((await call(a,'/books/'+book)).entries.length,1,'Failed writes must be atomic');
    assert.equal((await call(a,'/entries/update',{...entry,id,amount:'120',split_mode:'custom',custom:{[a]:'20',[b]:'40',[c]:'60'}})).ok,true);
    snapshot=await call(a,'/books/'+book);
    assert.deepEqual(snapshot.balances,{[a]:10000,[b]:-4000,[c]:-6000});
    assert.equal((await call(c,'/settlements',{book_id:book,from_id:b,to_id:a,amount:'40'})).status,403);
    assert.equal((await call(b,'/settlements',{book_id:book,from_id:b,to_id:a,amount:'40'})).ok,true);
    assert.equal((await call(b,'/settlements',{book_id:book,from_id:b,to_id:a,amount:'40'})).status,400,'Duplicate settlement must fail');
    assert.equal((await call(c,'/settlements',{book_id:book,from_id:c,to_id:a,amount:'60'})).ok,true);
    assert.deepEqual((await call(a,'/books/'+book)).transfers,[]);
    assert.equal((await call(b,'/entries',{...entry,kind:'income',payer_id:b,amount:'30'})).ok,true);
    snapshot=await call(a,'/books/'+book);
    assert.deepEqual(snapshot.balances,{[a]:1000,[b]:-2000,[c]:1000});
    assert.equal((await call(a,'/entries/delete',{book_id:book,id:snapshot.entries.find(e=>e.kind==='income').id})).ok,true);
    assert.equal((await call(a,'/budget',{book_id:book,budget:'6000'})).ok,true);
    assert.equal((await call(a,'/invite/rotate',{book_id:book})).ok,true);
    assert.equal((await call(outsider,'/join',{invite})).status,400);
    assert.equal((await call(outsider,'/books')).books.length,0);
    assert.deepEqual((await call(a,'/books/'+book)).balances,{[a]:0,[b]:0,[c]:0});
    // A repeated setup must preserve existing ledgers, entries and settlements.
    await db.exec(migration);
    await db.exec(optimization);
    snapshot=await call(a,'/books/'+book);
    assert.equal(snapshot.entries.length,1);
    assert.equal(snapshot.settlements.length,2);
    assert.equal(snapshot.book.budget,600000);
  } finally {await db.close();}
});
