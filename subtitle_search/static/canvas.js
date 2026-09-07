/* Themes as a plane instead of a row of columns.
 *
 * The board ran out of screen. Columns only work while they all fit, and past
 * about six themes the useful ones are off the right-hand edge -- which is the
 * point at which the interface starts deciding what you think about. A plane has
 * no such edge: it pans, it zooms, and a theme that matters can be put in the
 * middle where you keep looking.
 *
 * What the plane also gets you is the thing a column list cannot express at all.
 * Themes sit next to the themes they resemble; two areas nudged up against each
 * other is a claim you are making about them, and an outlier parked between two
 * areas is a quote you have not decided about yet. None of that is a field in the
 * file. It is the arrangement, and the arrangement is the analysis.
 *
 * Three ideas hold the whole thing up:
 *
 *   A card is not a quote. It is one appearance of a quote, at one position, so
 *   the same quote can be pinned inside two areas at once -- two cards, one
 *   quote. Photocopying a post-it, which is what you would do with the paper.
 *
 *   A card in an area is a DOM child of that area, positioned relative to it.
 *   That is what makes "themes bring their quotes with them" free rather than
 *   bookkeeping: dragging an area changes two numbers and every card in it
 *   moves, and no card can be left behind by a bug in the moving code.
 *
 *   Every drag is the same drag. One pointer capture on the viewport, one ghost
 *   element following the cursor in screen space. Dragging a quote out of the
 *   tray, out of one area into another, and back to the tray to put it away are
 *   the same code path, so they cannot behave differently.
 */

import { $, api, debounce, escapeHtml, formatTime, recall, remember } from "./util.js";

const VIEW_KEY = "subtitle-search:canvas-view";
const TRAY_KEY = "subtitle-search:canvas-tray";

//: Pointer travel before a press becomes a drag. Without it, clicking a card's
//: play button on a trackpad regularly moves the card a pixel and saves that.
const SLOP = 4;

//: Spacing of the surface's dot grid, in canvas units.
const GRID = 24;

const ZOOM_MIN = 0.2;
const ZOOM_MAX = 2;
const ZOOM_STEP = 1.15;

//: How far a card moves under the arrow keys, and under shift for fine work.
const NUDGE = 12;
const NUDGE_FINE = 2;

//: Long enough that dragging a card around does not write the file on every
//: frame, short enough that letting go and closing the tab keeps the position.
const SAVE_AFTER = 400;

let ctx = null;
const el = {};

/** Pan and zoom. A view of the work, not the work -- so it stays in this browser. */
const view = { x: 0, y: 0, z: 1 };

/** The drag in progress, or null. One at a time, by construction. */
let drag = null;

/** Which card the keyboard is on, as ``ref`` and the area holding it. */
let focused = null;

/** Whether the view has been framed on the work at least once. */
let framed = false;

/* ------------------------------------------------------------- geometry -- */

/**
 * The card and area sizes the server laid the file out with.
 *
 * Not restated here with defaults. The server owns these numbers because it
 * placed the themes in a file that had no coordinates, and a second copy of
 * them in the client is exactly the bug the arrangement cannot survive -- a
 * card measured differently at the two ends drops into the wrong slot. Anything
 * that needs them runs after the first load, which is where they arrive.
 */
const metrics = () => ctx.state.metrics;

/** Where a client point lands on the plane. */
function toCanvas(clientX, clientY) {
  const rect = el.viewport.getBoundingClientRect();
  return {
    x: (clientX - rect.left - view.x) / view.z,
    y: (clientY - rect.top - view.y) / view.z,
  };
}

//: Panning fires on every frame, and storage is not free -- so where you are
//: looking is written a moment after you stop looking around.
const rememberView = debounce(() => remember(VIEW_KEY, JSON.stringify(view)), 300);

function applyView() {
  el.surface.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
  // The dot grid is painted by the viewport rather than the surface, so it can
  // run endlessly in all four directions without a vast element to carry it.
  // Coarser when zoomed far out, where a fine grid would read as grey fog.
  const pitch = (view.z < 0.5 ? GRID * 4 : GRID) * view.z;
  el.viewport.style.backgroundSize = `${pitch}px ${pitch}px`;
  el.viewport.style.backgroundPosition = `${view.x}px ${view.y}px`;
  el.zoomLevel.textContent = `${Math.round(view.z * 100)}%`;
  rememberView();
}

function restoreView() {
  try {
    const saved = JSON.parse(recall(VIEW_KEY, "null"));
    if (saved && Number.isFinite(saved.z)) Object.assign(view, saved);
  } catch (_) { /* nothing remembered, or nonsense remembered */ }
  view.z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, view.z || 1));
}

/** Zoom about a fixed client point, so the thing under the cursor stays put. */
function zoomAt(clientX, clientY, factor) {
  const before = toCanvas(clientX, clientY);
  view.z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, view.z * factor));
  const after = toCanvas(clientX, clientY);
  view.x += (after.x - before.x) * view.z;
  view.y += (after.y - before.y) * view.z;
  applyView();
}

