# syntax=docker/dockerfile:1

# HardlyTracking as one container: the built app, served by the same origin that proxies the
# extension hosts.
#
# What this image is *not*: a Mihon extension host. Extensions are Android APKs and need a JVM
# with Android stubs (`M-Extension-Server`) or Suwayomi — a third-party image, and the app treats
# either as an execution engine, never as its source of truth. `docker-compose.yml` in the repo
# runs the whole stack; this image is the part that is ours.
#
# Nothing is baked in that the app could not be given at runtime: the library, read state and
# settings live in the browser (IndexedDB), so the container is stateless apart from the extension
# registry it keeps on disk for the phone-pairing feature.

FROM node:22-alpine AS build
WORKDIR /app

# Dependencies first, so a source change does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# HardlySyncing is optional and public: the two values below are the Supabase URL and the anon key,
# which are meant to ship in a client bundle. Leave them empty and the app simply has no sign-in
# row. The service_role key never goes near this file.
ARG PUBLIC_SUPABASE_URL=""
ARG PUBLIC_SUPABASE_ANON_KEY=""
ENV PUBLIC_SUPABASE_URL=$PUBLIC_SUPABASE_URL
ENV PUBLIC_SUPABASE_ANON_KEY=$PUBLIC_SUPABASE_ANON_KEY

RUN npm run build

FROM node:22-alpine
WORKDIR /app
# `HOST` is loopback in the source; a container has to listen on its own interface.
# `HT_STATE_DIR` is the extension registry the phone-pairing feature writes to.
ENV NODE_ENV=production \
    PORT=8460 \
    HOST=0.0.0.0 \
    HT_STATE_DIR=/data \
    RUNTIME_URL=http://runtime:4567 \
    DALVIK_URL=http://dalvik:8080

# The proxy is node stdlib only (`server/*.mjs`), so the runtime stage installs nothing.
COPY --from=build /app/dist ./dist
COPY server ./server

# The extension registry and the APKs the phone installed through this host.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

USER node
EXPOSE 8460

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:8460/').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server/proxy.mjs"]
