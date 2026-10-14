// Download bar under the YouTube player.
"use strict";

let currentId = null;
let info = null; // video info from background, for the quality menu
let jobs = [];
let pref = QUALITY_DEFAULT;

browser.storage.local.get("quality").then((s) => {
  pref = s.quality || QUALITY_DEFAULT;
  render();
});

const port = browser.runtime.connect({ name: "ui" });
port.onMessage.addListener((msg) => {
  if (msg.type === "jobs") {
    jobs = msg.jobs;
    render();
  }
});

const player = () => document.querySelector("video.html5-main-video") || document.querySelector("#movie_player video");

function videoId() {
  const u = new URL(location.href);
  return u.pathname === "/watch" ? u.searchParams.get("v") : null;
}

function videoTitle() {
  const h = document.querySelector("ytd-watch-metadata #title h1");
  return (h && h.textContent.trim()) || document.title.replace(/ - YouTube$/, "");
}

// ---------- building ----------

function buildBar() {
  const btn = (cls, name, text, title) => h("button", { className: cls, title }, icon(name), text && h("span", null, text));
  const ring = document.createElementNS(SVG_NS, "svg");
  ring.setAttribute("class", "ytdl-ring");
  ring.setAttribute("viewBox", "0 0 36 36");
  for (const cls of ["", "ytdl-ring-fill"]) {
    const c = document.createElementNS(SVG_NS, "circle");
    c.setAttribute("cx", "18");
    c.setAttribute("cy", "18");
    c.setAttribute("r", "15");
    if (cls) c.setAttribute("class", cls);
    ring.append(c);
  }
  const nowTitle = "Взять текущее время видео";

  const bar = h("div", { id: "ytdl-bar" },
    h("div", { className: "ytdl-row" },
      h("div", { className: "ytdl-split" },
        h("button", { className: "ytdl-main", title: "Скачать видео" }, icon("download"), h("span", null, "Скачать"), h("b", { className: "ytdl-q" })),
        btn("ytdl-caret", "chevron", "", "Выбрать качество"),
        h("div", { className: "ytdl-menu", hidden: true })),
      btn("ytdl-ghost ytdl-clip-toggle", "scissors", "Отрывок", "Скачать только часть видео"),
      btn("ytdl-ghost ytdl-frame", "camera", "Кадр", "Сохранить текущий кадр в PNG"),
      h("div", { className: "ytdl-job", hidden: true },
        ring,
        h("span", { className: "ytdl-job-text" }),
        h("button", { className: "ytdl-icon ytdl-job-act" }))),
    h("div", { className: "ytdl-clip", hidden: true },
      h("label", null, "Начало ", h("input", { className: "ytdl-from", spellcheck: false })),
      btn("ytdl-icon ytdl-from-now", "pin", "", nowTitle),
      h("span", { className: "ytdl-dash" }),
      h("label", null, "Конец ", h("input", { className: "ytdl-to", spellcheck: false })),
      btn("ytdl-icon ytdl-to-now", "pin", "", nowTitle),
      h("span", { className: "ytdl-clip-len" }),
      btn("ytdl-clip-go", "download", "Скачать отрывок")));

  const $ = (s) => bar.querySelector(s);
  const menu = $(".ytdl-menu");

  $(".ytdl-main").onclick = () => download();
  $(".ytdl-caret").onclick = (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    if (!menu.hidden) renderMenu();
  };
  document.addEventListener("click", (e) => {
    if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true;
  });

  $(".ytdl-clip-toggle").onclick = () => {
    const panel = $(".ytdl-clip");
    panel.hidden = !panel.hidden;
    $(".ytdl-clip-toggle").classList.toggle("ytdl-on", !panel.hidden);
    if (!panel.hidden) {
      const v = player();
      const t = v ? v.currentTime : 0;
      const dur = v && isFinite(v.duration) ? v.duration : t + 30;
      $(".ytdl-from").value = fmtTime(t);
      $(".ytdl-to").value = fmtTime(Math.min(dur, t + 30));
      updateClipLen();
    }
  };
  const setNow = (input) => () => {
    const v = player();
    if (v) input.value = fmtTime(v.currentTime);
    updateClipLen();
  };
  $(".ytdl-from-now").onclick = setNow($(".ytdl-from"));
  $(".ytdl-to-now").onclick = setNow($(".ytdl-to"));
  $(".ytdl-from").oninput = $(".ytdl-to").oninput = updateClipLen;
  $(".ytdl-clip-go").onclick = () => {
    const clip = readClip();
    if (clip) download(clip);
  };

  // YouTube hotkeys must not fire while typing time
  for (const input of bar.querySelectorAll("input")) {
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") $(".ytdl-clip-go").click();
    });
  }

  $(".ytdl-frame").onclick = () => captureFrame().then(
    () => flash($(".ytdl-frame"), "Сохранено"),
    (e) => flash($(".ytdl-frame"), e.message, true)
  );

  return bar;
}

function readClip() {
  const bar = document.getElementById("ytdl-bar");
  const from = parseTime(bar.querySelector(".ytdl-from").value);
  const to = parseTime(bar.querySelector(".ytdl-to").value);
  if (from == null || to == null || to <= from) return null;
  return { from, to };
}

function updateClipLen() {
  const bar = document.getElementById("ytdl-bar");
  const clip = readClip();
  bar.querySelector(".ytdl-clip-len").textContent = clip ? `${fmtTime(clip.to - clip.from)}` : "неверное время";
  bar.querySelector(".ytdl-clip-len").classList.toggle("ytdl-bad", !clip);
  bar.querySelector(".ytdl-clip-go").disabled = !clip;
}

