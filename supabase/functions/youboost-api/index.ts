import { createClient } from "npm:@supabase/supabase-js@2";

const CATEGORIES: Record<string, string> = {
  Animation: "#ef4444",
  Art: "#ca8a04",
  "Cinéma": "#7c3aed",
  Cuisine: "#16a34a",
  Divertissement: "#e11d48",
  Gaming: "#ea580c",
  Musique: "#db2777",
  Science: "#0891b2",
  Tech: "#2563eb",
  Voyage: "#0f766e",
};

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const env = (name: string, fallback = "") => Deno.env.get(name) || fallback;
const secretKeys = JSON.parse(env("SUPABASE_SECRET_KEYS", "{}"));
const supabaseSecret =
  env("SUPABASE_SERVICE_ROLE_KEY") || secretKeys.default || Object.values(secretKeys)[0];
const supabase = createClient(env("SUPABASE_URL"), String(supabaseSecret), {
  auth: { persistSession: false, autoRefreshToken: false },
});

const allowedOrigins = new Set(
  env("PUBLIC_ORIGINS")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

Deno.serve(async (request) => {
  const origin = request.headers.get("origin") || "";
  const corsHeaders = getCorsHeaders(origin);

  if (request.method === "OPTIONS") {
    if (origin && !isAllowedOrigin(origin)) {
      return json(403, { error: "Origine non autorisée." });
    }
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Max-Age": "600",
      },
    });
  }

  try {
    if (origin && !isAllowedOrigin(origin)) {
      throw new HttpError(403, "Origine non autorisée.");
    }

    const route = apiRoute(new URL(request.url).pathname);

    if (request.method === "GET" && route === "/api/health") {
      return json(
        200,
        {
          ok: true,
          youtubeConfigured: true,
          youtubeMetadataEnriched: Boolean(env("YOUTUBE_API_KEY")),
          mailConfigured: gmailConfigured(),
        },
        corsHeaders,
      );
    }

    if (request.method === "GET" && route === "/api/videos") {
      return json(200, { videos: await publishedVideos() }, corsHeaders);
    }

    if (request.method === "POST" && route === "/api/creator/login") {
      await enforceRateLimit(`creator-login:${clientAddress(request)}`, 900, 12);
      return json(200, await loginCreator(await readJson(request)), corsHeaders);
    }

    if (request.method === "GET" && route === "/api/creator/me") {
      const session = await requireCreator(request);
      return json(200, { creator: await getCreatorProfile(session.creatorId) }, corsHeaders);
    }

    if (request.method === "POST" && route === "/api/submissions") {
      await enforceRateLimit(`submission:${clientAddress(request)}`, 900, 12);
      const session = await requireCreator(request);
      const result = await createSubmission(session.creatorId, await readJson(request));
      return json(201, result, corsHeaders);
    }

    if (request.method === "POST" && route === "/api/admin/login") {
      await enforceRateLimit(`login:${clientAddress(request)}`, 900, 8);
      const body = await readJson(request);
      if (!safeEqual(String(body.password || ""), env("ADMIN_PASSWORD"))) {
        throw new HttpError(401, "Mot de passe incorrect.");
      }
      return json(200, { ok: true, token: await createAdminToken() }, corsHeaders);
    }

    if (route.startsWith("/api/admin/")) {
      await requireAdmin(request);

      if (request.method === "GET" && route === "/api/admin/dashboard") {
        return json(200, await dashboard(), corsHeaders);
      }
      if (request.method === "POST" && route === "/api/admin/creators") {
        return json(201, await createCreator(await readJson(request)), corsHeaders);
      }

      const creatorCodeMatch = route.match(
        /^\/api\/admin\/creators\/([a-f0-9-]+)\/reset-code$/,
      );
      if (request.method === "POST" && creatorCodeMatch) {
        return json(
          200,
          await resetCreatorCode(creatorCodeMatch[1], await readJson(request)),
          corsHeaders,
        );
      }

      const creatorProMatch = route.match(
        /^\/api\/admin\/creators\/([a-f0-9-]+)\/pro$/,
      );
      if (request.method === "POST" && creatorProMatch) {
        return json(
          200,
          await setCreatorPro(creatorProMatch[1], await readJson(request)),
          corsHeaders,
        );
      }

      const videoDeleteMatch = route.match(
        /^\/api\/admin\/videos\/([a-f0-9-]+)\/delete$/,
      );
      if (request.method === "POST" && videoDeleteMatch) {
        return json(200, await deletePublishedVideo(videoDeleteMatch[1]), corsHeaders);
      }

      const reviewMatch = route.match(
        /^\/api\/admin\/submissions\/([a-f0-9-]+)\/review$/,
      );
      if (request.method === "POST" && reviewMatch) {
        return json(
          200,
          await reviewSubmission(reviewMatch[1], await readJson(request)),
          corsHeaders,
        );
      }

      const resendMatch = route.match(
        /^\/api\/admin\/submissions\/([a-f0-9-]+)\/resend-email$/,
      );
      if (request.method === "POST" && resendMatch) {
        return json(200, await resendEmail(resendMatch[1]), corsHeaders);
      }
    }

    throw new HttpError(404, "Route introuvable.");
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status >= 500) console.error(error);
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "object" && error
          ? JSON.stringify(error)
          : String(error || "Erreur inconnue.");
    return json(
      status,
      { error: status === 500 ? "Erreur interne du service." : message },
      corsHeaders,
    );
  }
});

