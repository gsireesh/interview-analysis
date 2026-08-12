"""Reading the corpus by meaning rather than by the tags put on it.

Everything else in this tool works on what you decided: the tags you applied, the
themes you built. This module works on what the quotes *say*, so it can disagree
with you. That is the point. A cluster the language forms that your codebook does
not is either a theme you missed or a distinction you decided did not matter --
both worth knowing, and neither visible in a tag list.

Two backends, because the good one costs something:

``tfidf``   Local, instant, no download. Counts words. It finds quotes that share
            vocabulary, which is a decent proxy for topic and a poor one for
            meaning: it cannot tell that "it never works" and "constantly broken"
            are the same complaint.
``neural``  A sentence-transformer model. Understands paraphrase. Requires
            downloading the model once -- the only outbound request this tool
            ever makes. The quotes themselves are never sent anywhere; encoding
            happens in this process, on this machine.

Nothing here decides anything. It proposes groupings and ranks similarity; every
one of those is offered to a person to accept, and none is written into a theme
without being accepted.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

EMBEDDINGS_FILENAME = "library.embeddings.npz"

#: Small, fast, and good at short sentences -- which is what a quote is.
DEFAULT_MODEL = "sentence-transformers/all-MiniLM-L6-v2"


class SemanticsUnavailable(RuntimeError):
    """Raised when the numeric stack needed for this is not installed."""


def _require_numpy():
    try:
        import numpy
    except ImportError as exc:  # pragma: no cover - depends on the environment
        raise SemanticsUnavailable(
            "this view needs numpy and scikit-learn: pip install -e '.[analysis]'"
        ) from exc
    return numpy


def neural_available() -> bool:
    try:
        import sentence_transformers  # noqa: F401
    except Exception:
        return False
    return True


def _digest(text: str) -> str:
    return hashlib.sha1(text.strip().encode("utf-8")).hexdigest()[:16]


# ---------------------------------------------------------------- backends --


def encode_tfidf(texts: list[str]):
    """Vectors from word overlap. No model, no download, no network."""
    numpy = _require_numpy()
    try:
        from sklearn.decomposition import TruncatedSVD
        from sklearn.feature_extraction.text import TfidfVectorizer
    except ImportError as exc:  # pragma: no cover
        raise SemanticsUnavailable("scikit-learn is required: pip install -e '.[analysis]'") from exc

    if len(texts) < 2:
        return numpy.zeros((len(texts), 1), dtype="float32")

    # Dropping stop words is right for real quotes and fatal for short ones:
    # "it never works" is entirely stop words, and the vectorizer raises rather
    # than returning an empty row. Fall back to keeping everything, then to
    # giving up quietly, because no view should 500 over a thin corpus.
    matrix = None
    for options in ({"stop_words": "english"}, {}):
        try:
            matrix = TfidfVectorizer(
                sublinear_tf=True, min_df=1, ngram_range=(1, 2), **options
            ).fit_transform(texts)
            break
        except ValueError:
            matrix = None
    if matrix is None or matrix.shape[1] == 0:
        return numpy.zeros((len(texts), 1), dtype="float32")

    # Reduce to something a projection and a distance can work with, but never
    # ask for more components than the corpus actually has. A handful of nearly
    # identical short quotes can leave a single column, and SVD refuses that --
    # in which case the raw matrix is already small enough to use directly.
    components = min(64, matrix.shape[0] - 1, matrix.shape[1] - 1)
    if components < 2:
        return numpy.asarray(matrix.todense(), dtype="float32")
    reduced = TruncatedSVD(n_components=components, random_state=0).fit_transform(matrix)
    return numpy.asarray(reduced, dtype="float32")


def encode_neural(texts: list[str], model_name: str = DEFAULT_MODEL):
    """Vectors from a sentence-transformer. Downloads the model on first use."""
    numpy = _require_numpy()
    from sentence_transformers import SentenceTransformer

    model = SentenceTransformer(model_name)
    return numpy.asarray(model.encode(texts, show_progress_bar=False), dtype="float32")


# ------------------------------------------------------------------- cache --


class VectorCache:
    """Remembers neural vectors between runs, keyed by the text itself.

    Only the neural backend is cached. TF-IDF weights depend on the whole corpus,
    so a vector computed for one set of quotes is meaningless for another, and
    recomputing it is cheap anyway.
    """

    def __init__(self, path: Path):
        self.path = path
        self._vectors: dict[str, list[float]] = {}
        self._model = ""
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            numpy = _require_numpy()
            with numpy.load(self.path, allow_pickle=False) as data:
                keys = [str(k) for k in data["keys"]]
                self._model = str(data["model"][0]) if "model" in data else ""
                self._vectors = {k: data["vectors"][i].tolist() for i, k in enumerate(keys)}
        except (OSError, ValueError, KeyError, SemanticsUnavailable):
            self._vectors = {}

    def get(self, texts: list[str], model_name: str):
        numpy = _require_numpy()
        if self._model != model_name:
            return None
        keys = [_digest(t) for t in texts]
        if any(key not in self._vectors for key in keys):
            return None
        return numpy.asarray([self._vectors[key] for key in keys], dtype="float32")

    def put(self, texts: list[str], vectors, model_name: str) -> None:
        numpy = _require_numpy()
        if self._model != model_name:
            self._vectors = {}
            self._model = model_name
        for text, vector in zip(texts, vectors):
            self._vectors[_digest(text)] = [float(x) for x in vector]
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            keys = list(self._vectors)
            numpy.savez_compressed(
                self.path,
                keys=numpy.array(keys),
                vectors=numpy.asarray([self._vectors[k] for k in keys], dtype="float32"),
                model=numpy.array([model_name]),
            )
        except OSError:
            pass  # a cache that cannot be written is a slow run, not a failure


# --------------------------------------------------------------- the model --


@dataclass
class Semantics:
    """Vectors for one corpus of quotes, and the things you can ask of them."""

    refs: list[str]
    texts: list[str]
    vectors: object
    backend: str

    @classmethod
    def build(cls, quotes: list[dict], cache: VectorCache | None, prefer_neural: bool) -> "Semantics":
        numpy = _require_numpy()
        refs = [q["ref"] for q in quotes]
        texts = [(q.get("text") or "").strip() for q in quotes]

        if not texts:
            return cls(refs=[], texts=[], vectors=numpy.zeros((0, 1), dtype="float32"), backend="none")

        if prefer_neural and neural_available():
            vectors = cache.get(texts, DEFAULT_MODEL) if cache else None
            if vectors is None:
                vectors = encode_neural(texts)
                if cache:
                    cache.put(texts, vectors, DEFAULT_MODEL)
            backend = "neural"
        else:
            vectors = encode_tfidf(texts)
            backend = "tfidf"

        # Cosine similarity is the only distance that behaves for both backends,
        # so normalize once here and use dot products everywhere after.
        norms = numpy.linalg.norm(vectors, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        return cls(refs=refs, texts=texts, vectors=vectors / norms, backend=backend)

    def __len__(self) -> int:
        return len(self.refs)

    # -- projection ------------------------------------------------------

    def project(self) -> list[tuple[float, float]]:
        """Two dimensions to look at, scaled into a unit square.

        UMAP if it is installed, t-SNE when there are enough points for it to
        mean anything, PCA otherwise. Which one ran is reported, because the
        three make different promises about what distance on screen means.
        """
        numpy = _require_numpy()
        count = len(self.refs)
        if count == 0:
            return []
        if count == 1:
            return [(0.5, 0.5)]

        # A corpus of near-identical short quotes can collapse to a single
        # dimension, and every projector refuses to pull two axes out of one.
        # Padding keeps one code path, and identical quotes still land together.
        vectors = self.vectors
        if vectors.shape[1] < 2:
            vectors = numpy.hstack([vectors, numpy.zeros((count, 2 - vectors.shape[1]), dtype="float32")])

        coords = None
        try:
            import umap  # type: ignore

            coords = umap.UMAP(
                n_neighbors=min(15, max(2, count - 1)), min_dist=0.12, random_state=0
            ).fit_transform(vectors)
        except Exception:
            coords = None

        if coords is None:
            try:
                from sklearn.decomposition import PCA
                from sklearn.manifold import TSNE

                if count >= 8:
                    coords = TSNE(
                        n_components=2,
                        perplexity=max(2.0, min(30.0, (count - 1) / 3.0)),
                        init="pca",
                        random_state=0,
                    ).fit_transform(vectors)
                else:
                    coords = PCA(n_components=2, random_state=0).fit_transform(vectors)
            except ImportError as exc:  # pragma: no cover
                raise SemanticsUnavailable("scikit-learn is required for the map") from exc

        coords = numpy.asarray(coords, dtype="float64")
        low, high = coords.min(axis=0), coords.max(axis=0)
        span = numpy.where(high - low == 0, 1.0, high - low)
        scaled = (coords - low) / span
        return [(float(x), float(y)) for x, y in scaled]

    @property
    def projector(self) -> str:
        try:
            import umap  # noqa: F401

            return "umap"
        except Exception:
            return "t-SNE" if len(self.refs) >= 8 else "PCA"

    # -- clustering ------------------------------------------------------

    def cluster(self, requested: int | None = None) -> tuple[list[int], int]:
        """Group by meaning, choosing the number of groups if not told one.

        Chosen by silhouette score across a small range. This is a suggestion to
        argue with, not an answer -- it knows nothing about what the study is
        for.
        """
        numpy = _require_numpy()
        count = len(self.refs)
        if count < 4:
            return [0] * count, 1 if count else 0

        from sklearn.cluster import AgglomerativeClustering
        from sklearn.metrics import silhouette_score

        if requested and requested >= 2:
            labels = AgglomerativeClustering(n_clusters=min(requested, count)).fit_predict(self.vectors)
            return [int(x) for x in labels], int(len(set(labels)))

        best_labels, best_score, best_k = None, -2.0, 1
        for k in range(2, min(9, count)):
            labels = AgglomerativeClustering(n_clusters=k).fit_predict(self.vectors)
            if len(set(labels)) < 2:
                continue
            score = float(silhouette_score(self.vectors, labels, metric="cosine"))
            if score > best_score:
                best_labels, best_score, best_k = labels, score, k

        if best_labels is None:
            return [0] * count, 1
        return [int(x) for x in best_labels], best_k

    def cluster_terms(self, labels: list[int], top: int = 4) -> dict[int, list[str]]:
        """The words that distinguish each cluster, as a starting name for it."""
        try:
            from sklearn.feature_extraction.text import TfidfVectorizer
        except ImportError:  # pragma: no cover
            return {}
        if not self.texts:
            return {}

        joined: dict[int, list[str]] = {}
        for label, text in zip(labels, self.texts):
            joined.setdefault(label, []).append(text)
        if len(joined) < 2:
            return {label: [] for label in joined}

        keys = sorted(joined)
        documents = [" ".join(joined[k]) for k in keys]
        matrix = vocabulary = None
        for options in ({"stop_words": "english"}, {}):
            try:
                vectorizer = TfidfVectorizer(min_df=1, **options)
                matrix = vectorizer.fit_transform(documents)
                vocabulary = vectorizer.get_feature_names_out()
                break
            except ValueError:
                matrix = None
        if matrix is None:
            return {label: [] for label in joined}

        terms: dict[int, list[str]] = {}
        for row, key in enumerate(keys):
            weights = matrix[row].toarray()[0]
            ranked = weights.argsort()[::-1][:top]
            terms[key] = [str(vocabulary[i]) for i in ranked if weights[i] > 0]
        return terms

    # -- neighbours ------------------------------------------------------

    def similar(self, ref: str, count: int = 6) -> list[dict]:
        """The quotes most like this one, nearest first."""
        numpy = _require_numpy()
        if ref not in self.refs:
            return []
        index = self.refs.index(ref)
        scores = self.vectors @ self.vectors[index]
        order = numpy.argsort(scores)[::-1]
        return [
            {"ref": self.refs[int(i)], "score": round(float(scores[int(i)]), 4)}
            for i in order
            if int(i) != index
        ][:count]

    def loneliest(self, count: int = 8) -> list[dict]:
        """Quotes least like anything else in the corpus.

        Negative cases are load-bearing in qualitative work: the one person who
        said the opposite is usually where a theme's real boundary is. They are
        also the easiest thing to lose, because nothing groups them.
        """
        numpy = _require_numpy()
        if len(self.refs) < 3:
            return []
        similarity = self.vectors @ self.vectors.T
        numpy.fill_diagonal(similarity, -1.0)
        best = similarity.max(axis=1)
        order = numpy.argsort(best)
        return [
            {"ref": self.refs[int(i)], "nearest": round(float(best[int(i)]), 4)}
            for i in order[:count]
        ]

    def suggest_theme(self, ref: str, placed: dict[str, str], count: int = 5) -> dict | None:
        """Where a quote would go, judged by the company it keeps.

        Votes among its nearest neighbours that are already in a theme, weighted
        by similarity. Only ever a suggestion; nothing is filed automatically.
        """
        if not placed:
            return None
        votes: dict[str, float] = {}
        for neighbour in self.similar(ref, count=max(count, 8)):
            theme_id = placed.get(neighbour["ref"])
            if theme_id and neighbour["score"] > 0:
                votes[theme_id] = votes.get(theme_id, 0.0) + neighbour["score"]
        if not votes:
            return None
        theme_id, weight = max(votes.items(), key=lambda kv: kv[1])
        return {"theme_id": theme_id, "confidence": round(weight, 4)}


# -------------------------------------------------------------- saturation --


def saturation(quotes: list[dict], recordings: list[dict]) -> dict:
    """Whether new interviews are still turning up new tags.

    The grounded-theory question of whether you interviewed enough people, drawn
    as the curve it actually is: cumulative distinct tags against interviews, in
    the order they were recorded. A curve still climbing at the last participant
    is the study telling you it is not finished.

    It measures the codebook, not the phenomenon -- a flat curve can equally mean
    you stopped noticing new things. Worth reading as a prompt, not a verdict.
    """
    order = sorted(
        recordings,
        key=lambda r: (
            (r.get("parts") or [{}])[0].get("started_at") or "",
            r.get("title", ""),
        ),
    )
    by_recording: dict[str, set[str]] = {}
    for quote in quotes:
        by_recording.setdefault(quote["recording_id"], set()).update(quote.get("tags") or [])

    seen: set[str] = set()
    points = []
    for position, recording in enumerate(order, start=1):
        tags = by_recording.get(recording["id"], set())
        fresh = tags - seen
        seen |= tags
        points.append(
            {
                "position": position,
                "recording_id": recording["id"],
                "title": recording.get("title", ""),
                "total": len(seen),
                "new": len(fresh),
                "new_tags": sorted(fresh),
            }
        )
    return {"points": points, "total_tags": len(seen)}
