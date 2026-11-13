# Build image for the avatar pipeline: Blender 4.2 LTS (headless), KTX-Software, gltf-transform.
# convert.sh tags the image with a hash of this file, so any edit here builds a new image.
FROM node:22-bookworm@sha256:0e5f906573693feaa1e21057ebdcfdb5bd5021f050b2dc7c9deceb629c7da2a8

ARG BLENDER_VERSION=4.2.23
ARG BLENDER_SHA256=bea0eb3146be13eae6225409a117b215184f41b7f79e799f97cb3abb8f6dc404
ARG KTX_VERSION=4.4.2
ARG KTX_SHA256=ca635ed489d8bf54fac8d7687056c651193de0740830a7738cc034adc63e3027
ARG GLTF_TRANSFORM_VERSION=4.5.1

RUN apt-get update && apt-get install -y --no-install-recommends \
      xz-utils ca-certificates curl git \
      libx11-6 libxi6 libxxf86vm1 libxfixes3 libxrender1 libxkbcommon0 libsm6 libice6 \
      libgl1 libegl1 libglu1-mesa libxext6 libxrandr2 libxinerama1 libxcursor1 \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /tmp/blender.tar.xz \
      "https://download.blender.org/release/Blender4.2/blender-${BLENDER_VERSION}-linux-x64.tar.xz" \
    && echo "${BLENDER_SHA256}  /tmp/blender.tar.xz" | sha256sum -c - \
    && tar -xJf /tmp/blender.tar.xz -C /opt && rm /tmp/blender.tar.xz \
    && ln -s "/opt/blender-${BLENDER_VERSION}-linux-x64/blender" /usr/local/bin/blender

RUN curl -fsSL -o /tmp/ktx.deb \
      "https://github.com/KhronosGroup/KTX-Software/releases/download/v${KTX_VERSION}/KTX-Software-${KTX_VERSION}-Linux-x86_64.deb" \
    && echo "${KTX_SHA256}  /tmp/ktx.deb" | sha256sum -c - \
    && apt-get update && apt-get install -y --no-install-recommends /tmp/ktx.deb \
    && rm -rf /tmp/ktx.deb /var/lib/apt/lists/*

RUN npm install -g "@gltf-transform/cli@${GLTF_TRANSFORM_VERSION}"

WORKDIR /work
