#!/usr/bin/env python3
"""Synthesizes the candidate's lines in fish-lines.json into e2e/voice/<id>.wav with macOS `say`.

The real-voice emulator runs (fish-round.mjs) play them into the page's microphone, so the voice service hears
speech, finds the end of each turn itself and transcribes it. Run on the Mac from web/: python3 e2e/make-voice.py
"""
import json
import os
import subprocess

here = os.path.dirname(os.path.abspath(__file__))
lines = json.load(open(os.path.join(here, 'fish-lines.json')))
os.makedirs(os.path.join(here, 'voice'), exist_ok=True)
for kind in ('behavioral', 'design', 'meeting'):
    for line in lines[kind]:
        out = os.path.join(here, 'voice', f"{line['id']}.wav")
        subprocess.run(
            ['say', '-v', lines['voice'], '-r', str(lines['rate']), '-o', out,
             '--file-format=WAVE', '--data-format=LEI16@24000', line['text']],
            check=True,
        )
        secs = (os.path.getsize(out) - 44) / 48000
        print(f"{line['id']}: {secs:.1f} s")
