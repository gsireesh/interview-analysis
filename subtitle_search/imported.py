"""Imported video codes: spans read from a study session's diary, owned by no coder.

A diary dropped into a recording folder (see ``diary_import.py``) is imported
once, the first time a coder opens the recording, as a row of spans everyone
sees in every mode. Nobody edits them: a coder copies one into their own row to
change it, or moves a whole code to common, as with their own codes.

Imported records are written by whichever coder's tool happens to act, so every
file is a ``CommonSet``: each coder writes only their own copy, and the newest
version of each record wins. Codes and spans are named deterministically -- a
code by its name, a span by the diary's digest and the lines it came from -- so
two coders importing the same diary at once write the same records, which merge.

- ``ImportedCodebook``: the codes, ``<study>/common/imported_video_codebook.json``.
  A code moved to common leaves a deletion marker naming the common code, so
  themes that held it can follow it.
- ``ImportedSpans``: one recording's spans, ``<recording>/common/imported_video_codes.json``,
  and its import record and offset, ``<recording>/common/imported.json``.

Spans are stored without the offset; it is added when they are listed, so
changing it moves every span still in the row and nothing that has left it.
"""

from __future__ import annotations

import hashlib
import uuid
from pathlib import Path

from .codebook import COLORS, CodebookError
from .common import IMPORTED, CommonSet, _later_than
from .diary_import import find_diary, import_spans

CODEBOOK_NAME = "imported_video_codebook.json"
SPANS_NAME = "imported_video_codes.json"
STATE_NAME = "imported.json"

#: Records in the import state file.
DIARY_RECORD = "diary"
OFFSET_RECORD = "offset"


def code_id_for(name: str) -> str:
    """Return the id an imported code of this name always has."""
    return "imp-" + hashlib.sha1(name.lower().encode()).hexdigest()[:12]


def _color_for(name: str) -> str:
    return COLORS[int(hashlib.sha1(name.lower().encode()).hexdigest(), 16) % len(COLORS)]


class ImportedCodebook(CommonSet):
    """The imported codes of a study. Read-only to coders: codes are added by imports only."""

    #: Answers the check made on a coder's codebook before tidying themes.
    unreadable = False

    def list(self) -> list[dict]:
        return sorted(super().list(), key=lambda c: str(c.get("name", "")).lower())

    def find(self, name) -> dict | None:
        wanted = " ".join(str(name or "").split()).lower()
        return next((c for c in self.list() if str(c.get("name", "")).lower() == wanted), None)

    def ensure(self, actor: str, name: str) -> dict:
        """Return the code called ``name``, adding it as ``actor`` if it is not there."""
        code_id = code_id_for(name)
        return self.get(code_id) or self.put(actor, {"id": code_id, "name": name, "color": _color_for(name), "description": ""})

    def remove(self, code_id: str, actor: str, moved_to: str | None = None) -> bool:
        """Mark a code deleted, as ``actor``, recording the common code it moved to, if any."""
        if self.get(code_id) is None:
            return False
        marker = {"id": code_id, "deleted": True, "updated_at": _later_than(self._merged.get(code_id)), "updated_by": actor}
        if moved_to:
            marker["moved_to"] = moved_to
        copy = self._own_copy(actor)
        copy._data["records"][code_id] = marker
        copy._write()
        self._merged[code_id] = marker
        return True

    def moved(self) -> dict[str, str]:
        """Return ``{imported code id: common code id}`` for every code moved to common."""
        return {rid: r["moved_to"] for rid, r in self._merged.items() if r.get("deleted") and r.get("moved_to")}


