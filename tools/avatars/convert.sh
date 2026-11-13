#!/usr/bin/env bash
# Rocketbox -> GLB avatar pipeline.
#
#   tools/avatars/convert.sh [avatar ids...]      e.g. convert.sh f01   (default: all in sources.json)
#
# From a workstation it syncs tools/avatars to the build server, runs there, and copies the GLBs back to
# web/public/avatars and the manifest to tools/avatars. On the build server it runs everything inside a
# capped container (Blender 4.2 LTS headless, gltf-transform, KTX-Software); see Dockerfile.
#
# Environment:
#   AVATAR_HOST   ssh host of the build server (default: ioflood)
#   AVATAR_ROOT   work folder on the build server (default: /root/ir-dev/avatar)
set -euo pipefail

HOST="${AVATAR_HOST:-ioflood}"
ROOT="${AVATAR_ROOT:-/root/ir-dev/avatar}"
# The image tag is a hash of the Dockerfile (set on the build server), so Dockerfile edits always rebuild.
IMAGE=""
CONTAINER="ir-avatar-convert"
MIN_FREE_GB=60

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------- inside the container
if [[ "${AVATAR_STAGE:-}" == "container" ]]; then
  cd /work/tools
  [[ -d node_modules ]] || npm ci --no-audit --no-fund
  src=/work/src/rocketbox
  raw=/work/build/raw
  stage=/work/build/stage
  out=/work/out
  mkdir -p "$raw" "$stage" "$out"

  cfg() { node -e "const s=require('./sources.json'); $1"; }
  avatar_dir=$(cfg 'console.log(s.rocketbox.avatar_dir)')
  anim_dir=$(cfg 'console.log(s.rocketbox.anim_dir)')
  base_clip=$(cfg 'console.log(s.anim_base)')
  mapfile -t all_ids < <(cfg 's.avatars.forEach(a=>console.log(a.id))')
  if [[ $# -gt 0 ]]; then ids=("$@"); else ids=("${all_ids[@]}"); fi

  # Runs Blender and fails loudly: a non-zero exit or a missing "<MODE>_OK" line stops the run.
  blender_run() {
    local log status
    log=$(blender -b --factory-startup -P /work/tools/rb2glb.py -- "$@" 2>&1) && status=0 || status=$?
    grep -E '_OK|Error|Traceback|line [0-9]' <<<"$log" || true
    if (( status != 0 )) || ! grep -q '_OK' <<<"$log"; then
      echo "Blender failed (exit $status) for: $*" >&2
      tail -20 <<<"$log" >&2
      exit 1
    fi
  }

  sexes=()
  for id in "${ids[@]}"; do
    source_name=$(cfg "console.log(s.avatars.find(a=>a.id==='$id').source)")
    sex=$(cfg "console.log(s.avatars.find(a=>a.id==='$id').sex)")
    [[ " ${sexes[*]-} " == *" $sex "* ]] || sexes+=("$sex")
    echo "== $id ($source_name)"
    rm -f "$raw/$id.glb" "$raw/$id.json" "$out/$id.glb"
    blender_run avatar "$src/$avatar_dir/$source_name/Export/${source_name}_facial.fbx" \
      "$src/$avatar_dir/$source_name/Textures" "$raw/$id.glb" "$raw/$id.json"
    [[ -s "$raw/$id.glb" && -s "$raw/$id.json" ]] || { echo "Blender export failed for $id" >&2; exit 1; }
    node postprocess.mjs "$raw/$id.glb" "$stage/$id.post.glb" "$id"
    gltf-transform resize "$stage/$id.post.glb" "$stage/$id.r.glb" --width 1024 --height 1024
    gltf-transform etc1s "$stage/$id.r.glb" "$stage/$id.e.glb" --slots baseColorTexture --quality 192
    gltf-transform uastc "$stage/$id.e.glb" "$stage/$id.u.glb" --slots normalTexture --level 2 --zstd 18
    gltf-transform meshopt "$stage/$id.u.glb" "$out/$id.glb" --level medium
    rm -f "$stage/$id".{post,r,e,u}.glb
  done

  mapfile -t clips < <(cfg 's.clips.forEach(c=>console.log(c.id+" "+c.file+" "+(c.overlay?1:0)))')
  for sex in "${sexes[@]}"; do
    ref=$(cfg "console.log(s.avatars.find(a=>a.sex==='$sex').id)")
    args=()
    for line in "${clips[@]}"; do
      read -r cid cfile overlay <<<"$line"
      glb="$raw/clip_${sex}_${cid}.glb"
      echo "== clip ${sex}_${cfile}"
      rm -f "$glb"
      blender_run clip "$src/$anim_dir/${sex}_${cfile}.max.fbx" "$cid" "$glb"
      [[ -s "$glb" ]] || { echo "Blender export failed for clip ${sex}_${cfile}" >&2; exit 1; }
      [[ "$overlay" == 1 ]] && args+=("$cid=$glb@overlay") || args+=("$cid=$glb")
    done
    [[ -s "$out/$ref.glb" ]] || { echo "reference avatar $ref.glb missing; convert it first" >&2; exit 1; }
    rm -f "$out/anims-$sex.glb"
    node build-anims.mjs "$out/anims-$sex.glb" "$out/$ref.glb" "$base_clip" "${args[@]}"
  done

  # One manifest, written twice with identical bytes: tools/avatars (pipeline record) and
  # web/public/avatars (what the app fetches as /avatars/manifest.json). Avatars not converted in this
  # run keep their entry from the existing manifest; a run that would drop an avatar is refused.
  node make-manifest.mjs "$raw" "$out" /work/tools/manifest.json "$out/manifest.json"
  node verify.mjs --dir "$out" --manifest /work/tools/manifest.json
  ls -la "$out"
  exit 0
fi

# ---------------------------------------------------------------- on the build server
if [[ "${AVATAR_STAGE:-}" == "server" ]]; then
  free_gb=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
  if (( free_gb < MIN_FREE_GB )); then
    echo "refusing: only ${free_gb} GB free on / (need ${MIN_FREE_GB})" >&2
    exit 1
  fi
  mkdir -p "$ROOT/src" "$ROOT/build" "$ROOT/out"
  IMAGE="ir-avatar:$(sha256sum "$ROOT/tools/Dockerfile" | cut -c1-12)"
  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    # BuildKit ignores --cpu-quota/--memory, so use the classic builder, which applies them to each RUN step.
    DOCKER_BUILDKIT=0 docker build --cpu-period 100000 --cpu-quota 600000 --memory 6g --memory-swap 6g \
      -t "$IMAGE" - <"$ROOT/tools/Dockerfile"   # no build context: the Dockerfile copies nothing
  fi
  commit=$(grep -o '"commit": *"[0-9a-f]*"' "$ROOT/tools/sources.json" | grep -o '[0-9a-f]\{40\}')
  if [[ ! -d "$ROOT/src/rocketbox/.git" ]]; then
    # Sparse, blob-less clone: only the six avatars and the seated clips are downloaded (~0.8 GB, not the full repo).
    docker run --rm --name "$CONTAINER-fetch" --cpus 6 --memory 6g -v "$ROOT:/work" -w /work/src "$IMAGE" bash -c "
      git clone --filter=blob:none --no-checkout --sparse https://github.com/microsoft/Microsoft-Rocketbox.git rocketbox &&
      cd rocketbox && git sparse-checkout set --no-cone /LICENSE.md \
        \$(node -e \"const s=require('/work/tools/sources.json');for(const a of s.avatars)console.log('/'+s.rocketbox.avatar_dir+'/'+a.source+'/')\") \
        \$(node -e \"const s=require('/work/tools/sources.json');for(const c of s.clips)console.log('/'+s.rocketbox.anim_dir+'/[fm]_'+c.file+'.max.fbx')\") &&
      git checkout $commit"
  fi
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker run --rm --name "$CONTAINER" --cpus 6 --memory 6g -e AVATAR_STAGE=container \
    -v "$ROOT:/work" "$IMAGE" bash /work/tools/convert.sh "$@"
  exit 0
fi

# ---------------------------------------------------------------- on the workstation
repo="$(cd "$here/../.." && pwd)"
rsync -a --delete --exclude node_modules "$here/" "$HOST:$ROOT/tools/"
ssh "$HOST" "AVATAR_STAGE=server AVATAR_ROOT=$ROOT bash $ROOT/tools/convert.sh $*"
mkdir -p "$repo/web/public/avatars"
rsync -a --include '*.glb' --include manifest.json --exclude '*' "$HOST:$ROOT/out/" "$repo/web/public/avatars/"
rsync -a "$HOST:$ROOT/tools/manifest.json" "$here/manifest.json"
echo "avatars copied to $repo/web/public/avatars"
