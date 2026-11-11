import json

import pytest

from subtitle_search.codebook import ConversationCodebook
from subtitle_search.conversation import Conversation
from subtitle_search.conversation_highlights import (
    ConversationHighlightError,
    ConversationHighlightStore,
    SessionConversationHighlights,
    highlight_where,
)

U1, A1, U2 = "c1:0:0:user", "c1:0:0:assistant", "c1:1:0:user"


def _conversation(ids=(U1, A1, U2)):
    messages = {}
    for mid in ids:
        conversation_id, turn, version, role = mid.rsplit(":", 3)
        messages[mid] = {"role": role, "turn": int(turn), "version": int(version), "conversation_id": conversation_id}
    return Conversation(html="", order=list(ids), messages=messages)


@pytest.fixture
def book(tmp_path):
    codebook = ConversationCodebook(tmp_path / "book" / "conversation_codebook.json")
    for name in ("vague", "tone", "trust"):
        codebook.add({"name": name})
    return codebook


def code(book, name):
    return book.find(name)["id"]


@pytest.fixture
def store(tmp_path, book):
    return ConversationHighlightStore(tmp_path / "conversation_highlights.json", _conversation(), book)


def _payload(**overrides):
    base = {
        "text": "a selected phrase",
        "start_message_id": U1,
        "start_char_offset": 2,
        "end_message_id": U1,
        "end_char_offset": 19,
        "color": "teal",
        "note": "n",
    }
    base.update(overrides)
    return base


def test_create_persists_record(store):
    highlight = store.create(_payload())

    data = json.loads(store.path.read_text())
    assert data["version"] == 1
    assert data["highlights"][0]["id"] == highlight["id"]
    assert highlight["color"] == "teal" and highlight["codes"] == []


def test_create_orders_by_display_order(store):
    highlight = store.create(
        _payload(start_message_id=U2, start_char_offset=3, end_message_id=A1, end_char_offset=9)
    )

    assert (highlight["start_message_id"], highlight["end_message_id"]) == (A1, U2)
    assert (highlight["start_char_offset"], highlight["end_char_offset"]) == (9, 3)


def test_create_orders_offsets_within_one_message(store):
    highlight = store.create(_payload(start_char_offset=10, end_char_offset=4))

    assert (highlight["start_char_offset"], highlight["end_char_offset"]) == (4, 10)


def test_create_rejects_unknown_message(store):
    with pytest.raises(ConversationHighlightError):
        store.create(_payload(end_message_id="c1:9:0:user"))


def test_create_rejects_negative_offset(store):
    with pytest.raises(ConversationHighlightError):
        store.create(_payload(start_char_offset=-1))


def test_create_rejects_empty_text(store):
    with pytest.raises(ConversationHighlightError):
        store.create(_payload(text="   "))


def test_create_without_conversation_refused(tmp_path, book):
    bare = ConversationHighlightStore(tmp_path / "h.json", None, book)

    with pytest.raises(ConversationHighlightError):
        bare.create(_payload())


def test_unknown_color_falls_back_to_amber(store):
    assert store.create(_payload(color="plaid"))["color"] == "amber"


def test_codes_must_be_in_codebook(store, book):
    demo = code(book, "vague")
    assert store.create(_payload(codes=[demo, demo]))["codes"] == [demo]

    with pytest.raises(ConversationHighlightError, match="that conversation code is not in your codebook"):
        store.create(_payload(codes=["nope"]))


def test_update_note_color_codes(store, book):
    highlight = store.create(_payload())
    tone = code(book, "tone")

    updated = store.update(highlight["id"], {"note": "new", "color": "rose", "codes": [tone]})

    assert (updated["note"], updated["color"], updated["codes"]) == ("new", "rose", [tone])
    with pytest.raises(ConversationHighlightError):
        store.update(highlight["id"], {"codes": ["nope"]})
    with pytest.raises(KeyError):
        store.update("missing", {"note": "x"})


