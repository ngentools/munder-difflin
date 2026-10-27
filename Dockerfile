# Munder Difflin — web/PWA mode in Docker.
# Runs the real Electron main process headless (under Xvfb) and serves the same
# renderer to the browser through the web bridge. See docker-compose.yml.

# ---- build: compile main/preload, the web bundle, and native modules for Electron ----
FROM node:20-bookworm AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends git python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# package-lock pins @electron/node-gyp to a git+ssh URL; build without SSH keys.
RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"
WORKDIR /app

COPY package.json package-lock.json ./
# npm install, not npm ci: the committed lockfile is not in sync with package.json
# (npm ci fails with "Missing: ws@... from lock file").
RUN npm install --ignore-scripts --no-audit --no-fund
# Fetch the Electron binary and rebuild native modules against Electron's ABI
# (the same step the desktop postinstall does).
RUN node node_modules/electron/install.js \
 && npx electron-rebuild -f -w better-sqlite3,node-pty

COPY . .
RUN node tools/ensure-pty-perms.cjs \
 && node tools/patch-node-pty-conpty.cjs \
 && npx electron-vite build \
 && node tools/copy-main-assets.cjs \
 && npm run build:web

# ---- runtime ----
FROM node:20-bookworm-slim AS runtime

# Electron needs GTK/NSS/etc. even headless; Xvfb provides the display it wants.
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb xauth dbus-x11 tini ca-certificates git openssh-client \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libgbm1 libgtk-3-0 \
      libasound2 libxss1 libxtst6 libxkbcommon0 libxcomposite1 libxdamage1 \
      libxrandr2 libpango-1.0-0 libcairo2 fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

# Optional agent CLIs the app spawns (e.g. "@anthropic-ai/claude-code").
ARG AGENT_CLI_PACKAGES=""
RUN if [ -n "$AGENT_CLI_PACKAGES" ]; then npm install -g $AGENT_CLI_PACKAGES; fi

WORKDIR /app
COPY --from=build --chown=node:node /app /app

# All app state (config, hive, agents' memory) lives under HOME, so one volume holds it.
RUN mkdir -p /data/home && chown -R node:node /data/home

ENV NODE_ENV=production \
    WEB_HEADLESS=1 \
    WEB_HOST=0.0.0.0 \
    WEB_PORT=3900 \
    HOME=/data/home \
    WEB_DIST=/app/web/dist

USER node
EXPOSE 3900
VOLUME ["/data/home"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3900/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini reaps child processes (the agent PTYs); Xvfb supplies the display Electron needs.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["xvfb-run", "-a", "--server-args=-screen 0 1280x800x24", "./node_modules/.bin/electron", "--no-sandbox", "."]
