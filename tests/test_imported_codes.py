"""Imported video codes: importing a diary, the shared offset, and moving them to common and back."""

import json

import pytest
from fastapi.testclient import TestClient

from subtitle_search.app import create_app
from subtitle_search.common import IMPORTED, move_code, return_code
from subtitle_search.session import RecordingRegistry

# Two minutes of transcript, so the recording runs 0-121 s (last cue end plus one second's tail).
VTT = """WEBVTT

1
00:00:01.000 --> 00:00:05.000
Ann: Hello there.

2
00:01:55.000 --> 00:02:00.000
Ann: Goodbye.
"""
ZOOM_VTT = "GMT20261020-210000_Recording.transcript.vtt"


def row(event, at, **detail):
    return {"session_id": "s1", "timestamp": at, "event_type": event, "detail": detail}


DIARY = [
    row("prompt_sent", "2026-10-20T21:00:10+00:00", conversation_id="c1", turn=0, version=0),
    row("message_copied", "2026-10-20T21:00:20.500000+00:00", conversation_id="c1", turn=0, version=0),
    row("tab_blurred", "2026-10-20T21:00:30+00:00", conversation_id="c1"),
    row("tab_focused", "2026-10-20T21:00:40+00:00", conversation_id="c1"),
    row("clicked", None, conversation_id="c1"),
]


def write_diary(folder, rows=DIARY, name="s1_diary.jsonl"):
    (folder / name).write_text("".join(json.dumps(r) + "\n" for r in rows))


@pytest.fixture
def study(tmp_path):
    """A study of two Zoom recordings, each with a diary, and two coders."""
    for name in ("p1", "p2"):
        folder = tmp_path / name
        folder.mkdir()
        (folder / ZOOM_VTT).write_text(VTT)
        write_diary(folder)
    registry = RecordingRegistry()
    registry.add_library(tmp_path)
    ann = registry.coders.create("Ann Lee", "AL")["id"]
    ben = registry.coders.create("Ben Ode", "BO")["id"]
    return registry, ann, ben


def imported_spans(recording):
    return [s for s in recording.video_codes.list() if s["coder"] == IMPORTED]


def names(registry, recording):
    return sorted(registry.books.imported_video.get(s["code_id"])["name"] for s in imported_spans(recording))


def import_all(registry, coder):
    for recording in registry.list():
        recording.imported.import_diary(coder, registry.books.imported_video, recording.transcript)


# -- importing ---------------------------------------------------------------------


def test_a_diary_waits_until_a_coder_imports_it(study):
    registry, ann, _ = study
    recording = registry.default
    assert recording.imported.status()["status"] == "pending"
    assert imported_spans(recording) == []

    status = recording.imported.import_diary(ann, registry.books.imported_video, recording.transcript)

    assert status["status"] == "imported" and status["anchor"] == "zoom_start"
    assert status["imported"] == 3 and status["skipped"] == {"no_timestamp": 1}
    assert names(registry, recording) == ["message_copied", "off_tab", "prompt_sent"]
    times = {registry.books.imported_video.get(s["code_id"])["name"]: (s["start"], s["end"]) for s in imported_spans(recording)}
    assert times == {"prompt_sent": (10.0, 11.0), "message_copied": (20.5, 21.5), "off_tab": (30.0, 40.0)}


def test_a_recording_is_imported_once_even_if_the_diary_changes(study):
    registry, ann, ben = study
    recording = registry.default
    recording.imported.import_diary(ann, registry.books.imported_video, recording.transcript)
    write_diary(recording.folder, DIARY + [row("message_rated", "2026-10-20T21:00:50+00:00", rating="up")])

    recording.imported.import_diary(ben, registry.books.imported_video, recording.transcript)
    registry.refresh()

    assert len(imported_spans(registry.default)) == 3


def test_two_coders_importing_at_once_write_the_same_records(study, tmp_path):
    registry, ann, ben = study
    # Ben's tool opened the study before Ann's import synced to it.
    other = RecordingRegistry()
    other.add_library(tmp_path)
    registry.default.imported.import_diary(ann, registry.books.imported_video, registry.default.transcript)
    theirs = other.default
    theirs.imported.import_diary(ben, other.books.imported_video, theirs.transcript)

    registry.refresh()

    assert len(imported_spans(registry.default)) == 3
    assert len(registry.books.imported_video.list()) == 3


def test_several_diaries_in_one_folder_import_nothing(study):
    registry, _, _ = study
    recording = registry.default
    write_diary(recording.folder, name="s2_diary.jsonl")
    assert recording.imported.status()["status"] == "ambiguous"


# -- the offset ---------------------------------------------------------------------


def test_the_offset_shifts_the_row_and_hides_spans_pushed_outside(study):
    registry, ann, ben = study
    recording = registry.default
    recording.imported.import_diary(ann, registry.books.imported_video, recording.transcript)

    recording.imported.set_offset(ben, -10.5)

    starts = sorted(s["start"] for s in imported_spans(recording))
    assert starts == [0.0, 10.0, 19.5]  # prompt_sent clipped at the start, the others shifted
    recording.imported.set_offset(ben, -12)
    assert recording.imported.status()["hidden"] == 1


# -- moving to common and back ------------------------------------------------------------


