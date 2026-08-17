"""Measuring where each word actually falls in the audio.

This is forced alignment, not transcription. The text is an *input*: the words
come from the transcript -- Zoom's, with whatever corrections have been made to
it -- and what comes back is only timing. Nothing here can change a word, which
is the whole reason it is safe to run against a folder that already has quotes
saved in it. Re-transcribing would hand back a different set of words and strand
every anchor pointing into the old ones.

The method is standard CTC forced alignment. An acoustic model emits, for each
20ms frame of audio, a probability over characters; the transcript is turned into
the character sequence it must have produced; and a Viterbi pass finds the
highest-scoring assignment of frames to characters. Word boundaries fall out of
which frames were assigned to which word's characters.

Two consequences worth knowing. It runs on a **window** of audio rather than the
whole recording -- the trellis is frames by characters, so an hour in one pass is
a memory problem, while a single caption is nothing. And it is *forced*: given
audio and text that disagree, it still returns an alignment, just a poor one. So
windows are anchored on Zoom's caption boundaries, which are trustworthy even
where its interior timing is not.

The model is downloaded once and then runs locally, on this machine, in this
process. Audio is read with ffmpeg and never leaves.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

from .timings import TimedWord, normalize_word, split_words

#: An English CTC model with a character vocabulary, which is what forced
#: alignment needs -- a subword or word-piece vocabulary cannot place a boundary
#: inside a token. Overridable for anyone who wants a different language.
MODEL_NAME = os.environ.get("SUBTITLE_SEARCH_ALIGN_MODEL", "facebook/wav2vec2-base-960h")

SAMPLE_RATE = 16000

#: Zoom clips words at caption boundaries, so the window reaches slightly past
#: both ends. The extra audio is only context; timings outside the caption are
#: discarded.
WINDOW_PAD = 0.4

#: Alignment quality collapses when the text and the audio have drifted apart,
#: and a very long window makes that more likely while also being slower. Longer
#: requests are aligned caption by caption instead.
MAX_WINDOW = 30.0


class AlignmentError(RuntimeError):
    """Raised when alignment cannot be performed or produced nothing usable."""


def ffmpeg_path() -> str | None:
    return shutil.which("ffmpeg")


def available() -> tuple[bool, str]:
    """Whether alignment can run here, and if not, what is missing."""
    if ffmpeg_path() is None:
        return False, "ffmpeg is not on PATH; alignment needs it to read the audio"
    try:
        import torch  # noqa: F401
        import transformers  # noqa: F401
    except ImportError:
        return False, "install the 'align' extra to measure word timings"
    return True, ""


def read_window(media_path: Path, start: float, duration: float):
    """Decode a slice of the recording to mono 16kHz samples.

    ffmpeg seeks accurately on the input side by default, so pulling ten seconds
    out of a two-hour file costs about as much as those ten seconds.
    """
    binary = ffmpeg_path()
    if binary is None:
        raise AlignmentError("ffmpeg is not on PATH")

    command = [
        binary,
        "-nostdin",
        "-loglevel", "error",
        "-ss", f"{max(0.0, start):.3f}",
        "-i", str(media_path),
        "-t", f"{max(0.05, duration):.3f}",
        "-vn",
        "-ac", "1",
        "-ar", str(SAMPLE_RATE),
        "-f", "f32le",
        "-",
    ]
    try:
        finished = subprocess.run(command, capture_output=True, check=False, timeout=180)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise AlignmentError(f"could not read the audio: {exc}") from exc
    if finished.returncode != 0:
        detail = finished.stderr.decode("utf-8", "replace").strip().splitlines()
        raise AlignmentError(f"could not read the audio: {detail[-1] if detail else 'ffmpeg failed'}")

    import numpy as np

    audio = np.frombuffer(finished.stdout, dtype=np.float32)
    if audio.size < SAMPLE_RATE // 20:  # under 50ms of audio is not worth aligning
        raise AlignmentError("that stretch of the recording has no audio in it")
    return audio


class Aligner:
    """The acoustic model, loaded once and reused."""

    def __init__(self, model_name: str = MODEL_NAME):
        self.model_name = model_name
        self._model = None
        self._processor = None
        self._vocab: dict[str, int] = {}

    def load(self) -> None:
        if self._model is not None:
            return
        ok, why = available()
        if not ok:
            raise AlignmentError(why)
        try:
            import torch
            from transformers import AutoModelForCTC, AutoProcessor
        except ImportError as exc:  # pragma: no cover - guarded by available()
            raise AlignmentError(str(exc)) from exc

        try:
            self._processor = AutoProcessor.from_pretrained(self.model_name)
            model = AutoModelForCTC.from_pretrained(self.model_name)
        except Exception as exc:  # network, disk, or a renamed model
            raise AlignmentError(
                f"could not load the alignment model {self.model_name}: {exc}"
            ) from exc

        model.eval()
        torch.set_grad_enabled(False)
        self._model = model
        self._vocab = {
            token.lower(): index
            for token, index in self._processor.tokenizer.get_vocab().items()
        }
        if "|" not in self._vocab:
            raise AlignmentError(
                f"{self.model_name} has no word-delimiter token; it cannot be used to align"
            )

    @property
    def blank_id(self) -> int:
        pad = self._processor.tokenizer.pad_token
        return self._vocab.get((pad or "<pad>").lower(), 0)

    def emissions(self, audio):
        """Per-frame log probabilities over the character vocabulary."""
        import torch

        inputs = self._processor(
            audio, sampling_rate=SAMPLE_RATE, return_tensors="pt", padding=False
        )
        values = inputs.input_values
        with torch.inference_mode():
            logits = self._model(values).logits
        return torch.log_softmax(logits, dim=-1)[0].cpu().numpy()

    def align(self, audio, words: list[str]) -> list[tuple[int, float, float]]:
        """Place ``words`` in ``audio``. Returns ``(word position, start, end)``.

        Positions index into ``words`` as given; a word the model has no
        characters for is simply absent from the result, and the caller falls
        back to interpolating across it.
        """
        self.load()

        # Build the character sequence the audio must have produced, remembering
        # which word each character belongs to so boundaries can be read back out.
        tokens: list[int] = []
        owners: list[int] = []
        separator = self._vocab["|"]
        for position, word in enumerate(words):
            characters = [self._vocab[c] for c in normalize_word(word) if c in self._vocab]
            if not characters:
                continue
            if tokens:
                tokens.append(separator)
                owners.append(-1)
            tokens.extend(characters)
            owners.extend([position] * len(characters))
        if not tokens:
            return []

        emission = self.emissions(audio)
        if emission.shape[0] < len(tokens):
            # Fewer frames than characters: no assignment exists. Better to
            # report nothing than to return a confidently wrong alignment.
            return []

        assignment, spoken = _viterbi(emission, tokens, self.blank_id)
        seconds_per_frame = (len(audio) / emission.shape[0]) / SAMPLE_RATE

        spans: dict[int, list[int]] = {}
        for frame, token_index in enumerate(assignment):
            owner = owners[token_index]
            # Frames the model called silence sit *on* a character without being
            # it. Counting them would stretch the first word back over the pad.
            if owner < 0 or not spoken[frame]:
                continue
            bounds = spans.setdefault(owner, [frame, frame])
            bounds[1] = frame

        return [
            (position, first * seconds_per_frame, (last + 1) * seconds_per_frame)
            for position, (first, last) in sorted(spans.items())
        ]


def _viterbi(emission, tokens: list[int], blank_id: int):
    """Assign every audio frame to a character of the transcript.

    The standard CTC alignment recursion: at each frame a character either
    continues -- repeated, or covered by a blank -- or the next one begins, and
    the best-scoring route through that lattice is the alignment.

    Returns the token index assigned to each frame, and whether that frame was
    the character being *spoken* rather than a blank resting on it. The second
    array is what keeps a word's span off the silence around it.
    """
    import numpy as np

    frames = emission.shape[0]
    count = len(tokens)
    token_ids = np.asarray(tokens)

    # trellis[t, j]: best score for having consumed tokens 0..j by frame t.
    trellis = np.full((frames, count), -np.inf, dtype=np.float64)
    trellis[0, 0] = emission[0, token_ids[0]]

    # Walked back to recover the route: did token j begin at this frame, and was
    # the frame spent on its character or on a blank?
    advanced = np.zeros((frames, count), dtype=bool)
    voiced = np.zeros((frames, count), dtype=bool)
    voiced[0, 0] = True

    for t in range(1, frames):
        blank = trellis[t - 1] + emission[t, blank_id]
        repeat = trellis[t - 1] + emission[t, token_ids]
        stay = np.maximum(blank, repeat)
        step = np.full(count, -np.inf)
        step[1:] = trellis[t - 1, :-1] + emission[t, token_ids[1:]]

        advanced[t] = step > stay
        voiced[t] = np.where(advanced[t], True, repeat > blank)
        trellis[t] = np.where(advanced[t], step, stay)

    assignment = np.zeros(frames, dtype=np.int64)
    spoken = np.zeros(frames, dtype=bool)
    j = count - 1
    for t in range(frames - 1, -1, -1):
        assignment[t] = j
        spoken[t] = voiced[t, j]
        if j > 0 and advanced[t, j]:
            j -= 1
    return assignment, spoken


#: One model per process. Loading costs seconds and hundreds of megabytes; the
#: reader aligns a caption at a time, so it has to survive between requests.
_shared = Aligner()


def align_cues(media_path: Path, targets, base: float) -> list[TimedWord]:
    """Measure the words of some captions from one part.

    ``targets`` are ``(cue, first_word_index)`` pairs, where the index is the
    caption's position in the *part's* word sequence -- the address the timings are
    stored under. It is passed in rather than counted here because a caller
    aligning a handful of captions out of the middle of a session cannot have it
    counted from the handful.

    Cues carry *session* times; ``base`` is where the part starts, so windows and
    results are in the media file's own timeline. Each caption is aligned in its
    own window: it keeps the trellis small, keeps one bad caption from spoiling
    its neighbours, and lets a caller stop partway and keep what was measured.
    """
    measured: list[TimedWord] = []
    for cue, start_index in targets:
        words = split_words(cue.text)
        if not words:
            continue

        start = max(0.0, cue.start - base - WINDOW_PAD)
        duration = min(MAX_WINDOW, (cue.end - cue.start) + WINDOW_PAD * 2)
        try:
            audio = read_window(media_path, start, duration)
            placed = _shared.align(audio, [word for _, _, word in words])
        except AlignmentError:
            # One unreadable or unalignable caption should not abandon the rest.
            continue

        for offset, word_start, word_end in placed:
            absolute_start = start + word_start
            absolute_end = start + word_end
            measured.append(
                TimedWord(
                    index=start_index + offset,
                    word=normalize_word(words[offset][2]),
                    start=absolute_start,
                    end=max(absolute_start, absolute_end),
                )
            )
    return measured
