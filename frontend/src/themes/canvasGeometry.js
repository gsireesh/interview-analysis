/* The arithmetic of the plane: packing, boxes, and what a point falls inside.
 *
 * All of it pure, which is why it could come across from the hand-written canvas
 * untouched -- the only change is that the state it used to reach for through a
 * module-level `ctx` now arrives as arguments.
 */

export function packColumns(metrics, width) {
  const { card_w, card_gap, area_pad } = metrics;
  return Math.max(1, Math.floor((width - 2 * area_pad + card_gap) / (card_w + card_gap)));
}

export function packSlot(metrics, index, columns) {
  const { card_w, card_h, card_gap, area_pad, area_head } = metrics;
  return {
    x: area_pad + (index % columns) * (card_w + card_gap),
    y: area_head + Math.floor(index / columns) * (card_h + card_gap),
  };
}

export function packHeight(metrics, count, width) {
  const { card_h, card_gap, area_pad, area_head } = metrics;
  const rows = Math.max(1, Math.ceil(Math.max(1, count) / packColumns(metrics, width)));
  return area_head + rows * (card_h + card_gap) - card_gap + area_pad;
}

/**
 * Where a card falls when an area is packed: by speaker, then by time.
 *
 * Who said it first, because a theme read down a column of one voice at a time
 * is a theme you can argue with -- the same person's three remarks about trust
 * sit together, and the place where somebody else takes over is visible. Then
 * time, so each voice runs in the order it was said rather than in the order it
 * happened to be dragged out.
 *
 * Quotes with nobody attributed sort last: they are the ones to fix, not the
 * ones to read first. Recording only breaks ties, so the same cards always come
 * out in the same order.
 *
 * The server applies the same rule when it tidies an area for good. Two
 * spellings of one sentence, kept in step by `packing_key` in library.py --
 * which is the cheaper mistake, since the alternative is asking the server to
 * re-sort on every redraw of a view that writes nothing at all.
 */
export function packingKey(byRef, card) {
  const quote = byRef.get(card.ref);
  if (!quote) return [2, "", 0, ""];
  const speaker = (quote.speaker || "").trim();
  return [speaker ? 0 : 1, speaker.toLowerCase(), quote.start_time || 0, quote.recording_id || ""];
}

export function packingOrder(byRef, cards) {
  return [...cards].sort((a, b) => {
    const ka = packingKey(byRef, a);
    const kb = packingKey(byRef, b);
    for (let i = 0; i < ka.length; i += 1) {
      if (ka[i] < kb[i]) return -1;
      if (ka[i] > kb[i]) return 1;
    }
    return 0;
  });
}

/** Where an area's cards are drawn: as placed, or packed for grid view. */
export function laidOut({ metrics, byRef, gridView }, theme, cards) {
  if (!gridView) return cards;
  const columns = packColumns(metrics, theme.w);
  return packingOrder(byRef, cards).map((card, index) => ({
    ...card,
    ...packSlot(metrics, index, columns),
  }));
}

/**
 * The height to draw an area at, from state alone.
 *
 * Kept free of the DOM on purpose: this decides the inline height in the markup,
 * and a version that measured the previous render would feed its own output back
 * in and ratchet upwards. Rolled up, CSS sizes the box to its bar and nothing is
 * written here at all.
 */
export function drawnHeight({ metrics, cards, gridView }, theme) {
  if (theme.collapsed) return null;
  if (!gridView) return theme.h;
  const count = cards.filter((c) => c.theme_id === theme.id).length;
  return Math.max(theme.h, packHeight(metrics, count, theme.w));
}

/**
 * The box an area actually occupies, which is not always the one it stores.
 *
 * Rolled up it is as tall as its title bar; in grid view as tall as the packing
 * needs; and zoomed far out, as tall as a wrapped title has made that bar. All
 * three are drawing decisions rather than edits, so the stored height stays put
 * and this reports what is on screen -- which is what a drop has to be tested
 * against, and the only version of the box that is right in every case.
 */
export function areaBox(state, surface, theme) {
  const node = surface?.querySelector(`.area[data-theme="${CSS.escape(theme.id)}"]`);
  // offsetWidth/Height are in canvas units: layout ignores the transform.
  if (node) return { ...theme, w: node.offsetWidth, h: node.offsetHeight };
  return { ...theme, h: drawnHeight(state, theme) ?? state.metrics.area_head };
}

/**
 * Which area a point on the plane falls in.
 *
 * Areas do not nest, so overlap is only ever clutter to be dragged apart -- but
 * while it is there, the smallest area containing the point is the one meant.
 * A big area sitting behind a small one is a backdrop, not the target.
 */
export function areaAt(state, surface, point) {
  return (
    state.themes
      .map((theme) => areaBox(state, surface, theme))
      .filter(
        (t) => point.x >= t.x && point.x <= t.x + t.w && point.y >= t.y && point.y <= t.y + t.h
      )
      .sort((a, b) => a.w * a.h - b.w * b.h)[0] || null
  );
}

/** Keep a card's own position inside the area it belongs to. */
export function clampToArea(metrics, theme, x, y) {
  const { card_w, card_h, area_pad, area_head } = metrics;
  return {
    x: Math.min(Math.max(x, area_pad), Math.max(area_pad, theme.w - area_pad - card_w)),
    y: Math.min(Math.max(y, area_head), Math.max(area_head, theme.h - area_pad - card_h)),
  };
}

/* ------------------------------------------------------------- the tray -- */

/**
 * Whether one quote answers the filter bar.
 *
 * Every dimension is an "and": the reason to have six of them is to arrive at a
 * handful, not at a longer list.
 */
export function matches(quote, active) {
  const tags = quote.tags || [];
  if (active.tag === "state:any" && !tags.length) return false;
  if (active.tag === "state:none" && tags.length) return false;
  if (active.tag.startsWith("tag:") && !tags.includes(active.tag.slice(4))) return false;
  if (active.speaker && (quote.speaker || "") !== active.speaker) return false;
  if (active.recording && quote.recording_id !== active.recording) return false;
  if (active.color && (quote.color || "amber") !== active.color) return false;
  if (active.note === "yes" && !(quote.note || "").trim()) return false;
  if (active.note === "no" && (quote.note || "").trim()) return false;
  if (!active.text) return true;
  return (
    quote.text.toLowerCase().includes(active.text) ||
    (quote.note || "").toLowerCase().includes(active.text) ||
    tags.some((tag) => tag.toLowerCase().includes(active.text)) ||
    (quote.speaker || "").toLowerCase().includes(active.text)
  );
}

export const SORTS = {
  // The corpus order: recording, then time within it. Reading order, in effect.
  recording: null,
  longest: (a, b) => b.text.length - a.text.length,
  shortest: (a, b) => a.text.length - b.text.length,
  tags: (a, b) => (b.tags || []).length - (a.tags || []).length,
};

export function anyFilter(active) {
  return Boolean(
    active.text || active.tag || active.speaker || active.recording || active.color || active.note
  );
}

export const EMPTY_FILTERS = {
  text: "",
  tag: "",
  speaker: "",
  recording: "",
  color: "",
  note: "",
  sort: "recording",
};
