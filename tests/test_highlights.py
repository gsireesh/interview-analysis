import json

import pytest

from subtitle_search.highlights import HighlightError, HighlightStore
from subtitle_search.vtt import parse_vtt

from . import fixtures


@pytest.fixture
def store(tmp_path):
    transcript = parse_vtt(fixtures.COLON_PREFIX, source_name="talk.vtt")
    return HighlightStore(tmp_path / "talk.highlights.json", transcript)


def _payload(**overrides):
    base = {
        "text": "share my screen briefly",
        "start_cue_id": "c0",
        "start_char_offset": 27,
        "end_cue_id": "c0",
        "end_char_offset": 50,
        "color": "amber",
        "note": "good framing",
        "tags": ["demo", "intro"],
    }
    base.update(overrides)
    return base


def test_create_resolves_times_from_cue_anchors(store):
    highlight = store.create(_payload())
    cue = store.transcript.cue("c0")

    assert cue.start <= highlight["start_time"] <= highlight["end_time"] <= cue.end
    # Anchored partway into a 10s cue, so it should not collapse to the cue start.
    assert highlight["start_time"] > cue.start
    assert highlight["speaker"] == "Dana Whitfield"


def test_create_persists_to_disk_immediately(store):
    store.create(_payload())

    data = json.loads(store.path.read_text())
    assert len(data["highlights"]) == 1
    assert data["highlights"][0]["note"] == "good framing"
    assert data["vtt_file"] == "talk.vtt"
    assert data["vtt_sha256"] == store.transcript.sha256


def test_selection_spanning_cues_gets_a_range(store):
    highlight = store.create(
        _payload(start_cue_id="c0", start_char_offset=10, end_cue_id="c2", end_char_offset=20)
    )

    assert highlight["start_time"] < highlight["end_time"]
    assert highlight["end_time"] > store.transcript.cue("c1").start


def test_reversed_selection_is_normalized(store):
    """Selecting right-to-left must not produce an inverted time range."""
    highlight = store.create(
        _payload(start_cue_id="c2", start_char_offset=5, end_cue_id="c0", end_char_offset=5)
    )

    assert highlight["start_cue_id"] == "c0"
    assert highlight["end_cue_id"] == "c2"
    assert highlight["start_time"] <= highlight["end_time"]


def test_empty_selection_is_rejected(store):
    with pytest.raises(HighlightError):
        store.create(_payload(text="   "))


def test_unknown_cue_is_rejected(store):
    with pytest.raises(HighlightError):
        store.create(_payload(start_cue_id="c999"))


def test_update_and_delete(store):
    highlight = store.create(_payload())

    updated = store.update(highlight["id"], {"note": "revised", "color": "teal", "tags": ["key"]})
    assert updated["note"] == "revised"
    assert updated["color"] == "teal"
    assert updated["tags"] == ["key"]

    assert store.delete(highlight["id"]) is True
    assert store.list() == []
    assert store.delete(highlight["id"]) is False


def test_invalid_color_falls_back_to_default(store):
    highlight = store.create(_payload(color="chartreuse"))
    assert highlight["color"] == "amber"


def test_known_tags_accumulate(store):
    store.create(_payload(tags=["demo"]))
    store.create(_payload(tags=["pain-point", "demo"]))

    assert store.known_tags() == ["demo", "pain-point"]


def test_unknown_fields_survive_a_round_trip(tmp_path):
    """A file written by a later version must not be silently stripped."""
    transcript = parse_vtt(fixtures.COLON_PREFIX, source_name="talk.vtt")
    path = tmp_path / "talk.highlights.json"
    path.write_text(
        json.dumps(
            {
                "version": 99,
                "vtt_sha256": transcript.sha256,
                "future_top_level_field": {"keep": "me"},
                "known_tags": [],
                "highlights": [
                    {
                        "id": "abc123",
                        "text": "an existing quote",
                        "start_cue_id": "c0",
                        "end_cue_id": "c0",
                        "start_char_offset": 0,
                        "end_char_offset": 10,
                        "start_time": 2.18,
                        "end_time": 3.0,
                        "future_field": "preserved",
                    }
                ],
            }
        )
    )

    store = HighlightStore(path, transcript)
    store.update("abc123", {"note": "added later"})

    data = json.loads(path.read_text())
    assert data["future_top_level_field"] == {"keep": "me"}
    assert data["highlights"][0]["future_field"] == "preserved"
    assert data["highlights"][0]["note"] == "added later"


def test_stale_detection_when_transcript_changed(tmp_path):
    transcript = parse_vtt(fixtures.COLON_PREFIX, source_name="talk.vtt")
    path = tmp_path / "talk.highlights.json"

    store = HighlightStore(path, transcript)
    store.create(_payload())
    assert store.stale is False

    other = parse_vtt(fixtures.VOICE_TAG, source_name="talk.vtt")
    assert HighlightStore(path, other).stale is True


def test_corrupt_file_is_preserved_not_overwritten(tmp_path):
    transcript = parse_vtt(fixtures.COLON_PREFIX, source_name="talk.vtt")
    path = tmp_path / "talk.highlights.json"
    path.write_text("{not valid json at all")

    store = HighlightStore(path, transcript)
    store.create(_payload())

    assert (tmp_path / "talk.highlights.json.corrupt").read_text() == "{not valid json at all"
    assert len(store.list()) == 1


def test_write_leaves_no_temp_files_behind(store, tmp_path):
    store.create(_payload())
    store.create(_payload(text="another quote"))

    assert sorted(p.name for p in tmp_path.iterdir()) == ["talk.highlights.json"]
