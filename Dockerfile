# syntax=docker/dockerfile:1

FROM oven/bun:1.3.11 AS bun

FROM node:22-bookworm-slim AS manifests
WORKDIR /opt/codeshell
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY package.json bun.lock LICENSE ./
# Keep every workspace manifest so the frozen monorepo lockfile stays valid.
COPY packages/arena/package.json packages/arena/package.json
COPY packages/cdp/package.json packages/cdp/package.json
COPY packages/chat/package.json packages/chat/package.json
COPY packages/coding/package.json packages/coding/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/desktop/package.json packages/desktop/package.json
COPY packages/link/package.json packages/link/package.json
COPY packages/pet/package.json packages/pet/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/tui/package.json packages/tui/package.json
COPY packages/web/package.json packages/web/package.json

FROM manifests AS build
RUN bun install --frozen-lockfile --ignore-scripts \
      --filter '@cjhyy/code-shell' \
      --filter '@cjhyy/code-shell-server' \
      --filter '@cjhyy/code-shell-link'
COPY scripts/copy-assets.mjs scripts/copy-assets.mjs
COPY packages/link/ packages/link/
COPY packages/core/ packages/core/
COPY packages/coding/ packages/coding/
COPY packages/server/ packages/server/
COPY packages/web/ packages/web/
RUN bun run build:server

# Install production dependencies in a fresh tree; do not copy builder node_modules.
FROM manifests AS production-dependencies
RUN bun install --frozen-lockfile --ignore-scripts --production \
      --filter '@cjhyy/code-shell-server' \
      --filter '@cjhyy/code-shell-link'

FROM node:22-bookworm-slim AS runtime
RUN apt-get -o Acquire::Retries=3 update \
    && apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
      ca-certificates git openssh-client curl ffmpeg ripgrep \
      python3 python3-venv python3-pip yt-dlp unzip zip fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data /workspace/.code-shell \
    && mv /home/node /data/home \
    && mkdir -p /data/home/.code-shell \
    && ln -s /data/home /home/node \
    && chown -R node:node /data /workspace
# Match the validated downloader version instead of relying on Bookworm's older package.
RUN curl --fail --location --retry 3 \
      https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp \
      --output /usr/local/bin/yt-dlp \
    && echo '1fa6733c37ea6fb51c99ad8fe785e7b7e5f3246c9b980230329d4fb72ed8d4d6  /usr/local/bin/yt-dlp' | sha256sum --check \
    && chmod 755 /usr/local/bin/yt-dlp
WORKDIR /opt/codeshell
# Preserve the installed workspace layout and relative dependency symlinks.
COPY --from=production-dependencies /opt/codeshell/ ./
COPY --from=build /opt/codeshell/packages/link/dist/ packages/link/dist/
COPY --from=build /opt/codeshell/packages/core/dist/ packages/core/dist/
COPY --from=build /opt/codeshell/packages/coding/dist/ packages/coding/dist/
COPY --from=build /opt/codeshell/packages/server/dist/ packages/server/dist/
COPY --from=build /opt/codeshell/packages/web/dist/ packages/web/dist/
COPY --from=build /opt/codeshell/packages/web/dist-app/ packages/web/dist-app/
COPY packages/coding/THIRD_PARTY_NOTICES.md packages/coding/THIRD_PARTY_NOTICES.md
ENV NODE_ENV=production
USER node
WORKDIR /workspace
VOLUME ["/data", "/workspace"]
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8790/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "/opt/codeshell/packages/server/dist/bin/code-shell-serve.js"]
CMD ["--auth", "hub", "--host", "0.0.0.0", "--port", "8790", "--cwd", "/workspace", "--data-dir", "/data"]
