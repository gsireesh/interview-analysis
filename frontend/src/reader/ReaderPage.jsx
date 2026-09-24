/* The reader: one transcript, the recording behind it, and the quotes taken out.
 *
 * Reading is the default and the point of the tool. The page opens in READING
 * with the dock minimised: the cursor follows where you are in the text and
 * quietly cues the player to match, so playback always starts where you are
 * looking. Pressing play switches to FOLLOWING, where the transcript keeps up
 * with the audio instead.
 *
 * The playhead is deliberately not state. `timeupdate` fires several times a
 * second, and a transcript is hundreds of blocks; the clock, the scrubber and
 * the spine dot are written to the DOM here, and only a change of *block*
 * reaches React.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, formatTime } from "../lib/util.js";
import {
  chunkIndexAtScroll,
  chunkIndexAtTime,
  expandChunks,
  highlightSlices,
  offsetWithin,
} from "../lib/transcript.js";
import { storedRate, applyRate } from "../lib/player.js";
import { remapJoinedCues, remapSplitCues, wordStartAt } from "../lib/editing.js";
import { useToast } from "../ui/Toast.jsx";
import { ThemeToggle } from "../ui/Theme.jsx";
import Transcript from "./Transcript.jsx";
import EditBlock from "./EditBlock.jsx";
import Dock from "./Dock.jsx";
import Sidebar from "./Sidebar.jsx";
import QuoteBar from "./QuoteBar.jsx";
import { Roster, Timing } from "./Strips.jsx";
import { usePlayer } from "./usePlayer.js";
import { useChunkGeometry } from "./useChunkGeometry.js";
import { useCursor } from "./useCursor.js";
import { useSelection } from "./useSelection.js";

export default function ReaderPage() {
  const { notify, working } = useToast();

  const [recordingId, setRecordingId] = useState(null);
  const [recording, setRecording] = useState(null);
  const [highlights, setHighlights] = useState([]);
  const [vocabulary, setVocabulary] = useState([]);
  const [colors, setColors] = useState(["amber"]);
  const [splitCues, setSplitCues] = useState(() => new Set());
  const [activeHighlightId, setActiveHighlightId] = useState(null);
  const [tab, setTab] = useState("highlights");
  const [playing, setPlaying] = useState(false);
  const [align, setAlign] = useState({ available: false, reason: "", running: false, done: 0, total: 0 });
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState("fuzzy");
  const [searchResults, setSearchResults] = useState(null);
  const [failed, setFailed] = useState(null);
  const [editing, setEditing] = useState(null); // chunk index, or null

  const readerRef = useRef(null);
  const chunksRef = useRef(null);
  const spineRef = useRef(null);
  const spineDotRef = useRef(null);
  const clockRef = useRef(null);
  const scrubRef = useRef(null);
  const searchRef = useRef(null);
  const currentTime = useRef(0);
  const stopAlign = useRef(false);

  /* -------------------------------------------------------------- derived -- */

  const cueById = useMemo(() => {
    const map = new Map();
    for (const cue of recording?.transcript?.cues || []) map.set(cue.id, cue);
    return map;
  }, [recording]);

  const cueByIndex = useMemo(() => {
    const map = new Map();
    for (const cue of recording?.transcript?.cues || []) map.set(cue.index, cue);
    return map;
  }, [recording]);

  // Display blocks: the server's grouping, with any split ones broken open.
  const chunks = useMemo(
    () => expandChunks(recording?.transcript?.chunks || [], cueById, splitCues),
    [recording, cueById, splitCues]
  );

  const slices = useMemo(
    () => highlightSlices(highlights, cueById, cueByIndex),
    [highlights, cueById, cueByIndex]
  );

  const parts = recording?.transcript?.parts || [];
  const roster = recording?.transcript?.roster || [];
  const speakers = recording?.transcript?.speakers || [];
  const duration = recording?.duration || 0;
  const playable = parts.filter((part) => part.media_name);
  const anyVideo = playable.some((part) => part.media_kind === "video");

  /* ---------------------------------------------------------------- wiring -- */

  const geometry = useChunkGeometry(chunksRef, chunks);
  const cursor = useCursor({ chunks, geometry });
  const selection = useSelection(chunksRef, cueById);

  const onTime = useCallback(
    (seconds) => {
      currentTime.current = seconds;
      if (clockRef.current) clockRef.current.textContent = formatTime(seconds);
      if (scrubRef.current && duration) {
        scrubRef.current.value = String(Math.round((seconds / duration) * 1000));
      }
      if (cursorMode.current !== "following") return;
      const index = chunkIndexAtTime(geometry.starts.current, seconds);
      if (index !== cursorIndex.current) cursor.setCursor(index, { scroll: true });
      else paintSpine();
    },
    // paintSpine and cursor are stable; the refs carry everything that moves.
    [duration] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const onPlaying = useCallback(
    (isPlaying) => {
      setPlaying(isPlaying);
      // Pressing play is the signal that you want the transcript to keep up.
      if (isPlaying) cursor.setMode("following");
    },
    [cursor]
  );

  const player = usePlayer({ recordingId, parts, duration, onTime, onPlaying });

  // Read by onTime, which is registered once and must not go stale.
  const cursorMode = useRef(cursor.mode);
  const cursorIndex = useRef(cursor.index);
  cursorMode.current = cursor.mode;
  cursorIndex.current = cursor.index;

  /** Put the spine marker over the block being read. */
  const paintSpine = useCallback(() => {
    const el = geometry.els.current[cursorIndex.current];
    const marker = spineRef.current;
    if (!el || !marker) return;
    marker.hidden = false;
    marker.style.top = `${el.offsetTop + 8}px`;
    marker.style.height = `${Math.max(12, el.offsetHeight - 16)}px`;

    const dot = spineDotRef.current;
    if (!dot) return;
    const chunk = chunks[cursorIndex.current];
    if (cursorMode.current !== "following" || !chunk) {
      dot.hidden = true;
      return;
    }
    const span = Math.max(0.001, chunk.end - chunk.start);
    const progress = Math.max(0, Math.min(1, (currentTime.current - chunk.start) / span));
    dot.hidden = false;
    dot.style.top = `${progress * 100}%`;
  }, [chunks, geometry]);

  useEffect(paintSpine, [paintSpine, cursor.index, cursor.mode]);

  /* ----------------------------------------------------------------- load -- */

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const config = await api("/api/config");
        if (cancelled) return;
        setColors(config.colors);
        // The library links straight to a recording, and to a moment inside it.
        const asked = new URLSearchParams(location.search).get("recording");
        const id =
          (asked && config.recordings.some((r) => r.id === asked) && asked) ||
          config.default_recording_id;
        if (!id) {
          setFailed("No recording loaded.");
          return;
        }
        setRecordingId(id);
        const data = await api(`/api/recordings/${id}`);
        if (cancelled) return;
        setRecording(data);
        setHighlights(data.highlights);
      } catch (error) {
        if (!cancelled) {
          setFailed(error.message);
          notify(`Could not load the recording: ${error.message}`, { kind: "warn" });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [notify]);

  // Suggestions span the study, so a tag coined in one interview is offered in
  // every other one. Not fatal if it fails -- the field still takes free text.
  useEffect(() => {
    api("/api/library/vocabulary")
      .then((data) => setVocabulary(data.tags))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!recordingId) return;
    // Asked once: whether this machine can measure timings at all, and why not.
    api(`/api/recordings/${recordingId}/alignment`)
      .then((state) =>
        setAlign((current) => ({ ...current, available: state.available, reason: state.reason }))
      )
      .catch(() => {});
  }, [recordingId]);

  useEffect(() => {
    if (recording?.title) document.title = recording.title;
  }, [recording?.title]);

  /* --------------------------------------------------------- diagnostics -- */

  const said = useRef(false);
  useEffect(() => {
    if (!recording || said.current) return;
    said.current = true;
    const diagnostics = recording.transcript.diagnostics;

    if (recording.migrated_from) {
      notify(
        `Quotes from ${recording.migrated_from} were moved into ${recording.highlights_file}. The original file was left in place as a backup.`
      );
    }
    if (recording.highlights_stale) {
      notify(
        "The transcript changed since these quotes were saved. Their timestamps may no longer line up.",
        { kind: "warn" }
      );
    }
    if (!playable.length) {
      // Say so rather than just removing the player -- an unexplained missing
      // control reads as a bug, and this is usually a folder needing its media.
      notify(
        "No media file found in this folder, so there is nothing to play. The transcript still works.",
        { kind: "warn" }
      );
    }

    // Speaker detection is a heuristic, so say what it decided rather than
    // letting a misparse be discovered an hour into a reading session.
    const key = `subtitle-search:parsed:${recording.transcript.sha256}`;
    const leading =
      diagnostics.part_count > 1
        ? `${diagnostics.part_count} recordings joined into one timeline. `
        : "";
    notify(
      diagnostics.speakers.length
        ? `${leading}${diagnostics.cue_count} cues grouped into ${diagnostics.chunk_count} blocks. Speakers: ${diagnostics.speakers.join(", ")}.`
        : `${leading}${diagnostics.cue_count} cues, no speakers detected — blocks were split on pauses instead.`,
      { kind: diagnostics.speakers.length ? "info" : "warn", key }
    );
  }, [recording, notify, playable.length]);

  /* ------------------------------------------------------- first playable -- */

  const cued = useRef(false);
  useEffect(() => {
    if (cued.current || !recordingId || !playable.length || !chunks.length) return;
    cued.current = true;
    player.activate(0, 0).then(() => {
      if (player.media.current) applyRate(player.media.current, storedRate());
    });

    // A link from the library or the themes canvas carries a moment with it.
    const at = Number(new URLSearchParams(location.search).get("t"));
    if (Number.isFinite(at) && at > 0) {
      const index = chunkIndexAtTime(
        chunks.map((chunk) => chunk.start),
        at
      );
      cursor.setCursor(index, { scroll: true });
      player.seekAndPlay(at);
    }
  }, [recordingId, playable.length, chunks, player, cursor]);

  /* --------------------------------------------------------------- scroll -- */

  useEffect(() => {
    const reader = readerRef.current;
    if (!reader) return;
    let queued = false;

    const onScroll = () => {
      if (cursorMode.current !== "reading" || queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        cursor.setCursor(chunkIndexAtScroll(reader, geometry.tops.current));
      });
    };

    // Detaching on real input intent is more reliable than trying to tell a
    // programmatic scroll from a human one after the fact.
    const onIntent = () => cursor.setMode("reading");

    reader.addEventListener("scroll", onScroll);
    reader.addEventListener("wheel", onIntent, { passive: true });
    reader.addEventListener("touchmove", onIntent, { passive: true });
    return () => {
      reader.removeEventListener("scroll", onScroll);
      reader.removeEventListener("wheel", onIntent);
      reader.removeEventListener("touchmove", onIntent);
    };
  }, [cursor, geometry]);

  // While reading, the player follows the cursor silently.
  useEffect(() => {
    if (cursor.mode !== "reading") return;
    const chunk = chunks[cursor.index];
    if (!chunk) return;
    const timer = setTimeout(() => player.cue(chunk.start), 200);
    return () => clearTimeout(timer);
  }, [cursor.index, cursor.mode, chunks, player]);

  /* --------------------------------------------------------------- search -- */

  useEffect(() => {
    const term = searchQuery.trim();
    if (!recordingId || !term) {
      setSearchResults(null);
      return;
    }
    const timer = setTimeout(() => {
      api(
        `/api/recordings/${recordingId}/search?q=${encodeURIComponent(term)}&mode=${searchMode}`
      )
        .then((data) => setSearchResults(data.results))
        .catch((error) => notify(`Search failed: ${error.message}`, { kind: "warn" }));
    }, 160);
    return () => clearTimeout(timer);
  }, [searchQuery, searchMode, recordingId, notify]);

  /* --------------------------------------------------------------- quotes -- */

  const takeRecording = useCallback((payload) => {
    setRecording(payload);
    setHighlights(payload.highlights);
  }, []);

  const saveQuote = useCallback(
    async ({ color, focusNote = false } = {}) => {
      const anchors = selection.readNow();
      if (!anchors) {
        notify("Select some text first.");
        return;
      }
      try {
        const { highlight } = await api(`/api/recordings/${recordingId}/highlights`, {
          method: "POST",
          body: {
            text: anchors.text,
            start_cue_id: anchors.start_cue_id,
            start_char_offset: anchors.start_char_offset,
            end_cue_id: anchors.end_cue_id,
            end_char_offset: anchors.end_char_offset,
            speaker: anchors.speaker,
            color: color || colors[0],
          },
        });
        setHighlights((all) => [...all, highlight]);
        selection.clear();
        // Mark it inline too, so the transcript and the sidebar agree on which
        // quote was just added.
        setActiveHighlightId(highlight.id);
        setTab("highlights");
        if (focusNote) {
          requestAnimationFrame(() => {
            document
              .querySelector(`.quote[data-id="${highlight.id}"] .quote__note`)
              ?.focus();
          });
        }
      } catch (error) {
        notify(`Could not save the quote: ${error.message}`, { kind: "warn" });
      }
    },
    [recordingId, colors, selection, notify]
  );

  const patchQuote = useCallback(
    async (highlight, patch) => {
      // Shown before it is saved: a colour that waits for a round trip feels
      // broken, and the server is not going to disagree about a colour.
      setHighlights((all) => all.map((h) => (h.id === highlight.id ? { ...h, ...patch } : h)));
      try {
        const { highlight: saved } = await api(
          `/api/recordings/${recordingId}/highlights/${highlight.id}`,
          { method: "PATCH", body: patch }
        );
        setHighlights((all) => all.map((h) => (h.id === saved.id ? saved : h)));
        // Fold a just-used tag into the vocabulary so it completes straight away.
        if (patch.tags) {
          setVocabulary((current) => {
            const known = new Set(current.map((entry) => entry.tag.toLowerCase()));
            const added = patch.tags
              .filter((tag) => !known.has(tag.toLowerCase()))
              .map((tag) => ({ tag, quote_count: 1, recording_count: 1, recordings: [] }));
            return added.length ? [...current, ...added] : current;
          });
        }
      } catch (error) {
        setHighlights((all) => all.map((h) => (h.id === highlight.id ? highlight : h)));
        notify(`Could not save that change: ${error.message}`, { kind: "warn" });
      }
    },
    [recordingId, notify]
  );

  const deleteQuote = useCallback(
    async (highlight) => {
      try {
        await api(`/api/recordings/${recordingId}/highlights/${highlight.id}`, {
          method: "DELETE",
        });
        setHighlights((all) => all.filter((h) => h.id !== highlight.id));
        setActiveHighlightId((id) => (id === highlight.id ? null : id));
      } catch (error) {
        notify(`Could not delete that quote: ${error.message}`, { kind: "warn" });
      }
    },
    [recordingId, notify]
  );

  const copyLine = useCallback(
    (text, speaker, at) => {
      const who = speaker ? `${speaker} ` : "";
      const line = `"${text}" — ${who}(${formatTime(at)})`;
      navigator.clipboard?.writeText(line).then(
        () => notify("Quote copied."),
        () => notify("Could not reach the clipboard.")
      );
    },
    [notify]
  );

  const copySelection = useCallback(() => {
    const anchors = selection.readNow();
    if (!anchors) return;
    copyLine(anchors.text, anchors.speaker, anchors.estimated_start);
  }, [selection, copyLine]);

  /**
   * Offer to hand the selected words to someone else.
   *
   * Reading along, you see that half of what Zoom filed under one person was
   * actually said by the other. This is where that gets fixed: select the words
   * and hand them over. Whatever captions have to be cut to make the passage
   * its own are cut -- usually one caption into three.
   */
  const handOver = useCallback(
    async (speaker) => {
      const anchors = selection.readNow();
      if (!anchors) return;
      selection.clear();
      // Cutting a caption measures it against the audio first, and the first
      // measurement in a session waits for the model to load. Several seconds
      // of silence after a click is indistinguishable from a click that did
      // nothing.
      const done = working(`Giving those words to ${speaker}…`);
      try {
        const result = await api(`/api/recordings/${recordingId}/selection/speaker`, {
          method: "POST",
          body: {
            start_cue_id: anchors.start_cue_id,
            start_char_offset: anchors.start_char_offset,
            end_cue_id: anchors.end_cue_id,
            end_char_offset: anchors.end_char_offset,
            speaker,
          },
        });
        if (result.backup_created) {
          notify(`Original transcript saved as ${result.backup_created}.`);
        }
        const cuts = result.splits
          ? `, cutting ${result.splits} caption${result.splits === 1 ? "" : "s"}`
          : "";
        notify(`Given to ${result.speaker}${cuts}.`);
        takeRecording(result.recording);
      } catch (error) {
        notify(`Could not hand those words over: ${error.message}`, { kind: "warn" });
      } finally {
        done();
      }
    },
    [recordingId, selection, working, notify, takeRecording]
  );

  /* --------------------------------------------------------------- roster -- */

  /** Send the whole roster back; the server is the one that validates it. */
  const saveRoster = useCallback(
    async (entries) => {
      try {
        const result = await api(`/api/recordings/${recordingId}/roster`, {
          method: "PUT",
          body: { speakers: entries },
        });
        takeRecording(result.recording);
      } catch (error) {
        notify(`Could not save the speakers: ${error.message}`, { kind: "warn" });
      }
    },
    [recordingId, notify, takeRecording]
  );

  /**
   * Give the block at the cursor a speaker, then move to the next one.
   *
   * Whole block rather than one caption: the cursor sits on a block, and on a
   * single-speaker transcript every caption *is* a block, which is exactly the
   * case this exists for. Advancing afterwards is what makes a labelling pass a
   * run of keypresses rather than a click each time.
   */
  const assignSpeaker = useCallback(
    async (speaker) => {
      const chunk = chunks[cursorIndex.current];
      if (!chunk || !speaker) return;
      if (chunk.speaker === speaker) {
        cursor.setCursor(cursorIndex.current + 1, { scroll: true });
        return;
      }
      const cues = chunk.cue_ids;
      try {
        const result = await api(
          `/api/recordings/${recordingId}/cues/${cues[0]}/speaker`,
          { method: "PATCH", body: { speaker, through: cues[cues.length - 1] } }
        );
        if (result.backup_created) {
          notify(`Original transcript saved as ${result.backup_created}.`);
        }
        const wasAt = cursorIndex.current;
        takeRecording(result.recording);
        // Blocks may have merged, so step past the one this cue now belongs to.
        const next = result.recording.transcript.chunks.findIndex((c) =>
          c.cue_ids.includes(cues[cues.length - 1])
        );
        cursor.setCursor((next < 0 ? wasAt : next) + 1, { scroll: true });
      } catch (error) {
        notify(`Could not assign that speaker: ${error.message}`, { kind: "warn" });
      }
    },
    [chunks, recordingId, cursor, notify, takeRecording]
  );

  /* ------------------------------------------------------------ alignment -- */

  /** Walk the session in batches, so there is progress to show and a way out. */
  const runAlignment = useCallback(async () => {
    if (align.running) return;
    stopAlign.current = false;
    const cover = recording?.timing_coverage || { timed: 0, total: 0 };
    setAlign((s) => ({ ...s, running: true, done: cover.timed || 0, total: cover.total || 0 }));

    try {
      while (!stopAlign.current) {
        const before = (recording?.timing_coverage?.timed ?? 0) || 0;
        const result = await api(`/api/recordings/${recordingId}/align`, {
          method: "POST",
          body: {},
        });
        setAlign((s) => ({ ...s, done: result.coverage.timed, total: result.coverage.total }));
        if (!result.remaining || !result.captions) break;
        // A batch that handed back captions but measured none of them would
        // otherwise be asked for again forever -- a recording with no audio, or
        // captions the aligner cannot place. Stop on the first lack of progress.
        if (result.coverage.timed <= before) {
          notify(
            `Stopped at ${result.coverage.timed} of ${result.coverage.total}: those captions could not be measured.`,
            { kind: "warn" }
          );
          break;
        }
      }
      notify(
        stopAlign.current
          ? "Stopped measuring."
          : "Word timings measured. Timestamps in this session are no longer estimates."
      );
    } catch (error) {
      notify(`Could not measure timings: ${error.message}`, { kind: "warn" });
    } finally {
      setAlign((s) => ({ ...s, running: false }));
      // The cues themselves changed server-side, so take the session back to
      // pick up which captions are now measured.
      try {
        takeRecording(await api(`/api/recordings/${recordingId}`));
      } catch (_) { /* the strip simply keeps its last numbers */ }
    }
  }, [align.running, recording, recordingId, notify, takeRecording]);

  /* -------------------------------------------------------------- editing -- */

  /** Take quotes the server re-anchored after an edit. */
  const takeHighlights = useCallback((updated) => {
    if (!updated?.length) return;
    setHighlights((all) =>
      all.map((h) => updated.find((u) => u.id === h.id) || h)
    );
  }, []);

  const commitText = useCallback(
    async (cueId, raw, field) => {
      const cue = cueById.get(cueId);
      if (!cue) return;
      const text = raw.replace(/\s+/g, " ").trim();
      if (!text || text === cue.text) {
        field.textContent = cue.text;
        return;
      }
      const row = field.closest(".cue-line");
      row?.classList.add("cue-line--saving");
      try {
        const result = await api(`/api/recordings/${recordingId}/cues/${cueId}`, {
          method: "PATCH",
          body: { text },
        });
        field.textContent = result.cue.text;
        // The cue objects are the server's, so take the whole recording rather
        // than patching one string and hoping the rest still agrees.
        setRecording((current) => {
          if (!current) return current;
          const cues = current.transcript.cues.map((c) =>
            c.id === result.cue.id ? result.cue : c
          );
          return { ...current, transcript: { ...current.transcript, cues } };
        });
        takeHighlights(result.highlights);
        if (result.backup_created) {
          notify(`Original transcript saved as ${result.backup_created}.`);
        }
        row?.classList.remove("cue-line--saving");
        row?.classList.add("cue-line--saved");
        setTimeout(() => row?.classList.remove("cue-line--saved"), 1200);
      } catch (error) {
        row?.classList.remove("cue-line--saving");
        row?.classList.add("cue-line--failed");
        field.textContent = cue.text;
        notify(`Could not save that line: ${error.message}`, { kind: "warn" });
      }
    },
    [cueById, recordingId, notify, takeHighlights]
  );

  /**
   * Put a run of captions back together.
   *
   * Undoing a cut and repairing Zoom's opposite failure -- one sentence chopped
   * across three captions -- are the same operation, so they are the same
   * request. `expect` is the captions as the caller believes them to read: cue
   * ids are positional and an undo can be pressed after something else has
   * moved them, so the server compares before joining and refuses if the
   * transcript has shifted.
   */
  const joinCaptions = useCallback(
    async (cueId, through, expect, { keepEditing = false } = {}) => {
      try {
        const result = await api(`/api/recordings/${recordingId}/cues/${cueId}/merge`, {
          method: "POST",
          body: { through, expect },
        });
        if (result.backup_created) {
          notify(`Original transcript saved as ${result.backup_created}.`);
        }
        // One caption carries one speaker, so a join across two of them drops a
        // name. Worth saying out loud rather than discovering later.
        if (result.absorbed_speakers?.length) {
          notify(
            `Joined ${result.joined} captions under ${result.speaker} — ${result.absorbed_speakers.join(", ")} no longer named on those words.`,
            { kind: "warn" }
          );
        } else {
          notify(`Joined ${result.joined} captions into one.`);
        }
        setSplitCues((current) => remapJoinedCues(current, result.cue_id, result.joined));
        takeRecording(result.recording);
        if (!keepEditing) setEditing(null);
        return result;
      } catch (error) {
        notify(`Could not join those captions: ${error.message}`, { kind: "warn" });
        return null;
      }
    },
    [recordingId, notify, takeRecording]
  );

  /**
   * Cut a caption in two, and say which kind of cut it was.
   *
   * Zoom routinely puts the end of one person's turn and the start of another's
   * in a single caption, and no amount of reattributing whole captions can
   * separate them. So the caption itself has to divide first, and then each half
   * can be given its own speaker.
   */
  const requestSplit = useCallback(
    async (cueId, offset, text) => {
      if (!text.slice(0, offset).trim() || !text.slice(offset).trim()) {
        notify("A split needs words on both sides of the cut.");
        return null;
      }
      const done = working("Measuring where to cut…");
      try {
        const result = await api(`/api/recordings/${recordingId}/cues/${cueId}/split`, {
          method: "POST",
          body: { offset, text },
        });
        if (result.backup_created) {
          notify(`Original transcript saved as ${result.backup_created}.`);
        }
        // Say which it was. A measured cut lands in the real pause between the
        // two speakers; an estimated one is the old interpolation. The moment
        // after a cut is when you know you did not mean it, so the undo goes in
        // the toast, carrying the two halves as written so it can only put back
        // these same words. Timestamps read to the second, so a pause shorter
        // than that would print as a range from a time to itself.
        const from = formatTime(result.at);
        const to = formatTime(result.tail_at);
        notify(
          result.measured
            ? from === to
              ? `Cut on the measured pause at ${from}.`
              : `Cut on the measured pause, ${from} to ${to}.`
            : `Cut at an estimated ${from} — measure timings for an exact one.`,
          {
            action: {
              label: "Undo",
              onAct: () => joinCaptions(result.cue_ids[0], result.cue_ids[1], result.halves),
            },
          }
        );
        takeHighlights(result.highlights);
        // Cue ids are positional, so the manual expansions move with them.
        setSplitCues((current) => remapSplitCues(current, result.cue_ids));
        takeRecording(result.recording);
        return result;
      } catch (error) {
        notify(`Could not split that caption: ${error.message}`, { kind: "warn" });
        return null;
      } finally {
        done();
      }
    },
    [recordingId, notify, working, joinCaptions, takeHighlights, takeRecording]
  );

  const reattribute = useCallback(
    async (cueId, speaker) => {
      const cue = cueById.get(cueId);
      if (!cue || !speaker || speaker === (cue.speaker || "")) return;
      try {
        const result = await api(`/api/recordings/${recordingId}/cues/${cueId}/speaker`, {
          method: "PATCH",
          body: { speaker },
        });
        if (result.backup_created) {
          notify(`Original transcript saved as ${result.backup_created}.`);
        }
        // Reattributing regroups the whole transcript, so the reader takes it
        // back wholesale rather than trying to patch blocks in place.
        takeRecording(result.recording);
      } catch (error) {
        notify(`Could not reassign that line: ${error.message}`, { kind: "warn" });
      }
    },
    [cueById, recordingId, notify, takeRecording]
  );

  /**
   * Cut a caption in two where two people share it, by double-clicking the word
   * the second one starts on.
   *
   * Zoom's worst habit is putting the end of one turn and the start of the next
   * inside a single caption, and no amount of reattributing captions separates
   * those -- they are one caption. So this is the gesture that divides it.
   */
  const onDoubleClickWord = useCallback(
    (event) => {
      // While correcting text, a double-click means what it always means:
      // select a word. Edit mode has its own split, on the caret.
      if (editing != null) return;
      const cueEl = event.target.closest(".cue");
      if (!cueEl) return;

      // The double-click has already selected the word; its start is where the
      // browser thinks the word begins, which is the point being asked for.
      const selection = window.getSelection();
      let node = null;
      let offset = 0;
      if (selection?.rangeCount) {
        const range = selection.getRangeAt(0);
        if (cueEl === range.startContainer || cueEl.contains(range.startContainer)) {
          node = range.startContainer;
          offset = range.startOffset;
        }
      }
      // Fallback for a double-click that selected nothing -- on punctuation,
      // say. The standard call first, then WebKit's older one.
      if (!node && document.caretPositionFromPoint) {
        const position = document.caretPositionFromPoint(event.clientX, event.clientY);
        if (position && cueEl.contains(position.offsetNode)) {
          node = position.offsetNode;
          offset = position.offset;
        }
      }
      if (!node && document.caretRangeFromPoint) {
        const range = document.caretRangeFromPoint(event.clientX, event.clientY);
        if (range && cueEl.contains(range.startContainer)) {
          node = range.startContainer;
          offset = range.startOffset;
        }
      }
      if (!node) return;

      const cue = cueById.get(cueEl.dataset.cueId);
      if (!cue) return;
      const within = offsetWithin(cueEl, node, offset);
      event.preventDefault();
      selection?.removeAllRanges();
      requestSplit(cue.id, wordStartAt(cue.text, within), cue.text);
    },
    [editing, cueById, requestSplit]
  );

  /* ------------------------------------------------------------- keyboard -- */

  // Registered once, with every moving value read through a ref. A listener that
  // closed over state would move the cursor from where it was ten keys ago.
  const actions = useRef({});
  actions.current = { player, cursor, saveQuote, copySelection, assignSpeaker, selection, roster, setTab, setSplitCues, chunks, setActiveHighlightId, setEditing };

  useEffect(() => {
    const TYPING = new Set(["INPUT", "TEXTAREA", "SELECT"]);
    const onKey = (event) => {
      if (TYPING.has(event.target.tagName) || event.target.isContentEditable) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const a = actions.current;

      const bound = a.roster.find((entry) => entry.key === event.key);
      if (bound) {
        event.preventDefault();
        a.assignSpeaker(bound.name);
        return;
      }

      switch (event.key) {
        case "j":
          event.preventDefault();
          a.cursor.setMode("reading");
          a.cursor.setCursor(cursorIndex.current + 1, { scroll: true });
          break;
        case "k":
          event.preventDefault();
          a.cursor.setMode("reading");
          a.cursor.setCursor(cursorIndex.current - 1, { scroll: true });
          break;
        case " ":
          event.preventDefault();
          a.player.togglePlay();
          break;
        case "ArrowLeft":
          event.preventDefault();
          a.player.nudge(-5);
          break;
        case "ArrowRight":
          event.preventDefault();
          a.player.nudge(5);
          break;
        case "/":
          event.preventDefault();
          a.setTab("search");
          searchRef.current?.focus();
          searchRef.current?.select();
          break;
        case "h":
          event.preventDefault();
          a.saveQuote({});
          break;
        case "c":
          event.preventDefault();
          a.copySelection();
          break;
        case "f":
          event.preventDefault();
          a.cursor.setMode(cursorMode.current === "following" ? "reading" : "following");
          break;
        case "s": {
          // Break the block at the cursor into its captions, so a back-and-forth
          // Zoom filed as one turn can be labelled line by line.
          event.preventDefault();
          const chunk = a.chunks[cursorIndex.current];
          if (!chunk || chunk.cue_ids.length < 2) break;
          a.setSplitCues((current) => {
            const next = new Set(current);
            for (const id of chunk.cue_ids) next.add(id);
            return next;
          });
          break;
        }
        case "e":
          event.preventDefault();
          a.setEditing(cursorIndex.current);
          break;
        case "Escape":
          a.selection.clear();
          a.setActiveHighlightId(null);
          break;
        default:
          break;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  /* ----------------------------------------------------------------- view -- */

  const diagnostics = recording?.transcript?.diagnostics;
  const meta = recording
    ? [
        formatTime(recording.duration),
        `${diagnostics.chunk_count} blocks`,
        `${diagnostics.speakers.length} speakers`,
        recording.media_file || "no media",
      ].join("  ·  ")
    : "";

  return (
    <>
      <header className="topbar">
        <div className="topbar__identity">
          <h1 className="topbar__title">{recording?.title || "Transcript"}</h1>
          <p className="topbar__meta">{meta}</p>
        </div>

        <div className="topbar__search">
          <label className="field">
            <span className="field__key" aria-hidden="true">/</span>
            <input
              ref={searchRef}
              type="search"
              aria-label="Find a quote"
              placeholder="Find a quote"
              autoComplete="off"
              spellCheck="false"
              value={searchQuery}
              onChange={(event) => {
                setSearchQuery(event.target.value);
                setTab("search");
              }}
            />
          </label>
          <button
            className="toggle"
            type="button"
            aria-pressed={searchMode === "regex"}
            title="Match with a regular expression"
            onClick={() => setSearchMode((m) => (m === "regex" ? "fuzzy" : "regex"))}
          >
            .*
          </button>
        </div>

        <div className="topbar__actions">
          <a className="btn" href="/">← Library</a>
          <button
            className="btn"
            type="button"
            aria-pressed={tab === "search"}
            onClick={() => setTab("search")}
          >
            Results
          </button>
          <button
            className="btn"
            type="button"
            aria-pressed={tab === "highlights"}
            onClick={() => setTab("highlights")}
          >
            Quotes <span className="count">{highlights.length}</span>
          </button>
          <ThemeToggle />
        </div>
      </header>

      {recording && (
        <Roster
          roster={roster}
          speakers={speakers}
          onAssign={assignSpeaker}
          onSave={(which, entry) => {
            const next = [...roster];
            if (which === "new") next.push(entry);
            else next[which] = entry;
            saveRoster(next.filter((e) => e.name.trim()));
          }}
          onRemove={(index) => saveRoster(roster.filter((_, i) => i !== index))}
        />
      )}

      {recording && (
        <Timing
          state={align}
          coverage={recording.timing_coverage}
          onAlign={runAlignment}
          onStop={() => {
            stopAlign.current = true;
          }}
        />
      )}

      <div className="workspace">
        <main className="reader" ref={readerRef} tabIndex={-1}>
          <div className="transcript">
            <div className="spine-marker" ref={spineRef} hidden>
              <span className="spine-marker__dot" ref={spineDotRef} hidden />
            </div>
            {failed ? (
              <p className="empty">{failed}</p>
            ) : (
              <Transcript
                chunks={chunks}
                cueById={cueById}
                slices={slices}
                parts={parts}
                activeHighlightId={activeHighlightId}
                chunksRef={chunksRef}
                onPlayFrom={(at) => {
                  cursor.setMode("following");
                  player.seekAndPlay(at, { play: true });
                }}
                onHighlightClick={(id) => {
                  setActiveHighlightId(id);
                  setTab("highlights");
                }}
                onDoubleClickWord={onDoubleClickWord}
                editingIndex={editing}
                renderEditor={(chunk) => (
                  <EditBlock
                    chunk={chunk}
                    cueById={cueById}
                    speakers={speakers}
                    onCommitText={commitText}
                    onReattribute={reattribute}
                    onSplitAtCaret={(cueId, offset, text) => requestSplit(cueId, offset, text)}
                    onJoinWithPrevious={async (cueId, position, text) => {
                      if (position <= 0) {
                        notify("Nothing above this line in the block to join it to.");
                        return;
                      }
                      const above = chunk.cue_ids[position - 1];
                      const previous = cueById.get(above);
                      // A join works on the captions as the file has them, so
                      // any typing in this line is saved first.
                      await joinCaptions(above, cueId, [previous?.text ?? "", text], {
                        keepEditing: true,
                      });
                    }}
                    onPlayLine={(cue) => player.seekAndPlay(cue.start, { play: true })}
                    onCueLine={(cue) => player.cue(cue.start)}
                    onDone={() => setEditing(null)}
                  />
                )}
              />
            )}
          </div>
        </main>

        <Sidebar
          tab={tab}
          highlights={highlights}
          colors={colors}
          vocabulary={vocabulary}
          activeHighlightId={activeHighlightId}
          searchResults={searchResults}
          searchQuery={searchQuery}
          highlightsPath={recording?.highlights_file || ""}
          onJumpToQuote={(highlight) => {
            setActiveHighlightId(highlight.id);
            player.seekAndPlay(highlight.start_time, { play: false });
            const index = chunks.findIndex((c) => c.cue_ids.includes(highlight.start_cue_id));
            if (index >= 0) cursor.setCursor(index, { scroll: true });
          }}
          onPatchQuote={patchQuote}
          onDeleteQuote={deleteQuote}
          onCopyQuote={(h) => copyLine(h.text, h.speaker, h.start_time)}
          onJumpToResult={(hit) => {
            const index = chunks.findIndex((c) => c.id === hit.chunk_id);
            if (index >= 0) cursor.setCursor(index, { scroll: true });
            player.seekAndPlay(hit.start_time, { play: false });
          }}
        />
      </div>

      {Boolean(playable.length) && (
        <Dock
          media={player.media}
          duration={duration}
          playing={playing}
          anyVideo={anyVideo}
          clockRef={clockRef}
          scrubRef={scrubRef}
          onTogglePlay={player.togglePlay}
          onScrub={(value, commit) => {
            const at = (value / 1000) * duration;
            if (!commit) {
              player.scrubbing.current = true;
              if (clockRef.current) clockRef.current.textContent = formatTime(at);
              return;
            }
            player.scrubbing.current = false;
            player.seek(at);
            cursor.setMode("following");
          }}
        />
      )}

      <QuoteBar
        anchors={selection.anchors}
        colors={colors}
        roster={roster}
        speakers={speakers}
        onSave={saveQuote}
        onCopy={copySelection}
        onHandOver={handOver}
      />
    </>
  );
}
