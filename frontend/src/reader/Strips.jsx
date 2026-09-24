/* The two strips under the topbar: who is in the room, and how the times were got. */

import { useEffect, useRef, useState } from "react";

/**
 * The speaker keys: what they are, and where they are changed.
 *
 * This lives here rather than in the transcript because nobody should have to
 * open a .vtt to name the people in it. It doubles as a reminder of which key is
 * whom while reading, which is why it stays on screen.
 */
export function Roster({ roster, speakers, onAssign, onSave, onRemove }) {
  const [editing, setEditing] = useState(null); // index | "new" | null
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const nameInput = useRef(null);

  const begin = (which) => {
    const entry = which === "new" ? { key: "", name: "" } : roster[which];
    setKey(entry.key || "");
    setName(entry.name || "");
    setEditing(which);
  };

  useEffect(() => {
    if (editing != null) {
      nameInput.current?.focus();
      nameInput.current?.select();
    }
  }, [editing]);

  if (editing != null) {
    const commit = () => {
      onSave(editing, { key: key.trim(), name: name.trim() });
      setEditing(null);
    };
    return (
      <div className="roster">
        <span className="roster__lead">{editing === "new" ? "new speaker" : "rename"}</span>
        <input
          className="roster__field roster__field--key"
          maxLength={1}
          value={key}
          placeholder="key"
          aria-label="Key"
          onChange={(event) => setKey(event.target.value)}
        />
        <input
          className="roster__field"
          ref={nameInput}
          value={name}
          placeholder="name"
          aria-label="Speaker name"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
            if (event.key === "Escape") setEditing(null);
          }}
        />
        <button className="btn" type="button" onClick={commit}>Save</button>
        <button className="btn" type="button" onClick={() => setEditing(null)}>Cancel</button>
      </div>
    );
  }

  // Offering the labels already in the file is right when there are several of
  // them -- they are the real speakers and just need keys. It is wrong when
  // there is one, because that label is the room rather than a person, and
  // rostering it would let its lines join and defeat labelling them apart.
  const detected =
    speakers.length > 1 ? speakers.filter((who) => !roster.some((e) => e.name === who)) : [];

  return (
    <div className="roster">
      <span className="roster__lead">assign this block</span>
      {roster.length ? (
        roster.map((entry, index) => (
          <span className="roster__who" key={entry.name}>
            <button
              className="roster__hit"
              type="button"
              title={`Assign this block to ${entry.name}`}
              onClick={() => onAssign(entry.name)}
            >
              <kbd>{entry.key || "·"}</kbd>
              {entry.name}
            </button>
            <button
              className="roster__edit"
              type="button"
              aria-label={`Rename ${entry.name}`}
              onClick={() => begin(index)}
            >
              ✎
            </button>
            <button
              className="roster__edit"
              type="button"
              aria-label={`Remove ${entry.name}`}
              onClick={() => onRemove(index)}
            >
              ✕
            </button>
          </span>
        ))
      ) : (
        <span className="roster__empty">
          {speakers.length > 1
            ? "nobody named yet — add the speakers to label with a keypress"
            : "one label covers everyone here — add who was actually in the room"}
        </span>
      )}
      <button className="btn" type="button" onClick={() => begin("new")}>
        + Speaker
      </button>
      {detected.map((who) => (
        <button
          className="roster__suggest"
          type="button"
          key={who}
          title={`Add ${who} to the roster`}
          onClick={() => onSave("new", { key: "", name: who })}
        >
          + {who}
        </button>
      ))}
    </div>
  );
}

/**
 * Times inside a caption are interpolated until the words have been aligned to
 * the audio, which is wrong by about the length of any pause the speaker took.
 * This strip says which of the two you are looking at, and offers to fix it.
 *
 * Alignment is not automatic: it reads the audio and costs real seconds, so it
 * is a thing you ask for.
 */
export function Timing({ state, coverage, onAlign, onStop }) {
  const cover = coverage || { timed: 0, total: 0, complete: false };

  // Nothing to offer and nothing measured: stay out of the way entirely.
  if (!state.available && !cover.timed) return null;

  if (state.running) {
    const pct = state.total ? Math.round((state.done / state.total) * 100) : 0;
    return (
      <div className="timing">
        <span className="roster__lead">timings</span>
        <span className="timing__bar">
          <span className="timing__fill" style={{ width: `${pct}%` }} />
        </span>
        <span className="timing__state">
          measuring — {state.done} of {state.total} captions
        </span>
        <button className="btn" type="button" onClick={onStop}>Stop</button>
      </div>
    );
  }

  return (
    <div className="timing">
      <span className="roster__lead">timings</span>
      <span className="timing__state">
        {cover.complete
          ? "aligned to the audio"
          : `${cover.timed} of ${cover.total} captions measured`}
      </span>
      {state.available && !cover.complete && (
        <button className="btn" type="button" onClick={onAlign}>
          {cover.timed ? "Measure the rest" : "Measure word timings"}
        </button>
      )}
      {!state.available && <span className="timing__why">{state.reason}</span>}
    </div>
  );
}
