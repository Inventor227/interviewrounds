# Build image for the avatar pipeline: Blender 4.2 LTS (headless), KTX-Software, gltf-transform.
FROM node:22-bookworm

ARG BLENDER_VERSION=4.2.23
ARG KTX_VERSION=4.4.2
ARG GLTF_TRANSFORM_VERSION=4.5.1

RUN apt-get update && apt-get install -y --no-install-recommends \
      xz-utils ca-certificates curl git \
      libx11-6 libxi6 libxxf86vm1 libxfixes3 libxrender1 libxkbcommon0 libsm6 libice6 \
      libgl1 libegl1 libglu1-mesa libxext6 libxrandr2 libxinerama1 libxcursor1 \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://download.blender.org/release/Blender4.2/blender-${BLENDER_VERSION}-linux-x64.tar.xz" \
      | tar -xJ -C /opt \
    && ln -s "/opt/blender-${BLENDER_VERSION}-linux-x64/blender" /usr/local/bin/blender

RUN curl -fsSL -o /tmp/ktx.deb \
      "https://github.com/KhronosGroup/KTX-Software/releases/download/v${KTX_VERSION}/KTX-Software-${KTX_VERSION}-Linux-x86_64.deb" \
    && apt-get update && apt-get install -y --no-install-recommends /tmp/ktx.deb \
    && rm -rf /tmp/ktx.deb /var/lib/apt/lists/*

RUN npm install -g "@gltf-transform/cli@${GLTF_TRANSFORM_VERSION}"

WORKDIR /work
