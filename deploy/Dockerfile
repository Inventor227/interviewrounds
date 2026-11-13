# Interview Rounds: one image with the Rust server and the built web app.
#
# Build from the repository root (the context must be a clean export such as
# `git archive`, so target/ and node_modules/ are never sent):
#   DOCKER_BUILDKIT=0 docker build -f deploy/Dockerfile -t ir-app:<sha> .
#
# Written for the classic builder (so --memory and --cpu-quota apply): no syntax
# line, no cache mounts, no heredocs.
#
# web/ and content/ are optional. If web/package.json is missing the image ships
# with an empty public dir (the server still runs and /healthz works); if content/
# is missing the content dir is empty. The `src` stage creates both folders so
# the later COPY steps never fail.
#
# The Rust stages come first: the classic builder runs every stage before the
# target, so `--target deps` (the cached dependency layer) skips the web build.

# ---- Rust: cargo-chef ----
FROM rust:1.99.1-slim-bookworm AS chef
RUN cargo install cargo-chef --version 0.1.78 --locked
WORKDIR /app/server

FROM chef AS planner
COPY server/ ./
RUN cargo chef prepare --recipe-path recipe.json

# ---- Rust: dependencies only (cached while Cargo.toml/Cargo.lock are unchanged) ----
FROM chef AS deps
COPY --from=planner /app/server/recipe.json recipe.json
ENV CARGO_BUILD_JOBS=6
RUN cargo chef cook --release --locked --recipe-path recipe.json

# ---- Rust: the app ----
FROM deps AS build
COPY server/ ./
ENV SQLX_OFFLINE=true
RUN cargo build --release --locked --bin ir-server \
 && mkdir -p /app/empty-data

# ---- source: the whole context, with optional folders guaranteed to exist ----
FROM node:24-bookworm-slim AS src
COPY . /ctx
RUN mkdir -p /ctx/web /ctx/content /pkg \
 && if [ -f /ctx/web/package.json ]; then cp /ctx/web/package.json /pkg/; fi \
 && if [ -f /ctx/web/package-lock.json ]; then cp /ctx/web/package-lock.json /pkg/; fi

# ---- web app (Vite) ----
FROM node:24-bookworm-slim AS web
WORKDIR /repo/web
# Only the package files first, so npm ci is cached until they change.
COPY --from=src /pkg/ ./
RUN if [ -f package.json ]; then npm ci --no-audit --no-fund; \
    else echo "web/package.json not found: skipping npm ci"; fi
COPY --from=src /ctx/web/ ./
COPY --from=src /ctx/content/ /repo/content/
RUN mkdir -p /out \
 && if [ -f package.json ]; then npm run build && cp -R dist/. /out/; \
    else echo "no web app in this checkout: the public dir stays empty"; fi

# ---- runtime: glibc + CA certs, no shell ----
FROM gcr.io/distroless/cc-debian12:nonroot
WORKDIR /app
COPY --from=build /app/server/target/release/ir-server /app/ir-server
COPY --from=web /out/ /app/public/
COPY --from=src /ctx/content/ /app/content/
# Owned by the nonroot user so a fresh named volume mounted here is writable.
COPY --from=build --chown=65532:65532 /app/empty-data/ /app/data/
ENV PORT=8080 \
    PUBLIC_DIR=/app/public \
    CONTENT_DIR=/app/content \
    DATA_DIR=/app/data \
    RUST_LOG=info \
    LOG_FORMAT=json
EXPOSE 8080
USER nonroot
ENTRYPOINT ["/app/ir-server"]
CMD ["serve"]
