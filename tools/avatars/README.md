# Avatar pipeline (Rocketbox to GLB)

`convert.sh [ids...]` turns the Rocketbox `Business_*` avatars and seated clips listed in `sources.json` into the
GLBs and `manifest.json` under `web/public/avatars/`. It runs on the build server inside a capped container
(Blender 4.2 LTS, gltf-transform, KTX-Software; see `Dockerfile`) and copies the results back.

## Build server folder

Everything the pipeline keeps on the server lives in `/root/ir-avatar-work/` (override with `AVATAR_ROOT`):

| Path | What |
|---|---|
| `src/rocketbox/` | sparse, blob-less clone of the Rocketbox repo at the pinned commit (about 825 MB) |
| `tools/` | synced copy of this folder, plus its `node_modules` |
| `build/` | scratch, deleted after a run |
| `out/` | the GLBs and manifest of the last run |

Keep this folder outside any folder that another tool mirrors with `rsync --delete` (such as a synced copy of the
repository), or the next sync wipes it. `AVATAR_HOST` names the build server's ssh host.

## Preview screenshots

```
ssh "$AVATAR_HOST" 'docker run --rm --name ir-avatar-shots --cpus 6 --memory 6g --ipc=host -v /root/ir-avatar-work:/work \
  -w /work/tools/preview mcr.microsoft.com/playwright:v1.64.1-noble \
  bash -c "npm ci && node shots.mjs /work/out /work/tools/manifest.json /work/build/shots"'
```
