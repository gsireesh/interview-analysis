/* Saved quotes: the selection bar, the sidebar list, and their edits.
 *
 * Every change writes to disk immediately, so there is no save step and nothing
 * to lose if the tab closes.
 */

import { api, escapeHtml, formatTime } from "./util.js";
import { applyHighlights, flashCue, scrollToChunk, selectionAnchors } from "./transcript.js";
import { seekAndPlay } from "./player.js";

export function initHighlights(ctx) {
  renderSwatches(ctx);
  bindQuoteBar(ctx);
  bindList(ctx);
  renderList(ctx);
}

/* --------------------------------------------------------- selection bar -- */

function renderSwatches(ctx) {
  ctx.el.quotebarColors.innerHTML = ctx.colors
    .map(
      (color) =>
        `<button class="swatch swatch--${color}" type="button" data-color="${color}" title="Save as ${color}" aria-label="Save as ${color}"></button>`
    )
    .join("");
}

function bindQuoteBar(ctx) {
  const bar = ctx.el.quotebar;

  document.addEventListener("selectionchange", () => {
    // Let the selection settle before measuring it.
    clearTimeout(ctx.selectionTimer);
    ctx.selectionTimer = setTimeout(() => refreshQuoteBar(ctx), 120);
  });

  bar.addEventListener("mousedown", (event) => event.preventDefault());

  ctx.el.quotebarColors.addEventListener("click", (event) => {
    const swatch = event.target.closest(".swatch");
    if (swatch) save(ctx, { color: swatch.dataset.color });
  });

  ctx.el.quotebarNote.addEventListener("click", () => save(ctx, { focusNote: true }));
  ctx.el.quotebarCopy.addEventListener("click", () => copySelection(ctx));
}

function refreshQuoteBar(ctx) {
  const anchors = selectionAnchors(ctx);
  ctx.pendingSelection = anchors;
  const bar = ctx.el.quotebar;

  if (!anchors) {
    bar.hidden = true;
    return;
  }

  ctx.el.quotebarTime.textContent = `→ ${formatTime(anchors.estimated_start)}`;
  bar.hidden = false;

  const rect = anchors.rect;
  const width = bar.offsetWidth || 260;
  const left = Math.min(
    Math.max(8, rect.left + rect.width / 2 - width / 2),
    window.innerWidth - width - 8
  );
  const above = rect.top - bar.offsetHeight - 10;
  bar.style.left = `${left}px`;
  bar.style.top = `${above > 8 ? above : rect.bottom + 10}px`;
}

export function hideQuoteBar(ctx) {
  ctx.el.quotebar.hidden = true;
  ctx.pendingSelection = null;
}

export async function save(ctx, { color, focusNote = false } = {}) {
  const anchors = ctx.pendingSelection || selectionAnchors(ctx);
  if (!anchors) {
    ctx.notify("Select some text first.");
    return;
  }

  try {
    const { highlight, known_tags: knownTags } = await api(
      `/api/recordings/${ctx.recordingId}/highlights`,
      {
        method: "POST",
        body: {
          text: anchors.text,
          start_cue_id: anchors.start_cue_id,
          start_char_offset: anchors.start_char_offset,
          end_cue_id: anchors.end_cue_id,
          end_char_offset: anchors.end_char_offset,
          speaker: anchors.speaker,
          color: color || ctx.colors[0],
        },
      }
    );
    ctx.highlights.push(highlight);
    ctx.knownTags = knownTags;
    window.getSelection()?.removeAllRanges();
    hideQuoteBar(ctx);
    // Mark it inline too, so the transcript and the sidebar agree on which quote
    // was just added.
    ctx.activeHighlightId = highlight.id;
    applyHighlights(ctx);
    ctx.showTab("highlights");
    renderList(ctx);
    revealQuote(ctx, highlight.id, { focusNote });
  } catch (error) {
    ctx.notify(`Could not save the quote: ${error.message}`);
  }
}

