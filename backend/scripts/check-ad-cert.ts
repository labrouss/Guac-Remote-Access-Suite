import fs from 'fs';
import tls from 'tls';
import { X509Certificate } from 'crypto';

/**
 * Packages up every real technique developed during a live troubleshooting
 * session into one command — run inside the actual backend container
 * (`docker compose exec backend npm run check-ad-cert`), not on the host
 * or in some other environment, since that distinction itself turned out
 * to matter: an identical one-off `node -e` invocation on a Node/OpenSSL
 * build different from the real container's own gave a different,
 * misleadingly clean result during that same session.
 *
 * Three real, genuinely different problems were found and fixed in that
 * one session, each with its own distinct signature this script checks
 * for directly rather than leaving to be rediscovered by hand again:
 *
 * 1. The CA file on disk was DER (binary), not PEM — `certutil -ca.cert`
 *    on Windows writes DER by default, printing a PEM-looking preview to
 *    the console that is NOT what actually landed in the file. Symptom:
 *    `UNABLE_TO_VERIFY_LEAF_SIGNATURE` at the app layer, but underneath,
 *    Node's own loader failing with a misleading
 *    `error:80000002:system library::No such file or directory` — which
 *    sounds like a missing file but actually means "couldn't parse this
 *    file's content," confirmed against Node's own issue tracker before
 *    trusting that reading, not assumed from the wording alone.
 * 2. `NODE_EXTRA_CA_CERTS` was set in `.env` after the container had
 *    already started, so the running process never picked it up — this
 *    app's own env vars are read once at process start, not
 *    re-checked — `docker compose restart` reuses the existing
 *    container's environment as-is; only `--force-recreate` (or
 *    `down`+`up`) actually rebuilds it with `.env`'s current values.
 * 3. The CA certificate itself was genuine, valid PEM, correctly loaded,
 *    yet the domain controller's real certificate still failed
 *    signature verification against it — confirmed, not assumed, by
 *    comparing actual key material: the CA had been re-keyed at some
 *    point (a new key pair issued under the exact same CN, "DC01-CA" in
 *    the reported case), so a CA certificate pulled from a client
 *    machine's own (stale) trust store no longer matched what the DC
 *    was actually signing with. The fix was exporting a fresh CA
 *    certificate directly from the CA server itself
 *    (`certutil -ca.cert`), not re-checking the file format.
 *
 * A subtlety worth recording since it shaped how this script checks
 * signatures: Node's own `X509Certificate.checkIssued()` looked like the
 * right tool for the "does this CA's key actually match" check, but
 * tested directly against a deliberately mismatched CA/leaf pair sharing
 * one identical CN, it returned `true` for both the genuine and the
 * impostor CA — it apparently only checks the name relationship, not
 * the actual signature. `leaf.verify(ca.publicKey)` was confirmed, the
 * same direct way, to correctly return `false` for the impostor — that
 * is what this script actually uses below, deliberately not
 * `checkIssued` alone.
 */

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

function ok(msg: string) {
  console.log(`  \u2713 ${msg}`);
}

function problem(msg: string) {
  console.log(`  \u2717 ${msg}`);
}

function info(msg: string) {
  console.log(`  ${msg}`);
}

