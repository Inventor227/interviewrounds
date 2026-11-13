# Props

The room's furniture is built in code, so this folder ships no third-party models or textures:

| Prop | Source |
|---|---|
| Table slab, preview table and legs | `web/src/xr/room.ts`, `web/src/xr/preview.ts` (boxes and cylinders) |
| Chairs (seat, back, gas column, five-spoke base) | `web/src/xr/room.ts`, merged into one mesh |
| Wall board frame and tray | `web/src/xr/wallboard.ts` |
| Preview room (walls, floor, window, trim, felt panels) | `web/src/xr/preview.ts` |
| Sheet paper texture | drawn on a canvas in `web/src/xr/room.ts` |
| Contact shadows | IWSDK `ContactShadow` (MIT) |
| Image based lighting | IWSDK `IBLTexture` "room" environment (three.js RoomEnvironment, MIT) |
| UI sounds | synthesized with Web Audio in `web/src/xr/sound.ts` |
| Panel font | Inter by Rasmus Andersson, SIL Open Font License 1.1, as MSDF atlases redistributed by `@pmndrs/msdfonts` (from Google Fonts) via UIKit |
| Stand-in people (preview and screenshots) | Microsoft Rocketbox avatars and animations, MIT licence; see `web/public/avatars/LICENSE.md` |

If a CC0 model replaces any of these later, add its name, author, source link and licence here.
