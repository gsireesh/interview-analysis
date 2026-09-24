/* Correcting the transcript in place.
 *
 * Reading shows merged prose, but a correction has to land on a single caption,
 * because that is what gets written back to the file. So edit mode opens the
 * block up into the captions underneath it -- each with its own timestamp and a
 * button to replay just that line. The caption boundaries become visible exactly
 * when they matter, and stay invisible the rest of the time.
 *
 * Every line is saved as you leave it. The original transcript is copied aside
 * before the first change, so the file as Zoom produced it is always recoverable.
 *
 * The text fields are contenteditable and therefore **uncontrolled**: React sets
 * their text once through a ref and never again. Rendering the value as children
 * would have React diff a node the browser is also editing, which moves the
 * caret to the start on every keystroke.
 */

import { useEffect, useRef } from "react";
import { formatTime } from "../lib/util.js";
import { offsetWithin } from "../lib/transcript.js";
import { PLAINTEXT_ONLY, caretOffset, placeCaretAtEnd } from "../lib/editing.js";

export default function EditBlock({
  chunk,
  cueById,
  speakers,
  onCommitText,
  onReattribute,
  onSplitAtCaret,
  onJoinWithPrevious,
  onPlayLine,
  onCueLine,
  onDone,
}) {
  const container = useRef(null);
  const fields = useRef(new Map());

  // Set each line's text once, on the way in. After that the browser owns it.
  useEffect(() => {
    for (const cueId of chunk.cue_ids) {
      const field = fields.current.get(cueId);
      const cue = cueById.get(cueId);
      if (field && cue && field.textContent !== cue.text) field.textContent = cue.text;
    }
    const first = fields.current.get(chunk.cue_ids[0]);
    if (first) {
      first.focus();
      placeCaretAtEnd(first);
    }
    // Only when the block being edited changes -- not on every keystroke.
  }, [chunk.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const lineKeyDown = (event, cueId, position) => {
    const field = event.currentTarget;

    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      const offset = caretOffset(field, offsetWithin);
      if (offset != null) onSplitAtCaret(cueId, offset, field.textContent);
      return;
    }

    if (
      event.key === "Backspace" &&
      !event.metaKey &&
      !event.ctrlKey &&
      caretOffset(field, offsetWithin) === 0 &&
      window.getSelection()?.isCollapsed
    ) {
      // What backspace at the start of a line means in every text editor: join
      // it to the line above. Here that joins two captions, which is the repair
      // for one sentence Zoom chopped into several.
      event.preventDefault();
      onJoinWithPrevious(cueId, position, field.textContent);
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      const next = fields.current.get(chunk.cue_ids[position + 1]);
      if (next) {
        next.focus();
        placeCaretAtEnd(next);
      } else {
        field.blur();
        onDone();
      }
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      // Abandon this line's changes, then leave edit mode.
      field.textContent = cueById.get(cueId)?.text ?? field.textContent;
      field.dataset.skip = "1";
      onDone();
    }
  };

  return (
    <article className="chunk chunk--editing" data-chunk-id={chunk.id}>
      <span className="chunk__time">{formatTime(chunk.start)}</span>
      <div className="chunk__body" ref={container}>
        <div className="edit-bar">
          {/* Zoom attributes badly, so who said a line is as editable as what
              they said. */}
          <span className="edit-bar__hint">
            Editing {chunk.cue_ids.length} line{chunk.cue_ids.length === 1 ? "" : "s"} · Enter
            saves and moves on · ⌘↩ splits at the cursor · ⌫ at the start joins upward · Esc
            finishes
          </span>
          <datalist id="known-speakers">
            {speakers.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          <button className="edit-bar__done" type="button" onClick={onDone}>
            Done
          </button>
        </div>

        <div className="cue-lines">
          {chunk.cue_ids.map((cueId, position) => {
            const cue = cueById.get(cueId);
            if (!cue) return null;
            return (
              <div className="cue-line" data-cue-id={cueId} key={cueId}>
                <button
                  className="cue-line__play"
                  type="button"
                  title="Play this line"
                  aria-label="Play this line"
                  onClick={() => onPlayLine(cue)}
                >
                  ▶
                </button>
                <span className="cue-line__time">{formatTime(cue.start)}</span>
                <input
                  className="cue-line__who"
                  list="known-speakers"
                  defaultValue={cue.speaker || ""}
                  placeholder="who said this"
                  aria-label={`Speaker for the line at ${formatTime(cue.start)}`}
                  onChange={(event) => onReattribute(cueId, event.target.value.trim())}
                />
                <div
                  className="cue-line__text"
                  ref={(node) => {
                    if (node) fields.current.set(cueId, node);
                    else fields.current.delete(cueId);
                  }}
                  contentEditable={PLAINTEXT_ONLY ? "plaintext-only" : true}
                  suppressContentEditableWarning
                  spellCheck
                  role="textbox"
                  aria-label={`Transcript line at ${formatTime(cue.start)}`}
                  onFocus={() => onCueLine(cue)}
                  onBlur={(event) => {
                    const field = event.currentTarget;
                    if (field.dataset.skip) {
                      delete field.dataset.skip;
                      return;
                    }
                    onCommitText(cueId, field.textContent, field);
                  }}
                  onKeyDown={(event) => lineKeyDown(event, cueId, position)}
                  onPaste={
                    PLAINTEXT_ONLY
                      ? undefined
                      : (event) => {
                          event.preventDefault();
                          const text = event.clipboardData.getData("text");
                          document.execCommand("insertText", false, text.replace(/\s+/g, " "));
                        }
                  }
                />
              </div>
            );
          })}
        </div>
      </div>
    </article>
  );
}
