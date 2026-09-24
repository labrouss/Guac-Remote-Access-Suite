#!/bin/sh
# Runs after the root filesystem tree is populated but before it's turned
# into an image. Two jobs:
#   1. Place the GRUB config where genimage expects it (same pattern as
#      Buildroot's own board/pc/post-build.sh, verified against the real
#      source — this board only supports BIOS boot, not the EFI branch
#      that reference script also handles).
#   2. Bundle this app's own release artifacts (compose files, migrations,
#      .env.example) into the image, and pre-load container images from a
#      tarball if one was provided — see "Building with pre-loaded images"
#      in README.md. Never actually run — no Buildroot toolchain was
#      available in the environment this was written in.
set -e

BOARD_DIR=$(dirname "$0")
REPO_ROOT=$(cd "$BOARD_DIR/../../.." && pwd)

cp -f "$BOARD_DIR/grub.cfg" "$TARGET_DIR/boot/grub/grub.cfg"
# GRUB's stage-1.5 image, required by genimage to build the "grub"
# partition — same requirement as the verified board/pc/ reference.
cp -f "$TARGET_DIR/lib/grub/i386-pc/boot.img" "$BINARIES_DIR"

mkdir -p "$TARGET_DIR/opt/guac-access-suite"
cp -f "$REPO_ROOT/docker-compose.prod.yml" "$TARGET_DIR/opt/guac-access-suite/docker-compose.yml"
cp -f "$REPO_ROOT/buildroot/docker-compose.appliance.yml" "$TARGET_DIR/opt/guac-access-suite/docker-compose.appliance.yml"
cp -rf "$REPO_ROOT/migrations" "$TARGET_DIR/opt/guac-access-suite/migrations"
cp -f "$REPO_ROOT/.env.example" "$TARGET_DIR/opt/guac-access-suite/.env.example"

# Optional: a pre-built `docker save` tarball of all three of this app's
# images (backend/frontend/guac-worker), so the appliance can come up
# without needing internet access to pull them from GHCR on first boot —
# the point of an appliance is to be self-contained. Not required; if
# absent, guac-appliance-firstboot.service falls back to
# `docker compose pull` at first boot instead (see the rootfs overlay).
if [ -f "$REPO_ROOT/buildroot/images.tar" ]; then
	cp -f "$REPO_ROOT/buildroot/images.tar" "$TARGET_DIR/opt/guac-access-suite/images.tar"
fi

chmod +x "$TARGET_DIR/usr/bin/guac-appliance-firstboot.sh"
chmod +x "$TARGET_DIR/usr/bin/guac-appliance-vault-setup.sh"
