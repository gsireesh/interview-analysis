/* Thematic analysis across every recording in the library.
 *
 * Views over the same quotes, because the work has more than one shape:
 *
 *   Canvas - the themes on a plane. Generative, and the one with no right-hand
 *            edge: columns stop working at the width of the screen, and a plane
 *            does not, so the number of themes is no longer a layout problem.
 *            Where two areas sit relative to each other is itself a claim.
 *   Board  - the same themes as columns. Still the fastest way to sort a pile
 *            when there are few enough themes to see all of them at once.
 *   Matrix - tags against recordings. Analytical: separates a theme many people
 *            raised from one person's preoccupation, which a flat tag list hides.
 *   Pairs  - tags that share quotes. Diagnostic: finds two codes that are really
 *            one code, and codes that always arrive together.
 *
 * Canvas and board are two shapes of one thing, not two groupings: a theme made
 * on either shows up on the other, because membership lives in a single file and
 * a card on the canvas *is* a quote's membership of the area holding it.
 *
 * What none of them would have on their own is the recording: every quote here
 * can be played where it was said, and a whole theme can be listened to in
 * sequence. Tone is half of what a quote means, and it does not survive being
 * written down.
 */

import { $, api, escapeHtml, formatTime } from "./util.js";
import { applyRate, storedRate } from "./player.js";
import { applyStoredTheme, bindThemeToggle, notify } from "./chrome.js";
import { initCanvas, renderCanvas, showCanvas } from "./canvas.js";
import {
  initSemantics,
  invalidateSemantics,
  renderGraph,
  renderMap,
  renderSignals,
} from "./semantics.js";

const el = {
  meta: $("meta"),
  notices: $("notices"),
  modes: $("modes"),
  canvas: $("view-canvas"),
  board: $("view-board"),
  boardColumns: $("board-columns"),
  boardFilter: $("board-filter"),
  boardProgress: $("board-progress"),
  addTheme: $("add-theme"),
  mapView: $("view-map"),
  graphView: $("view-graph"),
  signalsView: $("view-signals"),
  matrixView: $("view-matrix"),
  matrix: $("matrix"),
  matrixNote: $("matrix-note"),
  matrixDetail: $("matrix-detail"),
  pairsView: $("view-pairs"),
  pairs: $("pairs"),
  pairsNote: $("pairs-note"),
  queue: $("queue"),
  queueMedia: $("queue-media"),
  queuePlay: $("queue-play"),
  queueNext: $("queue-next"),
  queueClose: $("queue-close"),
  queueLabel: $("queue-label"),
  queueQuote: $("queue-quote"),
  queuePosition: $("queue-position"),
};

const state = {
  quotes: [],
  byRef: new Map(),
  recordings: new Map(),
  tags: [],
  cooccurrence: [],
  themes: [],
  cards: [],
  //: Quotes that are in a theme -- what the board calls sorted.
  placed: new Set(),
  //: Quotes with a card anywhere, loose ones included -- what the tray hides.
  onCanvas: new Set(),
  metrics: null,
  mode: "canvas",
  queue: [],
  queueIndex: 0,
  queueLabel: "",
};

/* ------------------------------------------------------------- loading -- */

async function load() {
  const [library, quotes, themes] = await Promise.all([
    api("/api/library"),
    api("/api/library/quotes"),
    api("/api/library/themes"),
  ]);

  state.quotes = quotes.quotes;
  state.byRef = new Map(state.quotes.map((q) => [q.ref, q]));
  state.recordings = new Map(library.recordings.map((r) => [r.id, r]));
  state.tags = library.tags;
  state.cooccurrence = library.cooccurrence;
  state.metrics = themes.metrics;
  adopt(themes);

  el.meta.textContent = [
    `${library.recordings.length} recordings`,
    `${state.quotes.length} quotes`,
    `${library.tags.length} tags`,
    library.untagged_count ? `${library.untagged_count} untagged` : null,
  ].filter(Boolean).join("  ·  ");

  const wanted = new URLSearchParams(location.search).get("tag");
  if (wanted) {
    showMode("matrix");
    renderMatrix(wanted);
  } else {
    renderAll();
  }
}

