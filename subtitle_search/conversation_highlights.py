"""Persistent storage for conversation highlights, the selections of a participant's chat that carry conversation codes.

``ConversationHighlightStore`` is one coder's highlights in one recording, in
``<recording>/coders/<id>/conversation_highlights.json``. Each highlight carries ``codes``: ids from that
coder's conversation codebook. ``SessionConversationHighlights`` joins every coder's store and the common
highlights for a recording; it writes only to the caller's own store.
"""

from __future__ import annotations

import uuid

from .conversation import Conversation
from .highlights import COLORS, DEFAULT_COLOR, HighlightError, _normalize_codes
from .jsonstore import JsonStore, now

#: One coder's conversation highlights in one recording, at ``<recording>/coders/<id>/``.
HIGHLIGHTS_FILENAME = "conversation_highlights.json"

SCHEMA_VERSION = 1

_SPEAKERS = {"user": "User", "assistant": "AI"}


class ConversationHighlightError(ValueError):
    """Raised for a conversation highlight payload that cannot be stored."""


def _codes(raw, codebook) -> list[str]:
    try:
        return _normalize_codes(raw, codebook, "conversation")
    except HighlightError as error:
        raise ConversationHighlightError(str(error)) from error


def _parse_id(message_id: str) -> tuple[int, str]:
    """Give the turn and speaker of a message id, read from the right because the conversation id may hold colons."""
    _, turn, _, role = str(message_id).rsplit(":", 3)
    return int(turn), _SPEAKERS.get(role, role)


def highlight_where(highlight: dict) -> dict:
    """Say where a highlight sits, from its message ids alone so it works when the chat file is missing.

    Args:
        highlight: a record with ``start_message_id`` and ``end_message_id``.

    Returns:
        ``{"start_turn", "end_turn", "speaker"}``. ``speaker`` is "User" or "AI", or "User → AI" or
        "AI → User" when the start and end messages have different speakers.
    """
    start_turn, start_speaker = _parse_id(highlight["start_message_id"])
    end_turn, end_speaker = _parse_id(highlight["end_message_id"])
    speaker = start_speaker if start_speaker == end_speaker else f"{start_speaker} → {end_speaker}"
    return {"start_turn": start_turn, "end_turn": end_turn, "speaker": speaker}


def _offset(value) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ConversationHighlightError("offsets must be non-negative integers")
    return value


class ConversationHighlightStore(JsonStore):
    """Reads and writes one coder's conversation highlights for one recording."""

    def __init__(self, path, conversation: Conversation | None, codebook=None):
        #: The recording's chat, which anchors are checked against on create. None when it has no chat file.
        self.conversation = conversation
        #: The coder's conversation codebook, which every code on a highlight must come from.
        self.codebook = codebook
        super().__init__(path)

    def _empty(self) -> dict:
        return {"version": SCHEMA_VERSION, "updated_at": now(), "highlights": []}

    def _repair(self, data: dict) -> dict:
        data.setdefault("version", SCHEMA_VERSION)
        if not isinstance(data.get("highlights"), list):
            data["highlights"] = []
        return data

    def list(self) -> list[dict]:
        """Give the highlights in the order they were made."""
        return list(self._data["highlights"])

    def _find(self, highlight_id: str) -> dict | None:
        return next((h for h in self._data["highlights"] if h.get("id") == highlight_id), None)

    def create(self, payload: dict) -> dict:
        """Store a highlight, putting its start before its end in display order.

        Args:
            payload: ``text``, the two message ids and offsets, and optionally ``color``, ``note``, ``codes``.

        Returns:
            The stored record.

        Raises:
            ConversationHighlightError: no chat, an unknown message id, a bad offset, empty text or a code
                outside the codebook.
        """
        if self.conversation is None:
            raise ConversationHighlightError("this recording has no conversation")
        text = str(payload.get("text") or "").strip()
        if not text:
            raise ConversationHighlightError("cannot highlight an empty selection")
        start_id, end_id = payload.get("start_message_id"), payload.get("end_message_id")
        for message in (start_id, end_id):
            if message not in self.conversation.messages:
                raise ConversationHighlightError("that message is not in this conversation")
        start_offset, end_offset = _offset(payload.get("start_char_offset")), _offset(payload.get("end_char_offset"))
        order = self.conversation.order
        if (order.index(end_id), end_offset) < (order.index(start_id), start_offset):
            start_id, end_id, start_offset, end_offset = end_id, start_id, end_offset, start_offset
        codes = _codes(payload.get("codes"), self.codebook)
        color = payload.get("color")
        timestamp = now()
        highlight = {
            "id": uuid.uuid4().hex[:12],
            "start_message_id": start_id,
            "end_message_id": end_id,
            "start_char_offset": start_offset,
            "end_char_offset": end_offset,
            "text": text,
            "color": color if color in COLORS else DEFAULT_COLOR,
            "note": str(payload.get("note") or ""),
            "codes": codes,
            "created_at": timestamp,
            "updated_at": timestamp,
        }
        self._data["highlights"].append(highlight)
        self._write()
        return highlight

    def update(self, highlight_id: str, patch: dict) -> dict:
        """Change a highlight's ``note``, ``color`` or ``codes``; anchors and text are never touched.

        Raises:
            KeyError: no such highlight.
            ConversationHighlightError: a code outside the codebook, in which case nothing changes.
        """
        highlight = self._find(highlight_id)
        if highlight is None:
            raise KeyError(highlight_id)
        codes = _codes(patch["codes"], self.codebook) if "codes" in patch else None
        if "note" in patch:
            highlight["note"] = str(patch["note"] or "")
        if codes is not None:
            highlight["codes"] = codes
        if patch.get("color") in COLORS:
            highlight["color"] = patch["color"]
        highlight["updated_at"] = now()
        self._write()
        return highlight

    def count_code(self, code_id: str) -> int:
        return sum(1 for h in self._data["highlights"] if code_id in (h.get("codes") or []))

    def reassign_code(self, from_id: str, to_id: str) -> int:
        """Put ``to_id`` wherever ``from_id`` was, once per highlight, and return how many changed."""
        moved = 0
        for highlight in self._data["highlights"]:
            codes = highlight.get("codes") or []
            if from_id not in codes:
                continue
            merged: list[str] = []
            for code_id in codes:
                code_id = to_id if code_id == from_id else code_id
                if code_id not in merged:
                    merged.append(code_id)
            highlight["codes"] = merged
            highlight["updated_at"] = now()
            moved += 1
        if moved:
            self._write()
        return moved

    def delete(self, highlight_id: str) -> bool:
        highlight = self._find(highlight_id)
        if highlight is None:
            return False
        self._data["highlights"].remove(highlight)
        self._write()
        return True


