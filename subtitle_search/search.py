"""Quote search over a transcript.

Two passes. Exact case-insensitive substring always ranks first, because when you
remember a phrase verbatim you want it at the top and nowhere else. Fuzzy matching
then covers the rest, which matters for ASR text where the transcript may not have
heard the word the way you remember it.

Matching runs against chunk text rather than individual cues, so a phrase that
straddles a cue boundary is still findable -- Zoom splits cues mid-sentence often
enough that per-cue search misses real quotes. Matches are then mapped back down
to the cue that contains them, which is what makes a result seekable.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .models import Chunk, Transcript

try:  # pragma: no cover - exercised by absence, not by tests
    from rapidfuzz import fuzz

    _HAS_RAPIDFUZZ = True
except ImportError:  # pragma: no cover
    _HAS_RAPIDFUZZ = False

#: partial_ratio score below which a fuzzy match is noise rather than a near-miss.
FUZZY_THRESHOLD = 78

#: Characters of surrounding chunk text to show around a match.
SNIPPET_RADIUS = 110

MIN_QUERY_LENGTH = 2


@dataclass
class ChunkText:
    """A chunk's text, plus the cue each character came from."""

    chunk: Chunk
    text: str
    #: (cue_id, start_offset, end_offset) into ``text``, in order.
    spans: list[tuple[str, int, int]]

    def locate(self, offset: int) -> tuple[str, int]:
        """Map a chunk-level offset back to ``(cue_id, offset_within_cue)``."""
        for cue_id, start, end in self.spans:
            if start <= offset < end:
                return cue_id, offset - start
        if self.spans:
            cue_id, start, end = self.spans[-1]
            return cue_id, max(0, end - start)
        return "", 0


def build_chunk_texts(transcript: Transcript) -> list[ChunkText]:
    """Flatten each chunk into searchable text with a cue offset map."""
    built: list[ChunkText] = []
    for chunk in transcript.chunks:
        parts: list[str] = []
        spans: list[tuple[str, int, int]] = []
        cursor = 0
        for cue_id in chunk.cue_ids:
            cue = transcript.cue(cue_id)
            if cue is None:
                continue
            if parts:
                parts.append(" ")
                cursor += 1
            spans.append((cue_id, cursor, cursor + len(cue.text)))
            parts.append(cue.text)
            cursor += len(cue.text)
        built.append(ChunkText(chunk=chunk, text="".join(parts), spans=spans))
    return built


def _snippet(text: str, start: int, end: int) -> tuple[str, int, int]:
    """Trim text to a window around [start, end), returning adjusted offsets."""
    left = max(0, start - SNIPPET_RADIUS)
    right = min(len(text), end + SNIPPET_RADIUS)
    # Avoid slicing mid-word at either edge.
    if left > 0:
        space = text.find(" ", left, start)
        if space != -1:
            left = space + 1
    if right < len(text):
        space = text.rfind(" ", end, right)
        if space != -1:
            right = space

    snippet = text[left:right]
    prefix = "…" if left > 0 else ""
    suffix = "…" if right < len(text) else ""
    return prefix + snippet + suffix, start - left + len(prefix), end - left + len(prefix)


def _result(
    transcript: Transcript,
    entry: ChunkText,
    start: int,
    end: int,
    score: float,
    kind: str,
) -> dict:
    cue_id, cue_offset = entry.locate(start)
    cue = transcript.cue(cue_id)
    start_time = cue.time_at_offset(cue_offset) if cue else entry.chunk.start
    snippet, match_start, match_end = _snippet(entry.text, start, end)
    return {
        "chunk_id": entry.chunk.id,
        "cue_id": cue_id,
        "speaker": entry.chunk.speaker,
        "start_time": round(start_time, 3),
        "chunk_start": entry.chunk.start,
        "snippet": snippet,
        "match_start": match_start,
        "match_end": match_end,
        "score": round(float(score), 1),
        "kind": kind,
    }


def search(transcript: Transcript, query: str, limit: int = 60) -> list[dict]:
    query = (query or "").strip()
    if len(query) < MIN_QUERY_LENGTH:
        return []

    entries = build_chunk_texts(transcript)
    needle = query.lower()
    exact: list[dict] = []
    matched_chunks: set[str] = set()

    for entry in entries:
        haystack = entry.text.lower()
        position = haystack.find(needle)
        hits = 0
        while position != -1 and hits < 3:
            exact.append(
                _result(transcript, entry, position, position + len(needle), 100.0, "exact")
            )
            matched_chunks.add(entry.chunk.id)
            hits += 1
            position = haystack.find(needle, position + len(needle))

    exact.sort(key=lambda r: r["start_time"])
    if len(exact) >= limit or not _HAS_RAPIDFUZZ:
        return exact[:limit]

    fuzzy: list[dict] = []
    for entry in entries:
        if entry.chunk.id in matched_chunks or not entry.text:
            continue
        alignment = fuzz.partial_ratio_alignment(needle, entry.text.lower(), score_cutoff=FUZZY_THRESHOLD)
        if alignment is None or alignment.score < FUZZY_THRESHOLD:
            continue
        fuzzy.append(
            _result(
                transcript,
                entry,
                alignment.dest_start,
                max(alignment.dest_end, alignment.dest_start + 1),
                alignment.score,
                "fuzzy",
            )
        )

    # Best-scoring fuzzy matches first; ties broken by position so results read
    # in transcript order rather than arbitrarily.
    fuzzy.sort(key=lambda r: (-r["score"], r["start_time"]))
    return (exact + fuzzy)[:limit]


def regex_search(transcript: Transcript, pattern: str, limit: int = 60) -> list[dict]:
    """Regex search, available alongside fuzzy for when you need precision."""
    try:
        compiled = re.compile(pattern, re.IGNORECASE)
    except re.error as exc:
        raise ValueError(f"invalid regular expression: {exc}") from exc

    results: list[dict] = []
    for entry in build_chunk_texts(transcript):
        for match in compiled.finditer(entry.text):
            if match.end() == match.start():
                continue
            results.append(
                _result(transcript, entry, match.start(), match.end(), 100.0, "regex")
            )
            if len(results) >= limit:
                return results
    return results
