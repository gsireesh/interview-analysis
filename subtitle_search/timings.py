"""Word-level timings, and where they are kept.

Zoom gives honest times at a caption's *edges* and nothing inside it, so the
reader interpolates: a character offset becomes a fraction of the caption's
duration. That is wrong by roughly the length of any pause the speaker took, and
Zoom captions run to ten seconds. Aligning the words to the audio replaces the
guess with a measurement.

Two decisions carry this module.

**Timings live beside the transcript, not in it.** The VTT stays the file Zoom
wrote plus whatever corrections have been made to it; timings go in
``session.words.json``. A folder without that file behaves exactly as it always
did, so alignment is something you turn on rather than something you migrate to.

**A word is addressed by its position in the part's word sequence**, not by cue.
This is what makes on-demand alignment safe: splitting a caption in two leaves the
part's sequence of words *identical*, so every timing stays valid with no
remapping at all. Corrections do change the sequence, so those shift the indices
after them -- and every timing carries the word it was measured against, so a
desync is detected on load and degrades to interpolation instead of quietly
reporting the wrong second of audio.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path

WORDS_FILENAME = "session.words.json"
SCHEMA_VERSION = 1

#: A word for addressing purposes: a run of non-space. Punctuation rides along
#: with its word, which keeps this index space identical to what a reader would
#: count and makes it independent of how the aligner normalizes text.
_WORD_RE = re.compile(r"\S+")

#: Compared for verification, not for display: alignment is case- and
#: punctuation-blind, so a corrected comma must not invalidate a good timing.
_STRIP_RE = re.compile(r"[^a-z0-9']+")


def normalize_word(word: str) -> str:
    return _STRIP_RE.sub("", word.lower())


def split_words(text: str) -> list[tuple[int, int, str]]:
    """``(char_start, char_end, word)`` for each word in a caption's text."""
    return [(m.start(), m.end(), m.group()) for m in _WORD_RE.finditer(text)]


@dataclass(frozen=True)
class TimedWord:
    """One measured word, in the timeline of its own transcript file."""

    #: Position in the part's word sequence, counting from its first caption.
    index: int
    #: The word as it read when measured, normalized. Guards against desync.
    word: str
    start: float
    end: float

    def to_json(self) -> list:
        # A list rather than an object: there is one of these per word, and a
        # two-hour interview has twenty thousand of them.
        return [self.index, self.word, round(self.start, 3), round(self.end, 3)]

    @classmethod
    def from_json(cls, raw) -> "TimedWord | None":
        try:
            index, word, start, end = raw[0], raw[1], float(raw[2]), float(raw[3])
        except (TypeError, ValueError, IndexError):
            return None
        if not isinstance(index, int) or index < 0 or end < start:
            return None
        return cls(index=index, word=str(word), start=start, end=end)


