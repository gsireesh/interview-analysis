"""Correcting the transcript, and keeping quotes anchored while it happens."""

import pytest

from subtitle_search.editing import EditError, apply_cue_edit, backup_path, remap_offset
from subtitle_search.session import open_recording

from .test_session import write_mp4

EDITABLE = """WEBVTT

1
00:00:01.000 --> 00:00:08.000
Dana Whitfield: We should reconvene about the kubernetes migration next week.

2
00:00:09.000 --> 00:00:15.000
Rafael Ortiz: Agreed. I'll put something on the calendar for Tuesday.

3
00:00:16.000 --> 00:00:21.000
Dana Whitfield: Perfect, thank you.
"""

# A block the parser cannot read, sitting between two it can. Regenerating the
# file from parsed cues would silently drop it; splicing must not.
WITH_UNPARSEABLE = """WEBVTT

1
00:00:01.000 --> 00:00:08.000
Dana Whitfield: The first line, which parses fine.

2
00:00:09:000 --> 00:00:15.000
Dana Whitfield: This block has a malformed timestamp and gets skipped.

3
00:00:16.000 --> 00:00:21.000
Rafael Ortiz: The third line, which also parses fine.
"""


@pytest.fixture
def recording(tmp_path):
    (tmp_path / "meeting.vtt").write_text(EDITABLE, encoding="utf-8")
    write_mp4(tmp_path / "meeting.mp4", 30)
    return open_recording(tmp_path)


# -- offset remapping ---------------------------------------------------


def test_remap_offset_through_an_insertion():
    old, new = "hello world", "hello brave world"
    # "world" starts at 6 in the old text and 12 in the new one.
    assert old[6:] == "world"
    assert remap_offset(old, new, 6) == 12
    assert remap_offset(old, new, 0) == 0
    assert remap_offset(old, new, len(old)) == len(new)


def test_remap_offset_through_a_deletion():
    old, new = "the very big dog", "the big dog"
    assert remap_offset(old, new, old.index("big")) == new.index("big")


def test_remap_offset_inside_a_rewritten_span_collapses_to_an_edge():
    old, new = "kubernetes", "Kubernetes"
    mapped = remap_offset(old, new, 5)
    assert 0 <= mapped <= len(new)


def test_remap_offset_clamps_out_of_range():
    assert remap_offset("abc", "abcdef", 99) == 6
    assert remap_offset("abc", "ab", -5) == 0


# -- writing back -------------------------------------------------------


def test_edit_writes_to_the_original_file(recording):
    apply_cue_edit(recording, "c0", "We should reconvene about the Kubernetes migration next week.")

    saved = (recording.folder / "meeting.vtt").read_text()
    assert "Kubernetes migration" in saved
    # The speaker prefix is put back exactly as it was.
    assert "Dana Whitfield: We should reconvene about the Kubernetes" in saved
    assert recording.transcript.cue("c0").text.startswith("We should reconvene about the Kubernetes")


def test_first_edit_backs_up_the_original(recording):
    backup = backup_path(recording.folder / "meeting.vtt")
    assert not backup.exists()

    result = apply_cue_edit(recording, "c0", "First correction.")
    assert result["backup_created"] == "meeting_original.vtt"
    assert backup.read_text() == EDITABLE


def test_backup_is_never_overwritten_by_later_edits(recording):
    """The backup holds the file as it arrived, not the last state before an edit."""
    apply_cue_edit(recording, "c0", "First correction.")
    second = apply_cue_edit(recording, "c1", "Second correction.")

    assert second["backup_created"] is None
    assert backup_path(recording.folder / "meeting.vtt").read_text() == EDITABLE


