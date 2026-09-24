# Guac Access Suite — Portable QEMU Image

A self-contained, portable version of the same appliance covered in
`../README.md` — same Buildroot image, same kernel, same first-boot
logic, just packaged for `qemu-system-x86_64` instead of vSphere/ESXi.
Copy the bundle to a USB drive, another machine, wherever — anywhere with
QEMU (ideally with KVM) installed can run it.

**Verification status**: same as the rest of `buildroot/` — never
actually built or run. See `../README.md`'s "Verification status" for the
full picture; everything said there about the shared Buildroot image
(kernel config, first-boot script, Vault lifecycle) applies here
identically, since it's the same build producing both outputs.

## What's in the bundle

Produced automatically alongside the `.ova` by the same Buildroot build —
`post-image.sh` converts the exact same OS disk image into both formats,
so there's no separate build to run:

```
guac-access-suite-appliance-qemu/
├── guac-appliance-os.qcow2     # OS disk (~same content as the OVA's VMDK)
├── guac-appliance-data.qcow2   # empty, sparse — formatted on first boot
├── run-qemu.sh                 # launches it
├── make-seed-iso.sh            # optional pre-configuration (see below)
└── README.md                   # this file
```

## Running it

```bash
./run-qemu.sh
```

Defaults: 8GB RAM, 4 vCPUs, KVM acceleration if `/dev/kvm` exists
(falls back to slow software emulation with a warning if not). The web UI
is forwarded to `https://localhost:8443` on the host, SSH to
`localhost:2222`. Override any of these:

```bash
GUAC_QEMU_RAM=4G GUAC_QEMU_HTTP_PORT=9443 ./run-qemu.sh
```

First boot takes a few minutes — the data disk gets formatted, container
images get pulled (unless pre-loaded into the image at build time, see the
main README's "Building with pre-loaded images"), and Vault initializes
itself. Once it settles, visit `https://localhost:8443` — the app's own
setup wizard takes it from there, same as any other deployment.

`-nographic` is used deliberately (no QEMU GUI window; console output
goes to your terminal instead) — this is meant to run headless/portably,
including over SSH to wherever you're running QEMU from.

## Optional pre-configuration (seed ISO)

By default the appliance just uses DHCP and no custom public URL — fine
for trying it out on a local network. To pre-configure network settings,
a public URL, or syslog forwarding without touching a running instance:

```bash
./make-seed-iso.sh -o seed.iso \
  -m static -i 192.168.1.50 -p 24 -g 192.168.1.1 -d 192.168.1.1 \
  -u https://guac.example.com \
  -s 192.168.1.10   # optional syslog server

./run-qemu.sh -seed seed.iso
```

Needs `genisoimage` or `xorriso` installed on whichever machine builds the
seed ISO (not inside the appliance itself). This is the same underlying
mechanism as OVF properties in the vSphere deployment path — same property
names, just read from a small ISO volume (labeled `GUACSEED`) instead of
vCenter's OVF injection, since there's no vCenter in this deployment path.
Entirely optional — an appliance booted without `-seed` at all just uses
the defaults.

## Why virtio-scsi instead of the more common virtio-blk

`run-qemu.sh` attaches both disks via `virtio-scsi`, not the more commonly
seen `virtio-blk`. This is deliberate, not a stylistic choice: it makes
both disks appear as `/dev/sda`/`/dev/sdb` inside the guest, matching the
same device-naming convention `guac-appliance-firstboot.sh` already
assumes for the VMware/PVSCSI deployment path (see that script's
`DATA_DISK` comment). With `virtio-blk` instead, the disks would show up
as `/dev/vda`/`/dev/vdb`, and the first-boot script would silently
misidentify — or fail to find — its own data disk.

## Known gaps

Same list as the main `README.md`'s "Known gaps" section (no SSH key
provisioning, no automatic TLS, `scripts/backup-*.sh` need adapting to run
from inside the appliance) — all apply here identically. One additional
QEMU-specific item: `run-qemu.sh`'s exact command-line flags (particularly
the virtio-scsi bus addressing) have not been run against a real QEMU
instance and may need adjustment on first real use.
