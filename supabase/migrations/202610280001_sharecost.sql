-- Run once in the Supabase SQL editor. Safe to rerun without removing records.
-- Tables are private and have RLS enabled with no browser grants.
-- The sole public RPC checks the authenticated identity and membership on every call.
begin;

create schema if not exists sharecost_private;
revoke all on schema sharecost_private from public, anon, authenticated;

create table if not exists sharecost_private.profiles (
  id uuid primary key references auth.users(id),
  name text not null check (char_length(name) between 1 and 24)
);
create table if not exists sharecost_private.books (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 32),
  currency text not null check (currency in ('CNY','CAD','USD','EUR','HKD','JPY')),
  budget bigint not null default 0 check (budget between 0 and 10000000000),
  owner_id uuid not null references sharecost_private.profiles(id),
  invite text not null unique default upper(substr(replace(gen_random_uuid()::text,'-',''),1,12)),
  created_at timestamptz not null default clock_timestamp()
);
create table if not exists sharecost_private.members (
  book_id uuid not null references sharecost_private.books(id),
  user_id uuid not null references sharecost_private.profiles(id),
  created_at timestamptz not null default clock_timestamp(),
  primary key (book_id,user_id)
);
create table if not exists sharecost_private.entries (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references sharecost_private.books(id),
  creator_id uuid not null references sharecost_private.profiles(id),
  payer_id uuid not null,
  kind text not null check (kind in ('expense','income')),
  amount bigint not null check (amount between 1 and 10000000000),
  category text not null check (category in ('餐饮','购物','交通','住房','娱乐','旅行','健康','日用','工资','其他')),
  note text not null default '' check (char_length(note)<=200),
  date date not null,
  created bigint not null default (extract(epoch from clock_timestamp())*1000000)::bigint,
  foreign key (book_id,payer_id) references sharecost_private.members(book_id,user_id)
);
create index if not exists sc_entries_book on sharecost_private.entries(book_id,date desc,created desc);
create index if not exists sc_members_user on sharecost_private.members(user_id);
create table if not exists sharecost_private.shares (
  entry_id uuid not null references sharecost_private.entries(id) on delete cascade,
  user_id uuid not null references sharecost_private.profiles(id),
  amount bigint not null check (amount>=0),
  position integer not null,
  primary key (entry_id,user_id)
);
create table if not exists sharecost_private.settlements (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references sharecost_private.books(id),
  from_id uuid not null,
  to_id uuid not null,
  amount bigint not null check (amount between 1 and 10000000000),
  date date not null default current_date,
  creator_id uuid not null references sharecost_private.profiles(id),
  created_at timestamptz not null default clock_timestamp(),
  check (from_id<>to_id),
  foreign key (book_id,from_id) references sharecost_private.members(book_id,user_id),
  foreign key (book_id,to_id) references sharecost_private.members(book_id,user_id)
);
create index if not exists sc_settlements_book on sharecost_private.settlements(book_id);

alter table sharecost_private.profiles enable row level security;
alter table sharecost_private.books enable row level security;
alter table sharecost_private.members enable row level security;
alter table sharecost_private.entries enable row level security;
alter table sharecost_private.shares enable row level security;
alter table sharecost_private.settlements enable row level security;
revoke all on all tables in schema sharecost_private from public,anon,authenticated;
revoke all on all sequences in schema sharecost_private from public,anon,authenticated;

