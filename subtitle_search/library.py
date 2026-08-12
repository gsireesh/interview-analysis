"""Working across a whole set of recordings.

The reader is built around one session. Thematic analysis is not: it needs every
quote in the study at once, grouped by what they are about rather than by which
interview they came from. This module flattens the per-recording quote files
into one corpus, and stores the themes built on top of it.

Themes live in ``library.themes.json`` at the root of the library, beside the
recording folders rather than inside any of them, because a theme belongs to the
study and not to a participant. A theme holds references, never copies: the
quote text stays in the recording's own file, so correcting a transcript still
updates every theme that quote appears in.
"""

from __future__ import annotations

import json
import os
import tempfile
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

THEMES_FILENAME = "library.themes.json"
SCHEMA_VERSION = 1

#: Where a quote that has not been sorted anywhere yet belongs.
UNSORTED = "unsorted"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def quote_ref(recording_id: str, highlight_id: str) -> str:
    return f"{recording_id}:{highlight_id}"


def all_quotes(registry) -> list[dict]:
    """Every quote in the library, tagged with where it came from."""
    quotes: list[dict] = []
    for recording in registry.list():
        for highlight in recording.store.list():
            quotes.append(
                {
                    **highlight,
                    "ref": quote_ref(recording.id, highlight["id"]),
                    "recording_id": recording.id,
                    "recording_title": recording.title,
                }
            )
    return quotes


def tag_index(quotes: list[dict]) -> list[dict]:
    """Per-tag counts, and how they spread across recordings.

    ``recording_count`` is the number that matters most in analysis: a tag on
    twenty quotes from one participant is that person's preoccupation, while the
    same tag across twelve participants is a finding.
    """
    index: dict[str, dict] = {}
    for quote in quotes:
        for tag in quote.get("tags") or []:
            entry = index.setdefault(
                tag, {"tag": tag, "quote_count": 0, "recordings": {}, "colors": {}}
            )
            entry["quote_count"] += 1
            rec = quote["recording_id"]
            entry["recordings"][rec] = entry["recordings"].get(rec, 0) + 1
            color = quote.get("color")
            if color:
                entry["colors"][color] = entry["colors"].get(color, 0) + 1

    summary = []
    for entry in index.values():
        entry["recording_count"] = len(entry["recordings"])
        entry["color"] = (
            max(entry["colors"].items(), key=lambda kv: kv[1])[0] if entry["colors"] else None
        )
        entry.pop("colors")
        summary.append(entry)
    return sorted(summary, key=lambda e: (-e["recording_count"], -e["quote_count"], e["tag"].lower()))


def vocabulary(registry) -> list[dict]:
    """Every tag ever used anywhere in the library, for suggesting completions.

    Wider than ``tag_index``, deliberately. That one reports tags with quotes
    behind them right now; this one also keeps tags whose last quote was
    untagged or deleted, because the reason to show a vocabulary while typing is
    to stop a fifth near-duplicate of a code you already invented.

    Each recording's quotes file already remembers its own tags permanently, so
    the union of those is durable without another file to keep in sync.
    """
    entries: dict[str, dict] = {}

    def entry(tag: str) -> dict:
        return entries.setdefault(
            tag, {"tag": tag, "quote_count": 0, "recording_count": 0, "recordings": []}
        )

    for recording in registry.list():
        # History first: tags typed here at any point, even if nothing carries
        # them now.
        for tag in recording.store.known_tags():
            entry(tag)

        used: set[str] = set()
        for highlight in recording.store.list():
            for tag in highlight.get("tags") or []:
                item = entry(tag)
                item["quote_count"] += 1
                used.add(tag)
        for tag in used:
            item = entries[tag]
            item["recording_count"] += 1
            item["recordings"].append(recording.id)

    # Most-established first: a tag on many recordings is the one to reuse.
    return sorted(
        entries.values(),
        key=lambda e: (-e["recording_count"], -e["quote_count"], e["tag"].lower()),
    )


def cooccurrence(quotes: list[dict], minimum: int = 1) -> list[dict]:
    """Tags that share a quote.

    Two codes that always travel together are usually one theme wearing two
    names, or a pair worth reading as cause and effect. Either way it is the
    cheapest signal that a codebook needs consolidating.
    """
    pairs: dict[tuple[str, str], dict] = {}
    for quote in quotes:
        tags = sorted({t for t in (quote.get("tags") or []) if t})
        for i, first in enumerate(tags):
            for second in tags[i + 1 :]:
                key = (first, second)
                entry = pairs.setdefault(
                    key, {"a": first, "b": second, "count": 0, "recordings": set()}
                )
                entry["count"] += 1
                entry["recordings"].add(quote["recording_id"])

    out = []
    for entry in pairs.values():
        if entry["count"] < minimum:
            continue
        entry["recording_count"] = len(entry["recordings"])
        entry.pop("recordings")
        out.append(entry)
    return sorted(out, key=lambda e: (-e["count"], e["a"].lower(), e["b"].lower()))


