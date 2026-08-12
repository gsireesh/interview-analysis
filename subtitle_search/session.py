"""Recording folder discovery and the in-memory registry.

Everything in a folder is one session. Zoom splits a meeting into several
recordings when it gets interrupted -- someone drops, the host reconnects -- and
each part restarts its transcript at 00:00. Discovery groups the folder's files
into parts, orders them, and lays them end to end on a single timeline so times
run continuously across the whole session.

Even in single-folder mode the registry exists and recordings are addressed by a
stable id. That is the seam for a future library mode: pointing at a parent
folder becomes "register many" rather than a rewrite of routing or storage.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

from .editing import BACKUP_SUFFIX, backup_path, read_source
from .highlights import HighlightStore
from .mediainfo import container_duration
from .models import Part, Transcript
from .vtt import VTTParseError, assemble_session, parse_cues, session_digest

#: Searched in order -- video first, since the collapsible pane can show it and
#: an audio-only fallback is a strictly smaller feature.
VIDEO_EXTENSIONS = (".mp4", ".m4v", ".mov", ".webm", ".mkv")
AUDIO_EXTENSIONS = (".m4a", ".mp3", ".wav", ".aac", ".flac", ".ogg")
MEDIA_EXTENSIONS = VIDEO_EXTENSIONS + AUDIO_EXTENSIONS

#: Zoom cloud downloads: GMT20240101-140523_Recording.transcript.vtt
_GMT_RE = re.compile(r"GMT(\d{8})-(\d{6})")
#: A trailing counter, as in zoom_0.mp4 / zoom_1.mp4.
_COUNTER_RE = re.compile(r"(\d+)(?!.*\d)")
#: Decoration Zoom hangs off the shared stem, stripped before pairing by name.
_STEM_NOISE_RE = re.compile(
    r"(\.transcript|\.cc|_recording|_\d{3,4}x\d{3,4}|audio_only|_audio|_video)",
    re.IGNORECASE,
)

#: Below this, a gap between parts is recording overhead rather than a real
#: interruption worth interrupting the reader for.
MIN_REPORTABLE_GAP = 2.0

#: Used only when a part's media is missing or unreadable, so the next part does
#: not start on top of the previous one's last word.
FALLBACK_TAIL = 1.0


class RecordingError(ValueError):
    """Raised when a folder cannot be opened as a recording."""


def _recording_id(folder: Path) -> str:
    return hashlib.sha1(str(folder.resolve()).encode("utf-8")).hexdigest()[:12]


def _timestamp_key(path: Path) -> tuple[str, datetime] | None:
    match = _GMT_RE.search(path.name)
    if not match:
        return None
    try:
        stamp = datetime.strptime(match.group(1) + match.group(2), "%Y%m%d%H%M%S")
    except ValueError:
        return None
    return match.group(0), stamp


def _normalized_stem(path: Path) -> str:
    stem = path.name
    for suffix in (".vtt", ".transcript.vtt"):
        if stem.lower().endswith(suffix):
            stem = stem[: -len(suffix)]
    stem = Path(stem).stem if "." in stem else stem
    return _STEM_NOISE_RE.sub("", stem).strip(" _-.").lower()


def _sort_index(path: Path) -> tuple:
    """Order files when no timestamp is available: counter first, then mtime."""
    match = _COUNTER_RE.search(path.stem)
    counter = int(match.group(1)) if match else -1
    try:
        modified = path.stat().st_mtime
    except OSError:
        modified = 0.0
    return (counter, modified, path.name.lower())


def _best_media(candidates: list[Path]) -> Path | None:
    by_extension: dict[str, list[Path]] = {}
    for path in candidates:
        by_extension.setdefault(path.suffix.lower(), []).append(path)
    for extension in MEDIA_EXTENSIONS:
        if extension in by_extension:
            return max(by_extension[extension], key=lambda p: p.stat().st_size)
    return None


@dataclass
class PartFiles:
    vtt_path: Path
    media_path: Path | None
    started_at: datetime | None


def discover_parts(folder: Path) -> list[PartFiles]:
    """Group a folder's files into ordered session parts.

    Pairing is attempted three ways, most reliable first: the GMT timestamp Zoom
    stamps into cloud filenames, then a shared stem once Zoom's decoration is
    stripped, then plain ordering. Every path ends with transcripts in a defined
    order, because a wrong order silently corrupts every timestamp downstream.
    """
    # Backups made before the first correction sit in the same folder with the
    # same extension. Without this they would be read as another recording, and
    # every edit would silently double the session.
    vtts = sorted(
        p for p in folder.glob("*.vtt") if p.is_file() and not p.stem.endswith(BACKUP_SUFFIX)
    )
    if not vtts:
        raise RecordingError(f"no .vtt file found in {folder}")

    media = [p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in MEDIA_EXTENSIONS]

    # 1. Zoom cloud naming: group everything sharing a GMT timestamp token.
    keyed_vtts = [(v, _timestamp_key(v)) for v in vtts]
    if all(key is not None for _, key in keyed_vtts):
        parts: list[PartFiles] = []
        for vtt, key in sorted(keyed_vtts, key=lambda item: item[1][1]):
            token, stamp = key
            matching = [m for m in media if token in m.name]
            parts.append(PartFiles(vtt, _best_media(matching), stamp))
        return parts

    # 2. One transcript: the whole folder's media belongs to it.
    if len(vtts) == 1:
        return [PartFiles(vtts[0], _best_media(media), None)]

    # 3. Pair on a shared stem once Zoom's decoration is removed.
    by_stem: dict[str, list[Path]] = {}
    for path in media:
        by_stem.setdefault(_normalized_stem(path), []).append(path)
    ordered = sorted(vtts, key=_sort_index)
    if all(_normalized_stem(v) in by_stem for v in ordered):
        return [PartFiles(v, _best_media(by_stem[_normalized_stem(v)]), None) for v in ordered]

    # 4. Nothing lines up: order both sides and zip, leaving extras unpaired.
    ordered_media = sorted(media, key=_sort_index)
    return [
        PartFiles(vtt, ordered_media[i] if i < len(ordered_media) else None, None)
        for i, vtt in enumerate(ordered)
    ]


def highlights_path_for(folder: Path) -> Path:
    """One quotes file per session, at a fixed predictable name."""
    return folder / "session.highlights.json"


def build_transcript(folder: Path, part_files: list[PartFiles]) -> tuple[Transcript, list[str]]:
    """Parse each part and lay them end to end on one continuous timeline.

    Returns the transcript and each part's raw source text, which is kept in
    memory so a correction can be spliced into it without re-reading from disk.
    """
    specs: list[dict] = []
    parts: list[Part] = []
    sources: list[str] = []
    offset = 0.0
    previous_end_wall: datetime | None = None

    for index, files in enumerate(part_files):
        content = read_source(files.vtt_path)
        sources.append(content)
        cues, method = parse_cues(content)

        # Part N+1 starts where part N's *recording* ended, not where its last
        # caption ended -- recordings usually run on past the final word, and
        # using the caption would pull every later part earlier.
        measured = container_duration(files.media_path) if files.media_path else None
        last_cue_end = cues[-1].end if cues else 0.0
        duration = measured if measured and measured >= last_cue_end else last_cue_end + FALLBACK_TAIL

        gap_before: float | None = None
        if files.started_at and previous_end_wall:
            gap_before = max(0.0, (files.started_at - previous_end_wall).total_seconds())

        digest = hashlib.sha256(content.encode("utf-8", "replace")).hexdigest()
        parts.append(
            Part(
                index=index,
                vtt_name=files.vtt_path.name,
                media_name=files.media_path.name if files.media_path else None,
                media_kind=_media_kind(files.media_path),
                offset=offset,
                duration=duration,
                started_at=files.started_at,
                gap_before=gap_before if (gap_before or 0) >= MIN_REPORTABLE_GAP else None,
                sha256=digest,
                edited=backup_path(files.vtt_path).exists(),
            )
        )
        specs.append(
            {
                "cues": cues,
                "offset": offset,
                "index": index,
                "method": method,
                "sha256": digest,
            }
        )

        offset += duration
        if files.started_at:
            previous_end_wall = files.started_at + timedelta(seconds=duration)

    name = part_files[0].vtt_path.name if len(part_files) == 1 else f"{len(part_files)} recordings"
    return assemble_session(specs, parts, source_name=name), sources


def _media_kind(path: Path | None) -> str | None:
    if path is None:
        return None
    return "video" if path.suffix.lower() in VIDEO_EXTENSIONS else "audio"


@dataclass
class Recording:
    id: str
    folder: Path
    transcript: Transcript
    store: HighlightStore
    part_files: list[PartFiles]
    #: Each part's transcript file as text, kept so corrections can be spliced
    #: into it without re-reading and without reformatting the rest.
    sources: list[str]

    def restamp_part(self, part_index: int, content: str) -> None:
        """Refresh digests after a part's transcript was corrected on disk."""
        part = self.transcript.part(part_index)
        if part is None:
            return
        part.sha256 = hashlib.sha256(content.encode("utf-8", "replace")).hexdigest()
        part.edited = True
        self.transcript.sha256 = session_digest([p.sha256 for p in self.transcript.parts])

    @property
    def media_kind(self) -> str | None:
        kinds = [p.media_kind for p in self.transcript.parts if p.media_kind]
        if not kinds:
            return None
        return "video" if "video" in kinds else "audio"

    @property
    def title(self) -> str:
        return self.folder.name or str(self.folder)

    def media_path(self, part_index: int) -> Path | None:
        if 0 <= part_index < len(self.part_files):
            return self.part_files[part_index].media_path
        return None

    def summary(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "folder": str(self.folder),
            "vtt_file": self.transcript.source_name,
            "media_file": self.transcript.parts[0].media_name if self.transcript.parts else None,
            "media_kind": self.media_kind,
            "highlights_file": self.store.path.name,
            "duration": self.transcript.duration,
            "part_count": len(self.transcript.parts),
            "speakers": self.transcript.speakers,
            "quote_count": len(self.store.list()),
            # Carried so a page outside the reader can still turn a quote's
            # session time into a position in the right media file.
            "parts": [p.to_dict() for p in self.transcript.parts],
        }

    def payload(self) -> dict:
        """Everything the frontend needs to render the recording."""
        return {
            **self.summary(),
            "transcript": self.transcript.to_dict(),
            "highlights": self.store.list(),
            "known_tags": self.store.known_tags(),
            "highlights_stale": self.store.stale,
            "migrated_from": self.store.migrated_from,
        }


