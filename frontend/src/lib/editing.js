/* The parts of correcting a transcript that are arithmetic.
 *
 * Cue ids are positional (`c0`, `c1`, …), so cutting or joining a caption
 * renumbers everything after it. The blocks a reader has manually broken open
 * are tracked by cue id, which means they have to move too -- otherwise a split
 * you opened before the edit reopens some unrelated caption after it.
 */

/** Where the word containing an offset starts. */
export function wordStartAt(text, offset) {
  const at = Math.max(0, Math.min(offset, text.length));
  if (/\s/.test(text[at] ?? " ")) {
    const ahead = text.slice(at).search(/\S/);
    return ahead < 0 ? at : at + ahead;
  }
  let start = at;
  while (start > 0 && !/\s/.test(text[start - 1])) start -= 1;
  return start;
}

/** After a caption was cut in two, shift the open splits past the cut. */
export function remapSplitCues(splitCues, [head, tail]) {
  const at = Number(head.slice(1));
  const moved = new Set();
  for (const id of splitCues) {
    const index = Number(id.slice(1));
    moved.add(index > at ? `c${index + 1}` : id);
  }
  // Both halves stay open, so the split you just made is visible.
  if (moved.has(head)) moved.add(tail);
  return moved;
}

/** After a run of captions was joined, close the gap they left behind. */
export function remapJoinedCues(splitCues, survivor, joined) {
  const at = Number(survivor.slice(1));
  const gone = joined - 1;
  const moved = new Set();
  let touched = false;
  for (const id of splitCues) {
    const index = Number(id.slice(1));
    if (index >= at && index <= at + gone) {
      touched = true; // any of the absorbed captions was open
      continue;
    }
    moved.add(index > at + gone ? `c${index - gone}` : id);
  }
  if (touched) moved.add(survivor);
  return moved;
}

/** Where the caret sits in a line, measured in that line's own characters. */
export function caretOffset(field, offsetWithin) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!field.contains(range.startContainer) && range.startContainer !== field) return null;
  return offsetWithin(field, range.startContainer, range.startOffset);
}

export function placeCaretAtEnd(element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

// Safari and Chrome support plaintext-only; elsewhere paste is sanitised.
export const PLAINTEXT_ONLY = (() => {
  const probe = document.createElement("div");
  probe.setAttribute("contenteditable", "plaintext-only");
  return probe.contentEditable === "plaintext-only";
})();
