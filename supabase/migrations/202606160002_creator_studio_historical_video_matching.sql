update public.videos as published
set
  creator_id = submissions.creator_id,
  source_submission_id = coalesce(published.source_submission_id, submissions.id)
from public.submissions as submissions
where
  published.youtube_id = submissions.youtube_id
  and submissions.status = 'accepted'
  and (
    published.creator_id is null
    or published.source_submission_id is null
  );

update public.videos as published
set creator_id = (published.payload->>'creatorId')::uuid
where
  published.creator_id is null
  and (published.payload->>'creatorId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and exists (
    select 1
    from public.creators
    where creators.id = (published.payload->>'creatorId')::uuid
  );

with uniquely_named_creators as (
  select
    lower(trim(channel_title)) as creator_key,
    min(id::text)::uuid as creator_id
  from public.creators
  where nullif(trim(channel_title), '') is not null
  group by lower(trim(channel_title))
  having count(*) = 1
)
update public.videos as published
set creator_id = uniquely_named_creators.creator_id
from uniquely_named_creators
where
  published.creator_id is null
  and lower(trim(published.payload->>'creator')) = uniquely_named_creators.creator_key;

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
  creator_title text;
  creator_is_pro boolean;
  matched_youtube_ids text[] := array[]::text[];
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
  select
    channel_title,
    coalesce(
      pro_start_at is not null
        and pro_end_at is not null
        and pro_start_at <= now()
        and now() < pro_end_at,
      false
    )
  into creator_title, creator_is_pro
  from public.creators
  where id = p_creator_id;

  if not found then
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

  select coalesce(array_agg(distinct videos.youtube_id), array[]::text[])
  into matched_youtube_ids
  from public.videos
  left join public.submissions
    on
      submissions.id = videos.source_submission_id
      or submissions.youtube_id = videos.youtube_id
  where
    videos.creator_id = p_creator_id
    or submissions.creator_id = p_creator_id
    or (
      (videos.payload->>'creatorId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and (videos.payload->>'creatorId')::uuid = p_creator_id
    )
    or (
      nullif(trim(creator_title), '') is not null
      and lower(trim(videos.payload->>'creator')) = lower(trim(creator_title))
    );

  select least(
    coalesce((
      select min(clicks.clicked_at)
      from public.analytics_video_clicks as clicks
      where clicks.youtube_id = any(matched_youtube_ids)
    ), now()),
    coalesce((
      select min(added_at)
      from public.videos
      where youtube_id = any(matched_youtube_ids)
    ), now()),
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
  where youtube_id = any(matched_youtube_ids);

  select count(*), count(distinct visitor_id)
  into total_clicks, unique_visitors
  from public.analytics_video_clicks
  where
    youtube_id = any(matched_youtube_ids)
    and clicked_at >= range_start
    and clicked_at < range_end;

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
    select date_trunc(bucket_name, clicked_at) as bucket, count(*) as value
    from public.analytics_video_clicks
    where
      youtube_id = any(matched_youtube_ids)
      and clicked_at >= range_start
      and clicked_at < range_end
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
    where videos.youtube_id = any(matched_youtube_ids)
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