def test_any_coder_moves_an_imported_code_with_its_spans_in_every_recording(study):
    registry, ann, ben = study
    import_all(registry, ann)
    code_id = registry.books.imported_video.find("prompt_sent")["id"]

    summary = move_code(registry, "video", ben, code_id, final=True)

    assert summary["moved"] == 2 and summary["recordings"] == 2
    common = registry.books.common_video.find("prompt_sent")
    for recording in registry.list():
        assert "prompt_sent" not in names(registry, recording)
        (span,) = [s for s in recording.common_spans.list() if s["code_id"] == common["id"]]
        assert span["contributors"] == [IMPORTED] and (span["start"], span["end"]) == (10.0, 11.0)
    assert registry.books.imported_video.moved() == {code_id: common["id"]}


def test_returning_puts_imported_spans_back_in_the_imported_row(study):
    registry, ann, ben = study
    import_all(registry, ann)
    code_id = registry.books.imported_video.find("prompt_sent")["id"]
    move_code(registry, "video", ben, code_id, final=True)
    registry.default.imported.set_offset(ann, 2.0)
    common = registry.books.common_video.find("prompt_sent")

    return_code(registry, "video", ann, common["id"])

    for recording in registry.list():
        assert "prompt_sent" in names(registry, recording)
        assert recording.returns.list() == []
    (span,) = [s for s in imported_spans(registry.default)
               if registry.books.imported_video.get(s["code_id"])["name"] == "prompt_sent"]
    assert (span["start"], span["end"]) == (10.0, 11.0)  # shown where it was moved from, under the current offset


# -- through the API -----------------------------------------------------------------------


@pytest.fixture
def api(study):
    registry, ann, ben = study
    app = create_app(registry)
    return registry, TestClient(app, headers={"X-Coder": ann}), TestClient(app, headers={"X-Coder": ben})


def test_the_reader_is_told_a_diary_is_waiting_and_imports_it(api):
    registry, ann, _ = api
    rid = registry.default.id
    assert ann.get(f"/api/recordings/{rid}").json()["imported"]["status"] == "pending"

    body = ann.post(f"/api/recordings/{rid}/imported/import").json()

    assert body["imported"]["status"] == "imported"
    assert {s["coder"] for s in body["spans"]} == {IMPORTED}


def test_importing_needs_a_coder(api):
    registry, ann, _ = api
    anonymous = TestClient(ann.app)
    assert anonymous.post(f"/api/recordings/{registry.default.id}/imported/import").status_code == 401


def test_imported_spans_and_codes_are_read_only(api):
    registry, ann, _ = api
    rid = registry.default.id
    span = ann.post(f"/api/recordings/{rid}/imported/import").json()["spans"][0]

    assert ann.patch(f"/api/recordings/{rid}/video-codes/{span['id']}", json={"note": "x"}).status_code == 403
    assert ann.delete(f"/api/recordings/{rid}/video-codes/{span['id']}").status_code == 403
    assert ann.patch(f"/api/library/video-codebook/{span['code_id']}", json={"name": "y"}).status_code == 403


def test_the_offset_is_shared_through_the_api(api):
    registry, ann, ben = api
    rid = registry.default.id
    ann.post(f"/api/recordings/{rid}/imported/import")

    body = ben.put(f"/api/recordings/{rid}/imported/offset", json={"seconds": 1.5}).json()

    assert body["imported"]["offset"] == 1.5
    assert ann.get(f"/api/recordings/{rid}/video-codes").json()["imported"]["offset"] == 1.5
    assert ann.put(f"/api/recordings/{rid}/imported/offset", json={"seconds": "soon"}).status_code == 400


def test_the_codebook_lists_imported_codes_and_their_spans(api):
    registry, ann, _ = api
    rid = registry.default.id
    ann.post(f"/api/recordings/{rid}/imported/import")

    codes = [c for c in ann.get("/api/library/video-codebook").json()["codes"] if c["coder"] == IMPORTED]
    assert sorted(c["name"] for c in codes) == ["message_copied", "off_tab", "prompt_sent"]
    prompt = next(c for c in codes if c["name"] == "prompt_sent")
    applications = ann.get(f"/api/library/video-codebook/{prompt['id']}/applications").json()["applications"]
    assert [a["coder"] for a in applications] == [IMPORTED]


def test_a_coder_copies_an_imported_span_into_their_own_row(api):
    registry, ann, _ = api
    rid = registry.default.id
    span = next(s for s in ann.post(f"/api/recordings/{rid}/imported/import").json()["spans"] if s["note"])
    mine = ann.post("/api/library/video-codebook", json={"name": "prompt_sent"}).json()["code"]

    copy = ann.post(f"/api/recordings/{rid}/video-codes",
                    json={"code_id": mine["id"], "start": span["start"], "end": span["end"], "note": span["note"]}).json()["span"]

    assert copy["coder"] != IMPORTED
    assert ann.patch(f"/api/recordings/{rid}/video-codes/{copy['id']}", json={"note": "mine now"}).status_code == 200


def test_any_coder_can_move_an_imported_code_and_themes_follow_it(api):
    registry, ann, ben = api
    for recording in registry.list():
        ann.post(f"/api/recordings/{recording.id}/imported/import")
    code_id = registry.books.imported_video.find("off_tab")["id"]
    theme = ann.post("/api/library/themes", json={"title": "Distraction"}).json()["theme"]
    ann.post("/api/library/themes/assign", json={"ref": f"video:{code_id}", "theme_id": theme["id"]})

    assert ben.post(f"/api/library/video-codebook/{code_id}/move", json={"final": True}).status_code == 200

    common = registry.books.common_video.find("off_tab")
    themes = ann.get("/api/library/themes").json()["themes"]
    assert next(t for t in themes if t["id"] == theme["id"])["refs"] == [f"video:{common['id']}"]
