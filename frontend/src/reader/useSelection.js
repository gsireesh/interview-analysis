/* The live text selection, resolved to cue anchors.
 *
 * The 120ms wait is not only about letting a drag settle. Setting state from a
 * `selectionchange` handler synchronously can re-render the very nodes the
 * selection points into and collapse it, so the measurement is always deferred.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { readAnchors } from "../lib/transcript.js";

export function useSelection(chunksRef, cueById) {
  const [anchors, setAnchors] = useState(null);
  const live = useRef({ chunksRef, cueById });
  live.current = { chunksRef, cueById };

  useEffect(() => {
    let timer;
    const measure = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const { chunksRef, cueById } = live.current;
        setAnchors(readAnchors(chunksRef.current, cueById));
      }, 120);
    };
    document.addEventListener("selectionchange", measure);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("selectionchange", measure);
    };
  }, []); // registered once; live values come through the ref

  /** Read the selection now, for a caller that cannot wait for the timer. */
  const readNow = useCallback(
    () => anchors || readAnchors(live.current.chunksRef.current, live.current.cueById),
    [anchors]
  );

  const clear = useCallback(() => {
    window.getSelection()?.removeAllRanges();
    setAnchors(null);
  }, []);

  return { anchors, readNow, clear };
}
