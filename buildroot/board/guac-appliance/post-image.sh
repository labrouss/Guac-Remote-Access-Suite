#!/bin/sh
# Runs after the root filesystem image itself is built. Three jobs:
#   1. Assemble the OS disk (disk.img) via genimage — same invocation
#      Buildroot's own support/scripts/genimage.sh helper uses, verified
#      against that real script rather than guessed, since this doesn't
#      call that helper directly (it needs to run more steps afterward
#      that a plain BR2_ROOTFS_POST_IMAGE_SCRIPT="support/scripts/genimage.sh"
#      config couldn't also do in the same pass).
#   2. Convert the OS disk to a streamOptimized VMDK, and create a second,
#      empty streamOptimized VMDK for the data disk (formatted by
#      guac-appliance-firstboot.sh on the appliance's own first boot, not
#      here — this just needs to exist as a disk of the right capacity).
#   3. Populate ovf-template.xml with the real file sizes/capacities and
#      package everything into a single .ova.
#
# Never actually run — no Buildroot toolchain, qemu-img, or genimage
# binary was available in the environment this was written in. Treat this
# as a strong, carefully-reasoned starting point, not a proven pipeline.
set -e

BOARD_DIR=$(cd "$(dirname "$0")" && pwd)
DATA_DISK_SIZE_GB="${GUAC_APPLIANCE_DATA_DISK_GB:-200}"

log() { echo "[post-image] $*"; }

# --- 1. OS disk via genimage ---
# Mirrors support/scripts/genimage.sh's real invocation exactly (fetched
# and read from the actual Buildroot source before writing this) — empty
# --rootpath since genimage is only asked to insert the already-built
# rootfs.ext4 into the disk image, not build the rootfs itself.
GENIMAGE_TMP="${BUILD_DIR}/genimage.tmp"
ROOTPATH_TMP=$(mktemp -d)
trap 'rm -rf "$ROOTPATH_TMP"' EXIT
rm -rf "$GENIMAGE_TMP"

log "Running genimage to assemble the OS disk image."
genimage \
	--rootpath "$ROOTPATH_TMP" \
	--tmppath "$GENIMAGE_TMP" \
	--inputpath "$BINARIES_DIR" \
	--outputpath "$BINARIES_DIR" \
	--config "$BOARD_DIR/genimage.cfg"

OS_DISK_RAW="$BINARIES_DIR/disk.img"
if [ ! -f "$OS_DISK_RAW" ]; then
	echo "ERROR: genimage did not produce $OS_DISK_RAW — check genimage.cfg" >&2
	exit 1
fi

# --- 2. VMDK conversion ---
OVA_STAGING="$BINARIES_DIR/ova-staging"
rm -rf "$OVA_STAGING"
mkdir -p "$OVA_STAGING"

log "Converting OS disk to a streamOptimized VMDK (this is the format OVF/OVA expects)."
qemu-img convert -O vmdk -o subformat=streamOptimized \
	"$OS_DISK_RAW" "$OVA_STAGING/guac-appliance-os.vmdk"

log "Creating an empty ${DATA_DISK_SIZE_GB}GB data disk (sparse — formatted by the appliance itself on first boot, not here)."
DATA_DISK_RAW="$BUILD_DIR/guac-appliance-data.img"
qemu-img create -f raw "$DATA_DISK_RAW" "${DATA_DISK_SIZE_GB}G"
qemu-img convert -O vmdk -o subformat=streamOptimized \
	"$DATA_DISK_RAW" "$OVA_STAGING/guac-appliance-data.vmdk"
rm -f "$DATA_DISK_RAW"

# --- 3. OVF/OVA packaging ---
OS_VMDK_SIZE=$(stat -c%s "$OVA_STAGING/guac-appliance-os.vmdk" 2>/dev/null || stat -f%z "$OVA_STAGING/guac-appliance-os.vmdk")
DATA_VMDK_SIZE=$(stat -c%s "$OVA_STAGING/guac-appliance-data.vmdk" 2>/dev/null || stat -f%z "$OVA_STAGING/guac-appliance-data.vmdk")
# OS_DISK_CAPACITY_GB should match BR2_TARGET_ROOTFS_EXT2_SIZE in the
# defconfig (currently 4096M = 4GB) — kept as a separate, explicit value
# here rather than computed from the raw image, since genimage's holes/
# padding mean the raw file size isn't exactly the logical disk capacity
# OVF wants reported.
OS_DISK_CAPACITY_GB=4