def open_recording(folder: Path) -> Recording:
    folder = Path(folder).expanduser().resolve()
    if not folder.is_dir():
        raise RecordingError(f"not a directory: {folder}")

    part_files = discover_parts(folder)
    transcript, sources = build_transcript(folder, part_files)
    store = HighlightStore(highlights_path_for(folder), transcript)

    return Recording(
        id=_recording_id(folder),
        folder=folder,
        transcript=transcript,
        store=store,
        part_files=part_files,
        sources=sources,
    )


def find_recordings(root: Path) -> list[Path]:
    """Recording folders at or under ``root``.

    A folder holding a transcript is itself a recording; otherwise its children
    are searched. Two levels is enough for how these arrive -- a folder of
    participant folders -- and stopping there keeps an unrelated deep tree from
    being dragged in.
    """
    root = Path(root).expanduser().resolve()
    if not root.is_dir():
        return []
    if any(root.glob("*.vtt")):
        return [root]

    found: list[Path] = []
    for child in sorted(p for p in root.iterdir() if p.is_dir()):
        if any(child.glob("*.vtt")):
            found.append(child)
            continue
        found.extend(
            grandchild
            for grandchild in sorted(p for p in child.iterdir() if p.is_dir())
            if any(grandchild.glob("*.vtt"))
        )
    return found


