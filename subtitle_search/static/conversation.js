/* The Conversation pane: the participant's chat, its highlights, and their conversation codes.
 *
 * The chat arrives as HTML rendered on the server (conversation.py), with one
 * anchor element per message carrying `data-message-id`. A highlight is stored as
 * a start and an end message with a character offset into each anchor's text
 * nodes. Painting wraps the covered text-node pieces in marks, so the Markdown
 * markup survives, and it starts from the server's HTML every time.
 *
 * A highlight whose covered text no longer equals its stored text (the chat file
 * was replaced, or a reply renders differently) is not painted; its card comes
 * first and says "words not found", and it can still be coded, noted and deleted.
 *
 * Cards sit in a column beside the messages inside the same scroll body, each
 * level with its highlight, packed by highlights.js packCards.
 */

import { $, api, escapeHtml } from "./util.js";
import { offsetWithin } from "./transcript.js";
import { hideQuoteBar, otherCard, ownCard, packCards } from "./highlights.js";
import { mountTagFields } from "./tagfield.js";
import { isCommon, isMine, visibleNow } from "./coder.js";
import { openMoveDialog, returnToCoders } from "./commondialog.js";
import { renderStrip } from "./codestrip.js";

const esc = escapeHtml;
const CARD_GAP = 6;

export function initConversation(ctx) {
  ctx.conv = {
    data: ctx.data.conversation,
    highlights: ctx.data.conversation_highlights || [],
    codes: [],
    colors: [],
    vocabulary: [],
    filter: null,     // code id the cards are narrowed to
    activeId: null,   // the highlight last clicked or saved
    missing: new Set(), // ids of highlights whose words are not found
    anchors: new Map(), // message id -> its anchor element in the pane
    loaded: false,    // whether the codebook has arrived, before which a field would show no codes
  };
  Object.assign(ctx.el, {
    convCount: $("conv-count"),
    convFilters: $("conv-filters"),
    convBody: $("conv-body"),
    convMessages: $("conv-messages"),
    convCards: $("conv-cards"),
  });

  bindCards(ctx);
  ctx.el.convMessages.addEventListener("click", (event) => {
    const mark = event.target.closest("mark.hl");
    // A drag that ends on a mark is a selection, not a click on the highlight.
    if (!mark || !window.getSelection()?.isCollapsed) return;
    ctx.conv.activeId = mark.dataset.highlightId;
    levelCards(ctx);
  });
  let pending;
  ctx.el.convCards.addEventListener("input", () => {
    clearTimeout(pending);
    pending = setTimeout(() => levelCards(ctx), 150);
  });

  ctx.onConversationModeChange = () => {
    ctx.conv.activeId = null;
    render(ctx);
  };
  ctx.levelConversation = () => levelCards(ctx);
  ctx.revealConversation = (id) => reveal(ctx, id);

  render(ctx);
  refreshCodebook(ctx).catch((error) =>
    ctx.notify(`Could not load the conversation codes: ${error.message}`, { kind: "warn", key: null })
  );
}

/**
 * Re-read the highlights and the conversation codebook, and redraw.
 *
 * @param payload  a fresh recording payload (after Sync), whose chat and highlights are taken as they are;
 *                 without one, only the highlights are fetched, and not while a card field has focus or a
 *                 selection waits in the pane, since redrawing would drop either
 */
export async function reloadConversation(ctx, payload) {
  if (!ctx.conv) return;
  if (payload) {
    ctx.conv.data = payload.conversation;
    ctx.conv.highlights = payload.conversation_highlights || [];
  } else {
    if (ctx.el.convCards.contains(document.activeElement) || ctx.pendingConversation) return;
    ctx.conv.highlights = (await api(`/api/recordings/${ctx.recordingId}/conversation-highlights`)).highlights;
  }
  paint(ctx);
  await refreshCodebook(ctx);
}

function render(ctx) {
  paint(ctx);
  renderCards(ctx);
}

/* ------------------------------------------------------------- text -- */

/** The length of an anchor's text, counted over its text nodes as offsets are. */
const textLength = (el) => el.textContent.length;

/**
 * The offset of a selection boundary within an anchor.
 *
 * transcript.js offsetWithin counts a text-node or anchor boundary. A boundary inside one of the
 * anchor's Markdown elements is counted by a range from the anchor's start, whose text is its text nodes.
 */