class ImportedSpans:
    """One recording's imported spans, its import record and its offset.

    Sits among the coders' span stores in ``SessionVideoCodes`` under the owner
    ``"imported"``, so listing labels its spans and an edit to one is refused as
    another coder's would be.
    """

    #: Answers the check made on a coder's span store before a move to common.
    unreadable = False

    def __init__(self, folder: Path, duration):
        """``duration`` returns the session's current length in seconds."""
        self.folder = Path(folder)
        self.spans = CommonSet(self.folder, SPANS_NAME)
        self.state = CommonSet(self.folder, STATE_NAME)
        self._duration = duration

    def sets(self):
        return (self.spans, self.state)

    @property
    def incomplete(self) -> bool:
        return self.spans.incomplete or self.state.incomplete

    # -- reading ------------------------------------------------------------

    @property
    def offset(self) -> float:
        record = self.state.get(OFFSET_RECORD)
        return float(record.get("seconds", 0.0)) if record else 0.0

    def _view(self, span: dict, offset: float, duration: float) -> dict | None:
        start, end = span["start"] + offset, span["end"] + offset
        if end <= 0 or start >= duration:
            return None
        return {"id": span["id"], "code_id": span["code_id"], "start": round(max(start, 0.0), 3),
                "end": round(min(end, duration), 3), "note": span.get("note", "")}

    def list(self) -> list[dict]:
        """Return the spans as shown: offset added, clipped to the recording, any pushed wholly outside left out."""
        offset, duration = self.offset, self._duration()
        views = (self._view(s, offset, duration) for s in self.spans.list())
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
        record = self.state.get(DIARY_RECORD)
        if record:
            shown = len(self.list())
            return {"status": "imported", "file": record.get("file"), "anchor": record.get("anchor"),
                    "imported": record.get("imported", 0), "skipped": record.get("skipped", {}),
                    "hidden": len(self.spans.list()) - shown, "offset": self.offset}
        found = find_diary(self.folder)
        if found is None:
            return {"status": "none", "offset": self.offset}
        if found == "ambiguous":
            return {"status": "ambiguous", "offset": self.offset}
        return {"status": "pending", "file": found.name, "offset": self.offset}

    # -- writing: always as the coder whose tool acts ------------------------

    def import_diary(self, actor: str, books: ImportedCodebook, transcript) -> dict:
        """Import the folder's diary, as ``actor``, unless this recording has already been imported.

        Returns ``status()``. Raises ``CodebookError`` when there is no single diary to import.
        """
        if self.state.get(DIARY_RECORD):
            return self.status()
        found = find_diary(self.folder)
        if found is None or found == "ambiguous":
            raise CodebookError("there is no single diary in this recording's folder to import")
        result = import_spans(found, transcript)
        for span in result["spans"]:
            code = books.ensure(actor, span["name"])
            if self.spans.get(span["id"]) is None:
                self.spans.put(actor, {"id": span["id"], "code_id": code["id"], "start": span["start"],
                                       "end": span["end"], "note": span["note"]})
        self.state.put(actor, {"id": DIARY_RECORD, "file": result["file"], "sha256": result["sha256"],
                               "anchor": result["anchor"], "imported": len(result["spans"]), "skipped": result["skipped"]})
        return self.status()

    def set_offset(self, actor: str, seconds) -> float:
        """Set the shift added to every span, as ``actor``. Raises ``CodebookError`` for a non-number."""
        try:
            seconds = round(float(seconds), 3)
        except (TypeError, ValueError) as exc:
            raise CodebookError("the offset must be a number of seconds") from exc
        if seconds != seconds or abs(seconds) == float("inf"):
            raise CodebookError("the offset must be a number of seconds")
        self.state.put(actor, {"id": OFFSET_RECORD, "seconds": seconds})
        return seconds

    def remove(self, span_id: str, actor: str) -> bool:
        """Take a span out of the row, as ``actor``; done when its code moves to common."""
        return self.spans.delete(actor, span_id)

    def restore(self, actor: str, code_id: str, start: float, end: float, note: str) -> dict:
        """Put a span returned from common back in the row, at the times it is shown with the current offset."""
        offset = self.offset
        return self.spans.put(actor, {"id": uuid.uuid4().hex[:12], "code_id": code_id,
                                      "start": round(start - offset, 3), "end": round(end - offset, 3), "note": note})
