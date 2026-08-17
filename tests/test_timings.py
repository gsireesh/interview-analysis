"""Measured word timings: storing them, keeping them addressed to the right words.

Nothing here loads the acoustic model. Timings are written straight into the
sidecar, which is the same thing alignment does and lets every consequence of
having them be tested without half a gigabyte of weights.
"""

import pytest

from subtitle_search.editing import (
    apply_cue_edit,
    apply_cue_merge,
    apply_cue_split,
    apply_speaker_edit,
)
from subtitle_search.session import open_recording
from subtitle_search.timings import (
    WORDS_FILENAME,
    TimedWord,
    TimingStore,
    coverage,
    split_words,
    unmeasured,
    word_index_map,
)

from .test_session import write_mp4

# Two people inside one caption, with a real pause between them -- the case the
# whole feature exists for.
SHARED = """WEBVTT

1
00:00:00.000 --> 00:00:04.000
Dana Whitfield: Thanks for making the time.

2
00:00:04.000 --> 00:00:14.000
Dana Whitfield: So walk me through it. Sure, I read it first.
"""

# The second caption's words, as they would come back from the aligner: five
# words, a two-and-a-bit second silence, then the answer.
SECOND_CAPTION = [
    ("so", 4.2, 4.4),
    ("walk", 4.5, 4.8),
    ("me", 4.9, 5.0),
    ("through", 5.1, 5.4),
    ("it", 5.5, 5.7),
    ("sure", 8.0, 8.4),
    ("i", 8.5, 8.6),
    ("read", 8.7, 9.0),
    ("it", 9.1, 9.2),
    ("first", 9.3, 9.8),
]


def write_timings(folder, vtt_name="meeting.vtt", first_index=5, words=SECOND_CAPTION):
    store = TimingStore(folder / WORDS_FILENAME)
    store.record(
        vtt_name,
        [
            TimedWord(index=first_index + n, word=word, start=start, end=end)
            for n, (word, start, end) in enumerate(words)
        ],
    )
    return store


@pytest.fixture
def folder(tmp_path):
    (tmp_path / "meeting.vtt").write_text(SHARED, encoding="utf-8")
    write_mp4(tmp_path / "meeting.mp4", 30)
    return tmp_path


@pytest.fixture
def timed(folder):
    write_timings(folder)
    return open_recording(folder)


# -- the index space ----------------------------------------------------


def test_words_are_addressed_by_position_in_the_part(folder):
    recording = open_recording(folder)
    positions = word_index_map(recording.transcript.cues)
    assert positions == {"c0": 0, "c1": 5}


def test_a_store_round_trips(folder):
    write_timings(folder)
    reread = TimingStore(folder / WORDS_FILENAME)
    assert reread.words("meeting.vtt")[5].word == "so"
    assert reread.words("meeting.vtt")[10].start == 8.0
    assert not reread.empty


def test_an_unreadable_store_is_treated_as_absent(folder):
    (folder / WORDS_FILENAME).write_text("{not json", encoding="utf-8")
    assert TimingStore(folder / WORDS_FILENAME).empty


def test_shifting_moves_later_words_only(folder):
    store = write_timings(folder)
    store.shift("meeting.vtt", 10, 2)
    words = store.words("meeting.vtt")
    assert words[5].word == "so"  # before the shift point, untouched
    assert 10 not in words
    assert words[12].word == "sure"


def test_dropping_forgets_a_range(folder):
    store = write_timings(folder)
    store.drop("meeting.vtt", 5, 9)
    words = store.words("meeting.vtt")
    assert set(words) == {10, 11, 12, 13, 14}


# -- what a cue does with them ------------------------------------------


def test_a_caption_without_timings_still_interpolates(folder):
    recording = open_recording(folder)
    cue = recording.transcript.cue("c1")
    assert not cue.timed
    # The old behaviour, unchanged: character count across the caption.
    assert cue.time_at_offset(cue.text.index("Sure")) == pytest.approx(9.111, abs=0.01)


def test_a_measured_caption_reports_the_measurement(timed):
    cue = timed.transcript.cue("c1")
    assert cue.timed
    assert cue.time_at_offset(cue.text.index("Sure")) == pytest.approx(8.0)
    assert cue.time_at_offset(cue.text.index("walk")) == pytest.approx(4.5)


def test_measuring_one_caption_leaves_its_neighbour_estimated(timed):
    assert not timed.transcript.cue("c0").timed
    assert timed.transcript.cue("c1").timed


def test_a_point_inside_a_word_interpolates_within_that_word(timed):
    cue = timed.transcript.cue("c1")
    at = cue.text.index("through")
    # 'through' runs 5.1 to 5.4; halfway through the word is halfway through it.
    assert cue.time_at_offset(at + 4) == pytest.approx(5.1 + (4 / 7) * 0.3, abs=0.01)


def test_the_boundary_at_a_point_is_the_silence_around_it(timed):
    cue = timed.transcript.cue("c1")
    assert cue.boundary_at_offset(cue.text.index("Sure")) == pytest.approx((5.7, 8.0))


def test_an_unmeasured_caption_has_no_boundary(folder):
    recording = open_recording(folder)
    assert recording.transcript.cue("c1").boundary_at_offset(5) is None


def test_a_word_that_changed_loses_its_timing_but_not_its_neighbours(folder):
    """The stored word is compared, so a desync degrades instead of lying."""
    corrupted = [("XXX", 4.2, 4.4)] + SECOND_CAPTION[1:]
    write_timings(folder, words=corrupted)
    cue = open_recording(folder).transcript.cue("c1")
    # 'So' was measured against a different word, so it is dropped; the rest hold.
    assert len(cue.words) == len(SECOND_CAPTION) - 1
    assert cue.time_at_offset(cue.text.index("walk")) == pytest.approx(4.5)