def test_update_never_moves_anchors(store):
    highlight = store.create(_payload())

    updated = store.update(highlight["id"], {"start_char_offset": 99, "text": "other"})

    assert updated["start_char_offset"] == 2 and updated["text"] == "a selected phrase"


def test_delete(store):
    highlight = store.create(_payload())

    assert store.delete(highlight["id"]) is True
    assert store.delete(highlight["id"]) is False
    assert store.list() == []


def test_update_and_delete_after_message_gone(tmp_path, book, store):
    highlight = store.create(_payload())
    gone = ConversationHighlightStore(store.path, _conversation((A1, U2)), book)

    assert gone.update(highlight["id"], {"note": "still here"})["note"] == "still here"
    assert [h["id"] for h in gone.list()] == [highlight["id"]]
    assert gone.delete(highlight["id"]) is True


def test_count_code(store, book):
    vague = code(book, "vague")
    store.create(_payload(codes=[vague]))
    store.create(_payload(codes=[vague, code(book, "tone")]))
    store.create(_payload())

    assert store.count_code(vague) == 2


def test_reassign_code_dedupes(store, book):
    vague, tone = code(book, "vague"), code(book, "tone")
    store.create(_payload(codes=[vague, tone]))
    store.create(_payload(codes=[vague]))

    assert store.reassign_code(vague, tone) == 2
    assert [h["codes"] for h in store.list()] == [[tone], [tone]]


def test_highlight_where_single():
    assert highlight_where({"start_message_id": "a:b:3:0:user", "end_message_id": "a:b:3:0:user"}) == {
        "start_turn": 3,
        "end_turn": 3,
        "speaker": "User",
    }
    assert highlight_where({"start_message_id": "c:2:1:assistant", "end_message_id": "c:2:1:assistant"})["speaker"] == "AI"


def test_highlight_where_across_roles():
    where = highlight_where({"start_message_id": "c:1:0:user", "end_message_id": "c:2:0:assistant"})
    assert where == {"start_turn": 1, "end_turn": 2, "speaker": "User → AI"}
    assert highlight_where({"start_message_id": "c:1:0:assistant", "end_message_id": "c:2:0:user"})["speaker"] == "AI → User"


@pytest.fixture
def session(tmp_path):
    stores = {
        coder: ConversationHighlightStore(
            tmp_path / coder / "conversation_highlights.json",
            _conversation(),
            ConversationCodebook(tmp_path / coder / "book.json"),
        )
        for coder in ("ann", "ben")
    }
    return SessionConversationHighlights(stores, None, None, None)


def test_session_labels_each_item_with_its_coder(session):
    session.create("ann", _payload())
    session.create("ben", _payload())

    assert sorted(h["coder"] for h in session.list()) == ["ann", "ben"]


def test_session_store_writes_only_own(tmp_path, session):
    mine = session.create("ann", _payload())

    assert (tmp_path / "ann" / "conversation_highlights.json").is_file()
    assert not (tmp_path / "ben" / "conversation_highlights.json").exists()
    assert "coder" not in json.loads((tmp_path / "ann" / "conversation_highlights.json").read_text())["highlights"][0]
    with pytest.raises(PermissionError):
        session.update("ben", mine["id"], {"note": "x"})
    with pytest.raises(PermissionError):
        session.delete("ben", mine["id"])
    assert session.update("ann", mine["id"], {"note": "ok"})["note"] == "ok"
    assert session.delete("ann", mine["id"]) is True


def test_session_makes_store_for_new_coder(tmp_path):
    made = []

    def factory(coder):
        made.append(coder)
        return ConversationHighlightStore(tmp_path / coder / "h.json", _conversation(), None)

    session = SessionConversationHighlights({}, factory, None, None)
    session.create("cara", _payload())

    assert made == ["cara"]
    assert session.list()[0]["coder"] == "cara"
