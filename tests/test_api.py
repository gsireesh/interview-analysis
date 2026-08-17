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
