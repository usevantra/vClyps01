/* ═══════════════════════════════════════════════════════════
   VANTRA BRAIN — footage understanding + editorial planner
   Runs 100% in the browser. For every source file it:
     · watches the frames  (motion, sharpness, light, color, scene cuts)
     · listens to the audio (energy, beats/BPM, speech detection)
     · optionally transcribes speech (Whisper, loaded on demand)
   Then plans a real edit from vague — or empty — prompts:
   highlight picking, story arc, beat-synced cut lengths,
   speech-safe cutting, Ken Burns on photos, fades.
   Exposes window.VantraBrain. app.js falls back to its own
   simple generator if this file fails to load.
   ═══════════════════════════════════════════════════════════ */

(function () {
  "use strict";

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, p) => a + (b - a) * p;

  function rng(seed) {
    let a = (seed * 1103515245 + 12345) & 0x7fffffff;
    return () => {
      a = (a * 1103515245 + 12345) & 0x7fffffff;
      return a / 0x7fffffff;
    };
  }

  /* ═══════════ AUDIO ANALYSIS ═══════════ */

  async function analyzeAudio(item) {
    const out = { energy: [], zcr: [], hop: 0.05, peak: 0, loud: 0, beats: [], bpm: 0, musical: 0, voiced: [] };
    if (item.type !== "video" || (item.duration || 0) > 720) return out;
    let ctx = null;
    try {
      const buf = await (await fetch(item.url)).arrayBuffer();
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      const audio = await ctx.decodeAudioData(buf);
      const sr = audio.sampleRate;
      const ch = audio.getChannelData(0);
      const hopN = Math.round(sr * 0.05);
      out.hop = hopN / sr;

      // RMS energy + zero-crossing rate (high-pitch/excitement proxy) per hop
      for (let i = 0; i + hopN <= ch.length; i += hopN) {
        let s = 0, zc = 0, last = ch[i];
        for (let j = i; j < i + hopN; j += 4) {
          s += ch[j] * ch[j];
          if ((ch[j] >= 0) !== (last >= 0)) zc++;
          last = ch[j];
        }
        out.energy.push(Math.sqrt(s / (hopN / 4)));
        out.zcr.push(zc / (hopN / 4));
      }
      const e = out.energy;
      out.peak = Math.max(1e-6, ...e.slice(0, 20000));
      for (let i = 0; i < e.length; i++) e[i] /= out.peak;
      out.loud = e.reduce((a, b) => a + b, 0) / Math.max(1, e.length);

      // onsets = positive energy flux peaks
      const flux = e.map((v, i) => Math.max(0, v - (e[i - 1] || 0)));
      const mean = flux.reduce((a, b) => a + b, 0) / Math.max(1, flux.length);
      const sd = Math.sqrt(flux.reduce((a, b) => a + (b - mean) * (b - mean), 0) / Math.max(1, flux.length));
      const th = mean + 1.4 * sd;
      const onsets = [];
      for (let i = 2; i < flux.length - 2; i++) {
        if (flux[i] > th && flux[i] >= flux[i - 1] && flux[i] >= flux[i + 1] &&
            (!onsets.length || i * out.hop - onsets[onsets.length - 1] > 0.18)) {
          onsets.push(i * out.hop);
        }
      }
      // tempo from inter-onset intervals
      const iois = [];
      for (let i = 1; i < onsets.length; i++) {
        const d = onsets[i] - onsets[i - 1];
        if (d >= 0.28 && d <= 1.1) iois.push(d);
      }
      if (iois.length >= 6) {
        iois.sort((a, b) => a - b);
        const med = iois[Math.floor(iois.length / 2)];
        const near = iois.filter((d) => Math.abs(d - med) < med * 0.14).length / iois.length;
        if (near > 0.42) {
          out.bpm = Math.round(60 / med);
          out.musical = near;
          out.beats = onsets;
        }
      }

      // voiced / audible segments (speech-safe zones)
      const vth = 0.14;
      let start = -1;
      const segs = [];
      for (let i = 0; i <= e.length; i++) {
        const on = i < e.length && e[i] > vth;
        if (on && start < 0) start = i;
        if (!on && start >= 0) {
          if ((i - start) * out.hop > 0.35) segs.push({ s: start * out.hop, e: i * out.hop });
          start = -1;
        }
      }
      // merge close segments
      for (let i = segs.length - 2; i >= 0; i--) {
        if (segs[i + 1].s - segs[i].e < 0.3) {
          segs[i].e = segs[i + 1].e;
          segs.splice(i + 1, 1);
        }
      }
      out.voiced = segs;
    } catch (err) { /* silent media or decode failure — planner copes */ }
    if (ctx) { try { ctx.close(); } catch (e) {} }
    return out;
  }

  /* ═══════════ VISUAL ANALYSIS ═══════════ */

  function analyzeFrames(item, onProg) {
    return new Promise((resolve) => {
      const empty = { samples: [], sceneCuts: [], avgMot: 0.05, avgBri: 0.5, avgCol: 0.2, avgMcx: 0.5 };
      if (item.type !== "video") {
        // single-frame stats from the photo itself
        const img = new Image();
        img.onload = () => {
          try {
            const cv = document.createElement("canvas");
            cv.width = 64; cv.height = 36;
            const cx = cv.getContext("2d");
            cx.drawImage(img, 0, 0, 64, 36);
            const st = frameStats(cx.getImageData(0, 0, 64, 36).data, null).stats;
            resolve({ samples: [{ t: 0, bri: st.bri, col: st.col, sh: st.sh, mot: 0.04, mcx: 0.5 }], sceneCuts: [], avgMot: 0.04, avgBri: st.bri, avgCol: st.col, avgMcx: 0.5 });
          } catch (e) { resolve(empty); }
        };
        img.onerror = () => resolve(empty);
        img.src = item.url;
        return;
      }

      const v = document.createElement("video");
      v.muted = true; v.playsInline = true; v.preload = "auto";
      const cv = document.createElement("canvas");
      cv.width = 64; cv.height = 36;
      const cx = cv.getContext("2d", { willReadFrequently: true });
      const samples = [];
      let prev = null, t = 0.01, step = 0.5, done = false;

      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(guard);
        const cuts = [];
        let mSum = 0, bSum = 0, cSum = 0;
        samples.forEach((s, i) => {
          mSum += s.mot; bSum += s.bri; cSum += s.col;
          if (i > 1 && s.mot > 0.16 && s.mot > 2.4 * (samples[i - 1].mot + 0.02)) cuts.push(s.t);
        });
        const n = Math.max(1, samples.length);
        let wx = 0, ww = 0;
        samples.forEach((s) => { wx += (s.mcx || 0.5) * s.mot; ww += s.mot; });
        resolve({ samples, sceneCuts: cuts, avgMot: mSum / n, avgBri: bSum / n, avgCol: cSum / n, avgMcx: ww > 0.2 ? wx / ww : 0.5 });
      };
      const guard = setTimeout(finish, 25000 + (item.duration || 30) * 1200);

      v.onerror = finish;
      v.onloadedmetadata = () => {
        step = Math.max(0.35, (v.duration || 10) / 90);
        v.currentTime = t;
      };
      v.onseeked = () => {
        try {
          cx.drawImage(v, 0, 0, 64, 36);
          const r = frameStats(cx.getImageData(0, 0, 64, 36).data, prev);
          prev = r.lum;
          samples.push({ t, bri: r.stats.bri, col: r.stats.col, sh: r.stats.sh, mot: r.stats.mot, mcx: r.stats.mcx });
        } catch (e) { /* tainted frame — skip */ }
        if (onProg) onProg(clamp(t / (v.duration || 1), 0, 1));
        t += step;
        if (t < (v.duration || 0) - 0.06) v.currentTime = t;
        else finish();
      };
      v.src = item.url;
    });
  }

  function frameStats(d, prevLum) {
    const N = 64 * 36;
    const lum = new Float32Array(N);
    let bri = 0, col = 0;
    for (let i = 0, px = 0; px < N; i += 4, px++) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const l = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
      lum[px] = l;
      bri += l;
      col += (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
    }
    bri /= N; col /= N;
    let sh = 0;
    for (let y = 0; y < 36; y++) {
      for (let x = 1; x < 64; x++) sh += Math.abs(lum[y * 64 + x] - lum[y * 64 + x - 1]);
    }
    sh /= 36 * 63;
    let mot = 0.04, mcx = 0.5;
    if (prevLum) {
      mot = 0;
      let wsum = 0, xsum = 0;
      for (let px = 0; px < N; px++) {
        const df = Math.abs(lum[px] - prevLum[px]);
        mot += df; wsum += df; xsum += df * (px % 64);
      }
      mot /= N;
      if (wsum > 0.5) mcx = (xsum / wsum) / 64; // where the action is, horizontally
    }
    return { lum, stats: { bri, col, sh, mot, mcx } };
  }

  /* ═══════════ ANALYZE ORCHESTRATION ═══════════ */

  const pending = new Map();

  function analyze(item, onStatus) {
    if (item.analysis) return Promise.resolve(item.analysis);
    if (pending.has(item.id)) return pending.get(item.id);
    const p = (async () => {
      const [vis, aud] = await Promise.all([
        analyzeFrames(item, null),
        analyzeAudio(item)
      ]);
      item.analysis = { vis, aud };
      pending.delete(item.id);
      return item.analysis;
    })();
    pending.set(item.id, p);
    return p;
  }

  async function prepare(mediaList, opts) {
    opts = opts || {};
    const say = opts.status || function () {};
    const todo = mediaList.filter((m) => !m.analysis);
    let i = 0;
    for (const m of todo) {
      i++;
      say("Watching your footage… (" + i + " of " + todo.length + ")");
      try { await analyze(m); } catch (e) { m.analysis = { vis: null, aud: null }; }
    }
    if (opts.speech) {
      const vids = mediaList.filter((m) => m.type === "video" && m.transcript === undefined);
      for (const m of vids) {
        say("Transcribing speech in “" + m.name + "”…");
        try { await transcribe(m, say); } catch (e) { m.transcript = null; }
      }
    }
    say("Scoring the best moments…");
  }

  /* ═══════════ TRANSCRIPTION (Whisper, on-demand) ═══════════ */

  let asr = null, asrLoading = null;

  async function loadASR(say) {
    if (asr) return asr;
    if (!asrLoading) {
      asrLoading = (async () => {
        say("Downloading the speech model (first time only)…");
        const T = await import("https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2");
        T.env.allowLocalModels = false;
        asr = await T.pipeline("automatic-speech-recognition", "Xenova/whisper-tiny.en", {
          progress_callback: (p) => {
            if (p.status === "progress" && p.progress) {
              say("Downloading the speech model… " + Math.round(p.progress) + "%");
            }
          }
        });
        return asr;
      })();
    }
    return asrLoading;
  }

  async function transcribe(item, say) {
    if (item.transcript !== undefined) return item.transcript;
    const model = await loadASR(say || function () {});
    // decode + resample to 16 kHz mono
    const buf = await (await fetch(item.url)).arrayBuffer();
    const probe = new (window.AudioContext || window.webkitAudioContext)();
    const audio = await probe.decodeAudioData(buf);
    probe.close();
    const off = new OfflineAudioContext(1, Math.ceil(audio.duration * 16000), 16000);
    const src = off.createBufferSource();
    src.buffer = audio;
    src.connect(off.destination);
    src.start();
    const mono = (await off.startRendering()).getChannelData(0);
    const out = await model(mono, { chunk_length_s: 30, stride_length_s: 5, return_timestamps: true });
    item.transcript = (out.chunks || []).map((c) => ({
      s: c.timestamp[0] || 0,
      e: c.timestamp[1] || (c.timestamp[0] || 0) + 4,
      text: (c.text || "").trim()
    })).filter((c) => c.text);
    return item.transcript;
  }

  /* ═══════════ INTENT (prompt + footage → decisions) ═══════════ */

  const LOOK_RULES = [
    [/cinema|film|movie|epic/, "cinematic"],
    [/vintage|retro|old school|8mm|film grain|90s|80s|nostalg/, "vintage"],
    [/black and white|b&w|noir|monochrome/, "noir"],
    [/vibrant|colorful|colourful|vivid|pop|bright/, "vivid"],
    [/warm|golden|sunset|summer|cozy|romantic|wedding/, "warm"],
    [/cool|cold|winter|blue|moody/, "cool"],
    [/dream|soft|hazy|aesthetic|nostalgic/, "dreamy"]
  ];
  const FAST_RE = /fast|quick|energetic|upbeat|punchy|hype|exciting|action|reel|tiktok|party|sport|workout|gym|montage/;
  const SLOW_RE = /slow(?![ -]?mo)|calm|emotional|relax|chill|peaceful|gentle|romantic|wedding|tribute|memory|sad/;

  function decideIntent(prompt, media, rnd, fmt) {
    const p = (prompt || "").toLowerCase();
    const reasons = [];

    // aggregate footage character
    let mot = 0, bri = 0, col = 0, loud = 0, n = 0, bpm = 0, musical = 0;
    media.forEach((m) => {
      const a = m.analysis;
      if (a && a.vis) { mot += a.vis.avgMot; bri += a.vis.avgBri; col += a.vis.avgCol; n++; }
      if (a && a.aud) {
        loud = Math.max(loud, a.aud.loud);
        if (a.aud.musical > musical) { musical = a.aud.musical; bpm = a.aud.bpm; }
      }
    });
    if (n) { mot /= n; bri /= n; col /= n; }

    // pacing
    let pace;
    if (FAST_RE.test(p)) { pace = "fast"; reasons.push("fast pacing (you asked)"); }
    else if (SLOW_RE.test(p)) { pace = "slow"; reasons.push("gentle pacing (you asked)"); }
    else if (mot > 0.085 || loud > 0.45) { pace = "fast"; reasons.push("fast pacing to match your high-energy footage"); }
    else if (mot < 0.035 && loud < 0.2) { pace = "slow"; reasons.push("calm pacing to match your quiet footage"); }
    else { pace = "medium"; reasons.push("balanced pacing"); }

    // look
    let look = null;
    for (const [re, f] of LOOK_RULES) { if (re.test(p)) { look = f; break; } }
    if (!look) {
      if (bri < 0.32) { look = "cinematic"; reasons.push("cinematic look for your low-light shots"); }
      else if (col < 0.13) { look = "vivid"; reasons.push("vivid look to lift the muted colors"); }
      else if (bri > 0.55 && col > 0.2) { look = "warm"; reasons.push("warm look to match the bright footage"); }
      else { look = "cinematic"; reasons.push("cinematic look"); }
    } else reasons.push(LOOK_RULES.find((r) => r[1] === look) ? look + " look (you asked)" : look);

    // length
    let target = null;
    let m = p.match(/(\d+)\s*(?:seconds|second|secs|sec|s\b)/);
    if (m) target = +m[1];
    else if ((m = p.match(/(\d+)\s*(?:minutes|minute|mins|min)/))) target = +m[1] * 60;
    const explicitLen = target; // user's stated length, or null — user wishes always win
    const srcTotal = media.reduce((s, x) => s + (x.duration || 3), 0);
    if (!target) target = clamp(Math.round(srcTotal * (pace === "fast" ? 0.3 : 0.45)), 12, 75);
    target = Math.min(target, Math.max(8, srcTotal * 3)); // photos can stretch a bit

    // title
    let title = null;
    m = (prompt || "").match(/"([^"]{1,40})"|'([^']{1,40})'/);
    if (m) title = m[1] || m[2];
    else if ((m = p.match(/titled\s+([a-z0-9 ,!&']{2,36})/))) {
      title = m[1].trim().replace(/\b\w/g, (ch) => ch.toUpperCase());
    }

    // format defaults fill only what the user didn't specify
    if (fmt === "film") {
      if (!FAST_RE.test(p) && !SLOW_RE.test(p)) { pace = "slow"; reasons.push("slow, filmic pacing (Film format)"); }
      if (!LOOK_RULES.some((r) => r[0].test(p))) look = "cinematic";
    }

    const slowmo = /slow[- ]?mo|slow motion/.test(p);
    const cutMin = pace === "fast" ? 0.9 : pace === "slow" ? 3.4 : 1.9;
    const cutMax = pace === "fast" ? 2.1 : pace === "slow" ? 6.2 : 3.9;

    if (bpm && pace !== "slow") reasons.push("cuts timed to the music (~" + bpm + " bpm)");

    return { pace, look, target, explicitLen, title, slowmo, cutMin, cutMax, bpm, musical, reasons };
  }

  /* ═══════════ SCORING & SEGMENT PICKING ═══════════ */

  function audioAt(aud, t) {
    if (!aud || !aud.energy.length) return 0.3;
    const i = clamp(Math.floor(t / aud.hop), 0, aud.energy.length - 1);
    return aud.energy[i];
  }

  function inVoiced(aud, t) {
    if (!aud) return null;
    for (const s of aud.voiced) if (t >= s.s && t <= s.e) return s;
    return null;
  }

  function zcrAt(aud, t) {
    if (!aud || !aud.zcr || !aud.zcr.length) return 0.1;
    const i = clamp(Math.floor(t / aud.hop), 0, aud.zcr.length - 1);
    return aud.zcr[i];
  }

  /* Wording patterns that reliably signal hooks in short-form content —
     distilled from what viral shorts have in common, encoded as rules */
  const HOOK_WORDS = /\?|wait|watch|how |why |what |never|no one|nobody|insane|crazy|secret|hack|before you|you won'?t|don'?t |stop |top \d|\d+ (things|ways|tips|reasons)|pov|listen|okay so|so basically/i;

  function hookWordBonus(item, t) {
    if (!item.transcript) return 0;
    for (const c of item.transcript) {
      if (t >= c.s - 0.3 && t <= c.e + 0.3 && HOOK_WORDS.test(c.text)) return 1;
    }
    return 0;
  }

  /* ═══════════ SHORT-FORM SCORING ═══════════
     Every instant of every clip earns hook / retention / engagement points:
     hook  = loudness spikes, motion bursts, high-pitch excitement, hook wording
     ret   = sustained energy, movement, scene variety, sharpness
     eng   = speech, audible energy, excited delivery                       */
  function shortCurves(item) {
    const a = item.analysis || {};
    const vis = a.vis, aud = a.aud;
    if (!vis || !vis.samples || vis.samples.length < 2) return null;
    let shMax = 0.001, motAvg = 0.0001, eAvg = 0.0001;
    const n = vis.samples.length;
    vis.samples.forEach((s) => { shMax = Math.max(shMax, s.sh); motAvg += s.mot; });
    motAvg /= n;
    vis.samples.forEach((s) => { eAvg += audioAt(aud, s.t); });
    eAvg /= n;
    return vis.samples.map((s) => {
      const e = audioAt(aud, s.t);
      const eSpike = clamp(e / (eAvg * 2 + 0.05), 0, 1);
      const mSpike = clamp(s.mot / (motAvg * 2 + 0.01), 0, 1);
      const pitchy = clamp(zcrAt(aud, s.t) * 3, 0, 1);
      const sharp = s.sh / shMax;
      const voice = inVoiced(aud, s.t) ? 1 : 0;
      const words = hookWordBonus(item, s.t);
      const nearCut = vis.sceneCuts.some((c) => Math.abs(c - s.t) < 1.2) ? 1 : 0;
      return {
        t: s.t,
        hook: 26 * eSpike + 22 * mSpike + 14 * pitchy + 12 * sharp + 10 * voice + 16 * words,
        ret: 30 * clamp(e / (eAvg + 0.05) / 1.5, 0, 1) + 26 * clamp(s.mot / (motAvg + 0.01) / 1.5, 0, 1) + 16 * nearCut + 14 * sharp + 14 * voice,
        eng: 40 * voice + 24 * clamp(e, 0, 1) + 16 * pitchy + 20 * words,
        mot: s.mot, e: e
      };
    });
  }

  function qualityCurve(item) {
    const a = item.analysis;
    const vis = a && a.vis, aud = a && a.aud;
    if (!vis || !vis.samples.length) return [{ t: 0, q: 0.5, mot: 0.05 }];
    // normalizers
    let shMax = 0.001, motMax = 0.001;
    vis.samples.forEach((s) => { shMax = Math.max(shMax, s.sh); motMax = Math.max(motMax, s.mot); });
    const curve = vis.samples.map((s) => {
      const sharp = s.sh / shMax;
      const briOk = clamp(1 - Math.abs(s.bri - 0.5) * 1.9, 0, 1);
      const motN = s.mot / motMax;
      const motInterest = motN < 0.75 ? motN / 0.75 : clamp(1 - (motN - 0.75) * 2.2, 0.15, 1); // chaos penalty
      const aE = audioAt(aud, s.t);
      let q = sharp * 0.24 + briOk * 0.2 + s.col * 0.6 * 0.14 + motInterest * 0.24 + aE * 0.18;
      if (inVoiced(aud, s.t)) q += 0.08;
      return { t: s.t, q, mot: s.mot };
    });
    // light smoothing
    for (let i = 1; i < curve.length - 1; i++) {
      curve[i].q = (curve[i - 1].q + curve[i].q * 2 + curve[i + 1].q) / 4;
    }
    return curve;
  }

  function buildCandidates(item, intent, rnd) {
    const cands = [];
    const dur = item.duration || 3;
    if (item.type !== "video") {
      cands.push({ item, s: 0, e: Math.min(3.2, intent.cutMax), q: (qualityCurve(item)[0].q || 0.5) * 0.92, photo: true, mot: 0.04, aE: 0.2 });
      return cands;
    }
    const curve = qualityCurve(item);
    const aud = item.analysis && item.analysis.aud;
    const minGap = intent.cutMin * 1.1;

    // peaks of the quality curve
    const peaks = [];
    for (let i = 1; i < curve.length - 1; i++) {
      if (curve[i].q >= curve[i - 1].q && curve[i].q >= curve[i + 1].q) {
        if (!peaks.length || curve[i].t - peaks[peaks.length - 1].t > minGap) peaks.push(curve[i]);
        else if (curve[i].q > peaks[peaks.length - 1].q) peaks[peaks.length - 1] = curve[i];
      }
    }
    if (!peaks.length) peaks.push(curve[Math.floor(curve.length / 2)] || { t: dur / 2, q: 0.5, mot: 0.05 });

    peaks.forEach((pk) => {
      let L = intent.cutMin + rnd() * (intent.cutMax - intent.cutMin);
      let s = clamp(pk.t - L * 0.4, 0, Math.max(0, dur - L));
      let e = Math.min(s + L, dur);
      // never cut into the middle of speech / a musical phrase
      const vs = inVoiced(aud, s), ve = inVoiced(aud, e);
      if (vs) s = Math.max(0, vs.s - 0.12);
      if (ve) e = Math.min(dur, Math.min(ve.e + 0.12, s + intent.cutMax * 1.7));
      if (e - s < 0.4) return;
      // average quality inside window
      let q = 0, cnt = 0, mot = 0;
      curve.forEach((c) => { if (c.t >= s && c.t <= e) { q += c.q; mot += c.mot; cnt++; } });
      q = cnt ? q / cnt : pk.q;
      mot = cnt ? mot / cnt : pk.mot;
      // transcript bonus: whole sentences are gold
      if (item.transcript && item.transcript.some((c) => c.s >= s - 0.2 && c.e <= e + 0.2)) q += 0.15;
      cands.push({ item, s, e, q, photo: false, mot, aE: audioAt(aud, (s + e) / 2) });
    });
    return cands;
  }

  function pickSegments(media, intent, rnd) {
    const bySource = media.map((m) => ({
      m,
      cands: buildCandidates(m, intent, rnd).sort((a, b) => b.q - a.q),
      picked: []
    })).filter((g) => g.cands.length);

    const picked = [];
    let sum = 0, safety = 0;
    // round-robin across sources for variety, best-first within each
    while (sum < intent.target && safety++ < 300) {
      let took = false;
      for (const g of bySource) {
        if (sum >= intent.target) break;
        const next = g.cands.find((c) =>
          !g.picked.some((p) => c.s < p.e + 0.25 && c.e > p.s - 0.25));
        if (!next) continue;
        g.cands = g.cands.filter((c) => c !== next);
        g.picked.push(next);
        picked.push(next);
        sum += (next.e - next.s);
        took = true;
      }
      if (!took) break; // sources exhausted — shorter than target is fine
    }
    return picked;
  }

  /* ═══════════ ARRANGEMENT (story arc) ═══════════ */

  function arrange(picked, media, rnd) {
    if (picked.length <= 2) return picked;
    const energy = (c) => c.mot * 4 + c.aE;
    // opening: calm but high quality
    let opening = picked.slice().sort((a, b) => (b.q - energy(b) * 0.25) - (a.q - energy(a) * 0.25))[0];
    // ending: the calmest of the rest
    const rest = picked.filter((c) => c !== opening);
    let ending = rest.slice().sort((a, b) => energy(a) - energy(b))[0];
    // middle: chronological story order (source order, then time)
    const mid = rest.filter((c) => c !== ending).sort((a, b) => {
      const ai = media.indexOf(a.item), bi = media.indexOf(b.item);
      return ai !== bi ? ai - bi : a.s - b.s;
    });
    // push the single most energetic middle segment toward the 3/4 mark
    if (mid.length > 3) {
      let pk = 0;
      for (let i = 1; i < mid.length; i++) if (energy(mid[i]) > energy(mid[pk])) pk = i;
      const seg = mid.splice(pk, 1)[0];
      mid.splice(Math.floor(mid.length * 0.72), 0, seg);
    }
    return [opening].concat(mid, [ending]);
  }

  /* ═══════════ FORMAT DETECTION ═══════════
     Priority: explicit user pick (opts.format) > prompt keywords > default */

  function detectFormat(prompt) {
    const p = (prompt || "").toLowerCase();
    if (/reel|shorts?\b|tiktok|tik tok|viral|for ?you|fyp/.test(p)) return "short";
    if (/\bfilm\b|movie|wedding video|documentary/.test(p)) return "film";
    if (/\bstory\b|vlog|day in/.test(p)) return "story";
    const m = p.match(/(\d+)\s*(?:seconds|second|secs|sec|s\b)/);
    if (m && +m[1] <= 60 && /hook|follow|engag/.test(p)) return "short";
    return "recap";
  }

  /* ═══════════ SHORT-FORM PLANNER: HOOK → RETENTION → CTA ═══════════ */

  function planShort(opts, intent, media, rnd) {
    const withCurves = media
      .map((m) => ({ m, curves: shortCurves(m) }))
      .filter((x) => x.curves);
    if (!withCurves.length) return null; // photos-only / unanalyzed → standard planner takes over

    const target = clamp(intent.explicitLen || 28, 10, 60);

    // ── HOOK: the single most scroll-stopping moment across all footage
    let hook = null;
    withCurves.forEach(({ m, curves }) => {
      curves.forEach((c) => { if (!hook || c.hook > hook.c.hook) hook = { m, c }; });
    });
    const hookLen = clamp(1.7 + rnd() * 1.1, 1.5, 3);
    const hookIn = clamp(hook.c.t - hookLen * 0.35, 0, Math.max(0, (hook.m.duration || hookLen) - hookLen));
    const hookPts = Math.round(clamp(hook.c.hook, 0, 100));
    const hookClip = {
      mediaId: hook.m.id, in: hookIn, out: hookIn + hookLen,
      speed: 1, volume: 1, muted: false, filter: intent.look, fadeIn: 0, fadeOut: 0
    };

    // ── CTA bed: a stable, clean closing shot
    let cta = null;
    withCurves.forEach(({ m, curves }) => {
      curves.forEach((c) => {
        const stability = c.ret - c.mot * 120; // steady but still interesting
        if (!cta || stability > cta.score) cta = { m, c, score: stability };
      });
    });
    const ctaLen = 2.4;
    const ctaIn = clamp(cta.c.t - ctaLen / 2, 0, Math.max(0, (cta.m.duration || ctaLen) - ctaLen));
    const ctaClip = {
      mediaId: cta.m.id, in: ctaIn, out: ctaIn + ctaLen,
      speed: 1, volume: 1, muted: false, filter: intent.look, fadeIn: 0, fadeOut: 0.45
    };

    // ── RETENTION: rapid middle, escalating energy, beat-locked when musical
    const beat = intent.bpm ? 60 / intent.bpm : 0;
    const midTarget = Math.max(3, target - hookLen - ctaLen);
    const cands = [];
    withCurves.forEach(({ m, curves }) => {
      for (let i = 1; i < curves.length - 1; i++) {
        const c = curves[i];
        if (c.ret >= curves[i - 1].ret && c.ret >= curves[i + 1].ret) {
          let L = beat ? Math.max(1, Math.round((1.2 + rnd() * 1.2) / beat)) * beat : 1.2 + rnd() * 1.2;
          L = clamp(L, 0.8, 2.6);
          const s = clamp(c.t - L / 2, 0, Math.max(0, (m.duration || L) - L));
          if (m === hook.m && s < hookIn + hookLen + 0.3 && s + L > hookIn - 0.3) continue;
          if (m === cta.m && s < ctaIn + ctaLen + 0.3 && s + L > ctaIn - 0.3) continue;
          cands.push({ m, s, e: s + L, ret: c.ret, energy: c.e + c.mot * 4 });
        }
      }
    });
    cands.sort((a, b) => b.ret - a.ret);
    const midPicks = [];
    let sum = 0;
    for (const c of cands) {
      if (sum >= midTarget) break;
      if (midPicks.some((q) => q.m === c.m && c.s < q.e + 0.25 && c.e > q.s - 0.25)) continue;
      midPicks.push(c);
      sum += c.e - c.s;
    }
    midPicks.sort((a, b) => a.energy - b.energy); // build toward the peak

    const clips = [hookClip];
    midPicks.forEach((c, i) => {
      const clip = {
        mediaId: c.m.id, in: c.s, out: c.e,
        speed: 1, volume: 1, muted: false, filter: intent.look, fadeIn: 0, fadeOut: 0
      };
      // pattern interrupts every third cut: punch-in zoom or speed ramp
      if (i % 3 === 2) {
        if (c.energy < 0.5) clip.speed = 1.35;
        else clip.kb = { s0: 1, s1: 1.09, x0: 0, x1: 0, y0: 0, y1: 0 };
      }
      clips.push(clip);
    });
    clips.push(ctaClip);

    // ── Texts: hook line on top, call to action at the end
    let hookText = null;
    if (hook.m.transcript) {
      const hit = hook.m.transcript.find((c) => c.s <= hook.c.t + 0.5 && c.e >= hook.c.t - 0.5 && HOOK_WORDS.test(c.text));
      if (hit) hookText = hit.text.length > 44 ? hit.text.slice(0, 43).trim() + "…" : hit.text;
    }
    if (!hookText) hookText = intent.title || "Wait for it…";
    const tot = clips.reduce((s, c) => s + (c.out - c.in) / c.speed, 0);
    const texts = [
      { text: hookText, start: 0.15, dur: Math.min(2.2, hookLen), size: 38, color: "#ffffff", pos: "top" },
      { text: "Follow for more ✦", start: Math.max(0, tot - ctaLen), dur: ctaLen, size: 32, color: "#ffffff", pos: "bottom" }
    ];

    const summary = "Shorts format · hook scored " + hookPts + "/100 · " + clips.length + " cuts · " +
      Math.round(tot) + "s · escalating retention" + (beat ? " · beat-synced ~" + intent.bpm + " bpm" : "") +
      " · CTA added · exports vertical 9:16";

    return { clips, texts, summary, vertical: true };
  }

  /* ═══════════ PLAN — the public entry ═══════════ */

  function plan(opts) {
    const media = opts.media || [];
    const rnd = rng((opts.seed || 1) * 7919 + 13);
    const fmt = opts.format || detectFormat(opts.prompt);
    const intent = decideIntent(opts.prompt, media, rnd, fmt);

    if (fmt === "short") {
      const g = planShort(opts, intent, media, rnd);
      if (g) return g;
    }

    let picked = pickSegments(media, intent, rnd);
    if (!picked.length) {
      // analysis unavailable — even spread fallback
      media.forEach((m) => {
        const d = m.duration || 3;
        picked.push({ item: m, s: 0, e: Math.min(d, intent.cutMax), q: 0.5, photo: m.type !== "video", mot: 0.05, aE: 0.3 });
      });
    }
    picked = fmt === "story"
      ? picked.slice().sort((a, b) => {
          const ai = media.indexOf(a.item), bi = media.indexOf(b.item);
          return ai !== bi ? ai - bi : a.s - b.s;
        })
      : arrange(picked, media, rnd);

    // beat-sync cut lengths when the footage is musical
    const beat = intent.bpm && intent.pace !== "slow" ? 60 / intent.bpm : 0;

    const clips = [];
    let zoomIn = rnd() > 0.5;
    picked.forEach((c, idx) => {
      let s = c.s, e = c.e;
      if (beat && !c.photo) {
        const L = e - s;
        const beats = Math.max(1, Math.round(L / beat));
        e = Math.min(s + beats * beat, c.item.duration || e);
        if (e - s < 0.4) e = c.e;
      }
      const clip = {
        mediaId: c.item.id,
        in: s,
        out: e,
        speed: intent.slowmo && !c.photo ? 0.5 : 1,
        volume: 1,
        muted: false,
        filter: intent.look,
        fadeIn: 0,
        fadeOut: 0
      };
      // Ken Burns on photos: alternate gentle push-in / pull-out with a drift
      if (c.photo) {
        const drift = (rnd() - 0.5) * 0.06;
        clip.kb = zoomIn
          ? { s0: 1.0, s1: 1.14, x0: 0, x1: drift, y0: 0, y1: -Math.abs(drift) * 0.6 }
          : { s0: 1.14, s1: 1.0, x0: drift, x1: 0, y0: -Math.abs(drift) * 0.6, y1: 0 };
        zoomIn = !zoomIn;
      }
      // fades by mood
      if (idx === 0) clip.fadeIn = intent.pace === "fast" ? 0.3 : 0.55;
      if (idx === picked.length - 1) clip.fadeOut = intent.pace === "fast" ? 0.4 : 0.7;
      if (intent.pace === "slow" && idx > 0) clip.fadeIn = Math.max(clip.fadeIn, 0.18);
      if (intent.pace === "slow" && idx < picked.length - 1) clip.fadeOut = Math.max(clip.fadeOut, 0.18);
      clips.push(clip);
    });

    // trim overshoot so we land near the target
    let tot = clips.reduce((s, c) => s + (c.out - c.in) / c.speed, 0);
    while (clips.length > 2 && tot > intent.target * 1.18) {
      const cut = clips.splice(clips.length - 2, 1)[0];
      tot -= (cut.out - cut.in) / cut.speed;
    }

    const texts = [];
    if (intent.title && tot > 2) {
      texts.push({ text: intent.title, start: 0.35, dur: Math.min(2.9, tot - 0.5), size: 46, color: "#ffffff", pos: "center" });
    }

    const analyzed = media.filter((m) => m.analysis && m.analysis.vis && m.analysis.vis.samples.length > 1).length;
    const spoken = media.filter((m) => m.transcript && m.transcript.length).length;
    const parts = [];
    if (fmt === "film") parts.push("Film format");
    else if (fmt === "story") parts.push("Story format — kept in order");
    parts.push("watched " + media.length + (media.length === 1 ? " source" : " sources") +
      (analyzed ? "" : " (quick mode)"));
    parts.push(clips.length + " cuts · " + Math.round(tot) + "s");
    parts.push(intent.reasons[0]);
    if (intent.reasons[1]) parts.push(intent.reasons[1]);
    if (intent.bpm && intent.pace !== "slow") parts.push("beat-synced ~" + intent.bpm + " bpm");
    if (spoken) parts.push("speech transcribed & kept intact");
    else if (media.some((m) => m.analysis && m.analysis.aud && m.analysis.aud.voiced.length)) parts.push("kept spoken moments whole");
    if (intent.title) parts.push("titled “" + intent.title + "”");

    return { clips, texts, summary: parts.join(" · "), vertical: false };
  }

  /* ═══════════ EXPORT ═══════════ */

  window.VantraBrain = {
    analyze,
    prepare,
    transcribe,
    plan
  };
})();