function boundaryOffset(anchor, node, offset) {
  if (node === anchor || node.nodeType === Node.TEXT_NODE) return offsetWithin(anchor, node, offset);
  const range = document.createRange();
  range.setStart(anchor, 0);
  range.setEnd(node, offset);
  return range.toString().length;
}

/** The text of an anchor between two offsets, with a line break for each <br> inside them. */
function readText(el, from, to) {
  let pos = 0;
  let out = "";
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.nodeValue.slice(Math.max(from - pos, 0), Math.max(to - pos, 0));
      pos += node.nodeValue.length;
    } else if (node.nodeName === "BR" && pos > from && pos < to) {
      out += "\n";
    }
  }
  return out;
}

/**
 * The anchor pieces a highlight covers, in display order, or null when its anchors cannot be found.
 *
 * @returns [{el, from, to}], one per message from the start message to the end message
 */
function segmentsOf(ctx, highlight) {
  const order = ctx.conv.data?.order || [];
  const first = order.indexOf(highlight.start_message_id);
  const last = order.indexOf(highlight.end_message_id);
  if (first < 0 || last < first) return null;
  const segments = [];
  for (let i = first; i <= last; i += 1) {
    const el = ctx.conv.anchors.get(order[i]);
    if (!el) return null;
    const length = textLength(el);
    const from = i === first ? highlight.start_char_offset : 0;
    const to = i === last ? highlight.end_char_offset : length;
    if (from > length || to > length || to < from) return null;
    segments.push({ el, from, to });
  }
  return segments;
}

//: The text of a run of pieces, one line per message; the same reading saves a highlight and checks it.
const textOf = (segments) => segments.map((s) => readText(s.el, s.from, s.to)).join("\n");

/* ---------------------------------------------------------- painting -- */

/** Re-render the chat from the server's HTML and paint every highlight the mode shows. */
function paint(ctx) {
  const root = ctx.el.convMessages;
  const conv = ctx.conv;
  conv.missing = new Set();
  root.innerHTML = conv.data ? conv.data.html : `<p class="empty">No conversation.jsonl in this recording's folder.</p>`;
  conv.anchors = new Map([...root.querySelectorAll("[data-message-id]")].map((el) => [el.dataset.messageId, el]));

  for (const highlight of conv.highlights.filter(visibleNow)) {
    const segments = segmentsOf(ctx, highlight);
    if (!segments || textOf(segments).trim() !== String(highlight.text || "").trim()) {
      conv.missing.add(highlight.id);
      continue;
    }
    wrap(segments, highlight, highlight.id === conv.activeId);
  }
}

/** Wrap each text-node piece of the pieces in a mark of the highlight's colour. */
function wrap(segments, highlight, active) {
  const pieces = [];
  for (const { el, from, to } of segments) {
    let pos = 0;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node && pos < to; node = walker.nextNode()) {
      const length = node.nodeValue.length;
      const a = Math.max(from - pos, 0);
      const b = Math.min(to - pos, length);
      // Whitespace between Markdown blocks is counted but not marked: a mark inside a list would draw nothing useful.
      if (a < b && /\S/.test(node.nodeValue.slice(a, b))) pieces.push([node, a, b]);
      pos += length;
    }
  }
  for (const [whole, a, b] of pieces) {
    const node = a > 0 ? whole.splitText(a) : whole;
    if (b - a < node.nodeValue.length) node.splitText(b - a);
    const mark = document.createElement("mark");
    mark.className = `hl hl--${highlight.color}${active ? " hl--active" : ""}`;
    mark.dataset.highlightId = highlight.id;
    node.replaceWith(mark);
    mark.append(node);
  }
}

/* --------------------------------------------------------- selection -- */

/**
 * Resolve the current selection to message anchors, or null when it is not inside the messages.
 *
 * An end outside every anchor (a marker, a label, an avatar) is clamped to the nearest anchor inside
 * the selection: the start to offset 0 of the next one, the end to the end of the previous one.
 *
 * @returns {text, start_message_id, start_char_offset, end_message_id, end_char_offset, rect} | null
 */
