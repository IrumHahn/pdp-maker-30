export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CHANNEL_VIDEOS_URL = "https://www.youtube.com/@irum_hahn/videos";
const CHANNEL_URL = "https://www.youtube.com/@irum_hahn";
const YOUTUBE_FETCH_TIMEOUT_MS = 2500;
const FALLBACK_VIDEO_IDS = [
  "ffsqj3Re33E",
  "fv7FMgWWvXc",
  "UG_AKADeO1Q",
  "oD0k4OUTqgA",
  "75Y8loCps6s"
];

export async function GET() {
  try {
    const html = await fetchChannelVideosHtml();
    const videoIds = extractYoutubeVideoIds(html);
    const randomVideoId = pickRandom(videoIds);

    if (!randomVideoId) {
      return Response.json({
        ok: true,
        video: buildWaitingVideo(pickFallbackVideoId()),
        channelUrl: CHANNEL_URL,
        source: "fallback"
      });
    }

    return Response.json({
      ok: true,
      video: buildWaitingVideo(randomVideoId),
      source: "youtube"
    });
  } catch (error) {
    return Response.json({
      ok: true,
      video: buildWaitingVideo(pickFallbackVideoId()),
      channelUrl: CHANNEL_URL,
      source: "fallback",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
}

async function fetchChannelVideosHtml() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), YOUTUBE_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(CHANNEL_VIDEOS_URL, {
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
      }
    });

    return response.ok ? response.text() : "";
  } finally {
    clearTimeout(timeout);
  }
}

function extractYoutubeVideoIds(html: string) {
  const matches = html.matchAll(/"videoId":"([^"]{11})"/g);
  const uniqueIds = Array.from(new Set(Array.from(matches, (match) => match[1]).filter(Boolean)));

  return uniqueIds
    .filter((videoId) => !videoId.startsWith("UC"))
    .slice(0, 36);
}

function buildWaitingVideo(videoId: string) {
  return {
    videoId,
    title: "한이룸 유튜브 추천 영상",
    url: `https://www.youtube.com/watch?v=${videoId}`,
    embedUrl: `https://www.youtube.com/embed/${videoId}?rel=0&modestbranding=1`
  };
}

function pickRandom<T>(values: T[]) {
  if (!values.length) {
    return null;
  }

  return values[Math.floor(Math.random() * values.length)] ?? null;
}

function pickFallbackVideoId() {
  return pickRandom(FALLBACK_VIDEO_IDS) ?? FALLBACK_VIDEO_IDS[0];
}
