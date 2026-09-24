import { describe, it, expect, vi, beforeEach } from 'vitest';

// A queue of mock Client instances, consumed in construction order by the
// mocked `new Client(...)` below — activeDirectory.ts constructs one for
// the service-account search bind, then a second, separate one for the
// user's own bind, so tests push exactly two (or one, for the
// not-configured/empty-password cases that never reach a second).
const clientQueue = vi.hoisted(() => [] as any[]);
const clientConstructorCalls = vi.hoisted(() => [] as any[]);
vi.mock('ldapts', () => ({
  Client: vi.fn().mockImplementation((options: any) => {
    clientConstructorCalls.push(options);
    return clientQueue.shift();
  }),
}));

function makeMockClient(overrides: { bind?: any; search?: any } = {}) {
  return {
    bind: overrides.bind ?? vi.fn().mockResolvedValue(undefined),
    search: overrides.search ?? vi.fn().mockResolvedValue({ searchEntries: [], searchReferences: [] }),
    unbind: vi.fn().mockResolvedValue(undefined),
  };
}

const dbMock = vi.hoisted(() => ({ one: vi.fn(), oneOrNone: vi.fn(), any: vi.fn(), none: vi.fn() }));
vi.mock('../db', () => ({ db: dbMock }));

const vaultMock = vi.hoisted(() => ({
  encryptCredential: vi.fn(async (s: string) => `enc:${s}`),
  decryptCredential: vi.fn(async (s: string) => s.replace(/^enc:/, '')),
}));
vi.mock('./vaultClient', () => vaultMock);

const AD_ENV = {
  AD_URL: 'ldaps://ad.example.com',
  AD_BASE_DN: 'dc=example,dc=com',
  AD_BIND_DN: 'cn=service,dc=example,dc=com',
  AD_BIND_PASSWORD: 'service-account-password',
  AD_REQUIRED_GROUP_DN: 'cn=GuacUsers,ou=Groups,dc=example,dc=com',
};

// AD_URL etc. are read from process.env at module load time (same
// reasoning as vaultClient.test.ts's own comment on this), so each test
// needs a fresh module instance to see a different env configuration.
async function importFresh() {
  vi.resetModules();
  return import('./activeDirectory');
}

beforeEach(() => {
  clientQueue.length = 0;
  clientConstructorCalls.length = 0;
  dbMock.one.mockReset();
  dbMock.oneOrNone.mockReset();
  dbMock.any.mockReset();
  dbMock.none.mockReset();
  vaultMock.encryptCredential.mockClear();
  vaultMock.decryptCredential.mockClear();
  for (const key of Object.keys(AD_ENV)) delete process.env[key];
});

describe('isAdEnabled', () => {
  it('is false when any required env var is missing', async () => {
    const { isAdEnabled } = await importFresh();
    expect(isAdEnabled()).toBe(false);
    Object.assign(process.env, AD_ENV);
    delete process.env.AD_REQUIRED_GROUP_DN;
    const { isAdEnabled: isAdEnabled2 } = await importFresh();
    expect(isAdEnabled2()).toBe(false);
  });

  it('is true when every required env var is set', async () => {
    Object.assign(process.env, AD_ENV);
    const { isAdEnabled } = await importFresh();
    expect(isAdEnabled()).toBe(true);
  });
});

