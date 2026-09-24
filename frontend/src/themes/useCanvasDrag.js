/* Every drag is the same drag.
 *
 * One pointer capture, one ghost element following the cursor in screen space.
 * Dragging a quote out of the tray, out of one area into another, and back to
 * the tray to put it away are the same code path, so they cannot behave
 * differently -- which is why this stays imperative rather than being split into
 * a handler per target.
 *
 * Live positions are written to node.style during the drag and committed to
 * state only on release: optimistic in the DOM, authoritative on the server.
 */

import { useCallback, useEffect, useRef } from "react";

const SLOP = 4;

function pointerOver(node, clientX, clientY) {
  if (!node || node.hidden) return false;
  const rect = node.getBoundingClientRect();
  return (
    clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
  );
}

export function useCanvasDrag({
  viewport,
  surface,
  tray,
  view,
  apply,
  toCanvas,
  state,
  onPlaceCard,
  onUnplaceCard,
  onSaveArea,
  onFocusCard,
}) {
  const drag = useRef(null);
  const live = useRef({});
  live.current = { state, onPlaceCard, onUnplaceCard, onSaveArea, onFocusCard, toCanvas, apply };

  const cardNode = useCallback(
    (ref, themeId) =>
      surface.current?.querySelector(
        `.ccard[data-ref="${CSS.escape(ref)}"][data-theme="${CSS.escape(themeId || "")}"]`
      ),
    [surface]
  );

  const clearTargets = useCallback(() => {
    for (const node of surface.current?.querySelectorAll(".area--target") || []) {
      node.classList.remove("area--target");
    }
  }, [surface]);

  const moveGhost = useCallback(
    (clientX, clientY) => {
      const d = drag.current;
      const { state, toCanvas } = live.current;
      const { card_w, card_h } = state.metrics;
      d.ghost.style.left = `${clientX - d.grabX * view.current.z}px`;
      d.ghost.style.top = `${clientY - d.grabY * view.current.z}px`;
      const overTray = pointerOver(tray.current, clientX, clientY);
      d.ghost.classList.toggle("ccard--discard", overTray);

      // Say where it would land before letting go, because on a plane a drop
      // with no preview is a guess -- areas overlap, and the edge of one is not
      // obvious.
      const point = toCanvas(clientX - d.grabX * view.current.z, clientY - d.grabY * view.current.z);
      const target = overTray
        ? null
        : state.areaAt({ x: point.x + card_w / 2, y: point.y + card_h / 2 });
      clearTargets();
      if (target) {
        surface.current
          ?.querySelector(`.area[data-theme="${CSS.escape(target.id)}"]`)
          ?.classList.add("area--target");
      }
    },
    [tray, surface, view, clearTargets]
  );

  const beginCardDrag = useCallback(
    (event, { ref, from, grabX, grabY, copy }) => {
      const { state } = live.current;
      const { card_w, card_h } = state.metrics;
      const quote = state.byRef.get(ref);
      if (!quote) return;

      const ghost = document.createElement("div");
      ghost.className = `ccard ccard--ghost qcard--${quote.color || "amber"}`;
      ghost.style.width = `${card_w * view.current.z}px`;
      ghost.style.height = `${card_h * view.current.z}px`;
      const text = document.createElement("p");
      text.className = "ccard__text";
      text.textContent = quote.text;
      ghost.appendChild(text);
      document.body.appendChild(ghost);

      drag.current = {
        kind: "card",
        ref,
        from,
        copy,
        ghost,
        grabX,
        grabY,
        origin: from === undefined ? null : cardNode(ref, from),
      };
      drag.current.origin?.classList.add("ccard--lifted");
      moveGhost(event.clientX, event.clientY);
    },
    [view, cardNode, moveGhost]
  );

  const finishCardDrag = useCallback(
    async (clientX, clientY) => {
      const d = drag.current;
      const { state, onPlaceCard, onUnplaceCard, onFocusCard, toCanvas } = live.current;
      const { card_w, card_h } = state.metrics;
      const { ref, from, copy } = d;
      const point = toCanvas(clientX - d.grabX * view.current.z, clientY - d.grabY * view.current.z);
      const overTray = pointerOver(tray.current, clientX, clientY);
      const inViewport = pointerOver(viewport.current, clientX, clientY);

      d.ghost.remove();
      d.origin?.classList.remove("ccard--lifted");
      clearTargets();
      const wasNew = from === undefined;
      drag.current = null;

      // Dropped back on the tray: put this one card away. Other cards for the
      // same quote, in other themes, are none of this card's business.
      if (overTray) {
        if (wasNew) return;
        onFocusCard(null);
        await onUnplaceCard(ref, from);
        return;
      }
      if (!inViewport) return;

      const target = state.areaAt({ x: point.x + card_w / 2, y: point.y + card_h / 2 });
      const theme = target ? state.themes.find((t) => t.id === target.id) : null;

      // Grid view draws positions rather than reading them, so a drag that stays
      // inside one area has nowhere to put anything: it would land back in its
      // slot and the write would be invisible. Between areas it still means
      // something, and that still happens.
      if (state.gridView && !wasNew && !copy && (theme?.id || null) === (from || null)) return;

      const body = { ref, theme_id: theme ? theme.id : null };
      if (!theme) {
        Object.assign(body, { x: point.x, y: point.y });
      } else if (!state.gridView && !theme.collapsed) {
        // Positions are stored against the area's own box, so the clamp is
        // against that -- not the box grid view or a roll-up is drawing.
        Object.assign(body, state.clampToArea(theme, point.x - theme.x, point.y - theme.y));
      }
      // Rolled up or in grid view there is no meaningful spot to name, so none
      // is named and the server finds a clear one.

      // A move names where it came from so the card travels; a copy says
      // nothing, and the server adds a second card for the same quote.
      if (!wasNew && !copy) body.moved_from = from;

      onFocusCard({ ref, theme_id: body.theme_id });
      await onPlaceCard(body);
    },
    [view, tray, viewport, clearTargets]
  );

  useEffect(() => {
    const port = viewport.current;
    const trayNode = tray.current;
    if (!port) return;

    const onPointerDown = (event) => {
      if (event.button !== 0 && event.button !== 1) return;
      // Anything with its own job -- a play button, a title field -- keeps it.
      if (event.target.closest("button, a, input, textarea, select")) return;

      const card = event.target.closest(".ccard");
      const area = event.target.closest(".area");
      const handle = event.target.closest("[data-handle]")?.dataset.handle;
      const { state } = live.current;

      // Everything from here is a drag, so the browser's own idea of what a
      // press means is refused: dragging a card across its own text would
      // otherwise leave a trail of blue selection behind the thing being moved.
      event.preventDefault();
      const start = { clientX: event.clientX, clientY: event.clientY };
      port.setPointerCapture(event.pointerId);

      if (card && event.button === 0) {
        const rect = card.getBoundingClientRect();
        drag.current = {
          kind: "pending-card",
          start,
          ref: card.dataset.ref,
          from: card.dataset.theme || null,
          grabX: (event.clientX - rect.left) / view.current.z,
          grabY: (event.clientY - rect.top) / view.current.z,
          copy: event.altKey,
        };
        card.focus({ preventScroll: true });
        live.current.onFocusCard({ ref: card.dataset.ref, theme_id: card.dataset.theme || null });
        return;
      }

      if (area && event.button === 0) {
        const theme = state.themes.find((t) => t.id === area.dataset.theme);
        if (theme) {
          // Resizing starts from the box on screen, not the stored one: in grid
          // view those differ, and a grip that jumps when you take hold of it is
          // a grip nobody can aim.
          drag.current =
            handle === "resize"
              ? { kind: "resize", start, node: area, theme: { ...theme }, w: theme.w, h: state.areaBox(theme).h }
              : { kind: "area", start, node: area, theme: { ...theme }, x: theme.x, y: theme.y };
          area.classList.add("area--moving");
          return;
        }
      }

      drag.current = { kind: "pan", start, x: view.current.x, y: view.current.y };
      port.classList.add("canvas__viewport--panning");
    };

    const onTrayPointerDown = (event) => {
      const item = event.target.closest(".tray__item");
      if (!item || event.button !== 0) return;
      // The link out of a tray quote keeps its own job, as on a card.
      if (event.target.closest("a, button")) return;
      event.preventDefault();
      const { card_w, card_h } = live.current.state.metrics;
      item.focus({ preventScroll: true });
      trayNode.setPointerCapture(event.pointerId);
      drag.current = {
        kind: "pending-card",
        start: { clientX: event.clientX, clientY: event.clientY },
        ref: item.dataset.ref,
        from: undefined,
        // Grab it near its middle: the tray item is a different shape from the
        // card it becomes, so the point pressed means nothing on the plane.
        grabX: card_w / 2,
        grabY: card_h / 2,
        copy: false,
      };
    };

    const onPointerMove = (event) => {
      const d = drag.current;
      if (!d) return;

      // A card in flight is the one drag with no origin to measure from: the
      // ghost tracks the pointer in screen space, so it is handled before
      // anything reads the press position.
      if (d.kind === "card") {
        moveGhost(event.clientX, event.clientY);
        return;
      }

      const dx = event.clientX - d.start.clientX;
      const dy = event.clientY - d.start.clientY;

      if (d.kind === "pending-card") {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        const { ref, from, grabX, grabY, copy } = d;
        drag.current = null;
        beginCardDrag(event, { ref, from, grabX, grabY, copy });
        return;
      }

      if (d.kind === "pan") {
        view.current.x = d.x + dx;
        view.current.y = d.y + dy;
        live.current.apply();
        return;
      }

      const { area_min_w, area_min_h } = live.current.state.metrics;
      if (d.kind === "area") {
        d.theme.x = d.x + dx / view.current.z;
        d.theme.y = d.y + dy / view.current.z;
        d.node.style.left = `${d.theme.x}px`;
        d.node.style.top = `${d.theme.y}px`;
        return;
      }
      if (d.kind === "resize") {
        d.theme.w = Math.max(area_min_w, d.w + dx / view.current.z);
        d.theme.h = Math.max(area_min_h, d.h + dy / view.current.z);
        d.node.style.width = `${d.theme.w}px`;
        d.node.style.height = `${d.theme.h}px`;
      }
    };

    const onPointerUp = (event) => {
      const d = drag.current;
      if (!d) return;
      port.classList.remove("canvas__viewport--panning");
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch (_) { /* pointer already gone */ }

      if (d.kind === "card") {
        finishCardDrag(event.clientX, event.clientY);
        return;
      }
      if (d.kind === "pending-card" || d.kind === "pan") {
        drag.current = null;
        return;
      }

      const { theme, node, kind } = d;
      drag.current = null;
      node.classList.remove("area--moving");
      live.current.onSaveArea(theme, { pullCardsIn: kind === "resize" });
    };

    port.addEventListener("pointerdown", onPointerDown);
    port.addEventListener("pointermove", onPointerMove);
    port.addEventListener("pointerup", onPointerUp);
    port.addEventListener("pointercancel", onPointerUp);
    trayNode?.addEventListener("pointerdown", onTrayPointerDown);
    trayNode?.addEventListener("pointermove", onPointerMove);
    trayNode?.addEventListener("pointerup", onPointerUp);
    trayNode?.addEventListener("pointercancel", onPointerUp);
    return () => {
      port.removeEventListener("pointerdown", onPointerDown);
      port.removeEventListener("pointermove", onPointerMove);
      port.removeEventListener("pointerup", onPointerUp);
      port.removeEventListener("pointercancel", onPointerUp);
      trayNode?.removeEventListener("pointerdown", onTrayPointerDown);
      trayNode?.removeEventListener("pointermove", onPointerMove);
      trayNode?.removeEventListener("pointerup", onPointerUp);
      trayNode?.removeEventListener("pointercancel", onPointerUp);
    };
  }, [viewport, tray, view, moveGhost, beginCardDrag, finishCardDrag]);

  return { drag };
}
