"""Media file serving with HTTP Range support.

Range handling is not optional here. A multi-hour Zoom recording is hundreds of
megabytes, and without correct ``206 Partial Content`` responses the browser
either refuses to seek or re-downloads from byte zero on every scrub -- which
would make the core interaction of this tool unusable.
"""

from __future__ import annotations

import mimetypes
import re
from pathlib import Path
from typing import Iterator

from starlette.responses import FileResponse, Response, StreamingResponse

_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")

CHUNK_SIZE = 256 * 1024

#: mimetypes' database disagrees with itself across platforms for these, and a
#: wrong type makes the browser refuse to play a perfectly good file.
_EXPLICIT_TYPES = {
    ".m4a": "audio/mp4",
    ".m4v": "video/mp4",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".aac": "audio/aac",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
}


def guess_media_type(path: Path) -> str:
    explicit = _EXPLICIT_TYPES.get(path.suffix.lower())
    if explicit:
        return explicit
    return mimetypes.guess_type(str(path))[0] or "application/octet-stream"


def _iter_range(path: Path, start: int, end: int) -> Iterator[bytes]:
    """Yield bytes in [start, end] inclusive."""
    remaining = end - start + 1
    with path.open("rb") as handle:
        handle.seek(start)
        while remaining > 0:
            block = handle.read(min(CHUNK_SIZE, remaining))
            if not block:
                break
            remaining -= len(block)
            yield block


def serve_media(path: Path, range_header: str | None) -> Response:
    file_size = path.stat().st_size
    media_type = guess_media_type(path)

    if not range_header:
        return FileResponse(
            path,
            media_type=media_type,
            headers={"Accept-Ranges": "bytes", "Cache-Control": "no-cache"},
        )

    match = _RANGE_RE.match(range_header.strip())
    if not match:
        # An unparseable Range is not an error condition per the spec; ignoring
        # it and returning the whole file is the required behavior.
        return FileResponse(path, media_type=media_type, headers={"Accept-Ranges": "bytes"})

    raw_start, raw_end = match.group(1), match.group(2)
    if raw_start == "":
        if raw_end == "":
            return Response(status_code=416, headers={"Content-Range": f"bytes */{file_size}"})
        # Suffix range: the last N bytes.
        length = min(int(raw_end), file_size)
        start = file_size - length
        end = file_size - 1
    else:
        start = int(raw_start)
        end = int(raw_end) if raw_end else file_size - 1

    end = min(end, file_size - 1)
    if start > end or start >= file_size:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{file_size}"})

    return StreamingResponse(
        _iter_range(path, start, end),
        status_code=206,
        media_type=media_type,
        headers={
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Content-Length": str(end - start + 1),
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-cache",
        },
    )