describe('authenticateAgainstAd', () => {
  beforeEach(() => {
    Object.assign(process.env, AD_ENV);
  });

  it('returns ad_not_configured when AD is not set up, without touching the network at all', async () => {
    for (const key of Object.keys(AD_ENV)) delete process.env[key];
    const { authenticateAgainstAd } = await importFresh();
    const result = await authenticateAgainstAd('alice', 'password123');
    expect(result).toEqual({ ok: false, reason: 'ad_not_configured' });
    expect(clientConstructorCalls.length).toBe(0);
  });

  it('CRITICAL: rejects an empty password before any LDAP bind is attempted at all (RFC 4513 unauthenticated-bind bypass)', async () => {
    const { authenticateAgainstAd } = await importFresh();
    const result = await authenticateAgainstAd('alice', '');
    expect(result).toEqual({ ok: false, reason: 'empty_password' });
    // The real, critical assertion: no LDAP client was even constructed —
    // this guard has to fire before any bind attempt, not just produce
    // the right final answer some other way.
    expect(clientConstructorCalls.length).toBe(0);
  });

  it('returns user_not_found when the search returns no entries', async () => {
    const search = vi.fn().mockResolvedValue({ searchEntries: [], searchReferences: [] });
    clientQueue.push(makeMockClient({ search }));
    const { authenticateAgainstAd } = await importFresh();
    const result = await authenticateAgainstAd('nosuchuser', 'password123');
    expect(result).toEqual({ ok: false, reason: 'user_not_found' });
  });

  it('returns ambiguous_user when the search returns more than one entry', async () => {
    const search = vi.fn().mockResolvedValue({
      searchEntries: [{ dn: 'a', sAMAccountName: 'a' }, { dn: 'b', sAMAccountName: 'b' }],
      searchReferences: [],
    });
    clientQueue.push(makeMockClient({ search }));
    const { authenticateAgainstAd } = await importFresh();
    const result = await authenticateAgainstAd('alice', 'password123');
    expect(result).toEqual({ ok: false, reason: 'ambiguous_user' });
  });

  it('returns invalid_credentials when the user\'s own bind fails (wrong password)', async () => {
    const search = vi.fn().mockResolvedValue({
      searchEntries: [{ dn: 'cn=alice,dc=example,dc=com', sAMAccountName: 'alice', memberOf: [AD_ENV.AD_REQUIRED_GROUP_DN] }],
      searchReferences: [],
    });
    clientQueue.push(makeMockClient({ search }));
    clientQueue.push(makeMockClient({ bind: vi.fn().mockRejectedValue(new Error('invalid credentials')) }));
    const { authenticateAgainstAd } = await importFresh();
    const result = await authenticateAgainstAd('alice', 'wrong-password');
    expect(result).toEqual({ ok: false, reason: 'invalid_credentials' });
  });

  it('returns not_in_required_group when the bind succeeds but memberOf lacks the required group', async () => {
    const search = vi.fn().mockResolvedValue({
      searchEntries: [{ dn: 'cn=alice,dc=example,dc=com', sAMAccountName: 'alice', memberOf: ['cn=SomeOtherGroup,dc=example,dc=com'] }],
      searchReferences: [],
    });
    clientQueue.push(makeMockClient({ search }));
    clientQueue.push(makeMockClient());
    const { authenticateAgainstAd } = await importFresh();
    const result = await authenticateAgainstAd('alice', 'correct-password');
    expect(result).toEqual({ ok: false, reason: 'not_in_required_group' });
  });

  it('succeeds when bind and group membership both check out', async () => {
    const search = vi.fn().mockResolvedValue({
      searchEntries: [{ dn: 'cn=alice,dc=example,dc=com', sAMAccountName: 'alice', memberOf: [AD_ENV.AD_REQUIRED_GROUP_DN] }],
      searchReferences: [],
    });
    clientQueue.push(makeMockClient({ search }));
    clientQueue.push(makeMockClient());
    const { authenticateAgainstAd } = await importFresh();
    const result = await authenticateAgainstAd('alice', 'correct-password');
    expect(result).toEqual({ ok: true, dn: 'cn=alice,dc=example,dc=com', resolvedUsername: 'alice' });
  });

  it('handles memberOf being a single bare string, not an array (real LDAP behavior for a single-valued attribute)', async () => {
    const search = vi.fn().mockResolvedValue({
      searchEntries: [{ dn: 'cn=alice,dc=example,dc=com', sAMAccountName: 'alice', memberOf: AD_ENV.AD_REQUIRED_GROUP_DN }],
      searchReferences: [],
    });
    clientQueue.push(makeMockClient({ search }));
    clientQueue.push(makeMockClient());
    const { authenticateAgainstAd } = await importFresh();
    const result = await authenticateAgainstAd('alice', 'correct-password');
    expect(result.ok).toBe(true);
  });

  it('compares the required group DN case-insensitively', async () => {
    const search = vi.fn().mockResolvedValue({
      searchEntries: [{ dn: 'cn=alice,dc=example,dc=com', sAMAccountName: 'alice', memberOf: [AD_ENV.AD_REQUIRED_GROUP_DN.toUpperCase()] }],
      searchReferences: [],
    });
    clientQueue.push(makeMockClient({ search }));
    clientQueue.push(makeMockClient());
    const { authenticateAgainstAd } = await importFresh();
    const result = await authenticateAgainstAd('alice', 'correct-password');
    expect(result.ok).toBe(true);
  });

  it('escapes LDAP filter metacharacters in the username rather than passing them through raw', async () => {
    const search = vi.fn().mockResolvedValue({ searchEntries: [], searchReferences: [] });
    clientQueue.push(makeMockClient({ search }));
    const { authenticateAgainstAd } = await importFresh();
    await authenticateAgainstAd('alice)(uid=*', 'password123');
    const [, options] = search.mock.calls[0];
    expect(options.filter).toBe('(sAMAccountName=alice\\29\\28uid=\\2a)');
    expect(options.filter).not.toContain(')(uid=*');
  });

  it('strips a Windows down-level logon name\'s own DOMAIN\\ prefix before searching — a real, live login attempt was reported using exactly this format', async () => {
    const search = vi.fn().mockResolvedValue({
      searchEntries: [{ dn: 'cn=admin,dc=example,dc=com', sAMAccountName: 'Administrator', memberOf: [AD_ENV.AD_REQUIRED_GROUP_DN] }],
      searchReferences: [],
    });
    clientQueue.push(makeMockClient({ search }));
    clientQueue.push(makeMockClient());
    const { authenticateAgainstAd } = await importFresh();
    const result = await authenticateAgainstAd('contoso.com\\Administrator', 'correct-password');

    // The real point of this test: without stripping, the raw string —
    // backslash and all — would go straight into the filter, which
    // escapeLdapFilterValue would then correctly, faithfully escape as
    // a literal backslash character, producing a syntactically valid
    // filter that could never match any real sAMAccountName (that
    // attribute never actually contains a domain prefix at all).
    const [, options] = search.mock.calls[0];
    expect(options.filter).toBe('(sAMAccountName=Administrator)');
    expect(result).toEqual({ ok: true, dn: 'cn=admin,dc=example,dc=com', resolvedUsername: 'Administrator' });
  });

  it('binds the search client as the service account, not the submitted credentials', async () => {
    const bind = vi.fn().mockResolvedValue(undefined);
    clientQueue.push(makeMockClient({ bind }));
    const { authenticateAgainstAd } = await importFresh();
    await authenticateAgainstAd('alice', 'alices-password');
    expect(bind).toHaveBeenCalledWith(AD_ENV.AD_BIND_DN, AD_ENV.AD_BIND_PASSWORD);
  });

  it('uses a separate client instance for the user\'s own bind, never reusing the service-account connection', async () => {
    const searchBind = vi.fn().mockResolvedValue(undefined);
    const userBind = vi.fn().mockResolvedValue(undefined);
    const search = vi.fn().mockResolvedValue({
      searchEntries: [{ dn: 'cn=alice,dc=example,dc=com', sAMAccountName: 'alice', memberOf: [AD_ENV.AD_REQUIRED_GROUP_DN] }],
      searchReferences: [],
    });
    clientQueue.push(makeMockClient({ bind: searchBind, search }));
    clientQueue.push(makeMockClient({ bind: userBind }));
    const { authenticateAgainstAd } = await importFresh();
    await authenticateAgainstAd('alice', 'alices-password');
    expect(searchBind).toHaveBeenCalledWith(AD_ENV.AD_BIND_DN, AD_ENV.AD_BIND_PASSWORD);
    expect(userBind).toHaveBeenCalledWith('cn=alice,dc=example,dc=com', 'alices-password');
    expect(clientConstructorCalls.length).toBe(2);
  });

  it('a genuine connectivity/config failure (e.g. unreachable AD_URL, wrong AD_BIND_DN/PASSWORD) returns ldap_error and logs the real underlying error to the console — a real gap this test exists specifically to guard against regressing', async () => {
    const realError = new Error('connect ECONNREFUSED 10.0.0.5:636');
    const bind = vi.fn().mockRejectedValue(realError);
    clientQueue.push(makeMockClient({ bind })); // the service-account bind itself fails
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { authenticateAgainstAd } = await importFresh();
    const result = await authenticateAgainstAd('alice', 'alices-password');

    expect(result).toEqual({ ok: false, reason: 'ldap_error' });
    // The real point of this test: the actual error is not silently
    // discarded (a bare `catch {}` previously did exactly that) — it's
    // logged somewhere an admin would actually find it when diagnosing
    // "why can't anyone log in with AD right now."
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('LDAP error'), realError);

    consoleErrorSpy.mockRestore();
  });
});

