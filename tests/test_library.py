"""The library: many recordings at once, and the themes built across them."""

import json

import pytest
from fastapi.testclient import TestClient

from subtitle_search.app import create_app
from subtitle_search.library import (
    THEMES_FILENAME,
    ThemeStore,
    all_quotes,
    cooccurrence,
    tag_index,
    untagged,
)
from subtitle_search.session import RecordingRegistry, find_recordings

from .test_session import write_mp4

TRANSCRIPT = """WEBVTT

1
00:00:01.000 --> 00:00:06.000
Dana Whitfield: Tell me how you handle transcripts today.

2
00:00:07.000 --> 00:00:13.000
Rafael Ortiz: I read the whole thing, then hunt for where the quote actually is.

3
00:00:14.000 --> 00:00:20.000
Dana Whitfield: And does privacy come into it?

4
00:00:21.000 --> 00:00:27.000
Rafael Ortiz: Constantly. These are participant recordings.
"""


def quote(index: int, tags: list[str], color: str = "amber") -> dict:
    return {
        "id": f"q{index}",
        "text": f"quote number {index}",
        "color": color,
        "note": "",
        "tags": tags,
        "start_cue_id": "c1",
        "end_cue_id": "c1",
        "start_char_offset": 0,
        "end_char_offset": 10,
        "start_time": 7.0 + index,
        "end_time": 12.0 + index,
        "speaker": "Rafael Ortiz",
    }


def make_recording(root, name: str, quotes: list[dict] | None = None, media: bool = True):
    folder = root / name
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "session.vtt").write_text(TRANSCRIPT, encoding="utf-8")
    if media:
        write_mp4(folder / "session.mp4", 120)
    if quotes is not None:
        (folder / "session.highlights.json").write_text(
            json.dumps({"version": 1, "known_tags": [], "highlights": quotes})
        )
    return folder


@pytest.fixture
def library(tmp_path):
    root = tmp_path / "study"
    make_recording(root, "P01", [quote(1, ["trust"]), quote(2, ["timestamps", "tone"])])
    make_recording(root, "P02", [quote(3, ["timestamps"]), quote(4, [])])
    make_recording(root, "P03", [quote(5, ["trust", "timestamps"])])
    return root


@pytest.fixture
def client(library):
    registry = RecordingRegistry()
    registry.add_library(library)
    return TestClient(create_app(registry)), registry


# -- discovery ---------------------------------------------------------


def test_a_folder_of_folders_is_a_library(library):
    found = find_recordings(library)
    assert [p.name for p in found] == ["P01", "P02", "P03"]


def test_a_folder_holding_a_transcript_is_itself_the_recording(library):
    """Pointing at one recording must not be read as a library of one."""
    found = find_recordings(library / "P01")
    assert found == [library / "P01"]


def test_folders_without_transcripts_are_not_recordings(tmp_path):
    root = tmp_path / "study"
    make_recording(root, "P01", [])
    (root / "notes").mkdir()
    (root / "notes" / "scratch.txt").write_text("nothing here")

    assert [p.name for p in find_recordings(root)] == ["P01"]


def test_one_unreadable_folder_does_not_sink_the_library(tmp_path):
    root = tmp_path / "study"
    make_recording(root, "P01", [])
    broken = root / "P02"
    broken.mkdir()
    (broken / "session.vtt").write_text("this is not a transcript at all")

    registry = RecordingRegistry()
    registry.add_library(root)

    assert [r.title for r in registry.list()] == ["P01"]
    assert registry.failures and registry.failures[0][0] == "P02"


def test_a_single_recording_is_not_a_library(tmp_path):
    root = tmp_path / "study"
    folder = make_recording(root, "P01", [])
    registry = RecordingRegistry()
    registry.add_library(folder)
    assert registry.is_library is False


# -- aggregation -------------------------------------------------------


def test_quotes_carry_where_they_came_from(client):
    _, registry = client
    quotes = all_quotes(registry)

    assert len(quotes) == 5
    assert all(":" in q["ref"] for q in quotes)
    assert {q["recording_title"] for q in quotes} == {"P01", "P02", "P03"}


def test_tag_index_counts_recordings_not_just_quotes(client):
    """A tag on many quotes from one person is not the same as a shared theme."""
    _, registry = client
    tags = {entry["tag"]: entry for entry in tag_index(all_quotes(registry))}

    assert tags["timestamps"]["quote_count"] == 3
    assert tags["timestamps"]["recording_count"] == 3
    assert tags["tone"]["quote_count"] == 1
    assert tags["tone"]["recording_count"] == 1


