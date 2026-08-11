/* Quote search. Exact matches first, then close ones. */

import { api, debounce, escapeHtml, formatTime } from "./util.js";
import { flashCue, scrollToChunk } from "./transcript.js";
import { seekAndPlay } from "./player.js";

const KIND_LABEL = { exact: "exact", fuzzy: "close", regex: "regex" };

export function initSearch(ctx) {
  const { searchInput, regexToggle, searchResults, searchCount } = ctx.el;

  const run = debounce(async () => {
    const query = searchInput.value.trim();
    if (query.length < 2) {
      searchCount.textContent = "";
      searchResults.innerHTML =
        '<p class="empty">Search the transcript to find a quote. Exact matches come first, then close ones.</p>';
      return;
    }

    const mode = regexToggle.getAttribute("aria-pressed") === "true" ? "regex" : "fuzzy";
    const url = `/api/recordings/${ctx.recordingId}/search?q=${encodeURIComponent(query)}&mode=${mode}`;

    try {
      const { results } = await api(url);
      render(ctx, results);
    } catch (error) {
      searchCount.textContent = "";
      searchResults.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
    }
  }, 160);

  searchInput.addEventListener("input", run);
  regexToggle.addEventListener("click", () => {
    const on = regexToggle.getAttribute("aria-pressed") === "true";
    regexToggle.setAttribute("aria-pressed", String(!on));
    run();
  });

  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      searchInput.value = "";
      searchInput.blur();
      run();
    }
    if (event.key === "Enter") {
      const first = searchResults.querySelector(".result");
      if (first) first.click();
    }
  });

  searchResults.addEventListener("click", (event) => {
    const button = event.target.closest(".result");
    if (!button) return;
    searchResults.querySelectorAll(".result--active").forEach((el) => el.classList.remove("result--active"));
    button.classList.add("result--active");
    jumpTo(ctx, button.dataset);
  });
}

function jumpTo(ctx, data) {
  scrollToChunk(ctx, data.chunkId);
  flashCue(ctx, data.cueId);
  seekAndPlay(ctx, Number(data.startTime));
}

function render(ctx, results) {
  const { searchResults, searchCount } = ctx.el;
  searchCount.textContent = results.length ? `${results.length}` : "";

  if (!results.length) {
    searchResults.innerHTML = '<p class="empty">Nothing found. Try fewer words.</p>';
    return;
  }

  searchResults.innerHTML = results
    .map((result) => {
      const before = escapeHtml(result.snippet.slice(0, result.match_start));
      const hit = escapeHtml(result.snippet.slice(result.match_start, result.match_end));
      const after = escapeHtml(result.snippet.slice(result.match_end));
      const speaker = result.speaker ? escapeHtml(result.speaker) : "—";
      const kind = result.kind === "exact" ? "" : `<span class="result__kind">${KIND_LABEL[result.kind] || result.kind}</span>`;
      return `
        <button class="result" type="button"
                data-chunk-id="${result.chunk_id}"
                data-cue-id="${result.cue_id}"
                data-start-time="${result.start_time}">
          <span class="result__head">
            <span class="result__speaker">${speaker}</span>
            ${kind}
            <span class="result__time">${formatTime(result.start_time)}</span>
          </span>
          <p class="result__text">${before}<mark>${hit}</mark>${after}</p>
        </button>`;
    })
    .join("");
}
