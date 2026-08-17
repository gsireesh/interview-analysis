import pytest
from fastapi.testclient import TestClient

from subtitle_search.app import create_app
from subtitle_search.session import RecordingError, RecordingRegistry, open_recording

from . import fixtures

# A tiny fake media payload -- Range serving is byte plumbing and does not care
# whether the bytes decode as audio.
MEDIA_BYTES = bytes(range(256)) * 40  # 10240 bytes


@pytest.fixture
def folder(tmp_path):
    (tmp_path / "meeting.vtt").write_text(fixtures.COLON_PREFIX, encoding="utf-8")
    (tmp_path / "meeting.mp4").write_bytes(MEDIA_BYTES)
    (tmp_path / "audio_only.m4a").write_bytes(b"x" * 100)
    return tmp_path


@pytest.fixture
def client(folder):
    registry = RecordingRegistry()
    registry.add_folder(folder)
    return TestClient(create_app(registry)), registry.default.id


def test_discovery_prefers_video_over_audio(folder):
    recording = open_recording(folder)

    assert recording.media_path(0).name == "meeting.mp4"
    assert recording.media_kind == "video"
    assert recording.store.path.name == "session.highlights.json"


def test_audio_only_folder(tmp_path):
    (tmp_path / "meeting.vtt").write_text(fixtures.COLON_PREFIX, encoding="utf-8")
    (tmp_path / "meeting.m4a").write_bytes(b"x" * 100)

    recording = open_recording(tmp_path)
    assert recording.media_kind == "audio"


def test_folder_without_vtt_is_an_error(tmp_path):
    (tmp_path / "meeting.mp4").write_bytes(b"x")
    with pytest.raises(RecordingError):
        open_recording(tmp_path)


def test_config_and_recording_payload(client):
    api, rec_id = client

    config = api.get("/api/config").json()
    assert config["default_recording_id"] == rec_id
    assert "amber" in config["colors"]

    payload = api.get(f"/api/recordings/{rec_id}").json()
    assert payload["media_kind"] == "video"
    assert payload["transcript"]["diagnostics"]["speakers"] == ["Dana Whitfield", "Rafael Ortiz"]
    assert len(payload["transcript"]["chunks"]) == 3
    assert payload["highlights"] == []


def test_unknown_recording_is_404(client):
    api, _ = client
    assert api.get("/api/recordings/deadbeef").status_code == 404


def test_search_endpoint(client):
    api, rec_id = client
    body = api.get(f"/api/recordings/{rec_id}/search", params={"q": "share my screen"}).json()

    assert body["results"]
    assert body["results"][0]["kind"] == "exact"


def test_invalid_regex_is_a_400(client):
    api, rec_id = client
    response = api.get(
        f"/api/recordings/{rec_id}/search", params={"q": "([unclosed", "mode": "regex"}
    )
    assert response.status_code == 400


def test_highlight_crud_round_trip(client, folder):
    api, rec_id = client
    base = f"/api/recordings/{rec_id}/highlights"

    created = api.post(
        base,
        json={
            "text": "so many buttons",
            "start_cue_id": "c2",
            "start_char_offset": 9,
            "end_cue_id": "c2",
            "end_char_offset": 24,
            "color": "teal",
            "tags": ["ui"],
        },
    )
    assert created.status_code == 201
    highlight = created.json()["highlight"]
    assert highlight["color"] == "teal"

    patched = api.patch(f"{base}/{highlight['id']}", json={"note": "worth quoting"})
    assert patched.json()["highlight"]["note"] == "worth quoting"

    # One quotes file for the whole session folder.
    assert (folder / "session.highlights.json").exists()

    listing = api.get(base).json()
    assert len(listing["highlights"]) == 1
    assert listing["known_tags"] == ["ui"]

    assert api.delete(f"{base}/{highlight['id']}").status_code == 200
    assert api.get(base).json()["highlights"] == []
    assert api.delete(f"{base}/{highlight['id']}").status_code == 404


def test_highlight_with_bad_anchor_is_a_400(client):
    api, rec_id = client
    response = api.post(
        f"/api/recordings/{rec_id}/highlights",
        json={"text": "nope", "start_cue_id": "c999", "end_cue_id": "c999"},
    )
    assert response.status_code == 400


