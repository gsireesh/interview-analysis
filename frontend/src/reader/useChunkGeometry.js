/* Where each block sits, measured once rather than per scroll frame.
 *
 * A layout effect, not an effect: the first scroll event after a render must not
 * read offsets from the previous one. The ResizeObserver covers the case the old
 * code had to remember to handle by hand -- a highlight reflowing a cue changes
 * every offset below it, and nothing about that is a window resize.
 */

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

export function useChunkGeometry(chunksRef, chunks) {
  const els = useRef([]);
  const tops = useRef([]);
  const starts = useRef([]);

  const measure = useCallback(() => {
    const root = chunksRef.current;
    if (!root) return;
    // Only .chunk elements -- part breaks are siblings, and counting them would
    // shift every cursor index out of step with `chunks`.
    els.current = Array.from(root.querySelectorAll(".chunk"));
    tops.current = els.current.map((el) => el.offsetTop);
    starts.current = chunks.map((chunk) => chunk.start);
  }, [chunksRef, chunks]);

  useLayoutEffect(measure, [measure]);

  useEffect(() => {
    const root = chunksRef.current;
    if (!root) return;
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure, chunksRef]);

  return { els, tops, starts, measure };
}
