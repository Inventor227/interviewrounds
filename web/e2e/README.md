# Emulator scripts

End to end checks, screenshots and measurements that drive the app in the IWSDK emulator (IWER, Meta Quest 3 by
default) with its managed headless browser. They are not part of `npm test`.

How a run works:

1. Start the app's dev server with the emulator in agent mode: `npx @iwsdk/cli dev up --ai-mode agent
   --allow-browser-automation` in `web/`. Pick the device and room in `iwsdk.config.json`
   (`dev.emulator.device`, `dev.emulator.environment`). Scripts that need a round talk to a running server: set
   `IR_API_ORIGIN` to its origin (the dev server proxies `/api`, `/ws`, `/v1` and `/s` there) and `DEV_KEY` to its
   development key (the typed-turn voice needs it).
2. Put a small helper module, `emu-lib.mjs`, next to the script. The scripts import from it: `waitReady()` (the
   managed browser is up), `enterXR()` (accept the offered XR session), `screenshot(name, input?)` (an
   `iwsdk browser screenshot` into `$EMU_SHOTS`, retried when the browser restarts), `call(domain, action, input)`
   and `iwsdk(...args)` (any IWSDK CLI action), and `sleep(ms)`.
3. Run the script with Node from the app folder, with `EMU_SHOTS` (where captures and JSON go), `EMU_APP_DIR` (the
   app folder) and, where a header says so, `EMU_ROOM` and the script's own variables. Then `iwsdk dev down`.

The emulator renders in software: give it several CPU cores, and expect a capture inside an XR session to take tens of
seconds. Screens are fine for layout, rooms and draw-call counts, not for frame rate.

Each script's header says what it checks, the viewport it expects (512x512 when none is given), the room, the
variables it reads and roughly how long a run takes.
