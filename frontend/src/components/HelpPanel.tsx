import { useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';

/**
 * End-user help, not admin/developer documentation — that lives in
 * README.md / techdetails.md for people working on the app itself. This is
 * plain-language guidance for someone using the deployed app day to day.
 * Every behavior described here was checked against the actual
 * implementation (SessionViewport.tsx, BookmarkPanel.tsx, etc.) rather than
 * written aspirationally — if the real behavior changes, update this file
 * alongside it.
 */

type Section = 'connections' | 'bookmarks' | 'files' | 'recording' | 'sharing' | 'demos' | 'account';

const SECTION_IDS: Section[] = ['connections', 'bookmarks', 'files', 'recording', 'sharing', 'demos', 'account'];

export function HelpPanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [section, setSection] = useState<Section>('connections');

  return (
    <div className="help-overlay" onClick={onClose}>
      <div className="help-panel" onClick={(e) => e.stopPropagation()}>
        <div className="help-header">
          <span>{t('help.title')}</span>
          <button className="help-close" onClick={onClose}>×</button>
        </div>

        <div className="help-body">
          <nav className="help-nav">
            {SECTION_IDS.map((id) => (
              <button
                key={id}
                className={section === id ? 'is-active' : ''}
                onClick={() => setSection(id)}
              >
                {t(`help.nav.${id}`)}
              </button>
            ))}
          </nav>

          <div className="help-content">
            {section === 'connections' && (
              <>
                <h3>{t('help.connections.title')}</h3>
                <p>{t('help.connections.para1')}</p>
                <p>{t('help.connections.para2')}</p>
                <p>{t('help.connections.para3')}</p>
                <p>
                  <Trans i18nKey="help.connections.para4">
                    You can have several connections open at once. When more than one is
                    open, a row of tabs appears at the top so you can click between them.
                    There's also a <strong>Sessions</strong> button in the top-right corner
                    that always shows what's open, even if only one connection is active —
                    click it to jump to a session or close one.
                  </Trans>
                </p>
                <p>
                  <Trans i18nKey="help.connections.para5">
                    You can also switch with the keyboard: hold the <strong>left</strong> Ctrl and Alt keys together and press the <strong>Left</strong> or <strong>Right</strong> arrow to move to the previous or next session.
                    Press <strong>Up</strong> instead (still holding Ctrl+Alt) to see a
                    snapshot of every open session at once and click the one you want.
                  </Trans>
                </p>
              </>
            )}

            {section === 'bookmarks' && (
              <>
                <h3>{t('help.bookmarks.title')}</h3>
                <p>
                  <Trans i18nKey="help.bookmarks.para1">
                    Bookmarks are plain links you want quick access to, shown alongside
                    your connections. Click <strong>+ Add</strong> at the top of the
                    bookmark list to add one.
                  </Trans>
                </p>
                <p>
                  <Trans i18nKey="help.bookmarks.para2">
                    Most bookmarks are <strong>direct</strong> — they open in a new browser
                    tab like any normal link. Some are marked <strong>proxied</strong>:
                    these point to internal systems your browser can't reach directly, so
                    the app fetches the page on your behalf. Proxied bookmarks work the
                    same way to click, just behind the scenes they're reached differently.
                  </Trans>
                </p>
                <p>{t('help.bookmarks.para3')}</p>
              </>
            )}

            {section === 'files' && (
              <>
                <h3>{t('help.files.title')}</h3>
                <p>
                  <Trans i18nKey="help.files.paraClipboard1">
                    Copying and pasting plain text works both ways, automatically, in
                    every kind of session — RDP, SSH, and the rest. Copy something on
                    your own computer and paste (Ctrl+V) into the session, or copy
                    something inside the session and paste it into another app on your
                    own computer afterward — the same Ctrl+V (or Cmd+V on a Mac) either
                    way, nothing special to remember per session type.
                  </Trans>
                </p>
                <p>{t('help.files.paraClipboard2')}</p>
                <p>
                  <Trans i18nKey="help.files.para1">
                    <strong>To send a file into a session:</strong> drag it from your own
                    computer and drop it anywhere in the session window. You'll see a
                    progress indicator while it uploads.
                  </Trans>
                </p>
                <p>
                  <Trans i18nKey="help.files.para2">
                    On an <strong>RDP</strong> session, the file lands in a folder called
                    "Guacamole Transfer" inside the remote desktop — open that folder to
                    find it. On an <strong>SSH</strong> session, the app types the file's
                    new path at your cursor once the upload finishes, ready to use in a
                    command.
                  </Trans>
                </p>
                <p>
                  <Trans i18nKey="help.files.para3">
                    <strong>To bring a file back out</strong> of an RDP session, drag it
                    into that same "Guacamole Transfer" folder from inside the remote
                    desktop. A small notice appears in the bottom-left of your screen once
                    it's ready — click it to download.
                  </Trans>
                </p>
              </>
            )}

            {section === 'recording' && (
              <>
                <h3>{t('help.recording.title')}</h3>
                <p>
                  <Trans i18nKey="help.recording.para1">
                    While connected, click <strong>Record</strong> near the top of the
                    session window to start recording. The button turns red and shows a
                    timer while recording is active — click it again to stop.
                  </Trans>
                </p>
                <p>{t('help.recording.para2')}</p>
              </>
            )}

            {section === 'sharing' && (
              <>
                <h3>{t('help.sharing.title')}</h3>
                <p>
                  <Trans i18nKey="help.sharing.para1">
                    You can invite someone to watch or help with a session you have open, in
                    real time — useful for training, troubleshooting together, or a second
                    pair of eyes on something. Look for the <strong>Share</strong> button next
                    to Record while a session is open.
                  </Trans>
                </p>
                <p>
                  <Trans i18nKey="help.sharing.para2">
                    Add the person, then choose <strong>View only</strong> (they can watch but
                    not type or click) or <strong>Can control</strong> (they can type and click
                    too, the same as you). You can change this or remove someone at any time —
                    removing someone ends their view immediately, and closing the session
                    yourself ends it for everyone still watching, not just you.
                  </Trans>
                </p>
                <p>
                  <Trans i18nKey="help.sharing.para3">
                    When you share a session, the other person gets a pop-up notification
                    with a <strong>Join</strong> button right away — they don't need to go
                    looking for it. If they'd rather check later, it also shows up under{' '}
                    <strong>Sessions → Shared with you</strong>. Opening it joins the same live
                    session you have open — you're both looking at (and possibly both
                    controlling) the exact same thing at the same time. Being invited into a
                    session doesn't give you any other access to that system beyond what's
                    happening in that session.
                  </Trans>
                </p>
              </>
            )}

            {section === 'demos' && (
              <>
                <h3>{t('help.demos.title')}</h3>
                <p>
                  <Trans i18nKey="help.demos.para1">
                    A demo is a small, curated set of connections and bookmarks someone has
                    put together and shared with you specifically — for example, a demo
                    environment for a particular product walkthrough. Switch to the
                    <strong> Demos</strong> tab at the top of the screen to see any demos
                    shared with you, or to create your own if you have something to
                    curate.
                  </Trans>
                </p>
                <p>{t('help.demos.para2')}</p>
              </>
            )}

            {section === 'account' && (
              <>
                <h3>{t('help.account.title')}</h3>
                <p>{t('help.account.para1')}</p>
                <p>{t('help.account.para2')}</p>
                <p>
                  <Trans i18nKey="help.account.para3">
                    You can switch the app's color theme from the theme picker in the
                    header — <strong>Signal (Dark)</strong>, <strong>Daylight</strong>,{' '}
                    <strong>Midnight</strong>, or <strong>Comic</strong>. This is a personal
                    preference saved on this browser, not something an administrator sets
                    for you.
                  </Trans>
                </p>
                <p>{t('help.account.para4')}</p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
