#!/bin/sh
# Runs once, on first boot only (gated by /data/.firstboot-done — see
# guac-appliance-firstboot.service). Never actually run against a real VM
# or QEMU instance; see README.md's verification status. Three jobs:
#   1. Format and mount the second virtual disk as /data, if not already
#      done — this is where Postgres/Vault/recordings actually live (see
#      buildroot/docker-compose.appliance.yml), kept separate from the OS
#      disk so replacing/upgrading the appliance doesn't touch it.
#   2. Read instance properties (network config, public URL, optional
#      syslog target) from whichever source is available — OVF properties
#      via vSphere/vCenter, or a seed volume for the portable QEMU image
#      (see README-qemu.md) — and apply them. Same property names either
#      way, so this one script and one set of docs cover both deployment
#      paths without duplication.
#   3. Generate random secrets for the app's .env on first boot only —
#      deliberately never baked into the image itself, so every deployed
#      instance of this appliance gets its own independent credentials
#      rather than sharing one secret across every copy.
set -e

DATA_MARKER=/data/.firstboot-done
APP_DIR=/opt/guac-access-suite
ENV_FILE=/data/guac-appliance/.env

log() { echo "[guac-appliance-firstboot] $*"; }

# --- 1. Data disk ---
# /dev/sdb, on both deployment paths: for VMware this is the second unit
# on one PVSCSI controller (see ovf-template.xml); for the portable QEMU
# image, run-qemu.sh deliberately uses virtio-scsi rather than the more
# common virtio-blk specifically so device naming matches (see
# linux.config's CONFIG_SCSI_VIRTIO comment for the full reasoning).
# Neither has been confirmed against a real deployment of either kind.
DATA_DISK=/dev/sdb

if ! mountpoint -q /data; then
	mkdir -p /data
	if ! blkid "$DATA_DISK" >/dev/null 2>&1; then
		log "Formatting $DATA_DISK as ext4 (first use)"
		mkfs.ext4 -F -L guac-data "$DATA_DISK"
	fi
	mount "$DATA_DISK" /data
	# Persist the mount across reboots.
	if ! grep -q "^$DATA_DISK" /etc/fstab 2>/dev/null; then
		echo "$DATA_DISK /data ext4 defaults 0 2" >> /etc/fstab
	fi
fi

if [ -f "$DATA_MARKER" ]; then
	log "First-boot already completed — nothing to do."
	exit 0
fi

mkdir -p /data/guac-appliance/postgres /data/guac-appliance/vault \
	/data/guac-appliance/recordings /data/guac-appliance/rdp-drives

# --- 2. Instance properties: OVF (VMware) or a seed volume (QEMU) ---
# Exactly one of these sources is used, tried in this order. Property
# NAMES are identical either way (e.g. "guac.network.mode") — only the
# encoding differs (OVF's XML attributes vs. the seed file's plain
# KEY=value lines) — so ovf-template.xml and README-qemu.md can document
# the same property list once rather than maintaining two.
PROPS_SOURCE=""
OVF_ENV=""
SEED_CONF=""

# 2a. OVF (VMware/vSphere). vmware-rpctool is part of openvmtools — this
# specific invocation ("info-get guestinfo.ovfEnv" returning the
# ovf-env.xml document) is a commonly-used approach for OVF property
# injection, but hasn't been independently confirmed against a real build
# of this exact package version.
if command -v vmware-rpctool >/dev/null 2>&1; then
	OVF_ENV=$(vmware-rpctool "info-get guestinfo.ovfEnv" 2>/dev/null || true)
	[ -n "$OVF_ENV" ] && PROPS_SOURCE="ovf"
fi

# 2b. Seed volume (portable QEMU image — see make-seed-iso.sh /
# README-qemu.md), only tried if no OVF properties were found. Looked up
# by filesystem label ("GUACSEED"), same idea as cloud-init's NoCloud
# datasource convention. The seed file is READ AS PLAIN TEXT and parsed
# with the same sed-based key extraction as the OVF case below — never
# sourced/executed as shell (`. file`) — a seed volume on portable media
# may have changed hands or come from an untrusted source, and sourcing
# it would let a crafted file run arbitrary commands as root during boot.
if [ -z "$PROPS_SOURCE" ]; then
	SEED_DEV=$(blkid -L GUACSEED 2>/dev/null || true)
	if [ -n "$SEED_DEV" ]; then
		mkdir -p /mnt/seed
		if mount -o ro "$SEED_DEV" /mnt/seed 2>/dev/null; then
			if [ -f /mnt/seed/guac-appliance.conf ]; then
				SEED_CONF=$(cat /mnt/seed/guac-appliance.conf)
				PROPS_SOURCE="seed"
			fi
			umount /mnt/seed
		fi
	fi
