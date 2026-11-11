"""Imported video codes: spans read from a study session's diary, owned by no coder.

A diary dropped into a recording folder (see ``diary_import.py``) is imported
once, the first time a coder opens the recording, as a row of spans everyone
sees in every mode. Any coder may change a span's start and end, or the offset
that shifts the whole row; nobody changes an imported span's code or note, or
deletes one. A coder copies a span into their own row to do more with it, or
moves a whole code to common, as with their own codes.

Each file is shared and written directly, like a corrected transcript: one
file every coder reads, re-read just before each change so a change only ever
touches what it changes. Two coders changing the same recording at once can
still make the sync client keep two versions, so they take turns.

- ``ImportedCodebook``: the codes, ``<study>/imported_video_codebook.json``.
  A code moved to common is remembered with the common code it became, so
  themes that held it can follow it.
- ``ImportedSpans``: one recording's import record, offset and spans,
  ``<recording>/imported_video_codes.json``.

Spans are stored without the offset; it is added when they are listed, so
changing it moves every span still in the row, edited or not, and nothing that
has left it. Each span keeps the times the diary gave it beside its current ones.
"""

from __future__ import annotations

import hashlib
import uuid
from pathlib import Path

from .codebook import COLORS, CodebookError
from .diary_import import find_diary, import_spans
from .jsonstore import JsonStore, now

SCHEMA_VERSION = 1
CODEBOOK_FILENAME = "imported_video_codebook.json"
SPANS_FILENAME = "imported_video_codes.json"


def code_id_for(name: str) -> str:
    """Return the id an imported code of this name always has."""
    return "imp-" + hashlib.sha1(name.lower().encode()).hexdigest()[:12]


def _color_for(name: str) -> str:
    return COLORS[int(hashlib.sha1(name.lower().encode()).hexdigest(), 16) % len(COLORS)]


class _SharedFile(JsonStore):
    """A file every coder writes: re-read before each change, never written over while unreadable."""

    def reload(self) -> None:
        self.unreadable = False
        self._data = self._load()

    def _fresh(self) -> dict:
        """Re-read the file for a change; refuse while it cannot be read, since it may be mid-sync."""
        self.reload()
        if self.unreadable:
            raise CodebookError(f"{self.path.name} could not be read; wait for the folder to finish syncing, then press Sync")
        return self._data


class ImportedCodebook(_SharedFile):
    """The imported codes of a study. Codes are added by imports and returns only."""

    def __init__(self, root: Path, name: str = CODEBOOK_FILENAME):
        super().__init__(Path(root) / name)

    def _empty(self) -> dict:
        return {"version": SCHEMA_VERSION, "updated_at": now(), "codes": {}, "moved": {}}

    def _repair(self, data: dict) -> dict:
        for key in ("codes", "moved"):
            if not isinstance(data.get(key), dict):
                data[key] = {}
        return data

    def list(self) -> list[dict]:
        return sorted(self._data["codes"].values(), key=lambda c: str(c.get("name", "")).lower())

    def get(self, code_id: str) -> dict | None:
        return self._data["codes"].get(code_id)

    def find(self, name) -> dict | None:
        wanted = " ".join(str(name or "").split()).lower()
        return next((c for c in self.list() if str(c.get("name", "")).lower() == wanted), None)

    def ensure(self, actor: str, names) -> dict[str, dict]:
        """Return ``{name: code}`` for each name, adding any missing code in one write as ``actor``."""
        data = self._fresh()
        found, added = {}, False
        for name in names:
            code_id = code_id_for(name)
            if code_id not in data["codes"]:
                data["codes"][code_id] = {"id": code_id, "name": name, "color": _color_for(name), "description": "",
                                          "created_at": now(), "created_by": actor}
                data["moved"].pop(code_id, None)
                added = True
            found[name] = data["codes"][code_id]
        if added:
            self._write()
        return found

    def remove(self, code_id: str, actor: str, moved_to: str | None = None) -> bool:
        """Drop a code, as ``actor``, remembering the common code it moved to, if any."""
        data = self._fresh()
        if data["codes"].pop(code_id, None) is None:
            return False
        if moved_to:
            data["moved"][code_id] = moved_to
        self._write()
        return True

    def moved(self) -> dict[str, str]:
        """Return ``{imported code id: common code id}`` for every code moved to common."""
        return dict(self._data["moved"])


class _SpansFile(_SharedFile):
    def _empty(self) -> dict:
        return {"version": SCHEMA_VERSION, "updated_at": now(), "import": None, "offset": 0.0, "spans": []}

    def _repair(self, data: dict) -> dict:
        if not isinstance(data.get("spans"), list):
            data["spans"] = []
        data.setdefault("import", None)
        data.setdefault("offset", 0.0)
        return data


