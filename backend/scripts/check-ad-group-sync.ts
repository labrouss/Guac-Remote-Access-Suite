import { parseAdGroupMappings, lookupAdUserMemberOf, isAdEnabled } from '../src/services/activeDirectory';

/**
 * Requested directly, after a real, live report that newly-provisioned
 * AD accounts weren't actually being placed into their configured
 * AD_GROUP_MAPPINGS group. Run inside the real backend container
 * specifically (`docker compose exec backend npm run
 * check-ad-group-sync [-- username]`), the same reasoning
 * check-ad-cert.ts's own comment already covers in detail: a check run
 * anywhere else isn't actually checking the thing that matters, which
 * is what this one, real, running container's own environment and
 * config currently resolve to.
 *
 * Two layers, deliberately: the config layer (is AD_GROUP_MAPPINGS
 * even set, in *this* running container, and does it parse the way it
 * looks like it should) needs no AD connectivity or a specific
 * account to check at all, and is very likely to already explain
 * things on its own — the single most likely real cause, given
 * exactly this same pattern already came up once before in this same
 * environment for NODE_EXTRA_CA_CERTS: a value only just added to
 * .env never reaching an already-running container, since
 * `docker compose restart` reuses its existing environment as-is —
 * only `--force-recreate` (or `down`+`up`) actually rebuilds it with
 * .env's current values. The second layer, a specific user's own real,
 * live AD group membership compared directly against the configured
 * mappings, needs a username and real AD connectivity, and is what
 * actually confirms or rules out a DN mismatch (wrong OU, a typo, or
 * the account genuinely not being in the AD group someone assumed it
 * was) once the config layer alone doesn't explain it.
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
  section('AD_GROUP_MAPPINGS — this container\'s own current environment');
  const raw = process.env.AD_GROUP_MAPPINGS;
  if (!raw) {
    problem('AD_GROUP_MAPPINGS is not set in this container\'s own environment at all.');
    info('If you\'ve already added it to .env: this container needs to actually be recreated to pick it up —');
    info('  docker compose up -d --force-recreate backend');
    info('A plain "docker compose restart" reuses the container\'s existing environment as-is and will NOT pick up a .env change — this exact gotcha has come up before in this same environment for NODE_EXTRA_CA_CERTS.');
    return;
  }
  ok('AD_GROUP_MAPPINGS is set in this container\'s own environment.');
  info(`raw value: ${raw}`);

  section('Parsing it — the exact same logic the real login flow itself uses');
  const mappings = parseAdGroupMappings();
  if (mappings.length === 0) {
    problem('Parsed to zero usable mappings. Either the JSON itself is malformed, or none of its entries have both a string "dn" and a string "localGroup" — check `docker compose logs backend` for a specific [activeDirectory] error explaining which.');
    info('If the raw value above looks truncated or subtly different from what you actually put in .env, that container may also still be running on an older value — see the --force-recreate note above.');
    return;
  }
  ok(`Parsed ${mappings.length} mapping(s):`);
  for (const m of mappings) {
    info(`  "${m.dn}"  →  local group "${m.localGroup}"`);
  }

  const username = process.argv[2];
  if (!username) {
    section('Checking a specific user');
    info('Pass a username to check their real, current AD group membership directly against the mappings above, e.g.:');
    info('  docker compose exec backend npm run check-ad-group-sync -- someuser');
    info('(Config alone often explains it — the check above is frequently enough on its own, especially if it caught a missing or stale AD_GROUP_MAPPINGS.)');
    return;
  }

  section(`Live AD group membership for "${username}"`);
  if (!isAdEnabled()) {
    problem('AD login itself isn\'t fully configured in this container (AD_URL/AD_BASE_DN/AD_BIND_DN/AD_BIND_PASSWORD/AD_REQUIRED_GROUP_DN) — can\'t look up a real user without it.');
    return;
  }
  const lookup = await lookupAdUserMemberOf(username);
  if (!lookup.found) {
    problem(`Could not look this user up: ${lookup.error}`);
    if (lookup.error === 'user_not_found') info('Check the username itself — this searches the same way a real login attempt does (AD_USER_FILTER, sAMAccountName by default).');
    return;
  }
  ok(`Found: ${lookup.dn}`);
  info(`resolved username: ${lookup.resolvedUsername}`);
  if (!lookup.memberOf || lookup.memberOf.length === 0) {
    problem('This account is not a member of any AD group at all, per AD itself, right now.');
  } else {
    info(`Currently a member of ${lookup.memberOf.length} AD group(s):`);
    for (const dn of lookup.memberOf) info(`  ${dn}`);
  }

  section('Comparing against the configured mappings');
  const memberOfLower = new Set((lookup.memberOf ?? []).map((dn) => dn.toLowerCase()));
  let anyMatch = false;
  for (const m of mappings) {
    const matches = memberOfLower.has(m.dn.toLowerCase());
    if (matches) {
      anyMatch = true;
      ok(`Matches "${m.dn}" → will be placed in local group "${m.localGroup}" on next login.`);
    } else {
      problem(`Does NOT match "${m.dn}" — not currently a member of that exact AD group, so "${m.localGroup}" won't be granted from this mapping.`);
    }
  }
  if (!anyMatch) {
    console.log('\nNone of the configured mappings match this user\'s real, current AD group membership. Compare the DN(s) printed above, character for character, against what\'s configured in AD_GROUP_MAPPINGS — a wrong OU, a typo, or genuinely not being in that AD group yet are the three real causes left once config itself checks out.');
  }
}

main().catch((err) => {
  console.error('Unexpected error running this check:', err);
  process.exitCode = 1;
});