class SessionConversationHighlights:
    """Every coder's conversation highlights in one recording, one store per coder.

    Reads return everyone's highlights, each labelled with its coder. Writes go to the coder's own store,
    and a write to someone else's highlight is refused.
    """

    def __init__(self, stores: dict[str, ConversationHighlightStore], factory=None, common=None, returns=None):
        self.stores = dict(stores)
        #: Makes the store for a coder who has not saved a highlight here yet.
        self.factory = factory
        #: The agreed highlights of this recording (a common.CommonQuotes), shown to everyone.
        self.common = common
        #: Items returned from common, waiting to be claimed.
        self.returns = returns

    @staticmethod
    def _label(coder: str, highlight: dict) -> dict:
        # In place, so a caller holding a highlight sees later changes. The store leaves the label out when it writes.
        highlight["coder"] = coder
        return highlight

    def list(self) -> list[dict]:
        items = [self._label(c, h) for c, store in self.stores.items() for h in store.list()]
        if self.common is not None:
            items += self.common.list()
        return items

    def count_code(self, code_id: str) -> int:
        return sum(store.count_code(code_id) for store in self.stores.values())

    def reassign_code(self, from_id: str, to_id: str) -> int:
        return sum(store.reassign_code(from_id, to_id) for store in self.stores.values())

    def owner(self, highlight_id: str) -> str | None:
        return next((c for c, s in self.stores.items() if s._find(highlight_id)), None)

    def _own(self, coder: str, highlight_id: str) -> ConversationHighlightStore:
        owner = self.owner(highlight_id)
        if owner is None:
            raise KeyError(highlight_id)
        if owner != coder:
            raise PermissionError("that highlight belongs to another coder")
        return self.stores[owner]

    def store_for(self, coder: str) -> ConversationHighlightStore:
        if coder not in self.stores:
            if self.factory is None:
                raise KeyError(coder)
            self.stores[coder] = self.factory(coder)
        return self.stores[coder]

    def create(self, coder: str, payload: dict) -> dict:
        return self._label(coder, self.store_for(coder).create(payload))

    def update(self, coder: str, highlight_id: str, patch: dict) -> dict:
        return self._label(coder, self._own(coder, highlight_id).update(highlight_id, patch))

    def delete(self, coder: str, highlight_id: str) -> bool:
        return self._own(coder, highlight_id).delete(highlight_id)

    @property
    def unreadable(self) -> bool:
        """Whether any coder's highlights here could not be read, so the list is incomplete."""
        return any(store.unreadable for store in self.stores.values())
