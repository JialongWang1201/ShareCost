-- Replacement for 002 when SQL formatting differs. Run after 001; 002 is optional.
-- Matches only known profile statements, preserving all other API code and grants.
begin;
do $migration$
declare
  source text;
  definition text;
  masked text := '';
  statement text;
  normalized text;
  candidates text[];
  known text[];
  i integer := 1;
  j integer;
  n integer;
  depth integer;
  matches integer;
  start_at integer;
  end_at integer;
  body_at integer;
  ch text;
  delimiter text;
  marker constant text := '-- ShareCost storage v2: avoid profile writes on reads.';
  pattern constant text := $pattern$\minsert[[:space:]]+into[[:space:]]+(?:sharecost_private|"sharecost_private")[[:space:]]*\.[[:space:]]*(?:profiles|"profiles")[[:space:]]*\([^;]*;$pattern$;
  original_statement constant text := $old$insert into sharecost_private.profiles(id,name) values(actor,actor_name)
    on conflict(id) do update set name=excluded.name;$old$;
  optimized_statement constant text := $new$insert into sharecost_private.profiles(id,name)
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
  select p.prosrc into source from pg_proc p
  where p.oid='public.sharecost_api(text,jsonb)'::regprocedure;
  n := char_length(source);

  -- Mask literals and comments with equal-length text so matching positions
  -- refer to real SQL only. Preserve quoted identifiers and word boundaries.
  while i<=n loop
    j := regexp_instr(source,$special$['"/$-]$special$,i);
    if j=0 then
      masked:=masked||translate(substr(source,i),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz');
      exit;
    end if;
    if j>i then
      masked:=masked||translate(substr(source,i,j-i),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz');
      i:=j;
    end if;
    ch := substr(source,i,1);
    j := i;
    if substr(source,i,2)='--' then
      j := strpos(substr(source,i),E'\n');
      j := case when j=0 then n+1 else i+j-1 end;
      masked := masked||repeat(' ',j-i);
    elsif substr(source,i,2)='/*' then
      depth := 1;j := i+2;
      while j<=n and depth>0 loop
        if substr(source,j,2)='/*' then depth:=depth+1;j:=j+2;
        elsif substr(source,j,2)='*/' then depth:=depth-1;j:=j+2;
        else j:=j+1;end if;
      end loop;
      masked := masked||repeat(' ',j-i);
    elsif ch='''' or ch='"' then
      j := i+1;
      while j<=n loop
        if substr(source,j,1)=ch then
          if substr(source,j+1,1)=ch then j:=j+2;
          else j:=j+1;exit;end if;
        elsif ch='''' and substr(source,j,1)=E'\\' then j:=j+2;
        else j:=j+1;end if;
      end loop;
      if ch='"' then masked:=masked||substr(source,i,j-i);
      else masked:=masked||repeat('~',j-i);end if;
    elsif ch='$' and substr(source,i) ~ $tag$^\$(?:[a-zA-Z_][a-zA-Z_0-9]*)?\$$tag$ then
      delimiter := (regexp_match(substr(source,i),$tag$^(\$(?:[a-zA-Z_][a-zA-Z_0-9]*)?\$)$tag$))[1];
      j := strpos(substr(source,i+char_length(delimiter)),delimiter);
      if j=0 then raise exception 'Unclosed dollar quote. No changes applied.';end if;
      j := i+char_length(delimiter)+j-1+char_length(delimiter);
      masked := masked||repeat('~',j-i);
    else
      masked := masked||translate(ch,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz');
      j:=i+1;
    end if;
    i:=j;
  end loop;

  select count(*) into matches from regexp_matches(masked,pattern,'g');
  if matches<>1 then
    raise exception 'Expected one real profile INSERT, found %. No changes applied; send the profile_sync_statement diagnostic for review.',matches;
  end if;
  start_at := regexp_instr(masked,pattern,1,1,0);
  end_at := regexp_instr(masked,pattern,1,1,1);
  statement := substr(masked,start_at,end_at-start_at);

  -- Compare token spacing, not raw source. Keep spaces BETWEEN words, so a
  -- different expression cannot accidentally collapse into a known variable.
  candidates := array[statement,original_statement,optimized_statement];
  known := '{}';
  foreach statement in array candidates loop
    normalized := regexp_replace(statement,'"(sharecost_private|profiles|id|name|actor|actor_name|excluded|p)"','\1','g');
    normalized := trim(regexp_replace(normalized,'[[:space:]]+',' ','g'));
    normalized := regexp_replace(normalized,'[[:space:]]*([().,;=])[[:space:]]*','\1','g');
    known := array_append(known,normalized);
  end loop;
  if known[1]<>known[2] and known[1]<>known[3] then
    raise exception 'Unknown profile sync logic. No changes applied; send the profile_sync_statement diagnostic for review.';
  end if;
  if known[1]=known[3] and strpos(source,marker)>0 then
    raise notice 'ShareCost profile storage optimization is already installed.';
    return;
  end if;

  definition := pg_get_functiondef('public.sharecost_api(text,jsonb)'::regprocedure);
  body_at := strpos(definition,source);
  if body_at=0 or char_length(definition)-char_length(replace(definition,source,''))<>n then
    raise exception 'Could not uniquely locate the function body. No changes applied.';
  end if;
  source := overlay(source placing marker||E'\n  '||optimized_statement from start_at for end_at-start_at);
  execute substr(definition,1,body_at-1)||source||substr(definition,body_at+n);
end;
$migration$;
notify pgrst,'reload schema';
commit;

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
