create table if not exists public.analytics_visitors (
  visitor_id uuid primary key,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists public.analytics_sessions (
  session_id uuid primary key,
  visitor_id uuid not null references public.analytics_visitors(visitor_id) on delete cascade,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists public.analytics_visits (
  visit_id uuid primary key,
  visitor_id uuid not null references public.analytics_visitors(visitor_id) on delete cascade,
  session_id uuid not null,
  visited_at timestamptz not null default now()
);

create table if not exists public.analytics_video_clicks (
  event_id uuid primary key,
  visitor_id uuid not null references public.analytics_visitors(visitor_id) on delete cascade,
  session_id uuid not null,
  youtube_id text not null,
  clicked_at timestamptz not null default now()
);

create index if not exists analytics_sessions_last_seen_idx
  on public.analytics_sessions (last_seen_at desc);
create index if not exists analytics_sessions_visitor_idx
  on public.analytics_sessions (visitor_id);
create index if not exists analytics_visits_visited_at_idx
  on public.analytics_visits (visited_at desc);
create index if not exists analytics_visits_visitor_idx
  on public.analytics_visits (visitor_id);
create index if not exists analytics_visitors_first_seen_idx
  on public.analytics_visitors (first_seen_at);
create index if not exists analytics_video_clicks_clicked_at_idx
  on public.analytics_video_clicks (clicked_at desc);
create index if not exists analytics_video_clicks_youtube_idx
  on public.analytics_video_clicks (youtube_id, clicked_at desc);

alter table public.analytics_visitors enable row level security;
alter table public.analytics_sessions enable row level security;
alter table public.analytics_visits enable row level security;
alter table public.analytics_video_clicks enable row level security;

revoke all on public.analytics_visitors from anon, authenticated;
revoke all on public.analytics_sessions from anon, authenticated;
revoke all on public.analytics_visits from anon, authenticated;
revoke all on public.analytics_video_clicks from anon, authenticated;

grant all privileges on table public.analytics_visitors to service_role;
grant all privileges on table public.analytics_sessions to service_role;
grant all privileges on table public.analytics_visits to service_role;
grant all privileges on table public.analytics_video_clicks to service_role;

create or replace function public.record_analytics_visit(
  p_visitor_id uuid,
  p_session_id uuid,
  p_visit_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.analytics_visitors (visitor_id, first_seen_at, last_seen_at)
  values (p_visitor_id, now(), now())
  on conflict (visitor_id) do update
  set last_seen_at = excluded.last_seen_at;

  insert into public.analytics_sessions (session_id, visitor_id, started_at, last_seen_at)
  values (p_session_id, p_visitor_id, now(), now())
  on conflict (session_id) do update
  set
    visitor_id = excluded.visitor_id,
    last_seen_at = excluded.last_seen_at;

  insert into public.analytics_visits (visit_id, visitor_id, session_id, visited_at)
  values (p_visit_id, p_visitor_id, p_session_id, now())
  on conflict (visit_id) do nothing;
end;
$$;

create or replace function public.record_analytics_heartbeat(
  p_visitor_id uuid,
  p_session_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_count integer;
begin
  update public.analytics_sessions
  set last_seen_at = now()
  where session_id = p_session_id and visitor_id = p_visitor_id;

  get diagnostics updated_count = row_count;
  if updated_count = 0 then
    return false;
  end if;

  update public.analytics_visitors
  set last_seen_at = now()
  where visitor_id = p_visitor_id;

  return true;
end;
$$;

create or replace function public.record_analytics_video_click(
  p_event_id uuid,
  p_visitor_id uuid,
  p_session_id uuid,
  p_youtube_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1
    from public.analytics_sessions
    where
      session_id = p_session_id
      and visitor_id = p_visitor_id
      and last_seen_at >= now() - interval '1 day'
  ) then
    return false;
  end if;

  if not exists (
    select 1 from public.videos where youtube_id = p_youtube_id
  ) then
    return false;
  end if;

  update public.analytics_sessions
  set last_seen_at = now()
  where session_id = p_session_id and visitor_id = p_visitor_id;

  update public.analytics_visitors
  set last_seen_at = now()
  where visitor_id = p_visitor_id;

  insert into public.analytics_video_clicks (
    event_id,
    visitor_id,
    session_id,
    youtube_id,
    clicked_at
  )
  values (
    p_event_id,
    p_visitor_id,
    p_session_id,
    p_youtube_id,
    now()
  )
  on conflict (event_id) do nothing;

  return true;
end;
$$;

create or replace function public.analytics_report(
  p_start timestamptz default null,
  p_end timestamptz default now(),
  p_bucket text default 'auto'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  range_start timestamptz;
  range_end timestamptz := least(coalesce(p_end, now()), now() + interval '1 minute');
  earliest_at timestamptz;
  bucket_name text;
  bucket_step interval;
  online_visitors bigint;
  total_visits bigint;
  unique_visitors bigint;
  new_visitors bigint;
  visits_series jsonb;
  new_visitors_series jsonb;
  video_clicks jsonb;
begin
  select least(
    coalesce((select min(visited_at) from public.analytics_visits), now()),
    coalesce((select min(first_seen_at) from public.analytics_visitors), now())
  )
  into earliest_at;

  range_start := coalesce(p_start, earliest_at);
  if range_start >= range_end then
    range_start := range_end - interval '1 day';
  end if;

  if p_bucket in ('hour', 'day', 'week', 'month') then
    bucket_name := p_bucket;
  elsif range_end - range_start <= interval '2 days' then
    bucket_name := 'hour';
  elsif range_end - range_start <= interval '90 days' then
    bucket_name := 'day';
  elsif range_end - range_start <= interval '540 days' then
    bucket_name := 'week';
  else
    bucket_name := 'month';
  end if;

  bucket_step := case bucket_name
    when 'hour' then interval '1 hour'
    when 'day' then interval '1 day'
    when 'week' then interval '1 week'
    else interval '1 month'
  end;

  select count(distinct visitor_id)
  into online_visitors
  from public.analytics_sessions
  where last_seen_at >= now() - interval '90 seconds';

  select count(*), count(distinct visitor_id)
  into total_visits, unique_visitors
  from public.analytics_visits
  where visited_at >= range_start and visited_at < range_end;

  select count(*)
  into new_visitors
  from public.analytics_visitors
  where first_seen_at >= range_start and first_seen_at < range_end;

  with buckets as (
    select generate_series(
      date_trunc(bucket_name, range_start),
      date_trunc(bucket_name, range_end),
      bucket_step
    ) as bucket
  ),
  counts as (
    select date_trunc(bucket_name, visited_at) as bucket, count(*) as value
    from public.analytics_visits
    where visited_at >= range_start and visited_at < range_end
    group by 1
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object('at', buckets.bucket, 'value', coalesce(counts.value, 0))
      order by buckets.bucket
    ),
    '[]'::jsonb
  )
  into visits_series
  from buckets
  left join counts using (bucket);

  with buckets as (
    select generate_series(
      date_trunc(bucket_name, range_start),
      date_trunc(bucket_name, range_end),
      bucket_step
    ) as bucket
  ),
  counts as (
    select date_trunc(bucket_name, first_seen_at) as bucket, count(*) as value
    from public.analytics_visitors
    where first_seen_at >= range_start and first_seen_at < range_end
    group by 1
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object('at', buckets.bucket, 'value', coalesce(counts.value, 0))
      order by buckets.bucket
    ),
    '[]'::jsonb
  )
  into new_visitors_series
  from buckets
  left join counts using (bucket);

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'databaseId', items.database_id,
        'youtubeId', items.youtube_id,
        'title', items.title,
        'creator', items.creator,
        'thumbnail', items.thumbnail,
        'clicks', items.clicks,
        'uniqueVisitors', items.unique_visitors
      )
      order by items.unique_visitors desc, items.clicks desc
    ),
    '[]'::jsonb
  )
  into video_clicks
  from (
    select
      videos.id as database_id,
      videos.youtube_id,
      coalesce(videos.payload->>'title', 'Vidéo YouTube') as title,
      coalesce(videos.payload->>'creator', 'YouTube') as creator,
      coalesce(
        videos.payload->>'thumbnail',
        'https://i.ytimg.com/vi/' || videos.youtube_id || '/hqdefault.jpg'
      ) as thumbnail,
      count(clicks.event_id) as clicks,
      count(distinct clicks.visitor_id) as unique_visitors
    from public.videos
    left join public.analytics_video_clicks as clicks
      on
        clicks.youtube_id = videos.youtube_id
        and clicks.clicked_at >= range_start
        and clicks.clicked_at < range_end
    group by videos.id, videos.youtube_id, videos.payload
  ) as items;

  return jsonb_build_object(
    'range', jsonb_build_object(
      'start', range_start,
      'end', range_end,
      'bucket', bucket_name
    ),
    'summary', jsonb_build_object(
      'onlineVisitors', online_visitors,
      'totalVisits', total_visits,
      'uniqueVisitors', unique_visitors,
      'newVisitors', new_visitors
    ),
    'visits', visits_series,
    'newVisitors', new_visitors_series,
    'videoClicks', video_clicks
  );
end;
$$;

revoke all on function public.record_analytics_visit(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.record_analytics_heartbeat(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.record_analytics_video_click(uuid, uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.analytics_report(timestamptz, timestamptz, text)
  from public, anon, authenticated;

grant execute on function public.record_analytics_visit(uuid, uuid, uuid)
  to service_role;
grant execute on function public.record_analytics_heartbeat(uuid, uuid)
  to service_role;
grant execute on function public.record_analytics_video_click(uuid, uuid, uuid, text)
  to service_role;
grant execute on function public.analytics_report(timestamptz, timestamptz, text)
  to service_role;
