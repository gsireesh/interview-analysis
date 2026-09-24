/* The same themes as columns, which is the right shape until there are more
 * themes than fit across the screen.
 *
 * The board's move is one theme at a time: choosing a theme here takes the quote
 * out of the others. The canvas is where a quote goes into two themes at once,
 * because there you can see that it did.
 */

import { useMemo, useRef, useState } from "react";
import { api } from "../lib/util.js";
import QuoteCard from "./QuoteCard.jsx";
import SyncedField from "./SyncedField.jsx";

export default function Board({ lib, onPlayTheme, onPlayQuote }) {
  const { quotes, themes, byRef, recordings, placed, send, adopt, notify } = lib;
  const [filter, setFilter] = useState("all");
  const dragging = useRef(null);
  const [over, setOver] = useState(null);

  const visible = useMemo(
    () =>
      quotes.filter((quote) => {
        if (filter === "unplaced") return !placed.has(quote.ref);
        if (filter === "tagged") return (quote.tags || []).length > 0;
        if (filter === "untagged") return (quote.tags || []).length === 0;
        return true;
      }),
    [quotes, filter, placed]
  );

  // Built from the themes outwards rather than from the quotes, because a quote
  // pinned in two areas on the canvas is genuinely in two columns here, and
  // asking each quote for "its" theme could only ever return one of them.
  const shown = useMemo(() => new Set(visible.map((q) => q.ref)), [visible]);
  const inTheme = useMemo(
    () =>
      new Map(
        themes.map((theme) => [
          theme.id,
          theme.refs.filter((ref) => shown.has(ref)).map((ref) => byRef.get(ref)).filter(Boolean),
        ])
      ),
    [themes, shown, byRef]
  );
  const unsorted = visible.filter((quote) => !placed.has(quote.ref));

  const moveCard = async (ref, from, to) => {
    if (to === from) return;
    if (to) await send("/api/library/canvas/place", { ref, theme_id: to, moved_from: from }, "Could not move that quote");
    else await send("/api/library/canvas/unplace", { ref, theme_id: from }, "Could not unsort that quote");
  };

  const addTheme = async () => {
    try {
      const { theme, ...rest } = await api("/api/library/themes", {
        method: "POST",
        body: { title: "" },
      });
      adopt(rest);
      requestAnimationFrame(() => {
        const input = document.querySelector(
          `[data-theme-id="${theme.id}"] .column__title-input`
        );
        input?.focus();
        input?.select();
      });
    } catch (error) {
      notify(`Could not add a theme: ${error.message}`, { kind: "warn" });
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

  const dropZone = (themeId) => ({
    onDragOver: (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setOver(themeId);
    },
    onDragLeave: () => setOver((current) => (current === themeId ? null : current)),
    onDrop: async (event) => {
      event.preventDefault();
      setOver(null);
      const card = dragging.current || {
        ref: event.dataTransfer.getData("text/plain"),
        from: null,
      };
      if (card.ref) await moveCard(card.ref, card.from, themeId);
    },
  });

  return (
    <main className="board">
      <div className="board__bar">
        <button className="btn" type="button" onClick={addTheme}>
          + New theme
        </button>
        <label className="board__filter">
          <span>Show</span>
          <select value={filter} onChange={(event) => setFilter(event.target.value)}>
            <option value="all">every quote</option>
            <option value="unplaced">only unsorted</option>
            <option value="tagged">only tagged</option>
            <option value="untagged">only untagged</option>
          </select>
        </label>
        <span className="board__hint">
          {quotes.length ? `${placed.size} of ${quotes.length} quotes placed` : "no quotes saved yet"}
        </span>
      </div>

      <div className="board__columns">
        <section className="column column--unsorted" data-theme-id="">
          <header className="column__head">
            <h2 className="column__title">Unsorted</h2>
            <span className="column__count">{unsorted.length}</span>
          </header>
          <div
            className={`column__body${over === null && dragging.current ? "" : ""}`}
            {...dropZone(null)}
          >
            {unsorted.length ? (
              unsorted.map((quote) => (
                <QuoteCard
                  key={quote.ref}
                  quote={quote}
                  recordings={recordings}
                  themes={themes}
                  column={null}
                  onPlay={onPlayQuote}
                  onMove={moveCard}
                  onDragStart={(event) => {
                    dragging.current = { ref: quote.ref, from: null };
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", quote.ref);
                  }}
                  onDragEnd={() => {
                    dragging.current = null;
                    setOver(null);
                  }}
                />
              ))
            ) : (
              <p className="empty">Nothing left here.</p>
            )}
          </div>
        </section>

        {themes.map((theme) => {
          const quotesHere = inTheme.get(theme.id) || [];
          const spread = new Set(quotesHere.map((q) => q.recording_id));
          return (
            <section className="column" data-theme-id={theme.id} key={theme.id}>
              <header className="column__head">
                <SyncedField
                  className="column__title-input"
                  value={theme.title}
                  aria-label="Theme name"
                  onCommit={(title) => patchTheme(theme.id, { title })}
                />
                <span className="column__count">{quotesHere.length}</span>
                <button
                  className="icon-btn"
                  type="button"
                  title="Play every quote in this theme"
                  onClick={() => onPlayTheme(theme)}
                >
                  ▶
                </button>
                <button
                  className="icon-btn"
                  type="button"
                  title="Delete theme"
                  onClick={async () => {
                    try {
                      await api(`/api/library/themes/${theme.id}`, { method: "DELETE" });
                      lib.setThemes((all) => all.filter((t) => t.id !== theme.id));
                    } catch (error) {
                      notify(`Could not delete that theme: ${error.message}`, { kind: "warn" });
                    }
                  }}
                >
                  ✕
                </button>
              </header>
              {/* How many recordings a theme draws on is the difference between
                  a theme and one person's preoccupation. */}
              <p className="column__spread">
                {spread.size} of {recordings.size} recordings
              </p>
              <SyncedField
                as="textarea"
                className="column__note"
                rows="1"
                placeholder="What is this theme?"
                value={theme.note || ""}
                onCommit={(note) => patchTheme(theme.id, { note })}
              />
              <div
                className={`column__body${over === theme.id ? " column__body--over" : ""}`}
                {...dropZone(theme.id)}
              >
                {quotesHere.length ? (
                  quotesHere.map((quote) => (
                    <QuoteCard
                      key={`${theme.id}:${quote.ref}`}
                      quote={quote}
                      recordings={recordings}
                      themes={themes}
                      column={theme.id}
                      onPlay={onPlayQuote}
                      onMove={moveCard}
                      onDragStart={(event) => {
                        dragging.current = { ref: quote.ref, from: theme.id };
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", quote.ref);
                      }}
                      onDragEnd={() => {
                        dragging.current = null;
                        setOver(null);
                      }}
                    />
                  ))
                ) : (
                  <p className="empty">Drag quotes here.</p>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </main>
  );
}
