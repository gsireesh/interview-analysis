"""FastAPI application.

Routes are namespaced by recording id from the start, even though single-folder
mode registers exactly one. That keeps library mode an addition rather than a
migration.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .editing import EditError, apply_cue_edit
from .highlights import COLORS, HighlightError
from .library import THEMES_FILENAME, ThemeStore, all_quotes, cooccurrence, tag_index, untagged
from .media import serve_media
from .search import regex_search, search
from .session import Recording, RecordingRegistry

STATIC_DIR = Path(__file__).parent / "static"


def create_app(registry: RecordingRegistry) -> FastAPI:
    app = FastAPI(title="subtitle-search", docs_url=None, redoc_url=None)
    app.state.registry = registry

    def require(recording_id: str) -> Recording:
        recording = registry.get(recording_id)
        if recording is None:
            raise HTTPException(status_code=404, detail="unknown recording")
        return recording

    @app.get("/api/config")
    def get_config() -> dict:
        default = registry.default
        return {
            "recordings": [r.summary() for r in registry.list()],
            "default_recording_id": default.id if default else None,
            "colors": list(COLORS),
        }

    @app.get("/api/recordings/{recording_id}")
    def get_recording(recording_id: str) -> dict:
        return require(recording_id).payload()

    @app.get("/api/recordings/{recording_id}/parts/{part_index}/media")
    def get_part_media(recording_id: str, part_index: int, request: Request):
        recording = require(recording_id)
        path = recording.media_path(part_index)
        if path is None:
            raise HTTPException(status_code=404, detail="no media file for this part")
        return serve_media(path, request.headers.get("range"))

    @app.get("/api/recordings/{recording_id}/media")
    def get_media(recording_id: str, request: Request):
        """The first part's media. Kept so a single-recording folder has a plain URL."""
        return get_part_media(recording_id, 0, request)

    @app.get("/api/recordings/{recording_id}/search")
    def get_search(
        recording_id: str,
        q: str = Query("", description="query text"),
        mode: str = Query("fuzzy", pattern="^(fuzzy|regex)$"),
        limit: int = Query(60, ge=1, le=500),
    ) -> dict:
        recording = require(recording_id)
        if mode == "regex":
            try:
                results = regex_search(recording.transcript, q, limit=limit)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
        else:
            results = search(recording.transcript, q, limit=limit)
        return {"query": q, "mode": mode, "results": results}

    @app.patch("/api/recordings/{recording_id}/cues/{cue_id}")
    def edit_cue(recording_id: str, cue_id: str, payload: dict = Body(...)) -> dict:
        """Correct one line of the transcript and save it to the source file."""
        recording = require(recording_id)
        try:
            return apply_cue_edit(recording, cue_id, payload.get("text", ""))
        except EditError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except OSError as exc:
            raise HTTPException(
                status_code=500, detail=f"could not write the transcript: {exc}"
            ) from exc

    @app.get("/api/recordings/{recording_id}/highlights")
    def list_highlights(recording_id: str) -> dict:
        recording = require(recording_id)
        return {
            "highlights": recording.store.list(),
            "known_tags": recording.store.known_tags(),
            "stale": recording.store.stale,
            "path": str(recording.store.path),
        }

    @app.post("/api/recordings/{recording_id}/highlights", status_code=201)
    def create_highlight(recording_id: str, payload: dict = Body(...)) -> dict:
        recording = require(recording_id)
        try:
            highlight = recording.store.create(payload)
        except HighlightError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"highlight": highlight, "known_tags": recording.store.known_tags()}

    @app.patch("/api/recordings/{recording_id}/highlights/{highlight_id}")
    def update_highlight(recording_id: str, highlight_id: str, payload: dict = Body(...)) -> dict:
        recording = require(recording_id)
        try:
            highlight = recording.store.update(highlight_id, payload)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="unknown highlight") from exc
        except HighlightError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"highlight": highlight, "known_tags": recording.store.known_tags()}

    @app.delete("/api/recordings/{recording_id}/highlights/{highlight_id}")
    def delete_highlight(recording_id: str, highlight_id: str) -> JSONResponse:
        recording = require(recording_id)
        if not recording.store.delete(highlight_id):
            raise HTTPException(status_code=404, detail="unknown highlight")
        return JSONResponse({"deleted": highlight_id})

    # -- the library, and the themes built across it ----------------------

    def themes() -> ThemeStore:
        return app.state.themes

    def corpus() -> list[dict]:
        return all_quotes(registry)

    @app.get("/api/library")
    def get_library() -> dict:
        quotes = corpus()
        return {
            "root": str(registry.root) if registry.root else None,
            "is_library": registry.is_library,
            "recordings": [r.summary() for r in registry.list()],
            "unreadable": [{"folder": name, "reason": why} for name, why in registry.failures],
            "quote_count": len(quotes),
            "untagged_count": len(untagged(quotes)),
            "tags": tag_index(quotes),
            "cooccurrence": cooccurrence(quotes, minimum=1),
            "colors": list(COLORS),
        }

    @app.get("/api/library/quotes")
    def get_library_quotes() -> dict:
        return {"quotes": corpus()}

    @app.get("/api/library/search")
    def search_library(q: str = Query(""), limit: int = Query(40, ge=1, le=200)) -> dict:
        """Search every transcript at once, newest-scoped results first."""
        results = []
        for recording in registry.list():
            for hit in search(recording.transcript, q, limit=limit):
                results.append({**hit, "recording_id": recording.id, "recording_title": recording.title})
        results.sort(key=lambda r: (0 if r["kind"] == "exact" else 1, -r["score"]))
        return {"query": q, "results": results[:limit]}

    @app.get("/api/library/themes")
    def get_themes() -> dict:
        quotes = corpus()
        store = themes()
        store.prune({q["ref"] for q in quotes})
        return {"themes": store.list(), "placed": sorted(store.placed_refs())}

    @app.post("/api/library/themes", status_code=201)
    def create_theme(payload: dict = Body(default={})) -> dict:
        return {"theme": themes().create(payload.get("title", ""), payload.get("color"))}

    @app.patch("/api/library/themes/{theme_id}")
    def update_theme(theme_id: str, payload: dict = Body(...)) -> dict:
        try:
            return {"theme": themes().update(theme_id, payload)}
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="unknown theme") from exc

    @app.delete("/api/library/themes/{theme_id}")
    def delete_theme(theme_id: str) -> JSONResponse:
        if not themes().delete(theme_id):
            raise HTTPException(status_code=404, detail="unknown theme")
        return JSONResponse({"deleted": theme_id})

    @app.post("/api/library/themes/assign")
    def assign_quote(payload: dict = Body(...)) -> dict:
        ref = payload.get("ref")
        if not ref:
            raise HTTPException(status_code=400, detail="a quote reference is required")
        try:
            return {"themes": themes().assign(ref, payload.get("theme_id"), payload.get("index"))}
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="unknown theme") from exc

    @app.post("/api/library/themes/order")
    def reorder_themes(payload: dict = Body(...)) -> dict:
        return {"themes": themes().reorder(list(payload.get("order") or []))}

    # -- pages -------------------------------------------------------------

    @app.get("/")
    def index() -> FileResponse:
        # Always the library, whatever it holds. One entry point beats a home
        # page that changes shape depending on how many folders it found.
        return FileResponse(STATIC_DIR / "library.html")

    @app.get("/reader")
    def reader() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html")

    @app.get("/themes")
    def themes_page() -> FileResponse:
        return FileResponse(STATIC_DIR / "themes.html")

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    root = registry.root or Path.cwd()
    app.state.themes = ThemeStore(root / THEMES_FILENAME)
    return app
