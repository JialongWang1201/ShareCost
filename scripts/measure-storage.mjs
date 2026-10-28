// Synthetic PostgreSQL measurement, entirely in local memory. Never connects to Supabase.
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const count=Number(process.argv[2]||10000);
if(!Number.isInteger(count)||count<1||count>100000)throw new Error('Use a record count between 1 and 100000.');
const db=new PGlite();
try {
  await db.exec(`create role anon;create role authenticated;create schema auth;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;`);
  await db.exec(await fs.readFile(new URL('../supabase/migrations/202610280001_sharecost.sql',import.meta.url),'utf8'));
  await db.exec(await fs.readFile(new URL('../supabase/migrations/202610280003_profile_rewrite_compat.sql',import.meta.url),'utf8'));
  await db.exec(`insert into auth.users
    select ('00000000-0000-0000-0000-'||lpad(g::text,12,'0'))::uuid,'person'||g||'@example.com','{}'::jsonb from generate_series(1,3) g;
    insert into sharecost_private.profiles select id,'Person' from auth.users;
    insert into sharecost_private.books(id,name,currency,budget,owner_id)
    values('10000000-0000-0000-0000-000000000000','Synthetic local benchmark','CNY',0,'00000000-0000-0000-0000-000000000001');
    insert into sharecost_private.members(book_id,user_id) select '10000000-0000-0000-0000-000000000000',id from auth.users;`);
  const sizes=async()=>(await db.query(`select c.relname as name,pg_total_relation_size(c.oid)::float8 as bytes
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='sharecost_private' and c.relkind='r' order by c.relname`)).rows;
  const before=await sizes();
  await db.query(`insert into sharecost_private.entries(book_id,creator_id,payer_id,kind,amount,category,note,date)
    select '10000000-0000-0000-0000-000000000000','00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000001','expense',12000,'餐饮',repeat('日常开支 / groceries ',3),'2026-10-28'
    from generate_series(1,$1::integer)`,[count]);
  await db.exec(`insert into sharecost_private.shares(entry_id,user_id,amount,position)
    select e.id,m.user_id,4000,row_number() over(partition by e.id order by m.user_id)
    from sharecost_private.entries e join sharecost_private.members m on m.book_id=e.book_id;`);
  const after=await sizes();
  const total=rows=>rows.reduce((sum,row)=>sum+row.bytes,0);
  const growth=total(after)-total(before);
  console.log(JSON.stringify({
    note:'Local synthetic PostgreSQL measurement, not your live database. Counts include table/index allocation; Supabase system/auth storage and actual note lengths will differ.',
    entries:count,split_rows:count*3,participants_per_entry:3,
    baseline_application_bytes:total(before),application_bytes_after:total(after),
    additional_bytes:growth,additional_MiB:Number((growth/1024/1024).toFixed(3)),
    approximate_bytes_per_entry_including_splits_and_indexes:Number((growth/count).toFixed(1)),
    tables:after
  },null,2));
} finally {await db.close();}
