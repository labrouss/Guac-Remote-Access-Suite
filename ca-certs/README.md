# CA certificates

Drop one or more CA certificate files here (PEM format, `.pem` or `.crt`)
to have the backend trust them — no rebuild, no code change. This
directory is bind-mounted straight into the backend container at
`/app/ca-certs` (read-only), the same pattern `../locales` already uses
for adding a language.

By itself, dropping a file in here does nothing yet — the backend still
needs to be told which file(s) to actually trust. Set `NODE_EXTRA_CA_CERTS`
in `.env` to the file's path *inside the container*, e.g.:

```
NODE_EXTRA_CA_CERTS=/app/ca-certs/ad-ca.pem
```

then **recreate** the backend container — `docker compose up -d
--force-recreate backend`, not a plain `restart`. This is a real,
reported gotcha, not a hypothetical one: `docker compose restart` reuses
the existing container's own environment as-is, so a value only just
added to `.env` never actually reaches an already-running container —
only `--force-recreate` (or `down` + `up`) rebuilds it with `.env`'s
current values. `NODE_EXTRA_CA_CERTS` itself is a standard Node.js
environment variable, read once at process startup either way, never
re-checked per request.

## Why you'd need this

The most common real reason: [Active Directory](../README.md#active-directory)
requires LDAPS (`ldaps://`, see `AD_URL` in `.env.example`), and a real AD
environment's domain controller almost always presents a certificate
issued by that organization's own internal/enterprise CA — not a public
one. Node.js only trusts well-known public CAs by default, so without
this, every AD login attempt fails with an error that traces back to
`UNABLE_TO_VERIFY_LEAF_SIGNATURE` / "unable to verify the first
certificate" (visible in `docker compose logs backend` — see `TODO.md`
for when that logging itself was added). This is expected for
essentially any real AD deployment, not a misconfiguration on your end —
trusting your own domain's CA here is the correct, standard fix, not a
workaround.

## Getting the right certificate — and verifying it actually is the right one

**Export it directly from the CA server itself** (the domain controller
running Active Directory Certificate Services), not from a client
machine's own Certificate Manager (`certmgr.msc`) trust store. This
matters more than it sounds like it should: a real, reported case
involved a CA that had been re-keyed at some point (a new key pair
issued under the exact same CN as before) — a certificate pulled from a
client machine's own, unrefreshed trust store was still the *old*,
superseded one, sharing the same name but cryptographically unable to
verify anything the CA currently signs. Exporting straight from the CA
server itself avoids that entirely, since there's nothing there to have
gone stale.

On the CA server, in an elevated Command Prompt:

```
certutil -ca.cert dc01-ca.cer
```

**Then convert it — this file is not actually PEM yet, even though the
command prints what looks like one to the console.** `certutil -ca.cert`
writes its *file* output in binary (DER) format by default; the
`-----BEGIN CERTIFICATE-----` block it prints to the screen while doing
so is only a human-readable preview, not what actually landed on disk —
confirmed directly, not assumed, by inspecting the file's own raw bytes
against what the console showed. Convert what's actually on disk:

```
certutil -encode dc01-ca.cer dc01-ca.pem
```

Confirm the conversion actually worked before moving on — `type
dc01-ca.pem` should show real, readable `-----BEGIN CERTIFICATE-----`
text on screen, not the same garbled output the original `.cer` gives.

Then transfer `dc01-ca.pem` (the converted one, not the original `.cer`)
to this directory on your Docker host, and follow the `NODE_EXTRA_CA_CERTS`
steps above.

## Verifying it actually works

Rather than restarting the app and trying a real login to find out,
check the certificate itself directly — this runs the same checks (file
readable, PEM vs. binary, a real TLS connection to `AD_URL`, and a real
cryptographic signature check against whatever `NODE_EXTRA_CA_CERTS`
points at) developed live while diagnosing the exact problems described
above, packaged into one command:

```bash
docker compose exec backend npm run check-ad-cert
```

Run this **inside the actual backend container**, not from some other
machine or environment — confirmed directly to matter, not just a
formality: an identical check run from a different Node/OpenSSL build
gave a different, misleadingly clean result during the real
investigation this script came out of. It reports exactly which of the
problems above (if any) is the actual cause, including calling out a
re-keyed CA specifically when that's what it finds — by comparing the
certificate's actual signature against your CA file directly, not just
their names, since a same-named impostor CA looks identical to the real
one by name alone.

This directory is empty and unused for any deployment that isn't using
Active Directory, or whose AD's LDAPS certificate already chains to a
publicly-trusted CA.