def test_backup_is_not_read_as_another_recording(recording):
    """The backup shares the folder and the .vtt extension as the transcript."""
    before = len(recording.transcript.cues)
    apply_cue_edit(recording, "c0", "An edit, which creates the backup.")

    reopened = open_recording(recording.folder)
    assert backup_path(recording.folder / "meeting.vtt").exists()
    # Without excluding it, discovery would treat the backup as a second part
    # and double every count.
    assert len(reopened.transcript.parts) == 1
    assert len(reopened.transcript.cues) == before
    assert reopened.transcript.duration == recording.transcript.duration


def test_untouched_lines_are_left_byte_identical(recording):
    original = (recording.folder / "meeting.vtt").read_text()
    apply_cue_edit(recording, "c1", "Agreed. Calendar invite going out now.")
    saved = (recording.folder / "meeting.vtt").read_text()

    for line in ("WEBVTT", "00:00:01.000 --> 00:00:08.000", "Dana Whitfield: Perfect, thank you."):
        assert line in saved
    # Only the edited payload differs.
    assert original.count("\n") == saved.count("\n")


def test_a_block_the_parser_skipped_survives_an_edit(tmp_path):
    (tmp_path / "meeting.vtt").write_text(WITH_UNPARSEABLE, encoding="utf-8")
    recording = open_recording(tmp_path)

    # Only two cues parsed; the malformed block was skipped.
    assert len(recording.transcript.cues) == 2
    apply_cue_edit(recording, "c0", "The first line, now corrected.")

    saved = (tmp_path / "meeting.vtt").read_text()
    assert "This block has a malformed timestamp and gets skipped." in saved
    assert "00:00:09:000 --> 00:00:15.000" in saved


def test_consecutive_edits_shift_later_spans_correctly(recording):
    """The second edit must land correctly after the first changed the length."""
    apply_cue_edit(recording, "c0", "Short.")
    apply_cue_edit(recording, "c1", "Also short.")
    apply_cue_edit(recording, "c2", "A considerably longer replacement line than before.")

    saved = (recording.folder / "meeting.vtt").read_text()
    assert "Dana Whitfield: Short." in saved
    assert "Rafael Ortiz: Also short." in saved
    assert "Dana Whitfield: A considerably longer replacement line than before." in saved
    assert saved.count("-->") == 3


def test_crlf_line_endings_are_preserved(tmp_path):
    (tmp_path / "meeting.vtt").write_bytes(EDITABLE.replace("\n", "\r\n").encode("utf-8"))
    recording = open_recording(tmp_path)

    apply_cue_edit(recording, "c1", "Corrected on a CRLF file.")
    saved = (tmp_path / "meeting.vtt").read_bytes()

    assert b"Corrected on a CRLF file." in saved
    assert saved.count(b"\r\n") >= 8  # the rest of the file kept its endings


def test_empty_edit_is_rejected(recording):
    with pytest.raises(EditError):
        apply_cue_edit(recording, "c0", "   ")


def test_unknown_cue_is_rejected(recording):
    with pytest.raises(EditError):
        apply_cue_edit(recording, "c999", "text")


def test_unchanged_text_is_a_no_op(recording):
    text = recording.transcript.cue("c0").text
    result = apply_cue_edit(recording, "c0", text)

    assert result["changed"] is False
    assert not backup_path(recording.folder / "meeting.vtt").exists()


# -- quotes surviving edits ---------------------------------------------


def _quote(recording, cue_id, start, end):
    cue = recording.transcript.cue(cue_id)
    return recording.store.create(
        {
            "text": cue.text[start:end],
            "start_cue_id": cue_id,
            "start_char_offset": start,
            "end_cue_id": cue_id,
            "end_char_offset": end,
        }
    )


def test_quote_after_an_edit_still_covers_the_same_words(recording):
    cue = recording.transcript.cue("c0")
    start = cue.text.index("kubernetes")
    quote = _quote(recording, "c0", start, start + len("kubernetes migration"))
    assert quote["text"] == "kubernetes migration"

    # Insert words *before* the quote; its offsets must move with it.
    apply_cue_edit(
        recording, "c0", "So, we should probably reconvene about the kubernetes migration next week."
    )

    updated = recording.store.list()[0]
    covered = recording.transcript.text_between(
        updated["start_cue_id"],
        updated["start_char_offset"],
        updated["end_cue_id"],
        updated["end_char_offset"],
    )
    assert covered == "kubernetes migration"
    assert updated["text"] == "kubernetes migration"