async function publishedVideos() {
  const { data, error } = await supabase
    .from("videos")
    .select(
      "id,youtube_id,payload,added_at,creator_id,creator:creators(channel_id,pro_start_at,pro_end_at,avatar_url)",
    )
    .order("added_at", { ascending: false });
  if (error) throw error;

  return Promise.all(
    (data || []).map(async (published: any) => {
      const addedAt = published.payload?.addedAt || published.added_at;
      let payload = published.payload || {};

      if (
        payload.publishedAtChecked !== true &&
        (!payload.publishedAt || hasSyntheticPublishedAt(payload.publishedAt, addedAt))
      ) {
        const publishedAt = await getYouTubePublishedAt(
          published.youtube_id,
          published.creator?.channel_id,
        );
        payload = { ...payload, publishedAt, publishedAtChecked: true };

        const { error: updateError } = await supabase
          .from("videos")
          .update({ payload })
          .eq("id", published.id);
        if (updateError) console.warn("YouTube published date update:", updateError);
      }

      const { publishedAtChecked: _publishedAtChecked, ...publicPayload } = payload;
      return {
        ...publicPayload,
        databaseId: published.id,
        youtubeId: published.youtube_id,
        creatorId: published.creator_id,
        addedAt,
        isPro: isCreatorPro(published.creator),
        isApproved: true,
        creatorAvatar:
          published.creator?.avatar_url || publicPayload.creatorAvatar || null,
      };
    }),
  );
}

async function loginCreator(body: Record<string, unknown>) {
  requireSecret("CREATOR_CODE_SECRET");
  const code = normalizeCode(body.code);
  if (!code) throw new HttpError(400, "Entrez votre code créateur.");

  const codeHash = await hmacHex(code, env("CREATOR_CODE_SECRET"));
  const { data: creator, error } = await supabase
    .from("creators")
    .select("*")
    .eq("code_hash", codeHash)
    .maybeSingle();
  if (error) throw error;
  if (!creator) throw new HttpError(401, "Code créateur incorrect.");
  const enrichedCreator = await enrichCreatorAvatar(creator);

  return {
    ok: true,
    token: await createCreatorToken(enrichedCreator.id),
    creator: toCamelCreator(enrichedCreator),
  };
}

async function getCreatorProfile(id: string) {
  const { data: creator, error } = await supabase
    .from("creators")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!creator) throw new HttpError(401, "Session créateur invalide.");
  return toCamelCreator(await enrichCreatorAvatar(creator));
}

async function createSubmission(creatorId: string, body: Record<string, unknown>) {
  const youtubeId = extractYouTubeVideoId(body.videoUrl);
  const category = cleanText(body.category, 30);
  const note = cleanText(body.note, 300);
  const tags = parseTags(body.tags);
  if (!youtubeId || !CATEGORIES[category]) {
    throw new HttpError(400, "Le lien YouTube ou la catégorie est invalide.");
  }

  const { data: creator, error: creatorError } = await supabase
    .from("creators")
    .select("*")
    .eq("id", creatorId)
    .maybeSingle();
  if (creatorError) throw creatorError;
  if (!creator) throw new HttpError(401, "Session créateur invalide.");

  const expectedChannel = creator.channel_id
    ? {
        id: creator.channel_id,
        title: creator.channel_title,
        url: creator.canonical_channel_url,
        reference: parseYouTubeChannelReference(creator.channel_url),
      }
    : await resolveYouTubeChannel(creator.channel_url);
  const video = await getYouTubeVideo(youtubeId);
  if (!sameYouTubeChannel(expectedChannel, video)) {
    throw new HttpError(403, "Cette vidéo ne provient pas de la chaîne liée à votre code.");
  }

  const verifiedChannelId = video.channelId || expectedChannel.id;
  if (verifiedChannelId && creator.channel_id !== verifiedChannelId) {
    const { error } = await supabase
      .from("creators")
      .update({
        channel_id: verifiedChannelId,
        channel_title: video.creator || expectedChannel.title,
        canonical_channel_url:
          video.channelId
            ? `https://www.youtube.com/channel/${video.channelId}`
            : expectedChannel.url || `https://www.youtube.com/channel/${verifiedChannelId}`,
        avatar_url: expectedChannel.avatar || creator.avatar_url,
      })
      .eq("id", creator.id);
    if (error) throw error;
  }

  const { data: submission, error } = await supabase
    .from("submissions")
    .insert({
      creator_id: creator.id,
      youtube_id: youtubeId,
      category,
      tags,
      note,
      day_key: dateKey(new Date(), env("APP_TIME_ZONE", "Europe/Paris")),
      video,
    })
    .select("id")
    .single();

  if (error?.code === "23505") {
    if (error.message.includes("creator_id") || error.message.includes("day_key")) {
      throw new HttpError(429, "Vous avez déjà proposé une vidéo aujourd'hui.");
    }
    throw new HttpError(409, "Cette vidéo a déjà été proposée.");
  }
  if (error) throw error;

  return {
    ok: true,
    submissionId: submission.id,
    message: "Votre demande a été transmise à l'administrateur.",
  };
}

