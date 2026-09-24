/* Listening to a theme end to end.
 *
 * Tone is half of what a quote means and it does not survive being written down,
 * so being able to hear a theme rather than only read it is the reason the
 * recordings are still attached. Each quote plays in the recording it came from
 * and stops at its own end rather than running into whatever follows.
 */

import { useCallback, useEffect, useRef } from "react";
import { applyRate, storedRate } from "../lib/player.js";

/** Which media file holds a session time, and where inside it. */
export function locate(quote, recordings) {
  const parts = recordings.get(quote.recording_id)?.parts || [];
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (quote.start_time >= parts[i].offset && parts[i].media_name) {
      return { index: i, local: quote.start_time - parts[i].offset };
    }
  }
  return parts.length && parts[0].media_name ? { index: 0, local: quote.start_time } : null;
}

export default function Queue({ queue, index, label, recordings, onNext, onClose, notify }) {
  const media = useRef(null);
  const quote = queue[index];

  const play = useCallback(async () => {
    const node = media.current;
    if (!node || !quote) return;
    const spot = locate(quote, recordings);
    if (!spot) {
      notify("That recording has no media to play.", { kind: "warn" });
      return;
    }
    const url = `/api/recordings/${quote.recording_id}/parts/${spot.index}/media`;
    if (node.dataset.src !== url) {
      node.dataset.src = url;
      node.src = url;
      await new Promise((resolve) => {
        node.addEventListener("loadedmetadata", resolve, { once: true });
        node.addEventListener("error", resolve, { once: true });
      });
    }
    // A little before the first word, as in the reader, at the speed set there.
    applyRate(node, storedRate());
    node.currentTime = Math.max(0, spot.local - 0.75);
    node.play().catch(() => {});
  }, [quote, recordings, notify]);

  useEffect(() => {
    play();
  }, [play]);

  // Each quote stops at its own end rather than running into what follows.
  useEffect(() => {
    const node = media.current;
    if (!node || !quote) return;
    const tick = () => {
      const spot = locate(quote, recordings);
      if (!spot) return;
      const stopAt = spot.local + (quote.end_time - quote.start_time) + 0.4;
      if (node.currentTime >= stopAt) onNext();
    };
    node.addEventListener("timeupdate", tick);
    return () => node.removeEventListener("timeupdate", tick);
  }, [quote, recordings, onNext]);

  if (!quote) return null;

  return (
    <div className="queue">
      <button
        className="transport"
        type="button"
        aria-label="Play"
        onClick={() => {
          const node = media.current;
          if (!node) return;
          if (node.paused) node.play().catch(() => {});
          else node.pause();
        }}
      >
        ▶
      </button>
      <div className="queue__body">
        <p className="queue__label">
          {label} — {recordings.get(quote.recording_id)?.title || ""}
        </p>
        <p className="queue__quote">{quote.text}</p>
      </div>
      <span className="clock">
        {index + 1}/{queue.length}
      </span>
      <button className="btn" type="button" onClick={onNext}>
        Next
      </button>
      <button className="btn btn--icon" type="button" aria-label="Close" onClick={onClose}>
        ✕
      </button>
      <video ref={media} playsInline preload="metadata" hidden />
    </div>
  );
}
