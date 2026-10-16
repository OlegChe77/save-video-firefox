"use strict";

const CHUNK = 8 * 1024 * 1024; // YouTube serves ranges of up to ~10 MB at full speed
const THREADS = 6;
const SMALL = 50 * 1024 * 1024; // downloads up to this size stay in memory
const jobs = new Map();
const ui = new Set(); // connected popup / content-script ports
let nextJobId = 1;

// ---------- request headers ----------

// Requests from the extension must look like they come from the visionOS client.
browser.webRequest.onBeforeSendHeaders.addListener(
  (d) => {
    if (d.tabId !== -1) return {};
    const headers = d.requestHeaders.filter((h) => !/^(user-agent|origin|referer)$/i.test(h.name));
    headers.push({ name: "User-Agent", value: YT.UA }, { name: "Origin", value: "https://www.youtube.com" });
    if (d.url.includes("googlevideo.com")) headers.push({ name: "Referer", value: "https://www.youtube.com/" });
    return { requestHeaders: headers };
  },
  { urls: ["https://www.youtube.com/youtubei/*", "https://*.googlevideo.com/*"] },
  ["blocking", "requestHeaders"]
);

// ---------- state broadcast ----------

const publicJob = (j) => {
  const { streams, controller, ...rest } = j;
  return rest;
};

let broadcastTimer = null;
function broadcast(now = false) {
  if (broadcastTimer && !now) return;
  clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(() => (broadcastTimer = null), 250);
  const list = [...jobs.values()].map(publicJob);
  for (const port of ui) port.postMessage({ type: "jobs", jobs: list });
  const running = list.filter((j) => j.status === "running").length;
  browser.browserAction.setBadgeText({ text: running ? String(running) : "" });
}
browser.browserAction.setBadgeBackgroundColor({ color: "#ff3b30" });
browser.browserAction.setBadgeTextColor && browser.browserAction.setBadgeTextColor({ color: "#fff" });

browser.runtime.onConnect.addListener((port) => {
  ui.add(port);
  port.postMessage({ type: "jobs", jobs: [...jobs.values()].map(publicJob) });
  port.onDisconnect.addListener(() => ui.delete(port));
});

// ---------- downloading ----------

class HttpError extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