log "Populating the OVF descriptor with real file sizes."
sed \
	-e "s/@@OS_VMDK_SIZE@@/$OS_VMDK_SIZE/g" \
	-e "s/@@DATA_VMDK_SIZE@@/$DATA_VMDK_SIZE/g" \
	-e "s/@@OS_DISK_CAPACITY_GB@@/$OS_DISK_CAPACITY_GB/g" \
	-e "s/@@DATA_DISK_CAPACITY_GB@@/$DATA_DISK_SIZE_GB/g" \
	"$BOARD_DIR/ovf-template.xml" > "$OVA_STAGING/guac-access-suite-appliance.ovf"

log "Generating the OVF manifest (SHA256 of the .ovf and both .vmdk files)."
(
	cd "$OVA_STAGING"
	{
		printf 'SHA256(%s)= %s\n' "guac-access-suite-appliance.ovf" "$(sha256sum guac-access-suite-appliance.ovf | cut -d' ' -f1)"
		printf 'SHA256(%s)= %s\n' "guac-appliance-os.vmdk" "$(sha256sum guac-appliance-os.vmdk | cut -d' ' -f1)"
		printf 'SHA256(%s)= %s\n' "guac-appliance-data.vmdk" "$(sha256sum guac-appliance-data.vmdk | cut -d' ' -f1)"
	} > guac-access-suite-appliance.mf
)

log "Packaging the .ova (tar, uncompressed — VMDKs are already compressed internally by streamOptimized)."
(
	cd "$OVA_STAGING"
	tar -cf "$BINARIES_DIR/guac-access-suite-appliance.ova" \
		guac-access-suite-appliance.ovf \
		guac-access-suite-appliance.mf \
		guac-appliance-os.vmdk \
		guac-appliance-data.vmdk
)

rm -rf "$OVA_STAGING"
log "Done: $BINARIES_DIR/guac-access-suite-appliance.ova"

# --- 4. Portable QEMU bundle ---
# Reuses the exact same disk.img genimage already produced above — no
# separate build needed for the QEMU-portable distribution path, since the
# kernel already supports both VMware paravirt drivers and virtio (see
# linux.config). qcow2 rather than VMDK: QEMU's native format, and
# genuinely smaller for distribution (sparse + internal compression),
# where streamOptimized VMDK exists specifically for the VMware/OVA case.
QEMU_STAGING="$BINARIES_DIR/qemu-staging"
rm -rf "$QEMU_STAGING"
mkdir -p "$QEMU_STAGING"

log "Converting OS disk to qcow2 for the portable QEMU bundle."
qemu-img convert -O qcow2 -c "$OS_DISK_RAW" "$QEMU_STAGING/guac-appliance-os.qcow2"

log "Creating an empty ${DATA_DISK_SIZE_GB}GB qcow2 data disk (sparse — formatted on first boot, not here)."
qemu-img create -f qcow2 "$QEMU_STAGING/guac-appliance-data.qcow2" "${DATA_DISK_SIZE_GB}G"

cp -f "$BOARD_DIR/run-qemu.sh" "$QEMU_STAGING/run-qemu.sh"
cp -f "$BOARD_DIR/make-seed-iso.sh" "$QEMU_STAGING/make-seed-iso.sh"
chmod +x "$QEMU_STAGING/run-qemu.sh" "$QEMU_STAGING/make-seed-iso.sh"
cp -f "$BOARD_DIR/README-qemu.md" "$QEMU_STAGING/README.md"

log "Packaging the portable QEMU bundle."
mv "$QEMU_STAGING" "$BINARIES_DIR/guac-access-suite-appliance-qemu"
tar -czf "$BINARIES_DIR/guac-access-suite-appliance-qemu.tar.gz" -C "$BINARIES_DIR" \
	guac-access-suite-appliance-qemu

rm -rf "$BINARIES_DIR/guac-access-suite-appliance-qemu"
log "Done: $BINARIES_DIR/guac-access-suite-appliance-qemu.tar.gz"
