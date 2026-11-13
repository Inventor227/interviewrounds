# Avatar licence

The avatars and animations in this folder are converted from the Microsoft Rocketbox library:
https://github.com/microsoft/Microsoft-Rocketbox (commit 0943055db6ec570bcef9f2c8b41c9e5467c808f9).

| File | Rocketbox source |
|---|---|
| `f01.glb` | `Assets/Avatars/Professions/Business_Female_01` |
| `f02.glb` | `Assets/Avatars/Professions/Business_Female_02` |
| `f03.glb` | `Assets/Avatars/Professions/Business_Female_03` |
| `m02.glb` | `Assets/Avatars/Professions/Business_Male_02` |
| `m04.glb` | `Assets/Avatars/Professions/Business_Male_04` |
| `m05.glb` | `Assets/Avatars/Professions/Business_Male_05` |
| `anims-f.glb`, `anims-m.glb` | `Assets/Animations/all_animations_max_motextr_static` (seated and listening clips) |

Changes: converted from FBX to glTF binary, face shapes renamed to ARKit and Oculus viseme names and reduced
to the ones used here, textures resized to 1024 px and compressed to KTX2, geometry compressed with meshopt,
clips merged into one skeleton-only file per body type. The conversion scripts are in `tools/avatars/`.

The Rocketbox library is published under the MIT licence:

```
MIT License

Copyright (c) 2020 Microsoft

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The Rocketbox avatars were created by Rocketbox Studios GmbH and released by Microsoft.
