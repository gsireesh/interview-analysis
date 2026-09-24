/* The library's quotes and the themes built across them.
 *
 * Every canvas call answers with the *whole* canvas -- themes, cards, and the
 * two "is this quote dealt with" sets -- so there is exactly one place that
 * takes a reply on, and nothing has to work out which parts of the page a
 * particular edit invalidated. `placed` and `onCanvas` are derived rather than
 * stored, so they cannot drift from the cards they describe.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/util.js";
import { useToast } from "../ui/Toast.jsx";

export function useLibrary() {
  const { notify } = useToast();
  const [library, setLibrary] = useState(null);
  const [quotes, setQuotes] = useState([]);
  const [themes, setThemes] = useState([]);
  const [cards, setCards] = useState([]);
  const [metrics, setMetrics] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    Promise.all([
      api("/api/library"),
      api("/api/library/quotes"),
      api("/api/library/themes"),
    ])
      .then(([lib, quoteData, themeData]) => {
        setLibrary(lib);
        setQuotes(quoteData.quotes);
        setThemes(themeData.themes);
        setCards(themeData.cards);
        setMetrics(themeData.metrics);
        setReady(true);
      })
      .catch((error) =>
        notify(`Could not load the library: ${error.message}`, { kind: "warn" })
      );
  }, [notify]);

  /** Take a canvas payload on as the current truth. */
  const adopt = useCallback((payload) => {
    if (!payload) return;
    if (payload.themes) setThemes(payload.themes);
    if (payload.cards) setCards(payload.cards);
  }, []);

  const byRef = useMemo(() => new Map(quotes.map((q) => [q.ref, q])), [quotes]);

  const recordings = useMemo(
    () => new Map((library?.recordings || []).map((r) => [r.id, r])),
    [library]
  );

  // Which quotes are filed in a theme, and which have a card anywhere at all.
  const placed = useMemo(
    () => new Set(themes.flatMap((theme) => theme.refs)),
    [themes]
  );
  const onCanvas = useMemo(() => new Set(cards.map((card) => card.ref)), [cards]);

  /** Send a canvas change and take the whole answer back. */
  const send = useCallback(
    async (path, body, failure) => {
      try {
        const payload = await api(path, { method: "POST", body });
        adopt(payload);
        return payload;
      } catch (error) {
        notify(`${failure}: ${error.message}`, { kind: "warn" });
        return null;
      }
    },
    [adopt, notify]
  );

  return {
    ready,
    library,
    quotes,
    themes,
    cards,
    metrics,
    byRef,
    recordings,
    placed,
    onCanvas,
    adopt,
    send,
    setThemes,
    notify,
  };
}
