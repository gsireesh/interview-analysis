/* Wiring, shared state, and the reading/following cursor state machine.
 *
 * Reading is the default and the point of the tool. The transcript starts in
 * READING mode with the dock minimized: the cursor follows where you are in the
 * text and quietly cues the player to match, so playback always starts where you
 * are looking. Pressing play switches to FOLLOWING, where the transcript keeps up
 * with the audio instead. Scrolling or moving the cursor by hand drops back to
 * READING without stopping playback, and a "Follow along" button re-attaches.
 */

import { $, api, formatTime } from "./util.js";
import {
  applyHighlights,
  cacheGeometry,
  chunkIndexAtScroll,
  chunkIndexAtTime,
  flashCue,
  renderTranscript,
  setCursor,
  updateSpine,
} from "./transcript.js";
import { cue, initPlayer, nudge, seekAndPlay, stepRate, togglePlay } from "./player.js";
import { initSearch } from "./search.js";
import { copySelection, hideQuoteBar, initHighlights, renderList, save } from "./highlights.js";
import { enterEdit, exitEdit, isEditing } from "./editing.js";

const ctx = {
  el: {
    reader: $("reader"),
    transcript: $("transcript"),
    chunks: $("chunks"),
    spineMarker: $("spine-marker"),
    spineDot: $("spine-dot"),
    title: $("title"),
    meta: $("meta"),
    notices: $("notices"),
    roster: $("roster"),
    sidebar: $("sidebar"),
    panelSearch: $("panel-search"),
    panelHighlights: $("panel-highlights"),
    tabSearch: $("tab-search"),
    tabHighlights: $("tab-highlights"),
    themeToggle: $("theme-toggle"),
    libraryLink: $("library-link"),
    searchInput: $("search-input"),
    regexToggle: $("regex-toggle"),
    searchResults: $("search-results"),
    searchCount: $("search-count"),
    highlightList: $("highlight-list"),
    highlightCount: $("highlight-count"),
    highlightsPath: $("highlights-path"),
    tagFilters: $("tag-filters"),
    dock: $("dock"),
    dockToggle: $("dock-toggle"),
    dockGrip: $("dock-grip"),
    dockStage: $("dock-stage"),
    media: $("media"),
    play: $("play"),
    scrub: $("scrub"),
    clock: $("clock"),
    duration: $("duration"),
    rate: $("rate"),
    follow: $("follow"),
    quotebar: $("quotebar"),
    quotebarTime: $("quotebar-time"),
    quotebarColors: $("quotebar-colors"),
    quotebarNote: $("quotebar-note"),
    quotebarCopy: $("quotebar-copy"),
  },
  mode: "reading",
  cursorIndex: 0,
  currentTime: 0,
  chunks: [],
  cueById: new Map(),
  cueByIndex: new Map(),
  highlights: [],
  knownTags: [],
  // Every tag used anywhere in the library, for completing as you type.
  vocabulary: [],
  colors: ["amber"],
  paintedCues: new Set(),
  activeHighlightId: null,
  tagFilter: null,
  pendingSelection: null,
  scrubbing: false,
};

/* ---------------------------------------------------------------- notices -- */

ctx.notify = (message, { kind = "info", key = null } = {}) => {
  const notice = document.createElement("div");
  notice.className = `notice${kind === "warn" ? " notice--warn" : ""}`;
  notice.innerHTML = `<span class="notice__label">${kind === "warn" ? "Check" : "Note"}</span><span></span><button type="button" aria-label="Dismiss">✕</button>`;
  notice.querySelector("span:nth-child(2)").textContent = message;
  notice.querySelector("button").addEventListener("click", () => {
    notice.remove();
    if (key) localStorage.setItem(key, "dismissed");
  });
  ctx.el.notices.appendChild(notice);
  if (!key) setTimeout(() => notice.remove(), 4000);
};

/* ------------------------------------------------------------------ tabs -- */

ctx.showTab = (which) => {
  const showSearch = which === "search";
  ctx.el.panelSearch.hidden = !showSearch;
  ctx.el.panelHighlights.hidden = showSearch;
  ctx.el.tabSearch.setAttribute("aria-pressed", String(showSearch));
  ctx.el.tabHighlights.setAttribute("aria-pressed", String(!showSearch));
};

/* ------------------------------------------------------------ mode logic -- */

ctx.setMode = (mode) => {
  if (ctx.mode === mode) return;
  ctx.mode = mode;
  syncFollowButton();
  updateSpine(ctx);
};

