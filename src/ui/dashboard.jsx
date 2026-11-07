// The main page: one input for both sites, the X For You batch, and both sites' tiles.
// (Unlocked scrolling still exists in the worker; it's just not offered here.)
// Built with Base UI components; bundled to extension/popup.js (bun run build:ui).
import {useCallback, useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Autocomplete} from '@base-ui/react/autocomplete';
import {Button} from '@base-ui/react/button';
import {Collapsible} from '@base-ui/react/collapsible';
import {Dialog} from '@base-ui/react/dialog';
import {Form} from '@base-ui/react/form';
import {Input} from '@base-ui/react/input';
import {encode} from 'uqr';
import {UNAVAILABLE, clock, request} from './shared.js';
import {Mark} from './Mark.jsx';

const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/, IG_HANDLE = /^[A-Za-z0-9_.]{1,30}$/;
/**
 * One input for both sites: a link opens it; otherwise the choices are an X search
 * and the account on X and on Instagram. Enter takes the first choice ("@" puts the
 * accounts first).
 */
export function choices(raw) {
  const value = raw.trim();
  if (!value) return [];
  if (/^(https?:\/\/)?([a-z0-9-]+\.)*(x|twitter|instagram)\.com\//i.test(value) || /^https?:\/\//i.test(value)) {
    return [{label:'Open link', payload:{type:'open', url:/^https?:\/\//i.test(value) ? value : `https://${value}`}}];
  }
  const handle = value.replace(/^@/, '');
  const search = {label:`Search X for “${value}”`, payload:{type:'search', site:'x', query:value}};
  const accounts = [
    X_HANDLE.test(handle) && {label:`@${handle} on X`, payload:{type:'profile', site:'x', username:handle}},
    IG_HANDLE.test(handle) && {label:`@${handle} on Instagram`, payload:{type:'profile', site:'instagram', username:handle}},
  ].filter(Boolean);
  return value.startsWith('@') ? [...accounts, search] : [search, ...accounts];
}
globalThis.SocialDashboard = {choices};

const Message = ({text}) => <p id="message" role="alert">{text}</p>;

/** Asks for network access to the sync server's origin (an optional host permission). */
function allowOrigin(endpoint) {
  let origin;
  try { origin = new URL(endpoint.trim()).origin; } catch { return Promise.resolve(true); }  // the worker explains bad URLs
  if (!/^https:/.test(origin) || !chrome.permissions?.request) return Promise.resolve(true);
  return chrome.permissions.request({origins:[`${origin}/*`]}).catch(() => false);
}

/** A QR code as SVG squares (no markup from strings). */
function QR({text}) {
  const {data, size} = encode(text, {ecc:'M', border:2});
  const cells = [];
  data.forEach((row, y) => row.forEach((on, x) => { if (on) cells.push(`M${x} ${y}h1v1h-1z`); }));
  return (
    <svg className="qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Sync QR code" shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={cells.join('')} fill="#000" />
    </svg>
  );
}
/** Shows the sync details as a QR code for the iPhone app (Settings › Scan QR code, or the Camera app). */
function SyncQR({disabled}) {
  const [link, setLink] = useState(null);
  const [error, setError] = useState('');
  return (
    <Dialog.Root onOpenChange={open => {
      setLink(null); setError('');
      if (open) request({type:'syncShare'}).then(result => setLink(result.link), e => setError(e.message));
    }}>
      <Dialog.Trigger id="sync-qr" className="quiet" disabled={disabled}>QR for iPhone</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="dialog-backdrop" />
        <Dialog.Popup className="dialog">
          <Dialog.Title className="dialog-title">Scan on your iPhone</Dialog.Title>
          <Dialog.Description className="dialog-text">In Dreamscroll, open Settings › Scan QR code. The camera app works too.</Dialog.Description>
          {link ? <QR text={link} /> : <div className="qr qr-empty">{error ? null : 'Loading…'}</div>}
          {error && <p className="dialog-text dialog-error" role="alert">{error}</p>}
          <p className="dialog-text dialog-warning">This code contains your sync token. Don’t share it.</p>
          <Dialog.Close className="dialog-close">Done</Dialog.Close>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Dashboard() {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  // Errors show under what was used: {where, text}. Success needs no message: the tab navigates away.
  const [error, setError] = useState(null);
  const [feed, setFeed] = useState(null);
  const [fetching, setFetching] = useState(false);
  const [endpoint, setEndpoint] = useState('');
  const [token, setToken] = useState('');
  // Sync: once a server is saved, show its status; the form is only for a new server.
  const [changing, setChanging] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);

  const refreshFeed = useCallback(async () => {
    try { setFeed(await chrome.runtime.sendMessage({type:'feedStatus'})); }
    catch { setFeed({error:UNAVAILABLE}); }
  }, []);
  useEffect(() => { void refreshFeed(); }, [refreshFeed]);

  async function run(where, task) {
    setBusy(true); setError(null);
    try { await task(); }
    catch (e) { setError({where, text:e.message}); }
    finally { setBusy(false); setFetching(false); }
  }
  const at = where => error?.where === where ? <Message text={error.text} /> : null;

  const list = choices(query);
  const go = choice => void run('go', () => request(choice.payload));

  const status = !feed ? '' : feed.error ? feed.error : fetching ? 'Fetching…'
    : feed.active ? `${feed.count} tweets · until ${clock(feed.endsAt)}` : `${feed.size} new tweets`;
  const sync = feed && !feed.error ? feed.sync : null;
  const badge = !sync ? '' : !sync.configured ? 'off' : sync.synced ? 'on' : 'error';
  const syncProblem = !!(sync?.configured && sync.error);
  useEffect(() => { if (syncProblem) setSyncOpen(true); }, [syncProblem]);  // show the reason once
  let syncHost = '';
  try { syncHost = sync?.endpoint ? new URL(sync.endpoint).host : ''; } catch { /* shown blank */ }

  const tile = (site, action, label) => (
    <Button key={action} data-site={site} data-action={action} disabled={busy}
      onClick={() => void run(`tiles-${site}`, () => request({type:'personal', site, action}))}>{label}</Button>
  );

  return (
    <main className="app" aria-busy={busy || undefined}>
      <header className="bar"><span className="brand"><Mark />Dreamscroll</span></header>

      <Form id="go-form" className="go" noValidate onSubmit={event => {
        event.preventDefault();
        const [first] = choices(query);
        if (first) go(first);
      }}>
        <Autocomplete.Root items={list} filter={null} autoHighlight openOnInputClick
          itemToStringValue={choice => choice.label} value={query}
          onValueChange={(value, details) => {
            // Picking a choice acts on it; the input keeps what was typed.
            if (details.reason === 'item-press') return;
            setQuery(value); setError(null);
          }}>
          <Autocomplete.Input id="go" autoFocus autoComplete="off" autoCapitalize="none" spellCheck={false}
            placeholder="Search X, @username or link" aria-label="Search X, username or link" />
          {list.length > 0 && (
            <Autocomplete.Portal>
              <Autocomplete.Positioner className="suggestions-positioner" sideOffset={6}>
                <Autocomplete.Popup className="suggestions">
                  <Autocomplete.List id="suggestions" aria-label="Go to">
                    {choice => (
                      <Autocomplete.Item key={choice.label} value={choice} className="suggestion" disabled={busy}
                        onClick={() => go(choice)}>{choice.label}</Autocomplete.Item>
                    )}
                  </Autocomplete.List>
                </Autocomplete.Popup>
              </Autocomplete.Positioner>
            </Autocomplete.Portal>
          )}
        </Autocomplete.Root>
      </Form>
      {at('go')}

      <section className="site" aria-labelledby="x-label">
        <h2 id="x-label" className="site-label">X</h2>
        <div id="feed-panel" className="foryou">
          <Button id="open-feed" className="foryou-open" disabled={busy} onClick={() => void run('feed', async () => {
            // A new batch is captured from X in a hidden window first; that takes a few seconds.
            if (!feed?.active) setFetching(true);
            await request({type:'feed'});
          }).then(refreshFeed)}>
            <span className="foryou-title">For You</span>
            <span id="feed-status" className="foryou-status">{status}</span>
          </Button>
        </div>
        {at('feed')}
        <div className="tiles">
          {tile('x', 'notifications', 'Notifications')}
          {tile('x', 'messages', 'Messages')}
          {tile('x', 'compose', 'Post')}
          {tile('x', 'saved', 'Saved')}
        </div>
        {at('tiles-x')}
      </section>

      <section className="site" aria-labelledby="ig-label">
        <h2 id="ig-label" className="site-label">Instagram</h2>
        <div className="tiles">
          {tile('instagram', 'notifications', 'Notifications')}
          {tile('instagram', 'messages', 'Messages')}
          {tile('instagram', 'saved', 'Saved')}
        </div>
        {at('tiles-instagram')}
      </section>

      <Collapsible.Root id="sync" className="sync" open={syncOpen} onOpenChange={setSyncOpen}>
        <Collapsible.Trigger className="sync-trigger">
          Sync <span id="sync-badge" className="sync-badge" title={sync?.error || undefined}>{badge}</span>
        </Collapsible.Trigger>
        <Collapsible.Panel keepMounted className="sync-panel">
          {sync?.configured && !changing ? (
            <div id="sync-status" className="sync-status">
              <p className="sync-line">{sync.synced ? 'Synced with ' : 'Not syncing with '}<b>{syncHost}</b></p>
              {sync.error && <p className="sync-error">{sync.error}</p>}
              <div className="sync-actions">
                {!sync.synced && (
                  <Button id="sync-reconnect" disabled={busy} onClick={() => {
                    // Asks again for access (within the click) and re-checks with the saved token.
                    const allowed = allowOrigin(sync.endpoint);
                    void run('sync', async () => {
                      if (!(await allowed)) throw Error('Dreamscroll needs access to that server to sync with it.');
                      await request({type:'syncConfig', endpoint:sync.endpoint, token:''});
                      await refreshFeed();
                    });
                  }}>Reconnect</Button>
                )}
                <SyncQR disabled={busy} />
                <Button id="sync-change" className="quiet" disabled={busy} onClick={() => { setEndpoint(sync.endpoint || ''); setToken(''); setChanging(true); }}>Change server</Button>
                <Button id="sync-clear" className="quiet" disabled={busy} onClick={() => void run('sync', async () => {
                  await request({type:'syncConfig', endpoint:'', token:''});
                  await refreshFeed();
                })}>Use this device only</Button>
              </div>
            </div>
          ) : (
            <Form id="sync-form" noValidate onSubmit={event => {
              event.preventDefault();
              // Chrome only shows the permission prompt during the click, so ask before anything awaits.
              const allowed = allowOrigin(endpoint);
              void run('sync', async () => {
                if (!(await allowed)) throw Error('Dreamscroll needs access to that server to sync with it.');
                await request({type:'syncConfig', endpoint, token});
                setToken(''); setChanging(false);
                await refreshFeed();
              });
            }}>
              <Input id="sync-endpoint" type="text" inputMode="url" placeholder="https://your-sync-server.example" autoComplete="off" spellCheck={false}
                aria-label="Sync server address" value={endpoint} onValueChange={setEndpoint} />
              <Input id="sync-token" type="password" placeholder="Token" autoComplete="off"
                aria-label="Sync token" value={token} onValueChange={setToken} />
              <div className="sync-actions">
                <Button type="submit" disabled={busy}>Save</Button>
                {changing && <Button id="sync-cancel" className="quiet" disabled={busy} onClick={() => setChanging(false)}>Cancel</Button>}
              </div>
            </Form>
          )}
          {at('sync')}
        </Collapsible.Panel>
      </Collapsible.Root>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<Dashboard />);
