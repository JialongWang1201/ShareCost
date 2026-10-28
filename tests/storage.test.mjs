import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

test('profile reads stop creating row versions; optimization preserves existing data, permissions and name changes',async()=>{
  const db=new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated;
      create schema auth;
      create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb);
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
      $$;
      grant usage on schema auth to authenticated;`);
    const initial=await fs.readFile(new URL('../supabase/migrations/202610280001_sharecost.sql',import.meta.url),'utf8');
    const optimization=await fs.readFile(new URL('../supabase/migrations/202610280002_avoid_profile_rewrites.sql',import.meta.url),'utf8');
    await db.exec(initial);
    const actor='10000000-0000-0000-0000-000000000001';
    await db.query('insert into auth.users values($1,$2,$3)',[actor,'test@example.com',JSON.stringify({name:'Alex'})]);
    async function api(path,data) {
      await db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor]);
      await db.exec('set role authenticated');
      try{return (await db.query('select public.sharecost_api($1,$2::jsonb) as result',[path,data===undefined?null:JSON.stringify(data)])).rows[0].result;}
      finally{await db.exec('reset role');}
    }
    const book=(await api('/books',{name:'Existing ledger',currency:'CNY',budget:500})).id;
    assert.equal((await api('/entries',{book_id:book,payer_id:actor,kind:'expense',category:'餐饮',amount:'25.01',date:'2026-10-28',note:'Keep this note',participants:[actor],split_mode:'equal'})).ok,true);
    const before=await api('/books/'+book);
    await db.exec(`create schema test_audit;
      create table test_audit.profile_updates(n int);
      create function test_audit.profile_update() returns trigger language plpgsql as $$
        begin insert into test_audit.profile_updates values(1); return new; end;
      $$;
      create trigger profile_update_audit after update on sharecost_private.profiles
      for each row execute function test_audit.profile_update();`);
    const updates=async()=>Number((await db.query('select count(*) as n from test_audit.profile_updates')).rows[0].n);
    await api('/books');await api('/books/'+book);
    assert.equal(await updates(),2,'Reproduce the original writes from ordinary reads');
    const permissions=(await db.query("select prosecdef,proconfig,proacl::text,proowner from pg_proc where oid='public.sharecost_api(text,jsonb)'::regprocedure")).rows;
    await db.exec(optimization);
    await db.exec(optimization);
    for(let i=0;i<20;i++){await api('/books');await api('/books/'+book);}
    assert.equal(await updates(),2,'Forty read requests must perform zero profile updates');
    assert.deepEqual(await api('/books/'+book),before,'All existing records and balances survive');
    assert.deepEqual((await db.query("select prosecdef,proconfig,proacl::text,proowner from pg_proc where oid='public.sharecost_api(text,jsonb)'::regprocedure")).rows,permissions);
    await db.query('update auth.users set raw_user_meta_data=$1 where id=$2',[JSON.stringify({name:'Updated name'}),actor]);
    assert.equal((await api('/books/'+book)).members[0].name,'Updated name');
    assert.equal(await updates(),3,'A real name change must still be saved once');
    await api('/books/'+book);assert.equal(await updates(),3);
    await db.exec('set role anon');
    await assert.rejects(()=>db.query("select public.sharecost_api('/books')"),/permission denied/);
    await db.exec('reset role');
    const report=await fs.readFile(new URL('../supabase/maintenance/storage-report.sql',import.meta.url),'utf8');
    const output=JSON.parse((await db.query(report)).rows[0].storage_report);
    assert.equal(output.profile_write_optimization_installed,true);
    assert.equal(output.counts.entries,1);
    assert(output.sharecost_tables_bytes>0);
    // Unknown API versions must fail closed instead of overwriting user changes.
    const definition=(await db.query("select pg_get_functiondef('public.sharecost_api(text,jsonb)'::regprocedure) as definition")).rows[0].definition;
    const customized=definition.replace('where not exists (','where not exists(');
    await db.exec(customized);
    await assert.rejects(()=>db.exec(optimization),/differs from the expected version/);
    await db.exec('rollback');
    assert.equal((await db.query("select pg_get_functiondef('public.sharecost_api(text,jsonb)'::regprocedure) as definition")).rows[0].definition,customized);
  } finally {await db.close();}
});
