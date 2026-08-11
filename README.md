# subtitle-search

A reading-first viewer for Zoom transcripts. The text is the document; the
recording is a reference you drop into when you need to hear how something was
said. Point it at a recording folder, read, pull quotes.

```bash
pip install -e .
subtitle-search /path/to/recording-folder
```

It opens `http://127.0.0.1:8765`.

## What it expects

A folder with at least one `.vtt` transcript and its media. Video is preferred
(`.mp4`, `.m4v`, `.mov`, `.webm`, `.mkv`) with audio as a fallback (`.m4a`,
`.mp3`, `.wav`, …) — a typical Zoom folder with both an `.mp4` and an `.m4a`
uses the `.mp4`.

**Everything in the folder is one session.** Zoom splits a meeting into several
recordings when it gets interrupted, and each part restarts its transcript at
00:00. The folder's files are grouped into parts, ordered, and laid end to end on
a single continuous timeline.

## Interrupted sessions

Part two starts where part one's *recording* ended — not where its last caption
ended, since a recording usually runs on past the final word. Durations are read
straight out of the MP4/M4A container, so this needs no ffprobe; if a part's
media is missing, its last caption plus a short tail is used instead.

```
part 1   0:00:00 ──────────────── 1:30:00
         [ 10 min interruption, shown as a marker ]
part 2   1:30:00 ──────────────── 2:15:00
```

Times never restart, and the timeline has **no holes** — every session timestamp
has audio behind it, so scrubbing anywhere lands on something. The real
interruption is shown where it happened, as a rule across the reading column
reading *"Recording resumed after 10 minutes · 2:12 PM"*. Playback crosses the
seam by itself: playing off the end of one recording continues into the next, and
seeking or jumping to a quote switches files transparently.

Blocks never merge across a break, even when the same person is still talking.

Parts are ordered by the GMT timestamp Zoom stamps into cloud filenames
(`GMT20240301-140000_Recording.transcript.vtt`), which also pairs each transcript
with its media. Failing that, transcripts and media are paired on a shared stem
once Zoom's decoration is stripped, then by trailing counter and modified time.
Wall-clock interruption lengths need the filename timestamps; without them the
marker says which part is starting but not how long the gap was.

## Your recordings stay put

The server binds to `127.0.0.1` only and makes no outbound requests. There are no
CDN assets, web fonts, or analytics — the page is drawn entirely with fonts
already on your machine. Nothing is uploaded anywhere.

## Reading

The transcript is grouped into blocks: contiguous captions from one speaker read
as a single passage, with paragraph breaks inserted where the speaker paused for
more than a couple of seconds. Underneath, every original caption is kept
separately — that is what lets an arbitrary text selection resolve to a point in
the recording.

Blocks hang off a **time spine** down the left, with timestamps as ticks. The
marker on the spine shows where you are.

The video pane starts minimized and stays that way between sessions. Expanded, it
can be resized by dragging the grip along its top edge — or by focusing the grip
and using the arrow keys. The height is remembered, and capped at three quarters
of the window so the transcript can never be squeezed out.

### Two modes

Reading is the default:

- **Reading** — the cursor follows where you are in the text, and the player is
  silently cued to match. Press play and it starts where you are looking.
- **Following** — starting playback switches here: the transcript keeps up with
  the audio and scrolls itself.

Scrolling or moving the cursor by hand drops back to Reading **without stopping
playback**, and a "Follow along" button appears to re-attach.

### Keys

| | |
|---|---|
| `j` / `k` | previous / next block |
| `Space` | play / pause |
| `←` / `→` | seek ∓5s |
| `/` | search |
| `e` | correct the current block |
| `h` | save the selection as a quote |
| `c` | copy the selection with speaker and timestamp |
| `f` | toggle following |
| `Esc` | clear selection |

## Correcting the transcript

Press `e` on a block to fix what the transcript got wrong. Reading shows merged
prose, but a correction has to land on a single caption, since that is what gets
written back — so edit mode opens the block into the captions underneath it, each
with its own timestamp and a button to replay just that line. Caption boundaries
become visible exactly when they matter and stay invisible the rest of the time.

