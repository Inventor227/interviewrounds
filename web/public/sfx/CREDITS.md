# Sound credits

## Recorded (Kenney, CC0)

Six UI sounds are recordings by Kenney (www.kenney.nl), released under Creative Commons Zero (CC0 1.0,
https://creativecommons.org/publicdomain/zero/1.0/). Credit is not required; we give it anyway.

Each file was trimmed, filtered (high pass, some low pass), faded, normalised (peak -24 dBFS, the chime -20 dBFS) and
encoded as Ogg Opus, mono, 48 kHz, 48 kbps.

| File | Used for | Source file | Pack | Source page | Author | Licence |
| --- | --- | --- | --- | --- | --- | --- |
| `click.ogg` | presses | `select_002.ogg` | Interface Sounds 1.0 | https://opengameart.org/content/interface-sounds | Kenney | CC0 1.0 |
| `flap.ogg` | the sheet lands | `card-place-4.ogg` | Casino Audio | https://opengameart.org/content/54-casino-sound-effects-cards-dice-chips | Kenney | CC0 1.0 |
| `chime.ogg` | the scorecard is ready | `confirmation_001.ogg` | Interface Sounds 1.0 | https://opengameart.org/content/interface-sounds | Kenney | CC0 1.0 |
| `snap.ogg` | a card snaps into place | `card-place-1.ogg` | Casino Audio | https://opengameart.org/content/54-casino-sound-effects-cards-dice-chips | Kenney | CC0 1.0 |
| `pen.ogg` | a stroke starts | `scratch_004.ogg` | Interface Sounds 1.0 | https://opengameart.org/content/interface-sounds | Kenney | CC0 1.0 |
| `erase.ogg` | something goes in the bin | `cloth4.ogg` | RPG Audio (50 RPG sound effects) | https://opengameart.org/content/50-rpg-sound-effects | Kenney | CC0 1.0 |

## Generated (ElevenLabs)

Six round cues were made with ElevenLabs sound generation (`POST /v1/sound-generation`, default model, prompt influence
0.7) on our paid plan, November 2026. Under the ElevenLabs Terms of Use, paid subscribers may use the service
commercially and keep all rights in their output; other users may receive similar output. Three takes per sound
(1.0 s for start and chime, 0.5 s for the rest), the best one by measurement kept. All 24 takes together moved the
account balance by 84 credits (the published price, 40 credits per second, would have been 600).

Each pick was high passed, trimmed, faded, normalised (peak -24 dBFS, start -20 dBFS) and encoded as Ogg Opus, mono,
48 kHz, 48 kbps.

| File | Used for | Take | Prompt | Why this take |
| --- | --- | --- | --- | --- |
| `start.ogg` | a round begins | 2 of 3 | Soft warm two-note chime rising gently, calm minimal UI sound for a session starting, clean, no reverb tail | clear two notes C5 to E5, softest onset (78 ms), clean floor; take 3 was one note |
| `tick.ogg` | time check | 3 of 3 | Single very soft wooden tick, subtle quiet UI click, dry, no echo | warm 63 ms wooden tock (centroid 0.65 kHz); takes 1 and 2 were bright (3.7 to 4.7 kHz) |
| `ghost.ogg` | a suggestion appears | 3 of 3 | Soft gentle bubble pop, subtle quiet UI sound for a suggestion appearing, dry | a 46 ms rising pop (470 to 840 Hz); takes 1 and 2 were long hums or mostly sub bass |
| `handover.ogg` | one interviewer hands over to another | 3 of 3 | Very subtle soft fabric whoosh, gentle quiet movement sound, dry, no music | soft whoosh with enough mid range (centroid 0.54 kHz) for headset speakers; take 1 was sub bass, take 2 mostly below 300 Hz |
| `pause.ogg` | the round pauses | 3 of 3 | Soft muted two-tone descending UI sound, gentle and quiet, dry | smooth muted fall (370 to 290 Hz), cleanest floor; takes 1 and 2 were noisier and wandered |
| `resume.ogg` | the round resumes | 2 of 3 | Soft muted two-tone ascending UI sound, gentle and quiet, dry | smooth muted rise (205 to 260 Hz) that mirrors pause; take 1 rose then dropped, take 3 dipped first |

Also generated and not used: three `chime` takes (prompt: Warm soft two-note marimba chime, gentle and pleasant
notification that a report is ready, clean, short decay) and three `pen` takes (prompt: Felt-tip marker
tapping once on paper, single short soft tick, dry, close). The Kenney chime and pen were kept: no chime
take was clearly better (two were one note or did not decay within 1 s), and every pen take swelled slowly (attack
230 to 290 ms) and was very bright (centroid 7 to 8 kHz).