def test_tags_are_ordered_by_how_widely_they_are_shared(client):
    _, registry = client
    order = [entry["tag"] for entry in tag_index(all_quotes(registry))]
    assert order[0] == "timestamps"  # in 3 recordings
    assert order.index("trust") < order.index("tone")


def test_cooccurrence_finds_tags_sharing_a_quote(client):
    _, registry = client
    pairs = cooccurrence(all_quotes(registry))
    found = {(p["a"], p["b"]): p for p in pairs}

    assert ("timestamps", "tone") in found
    assert ("timestamps", "trust") in found
    assert found[("timestamps", "tone")]["count"] == 1
    assert ("trust", "tone") not in found  # never on the same quote


def test_untagged_quotes_are_findable(client):
    _, registry = client
    assert [q["id"] for q in untagged(all_quotes(registry))] == ["q4"]


# -- the API -----------------------------------------------------------


def test_library_endpoint(client):
    api, _ = client
    body = api.get("/api/library").json()

    assert body["is_library"] is True
    assert len(body["recordings"]) == 3
    assert body["quote_count"] == 5
    assert body["untagged_count"] == 1
    assert body["recordings"][0]["parts"]  # so a quote can be played elsewhere


def test_search_spans_every_transcript(client):
    api, _ = client
    body = api.get("/api/library/search", params={"q": "participant recordings"}).json()

    assert body["results"]
    assert {hit["recording_title"] for hit in body["results"]} == {"P01", "P02", "P03"}


def test_library_page_is_served_for_many_recordings(client):
    api, _ = client
    assert "Library" in api.get("/").text
    assert "<title>Themes</title>" in api.get("/themes").text
    assert "id=\"transcript\"" in api.get("/reader").text


def test_the_home_page_is_the_library_even_for_one_recording(tmp_path):
    """One entry point beats a home page that changes shape with the folder count."""
    root = tmp_path / "study"
    folder = make_recording(root, "P01", [])
    registry = RecordingRegistry()
    registry.add_library(folder)

    home = TestClient(create_app(registry)).get("/").text
    assert "<title>Library</title>" in home
    assert 'id="transcript"' not in home


# -- themes ------------------------------------------------------------


def test_theme_round_trip(client, library):
    api, _ = client
    created = api.post("/api/library/themes", json={"title": "Losing the recording"})
    assert created.status_code == 201
    theme = created.json()["theme"]

    quotes = api.get("/api/library/quotes").json()["quotes"]
    ref = quotes[0]["ref"]

    api.post("/api/library/themes/assign", json={"ref": ref, "theme_id": theme["id"]})
    listing = api.get("/api/library/themes").json()

    assert listing["themes"][0]["refs"] == [ref]
    assert listing["placed"] == [ref]
    # Themes live beside the recordings, not inside any one of them.
    assert (library / THEMES_FILENAME).exists()


def test_a_quote_belongs_to_one_theme_at_a_time(client):
    """The board's whole point is forcing the decision a tag list defers."""
    api, _ = client
    first = api.post("/api/library/themes", json={"title": "One"}).json()["theme"]
    second = api.post("/api/library/themes", json={"title": "Two"}).json()["theme"]
    ref = api.get("/api/library/quotes").json()["quotes"][0]["ref"]

    api.post("/api/library/themes/assign", json={"ref": ref, "theme_id": first["id"]})
    body = api.post(
        "/api/library/themes/assign", json={"ref": ref, "theme_id": second["id"]}
    ).json()

    by_id = {t["id"]: t for t in body["themes"]}
    assert by_id[first["id"]]["refs"] == []
    assert by_id[second["id"]]["refs"] == [ref]


def test_assigning_to_no_theme_returns_a_quote_to_unsorted(client):
    api, _ = client
    theme = api.post("/api/library/themes", json={"title": "One"}).json()["theme"]
    ref = api.get("/api/library/quotes").json()["quotes"][0]["ref"]

    api.post("/api/library/themes/assign", json={"ref": ref, "theme_id": theme["id"]})
    api.post("/api/library/themes/assign", json={"ref": ref, "theme_id": None})

    assert api.get("/api/library/themes").json()["placed"] == []


def test_renaming_and_deleting_a_theme(client):
    api, _ = client
    theme = api.post("/api/library/themes", json={}).json()["theme"]
    assert theme["title"] == "Untitled theme"

    renamed = api.patch(f"/api/library/themes/{theme['id']}", json={"title": "Trust", "note": "why"})
    assert renamed.json()["theme"]["title"] == "Trust"
    assert renamed.json()["theme"]["note"] == "why"

    assert api.delete(f"/api/library/themes/{theme['id']}").status_code == 200
    assert api.get("/api/library/themes").json()["themes"] == []
    assert api.delete(f"/api/library/themes/{theme['id']}").status_code == 404