function renderAll() {
  renderBoard();
  // showCanvas rather than renderCanvas: the canvas is the mode the page opens
  // in, so nothing clicks into it, and framing the work needs doing on the way.
  showCanvas();
  renderMatrix();
  renderPairs();
}

/**
 * Take on a canvas payload as the current truth.
 *
 * Every canvas edit answers with the whole of it, because moving one card can
 * change two themes' membership and a client reassembling that from a narrower
 * reply is a client that can quietly disagree with the file. So there is one
 * place that swallows a reply, and it repaints both shapes of the same data.
 */
function adopt(payload) {
  if (payload.themes) state.themes = payload.themes;
  if (payload.cards) state.cards = payload.cards;
  recount();
  renderBoard();
  renderCanvas();
  if (state.mode === "map") renderMap();
}

/** Re-derive the two "is this quote dealt with" sets from the cards. */
function recount() {
  state.placed = new Set(state.themes.flatMap((theme) => theme.refs));
  state.onCanvas = new Set(state.cards.map((card) => card.ref));
}

/* --------------------------------------------------------------- modes -- */

function showMode(mode) {
  state.mode = mode;
  el.canvas.hidden = mode !== "canvas";
  el.board.hidden = mode !== "board";
  el.matrixView.hidden = mode !== "matrix";
  el.pairsView.hidden = mode !== "pairs";
  el.mapView.hidden = mode !== "map";
  el.graphView.hidden = mode !== "graph";
  el.signalsView.hidden = mode !== "signals";
  for (const button of el.modes.querySelectorAll("[data-mode]")) {
    button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
  }

  // These three cost real work -- encoding, a layout simulation -- so they run
  // when asked for rather than on load, and only need measuring once visible.
  if (mode === "canvas") showCanvas();
  if (mode === "map") renderMap();
  if (mode === "graph") renderGraph();
  if (mode === "signals") renderSignals();
}

el.modes.addEventListener("click", (event) => {
  const button = event.target.closest("[data-mode]");
  if (button) showMode(button.dataset.mode);
});

/* ------------------------------------------------------ quote rendering -- */

/**
 * A quote as a board card.
 *
 * ``column`` is the theme this particular card is sitting in, which is not the
 * same question as which theme the quote is in: since the canvas can pin one
 * quote inside two areas, the same quote appears in both of those columns. So
 * the select says where *this* card is and moving it moves only this one --
 * anything else would make touching one column silently empty another.
 */
