create index if not exists videos_creator_id_idx
  on public.videos (creator_id);

create index if not exists analytics_video_clicks_visitor_idx
  on public.analytics_video_clicks (visitor_id, clicked_at desc);

create or replace function public.creator_studio_report(
  p_creator_id uuid,
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
  creator_exists boolean;
  creator_is_pro boolean;
  video_count bigint;
  total_clicks bigint;
  unique_visitors bigint;
  site_unique_visitors bigint;
  site_video_clicks bigint;
  estimated_clicks bigint;
  estimated_unique_visitors bigint;
  pro_click_lift numeric := 0.35;
  pro_visitor_lift numeric := 0.28;
  click_series jsonb;
  video_clicks jsonb;
begin
  select exists(select 1 from public.creators where id = p_creator_id)
  into creator_exists;

  if not creator_exists then
    return jsonb_build_object(
      'range', jsonb_build_object('start', range_end - interval '1 day', 'end', range_end, 'bucket', 'hour'),
      'summary', jsonb_build_object(
        'missingCreator', true,
        'videoCount', 0,
        'totalClicks', 0,
        'uniqueVisitors', 0,
        'averageClicksPerVideo', 0,
        'audienceShare', 0,
        'clickShare', 0,
        'isPro', false,
        'estimatedPro', jsonb_build_object(
          'liftPercent', pro_click_lift,
          'estimatedClicks', 0,
          'estimatedUniqueVisitors', 0,
          'extraClicks', 0,
          'extraUniqueVisitors', 0
        )
      ),
      'clicks', '[]'::jsonb,
      'videos', '[]'::jsonb
    );
  end if;

  select coalesce(
    pro_start_at is not null
      and pro_end_at is not null
      and pro_start_at <= now()
      and now() < pro_end_at,
    false
  )
  into creator_is_pro
  from public.creators
  where id = p_creator_id;

  select least(
    coalesce((
      select min(clicks.clicked_at)
      from public.analytics_video_clicks as clicks
      join public.videos on videos.youtube_id = clicks.youtube_id
      where videos.creator_id = p_creator_id
    ), now()),
    coalesce((select min(added_at) from public.videos where creator_id = p_creator_id), now()),
    coalesce((select min(visited_at) from public.analytics_visits), now())
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

  select count(*)
  into video_count
  from public.videos
  where creator_id = p_creator_id;

  select count(*), count(distinct clicks.visitor_id)
  into total_clicks, unique_visitors
  from public.analytics_video_clicks as clicks
  join public.videos on videos.youtube_id = clicks.youtube_id
  where
    videos.creator_id = p_creator_id
    and clicks.clicked_at >= range_start
    and clicks.clicked_at < range_end;

  select count(distinct visitor_id)
  into site_unique_visitors
  from public.analytics_visits
  where visited_at >= range_start and visited_at < range_end;

  select count(*)
  into site_video_clicks
  from public.analytics_video_clicks
  where clicked_at >= range_start and clicked_at < range_end;

  estimated_clicks := case
    when creator_is_pro then total_clicks
    when total_clicks = 0 then video_count * 2
    else ceil(total_clicks::numeric * (1 + pro_click_lift))::bigint
  end;

  estimated_unique_visitors := case
    when creator_is_pro then unique_visitors
    when unique_visitors = 0 then video_count
    else ceil(unique_visitors::numeric * (1 + pro_visitor_lift))::bigint
  end;

  with buckets as (
    select generate_series(
      date_trunc(bucket_name, range_start),
      date_trunc(bucket_name, range_end),
      bucket_step
    ) as bucket
  ),
  counts as (
    select date_trunc(bucket_name, clicks.clicked_at) as bucket, count(*) as value
    from public.analytics_video_clicks as clicks
    join public.videos on videos.youtube_id = clicks.youtube_id
    where
      videos.creator_id = p_creator_id
      and clicks.clicked_at >= range_start
      and clicks.clicked_at < range_end
    group by 1
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object('at', buckets.bucket, 'value', coalesce(counts.value, 0))
      order by buckets.bucket
    ),
    '[]'::jsonb
  )
  into click_series
  from buckets
  left join counts using (bucket);

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'databaseId', items.database_id,
        'youtubeId', items.youtube_id,
        'title', items.title,
        'thumbnail', items.thumbnail,
        'clicks', items.clicks,
        'uniqueVisitors', items.unique_visitors,
        'estimatedProClicks', case
          when creator_is_pro then items.clicks
          when items.clicks = 0 then 1
          else ceil(items.clicks::numeric * (1 + pro_click_lift))::bigint
        end,
        'estimatedProUniqueVisitors', case
          when creator_is_pro then items.unique_visitors
          when items.unique_visitors = 0 then 1
          else ceil(items.unique_visitors::numeric * (1 + pro_visitor_lift))::bigint
        end
      )
      order by items.unique_visitors desc, items.clicks desc, items.added_at desc
    ),
    '[]'::jsonb
  )
  into video_clicks
  from (
    select
      videos.id as database_id,
      videos.youtube_id,
      videos.added_at,
      coalesce(videos.payload->>'title', 'Vidéo YouTube') as title,
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
    where videos.creator_id = p_creator_id
    group by videos.id, videos.youtube_id, videos.payload, videos.added_at
  ) as items;

  return jsonb_build_object(
    'range', jsonb_build_object(
      'start', range_start,
      'end', range_end,
      'bucket', bucket_name
    ),
    'summary', jsonb_build_object(
      'missingCreator', false,
      'videoCount', video_count,
      'totalClicks', total_clicks,
      'uniqueVisitors', unique_visitors,
      'averageClicksPerVideo', case
        when video_count = 0 then 0
        else round(total_clicks::numeric / video_count, 1)
      end,
      'audienceShare', case
        when site_unique_visitors = 0 then 0
        else unique_visitors::numeric / site_unique_visitors
      end,
      'clickShare', case
        when site_video_clicks = 0 then 0
        else total_clicks::numeric / site_video_clicks
      end,
      'isPro', creator_is_pro,
      'estimatedPro', jsonb_build_object(
        'liftPercent', case when creator_is_pro then 0 else pro_click_lift end,
        'visitorLiftPercent', case when creator_is_pro then 0 else pro_visitor_lift end,
        'estimatedClicks', estimated_clicks,
        'estimatedUniqueVisitors', estimated_unique_visitors,
        'extraClicks', greatest(0, estimated_clicks - total_clicks),
        'extraUniqueVisitors', greatest(0, estimated_unique_visitors - unique_visitors)
      )
    ),
    'clicks', click_series,
    'videos', video_clicks
  );
end;
$$;

revoke all on function public.creator_studio_report(uuid, timestamptz, timestamptz, text)
  from public, anon, authenticated;

grant execute on function public.creator_studio_report(uuid, timestamptz, timestamptz, text)
  to service_role;
