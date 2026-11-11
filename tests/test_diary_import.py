"""Reading a study diary and placing its events on the recording timeline."""

import json
from dataclasses import dataclass
from datetime import datetime

from subtitle_search.diary_import import SINGLE_LENGTH, find_diary, note_text, pair, parse_time, place, read_rows


@dataclass
class FakePart:
    offset: float
    duration: float
    started_at: datetime | None


def row(event, at, **detail):
    return {"session_id": "s", "timestamp": at, "event_type": event, "detail": detail}


def write(tmp_path, rows, name="s1_diary.jsonl"):
    path = tmp_path / name
    path.write_text("".join(json.dumps(r) + "\n" for r in rows))
    return path


def intervals_of(tmp_path, rows):
    parsed, _ = read_rows(write(tmp_path, rows))
    return pair(parsed)


def by_name(intervals):
    return {i.name: i for i in intervals}


T0 = "2026-10-20T21:00:00+00:00"


def at(seconds):
    return f"2026-10-20T21:{int(seconds) // 60:02d}:{seconds % 60:09.6f}+00:00"


# -- reading ---------------------------------------------------------------------


def test_timestamps_parse_with_and_without_microseconds():
    assert parse_time("2026-10-20T21:00:05+00:00") == datetime(2026, 10, 20, 21, 0, 5)
    assert parse_time("2026-10-20T21:00:05.250000+00:00") == datetime(2026, 10, 20, 21, 0, 5, 250000)
    assert parse_time(None) is None


def test_rows_without_a_timestamp_and_exact_duplicates_are_counted_and_left_out(tmp_path):
    rows = [row("message_copied", T0, turn=1), row("message_copied", T0, turn=1), row("clicked", None)]
    parsed, skipped = read_rows(write(tmp_path, rows))
    assert len(parsed) == 1
    assert skipped == {"duplicate": 1, "no_timestamp": 1}


def test_a_folder_with_several_diaries_is_ambiguous(tmp_path):
    assert find_diary(tmp_path) is None
    write(tmp_path, [], "a_diary.jsonl")
    assert find_diary(tmp_path).name == "a_diary.jsonl"
    write(tmp_path, [], "b_diary.jsonl")
    assert find_diary(tmp_path) == "ambiguous"


# -- pairing -----------------------------------------------------------------------


def test_a_single_event_is_a_moment_under_its_own_name(tmp_path):
    (interval,) = intervals_of(tmp_path, [row("prompt_sent", T0, conversation_id="c1", turn=0, version=0)])
    assert interval.name == "prompt_sent" and interval.moment and interval.end == interval.start


def test_starts_and_ends_pair_on_their_detail_keys(tmp_path):
    rows = [
        row("response_generation_started", at(1), conversation_id="c1", turn=0, version=0),
        row("response_generation_started", at(2), conversation_id="c1", turn=0, version=1),
        row("response_generation_finished", at(5), conversation_id="c1", turn=0, version=1),
        row("response_generation_finished", at(9), conversation_id="c1", turn=0, version=0),
    ]
    spans = sorted((i.start.second, i.end.second) for i in intervals_of(tmp_path, rows))
    assert spans == [(1, 9), (2, 5)]


def test_scrolls_pair_per_pane_when_panes_interleave(tmp_path):
    rows = [
        row("scroll_started", at(1), conversation_id="c1", pane="main"),
        row("scroll_started", at(2), conversation_id="c1", pane="edit"),
        row("scroll_ended", at(3), conversation_id="c1", pane="main"),
        row("scroll_ended", at(6), conversation_id="c1", pane="edit"),
    ]
    spans = sorted((i.start.second, i.end.second) for i in intervals_of(tmp_path, rows))
    assert spans == [(1, 3), (2, 6)]


def test_read_aloud_closes_on_the_next_stop_whatever_turn_it_names(tmp_path):
    rows = [
        row("read_aloud_started", at(1), conversation_id="c1", turn=0, version=0),
        row("read_aloud_stopped", at(4), conversation_id="c1", turn=1, version=0),
    ]
    (interval,) = intervals_of(tmp_path, rows)
    assert interval.name == "read_aloud" and interval.detail["turn"] == 0 and interval.end.second == 4


def test_a_conversation_runs_to_its_last_end(tmp_path):
    rows = [
        row("conversation_started", at(0), conversation_id="c1"),
        row("conversation_ended", at(10), conversation_id="c1", reason="tab_closed"),
        row("conversation_ended", at(40), conversation_id="c1", reason="ended_by_participant"),
    ]
    (interval,) = intervals_of(tmp_path, rows)
    assert interval.name == "conversation" and interval.end.second == 40


