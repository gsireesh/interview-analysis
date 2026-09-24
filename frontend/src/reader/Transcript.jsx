/* The transcript body: blocks, cues, part breaks and the time spine.
 *
 * Highlights used to be painted by setting innerHTML on each cue span and a set
 * of "which cues did I paint" was kept so they could be un-painted later. Both
 * are gone: a cue renders its own text cut at the highlight boundaries, so the
 * marks are a consequence of the quotes rather than something kept in step with
 * them.
 *
 * Not virtualised, on purpose. Resolving a selection walks the cue spans the
 * range intersects, and the reading cursor binary-searches real offsetTops; a
 * selection running off the rendered window, or geometry for a block that is not
 * mounted, would break both. Cost is held down by keeping the playhead out of
 * state and memoising the blocks instead.
 */

import { memo, useMemo } from "react";
import { formatTime } from "../lib/util.js";
import { chunkIsMeasured, clockTime, cueSegments, formatGap } from "../lib/transcript.js";

export default function Transcript({
  chunks,
  cueById,
  slices,
  parts,
  activeHighlightId,
  chunksRef,
  onPlayFrom,
  onDoubleClickWord,
  onHighlightClick,
  editingIndex,
  renderEditor,
}) {
  return (
    <div className="chunks" ref={chunksRef} onDoubleClick={onDoubleClickWord}>
      {chunks.map((chunk) => (
        <div key={chunk.id}>
          {chunk.starts_part && chunk.part_index > 0 && parts[chunk.part_index] && (
            <PartBreak part={parts[chunk.part_index]} total={parts.length} />
          )}
          {editingIndex === chunk.index ? (
            renderEditor(chunk)
          ) : (
            <Chunk
              chunk={chunk}
              cueById={cueById}
              slices={slices}
              activeHighlightId={activeHighlightId}
              onPlayFrom={onPlayFrom}
              onHighlightClick={onHighlightClick}
            />
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * The marker shown where one recording ended and the next began.
 *
 * The timeline itself is continuous -- every session timestamp has audio behind
 * it -- so this is the only place the real interruption is visible. It reports
 * wall-clock time where the filenames carry it, and stays honest about not
 * knowing where they do not.
 */
function PartBreak({ part, total }) {
  const started = clockTime(part.started_at);
  return (
    <div className="part-break" data-part-index={part.index}>
      <span className="part-break__label">
        {part.gap_before != null
          ? `Recording resumed after ${formatGap(part.gap_before)}`
          : `New recording — part ${part.index + 1} of ${total}`}
        {started && <span className="part-break__clock">{started}</span>}
      </span>
    </div>
  );
}

const Chunk = memo(function Chunk({
  chunk,
  cueById,
  slices,
  activeHighlightId,
  onPlayFrom,
  onHighlightClick,
}) {
  const measured = useMemo(() => chunkIsMeasured(chunk, cueById), [chunk, cueById]);

  return (
    <article className={chunk.split ? "chunk chunk--split" : "chunk"} data-chunk-id={chunk.id}>
      <button
        type="button"
        className={measured ? "chunk__time chunk__time--measured" : "chunk__time"}
        title={
          measured
            ? "Play from here — this block's words are aligned to the audio"
            : "Play from here — times inside this block are estimated"
        }
        onClick={() => onPlayFrom(chunk.start)}
      >
        {formatTime(chunk.start)}
      </button>

      <div className="chunk__body">
        {chunk.speaker && <p className="chunk__speaker">{chunk.speaker}</p>}
        {chunk.paragraphs.map((paragraph, index) => (
          <p className="chunk__text" key={index}>
            {paragraph.map((cueId, position) => {
              const cue = cueById.get(cueId);
              if (!cue) return null;
              return (
                <Cue
                  key={cueId}
                  cue={cue}
                  slices={slices.get(cueId)}
                  activeHighlightId={activeHighlightId}
                  // The separator between two cues in one paragraph. JSX drops
                  // whitespace between elements on separate lines, so leaving
                  // this out silently joins the last word to the next one.
                  lead={position > 0}
                  onHighlightClick={onHighlightClick}
                />
              );
            })}
          </p>
        ))}
      </div>
    </article>
  );
});

const Cue = memo(function Cue({ cue, slices, activeHighlightId, lead, onHighlightClick }) {
  const segments = useMemo(() => cueSegments(cue, slices || []), [cue, slices]);

  return (
    <>
      {lead && " "}
      <span className="cue" data-cue-id={cue.id}>
        {segments.map((segment) =>
          segment.highlight ? (
            <mark
              key={segment.from}
              className={markClass(segment.highlight, activeHighlightId)}
              data-highlight-id={segment.highlight.id}
              onClick={() => onHighlightClick?.(segment.highlight.id)}
            >
              {segment.text}
            </mark>
          ) : (
            segment.text
          )
        )}
      </span>
    </>
  );
});

function markClass(highlight, activeId) {
  const classes = ["hl", `hl--${highlight.color}`];
  if (highlight.note) classes.push("hl--noted");
  if (highlight.id === activeId) classes.push("hl--active");
  return classes.join(" ");
}
