"""Synthetic VTT fixtures.

All content here is invented for testing. No real recordings are used.
"""

# The primary Zoom shape: speaker inlined in the payload as "Name: text".
COLON_PREFIX = """WEBVTT

1
00:00:02.180 --> 00:00:12.020
Dana Whitfield: Cool. And then I will share my screen briefly, to show you a bit of a demo.

2
00:00:13.270 --> 00:00:17.390
Dana Whitfield: So, let me share my screen.

3
00:00:19.880 --> 00:00:22.160
Dana Whitfield: There are so many buttons here now.

4
00:00:23.100 --> 00:00:27.400
Rafael Ortiz: I can see it. Looks good on my end.

5
00:00:28.000 --> 00:00:31.900
Dana Whitfield: Great, thanks for confirming.
"""

# The trap: a colon inside an ordinary sentence must not become a speaker.
COLON_IN_SENTENCE = """WEBVTT

1
00:00:01.000 --> 00:00:05.000
Dana Whitfield: So here's my whole point: I disagreed with the framing.

2
00:00:05.500 --> 00:00:09.000
Dana Whitfield: And that matters because of one thing: nobody asked.

3
00:00:09.500 --> 00:00:12.000
Rafael Ortiz: Fair enough.
"""

# A prefix that recurs but is not name-shaped should still be rejected on shape.
TRICKY_PREFIXES = """WEBVTT

1
00:00:01.000 --> 00:00:04.000
Well here's the thing: I never agreed to that.

2
00:00:04.500 --> 00:00:08.000
Well here's the thing: I still do not agree.
"""

VOICE_TAG = """WEBVTT

1
00:00:01.000 --> 00:00:04.000
<v Dana Whitfield>Let me pull up the document.

2
00:00:04.500 --> 00:00:08.000
<v Dana Whitfield>It should be in the shared folder.

3
00:00:08.500 --> 00:00:11.000
<v Rafael Ortiz>Found it.
"""

NO_SPEAKER = """WEBVTT

1
00:00:01.000 --> 00:00:04.000
The first thing to note is the timing.

2
00:00:04.200 --> 00:00:07.000
It runs faster than we expected.

3
00:00:20.000 --> 00:00:24.000
After a long pause, a separate thought entirely.
"""

# Windows line endings, no cue numbers, and a NOTE block to skip.
CRLF_NO_NUMBERS = (
    "WEBVTT\r\n"
    "\r\n"
    "NOTE this block should be ignored\r\n"
    "\r\n"
    "00:00:01.000 --> 00:00:04.000\r\n"
    "Dana Whitfield: First line of the transcript.\r\n"
    "\r\n"
    "00:00:04.500 --> 00:00:08.000\r\n"
    "Rafael Ortiz: Second line of the transcript.\r\n"
)

# One long turn broken by a pause, with a second speaker after it so that
# joining applies at all -- a transcript with a single speaker is deliberately
# never joined, since that label carries no information.
LONG_TURN_WITH_PAUSE = """WEBVTT

1
00:00:01.000 --> 00:00:05.000
Dana Whitfield: I want to walk through the background first.

2
00:00:05.100 --> 00:00:09.000
Dana Whitfield: The project started about a year ago.

3
00:00:16.000 --> 00:00:20.000
Dana Whitfield: Anyway, that is the context you need.

4
00:00:21.000 --> 00:00:24.000
Rafael Ortiz: Understood, thanks.
"""

# Payload wrapped across two lines within one cue.
MULTILINE_PAYLOAD = """WEBVTT

1
00:00:01.000 --> 00:00:06.000
Dana Whitfield: This sentence was wrapped
across two lines by the exporter.
"""