function syncFollowButton() {
  const playing = !ctx.el.media.paused && Boolean(ctx.el.media.src);
  ctx.el.follow.hidden = !(playing && ctx.mode === "reading");
}

/* ------------------------------------------------------------------ load -- */

async function load() {
  const config = await api("/api/config");
  ctx.colors = config.colors;
  // The library links straight to a recording, and to a moment inside it.
  const params = new URLSearchParams(location.search);
  const asked = params.get("recording");
  ctx.recordingId =
    (asked && config.recordings.some((r) => r.id === asked) && asked) ||
    config.default_recording_id;
  // The library is always the way back, however few recordings it holds.
  ctx.el.libraryLink.hidden = false;
  if (!ctx.recordingId) {
    ctx.el.chunks.innerHTML = '<p class="empty">No recording loaded.</p>';
    return;
  }

  const data = await api(`/api/recordings/${ctx.recordingId}`);
  ctx.data = data;
  ctx.chunks = data.transcript.chunks;
  ctx.parts = data.transcript.parts || [];
  ctx.highlights = data.highlights;
  ctx.knownTags = data.known_tags;

  for (const cueItem of data.transcript.cues) {
    ctx.cueById.set(cueItem.id, cueItem);
    ctx.cueByIndex.set(cueItem.index, cueItem);
  }

  document.title = data.title;
  ctx.el.title.textContent = data.title;
  ctx.el.highlightsPath.textContent = data.highlights_file;

  const diagnostics = data.transcript.diagnostics;
  ctx.el.meta.textContent = [
    formatTime(data.duration),
    `${diagnostics.chunk_count} blocks`,
    `${diagnostics.speakers.length} speakers`,
    data.media_file || "no media",
  ].join("  ·  ");

  // Suggestions span the study, so a tag coined in one interview is offered in
  // every other one. Not fatal if it fails -- the field still takes free text.
  api("/api/library/vocabulary")
    .then((data) => {
      ctx.vocabulary = data.tags;
      renderList(ctx);
    })
    .catch(() => {});

  ctx.onHighlightsChanged = () => {
    applyHighlights(ctx);
    renderList(ctx);
  };

  /**
   * Take a rebuilt transcript back wholesale.
   *
   * Reassigning a speaker regroups every block after it, so patching in place
   * would mean reimplementing the chunker in the browser. Re-rendering and
   * returning to the line being worked on is both simpler and always right.
   */
  /** The speaker keys, shown so the bindings are never a thing you remember. */
  ctx.renderRoster = () => {
    const roster = (ctx.data?.transcript?.roster || []).filter((entry) => entry.key);
    ctx.el.roster.hidden = !roster.length;
    if (!roster.length) return;
    ctx.el.roster.innerHTML =
      `<span class="roster__lead">assign this block</span>` +
      roster
        .map(
          (entry) =>
            `<button class="roster__who" type="button" data-speaker="${entry.name.replace(/"/g, "&quot;")}">
               <kbd>${entry.key}</kbd>${entry.name.replace(/</g, "&lt;")}</button>`
        )
        .join("");
  };

  ctx.el.roster.addEventListener("click", (event) => {
    const button = event.target.closest("[data-speaker]");
    if (button) assignSpeaker(ctx, button.dataset.speaker);
  });

  ctx.onTranscriptChanged = (payload, { keepEditingCue } = {}) => {
    exitEdit(ctx);
    ctx.data = payload;
    ctx.chunks = payload.transcript.chunks;
    ctx.parts = payload.transcript.parts || [];
    ctx.highlights = payload.highlights;
    ctx.cueById = new Map();
    ctx.cueByIndex = new Map();
    for (const item of payload.transcript.cues) {
      ctx.cueById.set(item.id, item);
      ctx.cueByIndex.set(item.index, item);
    }
    ctx.paintedCues = new Set();

    renderTranscript(ctx);
    applyHighlights(ctx);
    renderList(ctx);

    ctx.renderRoster();
    const index = keepEditingCue
      ? ctx.chunks.findIndex((chunk) => chunk.cue_ids.includes(keepEditingCue))
      : ctx.cursorIndex;
    setCursor(ctx, Math.max(0, index), { scroll: true });
    if (keepEditingCue && index >= 0) enterEdit(ctx, index);
  };

  renderTranscript(ctx);
  applyHighlights(ctx);
  initPlayer(ctx);
  initSearch(ctx);
  initHighlights(ctx);
  renderList(ctx);
  // Quotes are the output of a reading session, so that is what the sidebar
  // opens on. Search is a keystroke away with `/`.
  ctx.showTab("highlights");
  ctx.renderRoster();
  setCursor(ctx, 0);

  // A link from the library or the themes board carries a moment with it.
  const at = Number(params.get("t"));
  if (Number.isFinite(at) && at > 0) {
    const index = chunkIndexAtTime(ctx, at);
    setCursor(ctx, index, { scroll: true });
    seekAndPlay(ctx, at);
    flashCue(ctx, ctx.chunks[index]?.cue_ids?.[0]);
  }
  showDiagnostics(data, diagnostics);
}

