import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { UserPicker } from './UserPicker';
import { EditConnectionModal } from './EditConnectionModal';
import { BookmarksAdminSection } from './BookmarksAdminSection';
import { RecordingsAdminSection } from './RecordingsAdminSection';

interface Props {
  apiBase: string;
  authToken: string;
}

interface AdminPanelProps {
  apiBase: string;
  authToken: string;
  isAdmin: boolean | null;
}

type Tab = 'users' | 'groups' | 'lists' | 'auditLog';

export function AdminPanel({ apiBase, authToken, isAdmin }: AdminPanelProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('users');

  // Requested directly: a non-admin who reached /admin (the nav link
  // itself is now hidden for them too, but a bookmark, a typed URL, or
  // simply refreshing on this route all still land here directly) was
  // getting an empty-looking page instead of any explanation — every
  // tab's own data fetch was just silently met with a 403, rendering as
  // a table with nothing in it rather than any visible error. isAdmin
  // is null while AppShell's own admin check is still in flight (not
  // yet confirmed either way) — shown as neither this message nor the
  // real content for that brief moment, so a genuine admin refreshing
  // this exact page never sees their own "you don't have permission"
  // message flash before the real one loads.
  if (isAdmin === null) return <div className="admin-panel" />;
  if (!isAdmin) {
    return (
      <div className="admin-panel">
        <Link to="/" className="admin-back-link">{t('admin.backToConnections')}</Link>
        <p className="admin-error">{t('admin.notAnAdmin')}</p>
      </div>
    );
  }

  return (
    <div className="admin-panel">
      {/* /admin is now nested inside AppShell's persistent chrome (see
          App.tsx / AppShell.tsx) rather than a fully separate top-level
          route — but the header itself doesn't have an explicit "back
          to connections" affordance beyond the Connections/Demos toggle
          buttons, so this stays as a clear, obvious way back. Originally
          added when /admin genuinely had no way back at all short of the
          browser's own back button; kept for clarity even after the
          later fix that made navigating here no longer destroy open
          sessions. */}
      <Link to="/" className="admin-back-link">{t('admin.backToConnections')}</Link>
      <nav className="admin-tabs">
        {(['users', 'groups', 'lists', 'auditLog'] as Tab[]).map((tabKey) => (
          <button key={tabKey} className={tab === tabKey ? 'is-active' : ''} onClick={() => setTab(tabKey)}>
            {t(`admin.tabs.${tabKey}`)}
          </button>
        ))}
      </nav>
      <div className="admin-content">
        {tab === 'users' && <UsersTab apiBase={apiBase} authToken={authToken} />}
        {tab === 'groups' && <GroupsTab apiBase={apiBase} authToken={authToken} />}
        {tab === 'lists' && <ListsTab apiBase={apiBase} authToken={authToken} />}
        {tab === 'auditLog' && <AuditLogTab apiBase={apiBase} authToken={authToken} />}
      </div>
    </div>
  );
}

