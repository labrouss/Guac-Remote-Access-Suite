#!/bin/sh
# Launches the portable appliance image under QEMU. Expects
# guac-appliance-os.qcow2 and guac-appliance-data.qcow2 alongside this
# script (that's exactly what post-image.sh's QEMU bundle produces — see
# README-qemu.md). Never actually run — no QEMU/KVM environment was
# available while writing it; treat this as a carefully-reasoned starting
# point, not a proven command line.
set -e

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
OS_DISK="$SCRIPT_DIR/guac-appliance-os.qcow2"
DATA_DISK="$SCRIPT_DIR/guac-appliance-data.qcow2"
SEED_ISO=""
RAM="${GUAC_QEMU_RAM:-8G}"
CPUS="${GUAC_QEMU_CPUS:-4}"
HTTP_PORT="${GUAC_QEMU_HTTP_PORT:-8443}"
SSH_PORT="${GUAC_QEMU_SSH_PORT:-2222}"

while [ $# -gt 0 ]; do
	case "$1" in
	-seed)
		SEED_ISO="$2"
		shift 2
		;;
	-h | --help)
		echo "Usage: $0 [-seed seed.iso]" >&2
		echo "Env overrides: GUAC_QEMU_RAM GUAC_QEMU_CPUS GUAC_QEMU_HTTP_PORT GUAC_QEMU_SSH_PORT" >&2
		exit 0
		;;
	*)
		echo "Unknown argument: $1" >&2
		exit 1
		;;
	esac
done

for f in "$OS_DISK" "$DATA_DISK"; do
	if [ ! -f "$f" ]; then
		echo "Error: expected disk image not found: $f" >&2
		exit 1
	fi
done

KVM_FLAG="-enable-kvm"
if [ ! -e /dev/kvm ]; then
	echo "Warning: /dev/kvm not available — falling back to software emulation (much slower)." >&2
	KVM_FLAG=""
fi

# virtio-scsi (not the more common virtio-blk) deliberately, so both disks
# show up as /dev/sda/sdb inside the guest — matches the same device
# naming guac-appliance-firstboot.sh already assumes for the VMware/PVSCSI
# deployment path. See linux.config's CONFIG_SCSI_VIRTIO comment for the
# full reasoning; without this, the appliance would misidentify its own
# data disk when run under QEMU.
# $KVM_FLAG deliberately left unquoted below — when empty (no /dev/kvm),
# this is what makes it vanish from the argument list entirely rather than
# being passed to qemu as a stray empty-string argument.
set -- \
	$KVM_FLAG \
	-m "$RAM" \
	-smp "$CPUS" \
	-device virtio-scsi-pci,id=scsi0 \
	-drive file="$OS_DISK",if=none,id=os-disk,format=qcow2 \
	-device scsi-hd,drive=os-disk,bus=scsi0.0 \
	-drive file="$DATA_DISK",if=none,id=data-disk,format=qcow2 \
	-device scsi-hd,drive=data-disk,bus=scsi0.0 \
	-netdev "user,id=net0,hostfwd=tcp::${HTTP_PORT}-:8443,hostfwd=tcp::${SSH_PORT}-:22" \
	-device virtio-net-pci,netdev=net0 \
	-nographic

if [ -n "$SEED_ISO" ]; then
	if [ ! -f "$SEED_ISO" ]; then
		echo "Error: seed ISO not found: $SEED_ISO" >&2
		exit 1
	fi
	set -- "$@" -drive file="$SEED_ISO",if=none,id=seed,media=cdrom,readonly=on -device scsi-cd,drive=seed,bus=scsi0.0
fi

echo "Starting appliance — web UI will be at https://localhost:${HTTP_PORT} once boot completes"
echo "(first boot takes a few minutes: data disk formatting, image pulling if not pre-loaded, Vault init)"
echo "SSH: ssh -p ${SSH_PORT} root@localhost"
echo ""

exec qemu-system-x86_64 "$@"