describe('AD passthrough credential storage', () => {
  it('storeAdPassthroughCredential encrypts both username and password before writing', async () => {
    const { storeAdPassthroughCredential } = await importFresh();
    await storeAdPassthroughCredential('user-1', 'DOMAIN\\alice', 'alices-password');
    expect(vaultMock.encryptCredential).toHaveBeenCalledWith('DOMAIN\\alice');
    expect(vaultMock.encryptCredential).toHaveBeenCalledWith('alices-password');
    expect(dbMock.none).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO ad_passthrough_credentials'),
      ['user-1', 'enc:DOMAIN\\alice', 'enc:alices-password', expect.any(Date)],
    );
  });

  it('getAdPassthroughCredential returns null when nothing is stored or it has expired', async () => {
    dbMock.oneOrNone.mockResolvedValue(null);
    const { getAdPassthroughCredential } = await importFresh();
    const result = await getAdPassthroughCredential('user-1');
    expect(result).toBeNull();
    expect(dbMock.oneOrNone.mock.calls[0][0]).toContain('expires_at > now()');
  });

  it('getAdPassthroughCredential decrypts a found, unexpired row', async () => {
    dbMock.oneOrNone.mockResolvedValue({ ad_username_encrypted: 'enc:DOMAIN\\alice', ad_password_encrypted: 'enc:alices-password' });
    const { getAdPassthroughCredential } = await importFresh();
    const result = await getAdPassthroughCredential('user-1');
    expect(result).toEqual({ username: 'DOMAIN\\alice', password: 'alices-password' });
  });

  it('clearAdPassthroughCredential deletes the row for that user', async () => {
    const { clearAdPassthroughCredential } = await importFresh();
    await clearAdPassthroughCredential('user-1');
    expect(dbMock.none).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM ad_passthrough_credentials'), ['user-1']);
  });
});

