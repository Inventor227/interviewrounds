#!/usr/bin/env bash
# Builds the dev page's test voices with eSpeak NG (run in a throwaway Debian container, not on a laptop):
#   plan tooling: remote.sh <worktree> node --pull web/src/xr/avatar/dev/voice-f.wav --pull web/src/xr/avatar/dev/voice-m.wav \
#     -- 'bash web/src/xr/avatar/dev/make-voice.sh'
set -euo pipefail
cd "$(dirname "$0")"
apt-get -qq update >/dev/null && apt-get -qq install -y espeak-ng python3 >/dev/null
TEXT="Thanks for joining me today. Let's start with a design question. Imagine you are building a link shortener for a large social app. Walk me through the main parts of the system, and tell me how you would keep reads fast when traffic spikes. Take a moment to think, then go ahead whenever you are ready."
espeak-ng -v en-us+f3 -s 150 -p 55 -g 4 -w /tmp/f.wav "$TEXT"
espeak-ng -v en-us+m3 -s 150 -p 40 -g 4 -w /tmp/m.wav "$TEXT"
# 16 kHz mono 16-bit keeps the files small; audioop ships with Debian's Python 3.11.
python3 - <<'PY'
import audioop, wave
for s in 'fm':
    r = wave.open(f'/tmp/{s}.wav'); n = r.getnframes(); rate = r.getframerate(); data = r.readframes(n); r.close()
    data, _ = audioop.ratecv(data, 2, 1, rate, 16000, None)
    w = wave.open(f'voice-{s}.wav', 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(data); w.close()
    print(s, round(len(data) / 32000, 1), 's')
PY