// Downloads one byte range as a Blob. Big downloads go through Response.blob(),
// which Firefox keeps in a temporary file, so even a long 4K video doesn't have
// to fit in RAM. Small ones are read piece by piece for a smooth progress ring.
async function fetchBlob(job, stream, from, to) {
  const want = to - from + 1;
  for (let attempt = 0; ; attempt++) {
    let got = 0;
    try {
      const res = await fetch(`${stream.url}&range=${from}-${to}`, { credentials: "omit", signal: job.controller.signal });
      if (!res.ok) throw new HttpError(res.status);
      let blob;
      if (job.total > SMALL) {
        blob = await res.blob();
        got = blob.size;
        progress(job, got);
      } else {
        const parts = [];
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(value);
          got += value.length;
          progress(job, value.length);
        }
        blob = new Blob(parts);
      }
      if (got > want) throw new Error("Лишние данные");
      if (got !== want) throw new Error("Обрыв соединения");
      return blob;
    } catch (e) {
      progress(job, -got);
      if (job.controller.signal.aborted) throw e;
      if (attempt >= 4) throw e;
      if (e.status === 403 || e.status === 410) await refreshUrls(job);
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
}

// Stream URLs expire or occasionally get rejected - fetch fresh ones.
async function refreshUrls(job) {
  if (job.refreshing) return job.refreshing;
  job.refreshing = YT.info(job.videoId, true)
    .then((info) => {
      for (const s of job.streams) {
        const f = s.kind === "audio" ? info.audio : info.videos.find((v) => v.itag === s.itag);
        if (f) s.url = f.url;
      }
    })
    .catch(() => {})
    .finally(() => setTimeout(() => (job.refreshing = null), 3000));
  return job.refreshing;
}

function progress(job, n) {
  job.done += n;
  const now = Date.now();
  const s = job.speedSample;
  if (now - s.time >= 1000) {
    const inst = ((job.done - s.done) * 1000) / (now - s.time);
    job.speed = job.speed ? job.speed * 0.6 + inst * 0.4 : inst;
    job.eta = job.speed > 0 ? Math.round((job.total - job.done) / job.speed) : null;
    job.speedSample = { time: now, done: job.done };
  }
  broadcast();
}

async function runPool(tasks) {
  let i = 0;
  const worker = async () => {
    while (i < tasks.length) await tasks[i++]();
  };
  await Promise.all(Array.from({ length: Math.min(THREADS, tasks.length) }, worker));
}

// Each task fills its own slot in stream.parts, so the parts stay in file order.
function chunkTasks(job, stream, from, to) {
  const tasks = [];
  for (let p = from; p <= to; p += CHUNK) {
    const end = Math.min(p + CHUNK - 1, to);
    const i = stream.parts.push(null) - 1;
    tasks.push(async () => {
      stream.parts[i] = await fetchBlob(job, stream, p, end);
    });
  }
  return tasks;
}

// Plans what to download for one stream: whole file, or init + segments of the clip.
async function plan(job, stream) {
  const clen = Number(stream.format.contentLength);
  stream.parts = [];
  if (!job.clip) return chunkTasks(job, stream, 0, clen - 1);
  const idxEnd = Number(stream.format.indexRange.end);
  const idxStart = Number(stream.format.indexRange.start);
  const head = new Uint8Array(await (await fetchBlob(job, stream, 0, idxEnd)).arrayBuffer());
  const segs = stream.webm ? WebM.parseCues(head, idxStart) : MP4.parseSidx(head.subarray(idxStart), idxStart);
  if (!segs) throw new Error("Не удалось прочитать индекс видео");
  const need = segs.filter((s) => s.time + s.duration > job.clip.from && s.time < job.clip.to);
  if (!need.length) throw new Error("Отрывок вне видео");
  const lo = need[0].start;
  const hi = Math.min(need[need.length - 1].end, clen - 1);
  const initLen = Number(stream.format.initRange.end) + 1;
  stream.parts.push(head.slice(0, initLen));
  job.total += hi - lo + 1;
  broadcast();
  return chunkTasks(job, stream, lo, hi);
}

function pickVideo(info, key) {
  if (key === "audio") return null;
  const exact = info.videos.find((v) => String(v.itag) === key);
  if (exact) return exact;
  // key is a preferred height like "1080" or "max"
  const limit = key === "max" ? Infinity : Number(key) || 1080;
  return info.videos.find((v) => Math.min(v.width, v.height) <= limit) || info.videos[info.videos.length - 1];
}

function fileName(job) {
  const clean = job.title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 150) || job.videoId;
  const clip = job.clip ? ` [${fmtTime(job.clip.from)}–${fmtTime(job.clip.to)}]`.replace(/:/g, "-") : "";
  const ext = job.audioOnly ? "m4a" : "mp4";
  return `YouTube/${clean}${job.audioOnly ? "" : ` (${job.label})`}${clip}.${ext}`;
}