function showDiagnostics(data, diagnostics) {
  if (data.migrated_from) {
    ctx.notify(
      `Quotes from ${data.migrated_from} were moved into ${data.highlights_file}. The original file was left in place as a backup.`,
      { kind: "info", key: null }
    );
  }

  if (data.highlights_stale) {
    ctx.notify(
      `The transcript changed since these quotes were saved. Their timestamps may no longer line up.`,
      { kind: "warn", key: null }
    );
  }

  // Speaker detection is a heuristic, so say what it decided rather than letting
  // a misparse be discovered an hour into a reading session.
  const key = `subtitle-search:parsed:${data.transcript.sha256}`;
  if (localStorage.getItem(key) === "dismissed") return;

  const speakers = diagnostics.speakers;
  const parts = diagnostics.part_count > 1
    ? `${diagnostics.part_count} recordings joined into one timeline. `
    : "";
  const summary = speakers.length
    ? `${parts}${diagnostics.cue_count} cues grouped into ${diagnostics.chunk_count} blocks. Speakers: ${speakers.join(", ")}.`
    : `${parts}${diagnostics.cue_count} cues, no speakers detected — blocks were split on pauses instead.`;
  ctx.notify(summary, { kind: speakers.length ? "info" : "warn", key });
}

/* ------------------------------------------------- reading cursor driver -- */

let scrollQueued = false;

ctx.el.reader.addEventListener("scroll", () => {
  if (ctx.mode !== "reading" || scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => {
    scrollQueued = false;
    setCursor(ctx, chunkIndexAtScroll(ctx));
  });
});

// Detaching on real input intent is more reliable than trying to tell a
// programmatic scroll from a human one after the fact.
for (const event of ["wheel", "touchmove"]) {
  ctx.el.reader.addEventListener(event, () => ctx.setMode("reading"), { passive: true });
}

let cueTimer;
ctx.onCursorMoved = (chunk) => {
  if (!chunk || ctx.mode !== "reading") return;
  clearTimeout(cueTimer);
  cueTimer = setTimeout(() => cue(ctx, chunk.start), 200);
};

ctx.onTimeUpdate = (seconds) => {
  syncFollowButton();
  if (ctx.mode !== "following") return;
  const index = chunkIndexAtTime(ctx, seconds);
  if (index !== ctx.cursorIndex) setCursor(ctx, index, { scroll: true });
  else updateSpine(ctx);
};

ctx.el.chunks.addEventListener("click", (event) => {
  const chunkEl = event.target.closest(".chunk");
  if (!chunkEl) return;
  const index = ctx.chunks.findIndex((chunk) => chunk.id === chunkEl.dataset.chunkId);
  if (index < 0) return;

  // Clicking outside the block being corrected finishes editing it.
  if (isEditing(ctx) && ctx.editingChunk !== index) exitEdit(ctx);
  if (event.target.closest(".cue-lines, .edit-bar")) return;

  const mark = event.target.closest("mark.hl");
  if (mark) {
    ctx.activeHighlightId = mark.dataset.highlightId;
    ctx.showTab("highlights");
    applyHighlights(ctx);
  }

  // Clicking the timestamp means "play from here"; clicking the text just moves
  // the reading cursor and cues the player without starting it.
  const fromTimestamp = Boolean(event.target.closest(".chunk__time"));
  ctx.setMode("reading");
  setCursor(ctx, index);
  if (fromTimestamp) seekAndPlay(ctx, ctx.chunks[index].start, { play: true });
});

ctx.el.follow.addEventListener("click", () => {
  ctx.setMode("following");
  setCursor(ctx, chunkIndexAtTime(ctx, ctx.currentTime), { scroll: true });
});

window.addEventListener("resize", () => {
  cacheGeometry(ctx);
  updateSpine(ctx);
});

