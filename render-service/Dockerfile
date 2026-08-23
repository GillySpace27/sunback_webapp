# Print-master render service for the Dimensional SKU.
#
# Runs the exact same shaders the film uses (web3d/tools/render-plate.mjs
# against a PlateScene build) so the object sold is the object shown. web3d
# is built INTO this image rather than fetched from the live CDN, so a print
# master is always pinned to this image's git SHA, not whatever's currently
# deployed to the Cloudflare Worker.
#
# Base image ships Chromium + every Linux system lib Playwright validates for
# headless operation — the well-trodden part. What it does NOT verify is
# whether this project's WebGL2 shader pipeline (RHEF texture uploads, the
# corona shader) renders correctly and fast enough under SwiftShader software
# rasterization at print resolution. Only a real deploy answers that.
#
# The image tag's version MUST match render-service/package.json's pinned
# "playwright" version exactly — Playwright refuses to drive a browser
# bundled by a different release than the npm package resolving its path.
FROM mcr.microsoft.com/playwright:v1.62.0-noble

WORKDIR /app

# web3d first, its own cached layer — same "deps before source" trick as the
# main API's Dockerfile.
COPY web3d/package.json web3d/package-lock.json ./web3d/
RUN cd web3d && npm ci
COPY web3d/ ./web3d/
RUN cd web3d && npm run build

# The render service. PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: the base image
# already bundles the matching Chromium; installing the full "playwright"
# package would otherwise fetch a second, redundant copy.
COPY render-service/package.json render-service/package-lock.json ./render-service/
RUN cd render-service && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci
COPY render-service/server.mjs ./render-service/

EXPOSE 8090
CMD ["node", "render-service/server.mjs"]
