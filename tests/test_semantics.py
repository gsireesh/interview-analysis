"""Reading the corpus by meaning.

These pin the properties the views depend on, not the numbers themselves: which
quotes come out near each other, that a projection stays inside its box, that a
suggestion is only ever a suggestion. Exact coordinates are a function of a
library version and are not worth asserting.
"""

import pytest

pytest.importorskip("numpy")
pytest.importorskip("sklearn")

from subtitle_search.semantics import (  # noqa: E402
    Semantics,
    VectorCache,
    encode_tfidf,
    saturation,
)

TIMESTAMPS = [
    "Every file restarts at zero so my notes stop lining up.",
    "The clock resets on each part and I lose where a quote lives.",
    "Half my session is in one file and half in another with the same timecodes.",
]
PRIVACY = [
    "These are participant recordings, they cannot go to somebody else's cloud.",
    "I am not uploading interview audio to a service I do not control.",
]


def corpus(texts, recording="r1"):
    return [
        {"ref": f"{recording}:q{i}", "text": text, "recording_id": recording, "tags": []}
        for i, text in enumerate(texts)
    ]


@pytest.fixture
def model():
    return Semantics.build(corpus(TIMESTAMPS + PRIVACY), cache=None, prefer_neural=False)


# -- vectors -----------------------------------------------------------


def test_tfidf_gives_one_row_per_quote():
    vectors = encode_tfidf(TIMESTAMPS + PRIVACY)
    assert vectors.shape[0] == 5


def test_vectors_are_normalised_so_dot_products_are_cosines(model):
    import numpy

    lengths = numpy.linalg.norm(model.vectors, axis=1)
    assert numpy.allclose(lengths, 1.0, atol=1e-5)


def test_an_empty_corpus_does_not_explode():
    empty = Semantics.build([], cache=None, prefer_neural=False)
    assert len(empty) == 0
    assert empty.project() == []
    assert empty.similar("nothing") == []


def test_a_single_quote_lands_somewhere():
    one = Semantics.build(corpus(["only one"]), cache=None, prefer_neural=False)
    assert one.project() == [(0.5, 0.5)]


# -- neighbours --------------------------------------------------------


def test_quotes_about_the_same_thing_rank_above_unrelated_ones(model):
    """The whole premise: word overlap should at least separate topics."""
    neighbours = model.similar("r1:q0", count=4)
    ranked = [hit["ref"] for hit in neighbours]

    assert "r1:q0" not in ranked  # never itself
    # The two other timestamp complaints share vocabulary; the privacy ones do not.
    assert ranked.index("r1:q1") < ranked.index("r1:q4")


def test_similarity_is_ordered_and_bounded(model):
    scores = [hit["score"] for hit in model.similar("r1:q0", count=4)]
    assert scores == sorted(scores, reverse=True)
    assert all(-1.001 <= score <= 1.001 for score in scores)


def test_asking_about_an_unknown_quote_returns_nothing(model):
    assert model.similar("nope:q9") == []


# -- projection --------------------------------------------------------


def test_the_projection_fits_in_the_unit_square(model):
    points = model.project()
    assert len(points) == 5
    assert all(0.0 <= x <= 1.0 and 0.0 <= y <= 1.0 for x, y in points)


def test_identical_quotes_project_to_the_same_place():
    """Which is why the map spreads a stack rather than letting one hide."""
    twice = Semantics.build(corpus(["the same thing", "the same thing"]), cache=None, prefer_neural=False)
    points = twice.project()
    assert points[0] == pytest.approx(points[1])


# -- clustering --------------------------------------------------------


def test_clustering_splits_two_obvious_topics():
    model = Semantics.build(corpus(TIMESTAMPS + PRIVACY), cache=None, prefer_neural=False)
    labels, count = model.cluster()

    assert count >= 2
    assert len(labels) == 5
    # The two privacy quotes should not be scattered across every cluster.
    assert labels[3] == labels[4] or count > 2


def test_a_requested_cluster_count_is_honoured(model):
    labels, count = model.cluster(3)
    assert count == 3
    assert len(set(labels)) == 3


def test_too_few_quotes_to_cluster_is_not_an_error():
    tiny = Semantics.build(corpus(["one", "two"]), cache=None, prefer_neural=False)
    labels, count = tiny.cluster()
    assert len(labels) == 2 and count == 1


def test_cluster_terms_name_the_groups(model):
    labels, _ = model.cluster(2)
    terms = model.cluster_terms(labels)
    assert terms
    assert all(isinstance(words, list) for words in terms.values())


# -- negative cases ----------------------------------------------------