/** Frame everything that is on the canvas, or come back to the origin if nothing is. */
function fit() {
  const { card_w, card_h } = metrics();
  const boxes = [
    ...ctx.state.themes.map((t) => [t.x, t.y, t.w, t.h]),
    ...ctx.state.cards
      .filter((c) => !c.theme_id)
      .map((c) => [c.x, c.y, card_w, card_h]),
  ];
  const rect = el.viewport.getBoundingClientRect();
  if (!boxes.length || !rect.width) {
    Object.assign(view, { x: 24, y: 24, z: 1 });
    applyView();
    return;
  }

  const left = Math.min(...boxes.map((b) => b[0]));
  const top = Math.min(...boxes.map((b) => b[1]));
  const right = Math.max(...boxes.map((b) => b[0] + b[2]));
  const bottom = Math.max(...boxes.map((b) => b[1] + b[3]));
  const pad = 40;
  view.z = Math.min(
    ZOOM_MAX,
    Math.max(ZOOM_MIN, Math.min(rect.width / (right - left + pad * 2), rect.height / (bottom - top + pad * 2)))
  );
  view.x = (rect.width - (right - left) * view.z) / 2 - left * view.z;
  view.y = (rect.height - (bottom - top) * view.z) / 2 - top * view.z;
  applyView();
}

/**
 * Which area a point on the plane falls in.
 *
 * Areas do not nest, so overlap is only ever clutter to be dragged apart -- but
 * while it is there, the smallest area containing the point is the one meant.
 * A big area sitting behind a small one is a backdrop, not the target.
 */
function areaAt(point) {
  return ctx.state.themes
    .filter(
      (t) =>
        point.x >= t.x && point.x <= t.x + t.w && point.y >= t.y && point.y <= t.y + t.h
    )
    .sort((a, b) => a.w * a.h - b.w * b.h)[0] || null;
}

/** Keep a card's own position inside the area it belongs to. */
function clampToArea(theme, x, y) {
  const { card_w, card_h, area_pad, area_head } = metrics();
  return {
    x: Math.min(Math.max(x, area_pad), Math.max(area_pad, theme.w - area_pad - card_w)),
    y: Math.min(Math.max(y, area_head), Math.max(area_head, theme.h - area_pad - card_h)),
  };
}

/* ------------------------------------------------------------ rendering -- */

/** The card as it appears on the plane: short, and playable where it stands. */
function cardMarkup(quote, card) {
  const recording = ctx.state.recordings.get(quote.recording_id);
  const tags = (quote.tags || []).join(", ");
  return `
    <article class="ccard qcard--${quote.color || "amber"}"
             data-ref="${escapeHtml(quote.ref)}"
             data-theme="${escapeHtml(card.theme_id || "")}"
             style="left:${card.x}px; top:${card.y}px"
             tabindex="0" role="group"
             aria-label="${escapeHtml(quote.text.slice(0, 90))}">
      <p class="ccard__text">${escapeHtml(quote.text)}</p>
      <footer class="ccard__foot">
        <span class="ccard__who">${escapeHtml(quote.speaker || recording?.title || quote.recording_id)}</span>
        <time>${formatTime(quote.start_time)}</time>
        <button class="icon-btn" data-act="play" type="button" title="Play this quote">▶</button>
        <a class="icon-btn" data-act="open"
           href="/reader?recording=${encodeURIComponent(quote.recording_id)}&t=${quote.start_time}"
           title="Open in the transcript">↗</a>
      </footer>
      ${tags ? `<p class="ccard__tags" title="${escapeHtml(tags)}">${escapeHtml(tags)}</p>` : ""}
    </article>`;
}

function areaMarkup(theme, cards) {
  const spread = new Set(
    cards.map((c) => ctx.state.byRef.get(c.ref)?.recording_id).filter(Boolean)
  );
  return `
    <section class="area" data-theme="${escapeHtml(theme.id)}"
             style="left:${theme.x}px; top:${theme.y}px; width:${theme.w}px; height:${theme.h}px">
      <header class="area__head" data-handle="move">
        <input class="area__title" value="${escapeHtml(theme.title)}" data-act="rename"
               aria-label="Theme name">
        <span class="area__count" title="quotes in this theme">${cards.length}</span>
        <span class="area__spread">${spread.size}/${ctx.state.recordings.size} rec</span>
        <button class="icon-btn" data-act="play-theme" type="button"
                title="Play every quote in this theme">▶</button>
        <button class="icon-btn" data-act="tidy" type="button"
                title="Pack these into a grid">⊞</button>
        <button class="icon-btn" data-act="delete" type="button"
                title="Delete this area">✕</button>
      </header>
      <input class="area__note" value="${escapeHtml(theme.note || "")}" data-act="note"
             placeholder="What is this theme?" aria-label="What this theme is">
      ${cards
        .map((card) => {
          const quote = ctx.state.byRef.get(card.ref);
          return quote ? cardMarkup(quote, card) : "";
        })
        .join("")}
      ${cards.length ? "" : '<p class="area__empty">Drag quotes in here.</p>'}
      <span class="area__grip" data-handle="resize" title="Resize"></span>
    </section>`;
}