def test_media_full_request(client):
    api, rec_id = client
    response = api.get(f"/api/recordings/{rec_id}/media")

    assert response.status_code == 200
    assert response.headers["accept-ranges"] == "bytes"
    assert response.content == MEDIA_BYTES


def test_media_range_returns_exact_bytes(client):
    api, rec_id = client
    response = api.get(
        f"/api/recordings/{rec_id}/media", headers={"Range": "bytes=100-199"}
    )

    assert response.status_code == 206
    assert response.headers["content-range"] == f"bytes 100-199/{len(MEDIA_BYTES)}"
    assert response.headers["content-length"] == "100"
    assert response.content == MEDIA_BYTES[100:200]


def test_media_open_ended_and_suffix_ranges(client):
    api, rec_id = client
    total = len(MEDIA_BYTES)

    open_ended = api.get(f"/api/recordings/{rec_id}/media", headers={"Range": "bytes=10000-"})
    assert open_ended.status_code == 206
    assert open_ended.content == MEDIA_BYTES[10000:]

    suffix = api.get(f"/api/recordings/{rec_id}/media", headers={"Range": "bytes=-50"})
    assert suffix.status_code == 206
    assert suffix.content == MEDIA_BYTES[total - 50:]


def test_media_unsatisfiable_range_is_416(client):
    api, rec_id = client
    response = api.get(
        f"/api/recordings/{rec_id}/media", headers={"Range": "bytes=999999-1000000"}
    )

    assert response.status_code == 416
    assert response.headers["content-range"] == f"bytes */{len(MEDIA_BYTES)}"


def test_index_is_served(client):
    api, _ = client
    response = api.get("/")
    assert response.status_code == 200
    assert "<title>" in response.text


