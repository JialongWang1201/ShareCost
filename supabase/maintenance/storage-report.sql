-- Read-only. Run in the Supabase SQL Editor, using your project administrator.
-- Returns sizes and counts, never member names, notes, amounts or credentials.
-- pg_total_relation_size includes indexes and TOAST; exclude pg_toast to avoid
-- counting that storage twice. PostgreSQL statistics for dead rows are estimates.
with relations as (
  select n.nspname as schema_name,c.relname as table_name,
    pg_table_size(c.oid) as table_bytes,
    pg_indexes_size(c.oid) as index_bytes,
    pg_total_relation_size(c.oid) as total_bytes,
    coalesce(s.n_dead_tup,0) as estimated_dead_rows
  from pg_class c
  join pg_namespace n on n.oid=c.relnamespace
  left join pg_stat_all_tables s on s.relid=c.oid
  where c.relkind in ('r','m')
    and n.nspname not like 'pg_toast%'
    and n.nspname not like 'pg_temp%'
), schema_sizes as (
  select schema_name,sum(table_bytes)::bigint as table_bytes,
    sum(index_bytes)::bigint as index_bytes,sum(total_bytes)::bigint as total_bytes
  from relations group by schema_name
), largest_tables as (
  select * from relations order by total_bytes desc,schema_name,table_name limit 15
)
select jsonb_pretty(jsonb_build_object(
  'database',current_database(),
  'current_database_bytes',pg_database_size(current_database()),
  'current_database_size',pg_size_pretty(pg_database_size(current_database())),
  'sharecost_tables_bytes',coalesce((select total_bytes from schema_sizes where schema_name='sharecost_private'),0),
  'sharecost_tables_size',pg_size_pretty(coalesce((select total_bytes from schema_sizes where schema_name='sharecost_private'),0)),
  'counts',jsonb_build_object(
    'members',(select count(*) from sharecost_private.profiles),
    'ledgers',(select count(*) from sharecost_private.books),
    'entries',(select count(*) from sharecost_private.entries),
    'split_rows',(select count(*) from sharecost_private.shares),
    'settlements',(select count(*) from sharecost_private.settlements)
  ),
  'schemas',(select jsonb_agg(to_jsonb(s) order by s.total_bytes desc) from schema_sizes s),
  'largest_tables',(select jsonb_agg(to_jsonb(t) order by t.total_bytes desc,t.schema_name,t.table_name) from largest_tables t),
  'profile_write_optimization_installed',strpos(
    pg_get_functiondef('public.sharecost_api(text,jsonb)'::regprocedure),
    'ShareCost storage v2: avoid profile writes on reads.'
  )>0
)) as storage_report;