def test_leaving_the_tab_is_one_off_tab_span(tmp_path):
    rows = [row("tab_blurred", at(3), conversation_id="c1"), row("tab_focused", at(8), conversation_id="c1")]
    (interval,) = intervals_of(tmp_path, rows)
    assert interval.name == "off_tab" and (interval.start.second, interval.end.second) == (3, 8)


def test_a_start_with_no_end_is_left_open_and_a_lone_end_is_a_moment(tmp_path):
    rows = [row("tab_blurred", at(3), conversation_id="c1"), row("scroll_ended", at(5), conversation_id="c1", pane="main")]
    found = by_name(intervals_of(tmp_path, rows))
    assert found["off_tab"].end is None
    assert found["scroll_ended"].moment


# -- placing on the timeline ---------------------------------------------------------


def test_with_zoom_start_times_each_event_lands_in_the_part_recording_then(tmp_path):
    parts = [FakePart(0.0, 60.0, datetime(2026, 10, 20, 21, 0, 0)), FakePart(60.0, 60.0, datetime(2026, 10, 20, 21, 5, 0))]
    rows = [row("prompt_sent", at(10)), row("message_copied", "2026-10-20T21:05:20+00:00"),
            row("text_copied", at(90))]  # 21:01:30, in the gap between the parts
    spans, skipped, anchor = place(intervals_of(tmp_path, rows), parts, 120.0, "d")
    assert anchor == "zoom_start"
    assert [(s["name"], s["start"], s["end"]) for s in spans] == [("prompt_sent", 10.0, 11.0), ("message_copied", 80.0, 81.0)]
    assert skipped == {"outside_recording": 1}


def test_an_open_start_runs_to_the_end_of_its_part_and_a_pair_is_cut_there(tmp_path):
    parts = [FakePart(0.0, 60.0, datetime(2026, 10, 20, 21, 0, 0)), FakePart(60.0, 60.0, datetime(2026, 10, 20, 21, 5, 0))]
    rows = [row("tab_blurred", at(50)), row("scroll_started", at(55), pane="main"),
            row("scroll_ended", "2026-10-20T21:05:10+00:00", pane="main")]
    spans, _, _ = place(intervals_of(tmp_path, rows), parts, 120.0, "d")
    assert {s["name"]: (s["start"], s["end"]) for s in spans} == {"off_tab": (50.0, 60.0), "scroll": (55.0, 60.0)}


def test_a_short_pair_is_widened_to_the_least_length(tmp_path):
    parts = [FakePart(0.0, 60.0, datetime(2026, 10, 20, 21, 0, 0))]
    rows = [row("prompt_typing_started", at(5), turn=0, version=0), row("prompt_typing_ended", at(5), turn=0, version=0)]
    (span,), _, _ = place(intervals_of(tmp_path, rows), parts, 60.0, "d")
    assert span["end"] - span["start"] == SINGLE_LENGTH


def test_without_zoom_start_times_the_first_event_is_placed_at_zero(tmp_path):
    parts = [FakePart(0.0, 30.0, None)]
    rows = [row("conversation_started", at(100), conversation_id="c1"), row("prompt_sent", at(110)), row("message_copied", at(200))]
    spans, skipped, anchor = place(intervals_of(tmp_path, rows), parts, 30.0, "d")
    assert anchor == "first_event"
    assert {s["name"]: (s["start"], s["end"]) for s in spans} == {"conversation": (0.0, 30.0), "prompt_sent": (10.0, 11.0)}
    assert skipped == {"outside_recording": 1}


def test_span_ids_depend_only_on_the_diary_and_its_lines(tmp_path):
    parts = [FakePart(0.0, 60.0, datetime(2026, 10, 20, 21, 0, 0))]
    rows = [row("prompt_sent", at(10))]
    first, _, _ = place(intervals_of(tmp_path, rows), parts, 60.0, "digest")
    again, _, _ = place(intervals_of(tmp_path, rows), parts, 60.0, "digest")
    other, _, _ = place(intervals_of(tmp_path, rows), parts, 60.0, "another")
    assert first[0]["id"] == again[0]["id"] != other[0]["id"]


def test_the_note_lists_detail_without_empty_values():
    assert note_text({"conversation_id": "c1", "turn": 2, "error": None, "text": ""}) == "conversation_id: c1 · turn: 2"