async function dashboard() {
  const [creatorsResult, submissionsResult, videosResult] = await Promise.all([
    supabase
      .from("creators")
      .select(
        "id,email,channel_url,channel_id,channel_title,canonical_channel_url,avatar_url,code_last4,code_changed_at,created_at,pro_start_at,pro_end_at",
      )
      .order("created_at", { ascending: false }),
    supabase
      .from("submissions")
      .select(
        "*,creator:creators(id,email,channel_title,canonical_channel_url,channel_url)",
      )
      .order("submitted_at", { ascending: false }),
    supabase
      .from("videos")
      .select(
        "id,youtube_id,payload,added_at,creator_id,source_submission_id,creator:creators(id,email,channel_title,canonical_channel_url,channel_url)",
        { count: "exact" },
      )
      .order("added_at", { ascending: false }),
  ]);
  if (creatorsResult.error) throw creatorsResult.error;
  if (submissionsResult.error) throw submissionsResult.error;
  if (videosResult.error) throw videosResult.error;

  return {
    health: {
      youtubeConfigured: true,
      youtubeMetadataEnriched: Boolean(env("YOUTUBE_API_KEY")),
      mailConfigured: gmailConfigured(),
    },
    creators: (creatorsResult.data || []).map(toCamelCreator),
    submissions: (submissionsResult.data || []).map(toDashboardSubmission),
    publishedCount: videosResult.count || 0,
    videos: (videosResult.data || []).map(toDashboardVideo),
  };
}

async function createCreator(body: Record<string, unknown>) {
  requireSecret("CREATOR_CODE_SECRET");

  const email = cleanText(body.email, 160).toLowerCase();
  const channelUrl = cleanText(body.channelUrl, 300);
  const code = normalizeCode(body.code) || generateCreatorCode();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, "L'adresse e-mail n'est pas valide.");
  }
  if (!/^[A-Z0-9_-]{6,32}$/.test(code)) {
    throw new HttpError(400, "Le code doit contenir 6 à 32 lettres, chiffres, _ ou -.");
  }

  const channel = await resolveYouTubeChannel(channelUrl);
  const codeHash = await hmacHex(code, env("CREATOR_CODE_SECRET"));
  const { data: creator, error } = await supabase
    .from("creators")
    .insert({
      email,
      channel_url: channelUrl,
      channel_id: channel.id,
      channel_title: channel.title,
      canonical_channel_url: channel.url,
      avatar_url: channel.avatar || null,
      code_hash: codeHash,
      code_last4: code.slice(-4),
    })
    .select(
      "id,email,channel_url,channel_id,channel_title,canonical_channel_url,avatar_url,code_last4,created_at",
    )
    .single();
  if (error?.code === "23505") {
    throw new HttpError(409, "L'e-mail, la chaîne ou le code est déjà utilisé.");
  }
  if (error) throw error;

  let mailSent = false;
  let mailError = "";
  try {
    await sendGmailCreatorWelcome(creator, code);
    mailSent = true;
  } catch (error) {
    mailError = cleanText(error instanceof Error ? error.message : error, 300);
    console.error("Gmail creator welcome:", error);
  }

  return { creator: toCamelCreator(creator), code, mailSent, mailError };
}

async function resetCreatorCode(id: string, body: Record<string, unknown>) {
  requireSecret("CREATOR_CODE_SECRET");
  const code = normalizeCode(body.code) || generateCreatorCode();
  if (!/^[A-Z0-9_-]{6,32}$/.test(code)) {
    throw new HttpError(400, "Le code doit contenir 6 à 32 lettres, chiffres, _ ou -.");
  }
  const codeHash = await hmacHex(code, env("CREATOR_CODE_SECRET"));
  const { data: creator, error } = await supabase
    .from("creators")
    .update({
      code_hash: codeHash,
      code_last4: code.slice(-4),
      code_changed_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select(
      "id,email,channel_url,channel_id,channel_title,canonical_channel_url,avatar_url,code_last4,code_changed_at,created_at",
    )
    .maybeSingle();
  if (error?.code === "23505") {
    throw new HttpError(409, "Ce code créateur est déjà utilisé.");
  }
  if (error) throw error;
  if (!creator) throw new HttpError(404, "Créateur introuvable.");
  return { ok: true, creator: toCamelCreator(creator), code };
}

async function setCreatorPro(id: string, body: Record<string, unknown>) {
  const enabled = body.enabled !== false;
  let proStartAt: string | null = null;
  let proEndAt: string | null = null;

  if (enabled) {
    const startDate = cleanText(body.startDate, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      throw new HttpError(400, "Choisissez une date de début valide.");
    }
    const start = new Date(`${startDate}T00:00:00.000Z`);
    if (Number.isNaN(start.getTime()) || start.toISOString().slice(0, 10) !== startDate) {
      throw new HttpError(400, "Choisissez une date de début valide.");
    }
    proStartAt = start.toISOString();
    proEndAt = addUtcMonth(start).toISOString();
  }

  const { data: creator, error } = await supabase
    .from("creators")
    .update({ pro_start_at: proStartAt, pro_end_at: proEndAt })
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  if (!creator) throw new HttpError(404, "Créateur introuvable.");
  return { ok: true, creator: toCamelCreator(creator) };
}

async function deletePublishedVideo(id: string) {
  const { data: video, error } = await supabase
    .from("videos")
    .delete()
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!video) throw new HttpError(404, "Vidéo publiée introuvable.");
  return { ok: true, deletedId: video.id };
}

async function reviewSubmission(id: string, body: Record<string, unknown>) {
  const decision =
    body.decision === "accepted"
      ? "accepted"
      : body.decision === "rejected"
        ? "rejected"
        : null;
  if (!decision) throw new HttpError(400, "Décision invalide.");
  const reason = cleanText(body.reason, 500);

  const { data: submission, error } = await supabase
    .from("submissions")
    .select("*,creator:creators(*)")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!submission) throw new HttpError(404, "Demande introuvable.");
  if (submission.status !== "pending") {
    throw new HttpError(409, "Cette demande a déjà été traitée.");
  }

  const publicVideo = toPublicVideo(submission, new Date().toISOString());
  const { data: reviewed, error: reviewError } = await supabase.rpc("review_submission", {
    p_submission_id: id,
    p_decision: decision,
    p_reason: reason,
    p_public_video: publicVideo,
  });
  if (reviewError?.message.includes("submission_not_pending")) {
    throw new HttpError(409, "Cette demande a déjà été traitée.");
  }
  if (reviewError) throw reviewError;

  const result = await sendDecisionAndRecord(
    submission.creator,
    { ...submission, ...reviewed, status: decision, review_reason: reason },
  );
  return { ok: true, mailSent: result.mailSent };
}

