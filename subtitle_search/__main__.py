"""Command line entry point."""

from __future__ import annotations

import argparse
import sys
import threading
import webbrowser
from pathlib import Path

from .session import RecordingError, RecordingRegistry
from .vtt import format_timestamp

DEFAULT_PORT = 8765


def _dump_parse(registry: RecordingRegistry) -> int:
    """Print what the parser made of a folder, without starting the server.

    Speaker detection is heuristic, so this exists to let you sanity check the
    result against a real transcript without the file leaving your machine.
    """
    for recording in registry.list():
        transcript = recording.transcript
        diagnostics = transcript.diagnostics()
        print(f"\n{recording.title}")
        print(f"  highlights : {recording.store.path.name}")
        print(f"  duration   : {format_timestamp(diagnostics['duration'])}")
        print(f"  cues       : {diagnostics['cue_count']}")
        print(f"  chunks     : {diagnostics['chunk_count']}")
        print(f"  detection  : {diagnostics['speaker_detection']}")

        # The part layout is the thing worth checking on real data: a wrong order
        # or a wrong duration silently shifts every timestamp after it.
        print(f"  recordings : {len(transcript.parts)}")
        for part in transcript.parts:
            started = part.started_at.strftime("%Y-%m-%d %H:%M:%S") if part.started_at else "no timestamp"
            print(
                f"      {part.index + 1}. {part.vtt_name}"
                f"  [{started}]"
            )
            print(
                f"         media {part.media_name or '(none found)'}"
                f"  ·  starts at {format_timestamp(part.offset)}"
                f"  ·  runs {format_timestamp(part.duration)}"
            )
            if part.gap_before is not None:
                print(f"         interruption before this part: {format_timestamp(part.gap_before)}")
        speakers = diagnostics["speakers"]
        print(f"  speakers   : {len(speakers)}")
        for name in speakers:
            spoken = sum(1 for c in transcript.cues if c.speaker == name)
            print(f"      - {name}  ({spoken} cues)")
        if not speakers:
            print("      (none detected -- chunks were split on pauses instead)")
    print()
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="subtitle-search",
        description="Read Zoom transcripts, find quotes, and scrub to them in the recording.",
    )
    parser.add_argument("folder", type=Path, help="recording folder containing a .vtt and media file")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--host", default="127.0.0.1", help="bind address (default: localhost only)")
    parser.add_argument("--no-open", action="store_true", help="do not open a browser")
    parser.add_argument(
        "--dump-parse",
        action="store_true",
        help="print the parse summary for the folder and exit",
    )
    args = parser.parse_args(argv)

    registry = RecordingRegistry()
    try:
        registry.add_folder(args.folder)
    except RecordingError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if args.dump_parse:
        return _dump_parse(registry)

    import uvicorn

    from .app import create_app

    recording = registry.default
    assert recording is not None
    url = f"http://{args.host}:{args.port}/"

    diagnostics = recording.transcript.diagnostics()
    print(f"  {recording.title}")
    print(f"  {diagnostics['cue_count']} cues, {diagnostics['chunk_count']} chunks, "
          f"{len(recording.transcript.speakers)} speakers")
    if diagnostics["part_count"] > 1:
        print(f"  {diagnostics['part_count']} recordings joined into one "
              f"{format_timestamp(diagnostics['duration'])} timeline")
    if recording.media_kind is None:
        print("  no media file found -- transcript will be read-only")
    print(f"\n  {url}\n")

    if not args.no_open:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()

    uvicorn.run(create_app(registry), host=args.host, port=args.port, log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
