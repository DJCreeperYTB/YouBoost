create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

do $$
begin
  if exists (
    select 1
    from cron.job
    where jobname = 'youboost-weekly-creator-reports'
  ) then
    perform cron.unschedule('youboost-weekly-creator-reports');
  end if;
end $$;

select cron.schedule(
  'youboost-weekly-creator-reports',
  '0 9 * * 1',
  $$
  select net.http_post(
    url := 'https://tyeyjsflihxygkospkjk.supabase.co/functions/v1/youboost-api/api/cron/weekly-creator-reports',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Cron-Secret', coalesce(
        (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'youboost_weekly_report_secret'
          limit 1
        ),
        ''
      )
    ),
    body := jsonb_build_object('source', 'pg_cron'),
    timeout_milliseconds := 30000
  );
  $$
);