function flash(btn, text, bad) {
  const span = btn.querySelector("span");
  const old = span.textContent;
  span.textContent = text;
  btn.classList.add(bad ? "ytdl-flash-bad" : "ytdl-flash");
  setTimeout(() => {
    span.textContent = old;
    btn.classList.remove("ytdl-flash", "ytdl-flash-bad");
  }, 1600);
}

function renderMenu() {
  const menu = document.querySelector("#ytdl-bar .ytdl-menu");
  if (!menu) return;
  menu.replaceChildren();
  menu.append(h("div", { className: "ytdl-menu-head" }, "Качество"));
  if (!info || info.error) {
    menu.append(h("div", { className: "ytdl-menu-empty" + (info ? " ytdl-bad" : "") }, info ? info.error : "Загрузка…"));
    return;
  }
  const chosen = pickOption(info.options, pref);
  for (const o of info.options) {
    const item = h("button", { className: "ytdl-menu-item" + (o === chosen ? " ytdl-sel" : "") },
      h("span", { className: "ytdl-check" }, icon("check")),
      h("b", null, o.label),
      h("i", { className: o.hd ? "ytdl-hd" : "" }, o.hd ? o.note || "HD" : o.note),
      h("small", null, fmtSize(o.size)));
    item.onclick = () => {
      pref = o.key === "audio" ? "audio" : String(heightOf(o));
      browser.storage.local.set({ quality: pref });
      menu.hidden = true;
      render();
      download();
    };
    menu.append(item);
  }
}

// ---------- actions ----------

function download(clip) {
  if (!currentId) return;
  const opt = info && info.options && pickOption(info.options, pref);
  browser.runtime.sendMessage({ type: "download", videoId: currentId, key: opt ? opt.key : pref, clip });
}

async function captureFrame() {
  const v = player();
  if (!v || !v.videoWidth) throw new Error("Нет кадра");
  const c = document.createElement("canvas");
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  c.getContext("2d").drawImage(v, 0, 0);
  let dataUrl;
  try {
    dataUrl = c.toDataURL("image/png");
  } catch {
    throw new Error("Кадр недоступен");
  }
  await browser.runtime.sendMessage({ type: "frame", dataUrl, title: videoTitle(), time: v.currentTime });
}

// Popup asks the page for the player time and to grab frames.
browser.runtime.onMessage.addListener((msg) => {
  if (msg.type === "playerState") {
    const v = player();
    return Promise.resolve(v ? { time: v.currentTime, duration: v.duration } : null);
  }
  if (msg.type === "captureFrame") return captureFrame().then(() => ({ ok: true }), (e) => ({ ok: false, error: e.message }));
});

// ---------- rendering ----------

function render() {
  const bar = document.getElementById("ytdl-bar");
  if (!bar) return;
  const opt = info && info.options ? pickOption(info.options, pref) : null;
  const q = bar.querySelector(".ytdl-q");
  q.textContent = opt ? `${opt.label}${opt.size ? " · " + fmtSize(opt.size) : ""}` : pref === "audio" ? "M4A" : pref === "max" ? "макс." : `${pref}p`;

  const job = jobs.filter((j) => j.videoId === currentId).sort((a, b) => b.created - a.created)[0];
  const box = bar.querySelector(".ytdl-job");
  box.hidden = !job;
  if (!job) return;
  box.dataset.state = job.status;
  const pct = jobPercent(job);
  const ring = box.querySelector(".ytdl-ring-fill");
  ring.style.strokeDashoffset = String(94.25 * (1 - pct / 100));
  box.classList.toggle("ytdl-indeterminate", job.status === "running" && job.phase !== "download");
  const text = box.querySelector(".ytdl-job-text");
  text.textContent = jobStatus(job);
  text.title = job.status === "error" ? text.textContent : ""; // long errors are cut off in the bar
  const act = box.querySelector(".ytdl-job-act");
  if (job.status === "running") {
    act.replaceChildren(icon("close"));
    act.title = "Отменить";
    act.onclick = () => browser.runtime.sendMessage({ type: "cancel", jobId: job.id });
  } else if (job.status === "done") {
    act.replaceChildren(icon("folder"));
    act.title = "Показать в папке";
    act.onclick = () => browser.runtime.sendMessage({ type: "show", jobId: job.id });
  } else {
    act.replaceChildren(icon("close"));
    act.title = "Скрыть";
    act.onclick = () => browser.runtime.sendMessage({ type: "cancel", jobId: job.id });
  }
}

async function loadInfo(id) {
  info = null;
  render();
  const res = await browser.runtime.sendMessage({ type: "info", videoId: id });
  if (id !== currentId) return;
  info = res.ok ? res.info : { error: res.error };
  render();
  const menu = document.querySelector("#ytdl-bar .ytdl-menu");
  if (menu && !menu.hidden) renderMenu();
}

function ensureBar() {
  const id = videoId();
  let bar = document.getElementById("ytdl-bar");
  if (!id) {
    if (bar) bar.remove();
    currentId = null;
    return;
  }
  const anchor = document.querySelector("ytd-watch-flexy #below ytd-watch-metadata");
  if (!anchor) return;
  if (!bar || bar.nextElementSibling !== anchor) {
    if (bar) bar.remove();
    bar = buildBar();
    anchor.before(bar);
    render();
  }
  if (id !== currentId) {
    currentId = id;
    bar.querySelector(".ytdl-clip").hidden = true;
    bar.querySelector(".ytdl-clip-toggle").classList.remove("ytdl-on");
    loadInfo(id);
  }
}

// YouTube is a single-page app: re-check after navigation and DOM re-renders.
document.addEventListener("yt-navigate-finish", ensureBar);
setInterval(ensureBar, 1000);
ensureBar();