class ImportedSpans:
    """One recording's imported spans, its import record and its offset.

    Sits among the coders' span stores in ``SessionVideoCodes`` under the owner
    ``"imported"``, so listing labels its spans, and everything but a change of
    times is refused as another coder's span would be.
    """

    def __init__(self, folder: Path, duration):
        """``duration`` returns the session's current length in seconds."""
        self.folder = Path(folder)
        self._file = _SpansFile(self.folder / SPANS_FILENAME)
        self._duration = duration

    @property
    def unreadable(self) -> bool:
        return self._file.unreadable

    # -- reading ------------------------------------------------------------

    @property
    def offset(self) -> float:
        return float(self._file._data.get("offset") or 0.0)

    def _view(self, span: dict, offset: float, duration: float) -> dict | None:
        start, end = span["start"] + offset, span["end"] + offset
        if end <= 0 or start >= duration:
            return None
        view = {"id": span["id"], "code_id": span["code_id"], "start": round(max(start, 0.0), 3),
                "end": round(min(end, duration), 3), "note": span.get("note", "")}
        if (span["start"], span["end"]) != (span.get("diary_start", span["start"]), span.get("diary_end", span["end"])):
            view["edited"] = True
        return view

    def list(self) -> list[dict]:
        """Return the spans as shown: offset added, clipped to the recording, any pushed wholly outside left out."""
        offset, duration = self.offset, self._duration()
        views = (self._view(s, offset, duration) for s in self._file._data["spans"])
        return sorted((v for v in views if v), key=lambda s: (s["start"], s["end"]))

    def _find(self, span_id: str) -> dict | None:
        return next((s for s in self.list() if s["id"] == span_id), None)

    def count(self, code_id: str) -> int:
        return sum(1 for s in self.list() if s["code_id"] == code_id)

    def reassign(self, from_id: str, to_id: str) -> int:
        """Imported spans keep their imported code; merging a coder's codes never reaches them."""
        return 0

    def status(self) -> dict:
        """Return what the reader shows about this recording's import.

        ``status`` is ``imported``, ``pending`` (a diary is waiting), ``ambiguous``
        (several diaries, none imported) or ``none``.
        """
        record = self._file._data.get("import")
        if record:
            hidden = len(self._file._data["spans"]) - len(self.list())
            return {"status": "imported", "file": record.get("file"), "anchor": record.get("anchor"),
                    "imported": record.get("imported", 0), "skipped": record.get("skipped", {}),
                    "hidden": hidden, "offset": self.offset}
        found = find_diary(self.folder)
        if found is None:
            return {"status": "none", "offset": self.offset}
        if found == "ambiguous":
            return {"status": "ambiguous", "offset": self.offset}
        return {"status": "pending", "file": found.name, "offset": self.offset}

    # -- writing: re-read first, then change only what is changed -------------

    def import_diary(self, actor: str, books: ImportedCodebook, transcript) -> dict:
        """Import the folder's diary, as ``actor``, unless this recording has already been imported.

        Returns ``status()``. Raises ``CodebookError`` when there is no single diary to
        import or the shared file cannot be read, and ``OSError`` when the diary cannot.
        """
        data = self._file._fresh()
        if data.get("import"):
            return self.status()
        found = find_diary(self.folder)
        if found is None or found == "ambiguous":
            raise CodebookError("there is no single diary in this recording's folder to import")
        result = import_spans(found, transcript)
        codes = books.ensure(actor, {span["name"] for span in result["spans"]})
        data["spans"] = [{"id": s["id"], "code_id": codes[s["name"]]["id"], "start": s["start"], "end": s["end"],
                          "diary_start": s["start"], "diary_end": s["end"], "note": s["note"]} for s in result["spans"]]
        data["import"] = {"file": result["file"], "sha256": result["sha256"], "anchor": result["anchor"],
                          "imported": len(result["spans"]), "skipped": result["skipped"],
                          "imported_at": now(), "imported_by": actor}
        self._file._write()
        return self.status()

    def set_offset(self, actor: str, seconds) -> float:
        """Set the shift added to every span. Raises ``CodebookError`` for a non-number."""
        try:
            seconds = round(float(seconds), 3)
        except (TypeError, ValueError) as exc:
            raise CodebookError("the offset must be a number of seconds") from exc
        if seconds != seconds or abs(seconds) == float("inf"):
            raise CodebookError("the offset must be a number of seconds")
        data = self._file._fresh()
        data["offset"] = seconds
        data["offset_by"] = actor
        self._file._write()
        return seconds

    def retime(self, actor: str, span_id: str, patch: dict, duration: float) -> dict:
        """Move one span's start or end, given as shown, so the row offset still applies on top.

        Raises ``KeyError`` for an unknown span and ``CodebookError`` for times that do
        not make a span within the recording.
        """
        data = self._file._fresh()
        offset = self.offset
        span = next((s for s in data["spans"] if s["id"] == span_id), None)
        if span is None:
            raise KeyError(span_id)
        try:
            start = round(float(patch.get("start", span["start"] + offset)), 3)
            end = round(float(patch.get("end", span["end"] + offset)), 3)
        except (TypeError, ValueError) as exc:
            raise CodebookError("start and end must be numbers of seconds") from exc
        if start < 0:
            raise CodebookError("a span cannot start before the recording")
        if end <= start:
            raise CodebookError("a span has to end after it starts")
        if duration and end > duration + 0.5:
            raise CodebookError("a span cannot run past the end of the recording")
        span["start"], span["end"] = round(start - offset, 3), round(min(end, duration) - offset if duration else end - offset, 3)
        span["edited_at"], span["edited_by"] = now(), actor
        self._file._write()
        return self._view(span, offset, self._duration())

    def remove(self, span_id: str, actor: str) -> bool:
        """Take a span out of the row; done when its code moves to common."""
        data = self._file._fresh()
        kept = [s for s in data["spans"] if s["id"] != span_id]
        if len(kept) == len(data["spans"]):
            return False
        data["spans"] = kept
        self._file._write()
        return True

    def restore(self, actor: str, code_id: str, start: float, end: float, note: str) -> dict:
        """Put a span returned from common back in the row, at the times it is shown with the current offset."""
        data = self._file._fresh()
        offset = self.offset
        raw_start, raw_end = round(start - offset, 3), round(end - offset, 3)
        span = {"id": uuid.uuid4().hex[:12], "code_id": code_id, "start": raw_start, "end": raw_end,
                "diary_start": raw_start, "diary_end": raw_end, "note": note}
        data["spans"].append(span)
        self._file._write()
        return span
