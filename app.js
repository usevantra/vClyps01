/* ═══════════════════════════════════════════════════════════
   VANTRA — app engine
   Real features: upload, library, manual timeline editing
   (trim / split / reorder / text / filters / speed / volume),
   AI edit engine (prompt → real timeline), playback engine,
   real in-browser export via MediaRecorder, undo/redo,
   adaptive UI levels.
   ═══════════════════════════════════════════════════════════ */

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /* ═══════════ STATE ═══════════ */

  const S = {
    level: clamp(parseInt(localStorage.getItem("vantra-level") || "1", 10) || 1, 1, 4),
    mode: null,              // 'manual' | 'semi' | 'auto'
    media: [],               // {id,url,type,name,duration,thumb}
    clips: [],               // {id,mediaId,in,out,speed,volume,muted,filter}
    texts: [],               // {id,text,start,dur,size,color,pos}
    sel: null,               // {type:'clip'|'text'|'all', id}
    time: 0,
    playing: false,
    pps: 24,
    userMuted: false,
    seed: 1,
    format: "auto",
    vertical: false
  };
  let nextId = 1;
  const IMG_DUR = 3;

  const FILTERS = {
    none:      { label: "Original",  css: "none" },
    cinematic: { label: "Cinematic", css: "contrast(1.12) saturate(1.18) brightness(0.98)" },
    vivid:     { label: "Vivid",     css: "saturate(1.45) contrast(1.05)" },
    warm:      { label: "Warm",      css: "sepia(0.28) saturate(1.25) brightness(1.04)" },
    cool:      { label: "Cool",      css: "saturate(1.05) hue-rotate(14deg) brightness(1.02)" },
    noir:      { label: "Noir",      css: "grayscale(1) contrast(1.2) brightness(0.95)" },
    vintage:   { label: "Vintage",   css: "sepia(0.45) contrast(0.92) brightness(1.05) saturate(0.85)" },
    dreamy:    { label: "Dreamy",    css: "brightness(1.06) contrast(0.88) saturate(0.9)" }
  };

  /* ═══════════ TOAST ═══════════ */

  let toastTimer = null;
  function toast(msg, ms) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), ms || 2600);
  }

  /* ═══════════ HELPERS ═══════════ */

  const mediaById = (id) => S.media.find((m) => m.id === id) || null;
  const clipById = (id) => S.clips.find((c) => c.id === id) || null;
  const textById = (id) => S.texts.find((t) => t.id === id) || null;
  const dispDur = (c) => (c.out - c.in) / c.speed;
  const total = () => S.clips.reduce((s, c) => s + dispDur(c), 0);

  function clipAt(t) {
    let acc = 0;
    for (const c of S.clips) {
      const d = dispDur(c);
      if (t < acc + d) return { clip: c, offset: t - acc, start: acc };
      acc += d;
    }
    return null;
  }

  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
  }
  const fmt1 = (sec) => fmt(sec) + "." + Math.floor((sec % 1) * 10);

  function rand(seed) {
    let a = seed * 1103515245 + 12345;
    return () => {
      a = (a * 1103515245 + 12345) & 0x7fffffff;
      return a / 0x7fffffff;
    };
  }

  /* ═══════════ HISTORY (undo / redo) ═══════════ */

  let hist = [], histIdx = -1;
  function commit() {
    hist = hist.slice(0, histIdx + 1);
    hist.push(JSON.stringify({ c: S.clips, t: S.texts }));
    if (hist.length > 80) hist.shift();
    histIdx = hist.length - 1;
  }
  function restore(json) {
    const o = JSON.parse(json);
    S.clips = o.c;
    S.texts = o.t;
    S.sel = null;
    S.time = clamp(S.time, 0, total());
    renderTimeline();
    renderInspector();
  }
  function undo() {
    if (histIdx > 0) { histIdx--; restore(hist[histIdx]); }
    else toast("Nothing to undo");
  }
  function redo() {
    if (histIdx < hist.length - 1) { histIdx++; restore(hist[histIdx]); }
    else toast("Nothing to redo");
  }

  /* ═══════════ LEVELS ═══════════ */

  function setLevel(lv) {
    S.level = lv;
    document.body.classList.remove("lv1", "lv2", "lv3", "lv4");
    document.body.classList.add("lv" + lv);
    document.querySelectorAll("#levelSeg button").forEach((b) => {
      b.classList.toggle("active", +b.dataset.lv === lv);
    });
    localStorage.setItem("vantra-level", String(lv));
    renderInspector();
  }
  document.querySelectorAll("#levelSeg button").forEach((b) => {
    b.addEventListener("click", () => setLevel(+b.dataset.lv));
  });

  /* ═══════════ SCREENS & MODES ═══════════ */

  function mountPreview(container) {
    container.appendChild($("previewWrap"));
  }

  function showScreen(name) {
    document.body.dataset.screen = name;
    ["home", "auto", "editor"].forEach((n) => {
      $("screen-" + n).classList.toggle("active", n === name);
    });
    $("backBtn").classList.toggle("hidden", name === "home");
    $("exportBtn").classList.toggle(
      "hidden",
      !(name === "editor" || (name === "auto" && !$("autoResult").classList.contains("hidden")))
    );
    if (name === "home") pause();
  }

  function enterMode(mode) {
    S.mode = mode;
    closeSheets();
    if (mode === "auto") {
      showScreen("auto");
      autoShowSetup();
      renderStrips();
    } else {
      showScreen("editor");
      $("aiBar").classList.toggle("hidden", mode !== "semi");
      mountPreview($("editorStage"));
      $("mediaStrip").classList.remove("hidden");
      if (mode === "manual" && S.clips.length === 0 && S.media.length > 0) {
        S.media.forEach((m) => appendClip(m, false));
        commit();
        toast("Your footage is on the timeline — tap a clip to start editing");
      } else if (mode === "semi" && S.clips.length === 0 && S.media.length > 0) {
        toast("✦ Describe your edit in the bar above — VantraEdits will draft it");
      }
      renderStrips();
      renderTimeline();
    }
  }

  $("backBtn").addEventListener("click", () => showScreen("home"));
  $("logoHome").addEventListener("click", () => showScreen("home"));
  $("bbHome").addEventListener("click", () => showScreen("home"));

  document.querySelectorAll(".mode-card, .mode-row").forEach((el) => {
    el.addEventListener("click", () => enterMode(el.dataset.mode));
  });

  /* ═══════════ UPLOAD & LIBRARY ═══════════ */

  const picker = $("filePicker");
  let pickerCtx = "home"; // 'home' | 'library' | 'editor' | 'auto'

  function openPicker(ctx) {
    pickerCtx = ctx;
    picker.click();
  }

  $("bbPlus").addEventListener("click", () => openPicker("home"));
  $("bbLibrary").addEventListener("click", () => openSheet("librarySheet"));
  $("libAddBtn").addEventListener("click", () => openPicker("library"));
  $("stageAddBtn").addEventListener("click", () => openPicker("editor"));
  $("tbAdd").addEventListener("click", () => openPicker("editor"));

  picker.addEventListener("change", () => {
    const files = picker.files;
    let added = 0;
    Array.prototype.forEach.call(files, (file) => {
      const kind = file.type.startsWith("video/") ? "video" : file.type.startsWith("image/") ? "image" : null;
      if (!kind) return;
      added++;
      const item = {
        id: nextId++,
        url: URL.createObjectURL(file),
        type: kind,
        name: file.name.replace(/\.[^.]+$/, ""),
        duration: kind === "image" ? IMG_DUR : 0,
        thumb: kind === "image" ? URL.createObjectURL(file) : null
      };
      S.media.push(item);
      queueAnalysis(item);
      if (kind === "video") loadVideoMeta(item);
      if (pickerCtx === "editor" && S.mode === "manual") appendClip(item, false);
    });
    picker.value = "";
    if (!added) { toast("Only videos and photos are supported"); return; }

    if (pickerCtx === "editor" && S.mode === "manual") { commit(); renderTimeline(); }
    renderAll();

    if (pickerCtx === "home") {
      $("modeSheetTitle").textContent = added + (added === 1 ? " file" : " files") + " added ✓";
      openSheet("modeSheet");
    } else {
      toast(added + (added === 1 ? " file" : " files") + " added");
    }
  });

  function loadVideoMeta(item) {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    v.playsInline = true;
    v.src = item.url;
    v.addEventListener("loadedmetadata", () => {
      item.duration = isFinite(v.duration) ? v.duration : 0;
      // clips created before metadata arrived get their real length
      S.clips.forEach((c) => {
        if (c.mediaId === item.id && c.out === IMG_DUR && item.duration > 0) c.out = item.duration;
      });
      v.currentTime = Math.min(0.4, (item.duration || 1) / 2);
    });
    v.addEventListener("seeked", () => {
      try {
        const cnv = document.createElement("canvas");
        cnv.width = 160; cnv.height = 90;
        cnv.getContext("2d").drawImage(v, 0, 0, 160, 90);
        item.thumb = cnv.toDataURL("image/jpeg", 0.7);
      } catch (e) { /* cross-codec draw can fail; strip shows a dark tile */ }
      v.removeAttribute("src");
      renderAll();
      renderTimeline();
    });
    v.addEventListener("error", () => renderAll());
  }

  function removeMedia(id) {
    const i = S.media.findIndex((m) => m.id === id);
    if (i === -1) return;
    URL.revokeObjectURL(S.media[i].url);
    S.media.splice(i, 1);
    const before = S.clips.length;
    S.clips = S.clips.filter((c) => c.mediaId !== id);
    if (S.clips.length !== before) commit();
    if (S.sel && S.sel.type === "clip" && !clipById(S.sel.id)) S.sel = null;
    S.time = clamp(S.time, 0, total());
    renderAll();
    renderTimeline();
    renderInspector();
  }

  /* background footage understanding (brain.js) — starts the moment a file lands */
  function queueAnalysis(item) {
    if (!window.VantraBrain) return;
    item._an = "working";
    VantraBrain.analyze(item).then(() => {
      item._an = "done";
      renderStrips();
    }).catch(() => { item._an = "done"; });
  }

  function speechOn() { return localStorage.getItem("vantra-speech") === "1"; }

  /* ═══════════ RENDER: strips, library, home note ═══════════ */

  function stripItem(m, withPlus) {
    const el = document.createElement("div");
    el.className = "ms-item";
    el.title = m.name;
    if (m.thumb) {
      const img = document.createElement("img");
      img.src = m.thumb; img.alt = m.name;
      el.appendChild(img);
    }
    if (m.type === "video" && m.duration) {
      const d = document.createElement("span");
      d.className = "ms-dur"; d.textContent = fmt(m.duration);
      el.appendChild(d);
    }
    if (m._an) {
      const st = document.createElement("span");
      st.className = "ms-state" + (m._an === "working" ? " work" : "");
      st.title = m._an === "working" ? "VantraEdits is watching this clip…" : "Analyzed ✓";
      el.appendChild(st);
    }
    if (withPlus) {
      const p = document.createElement("button");
      p.className = "ms-plus"; p.textContent = "+";
      p.title = "Add to timeline";
      p.addEventListener("click", (e) => {
        e.stopPropagation();
        appendClip(m, true);
      });
      el.appendChild(p);
      el.addEventListener("click", () => appendClip(m, true));
    }
    return el;
  }

  function addTile(ctx, big) {
    const b = document.createElement("button");
    b.className = "ms-add";
    b.innerHTML = "<span style='font-size:" + (big ? 18 : 15) + "px;line-height:1'>+</span><span>Add</span>";
    b.addEventListener("click", () => openPicker(ctx));
    return b;
  }

  function renderStrips() {
    const ms = $("mediaStrip");
    ms.innerHTML = "";
    ms.appendChild(addTile("editor", false));
    S.media.forEach((m) => ms.appendChild(stripItem(m, true)));

    const as = $("autoMediaStrip");
    as.innerHTML = "";
    as.appendChild(addTile("auto", true));
    S.media.forEach((m) => as.appendChild(stripItem(m, false)));
  }

  function renderLibrary() {
    const grid = $("libGrid");
    grid.innerHTML = "";
    $("libEmpty").classList.toggle("hidden", S.media.length > 0);
    S.media.forEach((m) => {
      const el = document.createElement("div");
      el.className = "lib-item";
      if (m.thumb) {
        const img = document.createElement("img");
        img.src = m.thumb; img.alt = m.name;
        el.appendChild(img);
      }
      const b = document.createElement("span");
      b.className = "li-badge";
      b.textContent = m.type === "video" ? "video " + fmt(m.duration) : "photo";
      el.appendChild(b);
      const x = document.createElement("button");
      x.className = "li-x"; x.textContent = "✕";
      x.title = "Remove from library";
      x.addEventListener("click", () => removeMedia(m.id));
      el.appendChild(x);
      grid.appendChild(el);
    });
  }

  function renderHomeNote() {
    const n = S.media.length;
    $("homeMediaNote").textContent = n
      ? n + (n === 1 ? " clip" : " clips") + " in your library — pick a mode to start editing"
      : "";
    $("bbCount").classList.toggle("hidden", n === 0);
    $("bbCount").textContent = n;
  }

  function renderAll() {
    renderStrips();
    renderLibrary();
    renderHomeNote();
  }

  /* ═══════════ TIMELINE MODEL OPS ═══════════ */

  function appendClip(m, withCommit) {
    S.clips.push({
      id: nextId++,
      mediaId: m.id,
      in: 0,
      out: m.duration || IMG_DUR,
      speed: 1,
      volume: 1,
      muted: false,
      filter: "none",
      fadeIn: 0,
      fadeOut: 0
    });
    if (withCommit) {
      commit();
      toast('"' + m.name + '" added to timeline');
    }
    renderTimeline();
  }

  function splitAtPlayhead() {
    const info = clipAt(S.time);
    if (!info) { toast("Move the playhead over a clip to split it"); return; }
    const { clip, offset } = info;
    if (offset < 0.12 || dispDur(clip) - offset < 0.12) {
      toast("Move the playhead a little further into the clip");
      return;
    }
    const srcT = clip.in + offset * clip.speed;
    const second = Object.assign({}, clip, { id: nextId++, in: srcT });
    clip.out = srcT;
    S.clips.splice(S.clips.indexOf(clip) + 1, 0, second);
    S.sel = { type: "clip", id: second.id };
    commit();
    renderTimeline();
    renderInspector();
  }

  function addText() {
    if (!S.clips.length) { toast("Add footage to the timeline first"); return; }
    const t = {
      id: nextId++,
      text: "Your text",
      start: clamp(S.time, 0, Math.max(0, total() - 0.5)),
      dur: 3,
      size: 34,
      color: "#ffffff",
      pos: "bottom"
    };
    S.texts.push(t);
    S.sel = { type: "text", id: t.id };
    commit();
    renderTimeline();
    renderInspector();
  }

  function deleteSelection() {
    if (!S.sel || S.sel.type === "all") { toast("Tap a clip or text first, then delete"); return; }
    if (S.sel.type === "clip") S.clips = S.clips.filter((c) => c.id !== S.sel.id);
    else S.texts = S.texts.filter((t) => t.id !== S.sel.id);
    S.sel = null;
    S.time = clamp(S.time, 0, total());
    commit();
    renderTimeline();
    renderInspector();
  }

  function duplicateSelection() {
    if (!S.sel || S.sel.type === "all") { toast("Select a clip or text to copy"); return; }
    if (S.sel.type === "clip") {
      const c = clipById(S.sel.id);
      if (!c) return;
      const copy = Object.assign({}, c, { id: nextId++ });
      S.clips.splice(S.clips.indexOf(c) + 1, 0, copy);
      S.sel = { type: "clip", id: copy.id };
    } else {
      const t = textById(S.sel.id);
      if (!t) return;
      const copy = Object.assign({}, t, { id: nextId++, start: t.start + t.dur });
      S.texts.push(copy);
      S.sel = { type: "text", id: copy.id };
    }
    commit();
    renderTimeline();
    renderInspector();
  }

  $("tbSplit").addEventListener("click", splitAtPlayhead);
  $("tbText").addEventListener("click", addText);
  $("tbDelete").addEventListener("click", deleteSelection);
  $("tbDuplicate").addEventListener("click", duplicateSelection);
  $("tbFilter").addEventListener("click", () => {
    if (!S.clips.length) { toast("Add clips to the timeline first"); return; }
    S.sel = { type: "all" };
    renderTimeline();
    renderInspector();
  });

  /* ═══════════ TIMELINE RENDER & INTERACTION ═══════════ */

  const PADX = 20;

  function renderTimeline() {
    const vt = $("videoTrack"), tt = $("textTrack"), ruler = $("ruler");
    vt.innerHTML = ""; tt.innerHTML = "";

    const totSec = Math.max(total(), 12);
    const W = Math.max(totSec * S.pps + 200, $("tlScroll").clientWidth - PADX * 2);
    [vt, tt, ruler].forEach((x) => { x.style.width = W + "px"; });

    // ruler ticks
    ruler.innerHTML = "";
    const step = S.pps >= 40 ? 1 : S.pps >= 20 ? 2 : S.pps >= 12 ? 5 : 10;
    for (let s = 0; s <= W / S.pps; s += step) {
      const tick = document.createElement("div");
      tick.className = "rt";
      tick.style.left = s * S.pps + "px";
      const lb = document.createElement("span");
      lb.textContent = fmt(s);
      tick.appendChild(lb);
      ruler.appendChild(tick);
    }

    // video clips
    let x = 0;
    S.clips.forEach((c) => {
      const m = mediaById(c.mediaId);
      const w = Math.max(dispDur(c) * S.pps, 26);
      const cel = document.createElement("div");
      cel.className = "clip" + (S.sel && S.sel.type === "clip" && S.sel.id === c.id ? " sel" : "");
      cel.style.left = x + "px";
      cel.style.width = w + "px";
      if (m && m.thumb) {
        const img = document.createElement("img");
        img.src = m.thumb;
        cel.appendChild(img);
      }
      const nm = document.createElement("span");
      nm.className = "cname";
      nm.textContent = m ? m.name : "clip";
      cel.appendChild(nm);
      const du = document.createElement("span");
      du.className = "cdur";
      du.textContent = dispDur(c).toFixed(1) + "s";
      cel.appendChild(du);

      if (S.sel && S.sel.type === "clip" && S.sel.id === c.id) {
        const hl = document.createElement("div");
        hl.className = "handle hl";
        const hr = document.createElement("div");
        hr.className = "handle hr";
        cel.appendChild(hl);
        cel.appendChild(hr);
        hl.addEventListener("pointerdown", (e) => startTrim(e, c, "l"));
        hr.addEventListener("pointerdown", (e) => startTrim(e, c, "r"));
      }
      cel.addEventListener("pointerdown", (e) => {
        if (e.target.classList.contains("handle")) return;
        startClipDrag(e, c, cel);
      });
      vt.appendChild(cel);
      x += w;
    });

    // text clips
    S.texts.forEach((t) => {
      const tel = document.createElement("div");
      tel.className = "tclip" + (S.sel && S.sel.type === "text" && S.sel.id === t.id ? " sel" : "");
      tel.style.left = t.start * S.pps + "px";
      tel.style.width = Math.max(t.dur * S.pps, 24) + "px";
      tel.textContent = "T  " + t.text;
      tel.addEventListener("pointerdown", (e) => startTextDrag(e, t));
      tt.appendChild(tel);
    });

    updatePlayheadUI();
  }

  /* clip drag = select + reorder */
  function startClipDrag(e, clip, cel) {
    e.preventDefault();
    const startX = e.clientX;
    let moved = false;
    const origIdx = S.clips.indexOf(clip);

    const move = (ev) => {
      const dx = ev.clientX - startX;
      if (!moved && Math.abs(dx) > 8) { moved = true; cel.classList.add("dragging"); }
      if (moved) cel.style.transform = "translateX(" + dx + "px)";
    };
    const up = (ev) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!moved) {
        S.sel = { type: "clip", id: clip.id };
        renderTimeline();
        renderInspector();
        return;
      }
      const dx = ev.clientX - startX;
      const center = parseFloat(cel.style.left) + cel.offsetWidth / 2 + dx;
      // find which slot the dragged center falls into
      let acc = 0, newIdx = S.clips.length - 1;
      for (let i = 0; i < S.clips.length; i++) {
        const w = Math.max(dispDur(S.clips[i]) * S.pps, 26);
        if (center < acc + w) { newIdx = i; break; }
        acc += w;
      }
      if (newIdx !== origIdx) {
        S.clips.splice(origIdx, 1);
        S.clips.splice(newIdx, 0, clip);
        commit();
      }
      S.sel = { type: "clip", id: clip.id };
      renderTimeline();
      renderInspector();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /* trim handles */
  function startTrim(e, clip, side) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const m = mediaById(clip.mediaId);
    const maxOut = m && m.type === "video" && m.duration ? m.duration : 120;
    const oIn = clip.in, oOut = clip.out;

    const move = (ev) => {
      const dSrc = ((ev.clientX - startX) / S.pps) * clip.speed;
      if (side === "l") clip.in = clamp(oIn + dSrc, 0, clip.out - 0.15);
      else clip.out = clamp(oOut + dSrc, clip.in + 0.15, maxOut);
      renderTimeline();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      S.time = clamp(S.time, 0, total());
      commit();
      renderInspector();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /* text drag / select */
  function startTextDrag(e, t) {
    e.preventDefault();
    const startX = e.clientX;
    const oStart = t.start;
    let moved = false;

    const move = (ev) => {
      const dx = ev.clientX - startX;
      if (!moved && Math.abs(dx) > 6) moved = true;
      if (moved) {
        t.start = clamp(oStart + dx / S.pps, 0, Math.max(0, total() - 0.3));
        renderTimeline();
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (moved) commit();
      S.sel = { type: "text", id: t.id };
      renderTimeline();
      renderInspector();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /* scrub on ruler / empty track */
  function scrubHandler(trackEl) {
    trackEl.addEventListener("pointerdown", (e) => {
      if (e.target !== trackEl) return;
      const rect = trackEl.getBoundingClientRect();
      const setT = (ev) => {
        S.time = clamp((ev.clientX - rect.left) / S.pps, 0, total());
        syncNow();
      };
      setT(e);
      const move = (ev) => setT(ev);
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }
  scrubHandler($("ruler"));
  scrubHandler($("videoTrack"));
  scrubHandler($("textTrack"));

  $("zoomSlider").addEventListener("input", () => {
    S.pps = +$("zoomSlider").value;
    renderTimeline();
  });

  /* ═══════════ INSPECTOR ═══════════ */

  function mk(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  function group(labelText, child, min) {
    const g = mk("div", "ins-group");
    if (min) g.dataset.min = String(min);
    g.appendChild(mk("label", null, labelText));
    g.appendChild(child);
    return g;
  }

  function slider(min, max, step, val, oninput, onchange, fmtOut) {
    const wrap = mk("span", "ins-group");
    const r = document.createElement("input");
    r.type = "range"; r.min = min; r.max = max; r.step = step; r.value = val;
    const o = mk("output", null, fmtOut(val));
    r.addEventListener("input", () => { oninput(+r.value); o.textContent = fmtOut(+r.value); });
    r.addEventListener("change", () => onchange && onchange(+r.value));
    wrap.appendChild(r);
    wrap.appendChild(o);
    return wrap;
  }

  function filterChips(getCur, apply) {
    const wrap = mk("div", "filter-chips");
    Object.keys(FILTERS).forEach((key) => {
      const b = mk("button", "fchip" + (getCur() === key ? " active" : ""), FILTERS[key].label);
      b.addEventListener("click", () => {
        apply(key);
        commit();
        wrap.querySelectorAll(".fchip").forEach((c) => c.classList.remove("active"));
        b.classList.add("active");
      });
      wrap.appendChild(b);
    });
    return wrap;
  }

  function renderInspector() {
    const ins = $("inspector");
    ins.innerHTML = "";
    if (!S.sel) { ins.classList.add("hidden"); return; }
    ins.classList.remove("hidden");

    const closeBtn = mk("button", "ins-close", "✕");
    closeBtn.addEventListener("click", () => {
      S.sel = null;
      renderTimeline();
      renderInspector();
    });

    if (S.sel.type === "all") {
      ins.appendChild(mk("span", "ins-title", "<em>✦</em> Look — applies to every clip"));
      ins.appendChild(filterChips(
        () => (S.clips[0] ? S.clips[0].filter : "none"),
        (key) => { S.clips.forEach((c) => { c.filter = key; }); }
      ));
      ins.appendChild(closeBtn);
      return;
    }

    if (S.sel.type === "clip") {
      const c = clipById(S.sel.id);
      if (!c) { ins.classList.add("hidden"); return; }
      const m = mediaById(c.mediaId);
      const isVid = m && m.type === "video";

      ins.appendChild(mk("span", "ins-title", "<em>" + (isVid ? "▶" : "🖼") + "</em>" + (m ? m.name : "clip")));
      ins.appendChild(group("Look", filterChips(() => c.filter, (k) => { c.filter = k; })));

      if (isVid) {
        ins.appendChild(group("Speed", slider(0.25, 3, 0.05, c.speed,
          (v) => { c.speed = v; renderTimeline(); },
          () => commit(),
          (v) => v.toFixed(2) + "×"), 2));
        ins.appendChild(group("Volume", slider(0, 1, 0.05, c.volume,
          (v) => { c.volume = v; },
          () => commit(),
          (v) => Math.round(v * 100) + "%"), 2));
        const mute = mk("button", "ins-toggle" + (c.muted ? " on" : ""), c.muted ? "Muted" : "Sound on");
        mute.dataset.min = "3";
        mute.addEventListener("click", () => {
          c.muted = !c.muted;
          mute.classList.toggle("on", c.muted);
          mute.textContent = c.muted ? "Muted" : "Sound on";
          commit();
        });
        ins.appendChild(mute);
      } else {
        ins.appendChild(group("Show for", slider(0.5, 15, 0.5, c.out - c.in,
          (v) => { c.out = c.in + v; renderTimeline(); },
          () => commit(),
          (v) => v.toFixed(1) + "s")));
      }

      ins.appendChild(group("Fade in", slider(0, 1.5, 0.05, c.fadeIn || 0,
        (v) => { c.fadeIn = v; }, () => commit(), (v) => v.toFixed(2) + "s"), 3));
      ins.appendChild(group("Fade out", slider(0, 1.5, 0.05, c.fadeOut || 0,
        (v) => { c.fadeOut = v; }, () => commit(), (v) => v.toFixed(2) + "s"), 3));

      const meta = mk("span", "ins-meta",
        "in " + c.in.toFixed(2) + "s · out " + c.out.toFixed(2) + "s · plays " + dispDur(c).toFixed(2) + "s");
      meta.dataset.min = "4";
      ins.appendChild(meta);
      ins.appendChild(closeBtn);
      return;
    }

    // text selection
    const t = textById(S.sel.id);
    if (!t) { ins.classList.add("hidden"); return; }
    ins.appendChild(mk("span", "ins-title", "<em>T</em> Text"));

    const ti = document.createElement("input");
    ti.type = "text"; ti.value = t.text; ti.maxLength = 80;
    ti.addEventListener("input", () => { t.text = ti.value; renderTimeline(); });
    ti.addEventListener("change", () => commit());
    ins.appendChild(group("Says", ti));

    ins.appendChild(group("Size", slider(14, 88, 2, t.size,
      (v) => { t.size = v; }, () => commit(), (v) => v + "px"), 2));

    const ci = document.createElement("input");
    ci.type = "color"; ci.value = t.color;
    ci.addEventListener("input", () => { t.color = ci.value; });
    ci.addEventListener("change", () => commit());
    ins.appendChild(group("Color", ci, 2));

    const seg = mk("div", "ins-seg");
    seg.dataset.min = "3";
    ["top", "center", "bottom"].forEach((p) => {
      const b = mk("button", t.pos === p ? "active" : "", p[0].toUpperCase() + p.slice(1));
      b.addEventListener("click", () => {
        t.pos = p;
        seg.querySelectorAll("button").forEach((y) => y.classList.remove("active"));
        b.classList.add("active");
        commit();
      });
      seg.appendChild(b);
    });
    ins.appendChild(seg);

    ins.appendChild(group("Shows for", slider(0.5, 20, 0.5, t.dur,
      (v) => { t.dur = v; renderTimeline(); }, () => commit(), (v) => v.toFixed(1) + "s")));

    ins.appendChild(closeBtn);
  }

  /* ═══════════ PLAYBACK ENGINE ═══════════ */

  const pv = $("pv"), pi = $("pi");
  let lastTs = 0;

  function play() {
    if (!S.clips.length) { toast("Add footage to the timeline first"); return; }
    if (S.time >= total() - 0.05) S.time = 0;
    S.playing = true;
    $("playIco").classList.add("hidden");
    $("pauseIco").classList.remove("hidden");
  }
  function pause() {
    S.playing = false;
    pv.pause();
    $("playIco").classList.remove("hidden");
    $("pauseIco").classList.add("hidden");
  }
  $("playBtn").addEventListener("click", () => (S.playing ? pause() : play()));

  $("muteBtn").addEventListener("click", () => {
    S.userMuted = !S.userMuted;
    $("mOn").classList.toggle("hidden", S.userMuted);
    $("mOff").classList.toggle("hidden", !S.userMuted);
  });

  $("fsBtn").addEventListener("click", () => {
    const st = $("stage");
    if (document.fullscreenElement) document.exitFullscreen();
    else if (st.requestFullscreen) st.requestFullscreen();
  });

  let seekDragging = false;
  $("seekBar").addEventListener("input", () => {
    seekDragging = true;
    S.time = ($("seekBar").value / 1000) * total();
    syncNow();
  });
  $("seekBar").addEventListener("change", () => { seekDragging = false; });

  function syncNow() {
    syncMedia();
    syncOverlays();
    updateTransport();
    updatePlayheadUI();
  }

  function syncMedia() {
    $("stageEmpty").classList.toggle("hidden", S.clips.length > 0);
    const info = clipAt(Math.min(S.time, Math.max(total() - 0.001, 0)));
    if (!info) { pv.pause(); return; }
    const { clip, offset } = info;
    const m = mediaById(clip.mediaId);
    if (!m) return;

    if (m.type === "video") {
      pi.classList.add("hidden");
      pv.classList.remove("hidden");
      if (pv.dataset.mid !== String(m.id)) {
        pv.src = m.url;
        pv.dataset.mid = String(m.id);
      }
      const target = clip.in + offset * clip.speed;
      if (Math.abs(pv.currentTime - target) > 0.28) {
        try { pv.currentTime = target; } catch (e) { /* metadata not ready yet */ }
      }
      pv.playbackRate = clip.speed;
      pv.volume = clip.volume;
      pv.muted = clip.muted || (EXP.active ? false : S.userMuted);
      pv.style.filter = FILTERS[clip.filter].css;
      if (clip.kb) {
        const p = clamp(offset / Math.max(dispDur(clip), 0.01), 0, 1);
        pv.style.transform = "scale(" + (clip.kb.s0 + (clip.kb.s1 - clip.kb.s0) * p) + ")";
      } else {
        pv.style.transform = "";
      }
      if (S.playing && pv.paused) pv.play().catch(() => {});
      if (!S.playing && !pv.paused) pv.pause();
    } else {
      pv.pause();
      pv.classList.add("hidden");
      pi.classList.remove("hidden");
      if (pi.dataset.mid !== String(m.id)) {
        pi.src = m.url;
        pi.dataset.mid = String(m.id);
      }
      pi.style.filter = FILTERS[clip.filter].css;
      if (clip.kb) {
        const p = clamp(offset / Math.max(dispDur(clip), 0.01), 0, 1);
        const k = clip.kb;
        const zs = k.s0 + (k.s1 - k.s0) * p;
        const tx = (k.x0 + (k.x1 - k.x0) * p) * 100;
        const ty = (k.y0 + (k.y1 - k.y0) * p) * 100;
        pi.style.transform = "scale(" + zs + ") translate(" + tx + "%, " + ty + "%)";
      } else {
        pi.style.transform = "";
      }
    }
  }

  function fadeAlpha(info) {
    if (!info) return 0;
    const c = info.clip, d = dispDur(c), o = info.offset;
    let a = 0;
    if (c.fadeIn && o < c.fadeIn) a = 1 - o / c.fadeIn;
    if (c.fadeOut && d - o < c.fadeOut) a = Math.max(a, 1 - (d - o) / c.fadeOut);
    return clamp(a, 0, 1);
  }

  function syncOverlays() {
    const layer = $("overlayLayer");
    layer.innerHTML = "";
    const stageH = $("stage").clientHeight || 360;
    S.texts.forEach((t) => {
      if (S.time >= t.start && S.time <= t.start + t.dur) {
        const d = mk("div", "overlay-text pos-" + t.pos);
        d.textContent = t.text;
        d.style.fontSize = (t.size / 420) * stageH + "px";
        d.style.color = t.color;
        layer.appendChild(d);
      }
    });
    $("fadeVeil").style.opacity = fadeAlpha(clipAt(Math.min(S.time, Math.max(total() - 0.001, 0))));
  }

  function updateTransport() {
    $("tCur").textContent = fmt(S.time);
    $("tTot").textContent = fmt(total());
    if (!seekDragging) $("seekBar").value = total() ? (S.time / total()) * 1000 : 0;
    $("tlTimecode").textContent = fmt1(S.time);
  }

  function updatePlayheadUI() {
    $("playhead").style.left = PADX + S.time * S.pps + "px";
    if (S.playing) {
      const sc = $("tlScroll");
      const phX = PADX + S.time * S.pps;
      if (phX > sc.scrollLeft + sc.clientWidth - 70) sc.scrollLeft = phX - sc.clientWidth / 2;
      if (phX < sc.scrollLeft) sc.scrollLeft = Math.max(0, phX - 40);
    }
  }

  function loop(ts) {
    const dt = Math.min((ts - lastTs) / 1000, 0.1);
    lastTs = ts;
    if (S.playing) {
      S.time += dt;
      if (S.time >= total()) {
        S.time = total();
        if (EXP.active) finishExport();
        pause();
      }
    }
    syncMedia();
    syncOverlays();
    updateTransport();
    updatePlayheadUI();
    if (EXP.active) drawExportFrame();
    requestAnimationFrame(loop);
  }

  /* ═══════════ AI EDIT ENGINE ═══════════ */

  function aiGenerate(prompt, seed) {
    const p = (prompt || "").toLowerCase();
    const rnd = rand(seed * 7919 + 13);

    // target length
    let target = null;
    let m = p.match(/(\d+)\s*(?:seconds|second|secs|sec|s\b)/);
    if (m) target = +m[1];
    else if ((m = p.match(/(\d+)\s*(?:minutes|minute|mins|min)/))) target = +m[1] * 60;
    const srcTotal = S.media.reduce((s, x) => s + (x.duration || IMG_DUR), 0);
    if (!target) target = clamp(Math.round(srcTotal * 0.45), 10, 60);

    // pacing
    const fast = /fast|quick|energetic|upbeat|punchy|hype|exciting|action|reel|tiktok/.test(p);
    const slow = /slow(?![ -]?mo)|calm|emotional|relax|chill|peaceful|gentle/.test(p);
    const cutMin = fast ? 1.0 : slow ? 3.6 : 2.0;
    const cutMax = fast ? 2.2 : slow ? 6.5 : 4.0;

    // look
    let filter = "none";
    if (/cinema|film|movie/.test(p)) filter = "cinematic";
    else if (/vintage|retro|old school|8mm|90s|80s/.test(p)) filter = "vintage";
    else if (/black and white|b&w|noir|monochrome|dramatic|moody/.test(p)) filter = "noir";
    else if (/vibrant|colorful|colourful|vivid|pop/.test(p)) filter = "vivid";
    else if (/warm|golden|sunset|summer|cozy/.test(p)) filter = "warm";
    else if (/cool|cold|winter|blue/.test(p)) filter = "cool";
    else if (/dream|soft|hazy|aesthetic/.test(p)) filter = "dreamy";

    const slowmo = /slow[- ]?mo|slow motion/.test(p);

    // title
    let title = null;
    m = prompt.match(/"([^"]{1,40})"|'([^']{1,40})'/);
    if (m) title = m[1] || m[2];
    else if ((m = p.match(/titled\s+([a-z0-9 ,!&']{2,36})/))) {
      title = m[1].trim().replace(/\b\w/g, (ch) => ch.toUpperCase());
    }

    // build clips: cycle footage, sampling different parts each pass
    const clips = [];
    const cursors = {};
    let t = 0, guard = 0;
    const pool = S.media.slice();
    if (rnd() > 0.5 && pool.length > 2) pool.push(pool.shift()); // variation per take

    while (t < target && guard < 400) {
      const mItem = pool[guard % pool.length];
      guard++;
      let len = cutMin + rnd() * (cutMax - cutMin);
      let cin = 0, cout;
      if (mItem.type === "video" && mItem.duration > 0.5) {
        const dur = mItem.duration;
        len = Math.min(len, dur);
        let cur = cursors[mItem.id];
        if (cur === undefined) cur = rnd() * Math.max(0, dur - len) * 0.3;
        cin = cur + len > dur ? Math.max(0, dur - len) : cur;
        cout = Math.min(cin + len, dur);
        cursors[mItem.id] = cout + dur * 0.08 >= dur ? 0 : cout + dur * 0.05;
      } else {
        cout = Math.min(len, 3.5);
      }
      const speed = slowmo && mItem.type === "video" ? 0.5 : 1;
      clips.push({
        id: nextId++, mediaId: mItem.id, in: cin, out: cout,
        speed: speed, volume: 1, muted: false, filter: filter
      });
      t += (cout - cin) / speed;
    }

    const texts = [];
    if (title && t > 1) {
      texts.push({ id: nextId++, text: title, start: 0.3, dur: Math.min(2.8, t - 0.4), size: 46, color: "#ffffff", pos: "center" });
    }

    return {
      clips: clips,
      texts: texts,
      summary: clips.length + " cuts · " + Math.round(t) + "s · " +
        (filter === "none" ? "natural look" : FILTERS[filter].label + " look") +
        (title ? " · titled “" + title + "”" : "")
    };
  }

  function applyGenerated(g) {
    S.vertical = !!g.vertical;
    g.clips.forEach((c) => { if (c.id === undefined) c.id = nextId++; });
    g.texts.forEach((t) => { if (t.id === undefined) t.id = nextId++; });
    S.clips = g.clips;
    S.texts = g.texts;
    S.sel = null;
    S.time = 0;
    commit();
    renderTimeline();
    renderInspector();
  }

  /* ─── Automatic screen flow ─── */

  let lastAutoPrompt = "";
  let generating = false;

  function autoShowSetup() {
    $("autoSetup").classList.remove("hidden");
    $("autoProgress").classList.add("hidden");
    $("autoResult").classList.add("hidden");
    $("exportBtn").classList.add("hidden");
  }

  async function runAuto(prompt, quick) {
    if (generating) return;
    generating = true;
    lastAutoPrompt = prompt;
    $("autoSetup").classList.add("hidden");
    $("autoResult").classList.add("hidden");
    $("autoProgress").classList.remove("hidden");
    $("exportBtn").classList.add("hidden");
    pause();

    const say = (s) => { $("autoStatus").textContent = s; };
    let g = null;
    try {
      if (window.VantraBrain) {
        say(quick ? "Re-cutting a fresh take…" : "Watching your footage…");
        await VantraBrain.prepare(S.media, { speech: speechOn(), status: say });
        say("Planning the edit…");
        await new Promise((r) => setTimeout(r, quick ? 250 : 500));
        g = VantraBrain.plan({ prompt: prompt, media: S.media, seed: S.seed++, format: S.format === "auto" ? null : S.format });
      }
    } catch (e) { g = null; }
    if (!g || !g.clips.length) g = aiGenerate(prompt, S.seed++);

    applyGenerated(g);
    $("autoProgress").classList.add("hidden");
    $("autoResult").classList.remove("hidden");
    $("autoSummary").textContent = g.summary + " — press play, then export or fine-tune.";
    mountPreview($("autoStage"));
    $("exportBtn").classList.remove("hidden");
    generating = false;
    play();
  }

  $("autoGenerate").addEventListener("click", () => {
    if (!S.media.length) { toast("Add some footage first — tap the + tile above"); return; }
    runAuto($("autoPrompt").value.trim(), false);
  });

  document.querySelectorAll("#formatChips .chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll("#formatChips .chip").forEach((c) => c.classList.remove("selected"));
      chip.classList.add("selected");
      S.format = chip.dataset.f;
    });
  });

  document.querySelectorAll("#autoChips .chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const box = $("autoPrompt");
      box.value = box.value.trim()
        ? box.value.trim().replace(/[.。]?$/, "") + ". " + chip.dataset.p
        : chip.dataset.p;
      chip.classList.add("selected");
      setTimeout(() => chip.classList.remove("selected"), 700);
    });
  });

  $("autoRegen").addEventListener("click", () => runAuto(lastAutoPrompt || "a nice edit", true));
  $("autoRestart").addEventListener("click", autoShowSetup);
  $("autoRefine").addEventListener("click", () => {
    S.mode = "semi";
    showScreen("editor");
    $("aiBar").classList.remove("hidden");
    $("mediaStrip").classList.remove("hidden");
    mountPreview($("editorStage"));
    renderStrips();
    renderTimeline();
    toast("Here's your draft — every cut is now editable");
  });

  /* ─── Semi-auto bar ─── */

  $("semiGenerate").addEventListener("click", async () => {
    if (!S.media.length) { toast("Add footage first — tap Add below the preview"); return; }
    if (generating) return;
    generating = true;
    const prompt = $("semiPrompt").value.trim();
    pause();
    toast("✦ Drafting your edit…", 3000);
    let g = null;
    try {
      if (window.VantraBrain) {
        await VantraBrain.prepare(S.media, { speech: speechOn(), status: (s) => toast("✦ " + s, 4000) });
        g = VantraBrain.plan({ prompt: prompt, media: S.media, seed: S.seed++, format: S.format === "auto" ? null : S.format });
      }
    } catch (e) { g = null; }
    if (!g || !g.clips.length) g = aiGenerate(prompt, S.seed++);
    applyGenerated(g);
    generating = false;
    toast("✦ Draft ready — " + g.summary, 4500);
    play();
  });
  $("semiPrompt").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("semiGenerate").click();
  });

  /* ═══════════ EXPORT (real, in-browser) ═══════════ */

  const EXP = { active: false, cancelled: false, rec: null, chunks: [], canvas: null, ctx: null, ext: "webm" };
  let audioCtx = null, audioDest = null;

  function ensureAudioGraph() {
    if (audioCtx) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaElementSource(pv);
    audioDest = audioCtx.createMediaStreamDestination();
    src.connect(audioCtx.destination);
    src.connect(audioDest);
  }

  function pickMime() {
    const list = [
      ["video/mp4;codecs=avc1", "mp4"],
      ["video/webm;codecs=vp9,opus", "webm"],
      ["video/webm;codecs=vp8,opus", "webm"],
      ["video/webm", "webm"]
    ];
    for (const pair of list) {
      if (MediaRecorder.isTypeSupported(pair[0])) return { mime: pair[0], ext: pair[1] };
    }
    return null;
  }

  $("exportBtn").addEventListener("click", () => {
    if (!S.clips.length) { toast("The timeline is empty — add clips or generate an edit first"); return; }
    if (typeof MediaRecorder === "undefined") { toast("This browser can't record video — try Chrome or Edge"); return; }
    const picked = pickMime();
    if (!picked) { toast("This browser can't record video — try Chrome or Edge"); return; }
    startExport(picked);
  });

  function startExport(picked) {
    pause();
    S.time = 0;
    EXP.canvas = document.createElement("canvas");
    EXP.vertical = !!S.vertical;
    EXP.canvas.width = EXP.vertical ? 720 : 1280;
    EXP.canvas.height = EXP.vertical ? 1280 : 720;
    EXP.ctx = EXP.canvas.getContext("2d");
    EXP.chunks = [];
    EXP.ext = picked.ext;

    const stream = EXP.canvas.captureStream(30);
    try {
      ensureAudioGraph();
      if (audioCtx.state === "suspended") audioCtx.resume();
      audioDest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
    } catch (e) { /* export continues silent if the audio graph is unavailable */ }

    try {
      EXP.rec = new MediaRecorder(stream, { mimeType: picked.mime, videoBitsPerSecond: 8000000 });
    } catch (e) {
      toast("Couldn't start the recorder — try a different browser");
      return;
    }
    EXP.rec.ondataavailable = (e) => { if (e.data && e.data.size) EXP.chunks.push(e.data); };
    EXP.rec.onstop = saveExport;

    EXP.active = true;
    EXP.cancelled = false;
    $("exportOverlay").classList.remove("hidden");
    $("expTitle").textContent = "Exporting “" + ($("projectName").value.trim() || "Untitled") + "”…";
    $("expStatus").textContent = "rendering in real time — keep this tab open";
    EXP.rec.start(250);
    play();
  }

  function drawExportFrame() {
    const ctx = EXP.ctx, W = EXP.canvas.width, H = EXP.canvas.height;
    ctx.filter = "none";
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);

    const info = clipAt(Math.min(S.time, Math.max(total() - 0.001, 0)));
    if (info) {
      const m = mediaById(info.clip.mediaId);
      const isVid = m && m.type === "video";
      const elm = isVid ? pv : pi;
      const vw = isVid ? pv.videoWidth : pi.naturalWidth;
      const vh = isVid ? pv.videoHeight : pi.naturalHeight;
      if (vw && vh) {
        const cover = EXP.vertical;
        const sc = cover ? Math.max(W / vw, H / vh) : Math.min(W / vw, H / vh);
        const dw = vw * sc, dh = vh * sc;
        let dx = (W - dw) / 2, dy = (H - dh) / 2;
        if (cover && dw > W + 1) {
          // smart crop: keep the frame centered on where the motion lives
          const mcx = (m && m.analysis && m.analysis.vis && m.analysis.vis.avgMcx) || 0.5;
          dx = clamp(W / 2 - mcx * dw, W - dw, 0);
        }
        ctx.filter = FILTERS[info.clip.filter].css;
        const k = info.clip.kb;
        try {
          if (k) {
            const p = clamp(info.offset / Math.max(dispDur(info.clip), 0.01), 0, 1);
            const zs = k.s0 + (k.s1 - k.s0) * p;
            const tx = (k.x0 + (k.x1 - k.x0) * p) * dw;
            const ty = (k.y0 + (k.y1 - k.y0) * p) * dh;
            ctx.save();
            ctx.translate(W / 2 + tx, H / 2 + ty);
            ctx.scale(zs, zs);
            ctx.translate(-W / 2, -H / 2);
            ctx.drawImage(elm, dx, dy, dw, dh);
            ctx.restore();
          } else {
            ctx.drawImage(elm, dx, dy, dw, dh);
          }
        } catch (e) {}
        ctx.filter = "none";
      }
    }

    const fa = fadeAlpha(info);
    if (fa > 0) {
      ctx.fillStyle = "rgba(0,0,0," + fa + ")";
      ctx.fillRect(0, 0, W, H);
    }

    S.texts.forEach((t) => {
      if (S.time >= t.start && S.time <= t.start + t.dur) {
        const size = (t.size / 420) * H * 1.55;
        ctx.font = "800 " + size + "px -apple-system, 'Segoe UI', Roboto, Arial, sans-serif";
        ctx.textAlign = "center";
        ctx.fillStyle = t.color;
        ctx.shadowColor = "rgba(0,0,0,0.8)";
        ctx.shadowBlur = 16;
        const y = t.pos === "top" ? H * 0.14 + size / 2 : t.pos === "center" ? H / 2 + size / 3 : H * 0.88;
        ctx.fillText(t.text, W / 2, y, W * 0.9);
        ctx.shadowBlur = 0;
      }
    });

    const pct = total() ? Math.min(100, Math.round((S.time / total()) * 100)) : 0;
    $("expBar").style.width = pct + "%";
    $("expPct").textContent = pct + "%";
  }

  function finishExport() {
    if (!EXP.active) return;
    EXP.active = false;
    $("expBar").style.width = "100%";
    $("expPct").textContent = "100%";
    $("expStatus").textContent = "saving file…";
    try { EXP.rec.stop(); } catch (e) {}
  }

  function saveExport() {
    $("exportOverlay").classList.add("hidden");
    if (EXP.cancelled) { EXP.chunks = []; return; }
    const blob = new Blob(EXP.chunks, { type: (EXP.rec && EXP.rec.mimeType) || "video/webm" });
    EXP.chunks = [];
    if (!blob.size) { toast("Export produced no data — try again"); return; }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = ($("projectName").value.trim() || "vantra-export") + "." + EXP.ext;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast("Exported ✓ — check your downloads");
  }

  $("expCancel").addEventListener("click", () => {
    EXP.cancelled = true;
    EXP.active = false;
    pause();
    try { EXP.rec.stop(); } catch (e) {}
    $("exportOverlay").classList.add("hidden");
    toast("Export cancelled");
  });

  /* ═══════════ SHEETS ═══════════ */

  function openSheet(id) {
    renderLibrary();
    $("sheetBackdrop").classList.remove("hidden");
    document.querySelectorAll(".sheet").forEach((s) => s.classList.add("hidden"));
    $(id).classList.remove("hidden");
  }
  function closeSheets() {
    $("sheetBackdrop").classList.add("hidden");
    document.querySelectorAll(".sheet").forEach((s) => s.classList.add("hidden"));
  }
  $("sheetBackdrop").addEventListener("click", (e) => {
    if (e.target === $("sheetBackdrop")) closeSheets();
  });

  /* ═══════════ TOP BAR MISC ═══════════ */

  $("undoBtn").addEventListener("click", undo);
  $("redoBtn").addEventListener("click", redo);
  $("projectName").addEventListener("keydown", (e) => { if (e.key === "Enter") e.target.blur(); });
  $("projectName").addEventListener("blur", (e) => {
    if (!e.target.value.trim()) e.target.value = "Untitled";
  });

  /* ═══════════ KEYBOARD ═══════════ */

  document.addEventListener("keydown", (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    const typing = tag === "input" || tag === "textarea" || tag === "select";
    if (e.key === "Escape") { closeSheets(); return; }
    if (typing) return;
    const inEditor = document.body.dataset.screen === "editor" ||
      (document.body.dataset.screen === "auto" && !$("autoResult").classList.contains("hidden"));
    if (!inEditor) return;

    if (e.code === "Space") { e.preventDefault(); if (S.playing) pause(); else play(); }
    else if (e.key === "Delete" || e.key === "Backspace") { deleteSelection(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
    else if (e.key === "s" && !e.ctrlKey && !e.metaKey) { splitAtPlayhead(); }
  });

  /* ═══════════ INIT ═══════════ */

  const spc = $("speechCheck");
  if (spc) {
    spc.checked = speechOn();
    spc.addEventListener("change", () => localStorage.setItem("vantra-speech", spc.checked ? "1" : "0"));
  }
  mountPreview($("editorStage"));
  setLevel(S.level);
  showScreen("home");
  renderAll();
  renderTimeline();
  commit();
  requestAnimationFrame((ts) => { lastTs = ts; requestAnimationFrame(loop); });
})();
