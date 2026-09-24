/* The video element, driven imperatively behind a ref.
 *
 * React never owns `src`, `currentTime`, `paused` or `playbackRate`. Those are
 * set only in here. Two reasons, and both are load-bearing:
 *
 *   `timeupdate` fires several times a second. Putting the position in state
 *   would re-render a transcript of a thousand cues at that rate, so the clock,
 *   the scrubber and the spine dot are written to the DOM directly and only a
 *   *block* change reaches React.
 *
 *   Re-assigning `src` restarts the download and throws away the loaded byte
 *   range, so a render that set it as a prop would break seeking in a recording
 *   the browser is streaming with range requests.
 */

import { useCallback, useMemo, useRef } from "react";
import { applyRate, partAt, partUrl, storedRate, SEEK_LEAD_IN } from "../lib/player.js";

export function usePlayer({ recordingId, parts, duration, onTime, onPlaying }) {
  const media = useRef(null);
  const activePart = useRef(-1);
  const scrubbing = useRef(false);

  const live = useRef({ parts, recordingId, duration, onTime, onPlaying });
  live.current = { parts, recordingId, duration, onTime, onPlaying };

  /** Where the playhead is on the session timeline, not inside one file. */
  const sessionTime = useCallback(() => {
    const part = live.current.parts[activePart.current];
    return (part ? part.offset : 0) + (media.current?.currentTime || 0);
  }, []);

  /** Point the element at a part and move to a position inside it. */
  const activate = useCallback(async (index, localTime, { play = false } = {}) => {
    const { parts, recordingId } = live.current;
    const part = parts[index];
    const node = media.current;
    if (!part || !part.media_name || !node) return false;

    if (activePart.current !== index) {
      activePart.current = index;
      node.src = partUrl(recordingId, index);
      node.closest(".dock")?.setAttribute("data-media", part.media_kind || "audio");
      // currentTime cannot be set until the new file's metadata has loaded.
      await new Promise((resolve) => {
        node.addEventListener("loadedmetadata", resolve, { once: true });
        node.addEventListener("error", resolve, { once: true });
      });
      // A new source starts at normal speed, so the chosen rate is reapplied
      // rather than quietly resetting at every interruption in a session.
      applyRate(node, storedRate());
    }

    try {
      node.currentTime = Math.max(0, localTime);
    } catch (_) { /* metadata never arrived; leave the position alone */ }
    if (play) node.play().catch(() => {});
    return true;
  }, []);

  /** Move to a session time, switching recordings if it lands in another part. */
  const seek = useCallback(
    (target, options = {}) => {
      const { parts } = live.current;
      const bounded = Math.max(0, target);
      const index = partAt(parts, bounded);
      const part = parts[index];
      if (!part) return;
      return activate(index, bounded - part.offset, options);
    },
    [activate]
  );

  /**
   * Move the playhead without starting playback.
   *
   * This is what "the player is always cued to what you are reading" means:
   * while you read the position follows silently, so play starts where you are.
   */
  const cue = useCallback(
    (target) => {
      const node = media.current;
      if (!node?.src || !node.paused) return;
      if (Math.abs(sessionTime() - target) < 0.25) return;
      seek(target);
    },
    [seek, sessionTime]
  );

  /** Jump to a point and play it, with a lead-in so the first word is not clipped. */
  const seekAndPlay = useCallback(
    (target, { play = false } = {}) => seek(Math.max(0, target - SEEK_LEAD_IN), { play }),
    [seek]
  );

  const nudge = useCallback(
    (delta) => {
      const node = media.current;
      if (!node?.src) return;
      seek(Math.min(live.current.duration, Math.max(0, sessionTime() + delta)));
    },
    [seek, sessionTime]
  );

  const togglePlay = useCallback(() => {
    const node = media.current;
    if (!node?.src) return;
    if (node.paused) node.play().catch(() => {});
    else node.pause();
  }, []);

  /**
   * Bind to the media element as it mounts, rather than after the first render.
   *
   * The dock is not rendered until the recording has loaded and turns out to
   * have media, so on the first render there is no <video> to listen to. An
   * effect would run exactly then, find nothing, and -- since everything it
   * depends on is stable by design -- never run again: the element appears a
   * moment later with nobody listening to it, and the clock, the scrubber, the
   * play button and the whole of following mode sit frozen while the audio
   * plays. A ref callback fires when the node actually arrives.
   */
  const attach = useCallback(
    (node) => {
      media.current = node;
      if (!node) return undefined;

      const tick = () => {
        if (scrubbing.current) return;
        live.current.onTime?.(sessionTime());
      };
      const playing = () => live.current.onPlaying?.(true);
      const stopped = () => live.current.onPlaying?.(false);
      const ended = () => {
        // Playing off the end of one recording continues into the next, so a
        // session interrupted by Zoom still reads as one sitting.
        const next = activePart.current + 1;
        if (next < live.current.parts.length) activate(next, 0, { play: true });
        else live.current.onPlaying?.(false);
      };

      node.addEventListener("timeupdate", tick);
      node.addEventListener("play", playing);
      node.addEventListener("pause", stopped);
      node.addEventListener("ended", ended);
      return () => {
        node.removeEventListener("timeupdate", tick);
        node.removeEventListener("play", playing);
        node.removeEventListener("pause", stopped);
        node.removeEventListener("ended", ended);
        media.current = null;
      };
    },
    [activate, sessionTime]
  );

  // One stable object. Returning a fresh literal would re-run every consumer
  // effect that depends on the player on every single render.
  return useMemo(
    () => ({ media, attach, activate, seek, cue, seekAndPlay, nudge, togglePlay, sessionTime, scrubbing }),
    [attach, activate, seek, cue, seekAndPlay, nudge, togglePlay, sessionTime]
  );
}