def test_coverage_and_the_batch_queue(timed):
    assert coverage(timed.transcript) == {"timed": 1, "total": 2, "complete": False}
    assert [cue.id for cue in unmeasured(timed.transcript, 10)] == ["c0"]


# -- splitting on a measurement -----------------------------------------


def test_a_split_cuts_on_the_measured_pause(timed):
    cue = timed.transcript.cue("c1")
    result = apply_cue_split(timed, "c1", cue.text.index("Sure"), align=False)

    assert result["measured"] is True
    assert (result["at"], result["tail_at"]) == pytest.approx((5.7, 8.0))
    # The halves do not meet: the silence between two speakers is neither's.
    written = (timed.folder / "meeting.vtt").read_text()
    assert "00:00:04.000 --> 00:00:05.700" in written
    assert "00:00:08.000 --> 00:00:14.000" in written


def test_an_unmeasured_split_shares_one_interpolated_boundary(folder):
    recording = open_recording(folder)
    cue = recording.transcript.cue("c1")
    result = apply_cue_split(recording, "c1", cue.text.index("Sure"), align=False)

    assert result["measured"] is False
    assert result["at"] == result["tail_at"]
    written = (folder / "meeting.vtt").read_text()
    assert written.count("00:00:09.111") == 2  # the two halves meet


def test_timings_survive_a_split_untouched(timed):
    """A split leaves the part's word sequence identical, so nothing must move."""
    cue = timed.transcript.cue("c1")
    apply_cue_split(timed, "c1", cue.text.index("Sure"), align=False)

    reread = open_recording(timed.folder)
    head, tail = reread.transcript.cue("c1"), reread.transcript.cue("c2")
    assert head.text == "So walk me through it."
    assert tail.text == "Sure, I read it first."
    # Both halves kept the words they were measured with.
    assert head.timed and tail.timed
    assert head.time_at_offset(0) == pytest.approx(4.2)
    assert tail.time_at_offset(0) == pytest.approx(8.0)


def test_measured_times_survive_two_splits(timed):
    cue = timed.transcript.cue("c1")
    apply_cue_split(timed, "c1", cue.text.index("Sure"), align=False)
    second = timed.transcript.cue("c2")
    apply_cue_split(timed, "c2", second.text.index("read"), align=False)

    reread = open_recording(timed.folder)
    assert [c.text for c in reread.transcript.cues][1:] == [
        "So walk me through it.",
        "Sure, I",
        "read it first.",
    ]
    assert reread.transcript.cue("c3").time_at_offset(0) == pytest.approx(8.7)


# -- corrections ---------------------------------------------------------


def test_correcting_a_caption_forgets_only_its_own_timings(folder):
    """Word indices after an edit move; the words in it are no longer measured."""
    write_timings(folder, first_index=0, words=[("thanks", 0.1, 0.5), ("for", 0.6, 0.8)])
    write_timings(folder)  # and the second caption, as before
    recording = open_recording(folder)
    assert recording.transcript.cue("c0").timed

    # Two words become four, so everything after shifts by two.
    apply_cue_edit(recording, "c0", "Thanks so very much for making the time.")

    reread = open_recording(folder)
    assert not reread.transcript.cue("c0").timed  # its own words are void
    assert reread.transcript.cue("c1").timed  # the next caption still measured
    assert reread.transcript.cue("c1").time_at_offset(0) == pytest.approx(4.2)


def test_reattributing_a_speaker_keeps_the_timings(timed):
    """The label is not part of a caption's words, so nothing moves."""
    apply_speaker_edit(timed, "c1", "Rafael Ortiz")
    reread = open_recording(timed.folder)
    assert reread.transcript.cue("c1").timed
    assert reread.transcript.cue("c1").time_at_offset(0) == pytest.approx(4.2)


def test_the_word_index_space_counts_every_word(folder):
    recording = open_recording(folder)
    assert len(split_words(recording.transcript.cue("c0").text)) == 5
    assert len(split_words(recording.transcript.cue("c1").text)) == 10


def test_timings_survive_a_join_untouched(timed):
    """Joining leaves the word sequence identical, so nothing needs remapping."""
    apply_cue_merge(timed, "c0", "c1")

    reread = open_recording(timed.folder)
    joined = reread.transcript.cue("c0")
    assert joined.text == "Thanks for making the time. So walk me through it. Sure, I read it first."
    # The second caption's words were never measured against c0's five words, and
    # the measurements are addressed by position, so they land where they belong.
    assert joined.time_at_offset(joined.text.index("Sure")) == pytest.approx(8.0)
    assert joined.time_at_offset(joined.text.index("walk")) == pytest.approx(4.5)


def test_a_split_then_undo_leaves_the_timings_where_they_started(timed):
    cue = timed.transcript.cue("c1")
    was = [cue.time_at_offset(o) for o in (0, 10, 30)]
    split = apply_cue_split(timed, "c1", cue.text.index("Sure"), align=False)
    apply_cue_merge(timed, *split["cue_ids"], expect=split["halves"])

    restored = open_recording(timed.folder).transcript.cue("c1")
    assert restored.text == cue.text
    assert [restored.time_at_offset(o) for o in (0, 10, 30)] == pytest.approx(was)


def test_a_join_restores_the_original_span(timed):
    """Undo puts the caption's own start and end back, not the halves'."""
    cue = timed.transcript.cue("c1")
    split = apply_cue_split(timed, "c1", cue.text.index("Sure"), align=False)
    apply_cue_merge(timed, *split["cue_ids"], expect=split["halves"])

    restored = open_recording(timed.folder).transcript.cue("c1")
    assert (restored.start, restored.end) == (cue.start, cue.end)
