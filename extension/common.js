// Shared by popup and content script.
"use strict";

const QUALITY_DEFAULT = "1080";

function fmtSize(b) {
  if (!b) return "";
  if (b >= 1073741824) return `${(b / 1073741824).toFixed(1)} ГБ`;
  if (b >= 1048576) return `${Math.round(b / 1048576)} МБ`;
  return `${Math.max(1, Math.round(b / 1024))} КБ`;
}

function fmtTime(s) {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(sec).padStart(2, "0")}`;
}

// "1:23", "01:02:03", "83" -> seconds; null if invalid
function parseTime(str) {
  const parts = String(str).trim().split(":");
  if (!parts.length || parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
  return parts.reduce((a, p) => a * 60 + Number(p), 0);
}

function fmtEta(s) {
  if (s == null || !isFinite(s)) return "";
  if (s < 60) return `${s} с`;
  return `${Math.floor(s / 60)} мин ${s % 60} с`;
}

function jobPercent(j) {
  if (j.status !== "running") return 100;
  if (j.phase === "prepare") return 0;
  if (j.phase !== "download") return 100;
  return j.total ? Math.min(100, (j.done / j.total) * 100) : 0;
}

function jobStatus(j) {
  if (j.status === "done") return `Сохранено · ${fmtSize(j.size)}`;
  if (j.status === "error") return j.error || "Ошибка";
  switch (j.phase) {
    case "prepare": return "Подготовка…";
    case "mux": return "Склеиваю видео и звук…";
    case "save": return "Сохраняю файл…";
  }
  const parts = [`${Math.floor(jobPercent(j))}%`, `${fmtSize(j.done)} из ${fmtSize(j.total)}`];
  if (j.speed) parts.push(`${fmtSize(j.speed)}/с`);
  if (j.eta != null && j.speed) parts.push(`ещё ${fmtEta(j.eta)}`);
  return parts.join(" · ");
}

// Picks the option matching a saved preference ("1080", "max", "audio" or an itag).
function pickOption(options, pref) {
  if (!options || !options.length) return null;
  if (pref === "audio") return options[options.length - 1];
  const videos = options.filter((o) => o.key !== "audio");
  const exact = options.find((o) => o.key === pref);
  if (exact) return exact;
  if (pref === "max") return videos[0];
  const limit = Number(pref) || Number(QUALITY_DEFAULT);
  return videos.find((o) => heightOf(o) <= limit) || videos[videos.length - 1] || options[0];
}

function heightOf(o) {
  return o.label === "4K" ? 2160 : o.label === "2K" ? 1440 : parseInt(o.label, 10) || 0;
}

// Icons as element specs, so no HTML strings are ever parsed.
const ICONS = {
  download: [["path", { d: "M12 4v11m-5-5 5 5 5-5M5 20h14" }]],
  scissors: [["circle", { cx: "6", cy: "6", r: "3" }], ["circle", { cx: "6", cy: "18", r: "3" }], ["path", { d: "M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12" }]],
  camera: [["path", { d: "M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.5-2h6l1.5 2h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z" }], ["circle", { cx: "12", cy: "13", r: "3.5" }]],
  image: [["rect", { x: "3.5", y: "5", width: "17", height: "14", rx: "2" }], ["circle", { cx: "9", cy: "10", r: "1.6" }], ["path", { d: "m4 17 5-5 4 4 2.5-2.5L20 18" }]],
  chevron: [["path", { d: "m7 10 5 5 5-5" }]],
  pin: [["circle", { cx: "12", cy: "12", r: "7" }], ["path", { d: "M12 2v3M12 19v3M2 12h3M19 12h3" }], ["circle", { cx: "12", cy: "12", r: "1.5" }]],
  close: [["path", { d: "M6 6l12 12M18 6 6 18" }]],
  folder: [["path", { d: "M3.5 7A1.5 1.5 0 0 1 5 5.5h4l2 2h8A1.5 1.5 0 0 1 20.5 9v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" }]],
  check: [["path", { d: "m5 12.5 4.5 4.5L19 7.5" }]],
  retry: [["path", { d: "M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5" }]],
};

const SVG_NS = "http://www.w3.org/2000/svg";

function icon(name) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  for (const [tag, attrs] of ICONS[name]) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    svg.append(e);
  }
  return svg;
}

// h("div", { className: "x", onclick }, child, "text", ...)
function h(tag, props, ...children) {
  const e = document.createElement(tag);
  for (const k in props || {}) {
    if (k === "dataset") Object.assign(e.dataset, props[k]);
    else e[k] = props[k];
  }
  for (const c of children.flat()) if (c != null && c !== false) e.append(c);
  return e;
}
