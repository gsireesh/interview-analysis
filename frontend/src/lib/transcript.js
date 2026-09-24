/* Transcript logic with no DOM in it.
 *
 * Every cue gets its own <span>. That is what makes an arbitrary text selection
 * resolvable: the selection's endpoints land inside cue spans, and the offset
 * within a span maps back to a point in time. The functions that read a live
 * selection live here too -- they only ever *read* the DOM, so they were already
 * safe to keep exactly as they were.
 */

import { lastAtOrBefore } from "./util.js";

//: Where down the viewport "the line you are reading" sits.
export const READING_LINE = 0.32;

/** "7 minutes", "1 hr 5 min", "45 seconds" -- how long the recording was down. */
export function formatGap(seconds) {
  const total = Math.round(seconds);
  if (total < 90) return `${total} seconds`;
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

export function clockTime(iso) {
  if (!iso) return null;
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return null;
  return when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * Break open any block the reader has asked to see line by line.
 *
 * Splitting is a view, not an edit: nothing is written, because there is nothing
 * to record yet. A block that merged two people is still one run of one label
 * until somebody says otherwise -- this only exposes the seams so each line can
 * be assigned, and the assignment is what persists. Cue ids are stable across a
 * rebuild, so the split survives one.
 */
export function expandChunks(chunks, cueById, split) {
  if (!split.size) return chunks;
  const out = [];
  for (const chunk of chunks) {
    if (!chunk.cue_ids.some((id) => split.has(id))) {
      out.push(chunk);
      continue;
    }
    chunk.cue_ids.forEach((id, position) => {
      const cue = cueById.get(id);
      out.push({
        ...chunk,
        id: `${chunk.id}:${id}`,
        cue_ids: [id],
        paragraphs: [[id]],
        start: cue ? cue.start : chunk.start,
        end: cue ? cue.end : chunk.end,
        split: true,
        starts_part: chunk.starts_part && position === 0,
      });
    });
  }
  return out.map((chunk, index) => ({ ...chunk, index }));
}

/**
 * Whether a block's words are measured rather than interpolated.
 *
 * The difference between a measured and an interpolated timestamp is the
 * difference between knowing and guessing, so it is marked. A caption with no
 * words cannot be measured, so it must not be what stops a block reading as
 * measured.
 */
export function chunkIsMeasured(chunk, cueById) {
  return chunk.cue_ids.every((id) => {
    const item = cueById.get(id);
    return !item || !item.text.trim() || item.timed;
  });
}

/* ----------------------------------------------------------- highlights -- */

/** Which highlights touch each cue, as offsets within that cue's text. */
export function highlightSlices(highlights, cueById, cueByIndex) {
  const slices = new Map();
  for (const highlight of highlights) {
    const first = cueById.get(highlight.start_cue_id);
    const last = cueById.get(highlight.end_cue_id);
    if (!first || !last) continue;

    for (let index = first.index; index <= last.index; index += 1) {
      const cue = cueByIndex.get(index);
      if (!cue) continue;
      const from = index === first.index ? highlight.start_char_offset ?? 0 : 0;
      const to =
        index === last.index ? highlight.end_char_offset ?? cue.text.length : cue.text.length;
      if (to <= from) continue;
      if (!slices.has(cue.id)) slices.set(cue.id, []);
      slices.get(cue.id).push({ from, to, highlight });
    }
  }
  return slices;
}

/**
 * One cue's text cut at every highlight boundary.
 *
 * Overlapping quotes are flattened rather than nested: the most recent one wins
 * the segment, so colours never stack into an unreadable muddle.
 */
export function cueSegments(cue, slices = []) {
  const bounds = new Set([0, cue.text.length]);
  for (const slice of slices) {
    bounds.add(Math.max(0, Math.min(slice.from, cue.text.length)));
    bounds.add(Math.max(0, Math.min(slice.to, cue.text.length)));
  }
  const points = Array.from(bounds).sort((a, b) => a - b);

  const out = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const from = points[i];
    const to = points[i + 1];
    if (to <= from) continue;
    const covering = slices.filter((slice) => slice.from <= from && slice.to >= to);
    out.push({
      from,
      text: cue.text.slice(from, to),
      highlight: covering.length ? covering[covering.length - 1].highlight : null,
    });
  }
  return out;
}

/* ------------------------------------------------------------ selection -- */

export function offsetWithin(cueEl, node, offset) {
  if (node === cueEl) {
    let total = 0;
    for (let i = 0; i < offset && i < cueEl.childNodes.length; i += 1) {
      total += cueEl.childNodes[i].textContent.length;
    }
    return total;
  }
  const walker = document.createTreeWalker(cueEl, NodeFilter.SHOW_TEXT);
  let total = 0;
  let current = walker.nextNode();
  while (current) {
    if (current === node) return total + offset;
    total += current.nodeValue.length;
    current = walker.nextNode();
  }
  return total;
}

/**
 * Resolve the current selection to cue anchors.
 *
 * Uses the cue spans the range actually intersects rather than its endpoint
 * containers, so a selection that starts in whitespace or drags past the end of
 * a paragraph still anchors to real cues.
 *
 * Reads the DOM and writes none of it, which is why the move to a renderer that
 * owns the DOM left it alone: it needs the container React rendered into and the
 * cue lookup, and nothing else.
 */
export function readAnchors(root, cueById) {
  const selection = window.getSelection();
  if (!root || !selection || selection.isCollapsed || selection.rangeCount === 0) return null;

  const text = selection.toString().trim();
  if (!text) return null;

  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;

  const cueEls = Array.from(root.querySelectorAll(".cue")).filter((el) =>
    range.intersectsNode(el)
  );
  if (!cueEls.length) return null;

  const startEl = cueEls[0];
  const endEl = cueEls[cueEls.length - 1];
  const startCue = cueById.get(startEl.dataset.cueId);
  const endCue = cueById.get(endEl.dataset.cueId);
  if (!startCue || !endCue) return null;

  const startOffset =
    startEl.contains(range.startContainer) || startEl === range.startContainer
      ? offsetWithin(startEl, range.startContainer, range.startOffset)
      : 0;
  const endOffset =
    endEl.contains(range.endContainer) || endEl === range.endContainer
      ? offsetWithin(endEl, range.endContainer, range.endOffset)
      : endCue.text.length;

  return {
    text,
    start_cue_id: startCue.id,
    start_char_offset: startOffset,
    end_cue_id: endCue.id,
    end_char_offset: endOffset,
    speaker: startCue.speaker,
    // Mirrors the server's estimator so the quote bar can show the time live.
    estimated_start:
      startCue.start +
      (startOffset / Math.max(1, startCue.text.length)) * (startCue.end - startCue.start),
    rect: range.getBoundingClientRect(),
  };
}

/* --------------------------------------------------------------- cursor -- */

export function chunkIndexAtTime(chunkStarts, seconds) {
  return lastAtOrBefore(chunkStarts, seconds);
}

export function chunkIndexAtScroll(reader, chunkTops) {
  const line = reader.scrollTop + reader.clientHeight * READING_LINE;
  return lastAtOrBefore(chunkTops, line);
}