def test_correcting_a_word_inside_a_quote_updates_the_saved_quote(recording):
    cue = recording.transcript.cue("c0")
    start = cue.text.index("kubernetes")
    _quote(recording, "c0", start, start + len("kubernetes migration"))

    apply_cue_edit(
        recording, "c0", "We should reconvene about the Kubernetes migration next week."
    )

    updated = recording.store.list()[0]
    # The saved quote reflects the correction rather than preserving the error.
    assert "Kubernetes" in updated["text"]
    assert "kubernetes" not in updated["text"]


def test_quote_times_are_re_resolved_after_an_edit(recording):
    quote = _quote(recording, "c0", 0, 10)
    before = quote["start_time"]

    apply_cue_edit(recording, "c0", "Padding words at the front. " + recording.transcript.cue("c0").text)

    updated = recording.store.list()[0]
    assert updated["start_time"] >= before
    cue = recording.transcript.cue("c0")
    assert cue.start <= updated["start_time"] <= cue.end


def test_quotes_in_other_cues_are_untouched(recording):
    other = _quote(recording, "c2", 0, 7)
    snapshot = dict(other)

    apply_cue_edit(recording, "c0", "A totally different first line entirely.")

    unchanged = next(h for h in recording.store.list() if h["id"] == snapshot["id"])
    assert unchanged["start_char_offset"] == snapshot["start_char_offset"]
    assert unchanged["text"] == snapshot["text"]


def test_transcript_does_not_read_as_stale_after_its_own_edit(recording):
    _quote(recording, "c0", 0, 10)
    apply_cue_edit(recording, "c0", "An edited first line.")

    assert recording.store.stale is False


# -- multi-part ---------------------------------------------------------


def test_edit_lands_in_the_right_part(tmp_path):
    (tmp_path / "GMT20240301-140000_Recording.vtt").write_text(EDITABLE)
    write_mp4(tmp_path / "GMT20240301-140000_Recording.mp4", 60)
    (tmp_path / "GMT20240301-141200_Recording.vtt").write_text(
        "WEBVTT\n\n1\n00:00:01.000 --> 00:00:05.000\nRafael Ortiz: Second recording line.\n"
    )
    write_mp4(tmp_path / "GMT20240301-141200_Recording.mp4", 30)

    recording = open_recording(tmp_path)
    second_part_cue = next(c for c in recording.transcript.cues if c.part_index == 1)
    apply_cue_edit(recording, second_part_cue.id, "Second recording line, corrected.")

    assert "corrected" in (tmp_path / "GMT20240301-141200_Recording.vtt").read_text()
    assert "corrected" not in (tmp_path / "GMT20240301-140000_Recording.vtt").read_text()
    # Only the edited part gets a backup.
    assert (tmp_path / "GMT20240301-141200_Recording_original.vtt").exists()
    assert not (tmp_path / "GMT20240301-140000_Recording_original.vtt").exists()


def test_voice_tag_files_keep_their_tags(tmp_path):
    (tmp_path / "meeting.vtt").write_text(
        "WEBVTT\n\n1\n00:00:01.000 --> 00:00:05.000\n<v Dana Whitfield>Original wording here.\n"
        "\n2\n00:00:06.000 --> 00:00:09.000\n<v Rafael Ortiz>Another line.\n"
    )
    recording = open_recording(tmp_path)
    apply_cue_edit(recording, "c0", "Corrected wording here.")

    saved = (tmp_path / "meeting.vtt").read_text()
    assert "<v Dana Whitfield>Corrected wording here." in saved