describe('syncAdGroupMemberships', () => {
  beforeEach(() => {
    process.env.AD_GROUP_MAPPINGS = JSON.stringify([
      { dn: 'CN=GuacAdmins,OU=Groups,DC=example,DC=com', localGroup: 'Administrators' },
      { dn: 'CN=GuacUsers,OU=Groups,DC=example,DC=com', localGroup: 'AD Users' },
    ]);
  });

  it('is a complete no-op — zero DB calls at all — when no mappings are configured', async () => {
    delete process.env.AD_GROUP_MAPPINGS;
    const { syncAdGroupMemberships } = await importFresh();
    await syncAdGroupMemberships('user-1', ['CN=GuacUsers,OU=Groups,DC=example,DC=com']);
    expect(dbMock.oneOrNone).not.toHaveBeenCalled();
    expect(dbMock.one).not.toHaveBeenCalled();
    expect(dbMock.any).not.toHaveBeenCalled();
    expect(dbMock.none).not.toHaveBeenCalled();
  });

  it('malformed AD_GROUP_MAPPINGS JSON degrades to a no-op rather than crashing', async () => {
    process.env.AD_GROUP_MAPPINGS = '{not valid json';
    const { syncAdGroupMemberships } = await importFresh();
    await syncAdGroupMemberships('user-1', ['CN=GuacUsers,OU=Groups,DC=example,DC=com']);
    expect(dbMock.none).not.toHaveBeenCalled();
  });

  it('a mapped AD group with no matching local group auto-creates one, then adds the user with source ad_sync', async () => {
    dbMock.oneOrNone.mockResolvedValue(null); // "AD Users" doesn't exist yet
    dbMock.one.mockResolvedValue({ id: 'group-ad-users' });
    dbMock.any.mockResolvedValue([{ id: 'group-ad-users' }]);
    const { syncAdGroupMemberships } = await importFresh();

    await syncAdGroupMemberships('user-1', ['CN=GuacUsers,OU=Groups,DC=example,DC=com']);

    expect(dbMock.one).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO groups'), ['AD Users', expect.stringContaining('CN=GuacUsers')]);
    expect(dbMock.none).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO user_groups'), ['user-1', 'group-ad-users']);
  });

  it('never overwrites an existing row at all on the add side — ON CONFLICT DO NOTHING, not an upsert that could overwrite a manual grant\'s own source', async () => {
    dbMock.oneOrNone.mockResolvedValue({ id: 'group-admins' });
    dbMock.any.mockResolvedValue([{ id: 'group-admins' }]);
    const { syncAdGroupMemberships } = await importFresh();
    await syncAdGroupMemberships('user-1', ['CN=GuacAdmins,OU=Groups,DC=example,DC=com']);
    const insertCall = dbMock.none.mock.calls.find((c: any[]) => c[0].includes('INSERT INTO user_groups'));
    expect(insertCall[0]).toContain('ON CONFLICT (user_id, group_id) DO NOTHING');
  });

  it('removes a previously ad_sync-derived membership the user no longer qualifies for', async () => {
    dbMock.any.mockResolvedValue([]); // user currently qualifies for nothing at all
    const { syncAdGroupMemberships } = await importFresh();
    await syncAdGroupMemberships('user-1', []); // no AD groups at all right now
    expect(dbMock.none).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM user_groups WHERE user_id = $1 AND source = 'ad_sync'"),
      ['user-1'],
    );
    // The explicit, no-qualifying-groups branch specifically — not the
    // parameterized-array branch, which needs a real array to exclude
    // against.
    const deleteCall = dbMock.none.mock.calls.find((c: any[]) => c[0].includes('DELETE FROM user_groups'));
    expect(deleteCall[0]).not.toContain('ANY');
  });

  it('the removal step only ever targets source = \'ad_sync\' rows in its own SQL — never a manual grant, confirmed directly in the query itself', async () => {
    dbMock.any.mockResolvedValue([{ id: 'group-admins' }]);
    const { syncAdGroupMemberships } = await importFresh();
    await syncAdGroupMemberships('user-1', ['CN=GuacAdmins,OU=Groups,DC=example,DC=com']);
    const deleteCall = dbMock.none.mock.calls.find((c: any[]) => c[0].includes('DELETE FROM user_groups'));
    expect(deleteCall[0]).toContain("source = 'ad_sync'");
  });
});