fi

read_property() {
	# $1 = property name, e.g. "guac.network.mode". Empty output (not an
	# error) if the property is absent or no source was found at all —
	# every caller below already has a sensible default for that case.
	key=$(printf '%s' "$1" | sed 's/[.[\*^$/]/\\&/g') # escape for use inside the sed pattern
	case "$PROPS_SOURCE" in
	ovf)
		echo "$OVF_ENV" | sed -n "s/.*oe:key=\"$key\"[^>]*oe:value=\"\([^\"]*\)\".*/\1/p" | head -n1
		;;
	seed)
		echo "$SEED_CONF" | sed -n "s/^${key}=\(.*\)\$/\1/p" | head -n1
		;;
	esac
}

NET_MODE=$(read_property "guac.network.mode")
NET_IP=$(read_property "guac.network.ip")
NET_PREFIX=$(read_property "guac.network.prefix")
NET_GATEWAY=$(read_property "guac.network.gateway")
NET_DNS=$(read_property "guac.network.dns")
PUBLIC_URL=$(read_property "guac.public_url")
SYSLOG_HOST=$(read_property "guac.syslog_host")

if [ "$NET_MODE" = "static" ] && [ -n "$NET_IP" ]; then
	log "Applying static network config from OVF properties: $NET_IP/$NET_PREFIX"
	cat > /etc/systemd/network/10-eth0.network <<-EOF
	[Match]
	Name=eth0

	[Network]
	Address=${NET_IP}/${NET_PREFIX:-24}
	Gateway=${NET_GATEWAY}
	DNS=${NET_DNS:-1.1.1.1}
	EOF
else
	log "No static network properties found (or mode != static) — using DHCP."
	cat > /etc/systemd/network/10-eth0.network <<-EOF
	[Match]
	Name=eth0

	[Network]
	DHCP=yes
	EOF
fi
systemctl restart systemd-networkd || true

# --- 3. Secrets + .env ---
log "Generating fresh secrets for this appliance instance (first boot only)."
cat > "$ENV_FILE" <<-EOF
	POSTGRES_HOST=postgres
	POSTGRES_PORT=5432
	POSTGRES_DB=guac_access_suite
	POSTGRES_USER=guac_app
	POSTGRES_PASSWORD=$(openssl rand -hex 24)

	VAULT_ADDR=http://vault:8200
	VAULT_ROLE_ID=
	VAULT_SECRET_ID=

	SESSION_SECRET=$(openssl rand -hex 32)
	JWT_SECRET=$(openssl rand -hex 32)
	GUAC_TOKEN_ENCRYPTION_KEY=$(openssl rand -hex 32)

	GUACD_HOST=guacd
	GUACD_PORT=4822

	REDIS_HOST=redis
	REDIS_PORT=6379

	RECORDINGS_PATH=/data/recordings
	RDP_DRIVES_PATH=/data/rdp-drives

	PUBLIC_URL=${PUBLIC_URL:-http://localhost}
EOF

if [ -n "$SYSLOG_HOST" ]; then
	{
		echo "SYSLOG_ENABLED=true"
		echo "SYSLOG_HOST=$SYSLOG_HOST"
	} >> "$ENV_FILE"
fi

chmod 600 "$ENV_FILE"

# NOTE: VAULT_ROLE_ID/VAULT_SECRET_ID are intentionally left blank here —
# they're filled in by guac-appliance-vault-setup.sh, which runs on every
# boot (not just this one) and handles Vault's own init/unseal/AppRole
# bootstrap against the real (non-dev-mode) production Vault. Left blank
# here rather than duplicating that logic in two places.

touch "$DATA_MARKER"
log "First-boot setup complete."
