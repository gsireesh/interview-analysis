"""Turning a study session's diary into spans on the recording's timeline.

The study interface writes ``<session_id>_diary.jsonl``: one row per thing the
participant did, ``{"session_id", "timestamp", "event_type", "detail"}``, with
``timestamp`` an ISO 8601 UTC time on the study server's clock. This module reads
one such file and places each event on the session timeline, in session seconds,
ready to be stored as imported video codes (see ``imported.py``). It holds no
state and writes nothing.

Events that come as a start and an end become one span between them; every other
event is a moment, and gets ``SINGLE_LENGTH`` seconds from when it happened. A
start the diary never ends runs to the end of the recording part it falls in; an
end with no start is kept as a moment under its own name.

Two ways of finding a time in the recording:

- ``zoom_start``: every part's file names carry Zoom's ``GMT<date>-<time>``
  token, so each part's wall-clock start is known and an event lands in the part
  that was recording at that moment. An event in no part -- before recording,
  after it, or in a gap between parts -- is skipped.
- ``first_event``: some part has no start time, so the earliest event is placed
  at 0:00 and the shared offset is what lines the row up with the video.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

#: Recognised in a recording folder; the study writes ``<session_id>_diary.jsonl``.
DIARY_GLOB = "*_diary.jsonl"

#: Seconds given to an event that is a moment, and the least any span is given.
SINGLE_LENGTH = 1.0

#: Start event -> (end event, span name, which detail fields tie an end to its start).
#: A ``None`` key pairs in diary order regardless of detail: a read-aloud stop names
#: the turn of the next reply played rather than the one it stops, and tab focus
#: carries nothing else to match on.
PAIRS = {
    "conversation_started": ("conversation_ended", "conversation", ("conversation_id",)),
    "response_generation_started": ("response_generation_finished", "response_generation", ("conversation_id", "turn", "version")),
    "prompt_typing_started": ("prompt_typing_ended", "prompt_typing", ("conversation_id", "turn", "version")),
    "scroll_started": ("scroll_ended", "scroll", ("conversation_id", "pane")),
    "read_aloud_started": ("read_aloud_stopped", "read_aloud", None),
    "tab_blurred": ("tab_focused", "off_tab", None),
}
_ENDS = {end: start for start, (end, _, _) in PAIRS.items()}

#: A reload writes an extra ``tab_closed`` end before the real one, so a
#: conversation is closed by its last end rather than its first.
_CLOSED_BY_LAST = {"conversation_started"}


@dataclass
class Interval:
    """One event or start/end pair, in wall-clock time, before it is placed."""

    name: str
    start: datetime
    #: ``None`` when the diary never ends it; ``start`` for a moment.
    end: datetime | None
    detail: dict
    #: Line numbers in the diary it came from, which name the span.
    rows: tuple[int, ...]
    moment: bool = False


def find_diary(folder: Path) -> Path | str | None:
    """Return the folder's one diary, ``None`` if it has none, or ``"ambiguous"`` if it has several."""
    found = sorted(Path(folder).glob(DIARY_GLOB))
    if not found:
        return None
    return found[0] if len(found) == 1 else "ambiguous"


def parse_time(value) -> datetime | None:
    """Return a diary timestamp as a naive UTC datetime, or ``None`` if it is missing or unreadable.

    Naive, to compare with a part's ``started_at``, which is read from Zoom's
    ``GMT`` file-name token without a zone.
    """
    if not isinstance(value, str):
        return None
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        return None
    if moment.tzinfo is not None:
        moment = moment.astimezone(timezone.utc).replace(tzinfo=None)
    return moment


def read_rows(path: Path) -> tuple[list[tuple[int, datetime, dict]], dict[str, int]]:
    """Read a diary into ``(line number, time, row)`` in time order, and count what was left out.

    Left out: rows with no usable timestamp (``no_timestamp``), rows that are not
    JSON objects (``unreadable``), and rows identical to an earlier one in event,
    time and detail (``duplicate``), since the diary repeats an event on the
    boundary between two conversations into both.
    """
    rows, skipped, seen = [], {}, set()
    with open(path, encoding="utf-8") as handle:
        for number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except ValueError:
                row = None
            if not isinstance(row, dict) or not row.get("event_type"):
                skipped["unreadable"] = skipped.get("unreadable", 0) + 1
                continue
            moment = parse_time(row.get("timestamp"))
            if moment is None:
                skipped["no_timestamp"] = skipped.get("no_timestamp", 0) + 1
                continue
            key = (row["event_type"], row.get("timestamp"), json.dumps(row.get("detail"), sort_keys=True))
            if key in seen:
                skipped["duplicate"] = skipped.get("duplicate", 0) + 1
                continue
            seen.add(key)
            rows.append((number, moment, row))
    rows.sort(key=lambda r: (r[1], r[0]))
    return rows, skipped


def _key(fields, detail: dict) -> tuple:
    return () if fields is None else tuple((detail or {}).get(f) for f in fields)


