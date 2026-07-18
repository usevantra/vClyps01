# VantraEdits — edit videos your way

*The editing app by **Vantra**.* A vanta-black, professional video editor that
runs entirely in your browser. Tell it what you want and it edits for you — or
take full control yourself.

## Short-form engine (Reels / Shorts / TikTok)

Pick the **Reels / Shorts** format (or just mention "reel"/"shorts" in the
prompt) and the VantraAI brain scores every instant of your footage on three
point systems — **hook points** (loudness spikes, motion bursts, high-pitch
excitement, hook wording in the transcript), **retention points** (sustained
energy, variety, sharpness), and **engagement points** (speech and delivery).
It then builds the proven short-form structure:

1. **Hook** — the single highest-hook-scoring moment opens the video,
   started mid-action with a hook text overlay
2. **Retention** — rapid 1–2.5s cuts with escalating energy and pattern
   interrupts (punch-in zooms, speed ramps), beat-locked when the audio is musical
3. **Call to action** — a stable closing shot with a "Follow for more ✦" overlay

Shorts export **vertical 9:16 (720×1280)** with smart cropping that follows
where the motion is in frame. Other formats (Recap, Film, Story) ride the same
scoring pathway with their own structure rules. User wishes always beat format
defaults — say "slow" and a Short stays slow.

## Three modes

- **Manual** — a clean hands-on editor: trim, split, reorder, speed, volume,
  text overlays, color looks. No AI, just you.
- **Automatic** — import footage, type one sentence, get a finished edit and
  export it. Zero effort.
- **Semi-Auto** — the AI drafts the edit from your prompt, then drops you into
  the manual editor to polish every cut.

## Adaptive interface

A selector in the top bar switches the whole UI between **Simple,
Intermediate, Advanced, and Professional** — controls appear or disappear to
match how much you want on screen. The choice is remembered.

## What actually works (no back-end, no build step)

- Upload videos & photos (TikTok-style **+** button; files never leave your browser)
- Real timeline editing: tap to select, drag to reorder, pull edges to trim,
  split at the playhead, duplicate, delete
- Per-clip speed (0.25×–3×), volume, mute, and 8 color looks; per-text content,
  size, color, position, and timing
- **The Vantra Brain (brain.js)** — the AI genuinely studies your footage
  before cutting, all in the browser:
  - *Watches* every clip: samples frames and measures motion, sharpness,
    brightness, color, and scene changes to find highlights and skip
    dark/blurry/chaotic moments
  - *Listens* to the audio: energy mapping, beat/BPM detection for
    beat-synced cut lengths, and voice detection so it never cuts someone
    off mid-sentence
  - *Transcribes speech* (optional toggle): loads a Whisper speech model
    on demand and transcribes what's said, favoring complete sentences
  - *Decides on its own*: vague prompts — or **no prompt at all** — work;
    pacing, look, length, story arc (calm opening → energy peak → gentle
    ending), Ken Burns motion on photos, and fades are inferred from the
    footage itself, and the summary explains every decision it made
- Prompt understanding on top: length ("30 seconds"), pacing ("fast",
  "calm"), looks ("cinematic"/"vintage"/"noir"…), slow motion, quoted titles
- Full playback engine with playhead, scrubbing, seek, zoomable timeline
- **Real export**: the timeline is rendered in-browser (with looks and text
  baked in) and saved as a video file via MediaRecorder — Chrome/Edge
  recommended
- Undo / redo with keyboard shortcuts (Space, S to split, Del, Ctrl+Z / Ctrl+Y)

Known limits: export renders in real time (a 30s edit takes ~30s), output is
WebM in most browsers (MP4 where supported), and there's a brief flicker when
playback crosses between two different source files.

## Run it

All files sit flat in one folder — no subfolders, no dependencies.

- Open `index.html` in a browser, **or**
- Upload the 5 files to a GitHub repo root and enable
  **Settings → Pages → Deploy from a branch → main / (root)** for a live URL.

```
index.html   # Screens: home, automatic, editor + shared preview & sheets
styles.css   # Vanta-black theme, adaptive levels, responsive layout
app.js       # Editing engine, playback, export, history, UI
brain.js     # Footage analysis (vision + audio), transcription, edit planner
README.md
```

Note: the speech-transcription toggle fetches the Whisper model from a CDN the
first time it's used (everything else works fully offline). If it can't load,
Vantra quietly falls back to voice-detection-only editing.
