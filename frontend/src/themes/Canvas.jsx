/* Themes as a plane instead of a row of columns.
 *
 * The board ran out of screen. Columns only work while they all fit, and past
 * about six themes the useful ones are off the right-hand edge -- which is the
 * point at which the interface starts deciding what you think about. A plane has
 * no such edge: it pans, it zooms, and a theme that matters can be put in the
 * middle where you keep looking.
 *
 * Three ideas hold the whole thing up:
 *
 *   A card is not a quote. It is one appearance of a quote, at one position, so
 *   the same quote can be pinned inside two areas at once -- two cards, one
 *   quote. Photocopying a post-it, which is what you would do with the paper.
 *
 *   A card in an area is rendered as a child of that area, positioned relative
 *   to it. That is what makes "themes bring their quotes with them" free rather
 *   than bookkeeping: dragging an area changes two numbers and every card in it
 *   moves, and no card can be left behind by a bug in the moving code.
 *
 *   Every drag is the same drag -- see useCanvasDrag.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, debounce, formatTime, recall, remember } from "../lib/util.js";
import {
  EMPTY_FILTERS,
  SORTS,
  anyFilter,
  areaAt,
  areaBox,
  clampToArea,
  drawnHeight,
  laidOut,
  matches,
} from "./canvasGeometry.js";
import { useCanvasView, ZOOM_STEP } from "./useCanvasView.js";
import { useCanvasDrag } from "./useCanvasDrag.js";
import { useAreaChrome } from "./useAreaChrome.js";
import SyncedField from "./SyncedField.jsx";

const TRAY_KEY = "subtitle-search:canvas-tray";
const GRID_KEY = "subtitle-search:canvas-grid";
const NUDGE = 12;
const NUDGE_FINE = 2;
const SAVE_AFTER = 400;

export default function Canvas({ lib, wantedTag, onPlayTheme, active }) {
  const { quotes, themes, cards, metrics, byRef, recordings, onCanvas, send, adopt, notify } = lib;

  const viewport = useRef(null);
  const surface = useRef(null);
  const tray = useRef(null);
  const zoomLabel = useRef(null);
  const trayBody = useRef(null);
  const framed = useRef(false);

  const [trayOpen, setTrayOpen] = useState(() => recall(TRAY_KEY, "open") !== "shut");
  const [gridView, setGridView] = useState(() => recall(GRID_KEY) === "on");
  const [focused, setFocused] = useState(null);
  const [filters, setFilters] = useState(() =>
    wantedTag ? { ...EMPTY_FILTERS, tag: `tag:${wantedTag}` } : EMPTY_FILTERS
  );

  useEffect(() => remember(TRAY_KEY, trayOpen ? "open" : "shut"), [trayOpen]);
  useEffect(() => remember(GRID_KEY, gridView ? "on" : "off"), [gridView]);

  /* ------------------------------------------------------------- geometry -- */

  const cardsByTheme = useMemo(() => {
    const map = new Map(themes.map((t) => [t.id, []]));
    const loose = [];
    for (const card of cards) {
      if (card.theme_id && map.has(card.theme_id)) map.get(card.theme_id).push(card);
      else if (!card.theme_id) loose.push(card);
    }
    return { map, loose };
  }, [themes, cards]);

  // Everything the geometry and the drag machine need, in one object read
  // through a ref so neither has to re-subscribe when a card moves.
  const geoState = useMemo(
    () => ({ metrics, byRef, themes, cards, gridView }),
    [metrics, byRef, themes, cards, gridView]
  );

  const helpers = useMemo(
    () => ({
      ...geoState,
      areaBox: (theme) => areaBox(geoState, surface.current, theme),
      areaAt: (point) => areaAt(geoState, surface.current, point),
      clampToArea: (theme, x, y) => clampToArea(metrics, theme, x, y),
    }),
    [geoState, metrics]
  );

  const { fitChrome } = useAreaChrome(surface);

  const { view, apply, toCanvas, zoomAt, fit } = useCanvasView({
    viewport,
    surface,
    zoomLabel,
    onApply: fitChrome,
  });

  const frameEverything = useCallback(() => {
    const { card_w, card_h } = metrics;
    fit([
      ...themes.map((t) => helpers.areaBox(t)).map((t) => [t.x, t.y, t.w, t.h]),
      ...cards.filter((c) => !c.theme_id).map((c) => [c.x, c.y, card_w, card_h]),
    ]);
  }, [metrics, themes, cards, helpers, fit]);

  // Framing the work is done on the way in, once.
  useEffect(() => {
    if (!active || framed.current || !metrics) return;
    framed.current = true;
    requestAnimationFrame(frameEverything);
  }, [active, metrics, frameEverything]);

  // The chrome has to re-measure whenever the areas themselves change.
  useEffect(() => {
    fitChrome();
  }, [themes, cards, gridView, fitChrome]);

  /* ---------------------------------------------------------------- saves -- */

  const pendingMoves = useRef(new Map());
  const pendingShapes = useRef(new Map());

  const flushMoves = useRef(
    debounce(async () => {
      const moves = [...pendingMoves.current.values()];
      pendingMoves.current.clear();
      if (moves.length) await send("/api/library/canvas/positions", { moves }, "Could not save that move");
    }, SAVE_AFTER)
  ).current;

  const flushShapes = useRef(
    debounce(async () => {
      const shapes = [...pendingShapes.current.values()];
      pendingShapes.current.clear();
      for (const shape of shapes) {
        await api("/api/library/canvas/reshape", { method: "POST", body: shape }).catch(() => {});
      }
    }, SAVE_AFTER)
  ).current;

  const saveArea = useCallback(
    (theme, { pullCardsIn = false } = {}) => {
      // Pull anything the smaller box no longer covers back inside, so a card
      // cannot end up hidden behind the edge of its own theme.
      if (pullCardsIn) {
        for (const card of cards.filter((c) => c.theme_id === theme.id)) {
          const spot = clampToArea(metrics, theme, card.x, card.y);
          if (spot.x !== card.x || spot.y !== card.y) {
            pendingMoves.current.set(`${card.ref}:${theme.id}`, {
              ref: card.ref,
              theme_id: theme.id,
              ...spot,
            });
          }
        }
        flushMoves();
      }
      pendingShapes.current.set(theme.id, {
        theme_id: theme.id,
        x: theme.x,
        y: theme.y,
        w: theme.w,
        h: theme.h,
      });
      lib.setThemes((all) => all.map((t) => (t.id === theme.id ? { ...t, ...theme } : t)));
      flushShapes();
    },
    [cards, metrics, flushMoves, flushShapes, lib]
  );

  const placeCard = useCallback(
    (body) => send("/api/library/canvas/place", body, "Could not move that quote"),
    [send]
  );
  const unplaceCard = useCallback(
    (ref, themeId) =>
      send("/api/library/canvas/unplace", { ref, theme_id: themeId }, "Could not put that away"),
    [send]
  );

  useCanvasDrag({
    viewport,
    surface,
    tray,
    view,
    apply,
    toCanvas,
    state: helpers,
    onPlaceCard: placeCard,
    onUnplaceCard: unplaceCard,
    onSaveArea: saveArea,
    onFocusCard: setFocused,
  });

  /* ----------------------------------------------------------- the wheel -- */

  useEffect(() => {
    const port = viewport.current;
    if (!port) return;
    const onWheel = (event) => {
      event.preventDefault();
      // Pinch on a trackpad arrives as ctrl+wheel, which is also how a mouse
      // asks to zoom. Everything else pans the plane rather than the page.
      if (event.ctrlKey || event.metaKey) {
        zoomAt(event.clientX, event.clientY, event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
        return;
      }
      view.current.x -= event.deltaX;
      view.current.y -= event.deltaY;
      apply();
    };
    port.addEventListener("wheel", onWheel, { passive: false });
    return () => port.removeEventListener("wheel", onWheel);
  }, [zoomAt, view, apply]);

  /* -------------------------------------------------------------- the tray -- */

  const trayQuotes = useMemo(() => {
    const kept = quotes.filter((q) => !onCanvas.has(q.ref) && matches(q, filters));
    const order = SORTS[filters.sort];
    return order ? [...kept].sort(order) : kept;
  }, [quotes, onCanvas, filters]);

  // Counted over the whole corpus rather than the tray, so a number next to a
  // tag means the same thing whatever else is selected.
  const options = useMemo(() => {
    const tags = new Map();
    const speakers = new Map();
    for (const quote of quotes) {
      for (const tag of quote.tags || []) tags.set(tag, (tags.get(tag) || 0) + 1);
      const who = quote.speaker || "";
      if (who) speakers.set(who, (speakers.get(who) || 0) + 1);
    }
    const bySize = (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]);
    return {
      tags: [...tags.entries()].sort(bySize),
      speakers: [...speakers.entries()].sort(bySize),
      colors: [...new Set(quotes.map((q) => q.color || "amber"))].sort(),
    };
  }, [quotes]);

  const filtering = anyFilter(filters);
  const waiting = quotes.length - onCanvas.size;
  const setFilter = (key, value) => setFilters((all) => ({ ...all, [key]: value }));

  /* --------------------------------------------------------------- areas -- */

  const addArea = async () => {
    // In the middle of what you are looking at, because that is where you are.
    const rect = viewport.current.getBoundingClientRect();
    const middle = toCanvas(rect.left + rect.width / 2, rect.top + rect.height / 2);
    try {
      const payload = await api("/api/library/themes", {
        method: "POST",
        body: {
          title: "",
          box: {
            x: Math.round(middle.x - metrics.area_w / 2),
            y: Math.round(middle.y - metrics.area_h / 2),
            w: metrics.area_w,
            h: metrics.area_h,
          },
        },
      });
      adopt(payload);
      requestAnimationFrame(() => {
        const field = surface.current?.querySelector(
          `.area[data-theme="${CSS.escape(payload.theme.id)}"] .area__title`
        );
        field?.focus();
      });
    } catch (error) {
      notify(`Could not make an area: ${error.message}`, { kind: "warn" });
    }
  };

  const patchTheme = async (themeId, patch) => {
    try {
      const { theme } = await api(`/api/library/themes/${themeId}`, {
        method: "PATCH",
        body: patch,
      });
      lib.setThemes((all) => all.map((t) => (t.id === theme.id ? theme : t)));
    } catch (error) {
      notify(`Could not save that theme: ${error.message}`, { kind: "warn" });
    }
  };

  const deleteArea = async (theme) => {
    const snapshot = {
      title: theme.title,
      note: theme.note,
      color: theme.color,
      box: { x: theme.x, y: theme.y, w: theme.w, h: theme.h },
      cards: (cardsByTheme.map.get(theme.id) || []).map((c) => ({
        ref: c.ref,
        x: c.x,
        y: c.y,
      })),
    };
    try {
      await api(`/api/library/themes/${theme.id}`, { method: "DELETE" });
      lib.setThemes((all) => all.filter((t) => t.id !== theme.id));
      // The quotes were never at risk -- they live in the recordings, and
      // without an area they simply return to the tray. What the undo restores
      // is the box, the note and the arrangement inside it.
      notify(`Deleted "${theme.title || "Untitled"}".`, {
        action: {
          label: "Undo",
          onAct: async () => {
            const payload = await api("/api/library/themes", {
              method: "POST",
              body: snapshot,
            }).catch(() => null);
            if (payload) adopt(payload);
          },
        },
      });
    } catch (error) {
      notify(`Could not delete that area: ${error.message}`, { kind: "warn" });
    }
  };

  const nudgeFocused = useCallback(
    (dx, dy) => {
      if (!focused) return;
      const card = cards.find(
        (c) => c.ref === focused.ref && (c.theme_id || null) === (focused.theme_id || null)
      );
      if (!card) return;
      const theme = themes.find((t) => t.id === card.theme_id);
      const next = theme
        ? clampToArea(metrics, theme, card.x + dx, card.y + dy)
        : { x: card.x + dx, y: card.y + dy };
      pendingMoves.current.set(`${card.ref}:${card.theme_id || ""}`, {
        ref: card.ref,
        theme_id: card.theme_id,
        ...next,
      });
      flushMoves();
      // Shown immediately; the server confirms a moment later.
      const node = surface.current?.querySelector(
        `.ccard[data-ref="${CSS.escape(card.ref)}"][data-theme="${CSS.escape(card.theme_id || "")}"]`
      );
      if (node) {
        node.style.left = `${next.x}px`;
        node.style.top = `${next.y}px`;
      }
    },
    [focused, cards, themes, metrics, flushMoves]
  );

  /* ------------------------------------------------------------ keyboard -- */

  useEffect(() => {
    if (!active) return;
    const onKey = (event) => {
      if (["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) return;
      if (event.key === "0") {
        event.preventDefault();
        frameEverything();
        return;
      }
      if (!focused) return;
      const step = event.shiftKey ? NUDGE_FINE : NUDGE;
      const moves = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      if (moves[event.key]) {
        event.preventDefault();
        nudgeFocused(...moves[event.key]);
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        unplaceCard(focused.ref, focused.theme_id);
        setFocused(null);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, focused, frameEverything, nudgeFocused, unplaceCard]);

  if (!metrics) return null;

  const surfaceStyle = {
    "--card-w": `${metrics.card_w}px`,
    "--card-h": `${metrics.card_h}px`,
  };

  return (
    <main className="canvas">
      <div className="canvas__toolbar">
        <button className="btn" type="button" onClick={addArea}>
          + New area
        </button>
        <span className="zoomer">
          <button
            className="btn btn--icon"
            type="button"
            aria-label="Zoom out"
            onClick={() => {
              const r = viewport.current.getBoundingClientRect();
              zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1 / ZOOM_STEP);
            }}
          >
            −
          </button>
          <span className="zoomer__level" ref={zoomLabel}>100%</span>
          <button
            className="btn btn--icon"
            type="button"
            aria-label="Zoom in"
            onClick={() => {
              const r = viewport.current.getBoundingClientRect();
              zoomAt(r.left + r.width / 2, r.top + r.height / 2, ZOOM_STEP);
            }}
          >
            +
          </button>
          <button
            className="btn"
            type="button"
            title="Frame everything (0)"
            onClick={frameEverything}
          >
            Fit
          </button>
        </span>
        {/* Grid packs every area's cards into rows and writes nothing. Free
            placement is the point of the plane, and it is also how an area ends
            up unreadable; this is how to read it without giving up the
            arrangement that made it unreadable. */}
        <button
          className="btn"
          type="button"
          aria-pressed={gridView}
          title="Pack every area by speaker, then time, without moving anything"
          onClick={() => setGridView((v) => !v)}
        >
          Grid
        </button>
        <button
          className="btn"
          type="button"
          title="Roll every area up to its title"
          onClick={async () => {
            for (const theme of themes) {
              if (!theme.collapsed) await patchTheme(theme.id, { collapsed: true });
            }
          }}
        >
          Roll up all
        </button>
        <span className="board__hint">
          {quotes.length
            ? `${lib.placed.size} of ${quotes.length} in a theme` +
              (onCanvas.size - lib.placed.size > 0
                ? ` · ${onCanvas.size - lib.placed.size} loose`
                : "")
            : "no quotes saved yet"}
        </span>
        <button
          className="btn"
          type="button"
          aria-expanded={trayOpen}
          onClick={() => setTrayOpen((v) => !v)}
        >
          Quotes <span className="count">{trayQuotes.length}</span>
        </button>
      </div>

      <div className="canvas__body">
        <aside className="tray" ref={tray} hidden={!trayOpen}>
          <header className="tray__head">
          <input
            className="tray__search"
            type="search"
            placeholder="Search these quotes"
            aria-label="Search the text of the quotes not yet on the canvas"
            value={filters.text}
            onChange={(event) => setFilter("text", event.target.value.trim().toLowerCase())}
          />
          <div className="tray__filters">
            <label className="tray__filter">
              <span>Tag</span>
              <select
                aria-label="Filter by tag"
                value={filters.tag}
                onChange={(event) => setFilter("tag", event.target.value)}
              >
                <option value="">any tag</option>
                <option value="state:any">tagged with anything</option>
                <option value="state:none">not tagged at all</option>
                {options.tags.map(([tag, count]) => (
                  <option key={tag} value={`tag:${tag}`}>
                    {tag} ({count})
                  </option>
                ))}
              </select>
            </label>
            <label className="tray__filter">
              <span>Said by</span>
              <select
                aria-label="Filter by speaker"
                value={filters.speaker}
                onChange={(event) => setFilter("speaker", event.target.value)}
              >
                <option value="">anyone</option>
                {options.speakers.map(([who, count]) => (
                  <option key={who} value={who}>
                    {who} ({count})
                  </option>
                ))}
              </select>
            </label>
            <label className="tray__filter">
              <span>From</span>
              <select
                aria-label="Filter by recording"
                value={filters.recording}
                onChange={(event) => setFilter("recording", event.target.value)}
              >
                <option value="">every recording</option>
                {[...recordings.values()].map((rec) => (
                  <option key={rec.id} value={rec.id}>
                    {rec.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="tray__filter">
              <span>Colour</span>
              <select
                aria-label="Filter by highlight colour"
                value={filters.color}
                onChange={(event) => setFilter("color", event.target.value)}
              >
                <option value="">any colour</option>
                {options.colors.map((color) => (
                  <option key={color} value={color}>
                    {color}
                  </option>
                ))}
              </select>
            </label>
            <label className="tray__filter">
              <span>Note</span>
              <select
                aria-label="Filter by whether the quote has a note"
                value={filters.note}
                onChange={(event) => setFilter("note", event.target.value)}
              >
                <option value="">either</option>
                <option value="yes">has a note</option>
                <option value="no">no note</option>
              </select>
            </label>
            <label className="tray__filter">
              <span>Sort</span>
              <select
                aria-label="How to order the list"
                value={filters.sort}
                onChange={(event) => setFilter("sort", event.target.value)}
              >
                <option value="recording">by recording</option>
                <option value="longest">longest first</option>
                <option value="shortest">shortest first</option>
                <option value="tags">most tags first</option>
              </select>
            </label>
          </div>

          <p className="tray__state">
            <span>
              {filtering ? `${trayQuotes.length} of ${waiting} waiting` : `${waiting} waiting`}
            </span>
            {filtering && (
              <button className="btn btn--bare" type="button" onClick={() => setFilters(EMPTY_FILTERS)}>
                Clear
              </button>
            )}
          </p>
          </header>

          <div className="tray__body" ref={trayBody}>
            {trayQuotes.length ? (
              trayQuotes.map((quote) => (
                <TrayItem key={quote.ref} quote={quote} onPlace={placeCard} metrics={metrics} />
              ))
            ) : (
              <p className="empty">
                {filtering
                  ? "Nothing waiting matches that. Clear the filters to see the rest."
                  : "Everything is out on the canvas."}
              </p>
            )}
          </div>

          <footer className="tray__foot">
            <Inspector
              focused={focused}
              byRef={byRef}
              themes={themes}
              onMove={(themeId) => {
                placeCard({
                  ref: focused.ref,
                  theme_id: themeId,
                  moved_from: focused.theme_id,
                });
                setFocused({ ref: focused.ref, theme_id: themeId });
              }}
            />
          </footer>
        </aside>

        <div
          className="canvas__viewport"
          ref={viewport}
          tabIndex={0}
          aria-label="Theme canvas. Drag to pan, ctrl and scroll to zoom."
        >
          <div
            className={`canvas__surface${filtering ? " canvas__surface--filtering" : ""}`}
            ref={surface}
            style={surfaceStyle}
          >
            {themes.map((theme) => (
              <Area
                key={theme.id}
                theme={theme}
                cards={cardsByTheme.map.get(theme.id) || []}
                state={geoState}
                byRef={byRef}
                recordings={recordings}
                filters={filters}
                filtering={filtering}
                focused={focused}
                onPatch={patchTheme}
                onDelete={deleteArea}
                onPlay={onPlayTheme}
                onTidy={(id) => send("/api/library/canvas/tidy", { theme_id: id }, "Could not tidy that area")}
                onPlayQuote={lib.onPlayQuote}
              />
            ))}
            {cardsByTheme.loose.map((card) => {
              const quote = byRef.get(card.ref);
              return quote ? (
                <CanvasCard
                  key={`${card.ref}:`}
                  quote={quote}
                  card={card}
                  recordings={recordings}
                  matched={filtering && matches(quote, filters)}
                  focused={
                    focused?.ref === card.ref && !focused.theme_id
                  }
                />
              ) : null;
            })}
          </div>

          {!themes.length && !cards.length && (
            <p className="canvas__blank">
              Nothing on the plane yet. Make an <strong>area</strong> for a theme, then drag
              quotes out of the tray into it — or drop one on bare canvas to park it while you
              decide.
              <br />
              <span className="canvas__keys">
                drag the background to pan · ctrl-scroll or ⌘-scroll to zoom · 0 to frame
                everything
              </span>
            </p>
          )}
        </div>
      </div>
    </main>
  );
}

/**
 * An area: a boundary drawn on the surface, with its title bar on top.
 *
 * The chrome is one element rather than a header and a note side by side,
 * because it has to be counter-scaled as a unit -- one transform, and one opaque
 * background so that when zooming out makes the bar taller in canvas units than
 * the room reserved for it, it reads as a title bar over the cards rather than
 * as something broken.
 *
 * Rolled up, the area gets no height at all and CSS sizes it to that bar. A
 * quote can still be dropped on it: the theme is closed, not shut.
 */
function Area({
  theme,
  cards,
  state,
  byRef,
  recordings,
  filters,
  filtering,
  focused,
  onPatch,
  onDelete,
  onPlay,
  onTidy,
  onPlayQuote,
}) {
  const spread = new Set(cards.map((c) => byRef.get(c.ref)?.recording_id).filter(Boolean));
  const height = drawnHeight(state, theme);
  const shown = theme.collapsed ? [] : laidOut(state, theme, cards);

  return (
    <section
      className={`area${theme.collapsed ? " area--collapsed" : ""}`}
      data-theme={theme.id}
      style={{
        left: theme.x,
        top: theme.y,
        width: theme.w,
        ...(height === null ? {} : { height }),
      }}
    >
      <div className="area__chrome" data-handle="move">
        <span className="area__grab" title="Drag to move this theme" />
        <header className="area__head">
          <button
            className="icon-btn area__roll"
            type="button"
            aria-expanded={!theme.collapsed}
            title={theme.collapsed ? "Open this theme" : "Roll this theme up to its title"}
            onClick={() => onPatch(theme.id, { collapsed: !theme.collapsed })}
          >
            {theme.collapsed ? "▸" : "▾"}
          </button>
          <SyncedField
            as="textarea"
            className="area__title"
            rows="1"
            wrap="soft"
            spellCheck="false"
            aria-label="Theme name"
            value={theme.title}
            onCommit={(title) => onPatch(theme.id, { title })}
          />
          <span className="area__count" title="quotes in this theme">
            {cards.length}
          </span>
          <span className="area__tools">
            <button
              className="icon-btn"
              type="button"
              title="Play every quote in this theme"
              onClick={() => onPlay(theme)}
            >
              ▶
            </button>
            <button
              className="icon-btn"
              type="button"
              title="Tidy: pack these by speaker, then time, for good"
              onClick={() => onTidy(theme.id)}
            >
              ⊞
            </button>
            <button
              className="icon-btn"
              type="button"
              title="Delete this area"
              onClick={() => onDelete(theme)}
            >
              ✕
            </button>
          </span>
        </header>
        <div className="area__sub">
          <SyncedField
            className="area__note"
            value={theme.note || ""}
            placeholder="What is this theme?"
            aria-label="What this theme is"
            onCommit={(note) => onPatch(theme.id, { note })}
          />
          <span className="area__spread">
            {spread.size}/{recordings.size} rec
          </span>
        </div>
      </div>

      {shown.map((card) => {
        const quote = byRef.get(card.ref);
        return quote ? (
          <CanvasCard
            key={`${card.ref}:${theme.id}`}
            quote={quote}
            card={card}
            recordings={recordings}
            matched={filtering && matches(quote, filters)}
            focused={focused?.ref === card.ref && focused.theme_id === theme.id}
            onPlay={onPlayQuote}
          />
        ) : null;
      })}

      {!theme.collapsed && !cards.length && <p className="area__empty">Drag quotes in here.</p>}
      {!theme.collapsed && <span className="area__grip" data-handle="resize" title="Resize" />}
    </section>
  );
}

function CanvasCard({ quote, card, recordings, matched, focused, onPlay }) {
  const recording = recordings.get(quote.recording_id);
  const tags = (quote.tags || []).join(", ");
  return (
    <article
      className={`ccard qcard--${quote.color || "amber"}${matched ? " ccard--match" : ""}${
        focused ? " ccard--focus" : ""
      }`}
      data-ref={quote.ref}
      data-theme={card.theme_id || ""}
      style={{ left: card.x, top: card.y }}
      tabIndex={0}
      role="group"
      aria-label={quote.text.slice(0, 90)}
    >
      <p className="ccard__text">{quote.text}</p>
      <footer className="ccard__foot">
        <span className="ccard__who">
          {quote.speaker || recording?.title || quote.recording_id}
        </span>
        <time>{formatTime(quote.start_time)}</time>
        <button
          className="icon-btn"
          type="button"
          title="Play this quote"
          onClick={() => onPlay?.(quote)}
        >
          ▶
        </button>
        <ReaderLink quote={quote} />
      </footer>
      {tags && (
        <p className="ccard__tags" title={tags}>
          {tags}
        </p>
      )}
    </article>
  );
}

/**
 * The way back to where a quote was said.
 *
 * A new tab, always. Following it in place would throw away the canvas -- the
 * pan, the zoom, what was selected, a filter halfway through being narrowed --
 * to answer a question that is usually "wait, what came before this?". The point
 * of checking the context is to come back with it.
 */
function ReaderLink({ quote }) {
  return (
    <a
      className="icon-btn"
      target="_blank"
      rel="noopener"
      href={`/reader?recording=${encodeURIComponent(quote.recording_id)}&t=${quote.start_time}`}
      title="Open where it was said, in a new tab"
    >
      ↗
    </a>
  );
}

/** Quotes not out on the plane yet, shown whole rather than cut off. */
function TrayItem({ quote, onPlace, metrics }) {
  return (
    <article
      className={`tray__item qcard--${quote.color || "amber"}`}
      data-ref={quote.ref}
      tabIndex={0}
      title="Drag onto the canvas, or press enter"
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        onPlace({ ref: quote.ref, theme_id: null, x: 40, y: 40 });
      }}
    >
      <p className="tray__text">{quote.text}</p>
      <p className="tray__meta">
        <span className="tray__who">{quote.speaker || quote.recording_title || ""}</span>
        <time>{formatTime(quote.start_time)}</time>
        <ReaderLink quote={quote} />
      </p>
      {Boolean((quote.tags || []).length) && (
        <p className="tray__tags">{(quote.tags || []).join(" · ")}</p>
      )}
    </article>
  );
}

/**
 * What the keyboard is holding, and what can be done to it without a mouse.
 *
 * Dragging is the fast way to arrange a plane and it cannot be the only way. The
 * select here is the same move as a drag between two areas; the arrow keys are
 * the same move as a drag within one.
 */
function Inspector({ focused, byRef, themes, onMove }) {
  if (!focused) {
    return <p className="inspector__hint">Click or tab to a card to move it with the keyboard.</p>;
  }
  const quote = byRef.get(focused.ref);
  if (!quote) return null;
  return (
    <>
      <p className="inspector__text">{quote.text}</p>
      <div className="inspector__row">
        <label>
          <span>Also place in…</span>
          <select
            value={focused.theme_id || ""}
            onChange={(event) => onMove(event.target.value || null)}
          >
            <option value="">Loose on the plane</option>
            {themes.map((theme) => (
              <option key={theme.id} value={theme.id}>
                {theme.title || "Untitled"}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="inspector__hint">arrows nudge · shift for fine · delete puts it away</p>
    </>
  );
}
