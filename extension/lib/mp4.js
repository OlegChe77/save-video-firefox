// Minimal MP4 remuxer: turns YouTube DASH (fragmented MP4) video and audio
// streams into one regular MP4 file without re-encoding.
"use strict";

const MP4 = (() => {
  const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "mvex", "moof", "traf", "edts", "dinf"]);

  // ---------- reading ----------

  function boxes(u8, start = 0, end = u8.length) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const out = [];
    let p = start;
    while (p + 8 <= end) {
      let size = dv.getUint32(p);
      const type = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
      let header = 8;
      if (size === 1) {
        size = Number(dv.getBigUint64(p + 8));
        header = 16;
      } else if (size === 0) {
        size = end - p;
      }
      if (size < header || p + size > end) break; // truncated tail
      out.push({ type, start: p, end: p + size, body: p + header });
      p += size;
    }
    return out;
  }

  const child = (u8, box, type) => boxes(u8, box.body, box.end).find((b) => b.type === type);
  const children = (u8, box, type) => boxes(u8, box.body, box.end).filter((b) => b.type === type);
  const dvOf = (u8) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const bytes = (u8, box) => u8.subarray(box.start, box.end);

  function u64(dv, p) {
    return Number(dv.getBigUint64(p));
  }

  // Reads bytes [a, b) of a Blob through a cached window, so walking many
  // small headers doesn't turn into a disk read for each of them.
  function reader(blob, win = 1 << 20) {
    let start = 0, buf = new Uint8Array(0);
    return async (a, b) => {
      b = Math.min(b, blob.size);
      if (a < start || b > start + buf.length) {
        start = a;
        buf = new Uint8Array(await blob.slice(a, Math.min(blob.size, Math.max(b, a + win))).arrayBuffer());
      }
      return buf.subarray(a - start, b - start);
    };
  }

  // Top-level boxes of a stream kept in a Blob. moov and moof are read into
  // memory; mdat (the media itself) stays where it is.
  async function scan(blob) {
    const read = reader(blob, 16 * 1024); // a moof and the next box header usually fit
    const out = [];
    let p = 0;
    while (p + 8 <= blob.size) {
      const head = await read(p, p + 16);
      const dv = dvOf(head);
      let size = dv.getUint32(0);
      const type = String.fromCharCode(head[4], head[5], head[6], head[7]);
      let header = 8;
      if (size === 1) {
        if (head.length < 16) break;
        size = u64(dv, 8);
        header = 16;
      } else if (size === 0) {
        size = blob.size - p;
      }
      if (size < header || p + size > blob.size) break; // truncated tail
      const box = { type, start: p, end: p + size };
      if (type === "moov" || type === "moof") box.u8 = (await read(p, p + size)).slice();
      out.push(box);
      p += size;
    }
    return out;
  }

  // Parses init segment (ftyp+moov) and all moof/mdat fragments of one stream.
  async function readTrack(blob) {
    const top = await scan(blob);
    const moovBox = top.find((b) => b.type === "moov");
    if (!moovBox) throw new Error("moov not found");
    const u8 = moovBox.u8;
    const dv = dvOf(u8);
    const moov = boxes(u8)[0];
    const trak = child(u8, moov, "trak");
    const tkhd = child(u8, trak, "tkhd");
    const mdia = child(u8, trak, "mdia");
    const mdhd = child(u8, mdia, "mdhd");
    const hdlr = child(u8, mdia, "hdlr");
    const minf = child(u8, mdia, "minf");
    const stbl = child(u8, minf, "stbl");
    const stsd = child(u8, stbl, "stsd");
    const edts = child(u8, trak, "edts");

    const mdhdV = u8[mdhd.body];
    const timescale = dv.getUint32(mdhd.body + (mdhdV === 1 ? 20 : 12));
    const language = dv.getUint16(mdhd.body + (mdhdV === 1 ? 32 : 20));
    const handler = String.fromCharCode(...u8.subarray(hdlr.body + 8, hdlr.body + 12));
    const tkhdV = u8[tkhd.body];
    const whOff = tkhd.body + (tkhdV === 1 ? 88 : 76);
    const width = dv.getUint32(whOff);
    const height = dv.getUint32(whOff + 4);

    let editMediaTime = 0;
    if (edts) {
      const elst = child(u8, edts, "elst");
      if (elst && dv.getUint32(elst.body + 4) > 0) {
        const v = u8[elst.body];
        const mt = v === 1 ? Number(dv.getBigInt64(elst.body + 16)) : dv.getInt32(elst.body + 12);
        if (mt > 0) editMediaTime = mt;
      }
    }

    const trex = { dur: 0, size: 0, flags: 0 };
    const mvex = child(u8, moov, "mvex");
    const trexBox = mvex && child(u8, mvex, "trex");
    if (trexBox) {
      trex.dur = dv.getUint32(trexBox.body + 12);
      trex.size = dv.getUint32(trexBox.body + 16);
      trex.flags = dv.getUint32(trexBox.body + 20);
    }

    const samples = [];
    let frag = 0;
    for (const m of top) {
      if (m.type !== "moof") continue;
      const mu = m.u8;
      const mdv = dvOf(mu);
      for (const traf of children(mu, boxes(mu)[0], "traf")) {
        const tfhd = child(mu, traf, "tfhd");
        const tf = mdv.getUint32(tfhd.body) & 0xffffff;
        let p = tfhd.body + 8;
        let base = m.start;
        if (tf & 0x1) { base = u64(mdv, p); p += 8; }
        if (tf & 0x2) p += 4;
        const defDur = tf & 0x8 ? mdv.getUint32((p += 4) - 4) : trex.dur;
        const defSize = tf & 0x10 ? mdv.getUint32((p += 4) - 4) : trex.size;
        const defFlags = tf & 0x20 ? mdv.getUint32((p += 4) - 4) : trex.flags;

        const tfdt = child(mu, traf, "tfdt");
        let dts = 0;
        if (tfdt) dts = mu[tfdt.body] === 1 ? u64(mdv, tfdt.body + 4) : mdv.getUint32(tfdt.body + 4);

        let dataPos = base;
        for (const trun of children(mu, traf, "trun")) {
          const ver = mu[trun.body];
          const rf = mdv.getUint32(trun.body) & 0xffffff;
          const count = mdv.getUint32(trun.body + 4);
          let q = trun.body + 8;
          if (rf & 0x1) { dataPos = base + mdv.getInt32(q); q += 4; }
          let firstFlags = null;
          if (rf & 0x4) { firstFlags = mdv.getUint32(q); q += 4; }
          frag++;
          for (let i = 0; i < count; i++) {
            let dur = defDur, size = defSize, flags = defFlags, cto = 0;
            if (rf & 0x100) { dur = mdv.getUint32(q); q += 4; }
            if (rf & 0x200) { size = mdv.getUint32(q); q += 4; }
            if (rf & 0x400) { flags = mdv.getUint32(q); q += 4; }
            else if (i === 0 && firstFlags !== null) flags = firstFlags;
            if (rf & 0x800) { cto = ver === 0 ? mdv.getUint32(q) : mdv.getInt32(q); q += 4; }
            if (dataPos + size > blob.size) break; // incomplete download tail
            samples.push({ dts, dur, size, cto, sync: !((flags >> 16) & 1), offset: dataPos, frag });
            dts += dur;
            dataPos += size;
          }
        }
      }
    }

    return {
      data: blob,
      kind: handler === "vide" ? "video" : "audio",
      handler,
      timescale,
      language,
      width,
      height,
      editMediaTime,
      hdlr: bytes(u8, hdlr),
      mediaHeader: bytes(u8, child(u8, minf, handler === "vide" ? "vmhd" : "smhd") || child(u8, minf, "nmhd")),
      dinf: bytes(u8, child(u8, minf, "dinf")),
      stsd: bytes(u8, stsd),
      samples,
    };
  }

  // Byte ranges of segments from the sidx box, for downloading only part of a stream.
  function parseSidx(u8, fileOffset) {
    const box = boxes(u8).find((b) => b.type === "sidx");
    if (!box) return null;
    const dv = dvOf(u8);
    const v = u8[box.body];
    const timescale = dv.getUint32(box.body + 8);
    let p = box.body + 12;
    let time, first;
    if (v === 0) { time = dv.getUint32(p); first = dv.getUint32(p + 4); p += 8; }
    else { time = u64(dv, p); first = u64(dv, p + 8); p += 16; }
    const count = dv.getUint16(p + 2);
    p += 4;
    let pos = fileOffset + box.end + first;
    const segs = [];
    for (let i = 0; i < count; i++, p += 12) {
      const size = dv.getUint32(p) & 0x7fffffff;
      const dur = dv.getUint32(p + 4);
      segs.push({ start: pos, end: pos + size - 1, time: time / timescale, duration: dur / timescale });
      pos += size;
      time += dur;
    }
    return segs;
  }

  // ---------- trimming ----------

  // Keeps samples between `from` and `to` seconds. Video has to start on a
  // keyframe, so the frames before `from` are hidden with an edit list.
  function trim(track, from, to) {
    const ts = track.timescale;
    let s = track.samples;
    let startIdx = 0;
    if (track.kind === "video") {
      for (let i = 0; i < s.length; i++) {
        if (s[i].dts / ts > from + 0.001) break;
        if (s[i].sync) startIdx = i;
      }
    } else {
      startIdx = s.findIndex((x) => (x.dts + x.dur) / ts > from);
      if (startIdx < 0) startIdx = s.length;
    }
    let endIdx = s.length;
    if (to != null) {
      const e = s.findIndex((x, i) => i > startIdx && x.dts / ts >= to);
      if (e > 0) endIdx = e;
    }
    track.samples = s.slice(startIdx, endIdx);
    if (track.kind === "video" && track.samples.length) {
      track.preroll = Math.max(0, Math.round(from * ts) - track.samples[0].dts);
      track.editMediaTime += track.preroll;
    }
  }

  // ---------- writing ----------

  function box(type, ...parts) {
    let len = 8;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    new DataView(out.buffer).setUint32(0, len);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    let o = 8;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  function full(type, version, flags, body) {
    const head = new Uint8Array(4);
    new DataView(head.buffer).setUint32(0, (version << 24) | flags);
    return box(type, head, body);
  }

  function writer(size) {
    const u8 = new Uint8Array(size);
    const dv = new DataView(u8.buffer);
    let p = 0;
    return {
      u8,
      u32: (v) => { dv.setUint32(p, v); p += 4; },
      i32: (v) => { dv.setInt32(p, v); p += 4; },
      u64: (v) => { dv.setBigUint64(p, BigInt(v)); p += 8; },
      u16: (v) => { dv.setUint16(p, v); p += 2; },
      skip: (n) => { p += n; },
    };
  }

  const MATRIX = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];

  function mvhd(duration, nextId) {
    const w = writer(108);
    w.u64(0); w.u64(0); // creation/modification time
    w.u32(1000); w.u64(duration);
    w.u32(0x10000); w.u16(0x100); w.skip(10);
    MATRIX.forEach(w.u32);
    w.skip(24);
    w.u32(nextId);
    return full("mvhd", 1, 0, w.u8);
  }

  function tkhd(id, duration, t) {
    const w = writer(92);
    w.u64(0); w.u64(0); w.u32(id); w.u32(0); w.u64(duration);
    w.skip(8); w.u16(0); w.u16(0); w.u16(t.kind === "audio" ? 0x100 : 0); w.skip(2);
    MATRIX.forEach(w.u32);
    w.u32(t.width); w.u32(t.height);
    return full("tkhd", 1, 3, w.u8);
  }

  function mdhd(t, duration) {
    const w = writer(32);
    w.u64(0); w.u64(0); w.u32(t.timescale); w.u64(duration); w.u16(t.language); w.u16(0);
    return full("mdhd", 1, 0, w.u8);
  }

  function elst(segmentDuration, mediaTime) {
    const w = writer(24);
    w.u32(1); w.u64(segmentDuration); w.u64(mediaTime); w.u16(1); w.u16(0);
    return box("edts", full("elst", 1, 0, w.u8));
  }

  function stbl(t, chunks, chunkOffsets) {
    const s = t.samples;
    // stts: run-length sample durations
    const stts = [];
    for (const x of s) {
      const last = stts[stts.length - 1];
      if (last && last[1] === x.dur) last[0]++;
      else stts.push([1, x.dur]);
    }
    let w = writer(4 + stts.length * 8);
    w.u32(stts.length);
    for (const [n, d] of stts) { w.u32(n); w.u32(d); }
    const parts = [t.stsd, full("stts", 0, 0, w.u8)];

    // ctts: composition offsets (B-frames)
    if (s.some((x) => x.cto !== 0)) {
      const ctts = [];
      for (const x of s) {
        const last = ctts[ctts.length - 1];
        if (last && last[1] === x.cto) last[0]++;
        else ctts.push([1, x.cto]);
      }
      w = writer(4 + ctts.length * 8);
      w.u32(ctts.length);
      for (const [n, c] of ctts) { w.u32(n); w.i32(c); }
      parts.push(full("ctts", ctts.some((c) => c[1] < 0) ? 1 : 0, 0, w.u8));
    }

    // stss: keyframes (omitted when every sample is a keyframe, e.g. audio)
    if (s.some((x) => !x.sync)) {
      const keys = [];
      s.forEach((x, i) => x.sync && keys.push(i + 1));
      w = writer(4 + keys.length * 4);
      w.u32(keys.length);
      keys.forEach(w.u32);
      parts.push(full("stss", 0, 0, w.u8));
    }

    // stsc: samples per chunk
    const stsc = [];
    chunks.forEach((c, i) => {
      const last = stsc[stsc.length - 1];
      if (!last || last[1] !== c.count) stsc.push([i + 1, c.count]);
    });
    w = writer(4 + stsc.length * 12);
    w.u32(stsc.length);
    for (const [first, n] of stsc) { w.u32(first); w.u32(n); w.u32(1); }
    parts.push(full("stsc", 0, 0, w.u8));

    w = writer(8 + s.length * 4);
    w.u32(0); w.u32(s.length);
    for (const x of s) w.u32(x.size);
    parts.push(full("stsz", 0, 0, w.u8));

    w = writer(4 + chunkOffsets.length * 8);
    w.u32(chunkOffsets.length);
    chunkOffsets.forEach(w.u64);
    parts.push(full("co64", 0, 0, w.u8));

    return box("stbl", ...parts);
  }

  // One piece per fragment, copied as a whole. Inside it, each run of samples
  // stored back to back is an MP4 chunk; WebM has block headers between frames,
  // so there every frame is a chunk and the headers stay as unused bytes.
  function chunksOf(t, index) {
    const out = [];
    let cur = null, run = null;
    for (const x of t.samples) {
      if (!cur || cur.frag !== x.frag) {
        cur = { track: index, frag: x.frag, time: x.dts / t.timescale, start: x.offset, end: x.offset, runs: [] };
        out.push(cur);
        run = null;
      }
      if (!run || x.offset !== run.offset + run.size) {
        run = { offset: x.offset, size: 0, count: 0 };
        cur.runs.push(run);
      }
      run.size += x.size;
      run.count++;
      cur.end = x.offset + x.size;
    }
    return out;
  }

  // Builds a regular MP4. Returns an array of parts suitable for `new Blob(parts)`;
  // the media parts are slices of the source Blobs, so nothing is copied.
  function build(tracks) {
    tracks = tracks.filter((t) => t.samples.length);
    if (!tracks.length) throw new Error("no samples");

    // Rebase timelines so every track starts at 0.
    for (const t of tracks) {
      const base = t.samples[0].dts;
      if (base) for (const x of t.samples) x.dts -= base;
    }

    const perTrack = tracks.map(chunksOf);
    const runs = perTrack.map((pieces) => pieces.flatMap((p) => p.runs));
    const order = perTrack.flat().sort((a, b) => a.time - b.time || a.track - b.track);

    const isVideo = tracks.some((t) => t.kind === "video");
    const av1 = tracks.some((t) => String.fromCharCode(...t.stsd.subarray(20, 24)) === "av01");
    const brands = ["isom", "iso2", "mp41", isVideo ? "avc1" : "M4A ", ...(av1 ? ["av01"] : [])];
    const ftypBody = new Uint8Array(8 + brands.length * 4);
    const ftypStr = (isVideo ? "isom" : "M4A ") + "\0\0\x02\0" + brands.join("");
    for (let i = 0; i < ftypStr.length; i++) ftypBody[i] = ftypStr.charCodeAt(i);
    const ftyp = box("ftyp", ftypBody);

    const durations = tracks.map((t) => t.samples.reduce((a, x) => a + x.dur, 0));
    const shown = tracks.map((t, i) => Math.round(((durations[i] - (t.preroll || 0)) * 1000) / t.timescale));
    const movieDur = Math.max(...shown);

    const makeMoov = (offsets) =>
      box(
        "moov",
        mvhd(movieDur, tracks.length + 1),
        ...tracks.map((t, i) => {
          const msDur = shown[i];
          const edit = t.editMediaTime ? [elst(msDur, t.editMediaTime)] : [];
          return box(
            "trak",
            tkhd(i + 1, msDur, t),
            ...edit,
            box("mdia", mdhd(t, durations[i]), t.hdlr,
              box("minf", t.mediaHeader, t.dinf, stbl(t, runs[i], offsets[i])))
          );
        })
      );

    // moov size does not depend on offset values (co64 is fixed width).
    const dummy = runs.map((r) => r.map(() => 0));
    const moovSize = makeMoov(dummy).length;
    let pos = ftyp.length + moovSize + 16;
    const offsets = tracks.map(() => []);
    for (const c of order) {
      for (const r of c.runs) offsets[c.track].push(pos + r.offset - c.start);
      pos += c.end - c.start;
    }
    const mdatSize = pos - ftyp.length - moovSize;
    const mdatHead = new Uint8Array(16);
    const hv = new DataView(mdatHead.buffer);
    hv.setUint32(0, 1);
    mdatHead.set([0x6d, 0x64, 0x61, 0x74], 4);
    hv.setBigUint64(8, BigInt(mdatSize));

    const parts = [ftyp, makeMoov(offsets), mdatHead];
    for (const c of order) parts.push(tracks[c.track].data.slice(c.start, c.end));
    return parts;
  }

  return { readTrack, parseSidx, trim, build, boxes, box, reader };
})();

if (typeof module !== "undefined") module.exports = MP4;