create or replace function sharecost_private.money(value jsonb, allow_zero boolean default false)
returns bigint language plpgsql set search_path='' as $$
declare n numeric;
begin
  if value is null or jsonb_typeof(value) not in ('string','number') or (value#>>'{}') !~ '^[0-9]+([.][0-9]{1,2})?$' then
    raise exception '请输入有效金额，最多两位小数，且不超过一亿元';
  end if;
  n := (value#>>'{}')::numeric;
  if n>100000000 or n<0 or (n=0 and not allow_zero) then
    raise exception '请输入有效金额，最多两位小数，且不超过一亿元';
  end if;
  return (n*100)::bigint;
end;
$$;

create or replace function sharecost_private.balances(p_book uuid)
returns table(user_id uuid, amount bigint) language sql set search_path='' as $$
  with changes as (
    select e.payer_id as uid, case when e.kind='expense' then e.amount else -e.amount end as delta
    from sharecost_private.entries e where e.book_id=p_book
    union all
    select s.user_id,case when e.kind='expense' then -s.amount else s.amount end
    from sharecost_private.shares s join sharecost_private.entries e on e.id=s.entry_id where e.book_id=p_book
    union all
    select s.from_id,s.amount from sharecost_private.settlements s where s.book_id=p_book
    union all
    select s.to_id,-s.amount from sharecost_private.settlements s where s.book_id=p_book
  )
  select m.user_id,coalesce(sum(c.delta),0)::bigint
  from sharecost_private.members m left join changes c on c.uid=m.user_id
  where m.book_id=p_book group by m.user_id;
$$;

create or replace function sharecost_private.transfers(p_book uuid)
returns jsonb language sql set search_path='' as $$
  with balances as (select * from sharecost_private.balances(p_book)),
  debts as (select user_id,-amount as total,sum(-amount) over(order by user_id) as edge from balances where amount<0),
  credits as (select user_id,amount as total,sum(amount) over(order by user_id) as edge from balances where amount>0),
  transfers as (
    select d.user_id as from_id,c.user_id as to_id,
      (least(d.edge,c.edge)-greatest(d.edge-d.total,c.edge-c.total))::bigint as amount
    from debts d cross join credits c
  )
  select coalesce(jsonb_agg(to_jsonb(t) order by from_id,to_id),'[]'::jsonb) from transfers t where amount>0;
$$;

create or replace function public.sharecost_api(p_path text,p_data jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
<<sc>>
declare
  actor uuid := auth.uid();
  actor_name text;
  book sharecost_private.books%rowtype;
  old_entry sharecost_private.entries%rowtype;
  book_id uuid;
  entry_id uuid;
  payer uuid;
  participant uuid;
  participants uuid[];
  idx integer;
  amount bigint;
  share bigint;
  share_sum bigint := 0;
  share_values bigint[] := '{}';
  kind text;
  category text;
  note text;
  entry_date date;
  from_id uuid;
  to_id uuid;
  from_balance bigint;
  to_balance bigint;
  output jsonb;
begin
  if actor is null then raise sqlstate '28000' using message='请先登录'; end if;
  if p_data is not null and jsonb_typeof(p_data)<>'object' then raise exception '请求格式不正确'; end if;
  if octet_length(coalesce(p_data,'{}'::jsonb)::text)>65536 then raise exception '请求格式不正确'; end if;

  select left(coalesce(nullif(trim(u.raw_user_meta_data->>'name'),''),split_part(u.email,'@',1),'Member'),24)
  into actor_name from auth.users u where u.id=actor;
  if actor_name is null then raise sqlstate '28000' using message='请先登录'; end if;
  insert into sharecost_private.profiles(id,name) values(actor,actor_name)
  on conflict(id) do update set name=excluded.name;

  if p_path='/books' and p_data is null then
    select coalesce(jsonb_agg(to_jsonb(b) order by b.created_at,b.id),'[]'::jsonb) into output
    from sharecost_private.books b join sharecost_private.members m on m.book_id=b.id where m.user_id=actor;
    return jsonb_build_object('books',output);
  elsif p_path='/books' then
    if jsonb_typeof(p_data->'name') is distinct from 'string' or char_length(trim(p_data->>'name')) not between 1 and 32 then
      raise exception '账本名称不能为空，且最多 32 个字符';
    end if;
    if coalesce(p_data->>'currency','CNY') not in ('CNY','CAD','USD','EUR','HKD','JPY') then raise exception '不支持该币种'; end if;
    insert into sharecost_private.books(name,currency,budget,owner_id)
    values(trim(p_data->>'name'),coalesce(p_data->>'currency','CNY'),sharecost_private.money(coalesce(p_data->'budget','0'::jsonb),true),actor)
    returning * into book;
    insert into sharecost_private.members(book_id,user_id) values(book.id,actor);
    return jsonb_build_object('id',book.id);
  elsif p_path='/join' and p_data is not null then
    select * into book from sharecost_private.books b where b.invite=upper(trim(p_data->>'invite')) for update;
    if not found then raise exception '邀请码不正确，请向账本创建者确认'; end if;
    if (select count(*) from sharecost_private.members m where m.book_id=book.id)>=100
       and not exists(select 1 from sharecost_private.members m where m.book_id=book.id and m.user_id=actor) then
      raise exception '每个账本最多 100 位成员';
    end if;
    insert into sharecost_private.members(book_id,user_id) values(book.id,actor) on conflict do nothing;
    return jsonb_build_object('id',book.id);
  end if;

  if p_data is null and p_path ~ '^/books/[0-9a-f-]{36}$' then
    book_id := split_part(p_path,'/',3)::uuid;
  else
    book_id := (p_data->>'book_id')::uuid;
  end if;
  if not exists(select 1 from sharecost_private.members m where m.book_id=book_id and m.user_id=actor) then
    raise insufficient_privilege using message='你无权访问这个账本';
  end if;

  -- Every mutation locks the same ledger row. Reads take a shared lock so all
  -- parts of a response describe one consistent balance/transaction state.
  if p_data is null then
    select * into book from sharecost_private.books b where b.id=book_id for share;
    select jsonb_build_object(
      'book',to_jsonb(book),
      'members',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name) order by m.created_at,p.id),'[]'::jsonb)
        from sharecost_private.members m join sharecost_private.profiles p on p.id=m.user_id where m.book_id=book_id),
      'entries',(select coalesce(jsonb_agg(to_jsonb(e)||jsonb_build_object('shares',
          (select coalesce(jsonb_agg(jsonb_build_object('user_id',s.user_id,'amount',s.amount) order by s.position),'[]'::jsonb)
           from sharecost_private.shares s where s.entry_id=e.id)) order by e.date desc,e.created desc,e.id),'[]'::jsonb)
        from sharecost_private.entries e where e.book_id=book_id),
      'settlements',(select coalesce(jsonb_agg(to_jsonb(s) order by s.created_at desc,s.id),'[]'::jsonb) from sharecost_private.settlements s where s.book_id=book_id),
      'balances',(select coalesce(jsonb_object_agg(b.user_id,b.amount),'{}'::jsonb) from sharecost_private.balances(book_id) b),
      'transfers',sharecost_private.transfers(book_id)
    ) into output;
    return output;
  end if;
  select * into book from sharecost_private.books b where b.id=book_id for update;

  if p_path='/budget' then
    if book.owner_id<>actor then raise insufficient_privilege using message='只有账本创建者可以设置预算'; end if;
    update sharecost_private.books b set budget=sharecost_private.money(p_data->'budget',true) where b.id=book_id;
  elsif p_path='/invite/rotate' then
    if book.owner_id<>actor then raise insufficient_privilege using message='只有账本创建者可以更换邀请码'; end if;
    update sharecost_private.books b set invite=upper(substr(replace(gen_random_uuid()::text,'-',''),1,12)) where b.id=book_id;
  elsif p_path in ('/entries','/entries/update') then
    if p_path='/entries/update' then
      entry_id := (p_data->>'id')::uuid;
      select * into old_entry from sharecost_private.entries e where e.id=entry_id and e.book_id=book_id;
      if not found then raise exception '账单不存在'; end if;
      if actor not in (old_entry.creator_id,book.owner_id) then raise insufficient_privilege using message='只有记录者或账本创建者可以修改'; end if;
    else
      entry_id := gen_random_uuid();
    end if;
    amount := sharecost_private.money(p_data->'amount');
    kind := p_data->>'kind'; category := p_data->>'category';
    if kind is null or kind not in ('expense','income') or category is null or category not in ('餐饮','购物','交通','住房','娱乐','旅行','健康','日用','工资','其他') then
      raise exception '请选择有效的收支类型和分类';
    end if;
    payer := (p_data->>'payer_id')::uuid;
    if payer is null or not exists(select 1 from sharecost_private.members m where m.book_id=book_id and m.user_id=payer) then raise exception '付款或收款人必须是账本成员'; end if;
    if coalesce(p_data->>'date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception '日期无效'; end if;
    entry_date := (p_data->>'date')::date;
    note := coalesce(p_data->>'note','');
    if (p_data ? 'note' and jsonb_typeof(p_data->'note')<>'string') or char_length(note)>200 then raise exception '备注最多 200 个字符'; end if;
    if jsonb_typeof(p_data->'participants') is distinct from 'array' then raise exception '请至少选择一位分摊成员，成员不能重复'; end if;
    if jsonb_array_length(p_data->'participants') not between 1 and 100 then raise exception '请至少选择一位分摊成员，成员不能重复'; end if;
    select array_agg(v::uuid order by ord) into participants from jsonb_array_elements_text(p_data->'participants') with ordinality as x(v,ord);
    if (select count(distinct v) from unnest(participants) v)<>cardinality(participants) then raise exception '请至少选择一位分摊成员，成员不能重复'; end if;
    for idx in 1..cardinality(participants) loop
      participant := participants[idx];
      if not exists(select 1 from sharecost_private.members m where m.book_id=book_id and m.user_id=participant) then raise exception '分摊成员必须属于当前账本'; end if;
      if p_data->>'split_mode'='equal' then
        share := amount/cardinality(participants)+case when idx<=mod(amount,cardinality(participants)) then 1 else 0 end;
      elsif p_data->>'split_mode'='custom' then
        if jsonb_typeof(p_data->'custom') is distinct from 'object' then raise exception '分摊格式不正确'; end if;
        share := sharecost_private.money(coalesce(p_data->'custom'->participant::text,'0'::jsonb),true);
      else
        raise exception '分摊方式无效';
      end if;
      share_sum := share_sum+share;
      share_values := array_append(share_values,share);
    end loop;
    if share_sum<>amount then raise exception '各成员分摊金额之和必须等于总金额'; end if;
    if p_path='/entries/update' then
      update sharecost_private.entries e set payer_id=payer,kind=sc.kind,amount=sc.amount,category=sc.category,note=sc.note,date=entry_date where e.id=entry_id;
      delete from sharecost_private.shares s where s.entry_id=sc.entry_id;
    else
      insert into sharecost_private.entries(id,book_id,creator_id,payer_id,kind,amount,category,note,date)
      values(entry_id,book_id,actor,payer,kind,amount,category,note,entry_date);
    end if;
    for idx in 1..cardinality(participants) loop
      insert into sharecost_private.shares(entry_id,user_id,amount,position) values(entry_id,participants[idx],share_values[idx],idx);
    end loop;
  elsif p_path='/entries/delete' then
    select * into old_entry from sharecost_private.entries e where e.id=(p_data->>'id')::uuid and e.book_id=book_id;
    if not found then raise exception '账单不存在'; end if;
    if actor not in (old_entry.creator_id,book.owner_id) then raise insufficient_privilege using message='只有记录者或账本创建者可以删除'; end if;
    delete from sharecost_private.entries e where e.id=old_entry.id;
  elsif p_path='/settlements' then
    from_id := (p_data->>'from_id')::uuid; to_id := (p_data->>'to_id')::uuid;
    if from_id is null or to_id is null or actor not in (from_id,to_id,book.owner_id) then raise insufficient_privilege using message='只有转账双方或账本创建者可以确认结算'; end if;
    amount := sharecost_private.money(p_data->'amount');
    select b.amount into from_balance from sharecost_private.balances(book_id) b where b.user_id=from_id;
    select b.amount into to_balance from sharecost_private.balances(book_id) b where b.user_id=to_id;
    if from_id=to_id or from_balance is null or to_balance is null or amount>least(-from_balance,to_balance) then raise exception '待结算金额已变化，请刷新后重试'; end if;
    insert into sharecost_private.settlements(book_id,from_id,to_id,amount,creator_id) values(book_id,from_id,to_id,amount,actor);
  else
    raise exception '接口不存在';
  end if;
  return jsonb_build_object('ok',true);
exception
  when invalid_authorization_specification then return jsonb_build_object('error',sqlerrm,'status',401);
  when insufficient_privilege then return jsonb_build_object('error',sqlerrm,'status',403);
  when raise_exception then return jsonb_build_object('error',sqlerrm,'status',400);
  when invalid_datetime_format or datetime_field_overflow then return jsonb_build_object('error','日期无效','status',400);
  when invalid_text_representation or numeric_value_out_of_range or check_violation or not_null_violation or foreign_key_violation then
    return jsonb_build_object('error','请求格式不正确','status',400);
end;
$$;

revoke all on all functions in schema sharecost_private from public,anon,authenticated;
revoke all on function public.sharecost_api(text,jsonb) from public,anon;
grant execute on function public.sharecost_api(text,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
