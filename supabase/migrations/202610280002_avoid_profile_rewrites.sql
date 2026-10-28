-- Storage optimization for an existing ShareCost database.
-- Changes only the API's profile upsert. Does not delete or rewrite ledger data.
-- Preserves the function's authorization, signature, owner and grants.
begin;
do $migration$
declare
  definition text;
  old_fragment constant text := $old$  insert into sharecost_private.profiles(id,name) values(actor,actor_name)
  on conflict(id) do update set name=excluded.name;$old$;
  new_fragment constant text := $new$  -- ShareCost storage v2: avoid profile writes on reads.
  insert into sharecost_private.profiles(id,name)
  select actor,actor_name
  where not exists (
    select 1 from sharecost_private.profiles p
    where p.id=actor and p.name=actor_name
  )
  on conflict(id) do update set name=excluded.name
  where sharecost_private.profiles.name is distinct from excluded.name;$new$;
begin
  if to_regprocedure('public.sharecost_api(text,jsonb)') is null then
    raise exception 'Initialize ShareCost with migration 202610280001 first.';
  end if;
  definition := pg_get_functiondef('public.sharecost_api(text,jsonb)'::regprocedure);
  if strpos(definition,new_fragment)>0 then
    raise notice 'ShareCost profile storage optimization is already installed.';
    return;
  end if;
  if strpos(definition,old_fragment)=0
     or length(definition)-length(replace(definition,old_fragment,''))<>length(old_fragment) then
    raise exception 'ShareCost API differs from the expected version. No changes applied; inspect the function before patching.';
  end if;
  execute replace(definition,old_fragment,new_fragment);
end;
$migration$;
notify pgrst,'reload schema';
commit;

-- Return a small, read-only report in the same SQL Editor run.
with relation_sizes as (
  select n.nspname,pg_total_relation_size(c.oid) as bytes
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where c.relkind in ('r','m') and n.nspname in ('sharecost_private','auth')
)
select jsonb_pretty(jsonb_build_object(
  'profile_write_optimization_installed',true,
  'current_database_size',pg_size_pretty(pg_database_size(current_database())),
  'sharecost_tables_size',pg_size_pretty(coalesce((select sum(bytes)::bigint from relation_sizes where nspname='sharecost_private'),0)),
  'auth_tables_size',pg_size_pretty(coalesce((select sum(bytes)::bigint from relation_sizes where nspname='auth'),0)),
  'entries',(select count(*) from sharecost_private.entries),
  'split_rows',(select count(*) from sharecost_private.shares),
  'settlements',(select count(*) from sharecost_private.settlements)
)) as storage_report;
