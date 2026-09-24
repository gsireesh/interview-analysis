/* Pan and zoom, held in a ref and written straight to the DOM.
 *
 * This runs on every wheel tick and every frame of a pan. Putting {x, y, z} in
 * state would re-render every area and every card at 60Hz to move one transform,
 * so the view lives in a ref and `apply` writes the transform, the custom
 * properties the areas read, and the grid offset itself.
 */

import { useCallback, useEffect, useRef } from "react";
import { debounce, recall, remember } from "../lib/util.js";

export const VIEW_KEY = "subtitle-search:canvas-view";
export const ZOOM_MIN = 0.2;
export const ZOOM_MAX = 2;
export const ZOOM_STEP = 1.15;
const GRID = 24;

export function useCanvasView({ viewport, surface, zoomLabel, onApply }) {
  const view = useRef({ x: 0, y: 0, z: 1 });

  //: Panning fires on every frame, and storage is not free -- so where you are
  //: looking is written a moment after you stop looking around.
  const rememberView = useRef(
    debounce(() => remember(VIEW_KEY, JSON.stringify(view.current)), 300)
  ).current;

  const apply = useCallback(() => {
    const { x, y, z } = view.current;
    if (!surface.current || !viewport.current) return;
    surface.current.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
    // Published to CSS so an area's title can undo the zoom and stay one size on
    // screen. A quote shrinking as you pull back is fine -- you are not reading
    // it from there -- but a theme's name is what you navigate by, and a plane
    // whose labels go illegible exactly when you zoom out to see all of them has
    // given up the thing it was for.
    surface.current.style.setProperty("--z", String(z));
    surface.current.style.setProperty("--inv-z", String(1 / z));
    // The dot grid is painted by the viewport rather than the surface, so it can
    // run endlessly in all four directions without a vast element to carry it.
    // Coarser when zoomed far out, where a fine grid would read as grey fog.
    const pitch = (z < 0.5 ? GRID * 4 : GRID) * z;
    viewport.current.style.backgroundSize = `${pitch}px ${pitch}px`;
    viewport.current.style.backgroundPosition = `${x}px ${y}px`;
    if (zoomLabel.current) zoomLabel.current.textContent = `${Math.round(z * 100)}%`;
    onApply?.();
    rememberView();
  }, [surface, viewport, zoomLabel, onApply, rememberView]);

  /** Where a client point lands on the plane. */
  const toCanvas = useCallback(
    (clientX, clientY) => {
      const rect = viewport.current.getBoundingClientRect();
      const { x, y, z } = view.current;
      return { x: (clientX - rect.left - x) / z, y: (clientY - rect.top - y) / z };
    },
    [viewport]
  );

  /** Zoom about a fixed client point, so the thing under the cursor stays put. */
  const zoomAt = useCallback(
    (clientX, clientY, factor) => {
      const before = toCanvas(clientX, clientY);
      view.current.z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, view.current.z * factor));
      const after = toCanvas(clientX, clientY);
      view.current.x += (after.x - before.x) * view.current.z;
      view.current.y += (after.y - before.y) * view.current.z;
      apply();
    },
    [toCanvas, apply]
  );

  /** Frame everything on the canvas, or come back to the origin if nothing is. */
  const fit = useCallback(
    (boxes) => {
      const rect = viewport.current?.getBoundingClientRect();
      if (!boxes.length || !rect?.width) {
        Object.assign(view.current, { x: 24, y: 24, z: 1 });
        apply();
        return;
      }
      const left = Math.min(...boxes.map((b) => b[0]));
      const top = Math.min(...boxes.map((b) => b[1]));
      const right = Math.max(...boxes.map((b) => b[0] + b[2]));
      const bottom = Math.max(...boxes.map((b) => b[1] + b[3]));
      const pad = 40;
      view.current.z = Math.min(
        ZOOM_MAX,
        Math.max(
          ZOOM_MIN,
          Math.min(
            rect.width / (right - left + pad * 2),
            rect.height / (bottom - top + pad * 2)
          )
        )
      );
      view.current.x = (rect.width - (right - left) * view.current.z) / 2 - left * view.current.z;
      view.current.y = (rect.height - (bottom - top) * view.current.z) / 2 - top * view.current.z;
      apply();
    },
    [viewport, apply]
  );

  // What is remembered is the zoom and the pan, because those are about you at
  // this moment rather than about the analysis.
  useEffect(() => {
    try {
      const saved = JSON.parse(recall(VIEW_KEY, "null"));
      if (saved && Number.isFinite(saved.z)) Object.assign(view.current, saved);
    } catch (_) { /* nothing remembered, or nonsense remembered */ }
    view.current.z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, view.current.z || 1));
    apply();
  }, [apply]);

  return { view, apply, toCanvas, zoomAt, fit };
}
