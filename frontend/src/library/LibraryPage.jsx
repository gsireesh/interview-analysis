/* The library: every recording in the study, and one search across all of them. */

import { useEffect, useMemo, useRef, useState } from "react";
import { api, formatTime } from "../lib/util.js";
import { useToast } from "../ui/Toast.jsx";
import { ThemeToggle } from "../ui/Theme.jsx";

export function readerLink(recordingId, extra = "") {
  return `/reader?recording=${encodeURIComponent(recordingId)}${extra}`;
}

export default function LibraryPage() {
  const { notify } = useToast();
  const [data, setData] = useState(null);
  // Held here rather than in the search box: the box is chrome in the topbar and
  // the results are content in the sheet, and they are one feature.
  const [results, setResults] = useState(null);

  useEffect(() => {
    api("/api/library")
      .then(setData)
      .catch((error) => notify(`Could not load the library: ${error.message}`, { kind: "warn" }));
  }, [notify]);

  // Said once, when the library says a folder could not be read.
  const reported = useRef(false);
  useEffect(() => {
    if (!data || reported.current) return;
    reported.current = true;
    for (const bad of data.unreadable || []) {
      notify(`${bad.folder} could not be read: ${bad.reason}`, { kind: "warn" });
    }
  }, [data, notify]);

  // Which tags each recording carries, for the card chips.
  const tagsByRecording = useMemo(() => {
    const byRecording = new Map();
    for (const entry of data?.tags || []) {
      for (const [recordingId, count] of Object.entries(entry.recordings)) {
        if (!byRecording.has(recordingId)) byRecording.set(recordingId, []);
        byRecording.get(recordingId).push([entry.tag, count]);
      }
    }
    for (const list of byRecording.values()) list.sort((a, b) => b[1] - a[1]);
    return byRecording;
  }, [data]);

  const meta = data
    ? [
        data.root || "",
        `${data.recordings.length} recordings`,
        `${data.quote_count} quotes`,
        `${data.tags.length} tags`,
      ]
        .filter(Boolean)
        .join("  ·  ")
    : "";

  return (
    <>
      <header className="topbar">
        <div className="topbar__identity">
          <h1 className="topbar__title">Library</h1>
          <p className="topbar__meta">{meta}</p>
        </div>

        <LibrarySearch onResults={setResults} />

        <div className="topbar__actions">
          <nav className="tabs">
            <a className="btn" href="/" aria-current="page">Recordings</a>
            <a className="btn" href="/themes">Themes</a>
          </nav>
          <ThemeToggle />
        </div>
      </header>

      <main className="sheet">
        {results && <SearchResults results={results} />}

        <section>
          <header className="sheet__head">
            <h2 className="sheet__title">Recordings</h2>
            <span className="sheet__count">{data?.recordings.length ?? ""}</span>
          </header>
          {data && !data.recordings.length ? (
            <p className="empty">No recordings found under this folder.</p>
          ) : (
            <div className="cards">
              {(data?.recordings || []).map((recording) => (
                <RecordingCard
                  key={recording.id}
                  recording={recording}
                  tags={tagsByRecording.get(recording.id) || []}
                />
              ))}
            </div>
          )}
        </section>

        {Boolean(data?.tags.length) && (
          <section>
            <header className="sheet__head">
              <h2 className="sheet__title">Tags across the library</h2>
              <span className="sheet__count">{data.tags.length}</span>
            </header>
            <div className="tag-rail">
              {data.tags.map((entry) => (
                <a
                  className="tag-chip"
                  key={entry.tag}
                  href={`/themes?tag=${encodeURIComponent(entry.tag)}`}
                >
                  <span className="tag-chip__name">{entry.tag}</span>
                  <span className="tag-chip__counts">
                    {entry.quote_count} in {entry.recording_count}
                  </span>
                </a>
              ))}
            </div>
          </section>
        )}
      </main>
    </>
  );
}

function RecordingCard({ recording, tags }) {
  return (
    <a className="card" href={readerLink(recording.id)}>
      <h3 className="card__title">{recording.title}</h3>
      <p className="card__facts">
        <span className="card__fact card__fact--time">{formatTime(recording.duration)}</span>
        {recording.speakers?.length ? (
          <span className="card__fact">{recording.speakers.length} speakers</span>
        ) : (
          <span className="card__fact card__fact--warn">no speakers detected</span>
        )}
        {recording.part_count > 1 && (
          <span className="card__fact">{recording.part_count} recordings joined</span>
        )}
        {recording.media_file ? (
          <span className="card__fact">{recording.media_kind}</span>
        ) : (
          <span className="card__fact card__fact--warn">no media</span>
        )}
      </p>
      <p className="card__quotes">
        {recording.quote_count ? (
          <>
            <strong>{recording.quote_count}</strong>{" "}
            quote{recording.quote_count === 1 ? "" : "s"}
          </>
        ) : (
          <span className="card__fact">no quotes yet</span>
        )}
      </p>
      <div className="tags">
        {tags.slice(0, 6).map(([tag, count]) => (
          <span className="tag" key={tag}>
            {tag}
            <span className="tag__count">{count}</span>
          </span>
        ))}
      </div>
    </a>
  );
}

function LibrarySearch({ onResults }) {
  const { notify } = useToast();
  const [query, setQuery] = useState("");
  const input = useRef(null);

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      onResults(null);
      return;
    }
    // Debounced by letting a pending timer be cleared when the query moves on,
    // which also makes an in-flight answer for a stale term unreachable.
    const timer = setTimeout(() => {
      api(`/api/library/search?q=${encodeURIComponent(term)}`)
        .then(({ results }) => onResults(results))
        .catch((error) => notify(`Search failed: ${error.message}`, { kind: "warn" }));
    }, 180);
    return () => clearTimeout(timer);
  }, [query, notify, onResults]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "/" && document.activeElement !== input.current) {
        event.preventDefault();
        input.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="topbar__search">
      <label className="field">
        {/* The key that focuses this, not its name -- so it is spoken as a hint
            rather than becoming the accessible name of the box. */}
        <span className="field__key" aria-hidden="true">/</span>
        <input
          ref={input}
          type="search"
          aria-label="Search every transcript"
          placeholder="Search every transcript"
          autoComplete="off"
          spellCheck="false"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
    </div>
  );
}

function SearchResults({ results }) {
  return (
    <section className="results-strip">
      <header className="sheet__head">
        <h2 className="sheet__title">Search results</h2>
        <span className="sheet__count">{results.length}</span>
      </header>
      {results.length ? (
        results.map((hit) => (
          <a
            className="result"
            key={`${hit.recording_id}:${hit.cue_id}:${hit.match_start}`}
            href={readerLink(hit.recording_id, `&t=${hit.start_time}`)}
          >
            <span className="result__head">
              <span className="result__speaker">{hit.recording_title}</span>
              <span className="result__kind">{hit.speaker || "—"}</span>
              <span className="result__time">{formatTime(hit.start_time)}</span>
            </span>
            <p className="result__text">
              {hit.snippet.slice(0, hit.match_start)}
              <mark>{hit.snippet.slice(hit.match_start, hit.match_end)}</mark>
              {hit.snippet.slice(hit.match_end)}
            </p>
          </a>
        ))
      ) : (
        <p className="empty">Nothing found in any transcript.</p>
      )}
    </section>
  );
}
