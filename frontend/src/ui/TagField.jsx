/* A tag field that completes against the whole study.
 *
 * The field before this was one text box of comma-separated tags with a
 * <datalist> hung off it, which cannot work: a datalist matches the entire
 * value, so once you have typed "trust, pri" it has nothing to offer. Tags are
 * tokens, so the field holds tokens.
 *
 * The suggestions come from every recording in the library, not just this one.
 * That is the whole point of it: the moment to stop someone inventing
 * "privacy-concerns" alongside an existing "privacy" is while they are typing
 * the second one, and the only way to know is to look outside the file being
 * edited. Each suggestion carries how widely it is already used, so the
 * established tag is the obvious pick.
 */

import { useId, useMemo, useRef, useState } from "react";

const MAX_SUGGESTIONS = 8;

function normalize(tag) {
  return tag.trim().replace(/\s+/g, " ");
}

/** Rank vocabulary against what has been typed: prefix beats substring. */
export function rank(vocabulary, query, chosen) {
  const needle = query.trim().toLowerCase();
  const taken = new Set(chosen.map((t) => t.toLowerCase()));

  return vocabulary
    .filter((entry) => !taken.has(entry.tag.toLowerCase()))
    .map((entry) => {
      const name = entry.tag.toLowerCase();
      if (!needle) return { entry, score: 0 };
      if (name.startsWith(needle)) return { entry, score: 2 };
      if (name.includes(needle)) return { entry, score: 1 };
      return null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || b.entry.recording_count - a.entry.recording_count)
    .slice(0, MAX_SUGGESTIONS)
    .map((hit) => hit.entry);
}

export default function TagField({ tags, vocabulary, onCommit }) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const host = useRef(null);
  const input = useRef(null);
  const listId = useId();

  const suggestions = useMemo(() => rank(vocabulary, draft, tags), [vocabulary, draft, tags]);

  const typed = normalize(draft);
  const coining =
    typed && !suggestions.some((entry) => entry.tag.toLowerCase() === typed.toLowerCase());
  const options = coining ? [...suggestions, { tag: typed, isNew: true }] : suggestions;

  const add = (tag) => {
    const clean = normalize(tag);
    if (clean && !tags.some((t) => t.toLowerCase() === clean.toLowerCase())) {
      onCommit([...tags, clean]);
    }
    setDraft("");
    setOpen(false);
    setActive(-1);
  };

  const remove = (index) => onCommit(tags.filter((_, i) => i !== index));

  const onKeyDown = (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      if (!options.length) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      // From nothing selected, down lands on the first option and up on the
      // last. Getting this wrong skips the top suggestion -- which is the most
      // established tag, and the one the field exists to steer you towards.
      setActive((current) =>
        current < 0
          ? step > 0
            ? 0
            : options.length - 1
          : (current + step + options.length) % options.length
      );
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      add(active >= 0 && options[active] ? options[active].tag : draft);
      return;
    }

    if (event.key === "," || event.key === "Tab") {
      if (draft.trim()) {
        event.preventDefault();
        add(draft);
      }
      return;
    }

    if (event.key === "Escape") {
      if (open) {
        event.stopPropagation();
        setOpen(false);
        setActive(-1);
      }
      return;
    }

    // Backspace on an empty box takes the last chip back off.
    if (event.key === "Backspace" && !draft && tags.length) {
      event.preventDefault();
      remove(tags.length - 1);
    }
  };

  return (
    <div className="tagfield" ref={host}>
      <span className="tagfield__chips">
        {tags.map((tag, index) => (
          <span className="chip" key={tag}>
            {tag}
            <button
              className="chip__x"
              type="button"
              aria-label={`Remove ${tag}`}
              onClick={() => remove(index)}
            >
              ✕
            </button>
          </span>
        ))}
      </span>

      <input
        ref={input}
        className="tagfield__input"
        type="text"
        placeholder={tags.length ? "" : "Tag"}
        value={draft}
        role="combobox"
        aria-expanded={open && options.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        aria-label="Tags"
        onChange={(event) => {
          setDraft(event.target.value);
          setActive(-1);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Late enough for a click on an option to land first.
          setTimeout(() => {
            if (!host.current?.contains(document.activeElement)) {
              setOpen(false);
              setActive(-1);
            }
          }, 140);
        }}
        onKeyDown={onKeyDown}
      />

      <ul className="tagfield__list" id={listId} role="listbox" hidden={!open || !options.length}>
        {options.map((entry, index) => (
          <li
            key={entry.tag}
            id={`${listId}-${index}`}
            className={
              entry.isNew
                ? "tagfield__option tagfield__option--new"
                : "tagfield__option"
            }
            role="option"
            aria-selected={index === active}
            onMouseDown={(event) => {
              event.preventDefault();
              add(entry.tag);
              input.current?.focus();
            }}
          >
            <span className="tagfield__tag">{entry.tag}</span>
            <span className="tagfield__use">
              {entry.isNew
                ? "new tag"
                : `${entry.quote_count} in ${entry.recording_count}`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
