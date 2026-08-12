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
 */

import { api, escapeHtml, formatTime } from "./util.js";
import { applyHighlights, refreshChunk } from "./transcript.js";
import { cue, seekAndPlay } from "./player.js";

// Safari and Chrome support plaintext-only; fall back to sanitizing paste.
const PLAINTEXT_ONLY = (() => {
  const probe = document.createElement("div");
  probe.setAttribute("contenteditable", "plaintext-only");
  return probe.contentEditable === "plaintext-only";
})();

export function isEditing(ctx) {
  return ctx.editingChunk != null;
}

export function enterEdit(ctx, chunkIndex) {
  if (ctx.editingChunk === chunkIndex) return;
  if (isEditing(ctx)) exitEdit(ctx);

  const chunk = ctx.chunks[chunkIndex];
  const article = ctx.chunkEls[chunkIndex];
  if (!chunk || !article) return;

  ctx.editingChunk = chunkIndex;
  article.classList.add("chunk--editing");

  const body = article.querySelector(".chunk__body");
  const lines = document.createElement("div");
  lines.className = "cue-lines";

  for (const cueId of chunk.cue_ids) {
    const item = ctx.cueById.get(cueId);
    if (!item) continue;
    const row = document.createElement("div");
    row.className = "cue-line";
    row.dataset.cueId = cueId;
    row.innerHTML = `
      <button class="cue-line__play" type="button" title="Play this line" aria-label="Play this line">▶</button>
      <span class="cue-line__time">${formatTime(item.start)}</span>
      <input class="cue-line__who" list="known-speakers" value="${escapeHtml(item.speaker || "")}"
             placeholder="who said this" aria-label="Speaker for the line at ${formatTime(item.start)}">
      <div class="cue-line__text" contenteditable="${PLAINTEXT_ONLY ? "plaintext-only" : "true"}"
           spellcheck="true" role="textbox" aria-label="Transcript line at ${formatTime(item.start)}"></div>`;
    row.querySelector(".cue-line__text").textContent = item.text;
    lines.appendChild(row);
  }

  const bar = document.createElement("div");
  bar.className = "edit-bar";
  // Zoom attributes badly, so who said a line is as editable as what they said.
  bar.innerHTML =
    `<span class="edit-bar__hint">Editing ${chunk.cue_ids.length} line${chunk.cue_ids.length === 1 ? "" : "s"} · Enter saves and moves on · Esc finishes</span>` +
    `<datalist id="known-speakers">${(ctx.data?.transcript?.speakers || [])
      .map((name) => `<option value="${escapeHtml(name)}"></option>`)
      .join("")}</datalist>` +
    `<button class="edit-bar__done" type="button">Done</button>`;

  body.dataset.reading = "";
  body.replaceChildren(bar, lines);

  bar.querySelector(".edit-bar__done").addEventListener("click", () => exitEdit(ctx));
  bindLines(ctx, lines);

  const first = lines.querySelector(".cue-line__text");
  if (first) {
    first.focus();
    placeCaretAtEnd(first);
  }
}