export function renderCanvas() {
  if (!ctx || !ctx.state.metrics) return;

  // Card size comes from the server, which laid out the file, so the stylesheet
  // is told rather than asked. Restating it in CSS would be one number in two
  // places, and a card a pixel wider there than here drops in the wrong slot.
  const { card_w, card_h } = metrics();
  el.surface.style.setProperty("--card-w", `${card_w}px`);
  el.surface.style.setProperty("--card-h", `${card_h}px`);

  const byTheme = new Map(ctx.state.themes.map((t) => [t.id, []]));
  const loose = [];
  for (const card of ctx.state.cards) {
    if (card.theme_id && byTheme.has(card.theme_id)) byTheme.get(card.theme_id).push(card);
    else if (!card.theme_id) loose.push(card);
  }

  el.surface.innerHTML =
    ctx.state.themes.map((theme) => areaMarkup(theme, byTheme.get(theme.id))).join("") +
    loose
      .map((card) => {
        const quote = ctx.state.byRef.get(card.ref);
        return quote ? cardMarkup(quote, card) : "";
      })
      .join("");

  // An empty plane explains nothing about itself, and this is the one screen in
  // the tool where there is no content to infer the gesture from.
  el.blank.hidden = Boolean(ctx.state.themes.length || ctx.state.cards.length);

  // Two counts, because they answer different questions: how much of the study
  // is filed, and how much is out on the plane but still undecided.
  const undecided = ctx.state.onCanvas.size - ctx.state.placed.size;
  el.progress.textContent = ctx.state.quotes.length
    ? `${ctx.state.placed.size} of ${ctx.state.quotes.length} in a theme` +
      (undecided > 0 ? ` · ${undecided} loose` : "")
    : "no quotes saved yet";

  renderTray();
  if (focused) {
    const node = cardNode(focused.ref, focused.theme_id);
    if (node) node.classList.add("ccard--focus");
    else focused = null;
  }
  showInspector();
}

function cardNode(ref, themeId) {
  return el.surface.querySelector(
    `.ccard[data-ref="${CSS.escape(ref)}"][data-theme="${CSS.escape(themeId || "")}"]`
  );
}

/* ----------------------------------------------------------------- tray -- */

/**
 * The quotes not out on the canvas yet.
 *
 * A study has hundreds of quotes. Scattering all of them across the plane on
 * first open would be a mess nobody would sort, so the canvas starts as whatever
 * you have put on it, and everything else waits in a list you pull from. A quote
 * leaves the list the moment it has a card anywhere -- including parked loose on
 * bare canvas, because a quote you have already pulled out and looked at is one
 * you have dealt with, whether or not a theme claims it.
 */
function trayQuotes() {
  const needle = el.traySearch.value.trim().toLowerCase();
  const filter = el.trayFilter.value;
  return ctx.state.quotes.filter((quote) => {
    if (ctx.state.onCanvas.has(quote.ref)) return false;
    if (filter === "tagged" && !(quote.tags || []).length) return false;
    if (filter === "untagged" && (quote.tags || []).length) return false;
    if (!needle) return true;
    return (
      quote.text.toLowerCase().includes(needle) ||
      (quote.tags || []).some((tag) => tag.toLowerCase().includes(needle)) ||
      (quote.speaker || "").toLowerCase().includes(needle)
    );
  });
}

function renderTray() {
  const quotes = trayQuotes();
  const scroll = el.trayBody.scrollTop;
  el.trayCount.textContent = String(quotes.length);
  el.trayBody.innerHTML = quotes.length
    ? quotes
        .map(
          (quote) => `
          <article class="tray__item qcard--${quote.color || "amber"}"
                   data-ref="${escapeHtml(quote.ref)}" tabindex="0"
                   title="Drag onto the canvas, or press enter">
            <p class="tray__text">${escapeHtml(quote.text)}</p>
            <p class="tray__meta">
              <span>${escapeHtml(quote.speaker || quote.recording_title || "")}</span>
              <time>${formatTime(quote.start_time)}</time>
            </p>
          </article>`
        )
        .join("")
    : '<p class="empty">Everything is out on the canvas.</p>';
  el.trayBody.scrollTop = scroll;
}

/**
 * What the keyboard is holding, and what can be done to it without a mouse.
 *
 * Dragging is the fast way to arrange a plane and it cannot be the only way. The
 * select here is the same move as a drag between two areas; the arrow keys are
 * the same move as a drag within one.
 */
function showInspector() {
  if (!focused) {
    el.inspector.innerHTML =
      '<p class="empty">Click or tab to a card to move it with the keyboard.</p>';
    return;
  }
  const quote = ctx.state.byRef.get(focused.ref);
  if (!quote) {
    el.inspector.innerHTML = "";
    return;
  }
  el.inspector.innerHTML = `
    <p class="inspector__text">${escapeHtml(quote.text)}</p>
    <label class="inspector__row">
      <span>In</span>
      <select data-act="reparent" aria-label="Which theme this card is in">
        <option value=""${focused.theme_id ? "" : " selected"}>loose on the canvas</option>
        ${ctx.state.themes
          .map(
            (theme) =>
              `<option value="${escapeHtml(theme.id)}"${
                theme.id === focused.theme_id ? " selected" : ""
              }>${escapeHtml(theme.title)}</option>`
          )
          .join("")}
      </select>
    </label>
    <p class="inspector__hint">arrows move it · shift for fine · delete puts it away</p>
    <div class="inspector__acts">
      <button class="btn" data-act="duplicate" type="button">Also place in…</button>
      <button class="btn" data-act="remove" type="button">Put away</button>
    </div>`;
}