def test_split_route_divides_a_caption_and_returns_the_session(client):
    api, rec_id = client
    text = "I can see it. Looks good on my end."

    response = api.post(
        f"/api/recordings/{rec_id}/cues/c3/split",
        json={"offset": text.index("Looks"), "text": text},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["cue_ids"] == ["c3", "c4"]

    cues = {cue["id"]: cue["text"] for cue in body["recording"]["transcript"]["cues"]}
    assert cues["c3"] == "I can see it."
    assert cues["c4"] == "Looks good on my end."
    assert cues["c5"] == "Great, thanks for confirming."


def test_split_route_rejects_a_cut_with_nothing_on_one_side(client):
    api, rec_id = client
    response = api.post(f"/api/recordings/{rec_id}/cues/c3/split", json={"offset": 0})
    assert response.status_code == 400
    assert "both sides" in response.json()["detail"]


# -- measuring word timings ---------------------------------------------


def fake_aligner(monkeypatch, per_word=0.2, gap=0.05):
    """Stand in for the acoustic model: lay each word out at a fixed rate.

    The route's job is batching, storing and reporting, none of which needs real
    audio -- and a test that downloaded half a gigabyte of weights would not run.
    """
    import subtitle_search.alignment as engine
    from subtitle_search.timings import TimedWord, split_words

    def align_cues(media_path, targets, base):
        measured = []
        for cue, first in targets:
            at = cue.start - base
            for n, (_, _, word) in enumerate(split_words(cue.text)):
                measured.append(
                    TimedWord(first + n, engine.normalize_word(word), at, at + per_word)
                )
                at += per_word + gap  # real speech leaves silence between words
        return measured

    monkeypatch.setattr(engine, "align_cues", align_cues)


def test_alignment_state_reports_availability_and_coverage(client):
    api, rec_id = client
    body = api.get(f"/api/recordings/{rec_id}/alignment").json()
    assert set(body) == {"available", "reason", "coverage"}
    assert body["coverage"] == {"timed": 0, "total": 5, "complete": False}


def test_align_measures_a_batch_and_reports_what_is_left(client, monkeypatch):
    api, rec_id = client
    fake_aligner(monkeypatch)

    first = api.post(f"/api/recordings/{rec_id}/align", json={"limit": 2}).json()
    assert first["captions"] == 2
    assert first["coverage"]["timed"] == 2
    assert first["remaining"] == 3

    rest = api.post(f"/api/recordings/{rec_id}/align", json={"limit": 100}).json()
    assert rest["coverage"] == {"timed": 5, "total": 5, "complete": True}
    assert rest["remaining"] == 0


def test_align_can_be_pointed_at_named_captions(client, monkeypatch):
    api, rec_id = client
    fake_aligner(monkeypatch)

    body = api.post(f"/api/recordings/{rec_id}/align", json={"cue_ids": ["c3"]}).json()
    assert body["coverage"]["timed"] == 1

    cues = api.get(f"/api/recordings/{rec_id}").json()["transcript"]["cues"]
    assert [c["id"] for c in cues if c["timed"]] == ["c3"]


def test_measured_times_reach_the_reader(client, monkeypatch):
    api, rec_id = client
    fake_aligner(monkeypatch)
    api.post(f"/api/recordings/{rec_id}/align", json={"cue_ids": ["c3"]})

    # c3 runs 23.1 to 27.4 and reads "I can see it. Looks good on my end." The
    # stub strides 0.25s per word, so 'Looks' -- the fifth -- starts a second in.
    # Interpolation put it at 14/35 of a 4.3s caption: nearly a second later.
    quote = api.post(
        f"/api/recordings/{rec_id}/highlights",
        json={
            "text": "Looks good",
            "start_cue_id": "c3",
            "start_char_offset": 14,
            "end_cue_id": "c3",
            "end_char_offset": 24,
        },
    ).json()["highlight"]
    assert quote["start_time"] == pytest.approx(24.1, abs=0.01)


def test_align_reports_when_it_cannot_run(client, monkeypatch):
    api, rec_id = client
    import subtitle_search.app as app_module

    monkeypatch.setattr(app_module, "alignment_available", lambda: (False, "no ffmpeg here"))
    response = api.post(f"/api/recordings/{rec_id}/align", json={})
    assert response.status_code == 503
    assert response.json()["detail"] == "no ffmpeg here"


def test_a_split_measures_the_caption_it_is_about_to_cut(client, monkeypatch):
    api, rec_id = client
    fake_aligner(monkeypatch)
    text = "I can see it. Looks good on my end."

    body = api.post(
        f"/api/recordings/{rec_id}/cues/c3/split",
        json={"offset": text.index("Looks"), "text": text},
    ).json()
    # Nothing was measured beforehand: the split asked for that one caption.
    assert body["measured"] is True
    assert body["at"] < body["tail_at"]


def test_merge_route_joins_captions_and_returns_the_session(client):
    api, rec_id = client
    body = api.post(
        f"/api/recordings/{rec_id}/cues/c0/merge", json={"through": "c1"}
    ).json()
    assert body["joined"] == 2
    assert body["cue_id"] == "c0"

    cues = {c["id"]: c["text"] for c in body["recording"]["transcript"]["cues"]}
    assert cues["c0"].startswith("Cool. And then I will share my screen")
    assert cues["c0"].endswith("So, let me share my screen.")
    assert len(cues) == 4


def test_a_split_can_be_undone_over_the_api(client):
    api, rec_id = client
    text = "I can see it. Looks good on my end."

    split = api.post(
        f"/api/recordings/{rec_id}/cues/c3/split",
        json={"offset": text.index("Looks"), "text": text, "align": False},
    ).json()
    undone = api.post(
        f"/api/recordings/{rec_id}/cues/{split['cue_ids'][0]}/merge",
        json={"through": split["cue_ids"][1], "expect": split["halves"]},
    ).json()

    cues = {c["id"]: c["text"] for c in undone["recording"]["transcript"]["cues"]}
    assert cues["c3"] == text
    assert len(cues) == 5


def test_undo_over_the_api_refuses_stale_expectations(client):
    api, rec_id = client
    response = api.post(
        f"/api/recordings/{rec_id}/cues/c0/merge",
        json={"through": "c1", "expect": ["something else", "entirely"]},
    )
    assert response.status_code == 400
    assert "changed since then" in response.json()["detail"]
