"""Core data types.

Two distinctions carry the design.

Cues are what the VTT actually said; chunks are what you read. Cues are never
merged or rewritten, because they are the only thing that lets a loose text
selection resolve back to a point in the media.

Parts are the recordings a session was split across when it got interrupted. All
times outside a Part are *session* times on one continuous timeline; converting
back to a position in a particular file is what ``Part.offset`` is for.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import datetime


@dataclass
class Part:
    """One recording of an interrupted session, placed on the session timeline."""

    index: int
    vtt_name: str
    media_name: str | None
    media_kind: str | None
    #: Seconds from the start of the session at which this part begins.
    offset: float
    duration: float
    #: Wall-clock start, when the filenames carry one.
    started_at: datetime | None = None
    #: Real seconds between the previous part ending and this one starting.
    #: None when it cannot be known; 0 or more when it can.
    gap_before: float | None = None
    #: Digest of this part's transcript file, recomputed when it is edited.
    sha256: str = ""
    #: True once a correction has been saved and a backup copy exists.
    edited: bool = False

    def to_dict(self) -> dict:
        return {
            "index": self.index,
            "vtt_name": self.vtt_name,
            "media_name": self.media_name,
            "media_kind": self.media_kind,
            "offset": round(self.offset, 3),
            "duration": round(self.duration, 3),
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "gap_before": round(self.gap_before, 3) if self.gap_before is not None else None,
            "edited": self.edited,
        }


@dataclass(frozen=True)
class Cue:
    """One VTT cue, verbatim. The unit of localization."""

    id: str
    index: int
    start: float
    end: float
    speaker: str | None
    text: str
    part_index: int = 0
    #: Where this cue's payload sits in its source file, and what was stripped
    #: from around the readable text. Together these let a correction be spliced
    #: back into the original bytes instead of regenerating the file.
    source_start: int = 0
    source_end: int = 0
    #: Start of the cue's timing line, so a split can rewrite it.
    timing_start: int = 0
    prefix: str = ""
    suffix: str = ""
    #: Measured word spans, when this cue has been aligned to the audio:
    #: ``(char_start, char_end, start, end)`` in session time, in text order.
    #: Empty means nothing has been measured and times are interpolated.
    words: tuple[tuple[int, int, float, float], ...] = ()

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)

    @property
    def timed(self) -> bool:
        return bool(self.words)

    def time_at_offset(self, char_offset: int) -> float:
        """The session time at a character offset within this cue's text.

        Measured where the words have been aligned to the audio, interpolated
        where they have not. Interpolation divides the caption by character
        count, which is wrong by about the length of any pause the speaker took --
        and Zoom captions run to ten seconds, so that is regularly a second or
        more. Alignment replaces the estimate with the real thing.
        """
        if self.words:
            return self._measured(char_offset)
        if not self.text:
            return self.start
        ratio = min(max(char_offset, 0), len(self.text)) / len(self.text)
        return self.start + ratio * self.duration

    def _measured(self, char_offset: int) -> float:
        offset = min(max(char_offset, 0), len(self.text))
        previous_end = self.start
        for char_start, char_end, start, end in self.words:
            if offset < char_start:
                # In the space before a word -- punctuation, or a word the
                # aligner could not place. Land on the next word that was
                # measured, so playback starts on speech rather than in silence.
                return start
            if offset < char_end:
                span = char_end - char_start
                within = (offset - char_start) / span if span else 0.0
                return start + within * (end - start)
            previous_end = end
        return previous_end

    def boundary_at_offset(self, char_offset: int) -> tuple[float, float] | None:
        """The measured silence around a point: last word before, first word after.

        This is what a split wants. Cutting a caption in two at an interpolated
        point puts the boundary in the middle of somebody's word; cutting at a
        measured one gives the first half an end and the second half a start with
        the pause between them belonging to neither. ``None`` when this caption
        has no measurement to cut on.
        """
        if not self.words:
            return None
        offset = min(max(char_offset, 0), len(self.text))
        before = [end for char_start, _, _, end in self.words if char_start < offset]
        after = [start for char_start, _, start, _ in self.words if char_start >= offset]
        if not before or not after:
            return None
        return before[-1], after[0]

    def with_words(self, words: tuple[tuple[int, int, float, float], ...]) -> "Cue":
        """A copy carrying measured word spans."""
        return replace(self, words=words)

    def shifted(self, new_id: str, new_index: int, offset: float, part_index: int) -> "Cue":
        return Cue(
            id=new_id,
            index=new_index,
            start=self.start + offset,
            end=self.end + offset,
            speaker=self.speaker,
            text=self.text,
            part_index=part_index,
            source_start=self.source_start,
            source_end=self.source_end,
            timing_start=self.timing_start,
            prefix=self.prefix,
            suffix=self.suffix,
        )

    def edited(self, text: str, source_end: int) -> "Cue":
        """A copy carrying corrected text and the span it now occupies.

        Measured words are dropped: their character offsets describe the text as
        it was. The caption falls back to interpolation until it is re-aligned.
        """
        return Cue(
            id=self.id,
            index=self.index,
            start=self.start,
            end=self.end,
            speaker=self.speaker,
            text=text,
            part_index=self.part_index,
            source_start=self.source_start,
            source_end=source_end,
            timing_start=self.timing_start,
            prefix=self.prefix,
            suffix=self.suffix,
        )

    def moved(self, delta: int) -> "Cue":
        """A copy whose source span has shifted, after an earlier cue was edited.

        Keeps its measured words: only this cue's position in the file changed,
        not its text, and dropping them would throw away the alignment of
        everything downstream of a one-word correction.
        """
        return replace(
            self,
            source_start=self.source_start + delta,
            source_end=self.source_end + delta,
            timing_start=self.timing_start + delta,
        )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "index": self.index,
            "start": self.start,
            "end": self.end,
            "speaker": self.speaker,
            "text": self.text,
            "part_index": self.part_index,
            # Whether this caption's times are measured or interpolated. The
            # reader marks the difference rather than presenting both as equal.
            "timed": self.timed,
        }


@dataclass
class Chunk:
    """Contiguous cues from one speaker, displayed as a single block.

    ``paragraphs`` groups the chunk's cue ids by pause, so a long uninterrupted
    turn renders with visual breaks instead of as a wall of text. It is still one
    chunk with one speaker label and one timestamp.
    """

    id: str
    index: int
    speaker: str | None
    start: float
    end: float
    cue_ids: list[str]
    paragraphs: list[list[str]] = field(default_factory=list)
    part_index: int = 0
    #: True when this chunk opens a new recording, so the reader can show the break.
    starts_part: bool = False

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "index": self.index,
            "speaker": self.speaker,
            "start": self.start,
            "end": self.end,
            "cue_ids": self.cue_ids,
            "paragraphs": self.paragraphs,
            "part_index": self.part_index,
            "starts_part": self.starts_part,
        }


@dataclass
class Transcript:
    cues: list[Cue]
    chunks: list[Chunk]
    speakers: list[str]
    source_name: str
    sha256: str
    #: How speakers were determined, or "none" if chunking fell back to pauses.
    speaker_detection: str = "colon-prefix"
    parts: list[Part] = field(default_factory=list)
    #: Speakers assigned by hand, with the key that assigns each one.
    roster: list[dict] = field(default_factory=list)

    def __post_init__(self) -> None:
        self._by_id = {cue.id: cue for cue in self.cues}

    def cue(self, cue_id: str) -> Cue | None:
        return self._by_id.get(cue_id)

    def replace_cue(self, cue: Cue) -> None:
        """Swap in a corrected cue, keeping chunk membership as it was.

        Only the text changes, so timings and grouping are untouched -- the
        chunk this cue belongs to still holds the same cue ids.
        """
        for position, existing in enumerate(self.cues):
            if existing.id == cue.id:
                self.cues[position] = cue
                break
        self._by_id[cue.id] = cue

    def cues_in_part(self, part_index: int) -> list[Cue]:
        return [cue for cue in self.cues if cue.part_index == part_index]

    def text_between(
        self, start_cue_id: str, start_offset: int, end_cue_id: str, end_offset: int
    ) -> str:
        """The readable text a quote's anchors currently cover."""
        first, last = self.cue(start_cue_id), self.cue(end_cue_id)
        if first is None or last is None:
            return ""
        if first.index > last.index:
            first, last = last, first
            start_offset, end_offset = end_offset, start_offset

        pieces: list[str] = []
        for cue in self.cues:
            if cue.index < first.index or cue.index > last.index:
                continue
            begin = start_offset if cue.id == first.id else 0
            finish = end_offset if cue.id == last.id else len(cue.text)
            pieces.append(cue.text[max(0, begin) : max(0, finish)])
        return " ".join(piece for piece in pieces if piece).strip()

    @property
    def duration(self) -> float:
        if self.parts:
            return max(part.offset + part.duration for part in self.parts)
        return self.cues[-1].end if self.cues else 0.0

    def part(self, index: int) -> Part | None:
        return next((p for p in self.parts if p.index == index), None)

    def diagnostics(self) -> dict:
        """Parse summary, surfaced in the UI and by ``--dump-parse``.

        Speaker detection is heuristic, so it reports what it decided rather than
        leaving a misparse to be discovered halfway through a reading session.
        """
        return {
            "cue_count": len(self.cues),
            "chunk_count": len(self.chunks),
            "speakers": self.speakers,
            "speaker_detection": self.speaker_detection,
            "duration": self.duration,
            "source_name": self.source_name,
            "part_count": len(self.parts),
        }

    def to_dict(self) -> dict:
        return {
            "source_name": self.source_name,
            "sha256": self.sha256,
            "duration": self.duration,
            "speakers": self.speakers,
            "cues": [c.to_dict() for c in self.cues],
            "chunks": [c.to_dict() for c in self.chunks],
            "parts": [p.to_dict() for p in self.parts],
            "roster": self.roster,
            "diagnostics": self.diagnostics(),
        }