def test_a_theme_referring_to_a_deleted_quote_is_pruned(tmp_path):
    """A quote deleted in the reader must not leave a hole nothing accounts for."""
    root = tmp_path / "study"
    make_recording(root, "P01", [quote(1, ["trust"])])
    registry = RecordingRegistry()
    registry.add_library(root)
    api = TestClient(create_app(registry))

    theme = api.post("/api/library/themes", json={"title": "T"}).json()["theme"]
    ref = api.get("/api/library/quotes").json()["quotes"][0]["ref"]
    api.post("/api/library/themes/assign", json={"ref": ref, "theme_id": theme["id"]})

    recording = registry.list()[0]
    recording.store.delete("q1")

    assert api.get("/api/library/themes").json()["themes"][0]["refs"] == []


def test_themes_survive_a_reload(tmp_path, library):
    store = ThemeStore(library / THEMES_FILENAME)
    theme = store.create("Kept")
    store.assign("rec:q1", theme["id"])

    reopened = ThemeStore(library / THEMES_FILENAME)
    assert [t["title"] for t in reopened.list()] == ["Kept"]
    assert reopened.placed_refs() == {"rec:q1"}


def test_unknown_fields_in_the_themes_file_survive(tmp_path):
    path = tmp_path / THEMES_FILENAME
    path.write_text(
        json.dumps(
            {
                "version": 99,
                "future_field": {"keep": "me"},
                "themes": [{"id": "t1", "title": "Kept", "refs": ["a:b"], "future": 1}],
            }
        )
    )

    store = ThemeStore(path)
    store.update("t1", {"note": "added"})

    data = json.loads(path.read_text())
    assert data["future_field"] == {"keep": "me"}
    assert data["themes"][0]["future"] == 1


def test_assigning_to_an_unknown_theme_is_a_404(client):
    api, _ = client
    ref = api.get("/api/library/quotes").json()["quotes"][0]["ref"]
    assert api.post(
        "/api/library/themes/assign", json={"ref": ref, "theme_id": "nope"}
    ).status_code == 404


def test_assigning_without_a_reference_is_a_400(client):
    api, _ = client
    assert api.post("/api/library/themes/assign", json={}).status_code == 400


# -- the tag vocabulary ------------------------------------------------


def test_vocabulary_spans_every_recording(client):
    """The point of it: a tag coined in P01 is offered while tagging in P03."""
    api, registry = client
    from subtitle_search.library import vocabulary

    tags = {entry["tag"]: entry for entry in vocabulary(registry)}
    assert set(tags) == {"trust", "timestamps", "tone"}
    assert tags["timestamps"]["recording_count"] == 3
    assert tags["timestamps"]["quote_count"] == 3
    assert tags["tone"]["recording_count"] == 1


def test_vocabulary_is_ordered_by_how_established_a_tag_is(client):
    api, registry = client
    from subtitle_search.library import vocabulary

    order = [entry["tag"] for entry in vocabulary(registry)]
    assert order[0] == "timestamps"  # in every recording
    assert order.index("trust") < order.index("tone")


def test_vocabulary_keeps_a_tag_whose_quotes_all_lost_it(client):
    """Otherwise a code you stopped using stops being suggested, and gets
    reinvented under a new name a fortnight later."""
    api, registry = client
    from subtitle_search.library import vocabulary

    recording = next(r for r in registry.list() if r.title == "P01")
    quote = recording.store.list()[0]

    # Applied through the store, which is what records it as history.
    recording.store.update(quote["id"], {"tags": ["provisional"]})
    recording.store.update(quote["id"], {"tags": []})

    entry = next((e for e in vocabulary(registry) if e["tag"] == "provisional"), None)
    assert entry is not None, "a tag used once should stay in the vocabulary"
    assert entry["quote_count"] == 0
    assert entry["recording_count"] == 0

    # And it is still offered while typing, unlike the filter list.
    tags = [e["tag"] for e in api.get("/api/library/vocabulary").json()["tags"]]
    assert "provisional" in tags


def test_vocabulary_endpoint(client):
    api, _ = client
    body = api.get("/api/library/vocabulary").json()

    assert [entry["tag"] for entry in body["tags"]][0] == "timestamps"
    assert all({"tag", "quote_count", "recording_count"} <= set(e) for e in body["tags"])


def test_vocabulary_of_an_untagged_library_is_empty(tmp_path):
    root = tmp_path / "study"
    make_recording(root, "P01", [])
    registry = RecordingRegistry()
    registry.add_library(root)

    from subtitle_search.library import vocabulary

    assert vocabulary(registry) == []