function placeCaretAtEnd(element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function bindLines(ctx, container) {
  container.addEventListener("click", (event) => {
    const play = event.target.closest(".cue-line__play");
    if (!play) return;
    const item = ctx.cueById.get(play.closest(".cue-line").dataset.cueId);
    if (item) seekAndPlay(ctx, item.start, { play: true });
  });

  container.addEventListener("focusin", (event) => {
    const field = event.target.closest(".cue-line__text");
    if (!field) return;
    field.dataset.original = field.textContent;
    const item = ctx.cueById.get(field.closest(".cue-line").dataset.cueId);
    // Silently cue the player to the line being corrected, so replaying it is
    // one keypress away. Never interrupts playback already in progress.
    if (item) cue(ctx, item.start);
  });

  container.addEventListener("focusout", (event) => {
    const field = event.target.closest(".cue-line__text");
    if (field) commit(ctx, field);
  });

  container.addEventListener("change", (event) => {
    const who = event.target.closest(".cue-line__who");
    if (who) reattribute(ctx, who);
  });

  if (!PLAINTEXT_ONLY) {
    container.addEventListener("paste", (event) => {
      if (!event.target.closest(".cue-line__text")) return;
      event.preventDefault();
      const text = (event.clipboardData || window.clipboardData).getData("text");
      document.execCommand("insertText", false, text.replace(/\s+/g, " "));
    });
  }

  container.addEventListener("keydown", (event) => {
    const field = event.target.closest(".cue-line__text");
    if (!field) return;

    if (event.key === "Enter") {
      event.preventDefault();
      const rows = Array.from(container.querySelectorAll(".cue-line__text"));
      const next = rows[rows.indexOf(field) + 1];
      if (next) {
        next.focus();
        placeCaretAtEnd(next);
      } else {
        field.blur();
        exitEdit(ctx);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      // Abandon this line's changes, then leave edit mode.
      field.textContent = field.dataset.original ?? field.textContent;
      field.dataset.skip = "1";
      exitEdit(ctx);
    }
  });
}

async function commit(ctx, field) {
  if (field.dataset.skip) {
    delete field.dataset.skip;
    return;
  }
  const row = field.closest(".cue-line");
  const cueId = row?.dataset.cueId;
  const item = ctx.cueById.get(cueId);
  if (!item) return;

  const text = field.textContent.replace(/\s+/g, " ").trim();
  if (!text || text === item.text) {
    field.textContent = item.text;
    return;
  }

  row.classList.add("cue-line--saving");
  try {
    const result = await api(`/api/recordings/${ctx.recordingId}/cues/${cueId}`, {
      method: "PATCH",
      body: { text },
    });
    item.text = result.cue.text;
    field.textContent = result.cue.text;

    // Quotes overlapping this line were re-anchored server-side; take the
    // updated copies so the sidebar and the inline marks stay in step.
    for (const updated of result.highlights || []) {
      const existing = ctx.highlights.find((h) => h.id === updated.id);
      if (existing) Object.assign(existing, updated);
    }
    if (result.highlights?.length) ctx.onHighlightsChanged?.();

    if (result.backup_created) {
      ctx.notify(`Original transcript saved as ${result.backup_created}.`);
    }
    row.classList.remove("cue-line--saving");
    row.classList.add("cue-line--saved");
    setTimeout(() => row.classList.remove("cue-line--saved"), 1200);
  } catch (error) {
    row.classList.remove("cue-line--saving");
    row.classList.add("cue-line--failed");
    field.textContent = item.text;
    ctx.notify(`Could not save that line: ${error.message}`, { kind: "warn", key: null });
  }
}

/** Say who actually said this line, and let the blocks reform around it. */
async function reattribute(ctx, field) {
  const row = field.closest(".cue-line");
  const cueId = row?.dataset.cueId;
  const item = ctx.cueById.get(cueId);
  if (!item) return;

  const speaker = field.value.replace(/\s+/g, " ").trim();
  if (!speaker || speaker === (item.speaker || "")) {
    field.value = item.speaker || "";
    return;
  }

  row.classList.add("cue-line--saving");
  try {
    const result = await api(`/api/recordings/${ctx.recordingId}/cues/${cueId}/speaker`, {
      method: "PATCH",
      body: { speaker },
    });
    if (result.backup_created) {
      ctx.notify(`Original transcript saved as ${result.backup_created}.`);
    }
    // Reattributing regroups the whole transcript, so the reader takes it back
    // wholesale rather than trying to patch blocks in place.
    ctx.onTranscriptChanged?.(result.recording, { keepEditingCue: cueId });
  } catch (error) {
    row.classList.remove("cue-line--saving");
    field.value = item.speaker || "";
    ctx.notify(`Could not reassign that line: ${error.message}`, { kind: "warn", key: null });
  }
}

export function exitEdit(ctx) {
  const index = ctx.editingChunk;
  if (index == null) return;
  ctx.editingChunk = null;

  const article = ctx.chunkEls[index];
  if (article) article.classList.remove("chunk--editing");
  refreshChunk(ctx, index);
  applyHighlights(ctx);
}
