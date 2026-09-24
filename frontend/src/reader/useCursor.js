/* The reading cursor, and the two modes it moves in.
 *
 * Reading is the default and the point of the tool: the cursor follows where you
 * are in the text and quietly cues the player to match, so playback always
 * starts where you are looking. Pressing play switches to FOLLOWING, where the
 * transcript keeps up with the audio instead. Scrolling or moving the cursor by
 * hand drops back to READING without stopping playback.
 *
 * The cursor *class* is applied to the element through a ref rather than by
 * re-rendering the block. Moving through a transcript with j and k must not
 * re-render a thousand blocks to light up one of them.
 */

import { useCallback, useEffect, useReducer, useRef } from "react";

const initial = { mode: "reading", index: 0, scrollTick: 0 };

function reducer(state, action) {
  switch (action.type) {
    case "mode":
      return state.mode === action.mode ? state : { ...state, mode: action.mode };
    case "cursor": {
      const index = Math.max(0, Math.min(action.index, Math.max(0, action.count - 1)));
      // Re-asserting the cursor is how the reader is brought back to it after a
      // rebuild, and that has to scroll even when the index did not move -- so
      // the scroll is its own signal rather than a consequence of the index.
      if (index === state.index && !action.scroll) return state;
      return {
        ...state,
        index,
        scrollTick: action.scroll ? state.scrollTick + 1 : state.scrollTick,
      };
    }
    default:
      return state;
  }
}

export function useCursor({ chunks, geometry }) {
  const [state, dispatch] = useReducer(reducer, initial);
  const painted = useRef(-1);

  const setCursor = useCallback(
    (index, { scroll = false } = {}) =>
      dispatch({ type: "cursor", index, scroll, count: chunks.length }),
    [chunks.length]
  );

  const setMode = useCallback((mode) => dispatch({ type: "mode", mode }), []);

  // Move the class, and scroll if this move asked to.
  useEffect(() => {
    const els = geometry.els.current;
    if (painted.current !== state.index) {
      els[painted.current]?.classList.remove("chunk--cursor");
      painted.current = state.index;
    }
    els[state.index]?.classList.add("chunk--cursor");
  }, [state.index, state.scrollTick, geometry, chunks]);

  useEffect(() => {
    if (!state.scrollTick) return;
    geometry.els.current[state.index]?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [state.scrollTick]); // eslint-disable-line react-hooks/exhaustive-deps

  return { mode: state.mode, index: state.index, setCursor, setMode };
}
