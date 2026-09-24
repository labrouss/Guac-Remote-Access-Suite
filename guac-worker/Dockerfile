# Build context is the repo root (context: ., dockerfile: guac-worker/Dockerfile)

# ---- guacenc build stage ----
# guacenc is NOT shipped in the official guacamole/guacd:1.5.5 image at
# all — not just at a different path than assumed here originally. Confirmed
# two ways: (1) apache/guacamole-server's own Dockerfile builds guacd
# without ffmpeg-dev anywhere in its dependency list, and Apache's own docs
# state guacenc "will only be built if... FFmpeg libraries are installed";
# (2) empirically, `docker run --rm guacamole/guacd:1.5.5 find / -iname
# 'guacenc*'` returns nothing at all, while the rest of /opt/guacamole/lib
# is fully present — ruling out "wrong path" and confirming "never built".
# So this builds guacenc from the official source tarball instead, adding
# the one thing the official build deliberately omits.
#
# Alpine 3.18 specifically, matching the official guacd Dockerfile's own
# pin (its comment: "Using 3.18 because the required openssl1.1-compat-dev
# package was removed in more recent versions") — one of libguac's build
# deps disappearing from newer Alpine repos, so this can't just float with
# whatever Alpine version node:20-alpine happens to bundle. The final
# runtime stage below pins the same version for the same reason, rather
# than starting from node:20-alpine directly — mixing Alpine versions
# between where guacenc is compiled and where it actually runs risks an
# ABI mismatch against the ffmpeg/openssl shared libraries it links to.
FROM alpine:3.18 AS guacenc-builder
ARG GUACAMOLE_SERVER_VERSION=1.5.5
# Trimmed from the official Dockerfile's full dependency list (krb5-dev,
# sdl2*-dev, webkit2gtk-dev, pulseaudio-dev, cunit-dev omitted — those look
# RDP/audio/test-specific, not needed for a protocol-client-free
# libguac+guacenc build), but the first real build against this trimmed
# list failed on a missing libjpeg-turbo-dev — confirming cairo/libpng/
# libjpeg/libwebp are core image-handling deps guacenc itself needs
# (encoding video frames from image data), not protocol-specific, so
# they're kept even though RDP/VNC support itself is skipped. If another
# missing dependency turns up on the next build attempt, that's expected —
# this trimmed list hasn't been fully proven yet, only corrected once.
RUN apk add --no-cache \
    autoconf automake build-base cairo-dev cjson-dev \
    ffmpeg-dev git grep libjpeg-turbo-dev libpng-dev libtool \
    libwebp-dev make pango-dev \
    openssl1.1-compat-dev util-linux-dev wget

WORKDIR /tmp
RUN wget -O guacamole-server.tar.gz \
      "https://archive.apache.org/dist/guacamole/${GUACAMOLE_SERVER_VERSION}/source/guacamole-server-${GUACAMOLE_SERVER_VERSION}.tar.gz" \
    && tar -xzf guacamole-server.tar.gz \
    && mv "guacamole-server-${GUACAMOLE_SERVER_VERSION}" guacamole-server

WORKDIR /tmp/guacamole-server
# No explicit --without-rdp/--without-vnc/etc flags — deliberately not
# guessed at, since the real official Dockerfile controls which protocol
# clients get built purely via which *-dev packages are installed, not via
# configure flags (confirmed by reading that Dockerfile directly). Not
# installing libssh2-dev/libvncserver-dev/freerdp-dev/libtelnet-dev above
# means configure auto-detects their absence and skips those protocol
# clients — this build only needs libguac + guacenc, not a second guacd.
RUN ./configure --prefix=/opt/guacamole --disable-guaclog \
    && make -j"$(nproc)" \
    && make install

# ---- Node build stage ----
FROM node:20-alpine AS build
WORKDIR /app
COPY guac-worker/package.json guac-worker/package-lock.json* ./
RUN npm install
COPY guac-worker/. .
RUN npm run build

# ---- Runtime ----
# alpine:3.18 + nodejs/npm via apk, deliberately not node:20-alpine as the
# base here — see the guacenc-builder stage's comment on why the Alpine
# version needs to match what guacenc was actually compiled against.
FROM alpine:3.18
RUN apk add --no-cache nodejs npm ffmpeg
WORKDIR /app
ENV NODE_ENV=production

# Bring in guacenc + its runtime shared libraries from the stage that
# actually built it (not the official guacd image — see above).
COPY --from=guacenc-builder /opt/guacamole/bin/guacenc /usr/local/bin/guacenc
COPY --from=guacenc-builder /opt/guacamole/lib /opt/guacamole/lib
ENV LD_LIBRARY_PATH=/opt/guacamole/lib

COPY --from=build /app/package.json /app/package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist

CMD ["node", "dist/worker.js"]