class RecordingRegistry:
    """Holds open recordings, keyed by id."""

    def __init__(self, root: Path | None = None) -> None:
        self._recordings: dict[str, Recording] = {}
        self.root: Path | None = Path(root).expanduser().resolve() if root else None
        #: Folders that looked like recordings but could not be opened.
        self.failures: list[tuple[str, str]] = []

    def add_folder(self, folder: Path) -> Recording:
        recording = open_recording(folder)
        self._recordings[recording.id] = recording
        if self.root is None:
            self.root = recording.folder
        return recording

    def add_library(self, root: Path) -> list[Recording]:
        """Open every recording under a root folder.

        One unreadable folder must not take the library down with it, so
        failures are collected and reported rather than raised.
        """
        root = Path(root).expanduser().resolve()
        self.root = root
        opened: list[Recording] = []
        for folder in find_recordings(root):
            try:
                opened.append(self.add_folder(folder))
            except (RecordingError, VTTParseError, OSError) as exc:
                # A folder with an unreadable transcript is a folder to report,
                # not a reason the rest of the study cannot be opened.
                self.failures.append((folder.name, str(exc)))
        return opened

    @property
    def is_library(self) -> bool:
        return len(self._recordings) > 1 or (self.root is not None and self.root not in
                                             {r.folder for r in self._recordings.values()})

    def get(self, recording_id: str) -> Recording | None:
        return self._recordings.get(recording_id)

    def list(self) -> list[Recording]:
        return sorted(self._recordings.values(), key=lambda r: r.title.lower())

    @property
    def default(self) -> Recording | None:
        recordings = self.list()
        return recordings[0] if recordings else None