/* ----------------------------------------------------------- persistence -- */

/**
 * Make a change, and take the whole canvas back as the answer.
 *
 * Structural changes go through here and nowhere else. Moving one card can
 * change two themes' membership, so the reply is the entire state and one place
 * swallows it -- the alternative is a client patching its own copy and quietly
 * disagreeing with the file about where things are.
 */
async function send(path, body, whenBroken) {
  try {
    ctx.adopt(await api(path, { method: "POST", body }));
  } catch (error) {
    ctx.notify(`${whenBroken}: ${error.message}`, { kind: "warn" });
    renderCanvas();
  }
}

/**
 * Positions, written a moment after you stop moving things.
 *
 * Moves accumulate by card so that shoving one card around for ten seconds is
 * still one write, and so a drag that ends up touching several cards -- resizing
 * an area pulls its contents back inside -- lands as a single change to the file
 * rather than a burst the reader could catch halfway through.
 */
const pendingMoves = new Map();
const flushMoves = debounce(async () => {
  const moves = [...pendingMoves.values()];
  pendingMoves.clear();
  if (!moves.length) return;
  try {
    await api("/api/library/canvas/positions", { method: "POST", body: { moves } });
  } catch (error) {
    ctx.notify(`Could not save where things are: ${error.message}`, { kind: "warn" });
  }
}, SAVE_AFTER);

function saveCard(ref, themeId, x, y) {
  const card = ctx.state.cards.find((c) => c.ref === ref && (c.theme_id || null) === (themeId || null));
  if (card) Object.assign(card, { x, y });
  pendingMoves.set(`${themeId || ""}|${ref}`, { ref, theme_id: themeId || null, x, y });
  flushMoves();
}

const pendingShapes = new Map();
const flushShapes = debounce(async () => {
  const shapes = [...pendingShapes.values()];
  pendingShapes.clear();
  for (const shape of shapes) {
    try {
      const { theme } = await api("/api/library/canvas/reshape", { method: "POST", body: shape });
      Object.assign(ctx.state.themes.find((t) => t.id === theme.id) || {}, theme);
    } catch (error) {
      ctx.notify(`Could not save that area: ${error.message}`, { kind: "warn" });
    }
  }
}, SAVE_AFTER);

function saveArea(theme) {
  pendingShapes.set(theme.id, {
    theme_id: theme.id,
    x: theme.x,
    y: theme.y,
    w: theme.w,
    h: theme.h,
  });
  flushShapes();
}

/* ---------------------------------------------------------- dragging it -- */

/**
 * Start a drag of a card, from wherever it currently is.
 *
 * The card being dragged is drawn as a fixed-position ghost in screen space
 * rather than being moved around inside the transformed plane. That is what lets
 * one piece of code drag a quote out of the tray, between two areas, and back
 * into the tray: the ghost does not care which of those it came from, and none of
 * them involve reparenting a node that is holding a pointer capture.
 */
function beginCardDrag(event, { ref, from, grabX, grabY, copy }) {
  const { card_w, card_h } = metrics();
  const quote = ctx.state.byRef.get(ref);
  if (!quote) return;

  const ghost = document.createElement("div");
  ghost.className = `ccard ccard--ghost qcard--${quote.color || "amber"}`;
  ghost.style.width = `${card_w * view.z}px`;
  ghost.style.height = `${card_h * view.z}px`;
  ghost.innerHTML = `<p class="ccard__text">${escapeHtml(quote.text)}</p>`;
  document.body.appendChild(ghost);

  drag = {
    kind: "card",
    ref,
    from,
    copy,
    ghost,
    grabX,
    grabY,
    origin: from === undefined ? null : cardNode(ref, from),
  };
  drag.origin?.classList.add("ccard--lifted");
  moveGhost(event.clientX, event.clientY);
}

function moveGhost(clientX, clientY) {
  drag.ghost.style.left = `${clientX - drag.grabX * view.z}px`;
  drag.ghost.style.top = `${clientY - drag.grabY * view.z}px`;
  const overTray = pointerOver(el.tray, clientX, clientY);
  drag.ghost.classList.toggle("ccard--discard", overTray);

  // Say where it would land before letting go, because on a plane a drop with no
  // preview is a guess -- areas overlap, and the edge of one is not obvious.
  const { card_w, card_h } = metrics();
  const point = toCanvas(clientX - drag.grabX * view.z, clientY - drag.grabY * view.z);
  const target = overTray
    ? null
    : areaAt({ x: point.x + card_w / 2, y: point.y + card_h / 2 });
  for (const node of el.surface.querySelectorAll(".area--target")) {
    node.classList.remove("area--target");
  }
  if (target) {
    el.surface.querySelector(`.area[data-theme="${CSS.escape(target.id)}"]`)
      ?.classList.add("area--target");
  }
}