def test_the_loneliest_quote_is_the_one_least_like_the_rest():
    """Word overlap has to be real for this backend: it cannot read paraphrase."""
    texts = [
        "The timestamps reset on every file so the timestamps are useless.",
        "Timestamps reset when the file restarts and the timestamps stop matching.",
        "Every file resets its timestamps, which makes the timestamps meaningless.",
        "A completely unrelated remark about the weather in Lisbon.",
    ]
    model = Semantics.build(corpus(texts), cache=None, prefer_neural=False)
    lonely = model.loneliest(count=1)

    assert lonely and lonely[0]["ref"] == "r1:q3"


def test_loneliest_needs_a_few_quotes_to_mean_anything():
    tiny = Semantics.build(corpus(["a", "b"]), cache=None, prefer_neural=False)
    assert tiny.loneliest() == []


# -- suggestions -------------------------------------------------------


def test_a_quote_is_suggested_the_theme_its_neighbours_are_in(model):
    placed = {"r1:q1": "theme-time", "r1:q2": "theme-time", "r1:q4": "theme-privacy"}
    hint = model.suggest_theme("r1:q0", placed)

    assert hint is not None
    assert hint["theme_id"] == "theme-time"
    assert hint["confidence"] > 0


def test_nothing_is_suggested_when_no_theme_has_anything_in_it(model):
    assert model.suggest_theme("r1:q0", {}) is None


# -- saturation --------------------------------------------------------


def test_saturation_counts_tags_as_they_first_appear():
    quotes = [
        {"ref": "a:1", "recording_id": "a", "tags": ["trust", "tone"]},
        {"ref": "b:1", "recording_id": "b", "tags": ["trust"]},
        {"ref": "c:1", "recording_id": "c", "tags": ["privacy"]},
    ]
    recordings = [
        {"id": "a", "title": "P01", "parts": [{"started_at": "2024-01-01T10:00:00"}]},
        {"id": "b", "title": "P02", "parts": [{"started_at": "2024-01-02T10:00:00"}]},
        {"id": "c", "title": "P03", "parts": [{"started_at": "2024-01-03T10:00:00"}]},
    ]

    curve = saturation(quotes, recordings)
    assert [p["total"] for p in curve["points"]] == [2, 2, 3]
    assert [p["new"] for p in curve["points"]] == [2, 0, 1]
    assert curve["points"][2]["new_tags"] == ["privacy"]
    assert curve["total_tags"] == 3


def test_saturation_orders_by_when_the_interview_happened():
    """Folder order is not interview order, and the curve is meaningless if wrong."""
    quotes = [
        {"ref": "z:1", "recording_id": "z", "tags": ["first"]},
        {"ref": "a:1", "recording_id": "a", "tags": ["first", "second"]},
    ]
    recordings = [
        {"id": "z", "title": "P09", "parts": [{"started_at": "2024-01-01T09:00:00"}]},
        {"id": "a", "title": "P01", "parts": [{"started_at": "2024-01-05T09:00:00"}]},
    ]

    curve = saturation(quotes, recordings)
    assert [p["title"] for p in curve["points"]] == ["P09", "P01"]
    assert [p["new"] for p in curve["points"]] == [1, 1]


# -- cache -------------------------------------------------------------


def test_the_cache_round_trips_vectors(tmp_path):
    import numpy

    path = tmp_path / "vectors.npz"
    cache = VectorCache(path)
    texts = ["one", "two"]
    vectors = numpy.array([[1.0, 0.0], [0.0, 1.0]], dtype="float32")

    cache.put(texts, vectors, "model-a")
    assert numpy.allclose(VectorCache(path).get(texts, "model-a"), vectors)


def test_the_cache_is_ignored_for_a_different_model(tmp_path):
    """Vectors from one model say nothing about another."""
    import numpy

    path = tmp_path / "vectors.npz"
    cache = VectorCache(path)
    cache.put(["one"], numpy.array([[1.0, 0.0]], dtype="float32"), "model-a")

    assert VectorCache(path).get(["one"], "model-b") is None


def test_an_unseen_quote_misses_the_cache(tmp_path):
    import numpy

    path = tmp_path / "vectors.npz"
    cache = VectorCache(path)
    cache.put(["one"], numpy.array([[1.0, 0.0]], dtype="float32"), "model-a")

    assert cache.get(["one", "two"], "model-a") is None


def test_a_corrupt_cache_is_ignored_rather_than_fatal(tmp_path):
    path = tmp_path / "vectors.npz"
    path.write_bytes(b"not an npz file")
    assert VectorCache(path).get(["one"], "model-a") is None
