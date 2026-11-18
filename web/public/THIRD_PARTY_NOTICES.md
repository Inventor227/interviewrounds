# Third-party notices

Third-party code and assets that this app serves to the browser for the avatar runtime and the controllers, with
their licences.
Rocketbox avatars and animations have their own notice in `avatars/LICENSE.md`.

## HeadAudio

`@met4citizen/headaudio` 1.0.0, audio-driven viseme detection (bundled: the HeadAudio node, its worklet and the
`model-en-mixed.bin` viseme model). https://github.com/met4citizen/HeadAudio

```
MIT License

Copyright (c) 2025 Mika Suominen

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

## three.js

`three` (super-three 0.185.0), 3D engine, including the GLTFLoader and KTX2Loader add-ons. https://threejs.org

```
The MIT License

Copyright © 2010-2026 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## meshoptimizer decoder

`meshopt_decoder.module.js` as shipped in three.js `examples/jsm/libs/`, decodes the avatars' compressed geometry.
https://github.com/zeux/meshoptimizer

```
MIT License

Copyright (c) 2016-2026 Arseny Kapoulkine

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

## Basis Universal transcoder

`vendor/basis/basis_transcoder.js` and `vendor/basis/basis_transcoder.wasm`, unmodified copies of three.js's build,
transcode the avatars' KTX2 textures. Copyright Binomial LLC, licensed under the Apache License, Version 2.0. The
full licence text is in `vendor/basis/LICENSE`. https://github.com/BinomialLLC/basis_universal

## Inter

The pages use Inter 4.0 by Rasmus Andersson and the Inter Project Authors, cut to a Latin subset and served from this
site as WOFF2. Licensed under the SIL Open Font License, Version 1.1; the full text is in the source at
`web/src/app/fonts/Inter-LICENSE.txt`. https://github.com/rsms/inter

## UI sounds

Six sounds in `sfx/` (`click`, `flap`, `chime`, `snap`, `pen`, `erase`) are edited recordings by Kenney
(www.kenney.nl) from the packs Interface Sounds 1.0, Casino Audio and RPG Audio, released under Creative Commons
Zero (CC0 1.0). https://creativecommons.org/publicdomain/zero/1.0/

Six round cues in `sfx/` (`start`, `tick`, `ghost`, `handover`, `pause`, `resume`) were made with ElevenLabs sound
generation on a paid plan in November 2026 and then edited. Under the ElevenLabs Terms of Use paid subscribers may
use the output commercially and keep all rights in it.

The source file, pack and page of each recording, and the prompt and take of each generated cue, are listed in
`sfx/CREDITS.md`.

## WebXR input profiles: Meta Quest Touch Plus controller models and the hand model

`vendor/input-profiles/meta-quest-touch-plus/left.glb` and `right.glb`, from `@webxr-input-profiles/assets` 1.0.20
(`dist/profiles/meta-quest-touch-plus/`), shown when the user holds controllers.
`vendor/input-profiles/generic-hand/left.glb` and `right.glb`, from the same package and version
(`dist/profiles/generic-hand/`), drawn over the user's tracked hands.
https://github.com/immersive-web/webxr-input-profiles

```
MIT License

Copyright (c) 2019 Amazon

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is furnished
to do so, subject to the following conditions:

The above copyright notice and this permission notice (including the next
paragraph) shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS
OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF
OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
