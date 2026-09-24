#!/bin/sh
# Builds a small ISO volume the appliance's first-boot script looks for
# (by filesystem label "GUACSEED") to read instance properties from — the
# QEMU-portable equivalent of setting OVF properties in vCenter. Same idea
# as cloud-init's NoCloud datasource convention. This runs on the BUILD
# HOST (wherever you're preparing a QEMU image to hand someone, or your
# own laptop), not inside the appliance itself, and needs genisoimage or
# xorriso installed — neither is part of the appliance image.
#
# Entirely optional: an appliance booted with no seed volume attached at
# all just uses DHCP + no custom public URL, same as leaving every OVF
# property at its default.
#
# Usage:
#   ./make-seed-iso.sh -o seed.iso \
#     [-m static -i 192.168.1.50 -p 24 -g 192.168.1.1 -d 192.168.1.1] \
#     [-u https://guac.example.com] \
#     [-s 192.168.1.10]
#
# Then attach it as a CD-ROM when launching the appliance — see
# run-qemu.sh's -seed flag.
set -e

OUT=seed.iso
NET_MODE=""
NET_IP=""
NET_PREFIX=""
NET_GATEWAY=""
NET_DNS=""
PUBLIC_URL=""
SYSLOG_HOST=""

usage() {
	echo "Usage: $0 -o <output.iso> [-m dhcp|static] [-i ip] [-p prefix] [-g gateway] [-d dns] [-u public_url] [-s syslog_host]" >&2
	exit 1
}

while getopts "o:m:i:p:g:d:u:s:h" opt; do
	case "$opt" in
	o) OUT="$OPTARG" ;;
	m) NET_MODE="$OPTARG" ;;
	i) NET_IP="$OPTARG" ;;
	p) NET_PREFIX="$OPTARG" ;;
	g) NET_GATEWAY="$OPTARG" ;;
	d) NET_DNS="$OPTARG" ;;
	u) PUBLIC_URL="$OPTARG" ;;
	s) SYSLOG_HOST="$OPTARG" ;;
	h) usage ;;
	*) usage ;;
	esac
done

if [ "$NET_MODE" = "static" ] && [ -z "$NET_IP" ]; then
	echo "Error: -m static requires -i <ip>" >&2
	exit 1
fi

STAGING=$(mktemp -d)
trap 'rm -rf "$STAGING"' EXIT

# Same property names as ovf-template.xml — see
# guac-appliance-firstboot.sh's read_property() for how these are parsed
# (plain key=value text, never sourced/executed as shell).
{
	[ -n "$NET_MODE" ] && echo "guac.network.mode=$NET_MODE"
	[ -n "$NET_IP" ] && echo "guac.network.ip=$NET_IP"
	[ -n "$NET_PREFIX" ] && echo "guac.network.prefix=$NET_PREFIX"
	[ -n "$NET_GATEWAY" ] && echo "guac.network.gateway=$NET_GATEWAY"
	[ -n "$NET_DNS" ] && echo "guac.network.dns=$NET_DNS"
	[ -n "$PUBLIC_URL" ] && echo "guac.public_url=$PUBLIC_URL"
	[ -n "$SYSLOG_HOST" ] && echo "guac.syslog_host=$SYSLOG_HOST"
} > "$STAGING/guac-appliance.conf"

if command -v genisoimage >/dev/null 2>&1; then
	genisoimage -quiet -output "$OUT" -volid GUACSEED -joliet -rock "$STAGING"
elif command -v xorrisofs >/dev/null 2>&1; then
	xorrisofs -quiet -output "$OUT" -volid GUACSEED -joliet -rock "$STAGING"
else
	echo "Error: need genisoimage or xorrisofs installed on this (build) host." >&2
	exit 1
fi

echo "Wrote $OUT"
cat "$STAGING/guac-appliance.conf"