function fmtTime(s) {
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(sec).padStart(2, "0")}`;
}

async function startJob({ videoId, key, clip }) {
  const job = {
    id: nextJobId++,
    videoId,
    title: videoId,
    thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    label: "",
    clip: clip || null,
    status: "running",
    phase: "prepare",
    done: 0,
    total: 0,
    speed: 0,
    eta: null,
    speedSample: { time: Date.now(), done: 0 },
    controller: new AbortController(),
    created: Date.now(),
  };
  jobs.set(job.id, job);
  broadcast(true);

  try {
    const info = await YT.info(videoId);
    const video = pickVideo(info, key);
    job.title = info.title;
    job.audioOnly = !video;
    job.label = video ? info.options.find((o) => o.key === String(video.itag)).label : "M4A";
    if (job.clip) job.clip.to = Math.min(job.clip.to, info.duration || job.clip.to);
    job.streams = [
      ...(video ? [{ kind: "video", itag: video.itag, format: video, url: video.url, webm: video.mimeType.startsWith("video/webm") }] : []),
      { kind: "audio", itag: info.audio.itag, format: info.audio, url: info.audio.url },
    ];
    if (!job.clip) job.total = job.streams.reduce((a, s) => a + Number(s.format.contentLength), 0);
    broadcast(true);

    const tasks = (await Promise.all(job.streams.map((s) => plan(job, s)))).flat();
    job.phase = "download";
    job.speedSample = { time: Date.now(), done: job.done };
    broadcast(true);
    await runPool(tasks);

    job.phase = "mux";
    broadcast(true);
    const tracks = await Promise.all(job.streams.map((s) => (s.webm ? WebM : MP4).readTrack(new Blob(s.parts))));
    if (job.clip) for (const t of tracks) MP4.trim(t, job.clip.from, job.clip.to);
    const blob = new Blob(MP4.build(tracks), { type: job.audioOnly ? "audio/mp4" : "video/mp4" });
    for (const s of job.streams) s.parts = null;

    job.phase = "save";
    job.size = blob.size;
    broadcast(true);
    const url = URL.createObjectURL(blob);
    const { saveAs } = await browser.storage.local.get("saveAs");
    try {
      job.downloadId = await browser.downloads.download({ url, filename: fileName(job), saveAs: !!saveAs, conflictAction: "uniquify" });
    } catch (e) {
      URL.revokeObjectURL(url);
      if (/cancel/i.test(e.message)) { jobs.delete(job.id); broadcast(true); return; }
      throw e;
    }
    blobUrls.set(job.downloadId, url);
    job.status = "done";
    job.finished = Date.now();
  } catch (e) {
    if (job.controller.signal.aborted) return;
    console.error(e);
    job.status = "error";
    job.error = e.name === "TypeError" ? "Нет соединения с YouTube" : e.message;
  } finally {
    if (job.streams) for (const s of job.streams) s.parts = null;
    broadcast(true);
  }
}

const blobUrls = new Map();
browser.downloads.onChanged.addListener((d) => {
  if (d.state && d.state.current !== "in_progress" && blobUrls.has(d.id)) {
    URL.revokeObjectURL(blobUrls.get(d.id));
    blobUrls.delete(d.id);
  }
});

async function saveFrame({ dataUrl, title, time }) {
  const blob = await fetch(dataUrl).then((r) => r.blob());
  const url = URL.createObjectURL(blob);
  const clean = (title || "frame").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").trim().slice(0, 120);
  const id = await browser.downloads.download({ url, filename: `YouTube/${clean} [${fmtTime(time).replace(/:/g, "-")}].png`, conflictAction: "uniquify" });
  blobUrls.set(id, url);
}

async function saveCover({ videoId, title }) {
  for (const name of ["maxresdefault", "sddefault", "hqdefault"]) {
    const res = await fetch(`https://i.ytimg.com/vi/${videoId}/${name}.jpg`, { credentials: "omit" });
    if (!res.ok) continue;
    const url = URL.createObjectURL(await res.blob());
    const clean = (title || videoId).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").trim().slice(0, 120);
    const id = await browser.downloads.download({ url, filename: `YouTube/${clean} (обложка).jpg`, conflictAction: "uniquify" });
    blobUrls.set(id, url);
    return { ok: true };
  }
  return { ok: false };
}

// ---------- messages ----------

browser.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {
    case "info":
      return YT.info(msg.videoId).then(
        (i) => ({ ok: true, info: { ...i, audio: undefined, videos: undefined } }),
        (e) => ({ ok: false, error: e.name === "TypeError" ? "Нет соединения с YouTube" : e.message })
      );
    case "idFromUrl":
      return Promise.resolve(YT.idFromUrl(msg.url));
    case "download":
      startJob(msg);
      return Promise.resolve(true);
    case "cancel": {
      const j = jobs.get(msg.jobId);
      if (j) j.controller.abort();
      jobs.delete(msg.jobId);
      broadcast(true);
      return Promise.resolve(true);
    }
    case "show": {
      const j = jobs.get(msg.jobId);
      if (j && j.downloadId != null) return browser.downloads.show(j.downloadId).catch(() => browser.downloads.showDefaultFolder());
      return Promise.resolve(browser.downloads.showDefaultFolder());
    }
    case "clear":
      for (const [id, j] of jobs) if (j.status !== "running") jobs.delete(id);
      broadcast(true);
      return Promise.resolve(true);
    case "frame":
      return saveFrame(msg);
    case "cover":
      return saveCover(msg).catch(() => ({ ok: false }));
  }
});