function pointerOver(node, clientX, clientY) {
  if (!node || node.hidden) return false;
  const rect = node.getBoundingClientRect();
  return (
    clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
  );
}

async function finishCardDrag(clientX, clientY) {
  const { card_w, card_h } = metrics();
  const { ref, from, copy } = drag;
  const point = toCanvas(clientX - drag.grabX * view.z, clientY - drag.grabY * view.z);
  const overTray = pointerOver(el.tray, clientX, clientY);
  const inViewport = pointerOver(el.viewport, clientX, clientY);

  drag.ghost.remove();
  drag.origin?.classList.remove("ccard--lifted");
  for (const node of el.surface.querySelectorAll(".area--target")) {
    node.classList.remove("area--target");
  }
  const wasNew = from === undefined;
  drag = null;

  // Dropped back on the tray: put this one card away. Other cards for the same
  // quote, in other themes, are none of this card's business.
  if (overTray) {
    if (wasNew) return;
    focused = null;
    await send("/api/library/canvas/unplace", { ref, theme_id: from }, "Could not put that away");
    return;
  }
  if (!inViewport) {
    renderCanvas();
    return;
  }

  const target = areaAt({ x: point.x + card_w / 2, y: point.y + card_h / 2 });
  const body = { ref, theme_id: target ? target.id : null };
  if (target) {
    const spot = clampToArea(target, point.x - target.x, point.y - target.y);
    Object.assign(body, spot);
  } else {
    Object.assign(body, { x: point.x, y: point.y });
  }
  // A move names where it came from so the card travels; a copy says nothing, and
  // the server adds a second card for the same quote.
  if (!wasNew && !copy) body.moved_from = from;

  focused = { ref, theme_id: body.theme_id };
  await send("/api/library/canvas/place", body, "Could not move that quote");
}

/* ------------------------------------------------------------- pointers -- */

function bindPointers() {
  el.viewport.addEventListener("pointerdown", onPointerDown);
  el.viewport.addEventListener("pointermove", onPointerMove);
  el.viewport.addEventListener("pointerup", onPointerUp);
  el.viewport.addEventListener("pointercancel", onPointerUp);
  el.tray.addEventListener("pointerdown", onTrayPointerDown);
  el.tray.addEventListener("pointermove", onPointerMove);
  el.tray.addEventListener("pointerup", onPointerUp);
  el.tray.addEventListener("pointercancel", onPointerUp);
}

function onPointerDown(event) {
  if (event.button !== 0 && event.button !== 1) return;
  const card = event.target.closest(".ccard");
  const area = event.target.closest(".area");
  const handle = event.target.closest("[data-handle]")?.dataset.handle;

  // Anything with its own job -- a play button, a title field -- keeps it.
  if (event.target.closest("button, a, input, textarea, select")) return;

  // Everything from here is a drag, so the browser's own idea of what a press
  // means is refused: dragging a card across its own text would otherwise leave
  // a trail of blue selection behind the thing you are moving. Focus is then
  // this function's job, and is given without scrolling -- the plane is moved by
  // its transform and by nothing else.
  event.preventDefault();

  const start = { clientX: event.clientX, clientY: event.clientY };
  el.viewport.setPointerCapture(event.pointerId);

  if (card && event.button === 0) {
    const rect = card.getBoundingClientRect();
    drag = {
      kind: "pending-card",
      start,
      ref: card.dataset.ref,
      from: card.dataset.theme || null,
      grabX: (event.clientX - rect.left) / view.z,
      grabY: (event.clientY - rect.top) / view.z,
      copy: event.altKey,
    };
    card.focus({ preventScroll: true });
    focusCard(card.dataset.ref, card.dataset.theme || null);
    return;
  }

  if (area && event.button === 0) {
    const theme = ctx.state.themes.find((t) => t.id === area.dataset.theme);
    if (theme) {
      drag =
        handle === "resize"
          ? { kind: "resize", start, node: area, theme, w: theme.w, h: theme.h }
          : { kind: "area", start, node: area, theme, x: theme.x, y: theme.y };
      area.classList.add("area--moving");
      return;
    }
  }

  drag = { kind: "pan", start, x: view.x, y: view.y };
  el.viewport.classList.add("canvas__viewport--panning");
}

function onTrayPointerDown(event) {
  const item = event.target.closest(".tray__item");
  if (!item || event.button !== 0) return;
  event.preventDefault();
  const { card_w, card_h } = metrics();
  item.focus({ preventScroll: true });
  el.tray.setPointerCapture(event.pointerId);
  drag = {
    kind: "pending-card",
    start: { clientX: event.clientX, clientY: event.clientY },
    ref: item.dataset.ref,
    from: undefined,
    // Grab it near its middle: the tray item is a different shape from the card
    // it becomes, so the point you pressed does not mean anything on the plane.
    grabX: card_w / 2,
    grabY: card_h / 2,
    copy: false,
  };
}

