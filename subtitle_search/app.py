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

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html")

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    return app