class TimingStore:
    """Reads and writes one session's word timings."""

    def __init__(self, path: Path):
        self.path = path
        self._data = self._load()

    # -- persistence ------------------------------------------------------

    def _empty(self) -> dict:
        return {"version": SCHEMA_VERSION, "parts": {}}

    def _load(self) -> dict:
        if not self.path.exists():
            return self._empty()
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            # Timings are derived data: a corrupt file is worth nothing and
            # costs one re-run, so it is replaced rather than preserved.
            return self._empty()
        if not isinstance(data, dict) or not isinstance(data.get("parts"), dict):
            return self._empty()
        return data

    def _write(self) -> None:
        handle = tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            dir=str(self.path.parent),
            prefix=self.path.name + ".",
            suffix=".tmp",
            delete=False,
        )
        try:
            with handle:
                json.dump(self._data, handle, ensure_ascii=False)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(handle.name, self.path)
        except BaseException:
            Path(handle.name).unlink(missing_ok=True)
            raise

    # -- queries ----------------------------------------------------------

    def words(self, vtt_name: str) -> dict[int, TimedWord]:
        """Every measured word for one transcript file, by word index."""
        raw = self._data["parts"].get(vtt_name) or []
        found: dict[int, TimedWord] = {}
        for entry in raw:
            word = TimedWord.from_json(entry)
            if word is not None:
                found[word.index] = word
        return found

    @property
    def empty(self) -> bool:
        return not any(self._data["parts"].values())

    # -- mutations --------------------------------------------------------

    def record(self, vtt_name: str, words: list[TimedWord]) -> None:
        """Merge freshly measured words in, replacing any they overlap."""
        if not words:
            return
        existing = self.words(vtt_name)
        for word in words:
            existing[word.index] = word
        self._store(vtt_name, existing)
        self._write()

    def drop(self, vtt_name: str, first_index: int, last_index: int) -> None:
        """Forget a stretch of timings, because the words there changed."""
        existing = self.words(vtt_name)
        for index in [i for i in existing if first_index <= i <= last_index]:
            del existing[index]
        self._store(vtt_name, existing)
        self._write()

    def shift(self, vtt_name: str, from_index: int, delta: int) -> None:
        """Move indices along after a correction added or removed words.

        Splitting a caption never needs this -- it leaves the word sequence
        untouched -- but rewording one does, or every timing after the edit would
        describe the wrong word.
        """
        if not delta:
            return
        existing = self.words(vtt_name)
        moved: dict[int, TimedWord] = {}
        for index, word in existing.items():
            if index < from_index:
                moved[index] = word
                continue
            new_index = index + delta
            if new_index >= 0:
                moved[new_index] = TimedWord(new_index, word.word, word.start, word.end)
        self._store(vtt_name, moved)
        self._write()

    def _store(self, vtt_name: str, words: dict[int, TimedWord]) -> None:
        self._data["parts"][vtt_name] = [
            words[index].to_json() for index in sorted(words)
        ]


def attach(cues, timings: dict[int, TimedWord], offset: float):
    """Hand each cue the measured spans of its own words.

    Yields ``(cue, spans)`` where a span is ``(char_start, char_end, start, end)``
    in *session* time. Only words whose text still matches what was measured get
    a span, so a caption corrected since alignment falls back to interpolation
    for the part that changed rather than reporting a stale measurement.

    ``cues`` must be one part's cues in transcript order: the index space is the
    running word count across the file.
    """
    position = 0
    for cue in cues:
        spans: list[tuple[int, int, float, float]] = []
        for char_start, char_end, word in split_words(cue.text):
            measured = timings.get(position)
            position += 1
            if measured is None or measured.word != normalize_word(word):
                continue
            spans.append(
                (char_start, char_end, measured.start + offset, measured.end + offset)
            )
        yield cue, tuple(spans)


def word_index_of(cues, cue_id: str) -> int:
    """Where a caption's first word falls in its part's word sequence."""
    return word_index_map(cues).get(cue_id, 0)


def word_index_map(cues) -> dict[str, int]:
    """Every caption's first word position, for one part's cues in order."""
    positions: dict[str, int] = {}
    running = 0
    for cue in cues:
        positions[cue.id] = running
        running += len(split_words(cue.text))
    return positions


def coverage(transcript) -> dict:
    """How much of the session has been measured rather than interpolated."""
    cues = transcript.cues
    timed = [cue for cue in cues if cue.timed]
    return {
        "timed": len(timed),
        "total": len(cues),
        "complete": bool(cues) and len(timed) == len(cues),
    }


def unmeasured(transcript, limit: int) -> list:
    """The next captions with no measurement, in reading order.

    Alignment is handed out in batches so the reader can show progress and stop
    partway: each batch is written before the next is asked for, so an interrupted
    run keeps everything it measured.
    """
    found = []
    for cue in transcript.cues:
        if cue.timed or not cue.text.strip():
            continue
        found.append(cue)
        if len(found) >= limit:
            break
    return found
