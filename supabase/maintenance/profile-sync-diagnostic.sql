-- Read-only source-code diagnostic. No account or ledger data is read.
select (regexp_matches(
  pg_get_functiondef('public.sharecost_api(text,jsonb)'::regprocedure),
  $pattern$(?is)(insert\s+into\s+(?:sharecost_private|"sharecost_private")\s*\.\s*(?:profiles|"profiles")\s*\([^;]*;)$pattern$,
  'g'
))[1] as profile_sync_statement;
