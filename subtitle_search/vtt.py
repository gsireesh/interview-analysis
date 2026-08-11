"""WebVTT parsing and speaker-aware chunking.

Zoom writes the speaker two different ways: inlined in the cue payload as
``Name: text``, or as a WebVTT ``<v Name>`` voice tag. Voice tags are
unambiguous. The colon form is not -- on a single line, a sentence like
"So here's my point: I disagreed" is indistinguishable from a speaker prefix.

So speaker detection is a whole-file decision, not a per-line guess: candidate
prefixes are collected across the entire transcript first, and a candidate is
only promoted to a speaker if it either looks like a proper name or recurs.
See ``_accept_speakers``.

Each cue also records where its payload sits in the source file, and the exact
prefix and suffix that were stripped from it. That is what lets a correction be
spliced back into the original bytes rather than regenerating the file -- so
anything the parser skipped (a malformed timestamp, an unusual block) survives
an edit untouched.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path

from .models import Chunk, Cue, Part, Transcript

#: Insert a paragraph break inside a chunk when the speaker pauses this long.
PARAGRAPH_GAP = 2.5

#: When no speakers are detected at all, start a new chunk after this much silence.
FALLBACK_CHUNK_GAP = 4.0

_TIMING_RE = re.compile(r"^\s*(?P<start>[\d:.,]+)\s*-->\s*(?P<end>[\d:.,]+)")
_VOICE_RE = re.compile(
    r"^(?P<open><v(?:\.[^\s>]+)?\s+(?P<speaker>[^>]*)>)(?P<text>.*?)(?P<close></v>)?$", re.S
)
_COLON_RE = re.compile(r"^(?P<name>[^:\n]{1,100}):(?P<sep>[ \t]+)(?P<text>\S.*)$", re.S)
_CUE_TAG_RE = re.compile(r"</?[a-zA-Z][^>]*>")

#: Leading characters to look past when asking whether a word is capitalized.
_WORD_LEAD = "(\"'[{"


def looks_like_a_name(prefix: str) -> bool:
    """Whether a prefix is name-shaped enough to accept on a single sighting.

    Two or more capitalized words, starting with one. Requiring the *second*
    word to begin with a letter would reject real Zoom display names that carry
    a bracketed nickname or an affiliation, as in "B.F. (Jim) Lightning, Brown
    U. USA" -- so capitalization is counted across the whole prefix instead.

    "So here's my point" still fails: only one word in it is capitalized.
    """
    words = prefix.split()
    if len(words) < 2 or not prefix[:1].isupper():
        return False
    capitalized = sum(1 for word in words if word.lstrip(_WORD_LEAD)[:1].isupper())
    return capitalized >= 2


# Prefixes starting with one of these are sentence fragments, not names.
_FUNCTION_WORDS = {
    "a", "actually", "an", "and", "anyway", "as", "at", "basically", "because",
    "but", "either", "for", "he", "her", "here", "his", "honestly", "i", "if",
    "in", "is", "it", "its", "just", "like", "look", "maybe", "my", "no", "now",
    "of", "ok", "okay", "on", "one", "or", "our", "really", "right", "she", "so",
    "that", "the", "their", "then", "there", "they", "this", "to", "we", "well",
    "what", "when", "where", "which", "while", "who", "why", "yeah", "yes", "you",
    "your",
}


class VTTParseError(ValueError):
    """Raised when a file does not look like WebVTT at all."""


def parse_timestamp(raw: str) -> float:
    """Parse ``HH:MM:SS.mmm`` or ``MM:SS.mmm`` into seconds."""
    text = raw.strip().replace(",", ".")
    parts = text.split(":")
    if len(parts) == 3:
        hours, minutes, seconds = parts
    elif len(parts) == 2:
        hours, minutes, seconds = "0", parts[0], parts[1]
    else:
        raise VTTParseError(f"unrecognized timestamp: {raw!r}")
    try:
        return int(hours) * 3600 + int(minutes) * 60 + float(seconds)
    except ValueError as exc:
        raise VTTParseError(f"unrecognized timestamp: {raw!r}") from exc


def format_timestamp(seconds: float) -> str:
    """Render seconds as ``H:MM:SS`` (or ``M:SS`` under an hour)."""
    seconds = max(0, int(seconds))
    hours, remainder = divmod(seconds, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


def _clean(text: str) -> str:
    """Strip inline cue tags and collapse the whitespace from wrapped payloads."""
    return re.sub(r"\s+", " ", _CUE_TAG_RE.sub("", text)).strip()


@dataclass
class _Line:
    start: int
    end: int
    text: str


def _iter_lines(content: str) -> list[_Line]:
    """Split into lines, keeping each line's offsets in the original string.

    Offsets point into the file exactly as read, so a splice can be applied
    without normalizing line endings or disturbing anything else.
    """
    lines: list[_Line] = []
    offset = 0
    for raw in content.split("\n"):
        text = raw[:-1] if raw.endswith("\r") else raw
        lines.append(_Line(offset, offset + len(text), text))
        offset += len(raw) + 1
    return lines


def _iter_blocks(lines: list[_Line]) -> list[list[_Line]]:
    """Group lines into cue blocks, dropping headers and metadata blocks."""
    blocks: list[list[_Line]] = []
    current: list[_Line] = []
    for line in lines:
        if line.text.strip():
            current.append(line)
        elif current:
            blocks.append(current)
            current = []
    if current:
        blocks.append(current)

    kept = []
    for block in blocks:
        head = block[0].text.strip().upper()
        if head.startswith(("WEBVTT", "NOTE", "STYLE", "REGION")):
            continue
        kept.append(block)
    return kept


#: A Zoom display name is not just a name: people join as "Firstname M.
#: (Nickname) Lastname, Department, University, Country". Capping the prefix
#: tightly would reject those outright, and a rejected prefix does not fail
#: loudly -- the cue quietly inherits whoever spoke before, so two people merge
#: into one. What keeps a sentence from being mistaken for a speaker is the
#: function-word and capitalization tests, not length.
MAX_PREFIX_CHARS = 100
MAX_PREFIX_WORDS = 12

#: Above this many words, a prefix has to recur before it counts as a speaker.
#: A long display name repeats every time that person talks; a long sentence
#: fragment that happens to precede a colon does not.
SIGHT_ONCE_MAX_WORDS = 6


def starts_with_function_word(prefix: str) -> bool:
    """Whether a prefix opens with a word that marks it as a sentence fragment."""
    words = prefix.split()
    return bool(words) and words[0].strip(",.'\"").lower() in _FUNCTION_WORDS


def is_plausible_speaker_prefix(prefix: str) -> bool:
    """Loose shape test for a ``Name:`` prefix, before frequency is considered."""
    prefix = prefix.strip()
    if not 1 <= len(prefix) <= MAX_PREFIX_CHARS:
        return False
    words = prefix.split()
    if not words or len(words) > MAX_PREFIX_WORDS:
        return False
    if any(ch in prefix for ch in "?!"):
        return False
    # A trailing comma is normal on a display name whose affiliation got cut off;
    # only the endings that read as mid-sentence are rejected.
    if prefix[-1] in ";-":
        return False
    if starts_with_function_word(prefix):
        return False
    return True


def _accept_speakers(counts: dict[str, int]) -> set[str]:
    """Decide which candidate prefixes are real speakers, given the whole file.

    A prefix qualifies if it is plausibly name-shaped *and* either reads as a
    proper name or appears more than once. Requiring recurrence for anything but
    a clean two-word name is what keeps a stray mid-sentence colon from inventing
    a speaker: an accidental prefix would have to appear verbatim twice.
    """
    accepted = set()
    for prefix, count in counts.items():
        if not is_plausible_speaker_prefix(prefix):
            continue
        if count >= 2 or (
            looks_like_a_name(prefix) and len(prefix.split()) <= SIGHT_ONCE_MAX_WORDS
        ):
            accepted.add(prefix)
    return accepted


@dataclass
class _Resolved:
    speaker: str | None
    text: str
    prefix: str
    suffix: str


def _extract_payload_speakers(payloads: list[str]) -> tuple[list[_Resolved], str]:
    """Resolve each payload into speaker, readable text, and what was stripped."""
    # Voice tags are unambiguous -- if the file uses them, trust them exclusively
    # and never run the colon heuristic.
    voice_hits = [_VOICE_RE.match(p) for p in payloads]
    if any(voice_hits):
        resolved = []
        for payload, hit in zip(payloads, voice_hits):
            if hit:
                resolved.append(
                    _Resolved(
                        speaker=_clean(hit.group("speaker")) or None,
                        text=_clean(hit.group("text")),
                        prefix=hit.group("open"),
                        suffix=hit.group("close") or "",
                    )
                )
            else:
                resolved.append(_Resolved(None, _clean(payload), "", ""))
        return resolved, "voice-tag"

    counts: dict[str, int] = {}
    matches = [_COLON_RE.match(p) for p in payloads]
    for hit in matches:
        if hit:
            name = hit.group("name").strip()
            counts[name] = counts.get(name, 0) + 1

    accepted = _accept_speakers(counts)
    if not accepted:
        return [_Resolved(None, _clean(p), "", "") for p in payloads], "none"

    resolved = []
    for payload, hit in zip(payloads, matches):
        if hit and hit.group("name").strip() in accepted:
            resolved.append(
                _Resolved(
                    speaker=hit.group("name").strip(),
                    text=_clean(hit.group("text")),
                    prefix=hit.group("name") + ":" + hit.group("sep"),
                    suffix="",
                )
            )
        else:
            # A rejected prefix means the colon was punctuation: keep the whole
            # line and let the cue inherit the speaker still holding the floor.
            resolved.append(_Resolved(None, _clean(payload), "", ""))
    return resolved, "colon-prefix"


def parse_cues(content: str) -> tuple[list[Cue], str]:
    """Parse VTT text into cues. Returns the cues and the detection method."""
    timings: list[tuple[float, float]] = []
    payloads: list[str] = []
    spans: list[tuple[int, int]] = []

    for block in _iter_blocks(_iter_lines(content)):
        timing_idx = next((i for i, line in enumerate(block) if "-->" in line.text), None)
        if timing_idx is None:
            continue  # a block with no timing line is not a cue
        hit = _TIMING_RE.match(block[timing_idx].text)
        if not hit:
            continue
        try:
            start = parse_timestamp(hit.group("start"))
            end = parse_timestamp(hit.group("end"))
        except VTTParseError:
            continue
        payload_lines = block[timing_idx + 1 :]
        if not payload_lines:
            continue
        payload = " ".join(line.text for line in payload_lines).strip()
        if not payload:
            continue
        timings.append((start, max(start, end)))
        payloads.append(payload)
        spans.append((payload_lines[0].start, payload_lines[-1].end))

    if not timings:
        raise VTTParseError("no cues found; is this a WebVTT file?")

    resolved, method = _extract_payload_speakers(payloads)

    cues: list[Cue] = []
    current_speaker: str | None = None
    for index, ((start, end), item, span) in enumerate(zip(timings, resolved, spans)):
        if item.speaker:
            current_speaker = item.speaker
        if not item.text:
            continue
        cues.append(
            Cue(
                id=f"c{index}",
                index=index,
                start=start,
                end=end,
                speaker=current_speaker,
                text=item.text,
                source_start=span[0],
                source_end=span[1],
                prefix=item.prefix,
                suffix=item.suffix,
            )
        )
    return cues, method


def build_chunks(cues: list[Cue], has_speakers: bool) -> list[Chunk]:
    """Group cues into display blocks.

    With speakers, a chunk is exactly one contiguous run from one speaker, as
    requested -- long turns stay whole and get paragraph breaks instead. Without
    speakers there is nothing to group on, so chunks break on long pauses.
    """
    chunks: list[Chunk] = []
    run: list[Cue] = []

    def flush() -> None:
        if not run:
            return
        paragraphs: list[list[str]] = [[]]
        previous: Cue | None = None
        for cue in run:
            if previous is not None and cue.start - previous.end > PARAGRAPH_GAP:
                paragraphs.append([])
            paragraphs[-1].append(cue.id)
            previous = cue
        chunks.append(
            Chunk(
                id=f"k{len(chunks)}",
                index=len(chunks),
                speaker=run[0].speaker,
                start=run[0].start,
                end=run[-1].end,
                cue_ids=[c.id for c in run],
                paragraphs=[p for p in paragraphs if p],
            )
        )
        run.clear()

    for cue in cues:
        if run:
            # A new recording always starts a new block, even mid-sentence from
            # the same speaker -- the interruption is real and worth seeing.
            if cue.part_index != run[-1].part_index:
                boundary = True
            elif has_speakers:
                boundary = cue.speaker != run[-1].speaker
            else:
                boundary = cue.start - run[-1].end > FALLBACK_CHUNK_GAP
            if boundary:
                flush()
        run.append(cue)
    flush()

    by_id = {cue.id: cue for cue in cues}
    seen_parts: set[int] = set()
    for chunk in chunks:
        first = by_id.get(chunk.cue_ids[0])
        chunk.part_index = first.part_index if first else 0
        chunk.starts_part = chunk.part_index not in seen_parts
        seen_parts.add(chunk.part_index)
    return chunks


def parse_vtt(content: str, source_name: str = "transcript.vtt") -> Transcript:
    cues, method = parse_cues(content)
    speakers: list[str] = []
    for cue in cues:
        if cue.speaker and cue.speaker not in speakers:
            speakers.append(cue.speaker)
    chunks = build_chunks(cues, has_speakers=bool(speakers))
    digest = hashlib.sha256(content.encode("utf-8", "replace")).hexdigest()
    return Transcript(
        cues=cues,
        chunks=chunks,
        speakers=speakers,
        source_name=source_name,
        sha256=digest,
        speaker_detection=method,
    )


def assemble_session(specs: list[dict], parts: list[Part], source_name: str) -> Transcript:
    """Lay several parsed recordings end to end on one session timeline.

    Each spec carries that part's locally-timed cues and the offset at which the
    part begins. Cues are renumbered globally in time order, so ids stay stable
    when a later part is added to a folder -- which matters because saved quotes
    are anchored to cue ids.
    """
    combined: list[Cue] = []
    for spec in specs:
        offset = spec["offset"]
        part_index = spec["index"]
        for cue in spec["cues"]:
            combined.append(cue.shifted(f"c{len(combined)}", len(combined), offset, part_index))

    speakers: list[str] = []
    for cue in combined:
        if cue.speaker and cue.speaker not in speakers:
            speakers.append(cue.speaker)

    chunks = build_chunks(combined, has_speakers=bool(speakers))
    digest = session_digest([spec["sha256"] for spec in specs])
    methods = {spec["method"] for spec in specs}
    method = methods.pop() if len(methods) == 1 else "mixed"

    return Transcript(
        cues=combined,
        chunks=chunks,
        speakers=speakers,
        source_name=source_name,
        sha256=digest,
        speaker_detection=method,
        parts=parts,
    )


def session_digest(part_digests: list[str]) -> str:
    """The session's fingerprint, recomputed whenever a transcript is edited.

    A one-part session keeps the plain content digest, so folders that predate
    multi-part support do not read as "the transcript changed" on first open.
    """
    if len(part_digests) == 1:
        return part_digests[0]
    return hashlib.sha256(" ".join(part_digests).encode("utf-8")).hexdigest()


def splice_cue(content: str, cue: Cue, new_text: str) -> str:
    """Replace one cue's payload in the source, leaving the rest byte-identical."""
    replacement = f"{cue.prefix}{new_text}{cue.suffix}"
    return content[: cue.source_start] + replacement + content[cue.source_end :]


def load_vtt(path: Path) -> Transcript:
    # Zoom occasionally emits stray bytes in otherwise-UTF-8 files; replacing is
    # better than refusing to open an hour of transcript over one bad character.
    content = path.read_text(encoding="utf-8", errors="replace")
    return parse_vtt(content, source_name=path.name)
