/* The bar that appears over a selection: save it, copy it, or hand it over.
 *
 * It must not take the selection away by being clicked, which is what the
 * mousedown preventDefault is for -- a bar that clears the thing it acts on is
 * a bar that never works.
 */

import { useLayoutEffect, useRef, useState } from "react";
import { formatTime } from "../lib/util.js";

export default function QuoteBar({ anchors, colors, roster, speakers, onSave, onCopy, onHandOver }) {
  const bar = useRef(null);
  const [position, setPosition] = useState(null);

  useLayoutEffect(() => {
    if (!anchors || !bar.current) {
      setPosition(null);
      return;
    }
    const rect = anchors.rect;
    const width = bar.current.offsetWidth || 260;
    const height = bar.current.offsetHeight;
    const left = Math.min(
      Math.max(8, rect.left + rect.width / 2 - width / 2),
      window.innerWidth - width - 8
    );
    const above = rect.top - height - 10;
    setPosition({ left, top: above > 8 ? above : rect.bottom + 10 });
  }, [anchors]);

  if (!anchors) return null;

  // Only the speaker the passage is *not* currently credited to is offered,
  // because handing a passage to whoever already has it does nothing.
  const names = roster.map((entry) => entry.name);
  for (const name of speakers) if (!names.includes(name)) names.push(name);
  const candidates = names.filter((name) => name !== anchors.speaker);

  return (
    <div
      className="quotebar"
      ref={bar}
      style={position ? { left: position.left, top: position.top } : { visibility: "hidden" }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <span className="quotebar__time">→ {formatTime(anchors.estimated_start)}</span>

      <div className="quotebar__colors">
        {colors.map((color) => (
          <button
            key={color}
            className={`swatch swatch--${color}`}
            type="button"
            title={`Save as ${color}`}
            aria-label={`Save as ${color}`}
            onClick={() => onSave({ color })}
          />
        ))}
      </div>

      <button className="quotebar__action" type="button" onClick={() => onSave({ focusNote: true })}>
        Save with note
      </button>
      <button className="quotebar__action" type="button" onClick={onCopy}>
        Copy
      </button>

      <span className="quotebar__hand">
        <span className="quotebar__lead">said by</span>
        {candidates.length ? (
          candidates.map((name) => {
            const key = roster.find((entry) => entry.name === name)?.key;
            return (
              <button
                key={name}
                className="quotebar__who"
                type="button"
                title={`These words were said by ${name}`}
                onClick={() => onHandOver(name)}
              >
                {key && <kbd>{key}</kbd>}
                {name}
              </button>
            );
          })
        ) : (
          /* A transcript naming one person -- the in-person case, a whole room
             under one label -- has nobody to hand words *to* yet. Saying so
             beats the control silently not existing, which reads as the feature
             being missing. */
          <span className="quotebar__none">name someone in the strip above first</span>
        )}
      </span>
    </div>
  );
}