function onPointerMove(event) {
  if (!drag) return;

  // A card in flight is the one drag with no origin to measure from: the ghost
  // tracks the pointer in screen space, so it is handled before anything reads
  // the press position.
  if (drag.kind === "card") {
    moveGhost(event.clientX, event.clientY);
    return;
  }

  const dx = event.clientX - drag.start.clientX;
  const dy = event.clientY - drag.start.clientY;

  if (drag.kind === "pending-card") {
    if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
    const { ref, from, grabX, grabY, copy } = drag;
    drag = null;
    beginCardDrag(event, { ref, from, grabX, grabY, copy });
    return;
  }

  if (drag.kind === "pan") {
    view.x = drag.x + dx;
    view.y = drag.y + dy;
    applyView();
    return;
  }

  const { area_min_w, area_min_h } = metrics();
  if (drag.kind === "area") {
    drag.theme.x = drag.x + dx / view.z;
    drag.theme.y = drag.y + dy / view.z;
    drag.node.style.left = `${drag.theme.x}px`;
    drag.node.style.top = `${drag.theme.y}px`;
    return;
  }
  if (drag.kind === "resize") {
    drag.theme.w = Math.max(area_min_w, drag.w + dx / view.z);
    drag.theme.h = Math.max(area_min_h, drag.h + dy / view.z);
    drag.node.style.width = `${drag.theme.w}px`;
    drag.node.style.height = `${drag.theme.h}px`;
  }
}

function onPointerUp(event) {
  if (!drag) return;
  el.viewport.classList.remove("canvas__viewport--panning");
  try {
    event.currentTarget.releasePointerCapture(event.pointerId);
  } catch (_) { /* pointer already gone */ }

  if (drag.kind === "card") {
    finishCardDrag(event.clientX, event.clientY);
    return;
  }
  if (drag.kind === "pending-card" || drag.kind === "pan") {
    drag = null;
    return;
  }

  const { theme, node, kind } = drag;
  drag = null;
  node.classList.remove("area--moving");
  if (kind === "resize") {
    // Pull anything the smaller box no longer covers back inside, so a card
    // cannot end up hidden behind the edge of its own theme.
    for (const card of ctx.state.cards.filter((c) => c.theme_id === theme.id)) {
      const spot = clampToArea(theme, card.x, card.y);
      if (spot.x !== card.x || spot.y !== card.y) {
        Object.assign(card, spot);
        const element = cardNode(card.ref, theme.id);
        if (element) {
          element.style.left = `${card.x}px`;
          element.style.top = `${card.y}px`;
        }
      }
    }
  }
  saveArea(theme);
}

/* --------------------------------------------------------- wheel & keys -- */