Enter saves a line and moves to the next; Esc abandons the line you are on and
finishes. Focusing a line cues the player to it without interrupting playback, so
you can correct while listening.

**The original is preserved.** Before the first change to a transcript, it is
copied to `<name>_original.vtt`. That copy is written once and never touched
again, so it always holds the file as it came off Zoom regardless of how many
corrections follow. Backups are skipped by folder discovery, so they never get
read as another recording.

**Edits are spliced, not regenerated.** Only the edited caption's text is
replaced; every other byte stays as it was, including line endings and any block
the parser could not read. Rebuilding the file from parsed data would silently
drop those, and a transcript is the wrong place to lose things quietly.

**Quotes follow their words.** Correcting a line re-anchors every quote
overlapping it, so a quote keeps covering the same words rather than drifting by
however many characters you inserted. The quote's saved text is refreshed too, so
it reflects the correction instead of preserving the error.

Timestamps and speaker labels are not editable — only the words.

## Quotes

Select any text — across caption or speaker boundaries — and a bar appears
showing the estimated timestamp. Pick a color to save it. The new quote is
scrolled into view in the Quotes sidebar and briefly marked, and its inline
highlight is marked too, so the transcript and the list agree on which one you
just made. Keyboard focus stays in the transcript unless you chose "Save with
note", so `j` keeps moving you down the page rather than typing into a field.

Notes and tags are edited in the sidebar. The tag filter lists only tags that
have quotes behind them, with a count — a tag you have stopped using disappears
from the filter, while remaining available for autocomplete when tagging.

Everything is written immediately to one `session.highlights.json` beside the
recording — one file per folder, whatever the number of parts — so quotes travel
with the folder. There is no save step. Writes are atomic, so an interrupted
write cannot truncate the file.

Quotes saved by an earlier version, in a file named after the transcript, are
adopted into the session file on first open. The original is left on disk
untouched as a backup, never deleted.

Timestamps are estimated by interpolating within a caption based on where your
selection falls in it, rather than snapping to the caption's start — on Zoom's
longer captions that is a difference of several seconds. Playback seeks 0.75s
early so the first word is not clipped.

## Finding quotes

Exact matches rank first, then close ones (for when the transcript did not hear
the word the way you remember it). Matching runs across block text, so a phrase
split across two captions is still findable. `.*` switches to regex.

## Checking the parse

Speaker detection is a heuristic. Zoom writes the speaker either as a
`Name:` prefix inside the caption or as a `<v Name>` tag; the prefix form is
ambiguous, because a sentence like *"So here's my point: I disagreed"* looks
identical to one. Candidate prefixes are therefore collected across the whole
file and only promoted to speakers if they read as a proper name or recur, so a
stray mid-sentence colon cannot invent a speaker.

The app reports what it decided in a banner on first open. To check a folder
without starting the server:

```bash
subtitle-search --dump-parse /path/to/recording-folder
```

It prints the speakers and cue counts, plus the part layout — which recording
starts at which session time, how long each runs, and how long each interruption
was. A wrong order or a wrong duration silently shifts every timestamp after it,
so that layout is the thing worth checking on real files.

## Other flags

```
--port N      default 8765
--host ADDR   default 127.0.0.1
--no-open     do not open a browser
```

## Anonymizing a set of interviews

`scripts/anonymize_zoom.py` takes a directory of downloaded Zoom folders and
writes anonymized copies. Each folder under the input path is one participant,
and **the folder's name is that participant's ID**.

```bash
python scripts/anonymize_zoom.py raw/ anonymized/ --dry-run   # look first
python scripts/anonymize_zoom.py raw/ anonymized/
```

Media is copied verbatim. Transcripts are rewritten with `Sireesh Gururaja` and
`Jordan Taylor` replaced by `interviewer`, and the participant replaced by the
folder name. Names found in *filenames* are replaced the same way.