async function resendEmail(id: string) {
  const { data: submission, error } = await supabase
    .from("submissions")
    .select("*,creator:creators(*)")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!submission) throw new HttpError(404, "Demande introuvable.");
  if (submission.status === "pending") {
    throw new HttpError(409, "La demande n'a pas encore été traitée.");
  }
  const result = await sendDecisionAndRecord(submission.creator, submission);
  return { ok: true, mailSent: result.mailSent };
}

async function sendDecisionAndRecord(creator: Record<string, unknown>, submission: any) {
  let mailSent = false;
  let mailError = "";
  try {
    await sendGmailDecision(creator, submission);
    mailSent = true;
  } catch (error) {
    mailError = cleanText(error instanceof Error ? error.message : error, 300);
    console.error("Gmail error:", error);
  }

  const { error } = await supabase
    .from("submissions")
    .update({
      email_status: mailSent ? "sent" : "failed",
      email_sent_at: mailSent ? new Date().toISOString() : null,
      email_error: mailError,
    })
    .eq("id", submission.id);
  if (error) throw error;
  return { mailSent };
}

async function resolveYouTubeChannel(input: unknown) {
  const reference = parseYouTubeChannelReference(input);
  if (!reference) throw new HttpError(400, "Le lien de chaîne YouTube n'est pas valide.");
  if (!env("YOUTUBE_API_KEY")) {
    const fallbackUrl =
      reference.type === "id"
        ? `https://www.youtube.com/channel/${reference.value}`
        : `https://www.youtube.com/@${reference.value}`;
    const preview = await getYouTubeChannelPreview(fallbackUrl);
    return {
      id: preview.id || (reference.type === "id" ? reference.value : null),
      title:
        preview.title ||
        (reference.type === "handle" ? `@${reference.value}` : "Chaîne YouTube"),
      url: preview.url || fallbackUrl,
      avatar: preview.avatar || null,
      reference: preview.id
        ? { type: "id", value: preview.id }
        : reference,
    };
  }

  const params: Record<string, string> = { part: "id,snippet,statistics" };
  params[reference.type === "id" ? "id" : "forHandle"] = reference.value;
  const payload = await youtubeRequest("channels", params);
  const channel = payload.items?.[0];
  if (!channel) throw new HttpError(404, "Cette chaîne YouTube est introuvable.");
  return {
    id: channel.id,
    title: channel.snippet?.title || "Chaîne YouTube",
    url: `https://www.youtube.com/channel/${channel.id}`,
    avatar:
      channel.snippet?.thumbnails?.high?.url ||
      channel.snippet?.thumbnails?.medium?.url ||
      channel.snippet?.thumbnails?.default?.url ||
      null,
    reference: { type: "id", value: channel.id },
  };
}

async function enrichCreatorAvatar(creator: any) {
  if (creator.avatar_url) return creator;
  try {
    const channel = await resolveYouTubeChannel(
      creator.canonical_channel_url || creator.channel_url,
    );
    if (!channel.avatar) return creator;
    const updates = {
      avatar_url: channel.avatar,
      channel_id: creator.channel_id || channel.id,
      channel_title: creator.channel_title || channel.title,
      canonical_channel_url: creator.canonical_channel_url || channel.url,
    };
    const { data, error } = await supabase
      .from("creators")
      .update(updates)
      .eq("id", creator.id)
      .select("*")
      .single();
    if (error) throw error;
    return data;
  } catch (error) {
    console.warn("YouTube avatar:", error);
    return creator;
  }
}

async function getYouTubeChannelPreview(channelUrl: string) {
  try {
    const response = await fetch(channelUrl, {
      headers: {
        "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.7",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) return {};
    const html = await response.text();
    const id =
      firstMatch(html, /<meta\s+itemprop="channelId"\s+content="([^"]+)"/i) ||
      firstMatch(html, /"externalId":"(UC[A-Za-z0-9_-]{22})"/) ||
      firstMatch(html, /"channelId":"(UC[A-Za-z0-9_-]{22})"/);
    const title =
      metaContent(html, "og:title") ||
      firstMatch(html, /<title>([^<]+)<\/title>/i)?.replace(/\s*-\s*YouTube\s*$/, "");
    const avatar =
      metaContent(html, "og:image") ||
      firstMatch(html, /"avatar":\{"thumbnails":\[\{"url":"([^"]+)"/);
    const canonical =
      firstMatch(html, /<link\s+rel="canonical"\s+href="([^"]+)"/i) ||
      firstMatch(html, /<link\s+href="([^"]+)"\s+rel="canonical"/i);
    return {
      id: cleanText(decodeYouTubeValue(id), 40) || null,
      title: cleanText(decodeYouTubeValue(title), 120) || null,
      avatar: cleanText(decodeYouTubeValue(avatar), 600) || null,
      url: cleanText(decodeYouTubeValue(canonical), 300) || channelUrl,
    };
  } catch {
    return {};
  }
}

function metaContent(html: string, property: string) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    firstMatch(
      html,
      new RegExp(
        `<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)["']`,
        "i",
      ),
    ) ||
    firstMatch(
      html,
      new RegExp(
        `<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escaped}["']`,
        "i",
      ),
    )
  );
}