function onWheel(event) {
  event.preventDefault();
  // Pinch on a trackpad arrives as ctrl+wheel, which is also how a mouse asks
  // to zoom. Everything else scrolls the plane rather than the page.
  if (event.ctrlKey || event.metaKey) {
    zoomAt(event.clientX, event.clientY, event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
    return;
  }
  view.x -= event.deltaX;
  view.y -= event.deltaY;
  applyView();
}

function focusCard(ref, themeId) {
  for (const node of el.surface.querySelectorAll(".ccard--focus")) {
    node.classList.remove("ccard--focus");
  }
  focused = { ref, theme_id: themeId || null };
  cardNode(ref, focused.theme_id)?.classList.add("ccard--focus");
  showInspector();
}

function onKeyDown(event) {
  if (event.target.closest("input, textarea, select")) return;
  const step = event.shiftKey ? NUDGE_FINE : NUDGE;

  if (event.key === "0" && !event.metaKey && !event.ctrlKey) {
    fit();
    return;
  }
  if (!focused) return;
  const card = ctx.state.cards.find(
    (c) => c.ref === focused.ref && (c.theme_id || null) === focused.theme_id
  );
  if (!card) return;

  const shift = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[
    event.key
  ];
  if (shift) {
    event.preventDefault();
    const theme = focused.theme_id
      ? ctx.state.themes.find((t) => t.id === focused.theme_id)
      : null;
    const next = theme
      ? clampToArea(theme, card.x + shift[0], card.y + shift[1])
      : { x: card.x + shift[0], y: card.y + shift[1] };
    const node = cardNode(focused.ref, focused.theme_id);
    if (node) {
      node.style.left = `${next.x}px`;
      node.style.top = `${next.y}px`;
    }
    saveCard(focused.ref, focused.theme_id, next.x, next.y);
    return;
  }
  if (event.key === "Delete" || event.key === "Backspace") {
    event.preventDefault();
    const away = { ...focused };
    focused = null;
    send("/api/library/canvas/unplace", { ref: away.ref, theme_id: away.theme_id },
      "Could not put that away");
  }
}

/* --------------------------------------------------------------- clicks -- */

async function onSurfaceClick(event) {
  const act = event.target.closest("[data-act]")?.dataset.act;
  const card = event.target.closest(".ccard");
  const area = event.target.closest(".area");

  if (act === "play" && card) {
    const quote = ctx.state.byRef.get(card.dataset.ref);
    if (quote) ctx.startQueue([quote], quote.text.slice(0, 40));
    return;
  }
  if (!area) return;
  const theme = ctx.state.themes.find((t) => t.id === area.dataset.theme);
  if (!theme) return;

  if (act === "play-theme") {
    const quotes = theme.refs.map((ref) => ctx.state.byRef.get(ref)).filter(Boolean);
    if (quotes.length) ctx.startQueue(quotes, theme.title);
    else ctx.notify("That theme has no quotes in it yet.");
  } else if (act === "tidy") {
    await send("/api/library/canvas/tidy", { theme_id: theme.id }, "Could not tidy that area");
  } else if (act === "delete") {
    await deleteArea(theme);
  }
}

/**
 * Take an area away, and offer to put it back exactly as it was.
 *
 * An area holds a name, a note, and an arrangement -- which quote sits next to
 * which -- and that arrangement is the part that took the time. So the whole box
 * is copied down before it goes, and the undo rebuilds it in one call rather than
 * asking for the sorting again. The quotes themselves were never at risk: they
 * live in the recordings, and without an area to be in they go back to the tray.
 */
async function deleteArea(theme) {
  const snapshot = {
    title: theme.title,
    note: theme.note || "",
    color: theme.color,
    box: { x: theme.x, y: theme.y, w: theme.w, h: theme.h },
    cards: ctx.state.cards
      .filter((card) => card.theme_id === theme.id)
      .map((card) => ({ ref: card.ref, x: card.x, y: card.y })),
  };

  try {
    await api(`/api/library/themes/${theme.id}`, { method: "DELETE" });
  } catch (error) {
    ctx.notify(`Could not delete that area: ${error.message}`, { kind: "warn" });
    return;
  }
  ctx.state.themes = ctx.state.themes.filter((t) => t.id !== theme.id);
  ctx.state.cards = ctx.state.cards.filter((card) => card.theme_id !== theme.id);
  ctx.recount();
  renderCanvas();
  ctx.refreshBoard();

  const count = snapshot.cards.length;
  ctx.notify(
    count
      ? `Deleted “${snapshot.title}”. Its ${count} quote${count === 1 ? "" : "s"} are back in the tray.`
      : `Deleted “${snapshot.title}”.`,
    {
      action: {
        label: "Undo",
        onAct: () => send("/api/library/themes", snapshot, "Could not put that area back"),
      },
    }
  );
}

const saveField = debounce(async (themeId, patch) => {
  try {
    const { theme } = await api(`/api/library/themes/${themeId}`, { method: "PATCH", body: patch });
    Object.assign(ctx.state.themes.find((t) => t.id === theme.id) || {}, theme);
    ctx.refreshBoard();
  } catch (error) {
    ctx.notify(`Could not save that: ${error.message}`, { kind: "warn" });
  }
}, SAVE_AFTER);

function onSurfaceInput(event) {
  const act = event.target.dataset.act;
  const themeId = event.target.closest(".area")?.dataset.theme;
  if (!themeId || (act !== "rename" && act !== "note")) return;
  saveField(themeId, act === "rename" ? { title: event.target.value } : { note: event.target.value });
}

async function onInspectorAction(event) {
  const act = event.target.closest("[data-act]")?.dataset.act;
  if (!focused || !act) return;

  if (act === "remove") {
    const away = { ...focused };
    focused = null;
    await send("/api/library/canvas/unplace", { ref: away.ref, theme_id: away.theme_id },
      "Could not put that away");
  } else if (act === "duplicate") {
    // The keyboard route to what alt-dragging does: the same quote, a second
    // card, somewhere else. It lands loose, next to where it already is, so you
    // can see there are now two and drag the new one where it belongs.
    const card = ctx.state.cards.find(
      (c) => c.ref === focused.ref && (c.theme_id || null) === focused.theme_id
    );
    const theme = focused.theme_id
      ? ctx.state.themes.find((t) => t.id === focused.theme_id)
      : null;
    const { card_w } = metrics();
    const x = (theme ? theme.x + (card?.x || 0) : card?.x || 0) + card_w + 20;
    const y = theme ? theme.y + (card?.y || 0) : card?.y || 0;
    focused = { ref: focused.ref, theme_id: null };
    await send("/api/library/canvas/place", { ref: focused.ref, theme_id: null, x, y },
      "Could not place a second copy");
  }
}

async function onInspectorChange(event) {
  const select = event.target.closest('[data-act="reparent"]');
  if (!select || !focused) return;
  const target = select.value || null;
  if (target === focused.theme_id) return;

  const theme = target ? ctx.state.themes.find((t) => t.id === target) : null;
  const { area_pad, area_head, card_w } = metrics();
  const body = { ref: focused.ref, theme_id: target, moved_from: focused.theme_id };
  // Somewhere sensible: the server finds a free grid slot when nothing is said
  // about position, so nothing is said about position.
  if (theme) Object.assign(body, { x: area_pad, y: area_head });
  else {
    const from = ctx.state.themes.find((t) => t.id === focused.theme_id);
    Object.assign(body, { x: (from?.x || 0) + (from?.w || card_w) + 24, y: from?.y || 0 });
  }
  focused = { ref: focused.ref, theme_id: target };
  await send("/api/library/canvas/place", body, "Could not move that quote");
}

/**
 * Put a quote on the canvas without dragging it there.
 *
 * It lands loose in the middle of the view rather than in a theme, because
 * which theme is the decision being made and it should not be made by
 * whichever area happens to be under the centre of the screen. From there the
 * inspector's select files it.
 */
async function placeFromTray(ref) {
  const { card_w, card_h } = metrics();
  const rect = el.viewport.getBoundingClientRect();
  const middle = toCanvas(rect.left + rect.width / 2, rect.top + rect.height / 2);
  focused = { ref, theme_id: null };
  await send(
    "/api/library/canvas/place",
    { ref, theme_id: null, x: middle.x - card_w / 2, y: middle.y - card_h / 2 },
    "Could not put that on the canvas"
  );
  cardNode(ref, null)?.focus();
}

/* ---------------------------------------------------------------- setup -- */

export function initCanvas(context) {
  ctx = context;
  Object.assign(el, {
    view: $("view-canvas"),
    viewport: $("canvas-viewport"),
    surface: $("canvas-surface"),
    blank: $("canvas-blank"),
    zoomLevel: $("canvas-zoom"),
    progress: $("canvas-progress"),
    addArea: $("canvas-add-area"),
    fit: $("canvas-fit"),
    tray: $("tray"),
    trayBody: $("tray-body"),
    traySearch: $("tray-search"),
    trayFilter: $("tray-filter"),
    trayCount: $("tray-count"),
    trayToggle: $("tray-toggle"),
    inspector: $("inspector"),
  });
  bindPointers();

  // Whether the view was remembered has to be read before the first save of it.
  const remembered = recall(VIEW_KEY) !== null;
  restoreView();
  applyView();
  framed = remembered;
  el.tray.hidden = recall(TRAY_KEY, "open") === "shut";
  el.trayToggle.setAttribute("aria-expanded", String(!el.tray.hidden));

  el.viewport.addEventListener("wheel", onWheel, { passive: false });
  el.viewport.addEventListener("click", onSurfaceClick);
  el.viewport.addEventListener("input", onSurfaceInput);
  el.view.addEventListener("keydown", onKeyDown);
  el.surface.addEventListener("focusin", (event) => {
    const card = event.target.closest(".ccard");
    if (card) focusCard(card.dataset.ref, card.dataset.theme || null);
  });
  el.inspector.addEventListener("click", onInspectorAction);
  el.inspector.addEventListener("change", onInspectorChange);

  // Getting a quote out of the tray without a pointer. Without this the
  // keyboard could rearrange the canvas but never add to it, which would make
  // the inspector below a tour of somebody else's sorting.
  el.trayBody.addEventListener("keydown", (event) => {
    const item = event.target.closest(".tray__item");
    if (!item || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    placeFromTray(item.dataset.ref);
  });

  el.traySearch.addEventListener("input", debounce(renderTray, 120));
  el.trayFilter.addEventListener("change", renderTray);
  el.trayToggle.addEventListener("click", () => {
    el.tray.hidden = !el.tray.hidden;
    el.trayToggle.setAttribute("aria-expanded", String(!el.tray.hidden));
    remember(TRAY_KEY, el.tray.hidden ? "shut" : "open");
  });

  el.fit.addEventListener("click", fit);
  for (const button of el.view.querySelectorAll("[data-zoom]")) {
    button.addEventListener("click", () => {
      const rect = el.viewport.getBoundingClientRect();
      zoomAt(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
        button.dataset.zoom === "in" ? ZOOM_STEP : 1 / ZOOM_STEP
      );
    });
  }

  // A new area lands in the middle of what you are looking at, not at the
  // origin: the reason to add one is usually the quotes already on screen.
  el.addArea.addEventListener("click", async () => {
    const { area_w, area_h } = metrics();
    const rect = el.viewport.getBoundingClientRect();
    const middle = toCanvas(rect.left + rect.width / 2, rect.top + rect.height / 2);
    try {
      const { theme } = await api("/api/library/themes", {
        method: "POST",
        body: { title: "", box: { x: middle.x - area_w / 2, y: middle.y - area_h / 2 } },
      });
      ctx.state.themes.push(theme);
      renderCanvas();
      ctx.refreshBoard();
      const input = el.surface.querySelector(`.area[data-theme="${CSS.escape(theme.id)}"] .area__title`);
      input?.focus();
      input?.select();
    } catch (error) {
      ctx.notify(`Could not add an area: ${error.message}`, { kind: "warn" });
    }
  });
}

/**
 * Called when the canvas becomes visible.
 *
 * Framing has to happen here rather than at load, because it measures the
 * viewport and a hidden element has no size. Once only: after that the view is
 * where the user left it, and moving it out from under them would be worse than
 * a bad first frame.
 */
export function showCanvas() {
  renderCanvas();
  if (!framed) {
    fit();
    framed = true;
  }
}
