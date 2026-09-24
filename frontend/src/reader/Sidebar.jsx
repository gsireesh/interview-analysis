/* The sidebar: saved quotes, and the search results over this transcript.
 *
 * Quotes are the output of a reading session, so that is what it opens on.
 * Search is a keystroke away with `/`.
 */

import { useEffect, useMemo, useState } from "react";
import { formatTime } from "../lib/util.js";
import TagField from "../ui/TagField.jsx";

const KIND_LABEL = { exact: "exact", fuzzy: "close", regex: "regex" };

export default function Sidebar({
  tab,
  highlights,
  colors,
  vocabulary,
  activeHighlightId,
  searchResults,
  searchQuery,
  onJumpToQuote,
  onPatchQuote,
  onDeleteQuote,
  onCopyQuote,
  onJumpToResult,
  highlightsPath,
}) {
  const [tagFilter, setTagFilter] = useState(null);

  /* Tags that are actually on a quote right now, with how many carry each.
   *
   * Deliberately not knownTags: that keeps every tag ever typed so it can be
   * offered for autocomplete, but a filter for a tag with nothing behind it is
   * a dead end. History belongs in the input, reality belongs in the filter. */
  const counts = useMemo(() => {
    const map = new Map();
    for (const highlight of highlights) {
      for (const tag of highlight.tags || []) map.set(tag, (map.get(tag) || 0) + 1);
    }
    return new Map([...map.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  }, [highlights]);

  // A filter whose last quote just lost the tag would otherwise strand the list
  // showing nothing, with no way back except clicking a button that is now gone.
  useEffect(() => {
    if (tagFilter && !counts.has(tagFilter)) setTagFilter(null);
  }, [counts, tagFilter]);

  const visible = useMemo(() => {
    const kept = tagFilter
      ? highlights.filter((h) => (h.tags || []).includes(tagFilter))
      : highlights;
    return [...kept].sort((a, b) => a.start_time - b.start_time);
  }, [highlights, tagFilter]);

  return (
    <aside className="sidebar">
      <section className="panel" hidden={tab !== "search"}>
        <header className="panel__head">
          <h2 className="panel__title">Results</h2>
          <span className="panel__count">{searchResults ? searchResults.length : ""}</span>
        </header>
        <div className="panel__body">
          {!searchResults || !searchQuery ? (
            <p className="empty">
              Search the transcript to find a quote. Exact matches come first, then close ones.
            </p>
          ) : searchResults.length ? (
            searchResults.map((hit) => (
              <button
                className="result"
                type="button"
                key={`${hit.cue_id}:${hit.match_start}`}
                onClick={() => onJumpToResult(hit)}
              >
                <span className="result__head">
                  <span className="result__speaker">{hit.speaker || "—"}</span>
                  <span className="result__kind">{KIND_LABEL[hit.kind] || hit.kind}</span>
                  <span className="result__time">{formatTime(hit.start_time)}</span>
                </span>
                <p className="result__text">
                  {hit.snippet.slice(0, hit.match_start)}
                  <mark>{hit.snippet.slice(hit.match_start, hit.match_end)}</mark>
                  {hit.snippet.slice(hit.match_end)}
                </p>
              </button>
            ))
          ) : (
            <p className="empty">Nothing matched.</p>
          )}
        </div>
      </section>

      <section className="panel" hidden={tab !== "highlights"}>
        <header className="panel__head">
          <h2 className="panel__title">Quotes</h2>
          <span className="panel__count">{highlightsPath}</span>
        </header>

        <div className="panel__filters">
          {[...counts.entries()].map(([tag, count]) => (
            <button
              className="tag"
              type="button"
              key={tag}
              aria-pressed={tagFilter === tag}
              onClick={() => setTagFilter(tagFilter === tag ? null : tag)}
            >
              {tag}
              <span className="tag__count">{count}</span>
            </button>
          ))}
        </div>

        <div className="panel__body">
          {visible.length ? (
            visible.map((highlight) => (
              <QuoteCard
                key={highlight.id}
                highlight={highlight}
                colors={colors}
                vocabulary={vocabulary}
                active={highlight.id === activeHighlightId}
                onJump={() => onJumpToQuote(highlight)}
                onPatch={(patch) => onPatchQuote(highlight, patch)}
                onDelete={() => onDeleteQuote(highlight)}
                onCopy={() => onCopyQuote(highlight)}
              />
            ))
          ) : (
            <p className="empty">
              {highlights.length
                ? "No quotes with that tag."
                : "Select text in the transcript to save a quote. Quotes are written to a JSON file next to the recording."}
            </p>
          )}
        </div>
      </section>
    </aside>
  );
}

function QuoteCard({ highlight, colors, vocabulary, active, onJump, onPatch, onDelete, onCopy }) {
  const [note, setNote] = useState(highlight.note || "");

  // The server is the source of truth; a note edited elsewhere should land here.
  useEffect(() => setNote(highlight.note || ""), [highlight.note]);

  return (
    <article
      className={`quote quote--${highlight.color}${active ? " quote--active" : ""}`}
      data-id={highlight.id}
    >
      <p className="quote__text" onClick={onJump}>
        {highlight.text}
      </p>
      <div className="quote__meta">
        <span className="quote__speaker">{highlight.speaker || "—"}</span>
        <time>{formatTime(highlight.start_time)}</time>
        <span className="quote__tools">
          <span className="swatches">
            {colors.map((color) => (
              <button
                key={color}
                className={`swatch swatch--${color}`}
                type="button"
                aria-pressed={color === highlight.color}
                aria-label={color}
                onClick={() => onPatch({ color })}
              />
            ))}
          </span>
          <button className="icon-btn" type="button" title="Copy quote" onClick={onCopy}>
            ⧉
          </button>
          <button className="icon-btn" type="button" title="Delete quote" onClick={onDelete}>
            ✕
          </button>
        </span>
      </div>
      <textarea
        className="quote__note"
        rows="1"
        placeholder="Note"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        onBlur={() => {
          if (note !== (highlight.note || "")) onPatch({ note });
        }}
      />
      <TagField
        tags={highlight.tags || []}
        vocabulary={vocabulary}
        onCommit={(tags) => onPatch({ tags })}
      />
    </article>
  );
}