Names come **only from speaker labels**. Nothing else is treated as a name, so
places, employers, and products survive untouched for a human pass to judge.
Replacement covers both the speaker attribution and the same names spoken in the
body of the transcript.

### Who gets which label

Every decision is made from one folder's own transcripts — nothing is inferred by
comparing folders — so a folder anonymizes the same way whether it runs alone or
alongside fifty others. Within a folder, speakers are labeled by the order they
first speak:

```
first speaker    -> interviewer 1
second speaker   -> the participant (the folder name)
third onwards    -> interviewer 2, interviewer 3, ...
```

That ordering assumes an interviewer opens. When it is wrong — the participant
spoke first, or a colleague joined before them — name the interviewers:

```bash
python scripts/anonymize_zoom.py raw/ anonymized/ --interviewer "Ada Lovelace"
```

Named speakers are interviewers wherever they fall, in every folder, and the
participant becomes the first speaker not named. Someone named but never speaking
is still replaced if they are mentioned aloud. Because labels are per-folder,
`interviewer 2` is not necessarily the same person across folders unless you name
them.

The dry run prints the mapping for every folder before anything is written, which
is the place to catch a folder where the order was guessed wrong.

### Leaving folders out

```bash
python scripts/anonymize_zoom.py raw/ anonymized/ --skip-single-speaker
```

A transcript with only one voice usually means the recording captured one side of
the call. The ordering rule would label that lone person the participant, which
is as likely to be the interviewer talking to themselves — so this leaves those
folders out entirely.

Labels are merged before counting, so a participant who rejoins as `Alex` after
being `Alex Chen` is one speaker, not two. An interrupted session is counted
across all its transcripts together, so a folder where each part has one speaker
but the parts differ is kept.

Excluding is not a failure: those folders are listed separately and the exit
status stays zero.

### What it refuses, and what it only reports

A folder produces **no output at all** rather than a partial result. Nothing is
written until every file in it has passed, so a refusal never leaves
half-anonymized files behind. A folder is refused when it has no transcript, when
its output folder already has files (use `--force`), or when every speaker was
named as an interviewer so no participant is left.

Everything else is reported under `REVIEW` and still written, since deciding it
needs a reader:

- a line that still looks like `Somebody: text` where `Somebody` was never
  detected as a speaker. Detection is deliberately conservative, so this catches
  both a faint name and an ordinary line like `Correction:`
- a first name that is also a common word

The exit status is non-zero if any folder was refused. Other folders still
process, so one bad folder does not stop the run.

### What never reaches the output

Chat logs, `_original.vtt` transcript backups, and any file type the script does
not specifically handle. Backups matter here: they hold the transcript as it
arrived, so copying one would reintroduce every name the pass just removed.
Everything skipped is reported by name, so nothing disappears quietly.

### Left for your pass

This is a first sweep over transcripts you are going to read anyway, not a
substitute for reading them.

Given names that are also ordinary words (`Mark`, `Summer`, `Rose`) are **not**
replaced when they appear alone, because doing so would corrupt normal sentences
— "please mark that down". The full name is still replaced, and the script prints
which single names it left behind so your own pass knows where to look.

Zoom display names are pulled apart before matching, so
`B.F. (Jim) Lightning, Brown U. USA` contributes `B.F. Lightning`, `Lightning`
and the nickname `Jim` as names to replace — but not `Brown` or `USA`, which are
affiliation and would otherwise be rewritten wherever those words appeared.
Pronoun tags like `(she/her)` are recognized as tags, not nicknames.

## Development

```bash
pip install -e '.[dev]'
pytest
```

Tests run against synthetic VTT fixtures in `tests/fixtures.py`, including the
mid-sentence-colon trap, CRLF endings, voice tags, speakerless transcripts, and
byte-exact HTTP Range serving.

## Not built yet

Multi-recording library search. The backend is already namespaced by recording
id with a registry, so adding it means writing a folder scanner and a fan-out
search — not restructuring.
