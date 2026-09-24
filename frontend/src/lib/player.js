/* Playing a session that may be several files laid end to end.
 *
 * A recording can arrive as several media files -- Zoom splits a meeting when it
 * is interrupted -- which are placed on one continuous timeline. `partAt` and
 * the offsets are what convert between a session time, which is what everything
 * else in the tool talks in, and a position inside one file.
 */

import { recall, remember } from "./util.js";

export const DOCK_KEY = "subtitle-search:dock";
export const HEIGHT_KEY = "subtitle-search:dockHeight";
export const RATE_KEY = "subtitle-search:rate";

export const MIN_STAGE = 120;
export const KEY_STEP = 24;

//: Land just before a quote rather than inside its first word.
export const SEEK_LEAD_IN = 0.75;

export const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

/** Which part contains a session time, clamped to the ends. */
export function partAt(parts, sessionTime) {
  if (!parts.length) return 0;
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (sessionTime >= parts[i].offset) return i;
  }
  return 0;
}

export function partUrl(recordingId, index) {
  return `/api/recordings/${recordingId}/parts/${index}/media`;
}

/** The speed you last chose, or normal. */
export function storedRate() {
  const value = Number(recall(RATE_KEY));
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/**
 * Apply a playback speed to a media element.
 *
 * Pitch correction on, or a voice at 1.5x is a cartoon and the tone you kept the
 * recording for is gone. Safari wants the prefixed spelling.
 */
export function applyRate(media, rate) {
  media.preservesPitch = true;
  media.mozPreservesPitch = true;
  media.webkitPreservesPitch = true;
  media.playbackRate = rate;
}

/** Cap the video so the transcript can never be squeezed out entirely. */
export function boundHeight(px) {
  return Math.max(MIN_STAGE, Math.min(px, Math.round(window.innerHeight * 0.75)));
}

export function setStageHeight(px) {
  const bounded = boundHeight(px);
  document.documentElement.style.setProperty("--dock-height", `${bounded}px`);
  remember(HEIGHT_KEY, bounded);
  return bounded;
}
