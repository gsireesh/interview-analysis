/* A quote as a board card.
 *
 * `column` is the theme this particular card is sitting in, which is not the
 * same question as which theme the quote is in: since the canvas can pin one
 * quote inside two areas, the same quote appears in both of those columns. So
 * the select says where *this* card is, and moving it moves only this one --
 * anything else would make touching one column silently empty another.
 */

import { formatTime } from "../lib/util.js";

export default function QuoteCard({
  quote,
  recordings,
  themes,
  column = null,
  draggable = true,
  onPlay,
  onMove,
  onDragStart,
  onDragEnd,
}) {
  const recording = recordings.get(quote.recording_id);
  const elsewhere = themes.filter(
    (theme) => theme.id !== column && theme.refs.includes(quote.ref)
  );

  return (
    <article
      className={`qcard qcard--${quote.color || "amber"}`}
      data-ref={quote.ref}
      data-column={column || ""}
      draggable={draggable}
      onDragStart={draggable ? onDragStart : undefined}
      onDragEnd={draggable ? onDragEnd : undefined}
    >
      <p className="qcard__text">{quote.text}</p>
      <div className="qcard__meta">
        <span className="qcard__where">{recording ? recording.title : quote.recording_id}</span>
        <time>{formatTime(quote.start_time)}</time>
        <span className="qcard__tools">
          <button
            className="icon-btn"
            type="button"
            title="Play this quote"
            onClick={() => onPlay?.(quote)}
          >
            ▶
          </button>
          {/* A new tab, deliberately: following it in place would throw away the
              pan, the zoom and a half-narrowed filter to answer a question that
              is usually "wait, what came before this?". */}
          <a
            className="icon-btn"
            target="_blank"
            rel="noopener"
            href={`/reader?recording=${encodeURIComponent(quote.recording_id)}&t=${quote.start_time}`}
            title="Open in the transcript, in a new tab"
          >
            ↗
          </a>
        </span>
      </div>
      {quote.note && <p className="qcard__note">{quote.note}</p>}
      {Boolean(elsewhere.length) && (
        <p className="qcard__also">
          also in {elsewhere.map((theme) => theme.title).join(", ")}
        </p>
      )}
      <div className="tags">
        {(quote.tags || []).map((tag) => (
          <span className="tag" key={tag}>
            {tag}
          </span>
        ))}
      </div>
      {/* Dragging is the fast way to sort, but it cannot be the only way: a
          board you can only use with a mouse is a board some people cannot use
          at all. */}
      {draggable && (
        <select
          className="qcard__move"
          aria-label="Move this quote to a theme"
          value={column || ""}
          onChange={(event) => onMove?.(quote.ref, column, event.target.value || null)}
        >
          <option value="">Unsorted</option>
          {themes.map((theme) => (
            <option key={theme.id} value={theme.id}>
              {theme.title || "Untitled"}
            </option>
          ))}
        </select>
      )}
    </article>
  );
}
