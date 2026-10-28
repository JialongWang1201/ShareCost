import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

test('storage migration tolerates formatting, recognizes real SQL, preserves permissions and refuses unknown logic',async()=>{
  const db=new PGlite();
  try {
    await db.exec(`create role anon;create role authenticated;create schema auth;
      create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth to authenticated;`);
    const initial=await fs.readFile(new URL('../supabase/migrations/202610280001_sharecost.sql',import.meta.url),'utf8');
    const prior=await fs.readFile(new URL('../supabase/migrations/202610280002_avoid_profile_rewrites.sql',import.meta.url),'utf8');
    const patch=await fs.readFile(new URL('../supabase/migrations/202610280003_profile_rewrite_compat.sql',import.meta.url),'utf8');
    await db.exec(initial);
    const actor='10000000-0000-0000-0000-000000000001';
    await db.query('insert into auth.users values($1,$2,$3)',[actor,'test@example.com',JSON.stringify({name:'Alex'})]);
    async function api(path,data){
      await db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor]);
      await db.exec('set role authenticated');
      try{return (await db.query('select public.sharecost_api($1,$2::jsonb) as result',[path,data===undefined?null:JSON.stringify(data)])).rows[0].result;}
      finally{await db.exec('reset role');}
    }
    const definition=async()=>(await db.query("select pg_get_functiondef('public.sharecost_api(text,jsonb)'::regprocedure) as source")).rows[0].source;
    const grants=async()=>(await db.query("select prosecdef,proconfig,proacl::text,proowner from pg_proc where oid='public.sharecost_api(text,jsonb)'::regprocedure")).rows;
    const baseline=await definition(),permissions=await grants();
    const original='insert into sharecost_private.profiles(id,name) values(actor,actor_name)\n  on conflict(id) do update set name=excluded.name;';
    assert(baseline.includes(original));
    const book=(await api('/books',{name:'Existing',currency:'CNY',budget:500})).id;
    assert.equal((await api('/entries',{book_id:book,payer_id:actor,kind:'expense',amount:'19.99',category:'餐饮',date:'2026-10-28',note:'Preserve me',participants:[actor],split_mode:'equal'})).ok,true);
    const before=await api('/books/'+book);
    const spaced=original.replace(/([().,=])/g,' $1 ').replace(/\s+/g,' \r\n\t ');
    const quoted='INSERT INTO "sharecost_private" . "profiles" ("id", "name") VALUES ("actor", "actor_name") ON CONFLICT ("id") DO UPDATE SET "name" = "excluded" . "name";';
    const comments=original.replace('insert into','insert /* comment /* nested */ comment */ into').replace('values(actor','values(/* comment */ actor');
    const fake=`begin\n  -- ${original.replaceAll('\n',' ')}\n  /* ${original} */\n  perform '${original}';\n  perform $$${original}$$;\n  perform $sample$${original}$sample$;\n  if actor`;
    const cases=[baseline,baseline.replace(original,spaced),baseline.replace(original,original.toUpperCase()),baseline.replace(original,quoted),baseline.replace(original,comments),baseline.replace('begin\n  if actor',()=>fake)];
    await db.exec(prior);
    cases.push((await definition()).replace('-- ShareCost storage v2: avoid profile writes on reads.','').replace('where not exists (','where not exists\n ('));
    for(const [index,source] of cases.entries()){
      await db.exec(source);
      await db.exec(patch);
      const optimized=await definition();
      await db.exec(patch);assert.equal(await definition(),optimized,'Idempotence in case '+index);
      const ctid=(await db.query('select ctid::text from sharecost_private.profiles where id=$1',[actor])).rows[0].ctid;
      for(let i=0;i<3;i++)assert.deepEqual(await api('/books/'+book),before,'Records in case '+index);
      assert.equal((await db.query('select ctid::text from sharecost_private.profiles where id=$1',[actor])).rows[0].ctid,ctid,'No profile rewrites in case '+index);
      assert.deepEqual(await grants(),permissions,'Authorization is preserved in case '+index);
    }
    // The known statement inside a literal/comment must NOT authorize patching
    // a real INSERT with a different value, variable, or conflict expression.
    const unknown=[
      baseline.replace(original,original.replace('values(actor,actor_name)',"values(actor,'Custom name')")),
      baseline.replace(original,original.replace('set name=excluded.name',"set name=upper(excluded.name)")),
      baseline.replace(original,original.replace('values(actor,actor_name)','select actor,actor _name')),
      baseline.replace(original,original+'\n  '+original)
    ];
    for(const source of unknown){
      await db.exec(source);
      const actual=await definition();
      await assert.rejects(()=>db.exec(patch),/No changes applied/);
      await db.exec('rollback');
      assert.equal(await definition(),actual,'Unknown code must remain untouched');
    }
    await db.exec(baseline.replace(original,"insert into sharecost_private.profiles(id,name) values(actor,'Custom name') on conflict(id) do update set name=excluded.name;").replace('begin\n  if actor',()=>fake));
    const actual=await definition();
    await assert.rejects(()=>db.exec(patch),/No changes applied/);await db.exec('rollback');
    assert.equal(await definition(),actual);
  } finally {await db.close();}
});