async function main() {
  section('Configuration');
  const required = ['AD_URL', 'AD_BASE_DN', 'AD_BIND_DN', 'AD_BIND_PASSWORD', 'AD_REQUIRED_GROUP_DN'];
  const missing = required.filter((k) => !process.env[k]);
  for (const key of required) {
    if (process.env[key]) ok(`${key} is set`);
    else problem(`${key} is NOT set`);
  }
  if (missing.length > 0) {
    problem(`AD login is not fully configured — missing: ${missing.join(', ')}. Nothing further to check until these are set.`);
    process.exitCode = 1;
    return;
  }

  const caCertsPath = process.env.NODE_EXTRA_CA_CERTS;
  if (!caCertsPath) {
    info('NODE_EXTRA_CA_CERTS is not set — fine if your AD server\'s LDAPS certificate already chains to a publicly-trusted CA; almost certainly the actual problem otherwise, since a real AD environment normally does not.');
  } else {
    section(`CA certificate file (NODE_EXTRA_CA_CERTS=${caCertsPath})`);
    let raw: Buffer;
    try {
      raw = fs.readFileSync(caCertsPath);
    } catch (err) {
      problem(`Could not read this file inside the container: ${(err as Error).message}`);
      problem('This exact symptom happened for a real, reported reason before: NODE_EXTRA_CA_CERTS was only added to .env after the container had already started. Env vars are read once at process start — try: docker compose up -d --force-recreate backend');
      process.exitCode = 1;
      return;
    }
    ok('file exists and is readable inside this container');

    const asText = raw.toString('utf8', 0, Math.min(raw.length, 40));
    if (!asText.includes('-----BEGIN CERTIFICATE-----')) {
      problem('This does not look like PEM text — it looks like a binary (DER) certificate file.');
      problem('This exact symptom happened for a real, reported reason before: certutil -ca.cert on Windows writes DER by default, even though it prints a PEM-looking preview to the console (which is NOT what lands in the file). Convert it with either:');
      info('  certutil -encode dc01.certificate.cer dc01.certificate.pem   (on Windows, using the file you already have)');
      info('  openssl x509 -inform DER -in dc01.certificate.cer -outform PEM -out dc01.certificate.pem   (from Linux/this container)');
      process.exitCode = 1;
      return;
    }
    ok('file is PEM text, not binary');

    let caCert: X509Certificate;
    try {
      caCert = new X509Certificate(raw);
    } catch (err) {
      problem(`This file's content isn't a certificate Node can parse: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }
    ok('parses as a valid X.509 certificate');
    info(`subject: ${caCert.subject.replace(/\n/g, ', ')}`);
    info(`issuer:  ${caCert.issuer.replace(/\n/g, ', ')}`);
    info(`valid:   ${caCert.validFrom}  \u2192  ${caCert.validTo}`);
    const now = new Date();
    if (now < new Date(caCert.validFrom)) problem('This certificate is not valid yet (validFrom is in the future).');
    if (now > new Date(caCert.validTo)) problem('This certificate has expired.');

    section('Connecting to AD_URL over TLS');
    const url = new URL(process.env.AD_URL!);
    const port = url.port ? Number(url.port) : 636;
    const result = await new Promise<{ leaf?: X509Certificate; authorized: boolean; authorizationError?: string; connectError?: string }>((resolve) => {
      const socket = tls.connect(
        { host: url.hostname, port, servername: url.hostname, rejectUnauthorized: false, timeout: 8000 },
        () => {
          const peer = socket.getPeerCertificate(true);
          const leaf = peer && peer.raw ? new X509Certificate(peer.raw) : undefined;
          resolve({ leaf, authorized: socket.authorized, authorizationError: socket.authorizationError?.toString() });
          socket.end();
        },
      );
      socket.on('error', (err) => resolve({ authorized: false, connectError: err.message }));
      socket.on('timeout', () => { socket.destroy(); resolve({ authorized: false, connectError: 'connection timed out' }); });
    });

    if (result.connectError) {
      problem(`Could not even connect to ${url.hostname}:${port}: ${result.connectError}`);
      info('This is a network/reachability problem, not a certificate problem — check AD_URL, firewalls, and that this container can actually reach that host and port.');
      process.exitCode = 1;
      return;
    }

    ok(`connected to ${url.hostname}:${port}`);
    if (result.leaf) {
      info(`server presented: ${result.leaf.subject ? result.leaf.subject.replace(/\n/g, ', ') : '(no subject — common for a domain controller\'s own machine certificate, not unusual)'}`);
      info(`issued by:        ${result.leaf.issuer.replace(/\n/g, ', ')}`);
      info(`valid:            ${result.leaf.validFrom}  \u2192  ${result.leaf.validTo}`);
    }

    if (result.authorized) {
      ok('TLS handshake fully trusted (authorized: true) — this part is genuinely working.');
    } else {
      problem(`TLS handshake NOT trusted: ${result.authorizationError}`);

      if (result.leaf && (result.authorizationError === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || result.authorizationError === 'CERT_SIGNATURE_FAILURE')) {
        // Both error codes turned out to mean the same underlying thing
        // here — confirmed directly, not assumed: the exact same
        // deliberately-mismatched CA/leaf pair reported
        // UNABLE_TO_VERIFY_LEAF_SIGNATURE in one real environment and
        // CERT_SIGNATURE_FAILURE in another, purely from an OpenSSL
        // version/build difference — the same class of environment
        // variance that made testing in the wrong place misleading
        // earlier in this same investigation. Checked for both rather
        // than just the one actually seen, so this diagnostic doesn't
        // silently miss the same real problem on a different build.
        section('Checking whether the real cause is a re-keyed CA');
        // The specific, real thing that happened in the reported case:
        // same CA name, cryptographically different key. checkIssued()
        // alone is not reliable for this — confirmed directly, tested
        // against a deliberately mismatched pair, that it returns true
        // for an impostor sharing the same CN. verify() against the
        // actual public key is the real check.
        const namesMatch = result.leaf.issuer.trim() === caCert.subject.trim();
        let signatureValid = false;
        try {
          signatureValid = result.leaf.verify(caCert.publicKey);
        } catch {
          signatureValid = false;
        }
        info(`certificate names match: ${namesMatch ? 'yes' : 'no'}`);
        info(`signature actually verifies against your CA file: ${signatureValid ? 'yes' : 'no'}`);
        if (namesMatch && !signatureValid) {
          problem('Same CA name, but a different underlying key — your CA was re-keyed at some point, and the certificate you have on file is a stale, superseded copy.');
          problem('Export a fresh copy directly from the CA server itself (certutil -ca.cert), not from a client machine\'s own trust store, then convert it to PEM (see above) if needed.');
          if (result.leaf.infoAccess) info(`Its own certificate also names its current, authoritative CA source directly: ${result.leaf.infoAccess}`);
        } else if (!namesMatch) {
          problem('The certificate names do not even match — this looks like the wrong CA certificate entirely, not a re-keying issue. Confirm you exported the CA that actually issued this specific server\'s certificate.');
        }
      }
      process.exitCode = 1;
      return;
    }
  }

  section('Result');
  ok('Certificate trust looks correctly configured. If AD login still fails from here, the problem is elsewhere (bind credentials, base DN, required group, or the account itself) — check the audit log\'s own recorded reason, or docker compose logs backend for anything beyond a TLS/certificate error.');
}

main().catch((err) => {
  console.error('Unexpected error running this check:', err);
  process.exitCode = 1;
});