function firstMatch(value: string, pattern: RegExp) {
  return value.match(pattern)?.[1] || "";
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeYouTubeValue(value: unknown) {
  return String(value || "")
    .replaceAll("\\u0026", "&")
    .replaceAll("\\/", "/")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

async function getYouTubeVideo(videoId: string) {
  if (!env("YOUTUBE_API_KEY")) return getYouTubeVideoFromOEmbed(videoId);

  const payload = await youtubeRequest("videos", {
    part: "snippet,contentDetails,statistics,status",
    id: videoId,
  });
  const video = payload.items?.[0];
  if (!video) throw new HttpError(404, "Cette vidéo YouTube est introuvable.");
  if (video.status?.privacyStatus !== "public") {
    throw new HttpError(400, "La vidéo doit être publique sur YouTube.");
  }
  if (video.status?.embeddable === false) {
    throw new HttpError(400, "Cette vidéo n'autorise pas la lecture intégrée.");
  }

  const channelPayload = await youtubeRequest("channels", {
    part: "statistics",
    id: video.snippet.channelId,
  });
  const thumbnails = video.snippet.thumbnails || {};
  return {
    youtubeId: video.id,
    title: video.snippet.title,
    creator: video.snippet.channelTitle,
    channelId: video.snippet.channelId,
    channelUrl: `https://www.youtube.com/channel/${video.snippet.channelId}`,
    reference: { type: "id", value: video.snippet.channelId },
    description: video.snippet.description || "",
    publishedAt: video.snippet.publishedAt,
    duration: formatYouTubeDuration(video.contentDetails?.duration),
    views: Number(video.statistics?.viewCount || 0),
    subscribers: Number(channelPayload.items?.[0]?.statistics?.subscriberCount || 0),
    thumbnail:
      thumbnails.maxres?.url ||
      thumbnails.standard?.url ||
      thumbnails.high?.url ||
      `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`,
  };
}

async function getYouTubeVideoFromOEmbed(videoId: string) {
  const url = new URL("https://www.youtube.com/oembed");
  url.searchParams.set("url", `https://www.youtube.com/watch?v=${videoId}`);
  url.searchParams.set("format", "json");

  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  } catch {
    throw new HttpError(502, "YouTube ne répond pas pour le moment.");
  }
  if (!response.ok) {
    throw new HttpError(404, "Cette vidéo YouTube est introuvable ou n'est pas publique.");
  }
  const payload = await response.json();
  const authorReference = parseYouTubeChannelReference(payload.author_url);
  if (!authorReference) {
    throw new HttpError(502, "YouTube n'a pas fourni la chaîne propriétaire de cette vidéo.");
  }

  let channelId = authorReference.type === "id" ? authorReference.value : null;
  let channelUrl = payload.author_url;
  if (!channelId) {
    const channel = await resolveYouTubeChannel(payload.author_url);
    channelId = channel.id;
    channelUrl = channel.url || channelUrl;
  }

  return {
    youtubeId: videoId,
    title: cleanText(payload.title, 200),
    creator: cleanText(payload.author_name, 100),
    channelId,
    channelUrl,
    reference: authorReference,
    description: "",
    publishedAt: await getYouTubePublishedAt(videoId, channelId),
    duration: "YouTube",
    views: 0,
    subscribers: 0,
    thumbnail:
      payload.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  };
}

async function getYouTubePublishedAt(videoId: string, channelId: string | null) {
  if (channelId) {
    try {
      const response = await fetch(
        `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`,
        { signal: AbortSignal.timeout(12000) },
      );
      if (response.ok) {
        const xml = await response.text();
        const escapedVideoId = escapeRegExp(videoId);
        const publishedAt = firstMatch(
          xml,
          new RegExp(
            `<entry>[\\s\\S]*?<yt:videoId>${escapedVideoId}</yt:videoId>[\\s\\S]*?<published>([^<]+)</published>[\\s\\S]*?</entry>`,
          ),
        );
        const timestamp = Date.parse(publishedAt);
        if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
      }
    } catch {
      // Try the public embed metadata below.
    }
  }

  return getYouTubePublishedAtFromEmbed(videoId);
}

async function getYouTubePublishedAtFromEmbed(videoId: string) {
  try {
    const response = await fetch(
      `https://www.youtube.com/embed/${encodeURIComponent(videoId)}`,
      {
        headers: {
          "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.7",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36",
        },
        signal: AbortSignal.timeout(12000),
      },
    );
    if (!response.ok) return null;

    const html = await response.text();
    const publishedAt =
      firstMatch(html, /"publishDate":"([^"]+)"/) ||
      firstMatch(html, /"uploadDate":"([^"]+)"/) ||
      firstMatch(
        html,
        /<meta\s+itemprop=["']datePublished["']\s+content=["']([^"']+)["']/i,
      );
    const timestamp = Date.parse(publishedAt);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
  } catch {
    return null;
  }
}

function hasSyntheticPublishedAt(publishedAt: unknown, addedAt: unknown) {
  if (!publishedAt) return false;
  const publishedTime = Date.parse(String(publishedAt || ""));
  const addedTime = Date.parse(String(addedAt || ""));
  if (!Number.isFinite(publishedTime) || !Number.isFinite(addedTime)) return true;
  return Math.abs(addedTime - publishedTime) < 10 * 60 * 1000;
}

async function youtubeRequest(resource: string, params: Record<string, string>) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
  Object.entries({ ...params, key: env("YOUTUBE_API_KEY") }).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("YouTube API:", payload);
    throw new HttpError(502, "La vérification YouTube a échoué.");
  }
  return payload;
}

