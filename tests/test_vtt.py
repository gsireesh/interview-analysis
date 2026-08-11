import pytest

from subtitle_search.vtt import (
    VTTParseError,
    format_timestamp,
    parse_timestamp,
    parse_vtt,
)

from . import fixtures


def test_parses_colon_prefix_speakers():
    transcript = parse_vtt(fixtures.COLON_PREFIX)

    assert transcript.speaker_detection == "colon-prefix"
    assert transcript.speakers == ["Dana Whitfield", "Rafael Ortiz"]
    assert len(transcript.cues) == 5
    # The speaker prefix is stripped from the readable text.
    assert transcript.cues[0].text.startswith("Cool. And then I will share")
    assert "Dana Whitfield" not in transcript.cues[0].text


def test_chunks_break_only_on_speaker_change():
    transcript = parse_vtt(fixtures.COLON_PREFIX)

    assert [c.speaker for c in transcript.chunks] == [
        "Dana Whitfield",
        "Rafael Ortiz",
        "Dana Whitfield",
    ]
    # The first three contiguous cues from one speaker merge into one chunk.
    assert transcript.chunks[0].cue_ids == ["c0", "c1", "c2"]
    assert transcript.chunks[0].start == pytest.approx(2.18)
    assert transcript.chunks[0].end == pytest.approx(22.16)


def test_colon_inside_a_sentence_does_not_invent_a_speaker():
    transcript = parse_vtt(fixtures.COLON_IN_SENTENCE)

    assert transcript.speakers == ["Dana Whitfield", "Rafael Ortiz"]
    # The mid-sentence colon survives in the text rather than being split off.
    assert "here's my whole point: I disagreed" in transcript.cues[0].text
    assert "one thing: nobody asked" in transcript.cues[1].text


def test_recurring_but_unnamelike_prefix_is_rejected():
    """A repeated sentence fragment passes the frequency test but fails on shape."""
    transcript = parse_vtt(fixtures.TRICKY_PREFIXES)

    assert transcript.speakers == []
    assert transcript.speaker_detection == "none"
    assert transcript.cues[0].text.startswith("Well here's the thing:")


def test_voice_tags_take_precedence():
    transcript = parse_vtt(fixtures.VOICE_TAG)

    assert transcript.speaker_detection == "voice-tag"
    assert transcript.speakers == ["Dana Whitfield", "Rafael Ortiz"]
    assert transcript.cues[0].text == "Let me pull up the document."
    assert len(transcript.chunks) == 2


def test_no_speakers_falls_back_to_pause_chunking():
    transcript = parse_vtt(fixtures.NO_SPEAKER)

    assert transcript.speakers == []
    assert transcript.speaker_detection == "none"
    # The 13-second gap before the third cue starts a new chunk.
    assert len(transcript.chunks) == 2
    assert transcript.chunks[0].cue_ids == ["c0", "c1"]
    assert transcript.chunks[1].cue_ids == ["c2"]


def test_crlf_and_missing_cue_numbers():
    transcript = parse_vtt(fixtures.CRLF_NO_NUMBERS)

    assert len(transcript.cues) == 2
    assert transcript.speakers == ["Dana Whitfield", "Rafael Ortiz"]
    assert transcript.cues[0].text == "First line of the transcript."


def test_long_turn_keeps_one_chunk_but_splits_paragraphs():
    transcript = parse_vtt(fixtures.LONG_TURN_WITH_PAUSE)

    assert len(transcript.chunks) == 1
    chunk = transcript.chunks[0]
    # One chunk, one speaker label -- but broken for reading at the 7s pause.
    assert chunk.paragraphs == [["c0", "c1"], ["c2"]]


def test_multiline_payload_is_joined():
    transcript = parse_vtt(fixtures.MULTILINE_PAYLOAD)

    assert len(transcript.cues) == 1
    assert transcript.cues[0].text == "This sentence was wrapped across two lines by the exporter."


def test_timestamp_round_trip():
    assert parse_timestamp("00:00:02.180") == pytest.approx(2.18)
    assert parse_timestamp("01:02:03.500") == pytest.approx(3723.5)
    assert parse_timestamp("02:03.500") == pytest.approx(123.5)
    assert parse_timestamp("00:00:02,180") == pytest.approx(2.18)
    assert format_timestamp(3723) == "1:02:03"
    assert format_timestamp(123) == "2:03"


def test_non_vtt_content_raises():
    with pytest.raises(VTTParseError):
        parse_vtt("this is just a text file\nwith no cues at all\n")


def test_cue_offset_interpolation():
    transcript = parse_vtt(fixtures.COLON_PREFIX)
    cue = transcript.cues[0]

    assert cue.time_at_offset(0) == pytest.approx(cue.start)
    assert cue.time_at_offset(len(cue.text)) == pytest.approx(cue.end)
    midpoint = cue.time_at_offset(len(cue.text) // 2)
    assert cue.start < midpoint < cue.end
    # Interpolation is what makes a mid-cue quote land close; on a ~10s cue the
    # difference between this and seeking to cue.start is several seconds.
    assert midpoint - cue.start > 4


@pytest.mark.parametrize(
    "label",
    [
        "B.F. (Jim) Lightning, Brown U. USA",
        "Bartholomew F. (Jim) Lightning, Brown University, USA",
        "B.F. (Jim) Lightning, Brown University of Rhode Island, USA",
        "B.F. Lightning, Dept. of Computer Science, Brown U., USA",
        "B.F. (Jim) Lightning, Brown U. USA,",
    ],
)
def test_long_institutional_display_names_are_detected(label):
    """A rejected prefix does not fail loudly -- the cue inherits the previous
    speaker, so two people silently merge into one."""
    vtt = (
        "WEBVTT\n\n1\n00:00:01.000 --> 00:00:05.000\nDana Whitfield: Thanks for joining.\n\n"
        f"2\n00:00:06.000 --> 00:00:12.000\n{label}: Glad to help.\n\n"
        "3\n00:00:13.000 --> 00:00:18.000\nDana Whitfield: Tell me more.\n\n"
        f"4\n00:00:19.000 --> 00:00:26.000\n{label}: Mostly interviews.\n"
    )
    transcript = parse_vtt(vtt)
    assert len(transcript.speakers) == 2
    assert label in transcript.speakers


def test_a_long_prefix_still_has_to_recur():
    """Raising the length caps must not let a one-off sentence become a speaker."""
    vtt = (
        "WEBVTT\n\n1\n00:00:01.000 --> 00:00:05.000\nDana Whitfield: Morning.\n\n"
        "2\n00:00:06.000 --> 00:00:12.000\n"
        "Dana Whitfield: Note to self about the Q3 Budget Review: we need numbers.\n"
    )
    transcript = parse_vtt(vtt)
    assert transcript.speakers == ["Dana Whitfield"]
    assert "Q3 Budget Review: we need numbers" in transcript.cues[1].text