function quoteCard(quote, { draggable = true, column = null } = {}) {
  const recording = state.recordings.get(quote.recording_id);
  const tags = (quote.tags || [])
    .map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`)
    .join("");

  // Dragging is the fast way to sort, but it cannot be the only way: a board
  // you can only use with a mouse is a board some people cannot use at all.
  const elsewhere = state.themes.filter(
    (theme) => theme.id !== column && theme.refs.includes(quote.ref)
  );
  const mover = draggable
    ? `<select class="qcard__move" data-act="move" aria-label="Move this quote to a theme">
         <option value=""${column ? "" : " selected"}>Unsorted</option>
         ${state.themes
           .map(
             (theme) =>
               `<option value="${theme.id}"${theme.id === column ? " selected" : ""}>${escapeHtml(theme.title)}</option>`
           )
           .join("")}
       </select>`
    : "";

  return `
    <article class="qcard qcard--${quote.color || "amber"}" data-ref="${quote.ref}"
             data-column="${column || ""}"
             ${draggable ? 'draggable="true"' : ""}>
      <p class="qcard__text">${escapeHtml(quote.text)}</p>
      <div class="qcard__meta">
        <span class="qcard__where">${escapeHtml(recording ? recording.title : quote.recording_id)}</span>
        <time>${formatTime(quote.start_time)}</time>
        <span class="qcard__tools">
          <button class="icon-btn" data-act="play" title="Play this quote">▶</button>
          <a class="icon-btn" href="/reader?recording=${encodeURIComponent(quote.recording_id)}&t=${quote.start_time}"
             title="Open in the transcript">↗</a>
        </span>
      </div>
      ${quote.note ? `<p class="qcard__note">${escapeHtml(quote.note)}</p>` : ""}
      ${
        elsewhere.length
          ? `<p class="qcard__also">also in ${elsewhere
              .map((theme) => escapeHtml(theme.title))
              .join(", ")}</p>`
          : ""
      }
      <div class="tags">${tags}</div>
      ${mover}
    </article>`;
}

/**
 * Move one card from the column it is in to another, or out of the board.
 *
 * The same operation the canvas performs, and deliberately the same call: the
 * board is a second shape for the canvas, not a second store. Dropping into a
 * theme says nothing about position, and the server finds a free slot in that
 * area -- so a quote sorted here is somewhere sensible when you next open the
 * plane, rather than stacked on top of whatever is already at the origin.
 */
async function moveCard(ref, from, to) {
  const path = to
    ? "/api/library/canvas/place"
    : "/api/library/canvas/unplace";
  const body = to ? { ref, theme_id: to, moved_from: from } : { ref, theme_id: from };
  try {
    adopt(await api(path, { method: "POST", body }));
  } catch (error) {
    notify(el.notices, `Could not move that quote: ${error.message}`, { kind: "warn" });
  }
}

/* ------------------------------------------------------------ the board -- */

function boardQuotes() {
  const filter = el.boardFilter.value;
  return state.quotes.filter((quote) => {
    if (filter === "unplaced") return !state.placed.has(quote.ref);
    if (filter === "tagged") return (quote.tags || []).length > 0;
    if (filter === "untagged") return (quote.tags || []).length === 0;
    return true;
  });
}

function renderBoard() {
  const visible = boardQuotes();
  const shown = new Set(visible.map((quote) => quote.ref));

  // Built from the themes outwards rather than from the quotes, because a quote
  // pinned in two areas on the canvas is genuinely in two columns here, and
  // asking each quote for "its" theme could only ever return one of them.
  const inTheme = new Map(
    state.themes.map((theme) => [
      theme.id,
      theme.refs.filter((ref) => shown.has(ref)).map((ref) => state.byRef.get(ref)).filter(Boolean),
    ])
  );
  const unsorted = visible.filter((quote) => !state.placed.has(quote.ref));

  el.boardProgress.textContent = state.quotes.length
    ? `${state.placed.size} of ${state.quotes.length} quotes placed`
    : "no quotes saved yet";

  const columns = [
    `<section class="column column--unsorted" data-theme-id="">
       <header class="column__head">
         <h2 class="column__title">Unsorted</h2>
         <span class="column__count">${unsorted.length}</span>
       </header>
       <div class="column__body" data-drop="">
         ${unsorted.map((q) => quoteCard(q)).join("") ||
           '<p class="empty">Nothing left here.</p>'}
       </div>
     </section>`,
  ];

  for (const theme of state.themes) {
    const quotes = inTheme.get(theme.id) || [];
    const recordings = new Set(quotes.map((q) => q.recording_id));
    columns.push(`
      <section class="column" data-theme-id="${theme.id}">
        <header class="column__head">
          <input class="column__title-input" value="${escapeHtml(theme.title)}"
                 data-act="rename" aria-label="Theme name">
          <span class="column__count">${quotes.length}</span>
          <button class="icon-btn" data-act="play-theme" title="Play every quote in this theme">▶</button>
          <button class="icon-btn" data-act="delete-theme" title="Delete theme">✕</button>
        </header>
        <p class="column__spread">${recordings.size} of ${state.recordings.size} recordings</p>
        <textarea class="column__note" rows="1" placeholder="What is this theme?"
                  data-act="note">${escapeHtml(theme.note || "")}</textarea>
        <div class="column__body" data-drop="${theme.id}">
          ${quotes.map((q) => quoteCard(q, { column: theme.id })).join("") ||
            '<p class="empty">Drag quotes here.</p>'}
        </div>
      </section>`);
  }

  el.boardColumns.innerHTML = columns.join("");
}

el.boardFilter.addEventListener("change", renderBoard);

el.addTheme.addEventListener("click", async () => {
  try {
    const { theme } = await api("/api/library/themes", { method: "POST", body: { title: "" } });
    state.themes.push(theme);
    renderBoard();
    renderCanvas();
    const input = el.boardColumns.querySelector(`[data-theme-id="${theme.id}"] .column__title-input`);
    input?.focus();
    input?.select();
  } catch (error) {
    notify(el.notices, `Could not add a theme: ${error.message}`, { kind: "warn" });
  }
});

// Drag and drop between columns. What is dragged is one card, so the column it
// came out of travels with it -- a quote in two columns must lose only the one
// you actually picked up.
let dragging = null;

el.boardColumns.addEventListener("dragstart", (event) => {
  const card = event.target.closest(".qcard");
  if (!card) return;
  dragging = { ref: card.dataset.ref, from: card.dataset.column || null };
  card.classList.add("qcard--dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", dragging.ref);
});

el.boardColumns.addEventListener("dragend", (event) => {
  event.target.closest(".qcard")?.classList.remove("qcard--dragging");
  el.boardColumns.querySelectorAll(".column__body--over")
    .forEach((node) => node.classList.remove("column__body--over"));
  dragging = null;
});

el.boardColumns.addEventListener("dragover", (event) => {
  const body = event.target.closest("[data-drop]");
  if (!body) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  body.classList.add("column__body--over");
});

el.boardColumns.addEventListener("dragleave", (event) => {
  event.target.closest("[data-drop]")?.classList.remove("column__body--over");
});

el.boardColumns.addEventListener("drop", async (event) => {
  const body = event.target.closest("[data-drop]");
  if (!body) return;
  event.preventDefault();
  body.classList.remove("column__body--over");

  const card = dragging || { ref: event.dataTransfer.getData("text/plain"), from: null };
  if (!card.ref) return;
  const to = body.dataset.drop || null;
  if (to !== card.from) await moveCard(card.ref, card.from, to);
});

// The same move, without a mouse.
el.boardColumns.addEventListener("change", (event) => {
  const select = event.target.closest('[data-act="move"]');
  const card = event.target.closest(".qcard");
  if (!select || !card) return;
  const to = select.value || null;
  const from = card.dataset.column || null;
  if (to !== from) moveCard(card.dataset.ref, from, to);
});

el.boardColumns.addEventListener("click", async (event) => {
  const action = event.target.closest("[data-act]")?.dataset.act;
  const column = event.target.closest("[data-theme-id]");
  const card = event.target.closest(".qcard");

  if (action === "play" && card) {
    const quote = state.byRef.get(card.dataset.ref);
    if (quote) startQueue([quote], quote.text.slice(0, 40));
    return;
  }
  if (!column || !column.dataset.themeId) return;
  const theme = state.themes.find((t) => t.id === column.dataset.themeId);
  if (!theme) return;

  if (action === "play-theme") {
    const quotes = theme.refs.map((ref) => state.byRef.get(ref)).filter(Boolean);
    if (quotes.length) startQueue(quotes, theme.title);
    else notify(el.notices, "That theme has no quotes in it yet.");
  } else if (action === "delete-theme") {
    try {
      await api(`/api/library/themes/${theme.id}`, { method: "DELETE" });
      state.themes = state.themes.filter((t) => t.id !== theme.id);
      state.cards = state.cards.filter((card) => card.theme_id !== theme.id);
      recount();
      renderBoard();
      renderCanvas();
    } catch (error) {
      notify(el.notices, `Could not delete that theme: ${error.message}`, { kind: "warn" });
    }
  }
});

el.boardColumns.addEventListener("change", async (event) => {
  const field = event.target.closest("[data-act]");
  const column = event.target.closest("[data-theme-id]");
  // The move select also lives inside a theme column and also fires change.
  if (!field || !column?.dataset.themeId) return;
  if (field.dataset.act !== "rename" && field.dataset.act !== "note") return;
  const patch = field.dataset.act === "rename" ? { title: field.value } : { note: field.value };
  try {
    const { theme } = await api(`/api/library/themes/${column.dataset.themeId}`, {
      method: "PATCH",
      body: patch,
    });
    Object.assign(state.themes.find((t) => t.id === theme.id) || {}, theme);
    renderCanvas();
  } catch (error) {
    notify(el.notices, `Could not rename that theme: ${error.message}`, { kind: "warn" });
  }
});

/* ----------------------------------------------------------- the matrix -- */

function renderMatrix(focusTag = null) {
  const recordings = [...state.recordings.values()];
  if (!state.tags.length) {
    el.matrix.innerHTML = "";
    el.matrixNote.textContent = "";
    el.matrixDetail.innerHTML =
      '<p class="empty">No tags yet. Tag some quotes in the reader and they will show up here.</p>';
    return;
  }

  el.matrixNote.textContent =
    "sorted by how many recordings share the tag — the top rows are the findings";

  const head = `<thead><tr><th class="matrix__corner">tag</th>${recordings
    .map((r) => `<th class="matrix__rec"><span>${escapeHtml(r.title)}</span></th>`)
    .join("")}<th class="matrix__total">total</th></tr></thead>`;

  const rows = state.tags
    .map((entry) => {
      const cells = recordings
        .map((recording) => {
          const count = entry.recordings[recording.id] || 0;
          // Weight is what turns a table of numbers into a shape you can read
          // down a column: a sparse row is one person, a solid row is a finding.
          const weight = count ? Math.min(1, 0.25 + count / 6) : 0;
          return `<td class="matrix__cell${count ? " matrix__cell--on" : ""}"
                      data-tag="${escapeHtml(entry.tag)}" data-recording="${recording.id}"
                      style="--weight:${weight.toFixed(2)}">${count || ""}</td>`;
        })
        .join("");
      return `<tr${focusTag === entry.tag ? ' class="matrix__row--focus"' : ""}>
        <th class="matrix__tag" data-tag="${escapeHtml(entry.tag)}">
          <span class="dot dot--${entry.color || "amber"}"></span>${escapeHtml(entry.tag)}
          <span class="matrix__spread">${entry.recording_count}/${recordings.length}</span>
        </th>${cells}
        <td class="matrix__total">${entry.quote_count}</td></tr>`;
    })
    .join("");

  el.matrix.innerHTML = head + `<tbody>${rows}</tbody>`;
  if (focusTag) showMatrixDetail(focusTag, null);
}

function showMatrixDetail(tag, recordingId) {
  const quotes = state.quotes.filter(
    (quote) =>
      (quote.tags || []).includes(tag) && (!recordingId || quote.recording_id === recordingId)
  );
  const where = recordingId ? state.recordings.get(recordingId)?.title : "every recording";
  el.matrixDetail.innerHTML = `
    <header class="sheet__head">
      <h2 class="sheet__title">${escapeHtml(tag)} · ${escapeHtml(where || "")}</h2>
      <span class="sheet__count">${quotes.length}</span>
      <button class="btn" id="play-tag" type="button">Play all ${quotes.length}</button>
    </header>
    <div class="qgrid">${quotes.map((q) => quoteCard(q, { draggable: false })).join("")}</div>`;

  $("play-tag")?.addEventListener("click", () => {
    if (quotes.length) startQueue(quotes, `${tag} · ${where}`);
  });
}

el.matrix.addEventListener("click", (event) => {
  const cell = event.target.closest("[data-tag]");
  if (!cell) return;
  showMatrixDetail(cell.dataset.tag, cell.dataset.recording || null);
});

el.matrixDetail.addEventListener("click", (event) => {
  const card = event.target.closest(".qcard");
  if (card && event.target.closest('[data-act="play"]')) {
    const quote = state.byRef.get(card.dataset.ref);
    if (quote) startQueue([quote], quote.text.slice(0, 40));
  }
});

/* ------------------------------------------------------------ the pairs -- */

function renderPairs() {
  if (!state.cooccurrence.length) {
    el.pairs.innerHTML =
      '<p class="empty">No two tags share a quote yet. This view fills in once quotes carry more than one tag.</p>';
    el.pairsNote.textContent = "";
    return;
  }

  el.pairsNote.textContent = "two codes that always arrive together are often one code";
  const strongest = state.cooccurrence[0].count;

  el.pairs.innerHTML = state.cooccurrence
    .map((pair) => {
      const share = Math.max(0.08, pair.count / strongest);
      return `
        <button class="pair" type="button" data-a="${escapeHtml(pair.a)}" data-b="${escapeHtml(pair.b)}">
          <span class="pair__names">
            <span class="tag">${escapeHtml(pair.a)}</span>
            <span class="pair__link" style="--share:${share.toFixed(2)}"></span>
            <span class="tag">${escapeHtml(pair.b)}</span>
          </span>
          <span class="pair__counts">${pair.count} quote${pair.count === 1 ? "" : "s"}
            · ${pair.recording_count} recording${pair.recording_count === 1 ? "" : "s"}</span>
        </button>
        <div class="pair__quotes" hidden></div>`;
    })
    .join("");
}

el.pairs.addEventListener("click", (event) => {
  const button = event.target.closest(".pair");
  if (!button) return;
  const panel = button.nextElementSibling;
  if (!panel.hidden) {
    panel.hidden = true;
    return;
  }
  const { a, b } = button.dataset;
  const quotes = state.quotes.filter(
    (quote) => (quote.tags || []).includes(a) && (quote.tags || []).includes(b)
  );
  panel.innerHTML = `<div class="qgrid">${quotes.map((q) => quoteCard(q, { draggable: false })).join("")}</div>`;
  panel.hidden = false;
});

/* --------------------------------------------------- listening in a row -- */

/** Which media file holds a session time, and where inside it. */
function locate(quote) {
  const recording = state.recordings.get(quote.recording_id);
  const parts = recording?.parts || [];
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (quote.start_time >= parts[i].offset && parts[i].media_name) {
      return { index: i, local: quote.start_time - parts[i].offset };
    }
  }
  return parts.length && parts[0].media_name ? { index: 0, local: quote.start_time } : null;
}

function startQueue(quotes, label) {
  state.queue = quotes;
  state.queueIndex = 0;
  state.queueLabel = label || "";
  el.queue.hidden = false;
  playCurrent();
}

async function playCurrent() {
  const quote = state.queue[state.queueIndex];
  if (!quote) {
    stopQueue();
    return;
  }

  el.queueLabel.textContent =
    `${state.queueLabel} — ${state.recordings.get(quote.recording_id)?.title || ""}`;
  el.queueQuote.textContent = quote.text;
  el.queuePosition.textContent = `${state.queueIndex + 1}/${state.queue.length}`;

  const spot = locate(quote);
  if (!spot) {
    notify(el.notices, "That recording has no media to play.", { kind: "warn" });
    return;
  }

  const url = `/api/recordings/${quote.recording_id}/parts/${spot.index}/media`;
  if (el.queueMedia.dataset.src !== url) {
    el.queueMedia.dataset.src = url;
    el.queueMedia.src = url;
    await new Promise((resolve) => {
      el.queueMedia.addEventListener("loadedmetadata", resolve, { once: true });
      el.queueMedia.addEventListener("error", resolve, { once: true });
    });
  }
  // A little before the first word, as in the reader, at the speed set there.
  applyRate(el.queueMedia, storedRate());
  el.queueMedia.currentTime = Math.max(0, spot.local - 0.75);
  el.queueMedia.play().catch(() => {});
}

// Each quote stops at its own end rather than running into whatever follows.
el.queueMedia.addEventListener("timeupdate", () => {
  const quote = state.queue[state.queueIndex];
  if (!quote) return;
  const spot = locate(quote);
  if (!spot) return;
  const stopAt = spot.local + (quote.end_time - quote.start_time) + 0.4;
  if (el.queueMedia.currentTime >= stopAt) advance();
});

function advance() {
  if (state.queueIndex + 1 < state.queue.length) {
    state.queueIndex += 1;
    playCurrent();
  } else {
    el.queueMedia.pause();
    el.queuePosition.textContent = "done";
  }
}

function stopQueue() {
  el.queueMedia.pause();
  el.queue.hidden = true;
  state.queue = [];
}

el.queueNext.addEventListener("click", advance);
el.queueClose.addEventListener("click", stopQueue);
el.queuePlay.addEventListener("click", () => {
  if (el.queueMedia.paused) el.queueMedia.play().catch(() => {});
  else el.queueMedia.pause();
});
el.queueMedia.addEventListener("play", () => (el.queuePlay.textContent = "❚❚"));
el.queueMedia.addEventListener("pause", () => (el.queuePlay.textContent = "▶"));

/* ---------------------------------------------------------------- start -- */

const shared = {
  state,
  startQueue,
  notify: (message, options) => notify(el.notices, message, options),
  refreshBoard: renderBoard,
  adopt,
  recount,
};

initCanvas(shared);
initSemantics({ ...shared, quoteCard });

applyStoredTheme();
bindThemeToggle($("theme-toggle"));
load().catch((error) =>
  notify(el.notices, `Could not load the library: ${error.message}`, { kind: "warn" })
);