def pair(rows: list[tuple[int, datetime, dict]]) -> list[Interval]:
    """Join each start to its end, and return every event as an interval.

    An end closes every start still open under the same key, so two starts with
    no end between them -- a tab blurred twice across a page reload -- both end
    there. An end with nothing open is a moment of its own.
    """
    intervals: list[Interval] = []
    open_starts: dict[tuple, list[tuple[int, datetime, dict]]] = {}
    last_end: dict[tuple, tuple[int, datetime]] = {}
    for number, moment, row in rows:
        event, detail = row["event_type"], row.get("detail") or {}
        if event in PAIRS:
            key = (event, _key(PAIRS[event][2], detail))
            open_starts.setdefault(key, []).append((number, moment, detail))
            continue
        start_event = _ENDS.get(event)
        if start_event is not None:
            key = (start_event, _key(PAIRS[start_event][2], detail))
            if start_event in _CLOSED_BY_LAST and open_starts.get(key):
                last_end[key] = (number, moment)
                continue
            waiting = open_starts.pop(key, [])
            for start_number, start, start_detail in waiting:
                intervals.append(Interval(PAIRS[start_event][1], start, moment, start_detail, (start_number, number)))
            if waiting:
                continue
        intervals.append(Interval(event, moment, moment, detail, (number,), moment=True))
    for key, waiting in open_starts.items():
        start_event = key[0]
        for start_number, start, start_detail in waiting:
            end = last_end.get(key)
            rows_used = (start_number, end[0]) if end else (start_number,)
            intervals.append(Interval(PAIRS[start_event][1], start, end[1] if end else None, start_detail, rows_used))
    return sorted(intervals, key=lambda i: (i.start, i.rows))


def note_text(detail: dict) -> str:
    """Write an event's detail as a span note: ``key: value · key: value``, nulls left out."""
    return " · ".join(f"{k}: {v}" for k, v in (detail or {}).items() if v is not None and v != "")


def _span_id(digest: str, rows: tuple[int, ...]) -> str:
    return hashlib.sha1(f"{digest}:{','.join(map(str, rows))}".encode()).hexdigest()[:12]


def place(intervals: list[Interval], parts, duration: float, digest: str) -> tuple[list[dict], dict[str, int], str]:
    """Place intervals on the session timeline.

    Args:
        intervals: from ``pair``.
        parts: the transcript's ``Part`` records, each with ``offset``, ``duration`` and ``started_at``.
        duration: the session's length in seconds.
        digest: the diary's SHA-256, which with the source line numbers names each span, so two
            coders importing the same diary write identical records.

    Returns the spans ``{id, name, start, end, note}`` in session seconds, the
    count of intervals skipped by reason (``outside_recording``), and the anchor
    used (``zoom_start`` or ``first_event``).
    """
    parts = list(parts)
    zoom = bool(parts) and all(p.started_at for p in parts)
    anchor = min((i.start for i in intervals), default=None)
    spans, skipped = [], {}

    def part_at(seconds: float):
        return next((p for p in parts if p.offset <= seconds < p.offset + p.duration), parts[-1] if parts else None)

    for interval in intervals:
        if zoom:
            part = next((p for p in parts if 0 <= (interval.start - p.started_at).total_seconds() < p.duration), None)
            if part is None:
                skipped["outside_recording"] = skipped.get("outside_recording", 0) + 1
                continue
            start = part.offset + (interval.start - part.started_at).total_seconds()
            limit = part.offset + part.duration
            end = limit if interval.end is None else part.offset + (interval.end - part.started_at).total_seconds()
        else:
            start = (interval.start - anchor).total_seconds()
            if start >= duration:
                skipped["outside_recording"] = skipped.get("outside_recording", 0) + 1
                continue
            part = part_at(start)
            limit = part.offset + part.duration if part else duration
            end = limit if interval.end is None else (interval.end - anchor).total_seconds()
        end = min(max(end, start + SINGLE_LENGTH), limit)
        if end - start < SINGLE_LENGTH:  # a moment at the very end of a part
            start = max(end - SINGLE_LENGTH, part.offset if part else 0.0)
        spans.append({"id": _span_id(digest, interval.rows), "name": interval.name,
                      "start": round(start, 3), "end": round(end, 3), "note": note_text(interval.detail)})
    return spans, skipped, ("zoom_start" if zoom else "first_event")


def import_spans(path: Path, transcript) -> dict:
    """Read a diary and place it on a recording's timeline.

    Returns ``{"file", "sha256", "anchor", "spans", "skipped"}``, where ``skipped``
    counts what was left out by reason. Raises ``OSError`` if the file cannot be read.
    """
    path = Path(path)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    rows, skipped = read_rows(path)
    spans, outside, anchor = place(pair(rows), transcript.parts, transcript.duration, digest)
    for reason, count in outside.items():
        skipped[reason] = skipped.get(reason, 0) + count
    return {"file": path.name, "sha256": digest, "anchor": anchor, "spans": spans, "skipped": skipped}