describe('lookupAdUserMemberOf', () => {
  beforeEach(() => {
    Object.assign(process.env, AD_ENV);
  });

  it('returns ad_not_configured when AD is not set up, without touching the network', async () => {
    for (const key of Object.keys(AD_ENV)) delete process.env[key];
    const { lookupAdUserMemberOf } = await importFresh();
    const result = await lookupAdUserMemberOf('alice');
    expect(result).toEqual({ found: false, error: 'ad_not_configured' });
    expect(clientConstructorCalls.length).toBe(0);
  });

  it('returns the real, current memberOf for a found user — the exact thing this diagnostic exists to show', async () => {
    const search = vi.fn().mockResolvedValue({
      searchEntries: [{
        dn: 'cn=alice,dc=example,dc=com',
        sAMAccountName: 'alice',
        memberOf: ['CN=GuacUsers,OU=Groups,DC=example,DC=com', 'CN=GuacAdmins,OU=Groups,DC=example,DC=com'],
      }],
      searchReferences: [],
    });
    clientQueue.push(makeMockClient({ search }));
    const { lookupAdUserMemberOf } = await importFresh();
    const result = await lookupAdUserMemberOf('alice');
    expect(result).toEqual({
      found: true,
      dn: 'cn=alice,dc=example,dc=com',
      resolvedUsername: 'alice',
      memberOf: ['CN=GuacUsers,OU=Groups,DC=example,DC=com', 'CN=GuacAdmins,OU=Groups,DC=example,DC=com'],
    });
  });

  it('reports user_not_found distinctly, not just a generic failure', async () => {
    const search = vi.fn().mockResolvedValue({ searchEntries: [], searchReferences: [] });
    clientQueue.push(makeMockClient({ search }));
    const { lookupAdUserMemberOf } = await importFresh();
    const result = await lookupAdUserMemberOf('ghost');
    expect(result).toEqual({ found: false, error: 'user_not_found' });
  });

  it('reports ambiguous_user distinctly when the filter matches more than one entry', async () => {
    const search = vi.fn().mockResolvedValue({
      searchEntries: [
        { dn: 'cn=a,dc=example,dc=com', sAMAccountName: 'a', memberOf: [] },
        { dn: 'cn=b,dc=example,dc=com', sAMAccountName: 'b', memberOf: [] },
      ],
      searchReferences: [],
    });
    clientQueue.push(makeMockClient({ search }));
    const { lookupAdUserMemberOf } = await importFresh();
    const result = await lookupAdUserMemberOf('a');
    expect(result).toEqual({ found: false, error: 'ambiguous_user' });
  });

  it('does NOT check AD_REQUIRED_GROUP_DN membership — a real diagnostic tool showing raw AD state, not a second login gate', async () => {
    const search = vi.fn().mockResolvedValue({
      searchEntries: [{ dn: 'cn=bob,dc=example,dc=com', sAMAccountName: 'bob', memberOf: ['CN=SomeOtherGroup,DC=example,DC=com'] }],
      searchReferences: [],
    });
    clientQueue.push(makeMockClient({ search }));
    const { lookupAdUserMemberOf } = await importFresh();
    const result = await lookupAdUserMemberOf('bob');
    // bob is NOT in AD_REQUIRED_GROUP_DN at all — a real login would be
    // rejected with not_in_required_group, but this lookup still
    // reports found: true with bob's real memberOf regardless.
    expect(result.found).toBe(true);
    expect(result.memberOf).toEqual(['CN=SomeOtherGroup,DC=example,DC=com']);
  });

  it('surfaces the real underlying error message on an LDAP failure, not just a generic ldap_error reason', async () => {
    const bind = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));
    clientQueue.push(makeMockClient({ bind }));
    const { lookupAdUserMemberOf } = await importFresh();
    const result = await lookupAdUserMemberOf('alice');
    expect(result.found).toBe(false);
    expect(result.error).toBe('connect ECONNREFUSED');
  });
});