export function copySelection(ctx) {
  const anchors = ctx.pendingSelection || selectionAnchors(ctx);
  if (!anchors) return;
  const speaker = anchors.speaker ? `${anchors.speaker} ` : "";
  const line = `"${anchors.text}" — ${speaker}(${formatTime(anchors.estimated_start)})`;
  navigator.clipboard?.writeText(line).then(
    () => ctx.notify("Quote copied."),
    () => ctx.notify("Could not reach the clipboard.")
  );
}

/* ----------------------------------------------------------------- list -- */

export function renderList(ctx) {
  const list = ctx.el.highlightList;
  ctx.el.highlightCount.textContent = String(ctx.highlights.length);

  // A filter whose last quote just lost the tag would otherwise strand the list
  // showing nothing, with no way back except clicking a button that is now gone.
  const counts = tagsInUse(ctx);
  if (ctx.tagFilter && !counts.has(ctx.tagFilter)) ctx.tagFilter = null;

  const visible = ctx.tagFilter
    ? ctx.highlights.filter((h) => (h.tags || []).includes(ctx.tagFilter))
    : ctx.highlights;

  renderTagFilters(ctx, counts);

  if (!visible.length) {
    list.innerHTML = ctx.highlights.length
      ? '<p class="empty">No quotes with that tag.</p>'
      : '<p class="empty">Select text in the transcript to save a quote. Quotes are written to a JSON file next to the recording.</p>';
    return;
  }

  const ordered = [...visible].sort((a, b) => a.start_time - b.start_time);
  list.innerHTML = ordered
    .map(
      (highlight) => `
      <article class="quote quote--${highlight.color}" data-id="${highlight.id}">
        <p class="quote__text" data-action="jump">${escapeHtml(highlight.text)}</p>
        <div class="quote__meta">
          <span class="quote__speaker">${escapeHtml(highlight.speaker || "—")}</span>
          <time>${formatTime(highlight.start_time)}</time>
          <span class="quote__tools">
            <span class="swatches">
              ${ctx.colors
                .map(
                  (color) =>
                    `<button class="swatch swatch--${color}" type="button" data-action="color" data-color="${color}" aria-pressed="${color === highlight.color}" aria-label="${color}"></button>`
                )
                .join("")}
            </span>
            <button class="icon-btn" type="button" data-action="copy" title="Copy quote">⧉</button>
            <button class="icon-btn" type="button" data-action="delete" title="Delete quote">✕</button>
          </span>
        </div>
        <textarea class="quote__note" rows="1" placeholder="Note" data-action="note">${escapeHtml(highlight.note || "")}</textarea>
        <input class="quote__tags-input" type="text" placeholder="Tags, comma separated"
               list="known-tags" value="${escapeHtml((highlight.tags || []).join(", "))}" data-action="tags">
      </article>`
    )
    .join("");

  list.insertAdjacentHTML(
    "beforeend",
    `<datalist id="known-tags">${ctx.knownTags.map((tag) => `<option value="${escapeHtml(tag)}"></option>`).join("")}</datalist>`
  );
}

/** Tags that are actually on a quote right now, with how many carry each.
 *
 * Deliberately not ``knownTags``: that keeps every tag ever typed so it can be
 * offered for autocomplete, but a filter for a tag with nothing behind it is a
 * dead end. History belongs in the input, reality belongs in the filter.
 */
