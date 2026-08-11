"""Read a recording's duration straight out of the container.

An interrupted session's parts are laid end to end on one timeline, so part two
starts where part one's *recording* ended -- not where its last caption ended. A
recording usually runs on past the final word, so using the last cue would pull
every later part earlier and drift further with each interruption.

MP4/M4A keep the duration in the `mvhd` box, which is a few dozen lines to read
directly. That avoids depending on ffprobe being installed.
"""

from __future__ import annotations

import struct
from pathlib import Path

_CONTAINER_SUFFIXES = {".mp4", ".m4a", ".m4v", ".mov"}

# A malformed or hostile file should not be able to spin us; real moov atoms sit
# within the first few thousand boxes of the file.
_MAX_BOXES = 4096


def _read_box_header(handle) -> tuple[int, bytes] | None:
    header = handle.read(8)
    if len(header) < 8:
        return None
    size, box_type = struct.unpack(">I4s", header)
    if size == 1:
        extended = handle.read(8)
        if len(extended) < 8:
            return None
        size = struct.unpack(">Q", extended)[0]
        return size - 16, box_type
    if size == 0:
        return -1, box_type  # extends to end of file
    return size - 8, box_type


def _find_mvhd(handle, end: int, depth: int = 0) -> float | None:
    if depth > 4:
        return None
    boxes = 0
    while handle.tell() < end and boxes < _MAX_BOXES:
        boxes += 1
        position = handle.tell()
        header = _read_box_header(handle)
        if header is None:
            return None
        payload_size, box_type = header
        if payload_size < 0:
            payload_size = end - handle.tell()
        if payload_size < 0:
            return None

        if box_type == b"mvhd":
            data = handle.read(min(payload_size, 32))
            if len(data) < 20:
                return None
            version = data[0]
            if version == 1:
                if len(data) < 32:
                    return None
                timescale, duration = struct.unpack(">IQ", data[20:32])
            else:
                timescale, duration = struct.unpack(">II", data[12:20])
            if not timescale:
                return None
            return duration / timescale

        if box_type == b"moov":
            found = _find_mvhd(handle, handle.tell() + payload_size, depth + 1)
            if found is not None:
                return found

        next_position = position + (payload_size + 8)
        if next_position <= position:
            return None
        handle.seek(next_position)
    return None


def container_duration(path: Path) -> float | None:
    """Duration in seconds, or None if it cannot be determined."""
    if path.suffix.lower() not in _CONTAINER_SUFFIXES:
        return None
    try:
        size = path.stat().st_size
        with path.open("rb") as handle:
            return _find_mvhd(handle, size)
    except (OSError, struct.error, ValueError):
        return None