async function sendGmailDecision(creator: any, submission: any) {
  const accepted = submission.status === "accepted";
  const decision = accepted ? "acceptée" : "refusée";
  const reason = submission.review_reason || submission.reviewReason || "";
  const title = submission.video.title;
  const subject = accepted
    ? "Votre vidéo a été acceptée sur YouBoost"
    : "Décision concernant votre vidéo YouBoost";
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#101828">
      <div style="padding:20px;background:#07142e;color:white;border-radius:14px 14px 0 0">
        <strong style="font-size:22px">YouBoost</strong>
      </div>
      <div style="padding:26px;border:1px solid #e6e8ec;border-top:0;border-radius:0 0 14px 14px">
        <p>Bonjour ${escapeHtml(creator.channel_title || "créateur")},</p>
        <p>Votre proposition <strong>${escapeHtml(title)}</strong> a été
          <strong>${decision}</strong>.</p>
        ${reason ? `<p><strong>Message de l'équipe :</strong> ${escapeHtml(reason)}</p>` : ""}
        ${accepted ? "<p>Elle est maintenant visible sur YouBoost.</p>" : ""}
        <p style="margin-top:28px;color:#667085">L'équipe YouBoost</p>
      </div>
    </div>`;

  await sendGmailMessage(creator.email, subject, html);
}

async function sendGmailCreatorWelcome(creator: any, code: string) {
  const subject = "Votre accès créateur YouBoost";
  const siteUrl = env(
    "PUBLIC_SITE_URL",
    "https://djcreeperytb.github.io/YouBoost/",
  );
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#101828">
      <div style="padding:20px;background:#07142e;color:white;border-radius:14px 14px 0 0">
        <strong style="font-size:22px">YouBoost</strong>
      </div>
      <div style="padding:26px;border:1px solid #e6e8ec;border-top:0;border-radius:0 0 14px 14px">
        <p>Bonjour ${escapeHtml(creator.channel_title || "créateur")},</p>
        <p>Votre compte créateur YouBoost vient d'être créé.</p>
        <p>Votre code personnel est :</p>
        <p style="margin:24px 0;padding:16px;border-radius:10px;background:#f4f6fa;text-align:center">
          <strong style="font-size:24px;letter-spacing:2px">${escapeHtml(code)}</strong>
        </p>
        <p>Gardez ce code privé. Il vous permet de vous connecter et de proposer vos vidéos.</p>
        <p>
          <a href="${escapeHtml(siteUrl)}" style="color:#d92d35;font-weight:700">
            Ouvrir YouBoost
          </a>
        </p>
        <p style="margin-top:28px;color:#667085">L'équipe YouBoost</p>
      </div>
    </div>`;

  await sendGmailMessage(creator.email, subject, html);
}