function tagsInUse(ctx) {
  const counts = new Map();
  for (const highlight of ctx.highlights) {
    for (const tag of highlight.tags || []) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  return new Map([...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

function renderTagFilters(ctx, counts) {
  if (!counts.size) {
    ctx.el.tagFilters.innerHTML = "";
    return;
  }
  ctx.el.tagFilters.innerHTML = [...counts.entries()]
    .map(
      ([tag, count]) =>
        `<button class="tag" type="button" data-tag="${escapeHtml(tag)}" aria-pressed="${ctx.tagFilter === tag}">` +
        `${escapeHtml(tag)}<span class="tag__count">${count}</span></button>`
    )
    .join("");
}

/** Bring a newly saved quote into view in the sidebar and mark it. */
export function revealQuote(ctx, highlightId, { focusNote = false } = {}) {
  const card = ctx.el.highlightList.querySelector(`[data-id="${highlightId}"]`);
  if (!card) return;
  card.scrollIntoView({ block: "nearest", behavior: "smooth" });
  card.classList.add("quote--new");
  setTimeout(() => card.classList.remove("quote--new"), 1800);
  // Keyboard focus is only taken when a note was explicitly asked for --
  // otherwise the next `j` would type into a textarea instead of moving on.
  if (focusNote) card.querySelector(".quote__note")?.focus();
}

function bindList(ctx) {
  ctx.el.tagFilters.addEventListener("click", (event) => {
    const button = event.target.closest(".tag");
    if (!button) return;
    ctx.tagFilter = ctx.tagFilter === button.dataset.tag ? null : button.dataset.tag;
    renderList(ctx);
  });

  ctx.el.highlightList.addEventListener("click", async (event) => {
    const card = event.target.closest(".quote");
    if (!card) return;
    const highlight = ctx.highlights.find((h) => h.id === card.dataset.id);
    if (!highlight) return;
    const action = event.target.closest("[data-action]")?.dataset.action;

    if (action === "jump") {
      jumpToHighlight(ctx, highlight);
    } else if (action === "color") {
      await patch(ctx, highlight, { color: event.target.dataset.color });
    } else if (action === "copy") {
      const speaker = highlight.speaker ? `${highlight.speaker} ` : "";
      navigator.clipboard
        ?.writeText(`"${highlight.text}" — ${speaker}(${formatTime(highlight.start_time)})`)
        .then(() => ctx.notify("Quote copied."));
    } else if (action === "delete") {
      await remove(ctx, highlight);
    }
  });

  const commit = async (event) => {
    const field = event.target.closest("[data-action]");
    if (!field) return;
    const card = field.closest(".quote");
    const highlight = ctx.highlights.find((h) => h.id === card?.dataset.id);
    if (!highlight) return;

    if (field.dataset.action === "note" && field.value !== (highlight.note || "")) {
      await patch(ctx, highlight, { note: field.value }, { rerender: false });
    }
    if (field.dataset.action === "tags") {
      const tags = field.value.split(",").map((tag) => tag.trim()).filter(Boolean);
      if (tags.join("|") !== (highlight.tags || []).join("|")) {
        await patch(ctx, highlight, { tags });
      }
    }
  };

  ctx.el.highlightList.addEventListener("change", commit);
  ctx.el.highlightList.addEventListener("focusout", commit);
}

function jumpToHighlight(ctx, highlight) {
  const cue = ctx.cueById.get(highlight.start_cue_id);
  if (!cue) return;
  const chunk = ctx.chunks.find((c) => c.cue_ids.includes(cue.id));
  ctx.activeHighlightId = highlight.id;
  if (chunk) scrollToChunk(ctx, chunk.id);
  flashCue(ctx, cue.id);
  seekAndPlay(ctx, highlight.start_time);
  applyHighlights(ctx);
}

async function patch(ctx, highlight, body, { rerender = true } = {}) {
  try {
    const response = await api(
      `/api/recordings/${ctx.recordingId}/highlights/${highlight.id}`,
      { method: "PATCH", body }
    );
    Object.assign(highlight, response.highlight);
    ctx.knownTags = response.known_tags;
    applyHighlights(ctx);
    if (rerender) renderList(ctx);
  } catch (error) {
    ctx.notify(`Could not update the quote: ${error.message}`);
  }
}

async function remove(ctx, highlight) {
  try {
    await api(`/api/recordings/${ctx.recordingId}/highlights/${highlight.id}`, { method: "DELETE" });
    ctx.highlights = ctx.highlights.filter((h) => h.id !== highlight.id);
    applyHighlights(ctx);
    renderList(ctx);
  } catch (error) {
    ctx.notify(`Could not delete the quote: ${error.message}`);
  }
}
