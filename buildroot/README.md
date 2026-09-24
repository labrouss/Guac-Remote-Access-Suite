# Guac Access Suite — Buildroot Appliance

A purpose-built Linux appliance image (Buildroot + systemd + Docker) that
boots straight into the full `docker compose` stack. Two distribution
formats from the same build: a `.ova` for vSphere/ESXi import, and a
portable `qemu-system-x86_64` bundle (copy it anywhere, no hypervisor
infrastructure needed — see `board/guac-appliance/README-qemu.md`). Same
overall shape as the AsBuiltReport Manager appliance — a minimal OS whose
only job is running this app's containers — adapted for this app's
specific services (7 containers: backend, frontend, guac-worker, guacd,
Postgres, Vault, Redis) and its two extra needs beyond a typical
appliance: a persistent data disk separate from the OS disk, and Vault's
own init/unseal lifecycle.

## Verification status — read this first

**Nothing in this directory has been built or booted** — neither the OVA
nor the portable QEMU bundle, since they come from the same build. No
Buildroot toolchain, kernel source tree, `qemu-img`, `genimage` binary,
QEMU/KVM, or VMware environment was available in the environment this was
written in. What *was* done: every Buildroot `BR2_*` config symbol and
package name below was checked directly against Buildroot's real source
(`github.com/buildroot/buildroot`) — not assumed from memory or generic
Buildroot familiarity. That process caught two real mistakes before they
could cause a confusing build failure days later: the actual package name
is `openvmtools` (no hyphens, not `open-vm-tools`), and `dhcpcd` +
systemd-init would have fought over DHCP. It also caught a cross-platform
device-naming issue before it became a QEMU-specific bug report: QEMU's
default `virtio-blk` disks show up as `/dev/vda`/`/dev/vdb`, which would
have silently broken `guac-appliance-firstboot.sh`'s `/dev/sdb` data-disk
assumption (written against VMware's PVSCSI naming) — fixed by using
`virtio-scsi` in `run-qemu.sh` instead, confirmed against Buildroot's own
real `board/qemu/x86_64/linux.config` for the exact kernel symbol needed
(`CONFIG_SCSI_VIRTIO`). Treat everything here as a strong,
carefully-verified starting point for a first real build, not a proven
pipeline.

## Layout

```
buildroot/
├── configs/guac_appliance_defconfig   # the Buildroot defconfig
├── docker-compose.appliance.yml       # overlay redirecting volumes onto /data
├── board/guac-appliance/
│   ├── linux.config                   # kernel config FRAGMENT (see its header)
│   ├── genimage.cfg                   # OS disk partition layout
│   ├── grub.cfg                       # GRUB boot entry
│   ├── post-build.sh                  # bundles compose files + optional pre-loaded images
│   ├── post-image.sh                  # genimage -> both VMDK/.ova AND qcow2/QEMU bundle
│   ├── ovf-template.xml               # OVF descriptor + configurable properties
│   ├── run-qemu.sh                    # launches the portable QEMU bundle
│   ├── make-seed-iso.sh               # optional pre-configuration for the QEMU path
│   ├── README-qemu.md                 # the QEMU-portable path, in full
│   └── rootfs-overlay/
│       ├── etc/systemd/system/        # the three systemd units + enable symlinks
│       └── usr/bin/
│           ├── guac-appliance-firstboot.sh    # runs once: data disk, .env, network
│           └── guac-appliance-vault-setup.sh  # runs every boot: Vault init/unseal/AppRole
```

## The two-disk design

Every persistent thing (Postgres data, Vault data, session recordings) is
redirected via `docker-compose.appliance.yml` onto bind mounts under
`/data` — a **separate virtual disk** from the appliance's own OS disk (see
`ovf-template.xml`'s two `<Disk>` entries). This means:

- Replacing or upgrading the OS disk (a new appliance version) never
  touches persistent state, as long as the data disk stays attached.
- The OS disk can be small and is effectively disposable
  (`BR2_TARGET_ROOTFS_EXT2_SIZE="4096M"` in the defconfig); the data disk
  defaults to 200GB (`GUAC_APPLIANCE_DATA_DISK_GB` env var to
  `post-image.sh`, adjust to taste before building).
- `guac-appliance-firstboot.sh` formats the data disk as ext4 on first
  boot only — it ships as an empty, sparse VMDK, not pre-formatted.

`guac-appliance-firstboot.sh` currently assumes the data disk shows up as
`/dev/sdb` inside the guest — true for the virtual hardware layout
`ovf-template.xml` defines (both disks on one PVSCSI controller, OS at
address 0, data at address 1), but this specific assumption hasn't been
confirmed against a real vSphere deployment. If it's wrong for your
environment, that's the first thing to fix.

## Vault's init/unseal lifecycle

This surprised me while writing it, so it's worth calling out explicitly:
production Vault (`docker-compose.prod.yml`) uses file storage, not dev
mode — meaning it needs a real `vault operator init` (once, ever) and
**re-seals every time its container restarts** (VM reboot, host
maintenance, anything). `guac-appliance-vault-setup.sh` runs on *every*
boot, not just the first, specifically to handle this: it initializes
Vault the first time (single unseal-key share — the right default for a
self-contained appliance with no other infrastructure to split shares
across, though anyone hardening this further might want more), unseals it
on every subsequent boot using that saved key, and bootstraps the
Transit engine + AppRole (same pattern as `e2e/vault-init.sh`, but against
a real production Vault instead of a disposable dev-mode one) exactly
once.

**The unseal key and initial root token are written to
`/data/guac-appliance/vault-init-keys.txt` on first boot, in plaintext,
with a warning comment in the file itself.** Retrieve that file and store
it somewhere genuinely secure — this is the key that unseals the
credential vault protecting every connection this appliance manages.
The script does not delete it automatically; that's left as a deliberate
manual step once you've confirmed you have it safely elsewhere.

## Instance properties (OVF, or a seed ISO for the QEMU path)

Configurable at deploy time via vCenter's "Customize template" step (or
`ovftool --prop:...` for scripted deploys) — see `ovf-template.xml` for
the full list with descriptions: network mode (DHCP or static + IP/prefix/
gateway/DNS), a public URL, and an optional syslog server (turns on this
app's existing `SYSLOG_ENABLED` audit-log forwarding automatically). The
portable QEMU path uses the exact same property names via a small seed
ISO instead (`make-seed-iso.sh`, `board/guac-appliance/README-qemu.md`) —
one property scheme documented once, read by
`guac-appliance-firstboot.sh` from whichever source is actually present.
Everything else — creating the first admin account, TOTP enrollment —
goes through the app's own web-based setup wizard on first browser visit,
same as any other deployment of this app. Deliberately not duplicated as
an OVF/seed property; no reason to build a second onboarding flow when the
app already has one.

## Building (once Buildroot/toolchain access is available)

```bash
# From a Buildroot checkout, with this repo available alongside it:
cp path/to/guac-access-suite/buildroot/configs/guac_appliance_defconfig configs/
ln -s path/to/guac-access-suite/buildroot/board/guac-appliance board/guac-appliance
make guac_appliance_defconfig
make   # this is a real Buildroot build: expect a couple of hours the first time
```

One build produces **two** outputs from the same OS disk image — no
separate build needed to get both:

- `output/images/guac-access-suite-appliance.ova` — for vSphere/ESXi import
- `output/images/guac-access-suite-appliance-qemu.tar.gz` — a portable
  bundle for `qemu-system-x86_64`; see `board/guac-appliance/README-qemu.md`
  for how to run it (or copy it anywhere else with QEMU installed — that's
  the point of it being portable)

### Building with pre-loaded container images

For a fully self-contained appliance (no internet access needed on first
boot to pull from GHCR):

```bash
docker save \
  ghcr.io/your-org/guac-access-suite-backend:VERSION \
  ghcr.io/your-org/guac-access-suite-frontend:VERSION \
  ghcr.io/your-org/guac-access-suite-guac-worker:VERSION \
  -o buildroot/images.tar
make   # post-build.sh picks this up automatically if present
```

Without `images.tar`, `guac-appliance.service` falls back to
`docker compose pull` at first boot instead.

## Deploying

1. Import `guac-access-suite-appliance.ova` into vCenter/ESXi (Deploy OVF
   Template).
2. Set the OVF properties (network config, public URL, optional syslog
   host) during import, or leave everything at its DHCP default and
   configure later.
3. Power on. First boot takes a few minutes (data disk formatting, image
   pulling if `images.tar` wasn't bundled, Vault initialization).
4. Retrieve `/data/guac-appliance/vault-init-keys.txt` via SSH (openssh is
   enabled in the image) and store it securely — see the Vault section
   above.
5. Visit the appliance's IP/public URL in a browser — the app's own setup
   wizard takes it from there.

## Known gaps / not yet handled

- **Never built or booted** — see "Verification status" above. Expect the
  first real build to surface issues (a wrong kernel config option, a
  missing dependency, a genimage quirk) the same way the guacamole-lite
  upgrade surfaced three real bugs only once actually tested against the
  real library — treat that as the normal, expected experience of a first
  build, not a sign of carelessness here.
- **No SSH key provisioning** — openssh is enabled but nothing sets an
  authorized key or a non-default root password at build or first-boot
  time. Add an OVF property + a step in `guac-appliance-firstboot.sh` for
  this before relying on SSH access to a real deployed instance.
- **No automatic TLS** — same as the regular Docker Compose deployment
  (see the main README's TLS section): the frontend serves plain HTTP;
  put a TLS-terminating load balancer/reverse proxy in front, or adapt
  one of the optional Caddy overlays for use inside the appliance — the
  self-signed one (`docker-compose.caddy-internal.yml`) is likely the
  better fit here specifically, since an appliance imported into
  vSphere/ESXi is itself usually reached by an internal hostname or IP,
  not a real public domain the other overlay's Let's Encrypt mode needs.
- **No appliance-level backup integration** — `scripts/backup-postgres.sh`
  etc. assume a `docker compose`-managed host with the repo checked out;
  they'd need adapting to run from inside the appliance (or via SSH from
  outside it) against `/opt/guac-access-suite`'s compose files.
- **The `/dev/sdb` data-disk assumption** — see the two-disk section above.
- **The portable QEMU path specifically** — `run-qemu.sh`'s exact command
  line (virtio-scsi bus addressing, port-forwarding syntax) has not been
  run against a real QEMU instance. `make-seed-iso.sh` needs `genisoimage`
  or `xorriso` on whichever machine builds the seed ISO — neither is part
  of the appliance image itself, both are common but not universal on a
  given build host.
