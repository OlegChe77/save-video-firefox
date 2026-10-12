"use strict";

const $ = (id) => document.getElementById(id);
let tab = null;
let videoId = null;
let info = null;
let pref = QUALITY_DEFAULT;
let selected = null; // chosen option

// Inline icons referenced via data-icon
for (const e of document.querySelectorAll("[data-icon]")) e.prepend(icon(e.dataset.icon));

// ---------- settings ----------

$("settings-btn").onclick = () => ($("settings").hidden = !$("settings").hidden);
browser.storage.local.get(["saveAs", "quality"]).then((s) => {
  $("save-as").checked = !!s.saveAs;
  pref = s.quality || QUALITY_DEFAULT;
  renderOptions();
});
$("save-as").onchange = () => browser.storage.local.set({ saveAs: $("save-as").checked });

// ---------- video info ----------

async function init() {
  [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  videoId = tab && tab.url ? await browser.runtime.sendMessage({ type: "idFromUrl", url: tab.url }) : null;
  if (!videoId) {
    $("empty").hidden = false;
    return;
  }
  $("video").hidden = false;
  $("thumb").src = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
  $("title").textContent = (tab.title || "").replace(/^\(\d+\)\s*/, "").replace(/ - YouTube$/, "");

  const res = await browser.runtime.sendMessage({ type: "info", videoId });
  $("loading").hidden = true;
  if (!res.ok) {
    $("info-error").hidden = false;
    $("info-error").textContent = res.error;
    return;
  }
  info = res.info;
  $("title").textContent = info.title;
  $("author").textContent = info.author;
  $("duration").textContent = info.duration ? fmtTime(info.duration) : "";
  $("options-wrap").hidden = false;
  renderOptions();
}

function renderOptions() {
  if (!info) return;
  selected = selected ? info.options.find((o) => o.key === selected.key) : pickOption(info.options, pref);
  const box = $("options");
  box.replaceChildren();
  for (const o of info.options) {
    const b = h("button", { className: "opt" + (o === selected ? " sel" : "") + (o.key === "audio" ? " wide" : "") },
      h("b", null, o.label),
      h("small", null, [o.note, fmtSize(o.size)].filter(Boolean).join(" · ")),
      o.hd && h("span", { className: "tag" }, "HD"));
    b.onclick = () => {
      selected = o;
      pref = o.key === "audio" ? "audio" : String(heightOf(o));
      browser.storage.local.set({ quality: pref });
      renderOptions();
    };
    box.append(b);
  }
  updateMeta();
}

// ---------- clip ----------

async function playerState() {
  try {
    return await browser.tabs.sendMessage(tab.id, { type: "playerState" });
  } catch {
    return null;
  }
}

function readClip() {
  if (!$("clip-on").checked) return null;
  const from = parseTime($("clip-from").value);
  const to = parseTime($("clip-to").value);
  const ok = from != null && to != null && to > from;
  $("clip-from").classList.toggle("bad", !ok);
  $("clip-to").classList.toggle("bad", !ok);
  return ok ? { from, to } : false;
}

$("clip-on").onchange = async () => {
  $("clip").hidden = !$("clip-on").checked;
  if ($("clip-on").checked && !$("clip-from").value) {
    const st = await playerState();
    const t = st ? st.time : 0;
    const dur = (info && info.duration) || t + 30;
    $("clip-from").value = fmtTime(t);
    $("clip-to").value = fmtTime(Math.min(dur, t + 30));
  }
  updateMeta();
};
for (const b of document.querySelectorAll("[data-now]")) {
  b.onclick = async () => {
    const st = await playerState();
    if (st) $(b.dataset.now).value = fmtTime(st.time);
    updateMeta();
  };
}
$("clip-from").oninput = $("clip-to").oninput = updateMeta;

function updateMeta() {
  if (!selected) return;
  const clip = readClip();
  $("download").disabled = clip === false;
  if (clip) {
    const share = info.duration ? (clip.to - clip.from) / info.duration : 0;
    $("download-meta").textContent = `${selected.label} · ${fmtTime(clip.to - clip.from)}${share ? " · ~" + fmtSize(selected.size * share) : ""}`;
  } else {
    $("download-meta").textContent = `${selected.label} · ${fmtSize(selected.size)}`;
  }
}

$("download").onclick = () => {
  const clip = readClip();
  if (clip === false || !selected) return;
  browser.runtime.sendMessage({ type: "download", videoId, key: selected.key, clip: clip || undefined });
};

// ---------- tools ----------

function flash(btn, ok, text) {
  const span = btn.querySelector(".with-icon");
  const old = span.lastChild.textContent;
  span.lastChild.textContent = text;
  btn.classList.add(ok ? "ok" : "bad");
  setTimeout(() => {
    span.lastChild.textContent = old;
    btn.classList.remove("ok", "bad");
  }, 1600);
}

$("frame").onclick = async () => {
  let res;
  try {
    res = await browser.tabs.sendMessage(tab.id, { type: "captureFrame" });
  } catch {
    res = { ok: false, error: "Обновите страницу" };
  }
  flash($("frame"), res.ok, res.ok ? "Сохранено" : res.error);
};

$("cover").onclick = async () => {
  const res = await browser.runtime.sendMessage({ type: "cover", videoId, title: info ? info.title : videoId });
  flash($("cover"), res && res.ok, res && res.ok ? "Сохранено" : "Не удалось");
};

// ---------- downloads list ----------

function renderJobs(jobs) {
  $("jobs-wrap").hidden = jobs.length === 0;
  const ul = $("jobs");
  ul.replaceChildren();
  for (const j of [...jobs].sort((a, b) => b.created - a.created)) {
    const tag = [j.label, j.clip ? `${fmtTime(j.clip.from)}–${fmtTime(j.clip.to)}` : ""].filter(Boolean).join(" · ");
    const fill = h("div");
    fill.style.width = `${jobPercent(j)}%`;
    const act = h("button", { className: "icon-btn" });
    const li = h("li", { className: j.status },
      h("img", { src: j.thumbnail, alt: "" }),
      h("div", { className: "job-main" },
        h("div", { className: "job-title", title: j.title }, j.title + " ", h("em", null, tag)),
        j.status === "running" && h("div", { className: "bar" + (j.phase !== "download" ? " busy" : "") }, fill),
        h("div", { className: "job-status" }, jobStatus(j))),
      act);

    if (j.status === "done") {
      act.replaceChildren(icon("folder"));
      act.title = "Показать в папке";
      act.onclick = () => browser.runtime.sendMessage({ type: "show", jobId: j.id });
    } else if (j.status === "error") {
      act.replaceChildren(icon("retry"));
      act.title = "Повторить";
      act.onclick = () => {
        browser.runtime.sendMessage({ type: "cancel", jobId: j.id });
        browser.runtime.sendMessage({ type: "download", videoId: j.videoId, key: pref, clip: j.clip || undefined });
      };
    } else {
      act.replaceChildren(icon("close"));
      act.title = "Отменить";
      act.onclick = () => browser.runtime.sendMessage({ type: "cancel", jobId: j.id });
    }
    ul.append(li);
  }
}

const port = browser.runtime.connect({ name: "ui" });
port.onMessage.addListener((msg) => {
  if (msg.type === "jobs") renderJobs(msg.jobs);
});
$("clear").onclick = () => browser.runtime.sendMessage({ type: "clear" });

init();