async function sendGmailMessage(to: string, subject: string, html: string) {
  ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"].forEach(
    requireSecret,
  );
  const mime = [
    `From: YouBoost <${env("GMAIL_SENDER", "youboost.creators@gmail.com")}>`,
    `To: ${to}`,
    `Subject: ${encodeMimeHeader(subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    html,
  ].join("\r\n");

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env("GOOGLE_CLIENT_ID"),
      client_secret: env("GOOGLE_CLIENT_SECRET"),
      refresh_token: env("GOOGLE_REFRESH_TOKEN"),
      grant_type: "refresh_token",
    }),
  });
  const tokenPayload = await tokenResponse.json();
  if (!tokenResponse.ok || !tokenPayload.access_token) {
    const googleMessage =
      tokenPayload.error_description || tokenPayload.error || "";
    throw new Error(
      googleMessage
        ? `Autorisation Gmail refusée : ${cleanText(googleMessage, 220)}`
        : "L'autorisation Gmail doit être renouvelée.",
    );
  }

  const sendResponse = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenPayload.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw: base64Url(new TextEncoder().encode(mime)) }),
    },
  );
  if (!sendResponse.ok) {
    const gmailPayload = await sendResponse.json().catch(() => ({}));
    const googleMessage = cleanText(
      gmailPayload.error?.message || gmailPayload.error || "",
      300,
    );
    console.error("Gmail API:", gmailPayload);
    if (
      googleMessage.includes("has not been used") ||
      googleMessage.toLowerCase().includes("disabled")
    ) {
      throw new Error(
        "Gmail API est désactivée dans le projet Google Cloud. Activez Gmail API puis réessayez.",
      );
    }
    throw new Error(
      googleMessage
        ? `Envoi Gmail refusé : ${googleMessage}`
        : "L'e-mail n'a pas pu être envoyé.",
    );
  }
}

function toPublicVideo(submission: any, addedAt: string) {
  const video = submission.video;
  const creatorName = video.creator || submission.creator?.channel_title || "YouTube";
  return {
    id: `approved-${submission.id}`,
    youtubeId: video.youtubeId,
    title: video.title,
    creator: creatorName,
    creatorInitials: initials(creatorName),
    subscribers: Number(video.subscribers || 0),
    category: submission.category,
    tags: submission.tags || [],
    description:
      submission.note ||
      cleanText(video.description, 220) ||
      "Une vidéo sélectionnée par YouBoost.",
    duration: video.duration,
    publishedAt: video.publishedAt,
    addedAt,
    views: Number(video.views || 0),
    thumbnail: video.thumbnail,
    accent: CATEGORIES[submission.category] || "#ff393f",
    creatorId: submission.creator_id,
    creatorAvatar: submission.creator?.avatar_url || null,
  };
}

function toDashboardSubmission(submission: any) {
  return {
    id: submission.id,
    creatorId: submission.creator_id,
    status: submission.status,
    category: submission.category,
    tags: submission.tags,
    note: submission.note,
    submittedAt: submission.submitted_at,
    reviewedAt: submission.reviewed_at,
    reviewReason: submission.review_reason,
    video: submission.video,
    creator: submission.creator
      ? {
          id: submission.creator.id,
          email: submission.creator.email,
          channelTitle: submission.creator.channel_title,
          canonicalChannelUrl: submission.creator.canonical_channel_url,
          channelUrl: submission.creator.channel_url,
        }
      : null,
    email: {
      status: submission.email_status,
      sentAt: submission.email_sent_at,
      error: submission.email_error,
    },
  };
}

function toDashboardVideo(published: any) {
  return {
    ...published.payload,
    databaseId: published.id,
    youtubeId: published.youtube_id,
    creatorId: published.creator_id,
    sourceSubmissionId: published.source_submission_id,
    addedAt: published.payload?.addedAt || published.added_at,
    creatorAccount: published.creator
      ? {
          id: published.creator.id,
          email: published.creator.email,
          channelTitle: published.creator.channel_title,
          canonicalChannelUrl: published.creator.canonical_channel_url,
          channelUrl: published.creator.channel_url,
        }
      : null,
  };
}

function toCamelCreator(creator: any) {
  const pro = isCreatorPro(creator);
  return {
    id: creator.id,
    email: creator.email,
    channelUrl: creator.channel_url,
    channelId: creator.channel_id,
    channelTitle: creator.channel_title,
    canonicalChannelUrl: creator.canonical_channel_url,
    avatarUrl: creator.avatar_url || null,
    codeLast4: creator.code_last4,
    codeChangedAt: creator.code_changed_at || null,
    createdAt: creator.created_at,
    plan: pro ? "pro" : "free",
    isPro: pro,
    proStartAt: creator.pro_start_at || null,
    proEndAt: creator.pro_end_at || null,
  };
}

function isCreatorPro(creator: any, now = Date.now()) {
  if (!creator?.pro_start_at || !creator?.pro_end_at) return false;
  const start = new Date(creator.pro_start_at).getTime();
  const end = new Date(creator.pro_end_at).getTime();
  return Number.isFinite(start) && Number.isFinite(end) && start <= now && now < end;
}

function addUtcMonth(start: Date) {
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth();
  const day = start.getUTCDate();
  const lastDayOfTargetMonth = new Date(Date.UTC(year, month + 2, 0)).getUTCDate();
  return new Date(
    Date.UTC(year, month + 1, Math.min(day, lastDayOfTargetMonth), 0, 0, 0, 0),
  );
}

async function enforceRateLimit(key: string, windowSeconds: number, maximum: number) {
  const { data, error } = await supabase.rpc("consume_request_limit", {
    p_key: key,
    p_window_seconds: windowSeconds,
    p_max_requests: maximum,
  });
  if (error) throw error;
  if (!data) throw new HttpError(429, "Trop de tentatives. Réessayez plus tard.");
}

async function createAdminToken() {
  return createSignedToken(
    { role: "admin" },
    12 * 60 * 60 * 1000,
    sessionSecret("admin"),
  );
}

async function createCreatorToken(creatorId: string) {
  return createSignedToken(
    { role: "creator", creatorId },
    30 * 24 * 60 * 60 * 1000,
    sessionSecret("creator"),
  );
}

async function createSignedToken(
  claims: Record<string, unknown>,
  lifetimeMs: number,
  secret: string,
) {
  const payload = base64Url(
    new TextEncoder().encode(
      JSON.stringify({ ...claims, exp: Date.now() + lifetimeMs }),
    ),
  );
  const signature = await hmacBase64Url(payload, secret);
  return `${payload}.${signature}`;
}

async function requireAdmin(request: Request) {
  requireSecret("ADMIN_TOKEN_SECRET");
  const authorization = request.headers.get("authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const [payload, signature] = token.split(".");
  if (!payload || !signature) throw new HttpError(401, "Session administrateur requise.");
  const expected = await hmacBase64Url(payload, env("ADMIN_TOKEN_SECRET"));
  if (!safeEqual(signature, expected)) {
    throw new HttpError(401, "Session administrateur invalide.");
  }
  try {
    const decoded = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
    if (decoded.role !== "admin" || Number(decoded.exp) < Date.now()) {
      throw new Error("expired");
    }
  } catch {
    throw new HttpError(401, "Session administrateur expirée.");
  }
}

async function requireCreator(request: Request) {
  const secret = sessionSecret("creator");
  const authorization = request.headers.get("authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const [payload, signature] = token.split(".");
  if (!payload || !signature) {
    throw new HttpError(401, "Connexion créateur requise.");
  }
  const expected = await hmacBase64Url(payload, secret);
  if (!safeEqual(signature, expected)) {
    throw new HttpError(401, "Session créateur invalide.");
  }
  try {
    const decoded = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
    if (
      decoded.role !== "creator" ||
      !decoded.creatorId ||
      Number(decoded.exp) < Date.now()
    ) {
      throw new Error("expired");
    }
    return { creatorId: String(decoded.creatorId) };
  } catch {
    throw new HttpError(401, "Session créateur expirée. Reconnectez-vous.");
  }
}

function sessionSecret(role: "admin" | "creator") {
  const name = role === "admin" ? "ADMIN_TOKEN_SECRET" : "CREATOR_SESSION_SECRET";
  const secret = env(name) || (role === "creator" ? env("ADMIN_TOKEN_SECRET") : "");
  if (!secret) throw new HttpError(503, `Le service ${name} n'est pas configuré.`);
  return secret;
}

