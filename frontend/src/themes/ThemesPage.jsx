/* Thematic analysis across every recording in the library.
 *
 * Three views over the same quotes, because the work has more than one shape:
 *
 *   Canvas  - the themes on a plane. Generative, and the one with no right-hand
 *             edge: columns stop working at the width of the screen, and a plane
 *             does not, so the number of themes is no longer a layout problem.
 *             Where two areas sit relative to each other is itself a claim.
 *   Board   - the same themes as columns. Still the fastest way to sort a pile
 *             when there are few enough themes to see all of them at once.
 *   Signals - whether new interviews are still turning up new tags, and which
 *             quotes refuse to group with anything.
 *
 * Canvas and board are two shapes of one thing, not two groupings: a theme made
 * on either shows up on the other, because membership lives in a single file and
 * a card on the canvas *is* a quote's membership of the area holding it.
 */

import { useCallback, useState } from "react";
import { ThemeToggle } from "../ui/Theme.jsx";
import { useLibrary } from "./useLibrary.js";
import Board from "./Board.jsx";
import Signals from "./Signals.jsx";
import Canvas from "./Canvas.jsx";
import Queue from "./Queue.jsx";

const MODES = [
  ["canvas", "Canvas"],
  ["board", "Board"],
  ["signals", "Signals"],
];

export default function ThemesPage() {
  const lib = useLibrary();
  const [mode, setMode] = useState("canvas");
  const [queue, setQueue] = useState({ quotes: [], index: 0, label: "" });

  // A tag from the library's tag rail opens the canvas with that tag filtered,
  // which answers "where did this tag end up" rather than only "what carries it".
  const [wantedTag] = useState(() => new URLSearchParams(location.search).get("tag"));

  const startQueue = useCallback((quotes, label) => {
    setQueue({ quotes, index: 0, label: label || "" });
  }, []);

  const playTheme = useCallback(
    (theme) => {
      const quotes = theme.refs.map((ref) => lib.byRef.get(ref)).filter(Boolean);
      if (quotes.length) startQueue(quotes, theme.title || "Untitled");
    },
    [lib.byRef, startQueue]
  );

  const playQuote = useCallback(
    (quote) => startQueue([quote], quote.text.slice(0, 40)),
    [startQueue]
  );

  const meta = lib.library
    ? [
        `${lib.library.recordings.length} recordings`,
        `${lib.quotes.length} quotes`,
        `${lib.library.tags.length} tags`,
        lib.library.untagged_count ? `${lib.library.untagged_count} untagged` : null,
      ]
        .filter(Boolean)
        .join("  ·  ")
    : "";

  return (
    <>
      <header className="topbar">
        <div className="topbar__identity">
          <h1 className="topbar__title">Themes</h1>
          <p className="topbar__meta">{meta}</p>
        </div>

        <div className="topbar__search">
          <nav className="modes">
            {MODES.map(([value, label]) => (
              <button
                className="btn"
                type="button"
                key={value}
                aria-pressed={mode === value}
                onClick={() => setMode(value)}
              >
                {label}
              </button>
            ))}
          </nav>
        </div>

        <div className="topbar__actions">
          <nav className="tabs">
            <a className="btn" href="/">Recordings</a>
            <a className="btn" href="/themes" aria-current="page">Themes</a>
          </nav>
          <ThemeToggle />
        </div>
      </header>

      {lib.ready && (
        <>
          {/* Kept mounted rather than swapped out: the canvas holds a pan, a
              zoom and a half-narrowed filter, and clicking Board and back
              should not be a way to lose them. */}
          <div hidden={mode !== "canvas"} className="view-host">
            <Canvas lib={lib} wantedTag={wantedTag} onPlayTheme={playTheme} active={mode === "canvas"} />
          </div>
          <div hidden={mode !== "board"} className="view-host">
            <Board lib={lib} onPlayTheme={playTheme} onPlayQuote={playQuote} />
          </div>
          {mode === "signals" && <Signals lib={lib} onPlayQuote={playQuote} />}
        </>
      )}

      {Boolean(queue.quotes.length) && (
        <Queue
          queue={queue.quotes}
          index={queue.index}
          label={queue.label}
          recordings={lib.recordings}
          notify={lib.notify}
          onNext={() =>
            setQueue((current) =>
              current.index + 1 < current.quotes.length
                ? { ...current, index: current.index + 1 }
                : { quotes: [], index: 0, label: "" }
            )
          }
          onClose={() => setQueue({ quotes: [], index: 0, label: "" })}
        />
      )}
    </>
  );
}
