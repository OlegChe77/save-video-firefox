// Gets video info and direct stream URLs from YouTube's InnerTube API.
"use strict";

const YT = (() => {
  // The visionOS client returns plain stream URLs that need no player JS.
  const CLIENT = {
    clientName: "VISIONOS",
    clientVersion: "1.02",
    deviceMake: "Apple",
    deviceModel: "RealityDevice17,1",
    osName: "visionOS",
    osVersion: "26.5.23O471",
    hl: "ru",
  };
  const CLIENT_ID = "101";
  const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";

  let visitor = null; // { id, time }
  const cache = new Map(); // videoId -> { info, time }

  async function visitorData(videoId) {
    if (visitor && Date.now() - visitor.time < 3600e3) return visitor.id;
    const html = await fetch(`https://www.youtube.com/watch?v=${videoId}`, { credentials: "omit" }).then((r) => r.text());
    const m = html.match(/"VISITOR_DATA":"([^"]+)"/);
    if (!m) throw new Error("Не удалось связаться с YouTube");
    visitor = { id: m[1], time: Date.now() };
    return visitor.id;
  }

  async function player(videoId) {
    const res = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
      method: "POST",
      credentials: "omit",
      headers: {
        "Content-Type": "application/json",
        "X-YouTube-Client-Name": CLIENT_ID,
        "X-YouTube-Client-Version": CLIENT.clientVersion,
        "X-Goog-Visitor-Id": await visitorData(videoId),
      },
      body: JSON.stringify({
        context: { client: { ...CLIENT, userAgent: UA } },
        videoId,
        contentCheckOk: true,
        racyCheckOk: true,
      }),
    });
    if (!res.ok) throw new Error(`YouTube ответил ${res.status}`);
    return res.json();
  }

  const codecOf = (f) => (f.mimeType.match(/codecs="([^".]+)/) || [])[1];

  function parse(videoId, r) {
    const ps = r.playabilityStatus || {};
    if (ps.status !== "OK") {
      if (ps.status === "LOGIN_REQUIRED") visitor = null;
      throw new Error(ps.reason || "Видео недоступно");
    }
    const d = r.videoDetails || {};
    if (d.isLive || d.isLiveContent && !Number(d.lengthSeconds)) throw new Error("Прямые трансляции не поддерживаются");
    const all = (r.streamingData && r.streamingData.adaptiveFormats) || [];
    const mp4 = all.filter((f) => f.url && f.contentLength && f.indexRange && f.mimeType.includes("mp4"));

    const audios = mp4.filter((f) => f.mimeType.startsWith("audio/") && !f.isDrc);
    const defAudio = audios.filter((f) => !f.audioTrack || f.audioTrack.audioIsDefault);
    const audio = (defAudio.length ? defAudio : audios).sort((a, b) => b.bitrate - a.bitrate)[0];

    // One option per resolution: H.264 plays everywhere; AV1 only when there's no H.264.
    const byHeight = new Map();
    for (const f of mp4) {
      if (!f.mimeType.startsWith("video/")) continue;
      const codec = codecOf(f);
      if (codec !== "avc1" && codec !== "av01") continue;
      const prev = byHeight.get(f.height);
      const better = !prev ||
        (codecOf(prev) !== "avc1" && codec === "avc1") ||
        (codecOf(prev) === codec && (f.fps > prev.fps || (f.fps === prev.fps && f.bitrate > prev.bitrate)));
      if (better) byHeight.set(f.height, f);
    }
    const videos = [...byHeight.values()].sort((a, b) => b.height - a.height);
    if (!audio) throw new Error("YouTube не отдал звуковую дорожку");

    const thumbs = (d.thumbnail && d.thumbnail.thumbnails) || [];
    return {
      id: videoId,
      title: d.title || videoId,
      author: d.author || "",
      duration: Number(d.lengthSeconds) || 0,
      thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
      thumbnailHd: (thumbs[thumbs.length - 1] || {}).url || `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
      audio,
      videos,
      options: [
        ...videos.map((v) => ({
          key: String(v.itag),
          label: label(v),
          note: codecOf(v) === "av01" ? "AV1" : v.fps > 30 ? `${v.fps} fps` : "",
          size: Number(v.contentLength) + Number(audio.contentLength),
          hd: v.height >= 720,
        })),
        { key: "audio", label: "Только звук", note: "M4A", size: Number(audio.contentLength), hd: false },
      ],
    };
  }

  function label(v) {
    const h = Math.min(v.width, v.height); // vertical videos (Shorts) report width < height
    return h >= 2160 ? "4K" : h >= 1440 ? "2K" : `${h}p`;
  }

  async function info(videoId, fresh = false) {
    const c = cache.get(videoId);
    if (!fresh && c && Date.now() - c.time < 30 * 60e3) return c.info;
    let r = await player(videoId);
    if (r.playabilityStatus && r.playabilityStatus.status === "LOGIN_REQUIRED") {
      visitor = null; // stale visitor id - retry once with a new one
      r = await player(videoId);
    }
    const i = parse(videoId, r);
    cache.set(videoId, { info: i, time: Date.now() });
    return i;
  }

  function idFromUrl(url) {
    try {
      const u = new URL(url);
      if (u.hostname === "youtu.be") return u.pathname.slice(1, 12) || null;
      if (!/(^|\.)youtube\.com$/.test(u.hostname)) return null;
      if (u.pathname === "/watch") return u.searchParams.get("v");
      const m = u.pathname.match(/^\/(shorts|live|embed)\/([\w-]{11})/);
      return m ? m[2] : null;
    } catch {
      return null;
    }
  }

  return { info, idFromUrl, UA };
})();