export function conversationSelection(ctx) {
  const selection = window.getSelection();
  if (!ctx.conv?.data || !selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const root = ctx.el.convMessages;
  if (!root.contains(range.commonAncestorContainer)) return null;

  const anchors = [...ctx.conv.anchors.values()].filter((el) => range.intersectsNode(el));
  if (!anchors.length) return null;
  let start = { el: anchors[0], offset: 0 };
  if (start.el.contains(range.startContainer)) start.offset = boundaryOffset(start.el, range.startContainer, range.startOffset);
  let end = { el: anchors.at(-1), offset: textLength(anchors.at(-1)) };
  if (end.el.contains(range.endContainer)) end.offset = boundaryOffset(end.el, range.endContainer, range.endOffset);
  // A start at the very end of a message, or an end at the very start of one, selects nothing in it.
  if (anchors.length > 1 && start.offset >= textLength(start.el)) start = { el: anchors[1], offset: 0 };
  if (anchors.length > 1 && end.offset === 0 && end.el !== start.el) {
    const previous = anchors.at(-2);
    end = { el: previous, offset: textLength(previous) };
  }

  const anchor = {
    start_message_id: start.el.dataset.messageId,
    start_char_offset: start.offset,
    end_message_id: end.el.dataset.messageId,
    end_char_offset: end.offset,
  };
  const segments = segmentsOf(ctx, anchor);
  const text = segments ? textOf(segments).trim() : "";
  if (!text) return null;
  return { text, ...anchor, rect: range.getBoundingClientRect() };
}

/** Save the selection as a highlight, from the quote bar or the `h` key. */
export async function saveConversationHighlight(ctx, selection, { color, focusNote = false } = {}) {
  const { rect, ...body } = selection;
  try {
    const { highlight } = await api(`/api/recordings/${ctx.recordingId}/conversation-highlights`, {
      method: "POST",
      body: { ...body, color: color || ctx.colors[0] },
    });
    ctx.conv.highlights.push(highlight);
    window.getSelection()?.removeAllRanges();
    hideQuoteBar(ctx);
    ctx.conv.activeId = highlight.id;
    ctx.layout?.show("conversation");
    render(ctx);
    const card = ctx.el.convCards.querySelector(`[data-id="${highlight.id}"]`);
    if (!card) return;
    card.classList.add("quote--new");
    setTimeout(() => card.classList.remove("quote--new"), 1800);
    if (focusNote) card.querySelector(".quote__note")?.focus();
  } catch (error) {
    ctx.notify(`Could not save the highlight: ${error.message}`);
  }
}

/** Copy the selection with who said it and at which turn. */
export function copyConversationSelection(ctx, selection) {
  copyLine(ctx, selection);
}

function copyLine(ctx, item) {
  navigator.clipboard?.writeText(`${item.text} — ${whereLabel(ctx, item)}`).then(
    () => ctx.notify("Highlight copied."),
    () => ctx.notify("Could not reach the clipboard.")
  );
}

/* ------------------------------------------------------------- cards -- */

/** Who wrote a message and its turn, from the chat when it has the message and from the id otherwise. */
function messageWhere(ctx, id) {
  const message = ctx.conv.data?.messages?.[id];
  // `<conversation_id>:<turn>:<version>:<role>`, read from the right because the conversation id may hold colons.
  const parts = String(id).split(":");
  const role = message?.role ?? parts.at(-1);
  return { who: role === "user" ? "User" : "AI", turn: message?.turn ?? parts.at(-3) };
}

/** "User · turn 1" for one message, "User turn 1 → AI turn 1" across messages. */
function whereLabel(ctx, item) {
  const start = messageWhere(ctx, item.start_message_id);
  if (item.start_message_id === item.end_message_id) return `${start.who} · turn ${start.turn}`;
  const end = messageWhere(ctx, item.end_message_id);
  return `${start.who} turn ${start.turn} → ${end.who} turn ${end.turn}`;
}

function cardMeta(ctx, highlight) {
  const message = ctx.conv.data?.messages?.[highlight.start_message_id];
  const flags = [];
  if (ctx.conv.missing.has(highlight.id)) flags.push(["words not found", " quote__flag--missing"]);
  if (message?.abandoned) flags.push(["abandoned", ""]);
  if (message?.conversation_name) flags.push([`${message.conversation_name} conversation`, ""]);
  return (
    `<span class="quote__where">${esc(whereLabel(ctx, highlight))}</span>` +
    flags.map(([label, kind]) => `<span class="quote__flag${kind}">${esc(label)}</span>`).join("")
  );
}

/** Missing highlights first, then by where they start in the chat. */
function ordered(ctx, highlights) {
  const order = ctx.conv.data?.order || [];
  const position = (h) => {
    const index = order.indexOf(h.start_message_id);
    return index < 0 ? Infinity : index;
  };
  return [...highlights].sort(
    (a, b) =>
      Number(ctx.conv.missing.has(b.id)) - Number(ctx.conv.missing.has(a.id)) ||
      position(a) - position(b) ||
      a.start_char_offset - b.start_char_offset
  );
}

const codeById = (ctx, id) => ctx.conv.codes.find((c) => c.id === id);
const myCodeByName = (ctx, name) =>
  ctx.conv.codes.find((c) => isMine(c) && c.name.toLowerCase() === name.trim().toLowerCase());

/** Load the conversation codebook and the field's suggestions from it, then redraw the strip, or the cards too. */
async function refreshCodebook(ctx, { render: all = true, state } = {}) {
  const book = state || (await api("/api/library/conversation-codebook"));
  ctx.conv.codes = book.codes;
  ctx.conv.colors = book.colors;
  // The field reads text-code use; a conversation code has only its highlight count, which also ranks it.
  ctx.conv.vocabulary = book.codes.map((c) => ({
    ...c,
    tag: c.name,
    quote_count: c.highlight_count,
    recording_count: c.highlight_count,
  }));
  ctx.conv.loaded = true;
  if (all) renderCards(ctx);
  else {
    renderCodeStrip(ctx);
    levelCards(ctx);
  }
}

/** The strip alone, so a code edit on one highlight does not rebuild every card. */
function renderCodeStrip(ctx) {
  const conv = ctx.conv;
  const inMode = conv.highlights.filter(visibleNow);
  const counts = new Map();
  for (const highlight of inMode) {
    for (const id of highlight.codes || []) counts.set(id, (counts.get(id) || 0) + 1);
  }
  const stripCodes = conv.codes
    .filter((c) => (isMine(c) || isCommon(c) ? true : visibleNow(c) && counts.has(c.id)))
    .map((c) => ({ ...c, count: counts.get(c.id) || 0, total: c.highlight_count }));
  if (conv.filter && !stripCodes.some((c) => c.id === conv.filter)) conv.filter = null;
  renderStrip(ctx.el.convFilters, {
    codes: stripCodes,
    filter: conv.filter,
    colors: conv.colors,
    noun: "conversation code",
    kind: "conversation",
    empty: "Add one to a highlight",
    onFilter: (id) => {
      conv.filter = id;
      renderCards(ctx);
    },
    onAction: (action, code, value) => codebookAction(ctx, action, code, value),
  });
  return inMode;
}

function renderCards(ctx) {
  const conv = ctx.conv;
  const list = ctx.el.convCards;
  const inMode = renderCodeStrip(ctx);
  ctx.el.convCount.textContent = String(inMode.length);
  const visible = conv.filter ? inMode.filter((h) => (h.codes || []).includes(conv.filter)) : inMode;

  if (!visible.length) {
    list.innerHTML = inMode.length
      ? '<p class="empty">No highlights with that conversation code.</p>'
      : conv.data
        ? '<p class="empty">Select text in the conversation to save a highlight.</p>'
        : "";
    levelCards(ctx);
    return;
  }

  list.innerHTML = ordered(ctx, visible)
    .map((highlight) => {
      const options = {
        meta: cardMeta(ctx, highlight),
        extra: conv.missing.has(highlight.id) ? " quote--missing" : "",
        noun: "highlight",
      };
      return isMine(highlight) ? ownCard(ctx, highlight, options) : otherCard(ctx, highlight, { ...options, codeOf: (id) => codeById(ctx, id) });
    })
    .join("");

  // Until the codebook has loaded, a field would show a highlight's codes as empty, and saving from it would erase them.
  if (!conv.loaded) {
    levelCards(ctx);
    return;
  }
  mountTagFields(list, {
    noun: "conversation code",
    getTags: (id) =>
      (conv.highlights.find((h) => h.id === id)?.codes || []).map((cid) => codeById(ctx, cid)?.name).filter(Boolean),
    // Your own codes, and the common ones: picking a common name codes with your own same-named code.
    getVocabulary: () => {
      const mine = conv.vocabulary.filter(isMine);
      const names = new Set(mine.map((e) => e.tag.toLowerCase()));
      return [...mine, ...conv.vocabulary.filter((e) => isCommon(e) && !names.has(e.tag.toLowerCase()))];
    },
    use: (entry) => (entry.quote_count ? `${entry.quote_count} highlight${entry.quote_count === 1 ? "" : "s"}` : "nothing on it now"),
    decorate: (name) => {
      const code = myCodeByName(ctx, name);
      return { before: `<i class="chip__swatch vc--${esc(code?.color || "slate")}"></i>` };
    },
    onCommit: (id, names) => {
      const highlight = conv.highlights.find((h) => h.id === id);
      if (highlight) setCodes(ctx, highlight, names);
    },
  });
  levelCards(ctx);
}

/**
 * Line each card up with its highlight, in the one scroll body the messages and cards share.
 *
 * A card's wanted top is its first mark, or its start message when another highlight covers its start.
 * A highlight whose words are not found has nothing to line up with. With the pane collapsed, or no
 * cards, the cards fall back to a list.
 */
function levelCards(ctx) {
  const list = ctx.el.convCards;
  const activeId = ctx.conv.activeId;
  for (const mark of ctx.el.convMessages.querySelectorAll("mark.hl")) {
    mark.classList.toggle("hl--active", mark.dataset.highlightId === activeId);
  }
  const cards = [...list.querySelectorAll(".quote")];
  for (const card of cards) card.classList.toggle("quote--active", card.dataset.id === activeId);
  const canLevel = cards.length && list.offsetParent && ctx.conv.data;
  list.classList.toggle("quotes-level--on", Boolean(canLevel));
  if (!canLevel) return;

  const top = list.getBoundingClientRect().top;
  const wants = cards.map((card) => {
    if (ctx.conv.missing.has(card.dataset.id)) return null;
    const highlight = ctx.conv.highlights.find((h) => h.id === card.dataset.id);
    const anchor =
      ctx.el.convMessages.querySelector(`mark[data-highlight-id="${card.dataset.id}"]`) ||
      (highlight && ctx.conv.anchors.get(highlight.start_message_id));
    return anchor ? anchor.getBoundingClientRect().top - top : null;
  });
  const tops = packCards(cards, wants, cards.findIndex((card) => card.dataset.id === activeId), CARD_GAP);
  cards.forEach((card, i) => (card.style.top = `${tops[i]}px`));
  list.style.setProperty("--level-height", `${tops.at(-1) + cards.at(-1).offsetHeight + CARD_GAP}px`);
}

/** Make a card's highlight active, keeping the card where it is on screen and scrolling its highlight up beside it. */
function lineUpCard(ctx, card, highlight) {
  const list = ctx.el.convCards;
  const before = card.getBoundingClientRect().top;
  ctx.conv.activeId = highlight.id;
  list.classList.add("quotes-level--still");
  levelCards(ctx);
  if (list.classList.contains("quotes-level--on")) {
    const body = ctx.el.convBody;
    body.scrollTo({ top: body.scrollTop + card.getBoundingClientRect().top - before, behavior: "instant" });
  }
  void list.offsetHeight; // Apply the positions before the slide comes back.
  list.classList.remove("quotes-level--still");
}

/** Open the pane at a highlight and make it active, for a `?conv=` link. */
function reveal(ctx, id) {
  ctx.layout?.show("conversation");
  if (!ctx.conv.highlights.some((h) => h.id === id)) return;
  ctx.conv.activeId = id;
  levelCards(ctx);
  const target =
    ctx.el.convMessages.querySelector(`mark[data-highlight-id="${id}"]`) || ctx.el.convCards.querySelector(`[data-id="${id}"]`);
  if (!target) return;
  const body = ctx.el.convBody;
  const offset = target.getBoundingClientRect().top - body.getBoundingClientRect().top;
  body.scrollTo({ top: body.scrollTop + offset - body.clientHeight / 3, behavior: "instant" });
}

function bindCards(ctx) {
  const list = ctx.el.convCards;
  list.addEventListener("click", async (event) => {
    const card = event.target.closest(".quote");
    const highlight = card && ctx.conv.highlights.find((h) => h.id === card.dataset.id);
    if (!highlight) return;
    const action = event.target.closest("[data-action]")?.dataset.action;
    // The text and the card's bare surface line the card up; its controls do not.
    if (action === "jump" || !event.target.closest("button, a, input, textarea, .tagfield")) {
      lineUpCard(ctx, card, highlight);
      return;
    }
    // Another coder's highlight, or a common one, is read-only; only copying applies.
    if (!isMine(highlight) && action !== "copy") return;
    if (action === "color") await patch(ctx, highlight, { color: event.target.dataset.color });
    else if (action === "copy") copyLine(ctx, highlight);
    else if (action === "delete") await remove(ctx, highlight);
  });

  const commit = async (event) => {
    const field = event.target.closest('[data-action="note"]');
    const highlight = field && ctx.conv.highlights.find((h) => h.id === field.closest(".quote")?.dataset.id);
    if (highlight && field.value !== (highlight.note || "")) await patch(ctx, highlight, { note: field.value }, { rerender: false });
  };
  list.addEventListener("change", commit);
  list.addEventListener("focusout", commit);
}

async function patch(ctx, highlight, body, { rerender = true } = {}) {
  try {
    const response = await api(`/api/recordings/${ctx.recordingId}/conversation-highlights/${highlight.id}`, {
      method: "PATCH",
      body,
    });
    Object.assign(highlight, response.highlight);
    if (rerender) render(ctx);
  } catch (error) {
    ctx.notify(`Could not update the highlight: ${error.message}`);
  }
}

async function remove(ctx, highlight) {
  try {
    await api(`/api/recordings/${ctx.recordingId}/conversation-highlights/${highlight.id}`, { method: "DELETE" });
    ctx.conv.highlights = ctx.conv.highlights.filter((h) => h.id !== highlight.id);
    render(ctx);
  } catch (error) {
    ctx.notify(`Could not delete the highlight: ${error.message}`);
  }
}

/** Save the codes named in a highlight's field, adding any new names to your conversation codebook first. */
async function setCodes(ctx, highlight, names) {
  try {
    const ids = [];
    for (const name of names) {
      let code = myCodeByName(ctx, name);
      if (!code) {
        // A name taken from a common code keeps that code's colour and description.
        const common = ctx.conv.codes.find((c) => isCommon(c) && c.name.toLowerCase() === name.trim().toLowerCase());
        const body = common ? { name, color: common.color, description: common.description } : { name };
        const result = await api("/api/library/conversation-codebook", { method: "POST", body });
        ctx.conv.codes = result.codes;
        code = result.code;
      }
      ids.push(code.id);
    }
    await patch(ctx, highlight, { codes: ids }, { rerender: false });
    // Only the strip: rebuilding the cards would take focus out of the field being typed in.
    await refreshCodebook(ctx, { render: false });
  } catch (error) {
    ctx.notify(`Could not save the conversation codes: ${error.message}`, { kind: "warn" });
    renderCards(ctx);
  }
}

/** The strip's ⋯ menu, applied to your own conversation codebook or to a common code. */
async function codebookAction(ctx, action, code, value) {
  const base = `/api/library/conversation-codebook/${code.id}`;
  const reloadHighlights = async () => {
    ctx.conv.highlights = (await api(`/api/recordings/${ctx.recordingId}/conversation-highlights`)).highlights;
    paint(ctx);
  };
  try {
    if (action === "move" || action === "return") {
      const done =
        action === "move"
          ? await openMoveDialog({ kind: "conversation", code, common: ctx.conv.codes.filter(isCommon) })
          : await returnToCoders("conversation", code);
      if (!done) return;
      await reloadHighlights();
      ctx.notify(action === "move" ? `Moved “${code.name}” to common.` : `Returned ✓ ${code.name} to its coders.`);
    }
    if (action === "rename") await api(base, { method: "PATCH", body: { name: value } });
    if (action === "describe") await api(base, { method: "PATCH", body: { description: value } });
    if (action === "color") await api(base, { method: "PATCH", body: { color: value } });
    if (action === "delete") await api(base, { method: "DELETE" });
    if (action === "merge") {
      const result = await api(`${base}/merge`, { method: "POST", body: { into: value } });
      await reloadHighlights();
      ctx.notify(`Merged “${code.name}” (${result.moved} highlight${result.moved === 1 ? "" : "s"}).`);
    }
    if (action === "delete" && ctx.conv.filter === code.id) ctx.conv.filter = null;
  } catch (error) {
    ctx.notify(error.message, { kind: "warn" });
  }
  window.dispatchEvent(new CustomEvent("commonchange"));
  await refreshCodebook(ctx);
}