/**
 * Give the block at the cursor a speaker, then move to the next one.
 *
 * Whole block rather than one caption: the cursor sits on a block, and on a
 * single-speaker transcript every caption *is* a block, which is exactly the
 * case this exists for. Advancing afterwards is what makes a labelling pass a
 * run of keypresses rather than a click each time.
 */
async function assignSpeaker(ctx, speaker) {
  const chunk = ctx.chunks[ctx.cursorIndex];
  if (!chunk || !speaker) return;
  if (chunk.speaker === speaker) {
    setCursor(ctx, ctx.cursorIndex + 1, { scroll: true });
    return;
  }

  const cues = chunk.cue_ids;
  try {
    const result = await api(
      `/api/recordings/${ctx.recordingId}/cues/${cues[0]}/speaker`,
      { method: "PATCH", body: { speaker, through: cues[cues.length - 1] } }
    );
    if (result.backup_created) ctx.notify(`Original transcript saved as ${result.backup_created}.`);
    const wasAt = ctx.cursorIndex;
    ctx.onTranscriptChanged(result.recording);
    // Blocks may have merged, so step past the one this cue now belongs to.
    const now = ctx.chunks.findIndex((c) => c.cue_ids.includes(cues[cues.length - 1]));
    setCursor(ctx, (now < 0 ? wasAt : now) + 1, { scroll: true });
  } catch (error) {
    ctx.notify(`Could not assign that speaker: ${error.message}`, { kind: "warn", key: null });
  }
}

/* -------------------------------------------------------------- keyboard -- */

const TYPING = new Set(["INPUT", "TEXTAREA", "SELECT"]);

document.addEventListener("keydown", (event) => {
  if (TYPING.has(event.target.tagName) || event.target.isContentEditable) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  const bound = (ctx.data?.transcript?.roster || []).find((entry) => entry.key === event.key);
  if (bound) {
    event.preventDefault();
    assignSpeaker(ctx, bound.name);
    return;
  }

  switch (event.key) {
    case "j":
      event.preventDefault();
      ctx.setMode("reading");
      setCursor(ctx, ctx.cursorIndex + 1, { scroll: true });
      break;
    case "k":
      event.preventDefault();
      ctx.setMode("reading");
      setCursor(ctx, ctx.cursorIndex - 1, { scroll: true });
      break;
    case " ":
      event.preventDefault();
      togglePlay(ctx);
      break;
    case "ArrowLeft":
      event.preventDefault();
      nudge(ctx, -5);
      break;
    case "ArrowRight":
      event.preventDefault();
      nudge(ctx, 5);
      break;
    case "[":
    case "]": {
      event.preventDefault();
      const rate = stepRate(ctx, event.key === "]" ? 1 : -1);
      if (rate) ctx.notify(`Playing at ${rate}\u00d7`);
      break;
    }
    case "/":
      event.preventDefault();
      ctx.showTab("search");
      ctx.el.searchInput.focus();
      ctx.el.searchInput.select();
      break;
    case "e":
      event.preventDefault();
      enterEdit(ctx, ctx.cursorIndex);
      break;
    case "h":
      event.preventDefault();
      save(ctx, {});
      break;
    case "c":
      event.preventDefault();
      copySelection(ctx);
      break;
    case "f":
      event.preventDefault();
      ctx.setMode(ctx.mode === "following" ? "reading" : "following");
      if (ctx.mode === "following") setCursor(ctx, chunkIndexAtTime(ctx, ctx.currentTime), { scroll: true });
      break;
    case "Escape":
      hideQuoteBar(ctx);
      window.getSelection()?.removeAllRanges();
      if (ctx.activeHighlightId) {
        ctx.activeHighlightId = null;
        applyHighlights(ctx);
      }
      break;
    default:
      break;
  }
});

/* ----------------------------------------------------------------- chrome -- */

ctx.el.tabSearch.addEventListener("click", () => ctx.showTab("search"));
ctx.el.tabHighlights.addEventListener("click", () => ctx.showTab("highlights"));

const THEME_KEY = "subtitle-search:theme";
const applyTheme = (theme) => {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
};
applyTheme(localStorage.getItem(THEME_KEY) || "auto");

ctx.el.themeToggle.addEventListener("click", () => {
  const order = ["auto", "light", "dark"];
  const current = document.documentElement.dataset.theme || "auto";
  applyTheme(order[(order.indexOf(current) + 1) % order.length]);
});

load().catch((error) => {
  ctx.notify(`Could not load the recording: ${error.message}`, { kind: "warn", key: null });
});