export function authHeaders(authToken: string, json = true) {
  const headers: Record<string, string> = { Authorization: `Bearer ${authToken}` };
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

// --- Users ---
function UsersTab({ apiBase, authToken }: Props) {
  const { t } = useTranslation();
  const [users, setUsers] = useState<any[]>([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // Requested directly: reset a user's password from this same page,
  // alongside the existing 2FA reset. Shown once, right after
  // generation — the backend never stores anything but the password's
  // hash, so this is the only chance to actually see and hand it off.
  const [resetPasswordResult, setResetPasswordResult] = useState<{ username: string; password: string | null } | null>(null);
  // Completes the other half of what was asked for directly: editing a
  // group to add users already existed (see GroupsTab below); this is
  // the "or edit the user and set their group" alternative — there was
  // no group-related UI anywhere on this tab at all before this.
  const [allGroups, setAllGroups] = useState<{ id: string; name: string }[]>([]);
  const [addingGroupFor, setAddingGroupFor] = useState<string | null>(null);

  function refresh() {
    fetch(`${apiBase}/api/admin/users`, { headers: authHeaders(authToken, false) })
      .then((r) => r.json())
      .then(setUsers);
  }
  useEffect(refresh, [apiBase, authToken]);

  useEffect(() => {
    fetch(`${apiBase}/api/admin/groups`, { headers: authHeaders(authToken, false) })
      .then((r) => r.json())
      .then(setAllGroups);
  }, [apiBase, authToken]);

  // Reuses the exact same endpoints GroupsTab's own member management
  // already calls — adding "alice to Ops" is the same operation whether
  // it's initiated from Ops's own member list or from alice's row here.
  async function addUserToGroup(userId: string, groupId: string) {
    await fetch(`${apiBase}/api/admin/groups/${groupId}/members`, {
      method: 'POST',
      headers: authHeaders(authToken),
      body: JSON.stringify({ userId })
    });
    setAddingGroupFor(null);
    refresh();
  }

  async function removeUserFromGroup(userId: string, groupId: string) {
    await fetch(`${apiBase}/api/admin/groups/${groupId}/members/${userId}`, {
      method: 'DELETE',
      headers: authHeaders(authToken, false)
    });
    refresh();
  }

  async function createUser() {
    setError(null);
    const res = await fetch(`${apiBase}/api/admin/users`, {
      method: 'POST',
      headers: authHeaders(authToken),
      body: JSON.stringify({ username, password })
    });
    if (!res.ok) return setError((await res.json()).message ?? t('admin.users.createUserError'));
    setUsername('');
    setPassword('');
    refresh();
  }

  async function disableUser(id: string) {
    await fetch(`${apiBase}/api/admin/users/${id}`, { method: 'DELETE', headers: authHeaders(authToken, false) });
    refresh();
  }

  async function enableUser(id: string) {
    await fetch(`${apiBase}/api/admin/users/${id}/enable`, { method: 'POST', headers: authHeaders(authToken, false) });
    refresh();
  }

  async function removeUser(id: string, username: string) {
    if (!confirm(t('admin.users.removeConfirm', { username }))) return;
    setError(null);
    const res = await fetch(`${apiBase}/api/admin/users/${id}/remove`, { method: 'POST', headers: authHeaders(authToken, false) });
    if (!res.ok) {
      const body = await res.json();
      const key = body.error === 'cannot_remove_self' ? 'admin.users.removeErrorSelf'
        : body.error === 'cannot_remove_last_administrator' ? 'admin.users.removeErrorLastAdmin'
        : 'admin.users.removeErrorGeneric';
      return setError(t(key));
    }
    refresh();
  }

  async function resetTotp(id: string) {
    if (!confirm(t('admin.users.resetTotpConfirm'))) return;
    await fetch(`${apiBase}/api/admin/users/${id}/reset-totp`, { method: 'POST', headers: authHeaders(authToken, false) });
    refresh();
  }

  // Generates the temporary password client-side rather than asking the
  // admin to type one — avoids a weak/guessable temp password, and
  // avoids typing a password in plaintext into a browser prompt() (which
  // can't mask input at all). Excludes visually ambiguous characters
  // (0/O, 1/l/I) since an admin may need to read this aloud or copy it
  // by hand to give to the user; only ever shown once, immediately after
  // generation — the backend stores nothing but its hash, and the user
  // is forced to change it on their very next login
  // (must_change_password, already set server-side).
  function generateTemporaryPassword(): string {
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const bytes = new Uint8Array(20);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
  }

  async function resetPassword(id: string, username: string) {
    if (!confirm(t('admin.users.resetPasswordConfirm', { username }))) return;
    const temporaryPassword = generateTemporaryPassword();
    const res = await fetch(`${apiBase}/api/admin/users/${id}/reset-password`, {
      method: 'POST',
      headers: authHeaders(authToken),
      body: JSON.stringify({ temporaryPassword })
    });
    if (!res.ok) {
      setResetPasswordResult({ username, password: null });
      return;
    }
    setResetPasswordResult({ username, password: temporaryPassword });
  }

  async function saveRename(id: string) {
    if (!renameValue) return;
    await fetch(`${apiBase}/api/admin/users/${id}`, {
      method: 'PUT',
      headers: authHeaders(authToken),
      body: JSON.stringify({ username: renameValue })
    });
    setRenamingId(null);
    refresh();
  }

  return (
    <div>
      <div className="admin-form-row">
        <input placeholder={t('admin.users.usernamePlaceholder')} value={username} onChange={(e) => setUsername(e.target.value)} />
        <input placeholder={t('admin.users.temporaryPasswordPlaceholder')} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button onClick={createUser}>{t('admin.users.createUser')}</button>
      </div>
      {error && <p className="admin-error">{error}</p>}
      {resetPasswordResult && (
        <div className="admin-reset-password-result">
          {resetPasswordResult.password ? (
            <>
              <p>{t('admin.users.newTemporaryPasswordFor', { username: resetPasswordResult.username })}</p>
              <code className="temporary-password">{resetPasswordResult.password}</code>
              <p className="admin-hint">{t('admin.users.mustSetNewPasswordHint')}</p>
            </>
          ) : (
            <p className="admin-error">{t('admin.users.resetPasswordFailed', { username: resetPasswordResult.username })}</p>
          )}
          <button onClick={() => setResetPasswordResult(null)}>{t('share.dismiss')}</button>
        </div>
      )}
      <p className="admin-hint">{t('admin.users.newUserHint')}</p>
      <table className="admin-table">
        <thead><tr><th>{t('admin.users.colUsername')}</th><th>{t('admin.users.colGroups')}</th><th>{t('admin.users.col2fa')}</th><th>{t('admin.users.colStatus')}</th><th></th></tr></thead>
        <tbody>
          {users.map((u) => {
            const userGroups: { id: string; name: string }[] = u.groups ?? [];
            const availableGroups = allGroups.filter((g) => !userGroups.some((ug) => ug.id === g.id));
            return (
              <tr key={u.id}>
                <td>
                  {renamingId === u.id ? (
                    <span className="admin-inline-edit">
                      <input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} autoFocus />
                      <button onClick={() => saveRename(u.id)}>{t('common.save')}</button>
                      <button onClick={() => setRenamingId(null)}>{t('common.cancel')}</button>
                    </span>
                  ) : (
                    <>
                      {u.username}{' '}
                      <button className="admin-link-button" onClick={() => { setRenamingId(u.id); setRenameValue(u.username); }}>
                        {t('admin.users.rename')}
                      </button>
                    </>
                  )}
                </td>
                <td>
                  <span className="admin-user-groups">
                    {userGroups.map((g) => (
                      <span key={g.id} className="admin-user-group-tag">
                        {g.name}
                        <button onClick={() => removeUserFromGroup(u.id, g.id)} title={t('admin.users.removeFromGroup', { groupName: g.name })}>×</button>
                      </span>
                    ))}
                  </span>
                  {addingGroupFor === u.id ? (
                    <select
                      autoFocus
                      value=""
                      onChange={(e) => e.target.value && addUserToGroup(u.id, e.target.value)}
                      onBlur={() => setAddingGroupFor(null)}
                    >
                      <option value="">{t('admin.users.chooseGroupPlaceholder')}</option>
                      {availableGroups.map((g) => (
                        <option key={g.id} value={g.id}>{g.name}</option>
                      ))}
                    </select>
                  ) : (
                    availableGroups.length > 0 && (
                      <button className="admin-link-button" onClick={() => setAddingGroupFor(u.id)}>{t('admin.users.addToGroup')}</button>
                    )
                  )}
                </td>
                <td>
                  {u.totp_enabled ? (
                    <>
                      {t('admin.users.totpEnabled')}{' '}
                      <button className="admin-link-button" onClick={() => resetTotp(u.id)}>{t('admin.users.resetTotpLink')}</button>
                    </>
                  ) : (
                    t('admin.users.totpNotSetUp')
                  )}
                </td>
                <td>{u.disabled_at ? t('admin.users.statusDisabled') : t('admin.users.statusActive')}</td>
                <td>
                  {u.disabled_at ? (
                    <button onClick={() => enableUser(u.id)}>{t('admin.users.enable')}</button>
                  ) : (
                    <button onClick={() => disableUser(u.id)}>{t('admin.users.disable')}</button>
                  )}{' '}
                  <button onClick={() => resetPassword(u.id, u.username)}>{t('admin.users.resetPassword')}</button>{' '}
                  <button className="admin-danger-button" onClick={() => removeUser(u.id, u.username)}>{t('admin.users.remove')}</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// --- Groups ---
function GroupsTab({ apiBase, authToken }: Props) {
  const { t } = useTranslation();
  const [groups, setGroups] = useState<any[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  // No way existed at all to assign users to a group — only create/delete
  // for the group itself. requireAdmin-gated GET .../members already
  // needed adding on the backend too (only the add/remove mutations
  // existed there before this).
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [members, setMembers] = useState<{ id: string; username: string; source?: 'manual' | 'ad_sync' }[]>([]);
  const [memberError, setMemberError] = useState<string | null>(null);
  // Requested directly: setting a group's connection-list permissions
  // from this same group-editing view — no group-centric permissions UI
  // existed at all before this; only a list's own "Grant access — group"
  // section (see ListDetail below) could grant a group access, one list
  // at a time. This is the group-centric side of that same operation,
  // matching the identical pattern already established for group
  // *membership* a couple of rounds back.
  const [lists, setLists] = useState<{ id: string; name: string; is_personal: boolean }[]>([]);
  const [permissions, setPermissions] = useState<{ list_id: string; list_name: string; permission: string }[]>([]);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [grantListId, setGrantListId] = useState('');
  const [grantPermission, setGrantPermission] = useState('view');

  function refresh() {
    fetch(`${apiBase}/api/admin/groups`, { headers: authHeaders(authToken, false) })
      .then((r) => r.json())
      .then(setGroups);
  }
  useEffect(refresh, [apiBase, authToken]);

  function refreshMembers() {
    if (!activeGroupId) return;
    fetch(`${apiBase}/api/admin/groups/${activeGroupId}/members`, { headers: authHeaders(authToken, false) })
      .then((r) => r.json())
      .then(setMembers);
  }
  useEffect(refreshMembers, [apiBase, authToken, activeGroupId]);

  useEffect(() => {
    fetch(`${apiBase}/api/admin/lists`, { headers: authHeaders(authToken, false) })
      .then((r) => r.json())
      .then(setLists);
  }, [apiBase, authToken]);

  function refreshPermissions() {
    if (!activeGroupId) return;
    fetch(`${apiBase}/api/admin/groups/${activeGroupId}/permissions`, { headers: authHeaders(authToken, false) })
      .then((r) => r.json())
      .then(setPermissions);
  }
  useEffect(refreshPermissions, [apiBase, authToken, activeGroupId]);

  // Reuses the exact same endpoints ListDetail's own "Grant access —
  // group" section already calls — granting "Ops to the Production
  // list" is the same operation whether it's initiated from that list's
  // own detail view or from Ops's own group-editing view here.
  async function grantPermissionToGroup() {
    setPermissionError(null);
    if (!activeGroupId || !grantListId) return;
    const res = await fetch(`${apiBase}/api/admin/lists/${grantListId}/permissions/group`, {
      method: 'POST',
      headers: authHeaders(authToken),
      body: JSON.stringify({ groupId: activeGroupId, permission: grantPermission })
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setPermissionError(
        body.error === 'personal_lists_cannot_be_shared' ? t('admin.groups.personalListCannotBeShared') : t('admin.groups.grantPermissionError')
      );
      return;
    }
    setGrantListId('');
    refreshPermissions();
  }

  async function revokePermissionFromGroup(listId: string, permission: string) {
    if (!activeGroupId) return;
    await fetch(`${apiBase}/api/admin/lists/${listId}/permissions/group/${activeGroupId}/${permission}`, {
      method: 'DELETE',
      headers: authHeaders(authToken, false)
    });
    refreshPermissions();
  }

  async function createGroup() {
    await fetch(`${apiBase}/api/admin/groups`, {
      method: 'POST',
      headers: authHeaders(authToken),
      body: JSON.stringify({ name, description })
    });
    setName('');
    setDescription('');
    refresh();
  }

  async function deleteGroup(id: string) {
    setError(null);
    const res = await fetch(`${apiBase}/api/admin/groups/${id}`, { method: 'DELETE', headers: authHeaders(authToken, false) });
    if (!res.ok) return setError((await res.json()).error ?? t('admin.groups.deleteGroupError'));
    if (activeGroupId === id) setActiveGroupId(null);
    refresh();
  }

  async function addMember(userId: string) {
    setMemberError(null);
    if (!activeGroupId) return;
    const res = await fetch(`${apiBase}/api/admin/groups/${activeGroupId}/members`, {
      method: 'POST',
      headers: authHeaders(authToken),
      body: JSON.stringify({ userId })
    });
    if (!res.ok) return setMemberError(t('admin.groups.addMemberError'));
    refreshMembers();
  }

  async function removeMember(userId: string) {
    if (!activeGroupId) return;
    await fetch(`${apiBase}/api/admin/groups/${activeGroupId}/members/${userId}`, {
      method: 'DELETE',
      headers: authHeaders(authToken, false)
    });
    refreshMembers();
  }

  const activeGroup = groups.find((g) => g.id === activeGroupId);

  return (
    <div>
      <div className="admin-form-row">
        <input placeholder={t('admin.groups.namePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder={t('admin.groups.descriptionPlaceholder')} value={description} onChange={(e) => setDescription(e.target.value)} />
        <button onClick={createGroup}>{t('admin.groups.createGroup')}</button>
      </div>
      {error && <p className="admin-error">{error}</p>}
      <table className="admin-table">
        <thead><tr><th>{t('admin.groups.colName')}</th><th>{t('admin.groups.colDescription')}</th><th></th></tr></thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.id} className={g.id === activeGroupId ? 'is-active' : ''}>
              <td>
                <button className="admin-link-button" onClick={() => setActiveGroupId(g.id)}>{g.name}</button>
              </td>
              <td>{g.description}</td>
              <td>
                {g.name !== 'Administrators' && <button onClick={() => deleteGroup(g.id)}>{t('admin.groups.delete')}</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {activeGroup && (
        <div className="admin-group-members">
          <h4>{t('admin.groups.membersOf', { groupName: activeGroup.name })}</h4>
          <UserPicker
            apiBase={apiBase}
            authToken={authToken}
            placeholder={t('admin.groups.addPersonToGroupPlaceholder')}
            onSelect={(u) => addMember(u.id)}
          />
          {memberError && <p className="admin-error">{memberError}</p>}
          <ul className="admin-folders-list">
            {members.map((m) => (
              <li key={m.id}>
                <span>
                  {m.username}
                  {m.source === 'ad_sync' && (
                    <span className="ad-sync-tag" title={t('admin.groups.adSyncTagTitle')}>
                      {t('admin.groups.adSyncTag')}
                    </span>
                  )}
                </span>
                <button
                  onClick={() => removeMember(m.id)}
                  title={m.source === 'ad_sync' ? t('admin.groups.adSyncRemoveWarning') : undefined}
                >
                  {t('admin.groups.remove')}
                </button>
              </li>
            ))}
            {members.length === 0 && <li className="admin-hint">{t('admin.groups.noMembersYet')}</li>}
          </ul>

          <h4>{t('admin.groups.connectionListPermissions')}</h4>
          <p className="admin-hint">{t('admin.groups.grantHint')}</p>
          <div className="admin-form-row">
            <select value={grantListId} onChange={(e) => setGrantListId(e.target.value)}>
              <option value="">{t('admin.groups.chooseListPlaceholder')}</option>
              {lists.filter((l) => !l.is_personal).map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
            <select value={grantPermission} onChange={(e) => setGrantPermission(e.target.value)}>
              <option value="view">{t('admin.permissionLevels.view')}</option>
              <option value="connect">{t('admin.permissionLevels.connect')}</option>
              <option value="edit">{t('admin.permissionLevels.edit')}</option>
              <option value="admin">{t('admin.permissionLevels.admin')}</option>
            </select>
            <button onClick={grantPermissionToGroup}>{t('admin.groups.grant')}</button>
          </div>
          {permissionError && <p className="admin-error">{permissionError}</p>}
          <ul className="admin-folders-list">
            {permissions.map((p) => (
              <li key={`${p.list_id}-${p.permission}`}>
                <span>{p.list_name} — {t(`admin.permissionLevels.${p.permission}`)}</span>
                <button onClick={() => revokePermissionFromGroup(p.list_id, p.permission)}>{t('admin.groups.revoke')}</button>
              </li>
            ))}
            {permissions.length === 0 && <li className="admin-hint">{t('admin.groups.noPermissionsGrantedYet')}</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

// --- Lists, connections, and permission grants ---
function ListsTab({ apiBase, authToken }: Props) {
  const { t } = useTranslation();
  const [lists, setLists] = useState<any[]>([]);
  const [activeListId, setActiveListId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  function refreshLists() {
    // Real, pre-existing gap fixed alongside group-permission management
    // (see admin.ts's own GET /admin/lists comment for the full
    // reasoning): GET /api/connections/lists only ever returns lists the
    // *calling* user already has some permission grant on — for a global
    // admin in a genuine multi-admin deployment, that could silently
    // exclude lists a different admin created and never explicitly
    // shared with them. This admin-only endpoint returns every list,
    // matching what 'Administrators' already means everywhere else it's
    // checked.
    fetch(`${apiBase}/api/admin/lists`, { headers: authHeaders(authToken, false) })
      .then((r) => r.json())
      .then(setLists);
  }
  useEffect(refreshLists, [apiBase, authToken]);

  async function createList() {
    await fetch(`${apiBase}/api/admin/lists`, {
      method: 'POST',
      headers: authHeaders(authToken),
      body: JSON.stringify({ name, description })
    });
    setName('');
    setDescription('');
    refreshLists();
  }

  return (
    <div className="admin-lists-layout">
      <div className="admin-lists-sidebar">
        <div className="admin-form-row admin-form-row-stacked">
          <input placeholder={t('admin.lists.namePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} />
          <input placeholder={t('admin.lists.descriptionPlaceholder')} value={description} onChange={(e) => setDescription(e.target.value)} />
          <button onClick={createList}>{t('admin.lists.createSharedList')}</button>
        </div>
        <ul className="admin-list-select">
          {lists.map((l) => (
            <li key={l.id}>
              <button className={activeListId === l.id ? 'is-active' : ''} onClick={() => setActiveListId(l.id)}>
                {l.name} {l.is_personal && <span className="personal-tag">{t('connectionPanel.private')}</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="admin-lists-detail">
        {activeListId && (
          <ListDetail
            apiBase={apiBase}
            authToken={authToken}
            listId={activeListId}
            list={lists.find((l) => l.id === activeListId)}
            onListChanged={refreshLists}
            onListDeleted={() => {
              refreshLists();
              setActiveListId(null);
            }}
          />
        )}
      </div>
    </div>
  );
}

const PROTOCOL_DEFAULT_PORTS: Record<string, number> = {
  ssh: 22,
  rdp: 3389,
  vnc: 5900,
  telnet: 23,
  kubernetes: 443
};

export function ListDetail({
  apiBase,
  authToken,
  listId,
  list,
  onListChanged,
  onListDeleted
}: Props & { listId: string; list?: any; onListChanged: () => void; onListDeleted: () => void }) {
  const { t } = useTranslation();
  const [connections, setConnections] = useState<any[]>([]);
  const [credStatus, setCredStatus] = useState<Record<string, boolean>>({});
  const [editingConnection, setEditingConnection] = useState<any | null>(null);
  const [form, setForm] = useState({
    name: '', protocol: 'ssh', hostname: '', port: PROTOCOL_DEFAULT_PORTS.ssh, credentialMode: 'individual',
    forceRecord: false, ignoreCert: false, folderId: ''
  });
  // Real, standalone folder entities (migration 018) — a folder can now
  // exist with zero connections in it, and be assigned to a connection
  // via a dropdown right in this table, not only by editing the
  // connection. See that migration's own comment for why the earlier
  // flat-text-column version (017) couldn't support either of those.
  const [folders, setFolders] = useState<{ id: string; name: string }[]>([]);
  const [newFolderName, setNewFolderName] = useState('');
  const [folderError, setFolderError] = useState<string | null>(null);
  const [grantUserId, setGrantUserId] = useState('');
  const [grantUsername, setGrantUsername] = useState('');
  const [grantPermission, setGrantPermission] = useState('connect');
  const [groupGrantId, setGroupGrantId] = useState('');
  const [groupGrantPermission, setGroupGrantPermission] = useState('connect');
  const [groups, setGroups] = useState<any[]>([]);
  const [permissions, setPermissions] = useState<{ userGrants: any[]; groupGrants: any[] }>({ userGrants: [], groupGrants: [] });
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [exportWithCredentials, setExportWithCredentials] = useState(false);
  const [testResult, setTestResult] = useState<{ reachable: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  // Backend already fully supported renaming and deleting a list
  // (PUT/DELETE /api/admin/lists/:id, including a guard against deleting
  // the personal list) — the actual gap, confirmed by reading the
  // frontend first rather than assuming, was that no UI ever called
  // either endpoint. list?.name — optional chaining since list is only
  // available once ListsTab's own fetch resolves; briefly undefined on
  // first render for a newly-selected list is expected, not a bug.
  const [listName, setListName] = useState(list?.name ?? '');
  const [listDescription, setListDescription] = useState(list?.description ?? '');
  const [listSaving, setListSaving] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  useEffect(() => {
    setListName(list?.name ?? '');
    setListDescription(list?.description ?? '');
    setListError(null);
  }, [list?.id, list?.name, list?.description]);

  async function saveListDetails() {
    setListSaving(true);
    setListError(null);
    try {
      const res = await fetch(`${apiBase}/api/admin/lists/${listId}`, {
        method: 'PUT',
        headers: authHeaders(authToken),
        body: JSON.stringify({ name: listName, description: listDescription })
      });
      if (!res.ok) {
        setListError(t('admin.listDetail.saveError'));
        return;
      }
      onListChanged();
    } finally {
      setListSaving(false);
    }
  }

  async function deleteList() {
    if (!confirm(t('admin.listDetail.deleteListConfirm', { listName: list?.name }))) return;
    const res = await fetch(`${apiBase}/api/admin/lists/${listId}`, {
      method: 'DELETE',
      headers: authHeaders(authToken)
    });
    if (!res.ok) {
      setListError(t('admin.listDetail.deleteListError'));
      return;
    }
    onListDeleted();
  }

  function refresh() {
    fetch(`${apiBase}/api/connections/lists/${listId}/connections`, { headers: authHeaders(authToken, false) })
      .then((r) => r.json())
      .then((d) => {
        setConnections(d.connections);
        // Surfaces the exact gap that made every connection unusable —
        // created with no credentials configured, with nothing in the UI
        // to show that until the moment someone actually tried to
        // connect and got a 409. Fetched per-connection since there's no
        // bulk-status endpoint; the admin list for one shared list is
        // small enough in practice for this to be fine.
        d.connections.forEach((c: any) => {
          fetch(`${apiBase}/api/credentials/${c.id}/status`, { headers: authHeaders(authToken, false) })
            .then((r) => (r.ok ? r.json() : { configured: false }))
            .then((status) => setCredStatus((prev) => ({ ...prev, [c.id]: status.configured })));
        });
      });
  }
  useEffect(refresh, [apiBase, authToken, listId]);

  function refreshFolders() {
    fetch(`${apiBase}/api/admin/lists/${listId}/folders`, { headers: authHeaders(authToken, false) })
      .then((r) => (r.ok ? r.json() : { folders: [] }))
      .then((d) => setFolders(d.folders));
  }
  useEffect(refreshFolders, [apiBase, authToken, listId]);

  async function createFolder() {
    setFolderError(null);
    if (!newFolderName.trim()) return;
    const res = await fetch(`${apiBase}/api/admin/lists/${listId}/folders`, {
      method: 'POST',
      headers: authHeaders(authToken),
      body: JSON.stringify({ name: newFolderName.trim() })
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setFolderError(body.error === 'folder_already_exists' ? t('admin.listDetail.folderAlreadyExists') : t('admin.listDetail.createFolderError'));
      return;
    }
    setNewFolderName('');
    refreshFolders();
  }

  async function renameFolder(folder: { id: string; name: string }) {
    const newName = prompt(t('admin.listDetail.renameFolderPrompt', { folderName: folder.name }), folder.name);
    if (newName === null || !newName.trim() || newName.trim() === folder.name) return;
    const res = await fetch(`${apiBase}/api/admin/folders/${folder.id}`, {
      method: 'PUT',
      headers: authHeaders(authToken),
      body: JSON.stringify({ name: newName.trim() })
    });
    if (!res.ok) {
      setFolderError(t('admin.listDetail.renameFolderError'));
      return;
    }
    refreshFolders();
  }

  async function deleteFolder(folder: { id: string; name: string }) {
    if (!confirm(t('admin.listDetail.deleteFolderConfirm', { folderName: folder.name }))) return;
    const res = await fetch(`${apiBase}/api/admin/folders/${folder.id}`, {
      method: 'DELETE',
      headers: authHeaders(authToken)
    });
    if (!res.ok) {
      setFolderError(t('admin.listDetail.deleteFolderError'));
      return;
    }
    refreshFolders();
    refresh();
  }

  async function assignConnectionFolder(connectionId: string, folderId: string) {
    await fetch(`${apiBase}/api/admin/connections/${connectionId}/folder`, {
      method: 'PATCH',
      headers: authHeaders(authToken),
      body: JSON.stringify({ folderId: folderId || null })
    });
    refresh();
  }

  function refreshPermissions() {
    fetch(`${apiBase}/api/admin/lists/${listId}/permissions`, { headers: authHeaders(authToken, false) })
      .then((r) => (r.ok ? r.json() : { userGrants: [], groupGrants: [] }))
      .then(setPermissions);
  }
  useEffect(refreshPermissions, [apiBase, authToken, listId]);

  useEffect(() => {
    fetch(`${apiBase}/api/admin/groups`, { headers: authHeaders(authToken, false) })
      .then((r) => (r.ok ? r.json() : []))
      .then(setGroups);
  }, [apiBase, authToken]);

  function onProtocolChange(next: string) {
    setForm({ ...form, protocol: next, port: PROTOCOL_DEFAULT_PORTS[next] ?? form.port });
    setTestResult(null);
  }

  async function testConnection() {
    if (!form.hostname.trim()) {
      setTestResult({ reachable: false, message: t('admin.listDetail.enterHostnameFirst') });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`${apiBase}/api/connections/test-reachability`, {
        method: 'POST',
        headers: authHeaders(authToken),
        body: JSON.stringify({ hostname: form.hostname, port: form.port })
      });
      setTestResult(await res.json());
    } catch {
      setTestResult({ reachable: false, message: t('admin.listDetail.testRunError') });
    } finally {
      setTesting(false);
    }
  }

  async function createConnection() {
    setConnectionError(null);
    const { ignoreCert, ...rest } = form;
    const params = ignoreCert ? { 'ignore-cert': true } : {};
    const res = await fetch(`${apiBase}/api/admin/lists/${listId}/connections`, {
      method: 'POST',
      headers: authHeaders(authToken),
      body: JSON.stringify({ ...rest, params })
    });
    if (!res.ok) {
      setConnectionError(t('admin.listDetail.createConnectionError'));
      return;
    }
    setForm({ ...form, name: '', hostname: '', folderId: '' });
    setTestResult(null);
    refresh();
  }

  // Requested directly: backing up/restoring connections as a JSON file.
  // Same authenticated-fetch-then-blob pattern used for bookmark export
  // (see BookmarkPanel.tsx's own exportForBrowser and its comment on why
  // a plain window.open() can't carry the Authorization header this
  // route needs) — reused here rather than reinvented, since it's
  // exactly the same underlying problem.
  async function exportConnections(includeCredentials: boolean) {
    setConnectionError(null);
    const res = await fetch(
      `${apiBase}/api/admin/lists/${listId}/connections/export${includeCredentials ? '?includeCredentials=true' : ''}`,
      { headers: authHeaders(authToken, false) }
    );
    if (!res.ok) {
      setConnectionError(res.status === 403 ? t('admin.listDetail.exportCredentialsNotAuthorized') : t('admin.listDetail.exportError'));
      return;
    }
    const data = await res.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const safeListName = (data.list_name ?? 'connections').replace(/[^a-z0-9-_]+/gi, '_');
    link.download = `${safeListName}-connections${includeCredentials ? '-with-credentials' : ''}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function importConnections(file: File) {
    setConnectionError(null);
    let parsed: any;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      setConnectionError(t('admin.listDetail.notValidJson'));
      return;
    }
    const res = await fetch(`${apiBase}/api/admin/lists/${listId}/connections/import`, {
      method: 'POST',
      headers: authHeaders(authToken),
      body: JSON.stringify(parsed)
    });
    if (!res.ok) {
      if (res.status === 403) {
        setConnectionError(t('admin.listDetail.importCredentialsNotAuthorized'));
        return;
      }
      const body = await res.json().catch(() => ({}));
      setConnectionError(
        body.error === 'unsupported_schema_version'
          ? t('admin.listDetail.unrecognizedExport')
          : t('admin.listDetail.importError')
      );
      return;
    }
    const { imported, importedCredentials, skipped } = await res.json();
    setConnectionError(
      skipped > 0
        ? t('admin.listDetail.importPartial', { count: skipped, imported, skipped })
        : importedCredentials > 0
          ? t('admin.listDetail.importedWithCredentials', { count: importedCredentials, importedCredentials })
          : null
    );
    refresh();
    refreshFolders();
  }

  async function deleteConnection(id: string) {
    setConnectionError(null);
    // Previously never checked whether this actually succeeded — a
    // failed delete (permission, network, anything) looked identical to
    // clicking the button and having nothing happen at all, which is
    // exactly the symptom reported live ("I cannot delete a connection
    // when clicking delete").
    const res = await fetch(`${apiBase}/api/admin/connections/${id}`, { method: 'DELETE', headers: authHeaders(authToken, false) });
    if (!res.ok) {
      setConnectionError(t('admin.listDetail.deleteConnectionError'));
      return;
    }
    refresh();
  }

  async function grantUser() {
    if (!grantUserId) return;
    await fetch(`${apiBase}/api/admin/lists/${listId}/permissions/user`, {
      method: 'POST',
      headers: authHeaders(authToken),
      body: JSON.stringify({ userId: grantUserId, permission: grantPermission })
    });
    setGrantUserId('');
    setGrantUsername('');
    refreshPermissions();
  }

  async function grantGroup() {
    if (!groupGrantId) return;
    await fetch(`${apiBase}/api/admin/lists/${listId}/permissions/group`, {
      method: 'POST',
      headers: authHeaders(authToken),
      body: JSON.stringify({ groupId: groupGrantId, permission: groupGrantPermission })
    });
    setGroupGrantId('');
    refreshPermissions();
  }

  async function revokeUserGrant(userId: string, permission: string) {
    await fetch(`${apiBase}/api/admin/lists/${listId}/permissions/user/${userId}/${permission}`, {
      method: 'DELETE',
      headers: authHeaders(authToken, false)
    });
    refreshPermissions();
  }

  async function revokeGroupGrant(groupId: string, permission: string) {
    await fetch(`${apiBase}/api/admin/lists/${listId}/permissions/group/${groupId}/${permission}`, {
      method: 'DELETE',
      headers: authHeaders(authToken, false)
    });
    refreshPermissions();
  }

  return (
    <div>
      <div className="admin-form-row admin-form-row-wrap admin-list-edit-row">
        <input
          placeholder={t('admin.listDetail.listNamePlaceholder')}
          value={listName}
          onChange={(e) => setListName(e.target.value)}
        />
        <input
          placeholder={t('admin.listDetail.descriptionPlaceholder')}
          value={listDescription}
          onChange={(e) => setListDescription(e.target.value)}
        />
        <button onClick={saveListDetails} disabled={listSaving}>
          {listSaving ? t('admin.listDetail.saving') : t('admin.listDetail.saveListDetails')}
        </button>
        {/* Matches the backend's own guard exactly (DELETE /api/admin/lists/:id
            returns 400 cannot_delete_personal_list) — hidden here rather
            than shown and always failing, since every user's personal
            list is a structural part of the app, not something anyone
            should be prompted to remove. */}
        {!list?.is_personal && (
          <button onClick={deleteList}>{t('admin.listDetail.deleteList')}</button>
        )}
      </div>
      {listError && <p className="setup-error">{listError}</p>}

      <h3>{t('admin.listDetail.connectionsHeading')}</h3>
      <div className="admin-form-row admin-form-row-wrap">
        <input placeholder={t('admin.listDetail.namePlaceholder')} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <select value={form.protocol} onChange={(e) => onProtocolChange(e.target.value)}>
          <option value="ssh">SSH</option>
          <option value="rdp">RDP</option>
          <option value="vnc">VNC</option>
          <option value="telnet">Telnet</option>
          <option value="kubernetes">Kubernetes</option>
        </select>
        <input
          placeholder={t('admin.listDetail.hostnamePlaceholder')}
          value={form.hostname}
          onChange={(e) => { setForm({ ...form, hostname: e.target.value }); setTestResult(null); }}
        />
        <input
          placeholder={t('admin.listDetail.portPlaceholder')}
          type="number"
          value={form.port}
          onChange={(e) => { setForm({ ...form, port: Number(e.target.value) }); setTestResult(null); }}
        />
        <select value={form.credentialMode} onChange={(e) => setForm({ ...form, credentialMode: e.target.value })}>
          <option value="individual">{t('admin.listDetail.individualCredentials')}</option>
          <option value="shared">{t('admin.listDetail.sharedCredentials')}</option>
        </select>
        <label className="admin-checkbox">
          <input
            type="checkbox"
            checked={form.forceRecord}
            onChange={(e) => setForm({ ...form, forceRecord: e.target.checked })}
          />
          {t('admin.listDetail.forceRecording')}
        </label>
        {form.protocol === 'rdp' && (
          <label className="admin-checkbox">
            <input
              type="checkbox"
              checked={form.ignoreCert}
              onChange={(e) => setForm({ ...form, ignoreCert: e.target.checked })}
            />
            {t('admin.listDetail.ignoreCertErrors')}
          </label>
        )}
        <button type="button" onClick={testConnection} disabled={testing}>
          {testing ? t('admin.listDetail.testing') : t('admin.listDetail.testConnection')}
        </button>
        {testResult && (
          <span className={testResult.reachable ? 'cred-status-ok' : 'cred-status-missing'}>
            {testResult.reachable ? t('admin.listDetail.reachable') : `✗ ${testResult.message}`}
          </span>
        )}
        <select value={form.folderId} onChange={(e) => setForm({ ...form, folderId: e.target.value })}>
          <option value="">{t('admin.listDetail.noFolder')}</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>{f.name}</option>
          ))}
        </select>
        <button onClick={createConnection}>{t('admin.listDetail.addConnection')}</button>
        <button onClick={() => exportConnections(exportWithCredentials)}>{t('admin.listDetail.exportConnections')}</button>
        <label className="admin-checkbox" title={t('admin.listDetail.includeCredentialsHint')}>
          <input
            type="checkbox"
            checked={exportWithCredentials}
            onChange={(e) => setExportWithCredentials(e.target.checked)}
          />
          {t('admin.listDetail.includeCredentials')}
        </label>
        <label className="connections-import-label">
          {t('admin.listDetail.importConnections')}
          <input
            type="file"
            accept="application/json"
            hidden
            onChange={(e) => e.target.files?.[0] && importConnections(e.target.files[0])}
          />
        </label>
      </div>
      {connectionError && <p className="setup-error">{connectionError}</p>}

      <div className="admin-folders-manage">
        <h4>{t('admin.listDetail.foldersHeading')}</h4>
        <div className="admin-form-row">
          <input
            placeholder={t('admin.listDetail.newFolderNamePlaceholder')}
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
          />
          <button onClick={createFolder}>{t('admin.listDetail.createFolder')}</button>
        </div>
        {folderError && <p className="setup-error">{folderError}</p>}
        {folders.length > 0 && (
          <ul className="admin-folders-list">
            {folders.map((f) => (
              <li key={f.id}>
                <span>{f.name}</span>
                <button onClick={() => renameFolder(f)}>{t('admin.listDetail.rename')}</button>
                <button onClick={() => deleteFolder(f)}>{t('admin.listDetail.delete')}</button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <table className="admin-table">
        <thead><tr><th>{t('admin.listDetail.colName')}</th><th>{t('admin.listDetail.colProtocol')}</th><th>{t('admin.listDetail.colHost')}</th><th>{t('admin.listDetail.colFolder')}</th><th>{t('admin.listDetail.colCredentials')}</th><th>{t('admin.listDetail.colConfigured')}</th><th></th></tr></thead>
        <tbody>
          {connections.map((c) => (
            <tr key={c.id}>
              <td>{c.name}</td>
              <td>{c.protocol}</td>
              <td>{c.hostname}:{c.port}</td>
              <td>
                {/* Requested directly: a way to assign a connection to a
                    folder right from the list view, not only by opening
                    the edit modal. Goes through the dedicated
                    PATCH .../folder endpoint, not the full connection
                    PUT — see that endpoint's own comment for why: this
                    row doesn't have this connection's params available,
                    and a full PUT without them would have silently
                    wiped out any existing advanced parameters. */}
                <select
                  value={c.folder_id ?? ''}
                  onChange={(e) => assignConnectionFolder(c.id, e.target.value)}
                >
                  <option value="">{t('admin.listDetail.noneFolder')}</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </select>
              </td>
              <td>{c.credential_mode}</td>
              <td>
                {credStatus[c.id] === undefined ? '…' : credStatus[c.id] ? (
                  <span className="cred-status-ok">{t('admin.listDetail.credConfiguredYes')}</span>
                ) : (
                  <span className="cred-status-missing">{t('admin.listDetail.credConfiguredNo')}</span>
                )}
              </td>
              <td>
                <button onClick={() => setEditingConnection(c)}>{t('admin.listDetail.edit')}</button>{' '}
                <button onClick={() => deleteConnection(c.id)}>{t('admin.listDetail.delete')}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {editingConnection && (
        <EditConnectionModal
          apiBase={apiBase}
          authToken={authToken}
          connection={editingConnection}
          onClose={() => setEditingConnection(null)}
          onSaved={refresh}
          folders={folders}
        />
      )}

      <BookmarksAdminSection apiBase={apiBase} authToken={authToken} listId={listId} />

      <RecordingsAdminSection apiBase={apiBase} authToken={authToken} listId={listId} />

      {/* Never made sense for a personal list — one can't be shared at
          all (the grant route's own personal_lists_cannot_be_shared
          check already reflects this), so attempting it here would just
          be a confusing round-trip to a guaranteed server error. Matches
          the same is_personal guard this file already applies to the
          "Delete list" button, extended to cover this too — found while
          building the new personal-list management page below, which
          reuses this same component and made the gap obvious. */}
      {!list?.is_personal && (
        <>
          <h3>{t('admin.listDetail.grantAccessUser')}</h3>
          <div className="admin-form-row">
            {grantUsername ? (
              <span className="picked-user">
                {grantUsername} <button onClick={() => { setGrantUserId(''); setGrantUsername(''); }}>×</button>
              </span>
            ) : (
              <UserPicker
                apiBase={apiBase}
                authToken={authToken}
                onSelect={(u) => { setGrantUserId(u.id); setGrantUsername(u.username); }}
              />
            )}
            <select value={grantPermission} onChange={(e) => setGrantPermission(e.target.value)}>
              <option value="view">{t('admin.permissionLevels.view')}</option>
              <option value="connect">{t('admin.permissionLevels.connect')}</option>
              <option value="edit">{t('admin.permissionLevels.edit')}</option>
              <option value="admin">{t('admin.permissionLevels.admin')}</option>
            </select>
            <button onClick={grantUser}>{t('admin.listDetail.grant')}</button>
          </div>

          <h3>{t('admin.listDetail.grantAccessGroup')}</h3>
          <div className="admin-form-row">
            <select value={groupGrantId} onChange={(e) => setGroupGrantId(e.target.value)}>
              <option value="">{t('admin.listDetail.selectGroupPlaceholder')}</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
            <select value={groupGrantPermission} onChange={(e) => setGroupGrantPermission(e.target.value)}>
              <option value="view">{t('admin.permissionLevels.view')}</option>
              <option value="connect">{t('admin.permissionLevels.connect')}</option>
              <option value="edit">{t('admin.permissionLevels.edit')}</option>
              <option value="admin">{t('admin.permissionLevels.admin')}</option>
            </select>
            <button onClick={grantGroup}>{t('admin.listDetail.grant')}</button>
          </div>

          <h3>{t('admin.listDetail.currentGrants')}</h3>
          <table className="admin-table">
            <thead><tr><th>{t('admin.listDetail.colWho')}</th><th>{t('admin.listDetail.colPermission')}</th><th></th></tr></thead>
            <tbody>
              {permissions.userGrants.map((g) => (
                <tr key={`u-${g.user_id}-${g.permission}`}>
                  <td>{g.username}</td>
                  <td>{t(`admin.permissionLevels.${g.permission}`)}</td>
                  <td><button onClick={() => revokeUserGrant(g.user_id, g.permission)}>{t('admin.listDetail.revoke')}</button></td>
                </tr>
              ))}
              {permissions.groupGrants.map((g) => (
                <tr key={`g-${g.group_id}-${g.permission}`}>
                  <td>{g.name} <span className="protocol-tag">{t('admin.listDetail.groupTag')}</span></td>
                  <td>{t(`admin.permissionLevels.${g.permission}`)}</td>
                  <td><button onClick={() => revokeGroupGrant(g.group_id, g.permission)}>{t('admin.listDetail.revoke')}</button></td>
                </tr>
              ))}
              {permissions.userGrants.length === 0 && permissions.groupGrants.length === 0 && (
                <tr><td colSpan={3} className="admin-hint">{t('admin.listDetail.noGrantsYet')}</td></tr>
              )}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

// --- Audit Log ---
function AuditLogTab({ apiBase, authToken }: Props) {
  const { t, i18n } = useTranslation();
  const [rows, setRows] = useState<any[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [filterAction, setFilterAction] = useState('');
  const [filterUserId, setFilterUserId] = useState('');
  const [filterUsername, setFilterUsername] = useState('');
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const pageSize = 50;

  useEffect(() => {
    fetch(`${apiBase}/api/admin/audit-log/actions`, { headers: authHeaders(authToken, false) })
      .then((r) => (r.ok ? r.json() : []))
      .then(setActions);
  }, [apiBase, authToken]);

  useEffect(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (filterAction) params.set('action', filterAction);
    if (filterUserId) params.set('userId', filterUserId);
    // <input type="datetime-local"> values have no timezone suffix — treated
    // as local time by `new Date(...)`, then sent as a real ISO instant so
    // the backend's `created_at >= $1` / `<= $1` comparisons are unambiguous
    // regardless of what timezone the Postgres server itself is running in.
    if (filterFrom) params.set('from', new Date(filterFrom).toISOString());
    if (filterTo) params.set('to', new Date(filterTo).toISOString());
    fetch(`${apiBase}/api/admin/audit-log?${params}`, { headers: authHeaders(authToken, false) })
      .then((r) => (r.ok ? r.json() : { rows: [], total: 0 }))
      .then((data) => {
        setRows(data.rows);
        setTotal(data.total);
      });
  }, [apiBase, authToken, filterAction, filterUserId, filterFrom, filterTo, page]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  function resetToFirstPage() {
    setPage(1);
  }

  return (
    <div>
      <div className="admin-form-row admin-form-row-wrap">
        <select value={filterAction} onChange={(e) => { setFilterAction(e.target.value); resetToFirstPage(); }}>
          <option value="">{t('admin.auditLog.allActions')}</option>
          {actions.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>

        {filterUsername ? (
          <span className="picked-user">
            {filterUsername}{' '}
            <button onClick={() => { setFilterUserId(''); setFilterUsername(''); resetToFirstPage(); }}>×</button>
          </span>
        ) : (
          <UserPicker
            apiBase={apiBase}
            authToken={authToken}
            placeholder={t('admin.auditLog.filterByUserPlaceholder')}
            onSelect={(u) => { setFilterUserId(u.id); setFilterUsername(u.username); resetToFirstPage(); }}
          />
        )}

        <label className="audit-date-filter">
          {t('admin.auditLog.from')}
          <input
            type="datetime-local"
            value={filterFrom}
            onChange={(e) => { setFilterFrom(e.target.value); resetToFirstPage(); }}
          />
        </label>
        <label className="audit-date-filter">
          {t('admin.auditLog.to')}
          <input
            type="datetime-local"
            value={filterTo}
            onChange={(e) => { setFilterTo(e.target.value); resetToFirstPage(); }}
          />
        </label>
        {(filterAction || filterUserId || filterFrom || filterTo) && (
          <button
            onClick={() => {
              setFilterAction('');
              setFilterUserId('');
              setFilterUsername('');
              setFilterFrom('');
              setFilterTo('');
              resetToFirstPage();
            }}
          >
            {t('admin.auditLog.clearFilters')}
          </button>
        )}
      </div>

      <table className="admin-table">
        <thead>
          <tr>
            <th>{t('admin.auditLog.colTime')}</th><th>{t('admin.auditLog.colUser')}</th><th>{t('admin.auditLog.colAction')}</th><th>{t('admin.auditLog.colConnection')}</th><th>{t('admin.auditLog.colSourceIp')}</th><th>{t('admin.auditLog.colDetail')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{new Date(r.created_at).toLocaleString(i18n.language)}</td>
              <td>{r.username ?? '—'}</td>
              <td>{r.action}</td>
              <td>{r.connection_name ?? '—'}</td>
              <td>{r.source_ip ?? '—'}</td>
              <td className="audit-detail">{JSON.stringify(r.detail)}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={6} className="admin-hint">{t('admin.auditLog.noMatchingEntries')}</td></tr>
          )}
        </tbody>
      </table>

      <div className="admin-form-row">
        <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>{t('admin.auditLog.previous')}</button>
        <span className="admin-hint">{t('admin.auditLog.pageOf', { page, totalPages, total })}</span>
        <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>{t('admin.auditLog.next')}</button>
      </div>
    </div>
  );
}