def untagged(quotes: list[dict]) -> list[dict]:
    return [q for q in quotes if not (q.get("tags") or [])]


# ------------------------------------------------------------------ themes --


@dataclass
class Theme:
    id: str
    title: str
    note: str
    color: str | None
    refs: list[str]


class ThemeStore:
    """Reads and writes the library's themes file.

    Same discipline as the quote store: every change is written immediately and
    atomically, and fields written by a later version survive a round trip.
    """

    def __init__(self, path: Path):
        self.path = path
        self._data = self._load()

    def _empty(self) -> dict:
        return {
            "version": SCHEMA_VERSION,
            "updated_at": _now(),
            "themes": [],
        }

    def _load(self) -> dict:
        if not self.path.exists():
            return self._empty()
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            backup = self.path.with_suffix(self.path.suffix + ".corrupt")
            try:
                os.replace(self.path, backup)
            except OSError:
                pass
            return self._empty()
        if not isinstance(data, dict):
            return self._empty()
        data.setdefault("themes", [])
        if not isinstance(data["themes"], list):
            data["themes"] = []
        for theme in data["themes"]:
            theme.setdefault("refs", [])
        return data

    def _write(self) -> None:
        self._data["updated_at"] = _now()
        self.path.parent.mkdir(parents=True, exist_ok=True)
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
                json.dump(self._data, handle, indent=2, ensure_ascii=False)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(handle.name, self.path)
        except BaseException:
            Path(handle.name).unlink(missing_ok=True)
            raise

    # -- queries ---------------------------------------------------------

    def list(self) -> list[dict]:
        return self._data["themes"]

    def _find(self, theme_id: str) -> dict | None:
        return next((t for t in self._data["themes"] if t.get("id") == theme_id), None)

    def placed_refs(self) -> set[str]:
        return {ref for theme in self._data["themes"] for ref in theme.get("refs", [])}

    # -- mutations -------------------------------------------------------

    def create(self, title: str = "", color: str | None = None) -> dict:
        theme = {
            "id": uuid.uuid4().hex[:12],
            "title": title.strip() or "Untitled theme",
            "note": "",
            "color": color,
            "refs": [],
            "created_at": _now(),
            "updated_at": _now(),
        }
        self._data["themes"].append(theme)
        self._write()
        return theme

    def update(self, theme_id: str, patch: dict) -> dict:
        theme = self._find(theme_id)
        if theme is None:
            raise KeyError(theme_id)
        if "title" in patch:
            theme["title"] = str(patch["title"]).strip() or "Untitled theme"
        if "note" in patch:
            theme["note"] = str(patch["note"] or "")
        if "color" in patch:
            theme["color"] = patch["color"] or None
        theme["updated_at"] = _now()
        self._write()
        return theme

    def delete(self, theme_id: str) -> bool:
        theme = self._find(theme_id)
        if theme is None:
            return False
        self._data["themes"].remove(theme)
        self._write()
        return True

    def reorder(self, order: list[str]) -> list[dict]:
        position = {theme_id: index for index, theme_id in enumerate(order)}
        self._data["themes"].sort(key=lambda t: position.get(t["id"], len(position)))
        self._write()
        return self._data["themes"]

    def assign(self, ref: str, theme_id: str | None, index: int | None = None) -> list[dict]:
        """Move a quote into a theme, or out of every theme.

        A quote belongs to at most one theme: the point of the board is to force
        the decision that a spreadsheet of tags lets you defer.
        """
        for theme in self._data["themes"]:
            if ref in theme["refs"]:
                theme["refs"].remove(ref)

        if theme_id is not None:
            theme = self._find(theme_id)
            if theme is None:
                raise KeyError(theme_id)
            if index is None or not 0 <= index <= len(theme["refs"]):
                theme["refs"].append(ref)
            else:
                theme["refs"].insert(index, ref)
            theme["updated_at"] = _now()

        self._write()
        return self._data["themes"]

    def prune(self, known: set[str]) -> int:
        """Drop references to quotes that no longer exist.

        A quote deleted in the reader would otherwise leave a hole in a theme
        that nothing accounts for.
        """
        removed = 0
        for theme in self._data["themes"]:
            keep = [ref for ref in theme["refs"] if ref in known]
            removed += len(theme["refs"]) - len(keep)
            theme["refs"] = keep
        if removed:
            self._write()
        return removed
