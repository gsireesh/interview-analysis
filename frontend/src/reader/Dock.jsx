/* The video dock: the stage, the transport, and the grip that resizes it.
 *
 * The <video> is mounted once and never conditionally. Putting it behind
 * `{expanded && ...}` would unmount it on collapse, dropping the loaded byte
 * range and the playhead -- the collapse is CSS, which is why the transport
 * stays reachable with the video hidden.
 *
 * The clock and the scrubber are written to the DOM by the parent on every
 * timeupdate rather than rendered from state, so a recording playing does not
 * re-render the transcript several times a second.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { formatTime, recall, remember } from "../lib/util.js";
import {
  DOCK_KEY,
  HEIGHT_KEY,
  KEY_STEP,
  RATES,
  RATE_KEY,
  applyRate,
  setStageHeight,
  storedRate,
} from "../lib/player.js";

export default function Dock({ media, duration, playing, anyVideo, onTogglePlay, onScrub, clockRef, scrubRef }) {
  // Whether you want the video showing is worth remembering between sessions.
  // A stored state from an older build may name one that no longer exists.
  const [expanded, setExpanded] = useState(() => anyVideo && recall(DOCK_KEY) === "expanded");
  const [rate, setRate] = useState(storedRate);
  const dock = useRef(null);
  const stage = useRef(null);
  const grip = useRef(null);

  useEffect(() => {
    if (!anyVideo && expanded) setExpanded(false);
  }, [anyVideo, expanded]);

  useEffect(() => {
    remember(DOCK_KEY, expanded ? "expanded" : "minimized");
  }, [expanded]);

  useEffect(() => {
    // Speed first, remembering it second: a storage failure must not be able to
    // swallow the change it exists to make.
    if (media.current) applyRate(media.current, rate);
    remember(RATE_KEY, String(rate));
  }, [rate, media]);

  useDockResize(grip, stage, dock);

  const onKeyGrip = useCallback((event) => {
    const step = event.key === "ArrowUp" ? KEY_STEP : event.key === "ArrowDown" ? -KEY_STEP : 0;
    if (!step) return;
    event.preventDefault();
    setStageHeight(stage.current.offsetHeight + step);
  }, []);

  return (
    <div className="dock" ref={dock} data-state={expanded ? "expanded" : "minimized"}>
      <div
        className="dock__grip"
        ref={grip}
        role="separator"
        aria-orientation="horizontal"
        tabIndex={0}
        aria-label="Resize video — drag, or use the arrow keys"
        onKeyDown={onKeyGrip}
      />
      <div className="dock__stage" ref={stage}>
        <video ref={media} playsInline preload="metadata" />
      </div>
      <div className="dock__bar">
        <button
          className="transport"
          type="button"
          aria-label={playing ? "Pause" : "Play"}
          onClick={onTogglePlay}
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <span className="clock" ref={clockRef}>0:00</span>
        <input
          className="scrub"
          ref={scrubRef}
          type="range"
          min="0"
          max="1000"
          defaultValue="0"
          step="1"
          aria-label="Seek"
          onInput={(event) => onScrub(Number(event.target.value), false)}
          onChange={(event) => onScrub(Number(event.target.value), true)}
        />
        <span className="clock clock--muted">{formatTime(duration)}</span>
        <label className="rate">
          <span className="rate__label">speed</span>
          <select
            className="rate__select"
            aria-label="Playback speed"
            value={String(rate)}
            onChange={(event) => setRate(Number(event.target.value))}
          >
            {RATES.map((value) => (
              <option key={value} value={String(value)}>
                {value}×
              </option>
            ))}
          </select>
        </label>
        {anyVideo && (
          <button
            className="btn btn--icon"
            type="button"
            title={expanded ? "Hide video" : "Show video"}
            aria-label={expanded ? "Hide video" : "Show video"}
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "▤" : "▣"}
          </button>
        )}
      </div>
    </div>
  );
}

/** Drag the grip, or focus it and use the arrow keys. */
function useDockResize(grip, stage, dock) {
  useEffect(() => {
    const node = grip.current;
    if (!node) return;

    const stored = Number(recall(HEIGHT_KEY));
    setStageHeight(Number.isFinite(stored) && stored > 0 ? stored : window.innerHeight * 0.34);

    let dragging = false;
    let startY = 0;
    let startHeight = 0;

    const down = (event) => {
      dragging = true;
      startY = event.clientY;
      startHeight = stage.current.offsetHeight;
      // Capture keeps the drag alive when the pointer leaves the thin grip, but
      // the drag must not depend on it -- track the state explicitly instead.
      try {
        node.setPointerCapture(event.pointerId);
      } catch (_) { /* no active pointer to capture */ }
      dock.current?.classList.add("dock--resizing");
      event.preventDefault();
    };

    const move = (event) => {
      if (!dragging) return;
      // Dragging the grip upward grows the video.
      setStageHeight(startHeight + (startY - event.clientY));
    };

    const stop = (event) => {
      dragging = false;
      try {
        node.releasePointerCapture(event.pointerId);
      } catch (_) { /* never captured */ }
      dock.current?.classList.remove("dock--resizing");
    };

    // Keep the video inside the window when the window itself shrinks.
    const resize = () => setStageHeight(stage.current.offsetHeight);

    node.addEventListener("pointerdown", down);
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", stop);
    node.addEventListener("pointercancel", stop);
    node.addEventListener("lostpointercapture", stop);
    window.addEventListener("resize", resize);
    return () => {
      node.removeEventListener("pointerdown", down);
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", stop);
      node.removeEventListener("pointercancel", stop);
      node.removeEventListener("lostpointercapture", stop);
      window.removeEventListener("resize", resize);
    };
  }, [grip, stage, dock]);
}
