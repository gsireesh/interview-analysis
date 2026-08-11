"""Correcting the transcript in place.

Two things make this more than a file write.

The original is preserved. Before the first edit to a transcript, it is copied
to ``<name>_original.vtt``. That copy is written once and never touched again,
so it always holds the file as it came off Zoom no matter how many corrections
follow.

Edits are spliced, not regenerated. Only the edited cue's payload is replaced in
the source text; every other byte is left exactly as it was. Regenerating the
file from parsed data would quietly drop anything the parser skipped -- a
malformed timestamp, an unrecognized block -- and those are precisely the parts
of a transcript a person cannot afford to lose silently.

And because corrections happen while quotes are being saved, an edit re-anchors
any quote overlapping the cue rather than letting its offsets drift.
"""

from __future__ import annotations

import difflib
import os
import re
import shutil
import tempfile
from pathlib import Path

from .models import Cue
from .vtt import splice_cue


class EditError(ValueError):
    """Raised when an edit cannot be applied."""


#: Appended to a transcript's stem for its pre-edit backup. Discovery skips
#: files ending in this, or a backup would be read as another recording.
BACKUP_SUFFIX = "_original"


def backup_path(vtt_path: Path) -> Path:
    return vtt_path.with_name(f"{vtt_path.stem}{BACKUP_SUFFIX}{vtt_path.suffix}")


def ensure_backup(vtt_path: Path) -> str | None:
    """Copy the transcript aside once. Returns the name if it was just created.

    Deliberately never overwrites: the backup is the file as it arrived, not the
    state before the most recent edit.
    """
    target = backup_path(vtt_path)
    if target.exists():
        return None
    shutil.copy2(vtt_path, target)
    return target.name


def read_source(path: Path) -> str:
    """Read a transcript without translating line endings.

    Universal newlines would turn a CRLF file into LF in memory, and writing it
    back would silently reformat every line of the user's transcript. Offsets are
    tracked against the file exactly as it is on disk.
    """
    with path.open("r", encoding="utf-8", errors="replace", newline="") as handle:
        return handle.read()


def write_atomically(path: Path, content: str) -> None:
    handle = tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        newline="",
        dir=str(path.parent),
        prefix=path.name + ".",
        suffix=".tmp",
        delete=False,
    )
    try:
        with handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(handle.name, path)
    except BaseException:
        Path(handle.name).unlink(missing_ok=True)
        raise


def remap_offset(old: str, new: str, offset: int) -> int:
    """Carry a character offset from the old text onto the corrected text.

    A quote anchored inside a cue has to survive that cue being edited. Offsets
    in untouched regions move by exactly the shift ahead of them; offsets inside
    a rewritten region collapse to whichever edge of the replacement is nearer,
    since there is no honest sub-position to map them to.
    """
    offset = max(0, min(offset, len(old)))
    # Half-open ranges give the anchor forward gravity: an offset sitting exactly
    # where text was inserted belongs to the word that follows it, not to the
    # insertion point, so a quote keeps covering the same words.
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, old, new, autojunk=False).get_opcodes():
        if not i1 <= offset < i2:
            continue
        if tag == "equal":
            return j1 + (offset - i1)
        return j1 if (offset - i1) <= (i2 - offset) else j2
    return len(new)


_WHITESPACE_RE = re.compile(r"\s+")


def normalize_edit(text: str) -> str:
    """A cue is one line of the source, so newlines and runs of space collapse."""
    return _WHITESPACE_RE.sub(" ", text or "").strip()


def apply_cue_edit(recording, cue_id: str, raw_text: str) -> dict:
    """Correct one cue, save it to the transcript, and re-anchor its quotes."""
    transcript = recording.transcript
    cue: Cue | None = transcript.cue(cue_id)
    if cue is None:
        raise EditError("that line is not part of this transcript")

    new_text = normalize_edit(raw_text)
    if not new_text:
        raise EditError("a line cannot be left empty; delete the words but keep the line")

    if new_text == cue.text:
        return {
            "cue": cue.to_dict(),
            "changed": False,
            "backup_created": None,
            "highlights": [],
            "sha256": transcript.sha256,
        }

    part_index = cue.part_index
    try:
        vtt_path = recording.part_files[part_index].vtt_path
        content = recording.sources[part_index]
    except IndexError as exc:
        raise EditError("cannot locate the transcript this line came from") from exc

    backup_created = ensure_backup(vtt_path)
    updated_content = splice_cue(content, cue, new_text)
    write_atomically(vtt_path, updated_content)
    recording.sources[part_index] = updated_content

    # The replacement changes length, so every later cue in the same file moves.
    old_text = cue.text
    old_source_end = cue.source_end
    new_source_end = cue.source_start + len(cue.prefix) + len(new_text) + len(cue.suffix)
    delta = new_source_end - old_source_end

    transcript.replace_cue(cue.edited(new_text, new_source_end))
    if delta:
        for other in list(transcript.cues_in_part(part_index)):
            if other.id != cue_id and other.source_start >= old_source_end:
                transcript.replace_cue(other.moved(delta))

    recording.restamp_part(part_index, updated_content)
    touched = recording.store.remap_cue(cue_id, old_text, new_text)
    recording.store.restamp()

    return {
        "cue": transcript.cue(cue_id).to_dict(),
        "changed": True,
        "backup_created": backup_created,
        "backup_file": backup_path(vtt_path).name,
        "highlights": touched,
        "sha256": transcript.sha256,
    }
