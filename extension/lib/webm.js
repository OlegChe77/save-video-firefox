// Reads YouTube's WebM (VP9) video streams as tracks for the MP4 builder,
// so VP9 ends up in an ordinary MP4 file without re-encoding.
"use strict";

const WebM = (() => {
  const ID = {
    EBML: 0x1a45dfa3, Segment: 0x18538067, Info: 0x1549a966, TimecodeScale: 0x2ad7b1,
    Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackType: 0x83, CodecID: 0x86, DefaultDuration: 0x23e383,
    Video: 0xe0, PixelWidth: 0xb0, PixelHeight: 0xba, Colour: 0x55b0, Matrix: 0x55b1, Transfer: 0x55ba, Primaries: 0x55bb,
    Cues: 0x1c53bb6b, CuePoint: 0xbb, CueTime: 0xb3, CueTrackPositions: 0xb7, CueClusterPosition: 0xf1,
    Cluster: 0x1f43b675, Timecode: 0xe7, SimpleBlock: 0xa3, BlockGroup: 0xa0, Block: 0xa1, ReferenceBlock: 0xfb,
  };
  // Elements that can follow a cluster of unknown size.
  const TOP = new Set([ID.Cluster, ID.Cues, ID.Info, ID.Tracks, 0x114d9b74, 0x1254c367, 0x1043a770, 0x1941a469]);

  // ---------- EBML ----------

  // Variable-length integer: element ids keep the length marker, sizes don't.
  // A size with all value bits set means "unknown" and is returned as -1.
  function vint(u8, p, isId) {
    const first = u8[p];
    if (first === undefined || first === 0) return null;
    let len = 1, mask = 0x80;
    while (!(first & mask)) { len++; mask >>= 1; }
    if (p + len > u8.length) return null;
    let v = isId ? first : first & (mask - 1);
    let ones = (first & (mask - 1)) === mask - 1;
    for (let i = 1; i < len; i++) {
      v = v * 256 + u8[p + i];
      if (u8[p + i] !== 0xff) ones = false;
    }
    return { v: !isId && ones ? -1 : v, len };
  }

  function header(u8, p) {
    const id = vint(u8, p, true);
    const size = id && vint(u8, p + id.len, false);
    return size ? { id: id.v, size: size.v, body: p + id.len + size.len } : null;
  }

  function* elements(u8, p, end) {
    while (p < end) {
      const h = header(u8, p);
      if (!h || h.size < 0 || h.body + h.size > end) return;
      yield h;
      p = h.body + h.size;
    }
  }

  function uint(u8, p, n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + u8[p + i];
    return v;
  }

  const child = (u8, el, id) => [...elements(u8, el.body, el.body + el.size)].find((c) => c.id === id);
  const uintOf = (u8, el, id, def) => {
    const c = child(u8, el, id);
    return c ? uint(u8, c.body, c.size) : def;
  };

  // Where the Segment's data starts and the time scale, from the start of the file.
  function segmentHead(u8) {
    const ebml = header(u8, 0);
    if (!ebml || ebml.id !== ID.EBML) throw new Error("Не WebM");
    const seg = header(u8, ebml.body + ebml.size);
    if (!seg || seg.id !== ID.Segment) throw new Error("WebM без Segment");
    let scale = 1e6;
    for (let p = seg.body; p < u8.length;) {
      const h = header(u8, p);
      if (!h || h.size < 0 || h.id === ID.Cluster || h.id === ID.Cues) break;
      if (h.id === ID.Info && h.body + h.size <= u8.length) scale = uintOf(u8, h, ID.TimecodeScale, scale);
      p = h.body + h.size;
    }
    return { seg, scale };
  }

  // Byte ranges of clusters from the Cues (the index range), like MP4.parseSidx.
  // `u8` holds the file from its start through the Cues.
  function parseCues(u8, cuesStart) {
    const { seg, scale } = segmentHead(u8);
    const cues = header(u8, cuesStart);
    if (!cues || cues.id !== ID.Cues) return null;
    const points = [];
    for (const cp of elements(u8, cues.body, cues.body + cues.size)) {
      if (cp.id !== ID.CuePoint) continue;
      const pos = child(u8, cp, ID.CueTrackPositions);
      if (!pos) continue;
      points.push({ time: uintOf(u8, cp, ID.CueTime, 0), pos: uintOf(u8, pos, ID.CueClusterPosition, 0) });
    }
    points.sort((a, b) => a.pos - b.pos);
    return points.map((c, i) => {
      const next = points[i + 1];
      return {
        start: seg.body + c.pos,
        end: next ? seg.body + next.pos - 1 : Infinity,
        time: (c.time * scale) / 1e9,
        duration: next ? ((next.time - c.time) * scale) / 1e9 : Infinity,
      };
    });
  }

  // ---------- reading a whole stream ----------

  function videoTrack(u8, tracks) {
    for (const t of elements(u8, tracks.body, tracks.body + tracks.size)) {
      if (t.id !== ID.TrackEntry || uintOf(u8, t, ID.TrackType, 0) !== 1) continue;
      const codec = child(u8, t, ID.CodecID);
      if (!codec || String.fromCharCode(...u8.subarray(codec.body, codec.body + codec.size)) !== "V_VP9") throw new Error("WebM: не VP9");
      const video = child(u8, t, ID.Video);
      const colour = video && child(u8, video, ID.Colour);
      return {
        number: uintOf(u8, t, ID.TrackNumber, 1),
        defaultDuration: uintOf(u8, t, ID.DefaultDuration, 0),
        width: video ? uintOf(u8, video, ID.PixelWidth, 0) : 0,
        height: video ? uintOf(u8, video, ID.PixelHeight, 0) : 0,
        primaries: colour ? uintOf(u8, colour, ID.Primaries, 2) : 2,
        transfer: colour ? uintOf(u8, colour, ID.Transfer, 2) : 2,
        matrix: colour ? uintOf(u8, colour, ID.Matrix, 2) : 2,
      };
    }
    throw new Error("WebM без видео");
  }

  // Walks one cluster and collects its frames: only element headers are read.
  async function readCluster(read, p, end, unknownSize, track, frag, samples) {
    let time = 0;
    while (p < end) {
      const h = header(await read(p, p + 12), 0);
      if (!h) break;
      if (unknownSize && TOP.has(h.id)) return p;
      const body = p + h.body, size = h.size;
      if (size < 0 || body + size > end) return end; // incomplete download tail
      if (h.id === ID.Timecode) {
        time = uint(await read(body, body + size), 0, size);
      } else if (h.id === ID.SimpleBlock) {
        await block(read, body, size, time, null, track, frag, samples);
      } else if (h.id === ID.BlockGroup) {
        // Block comes first; the group is a keyframe when it has no ReferenceBlock.
        let blk = null, key = true;
        for (let q = body; q < body + size;) {
          const c = header(await read(q, q + 12), 0);
          if (!c || c.size < 0) break;
          const cBody = q + c.body;
          if (c.id === ID.Block) blk = { body: cBody, size: c.size };
          else if (c.id === ID.ReferenceBlock) key = false;
          q = cBody + c.size;
        }
        if (blk) await block(read, blk.body, blk.size, time, key, track, frag, samples);
      }
      p = body + size;
    }
    return p;
  }

  async function block(read, p, size, clusterTime, key, track, frag, samples) {
    const u8 = await read(p, p + 12);
    const tn = vint(u8, 0, false);
    if (!tn || tn.v !== track.number) return;
    const flags = u8[tn.len + 2];
    if (flags & 0x06) throw new Error("WebM: склеенные кадры не поддерживаются");
    const rel = (u8[tn.len] << 24 >> 16) | u8[tn.len + 1]; // signed 16-bit
    const hl = tn.len + 3;
    samples.push({ t: clusterTime + rel, size: size - hl, offset: p + hl, sync: key === null ? !!(flags & 0x80) : key, frag });
  }

  async function readTrack(blob) {
    // Only element headers are read, a few bytes at a time: reading the frames
    // themselves would pull the whole video into memory.
    const read = MP4.reader(blob, 64);
    const start = await read(0, 64 * 1024);
    const { seg, scale } = segmentHead(start);
    const segEnd = seg.size < 0 ? blob.size : Math.min(blob.size, seg.body + seg.size);

    let track = null;
    const raw = [];
    let frag = 0;
    for (let p = seg.body; p < segEnd;) {
      const h = header(await read(p, p + 12), 0);
      if (!h) break;
      const body = p + h.body;
      if (h.id === ID.Cluster) {
        if (!track) throw new Error("WebM: нет описания дорожки");
        const end = h.size < 0 ? segEnd : Math.min(segEnd, body + h.size);
        p = await readCluster(read, body, end, h.size < 0, track, ++frag, raw);
        continue;
      }
      if (h.size < 0 || body + h.size > segEnd) break;
      if (h.id === ID.Tracks) {
        const u8 = (await read(body, body + h.size)).slice();
        track = videoTrack(u8, { body: 0, size: u8.length });
      }
      p = body + h.size;
    }
    if (!track) throw new Error("WebM без видео");

    // Block times are in the segment's scale (normally 1 ms); MP4 gets 1/1000 s.
    const ms = (t) => Math.round((t * scale) / 1e6);
    const defDur = track.defaultDuration ? Math.max(1, Math.round(track.defaultDuration / 1e6)) : 0;
    const samples = raw.map((s, i) => {
      const dts = ms(s.t);
      const next = raw[i + 1];
      return { dts, dur: next ? Math.max(0, ms(next.t) - dts) : 0, size: s.size, cto: 0, sync: s.sync, offset: s.offset, frag: s.frag };
    });
    if (samples.length) {
      const last = samples[samples.length - 1];
      last.dur = defDur || (samples.length > 1 ? samples[samples.length - 2].dur : 33);
    }

    const cfg = samples.length ? frameConfig(await read(samples[0].offset, samples[0].offset + 16)) : null;
    return {
      data: blob,
      kind: "video",
      handler: "vide",
      timescale: 1000,
      language: 0x55c4, // "und"
      width: track.width * 65536,
      height: track.height * 65536,
      editMediaTime: 0,
      hdlr: MP4.box("hdlr", new Uint8Array(8), ascii("vide"), new Uint8Array(12), ascii("VideoHandler\0")),
      mediaHeader: MP4.box("vmhd", Uint8Array.of(0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0)),
      dinf: MP4.box("dinf", MP4.box("dref", Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 1), MP4.box("url ", Uint8Array.of(0, 0, 0, 1)))),
      stsd: stsd(track, cfg || { profile: 0, bitDepth: 8, fullRange: 0 }, samples),
      samples,
    };
  }

  const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

  // Profile, bit depth and colour range from a VP9 keyframe header.
  function frameConfig(u8) {
    let bit = 0;
    const read = (n) => {
      let v = 0;
      for (let i = 0; i < n; i++, bit++) v = (v << 1) | ((u8[bit >> 3] >> (7 - (bit & 7))) & 1);
      return v;
    };
    if (read(2) !== 2) return null; // frame marker
    const low = read(1), high = read(1);
    const profile = (high << 1) | low;
    if (profile === 3) read(1);
    if (read(1)) return null; // show_existing_frame
    if (read(1) !== 0) return null; // not a keyframe
    read(2); // show_frame, error_resilient_mode
    if (read(24) !== 0x498342) return null; // sync code
    const bitDepth = profile >= 2 ? (read(1) ? 12 : 10) : 8;
    const colorSpace = read(3);
    const fullRange = colorSpace !== 7 ? read(1) : 1;
    return { profile, bitDepth, fullRange };
  }

  // VP9 level by picture size and frame rate (VP9 levels table).
  function level(w, h, fps) {
    const size = w * h, rate = size * fps;
    const table = [[36864, 829440, 10], [73728, 2764800, 11], [122880, 4608000, 20], [245760, 9216000, 21],
      [552960, 20736000, 30], [983040, 36864000, 31], [2228224, 83558400, 40], [2228224, 160432128, 41],
      [8912896, 311951360, 50], [8912896, 588251136, 51], [8912896, 1176502272, 52],
      [35651584, 1176502272, 60], [35651584, 2353004544, 61], [35651584, 4706009088, 62]];
    for (const [s, r, l] of table) if (size <= s && rate <= r) return l;
    return 62;
  }

  function stsd(track, cfg, samples) {
    const total = samples.reduce((a, s) => a + s.dur, 0);
    const fps = total ? (samples.length * 1000) / total : 30;
    const entry = new Uint8Array(78);
    const dv = new DataView(entry.buffer);
    dv.setUint16(6, 1); // data_reference_index
    dv.setUint16(24, track.width);
    dv.setUint16(26, track.height);
    dv.setUint32(28, 0x480000); // 72 dpi
    dv.setUint32(32, 0x480000);
    dv.setUint16(40, 1); // frame_count
    dv.setUint16(74, 0x18); // depth
    dv.setInt16(76, -1);
    const vpcC = MP4.box("vpcC", Uint8Array.of(1, 0, 0, 0, // version 1
      cfg.profile, level(track.width, track.height, fps),
      (cfg.bitDepth << 4) | (1 << 1) | cfg.fullRange, // 4:2:0, chroma sited with luma
      track.primaries, track.transfer, track.matrix, 0, 0));
    return MP4.box("stsd", Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 1), MP4.box("vp09", entry, vpcC));
  }

  return { parseCues, readTrack };
})();

if (typeof module !== "undefined") module.exports = WebM;
