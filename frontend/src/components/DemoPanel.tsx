import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { openBookmark } from '../lib/openBookmark';
import { UserPicker } from './UserPicker';
import { DemoItemPicker } from './DemoItemPicker';

interface Props {
  apiBase: string;
  authToken: string;
  onOpenConnection: (connectionId: string, protocol: string, name: string) => void;
}

interface DemoSummary {
  id: string;
  slug: string;
  title: string;
  description: string;
}

export function DemoPanel({ apiBase, authToken, onOpenConnection }: Props) {
  const { t } = useTranslation();
  const [owned, setOwned] = useState<DemoSummary[]>([]);
  const [sharedWithMe, setSharedWithMe] = useState<DemoSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [form, setForm] = useState({ slug: '', title: '', description: '' });
  const [error, setError] = useState<string | null>(null);

  function authHeaders(json = false) {
    const headers: Record<string, string> = { Authorization: `Bearer ${authToken}` };
    if (json) headers['Content-Type'] = 'application/json';
    return headers;
  }

  function refresh() {
    fetch(`${apiBase}/api/demos`, { headers: authHeaders() })
      .then((r) => r.json())
      .then((data) => {
        setOwned(data.owned);
        setSharedWithMe(data.sharedWithMe);
      });
  }
  useEffect(refresh, [apiBase, authToken]);

  async function createDemo() {
    setError(null);
    const res = await fetch(`${apiBase}/api/demos`, {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify(form)
    });
    if (!res.ok) return setError((await res.json()).message ?? t('demos.createDemoError'));
    setForm({ slug: '', title: '', description: '' });
    refresh();
  }

  return (
    <div className="demo-panel">
      {!activeId && (
        <>
          <div className="demo-create-form">
            <input
              placeholder={t('demos.slugPlaceholder')}
              value={form.slug}
              onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase() })}
            />
            <input
              placeholder={t('demos.titlePlaceholder')}
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
            <input
              placeholder={t('demos.descriptionPlaceholder')}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
            <button onClick={createDemo}>{t('demos.createDemo')}</button>
          </div>
          {error && <p className="demo-error">{error}</p>}

          <h4>{t('demos.myDemos')}</h4>
          <ul className="demo-list">
            {owned.map((d) => (
              <li key={d.id}>
                <button onClick={() => setActiveId(d.id)}>{d.title} <span className="demo-slug">/{d.slug}</span></button>
              </li>
            ))}
          </ul>

          <h4>{t('demos.sharedWithMe')}</h4>
          <ul className="demo-list">
            {sharedWithMe.map((d) => (
              <li key={d.id}>
                <button onClick={() => setActiveId(d.id)}>{d.title}</button>
              </li>
            ))}
          </ul>
        </>
      )}

      {activeId && (
        <DemoDetail
          apiBase={apiBase}
          authToken={authToken}
          demoId={activeId}
          onBack={() => setActiveId(null)}
          onOpenConnection={onOpenConnection}
        />
      )}
    </div>
  );
}