function getCorsHeaders(origin: string) {
  return origin && isAllowedOrigin(origin)
    ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
    : {};
}

function isAllowedOrigin(origin: string) {
  if (allowedOrigins.has(origin) || origin === "null") return true;
  try {
    const url = new URL(origin);
    return (
      ["127.0.0.1", "localhost"].includes(url.hostname) ||
      url.hostname.endsWith(".github.io")
    );
  } catch {
    return false;
  }
}

function apiRoute(pathname: string) {
  const index = pathname.indexOf("/api/");
  return index >= 0 ? pathname.slice(index) : pathname;
}

function json(status: number, payload: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...headers,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function readJson(request: Request) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 20_000) throw new HttpError(413, "Requête trop volumineuse.");
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "Le contenu JSON est invalide.");
  }
}

function requireSecret(name: string) {
  if (!env(name)) throw new HttpError(503, `Le service ${name} n'est pas configuré.`);
}

function gmailConfigured() {
  return Boolean(
    env("GOOGLE_CLIENT_ID") &&
      env("GOOGLE_CLIENT_SECRET") &&
      env("GOOGLE_REFRESH_TOKEN"),
  );
}

function clientAddress(request: Request) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    request.headers.get("cf-connecting-ip") ||
    "unknown"
  );
}

function normalizeCode(value: unknown) {
  return String(value || "").trim().toUpperCase();
}

function cleanText(value: unknown, maximum: number) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function parseTags(value: unknown) {
  return String(value || "")
    .split(",")
    .map((tag) => cleanText(tag, 24))
    .filter(Boolean)
    .slice(0, 5);
}

function extractYouTubeVideoId(input: unknown) {
  try {
    const url = new URL(String(input || "").trim());
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    let videoId = "";
    if (hostname === "youtu.be") {
      videoId = url.pathname.split("/").filter(Boolean)[0] || "";
    } else if (hostname === "youtube.com" || hostname.endsWith(".youtube.com")) {
      videoId = /^\/(shorts|embed|live)\//.test(url.pathname)
        ? url.pathname.split("/").filter(Boolean)[1] || ""
        : url.searchParams.get("v") || "";
    }
    return /^[A-Za-z0-9_-]{11}$/.test(videoId) ? videoId : null;
  } catch {
    return null;
  }
}

function parseYouTubeChannelReference(input: unknown) {
  const raw = String(input || "").trim();
  if (/^UC[A-Za-z0-9_-]{22}$/.test(raw)) return { type: "id", value: raw };
  if (/^@[A-Za-z0-9._-]{3,30}$/.test(raw)) {
    return { type: "handle", value: raw.slice(1) };
  }
  try {
    const url = new URL(raw);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    if (hostname !== "youtube.com" && !hostname.endsWith(".youtube.com")) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "channel" && /^UC[A-Za-z0-9_-]{22}$/.test(parts[1] || "")) {
      return { type: "id", value: parts[1] };
    }
    if (parts[0]?.startsWith("@")) {
      return { type: "handle", value: parts[0].slice(1) };
    }
  } catch {
    return null;
  }
  return null;
}

function sameYouTubeChannel(expected: any, video: any) {
  if (expected.id && video.channelId && expected.id === video.channelId) return true;

  const expectedReferences = [
    expected.reference,
    parseYouTubeChannelReference(expected.url || ""),
  ].filter(Boolean);
  const videoReferences = [
    video.reference,
    parseYouTubeChannelReference(video.channelUrl || ""),
  ].filter(Boolean);

  return expectedReferences.some((expectedReference: any) =>
    videoReferences.some(
      (videoReference: any) =>
        expectedReference.type === videoReference.type &&
        expectedReference.value.toLowerCase() === videoReference.value.toLowerCase(),
    ),
  );
}

function dateKey(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("fr-FR", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function formatYouTubeDuration(value: unknown) {
  const match = String(value || "").match(
    /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/,
  );
  if (!match) return "YouTube";
  const hours = Number(match[2] || 0) + Number(match[1] || 0) * 24;
  const minutes = Number(match[3] || 0);
  const seconds = Number(match[4] || 0);
  const pieces = hours ? [hours, String(minutes).padStart(2, "0")] : [minutes];
  pieces.push(String(seconds).padStart(2, "0"));
  return pieces.join(":");
}

function generateCreatorCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return `YB${[...bytes].map((byte) => alphabet[byte % alphabet.length]).join("")}`;
}

function initials(value: unknown) {
  return String(value || "YT")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function escapeHtml(value: unknown) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function encodeMimeHeader(value: string) {
  return `=?UTF-8?B?${base64(new TextEncoder().encode(value))}?=`;
}

async function hmacHex(value: string, secret: string) {
  const bytes = await hmac(value, secret);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmacBase64Url(value: string, secret: string) {
  return base64Url(await hmac(value, secret));
}

async function hmac(value: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
  );
}

function safeEqual(left: string, right: string) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  if (leftBytes.length !== rightBytes.length) return false;
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

function base64(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function base64Url(bytes: Uint8Array) {
  return base64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
