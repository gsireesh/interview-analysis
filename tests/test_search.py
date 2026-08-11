from subtitle_search.search import build_chunk_texts, regex_search, search
from subtitle_search.vtt import parse_vtt

from . import fixtures


def test_exact_match_is_found_and_located():
    transcript = parse_vtt(fixtures.COLON_PREFIX)
    results = search(transcript, "share my screen")

    assert results
    top = results[0]
    assert top["kind"] == "exact"
    assert top["speaker"] == "Dana Whitfield"
    assert top["snippet"][top["match_start"]:top["match_end"]].lower() == "share my screen"


def test_exact_matches_rank_above_fuzzy():
    transcript = parse_vtt(fixtures.COLON_PREFIX)
    results = search(transcript, "buttons")

    kinds = [r["kind"] for r in results]
    assert kinds[0] == "exact"
    assert kinds == sorted(kinds, key=lambda k: 0 if k == "exact" else 1)


def test_fuzzy_match_survives_a_typo():
    transcript = parse_vtt(fixtures.COLON_PREFIX)
    results = search(transcript, "confirmng")  # missing an 'i'

    assert any(r["kind"] == "fuzzy" for r in results)


def test_match_spanning_a_cue_boundary_is_found():
    """Zoom splits sentences across cues, so per-cue search would miss this."""
    transcript = parse_vtt(fixtures.COLON_PREFIX)
    # "demo." ends cue 0; "So, let me" begins cue 1.
    results = search(transcript, "of a demo. So, let me")

    assert results
    assert results[0]["kind"] == "exact"


def test_result_start_time_is_inside_the_matching_cue():
    transcript = parse_vtt(fixtures.COLON_PREFIX)
    results = search(transcript, "so many buttons")

    top = results[0]
    cue = transcript.cue(top["cue_id"])
    assert cue is not None
    assert cue.start <= top["start_time"] <= cue.end


def test_short_queries_return_nothing():
    transcript = parse_vtt(fixtures.COLON_PREFIX)
    assert search(transcript, "a") == []
    assert search(transcript, "   ") == []


def test_regex_mode():
    transcript = parse_vtt(fixtures.COLON_PREFIX)
    results = regex_search(transcript, r"scr(een|ipt)")

    assert results
    assert all(r["kind"] == "regex" for r in results)


def test_chunk_offsets_map_back_to_the_right_cue():
    transcript = parse_vtt(fixtures.COLON_PREFIX)
    entry = build_chunk_texts(transcript)[0]

    for cue_id, start, end in entry.spans:
        cue = transcript.cue(cue_id)
        assert entry.text[start:end] == cue.text
        assert entry.locate(start) == (cue_id, 0)