function DemoDetail({
  apiBase,
  authToken,
  demoId,
  onBack,
  onOpenConnection
}: Props & { demoId: string; onBack: () => void }) {
  const { t, i18n } = useTranslation();
  const [demo, setDemo] = useState<any>(null);
  const [newItem, setNewItem] = useState({ itemType: 'connection', itemId: '', name: '' });
  const [grantUserId, setGrantUserId] = useState('');
  const [grantUsername, setGrantUsername] = useState('');
  const [grantExpiresAt, setGrantExpiresAt] = useState('');
  const [grants, setGrants] = useState<any[]>([]);

  function refreshGrants() {
    fetch(`${apiBase}/api/demos/${demoId}/access`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : []))
      .then(setGrants);
  }
  useEffect(refreshGrants, [demoId, apiBase, authToken]);

  function authHeaders(json = false) {
    const headers: Record<string, string> = { Authorization: `Bearer ${authToken}` };
    if (json) headers['Content-Type'] = 'application/json';
    return headers;
  }

  function refresh() {
    fetch(`${apiBase}/api/demos/${demoId}`, { headers: authHeaders() })
      .then((r) => r.json())
      .then(setDemo);
  }
  useEffect(refresh, [demoId, apiBase, authToken]);

  async function addItem() {
    if (!newItem.itemId) return;
    await fetch(`${apiBase}/api/demos/${demoId}/items`, {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({ itemType: newItem.itemType, itemId: newItem.itemId })
    });
    setNewItem({ itemType: 'connection', itemId: '', name: '' });
    refresh();
  }

  async function removeItem(itemId: string) {
    await fetch(`${apiBase}/api/demos/${demoId}/items/${itemId}`, { method: 'DELETE', headers: authHeaders() });
    refresh();
  }

  async function grantAccess() {
    if (!grantUserId) return;
    await fetch(`${apiBase}/api/demos/${demoId}/access`, {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({
        userId: grantUserId,
        expiresAt: grantExpiresAt ? new Date(grantExpiresAt).toISOString() : null
      })
    });
    setGrantUserId('');
    setGrantUsername('');
    setGrantExpiresAt('');
    refreshGrants();
  }

  async function revokeAccess(userId: string) {
    await fetch(`${apiBase}/api/demos/${demoId}/access/${userId}`, { method: 'DELETE', headers: authHeaders() });
    refreshGrants();
  }

  function openItem(item: any) {
    if (item.itemType === 'connection') {
      onOpenConnection(item.id, item.protocol, item.name);
    } else {
      openBookmark(item, apiBase, authToken);
    }
  }

  if (!demo) return null;

  return (
    <div className="demo-detail">
      <button className="demo-back" onClick={onBack}>{t('demos.backToAllDemos')}</button>
      <h3>{demo.title}</h3>
      <p className="demo-description">{demo.description}</p>

      <ul className="demo-item-list">
        {demo.items.map((item: any) => (
          <li key={item.id}>
            <button className="demo-item" onClick={() => openItem(item)}>
              {item.name}
              <span className="protocol-tag">{item.itemType === 'connection' ? item.protocol : t('demos.linkTag')}</span>
            </button>
            {demo.isOwner && <button className="demo-item-remove" onClick={() => removeItem(item.id)}>{t('share.remove')}</button>}
          </li>
        ))}
      </ul>

      {demo.isOwner && (
        <>
          <div className="demo-form-row">
            {newItem.name ? (
              <span className="picked-user">
                {newItem.name} <button onClick={() => setNewItem({ itemType: 'connection', itemId: '', name: '' })}>×</button>
              </span>
            ) : (
              <DemoItemPicker
                apiBase={apiBase}
                authToken={authToken}
                placeholder={t('demos.itemPickerPlaceholder')}
                onSelect={(item) => setNewItem({ itemType: item.item_type, itemId: item.id, name: item.name })}
              />
            )}
            <button onClick={addItem}>{t('demos.addItem')}</button>
          </div>
          <p className="demo-hint">
            {t('demos.addItemHint')}
          </p>

          <div className="demo-form-row">
            {grantUsername ? (
              <span className="picked-user">
                {grantUsername} <button onClick={() => { setGrantUserId(''); setGrantUsername(''); }}>×</button>
              </span>
            ) : (
              <UserPicker
                apiBase={apiBase}
                authToken={authToken}
                placeholder={t('demos.searchUsernamePlaceholder')}
                onSelect={(u) => { setGrantUserId(u.id); setGrantUsername(u.username); }}
              />
            )}
            <input
              type="date"
              title={t('demos.expiryDateTitle')}
              value={grantExpiresAt}
              onChange={(e) => setGrantExpiresAt(e.target.value)}
            />
            <button onClick={grantAccess}>{t('demos.grantAccess')}</button>
          </div>
          <p className="demo-hint">
            {t('demos.grantAccessHint')}
          </p>

          {grants.length > 0 && (
            <ul className="demo-grant-list">
              {grants.map((g) => (
                <li key={g.id}>
                  <span>{g.username}</span>
                  <span className={`demo-grant-expiry ${g.is_expired ? 'is-expired' : ''}`}>
                    {g.expires_at ? (g.is_expired ? t('demos.expired') : t('demos.untilDate', { date: new Date(g.expires_at).toLocaleDateString(i18n.language) })) : t('demos.noExpiry')}
                  </span>
                  <button onClick={() => revokeAccess(g.id)}>{t('admin.groups.revoke')}</button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
