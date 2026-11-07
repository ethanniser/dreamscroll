import './policy.js';
import './feed.js';
import './timeline.js';
const P = globalThis.SocialPolicy;
const F = globalThis.SocialFeed;
const TL = globalThis.SocialTimeline;
const dnr = chrome.declarativeNetRequest;
const gateURL = site => chrome.runtime.getURL(`blocked.html?site=${site === 'instagram' ? 'instagram' : 'x'}`);
let queue = Promise.resolve();
const serial = task => { const next = queue.then(task); queue = next.catch(() => {}); return next; };
async function validateRules(rules) {
  for (const rule of rules) {
    const result = await dnr.isRegexSupported({regex:rule.condition.regexFilter,isCaseSensitive:true,requireCapturing:false});
    if (!result.isSupported) throw Error(`Chrome cannot compile rule ${rule.id} (${result.reason || 'unsupported regex'}): ${rule.condition.regexFilter.slice(0, 120)}`);
  }
}
function allowed(url) {
  const view=P.view(url);
  return !!view && view.kind !== 'home';
}
// ============ Feed snapshots and scroll budget (X home, For You) ============
// The batch is a snapshot: 10 For You tweets captured from a hidden window and shown
// on the extension's own feed page, the same for 2 hours. Home itself stays blocked
// unless a tab holds a grant: 'capture' (the hidden window) or 'unlocked' (spends the
// daily budget). A grant is a tab-scoped session rule letting x.com/home load there only.
const FEED_HOME = /^https:\/\/x\.com\/(?:home\/?)?(?:[?#]|$)/;
const feedRule = (tabId, id) => ({id, priority:30, action:{type:'allow'}, condition:{regexFilter:'^https://x\\.com/(?:home/?)?(?:[?#]|$)', isUrlFilterCaseSensitive:true, tabIds:[tabId], resourceTypes:['main_frame']}});
let grants = null, grantsLoad = null;
async function loadGrants() {
  grantsLoad ||= chrome.storage.session.get('grants').catch(() => ({})).then(stored => { grants ||= stored.grants || {}; return grants; });
  return grantsLoad;
}
const saveGrants = () => chrome.storage.session.set({grants}).catch(() => {});
async function grant(tabId, mode, day = null) {
  const all = await loadGrants();
  const ruleId = all[tabId]?.ruleId ?? 100000 + (Object.values(all).reduce((max, g) => Math.max(max, g.ruleId - 100000), 0) + 1);
  await dnr.updateSessionRules({removeRuleIds:[ruleId], addRules:[feedRule(tabId, ruleId)]});
  all[tabId] = {mode, ruleId, day};
  await saveGrants();
}
async function revoke(tabId) {
  const all = await loadGrants();
  if (!all[tabId]) return;
  await dnr.updateSessionRules({removeRuleIds:[all[tabId].ruleId]}).catch(() => {});
  delete all[tabId];
  await saveGrants();
}
chrome.tabs.onRemoved?.addListener(tabId => void serial(() => revoke(tabId)));

let lastRemote = 0, lastSpendFlush = 0;
async function remote(sync, op, body) {
  const url = new URL(`/dreamscroll/${op}`, sync.endpoint);
  if (op === 'state') url.searchParams.set('day', F.localDay());
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, {method: op === 'state' ? 'GET' : 'POST', headers:{authorization:`Bearer ${sync.token}`, 'content-type':'application/json'}, body: op === 'state' ? undefined : JSON.stringify(body), signal: controller.signal});
    if (!res.ok) throw Error(res.status === 401 ? 'The sync server rejected the token (401).' : `Sync failed (${res.status}).`);
    return await res.json();
  } finally { clearTimeout(timer); }
}
/** Applies an operation locally, then (when configured) syncs with the sync server, whose state wins. See docs/sync-api.md. */
async function feedOp(op, payload = {}, {fresh = false, local = false} = {}) {
  const stored = await chrome.storage.local.get(['feed', 'sync']);
  const feed = stored.feed || {snapshot:null, budget:{day:F.localDay(), usedMs:0}, pendingSnapshot:false, pendingSpendMs:0};
  // Offline, the clock can't be wound back to reopen a batch or restart the day.
  const now = Math.max(Date.now(), feed.highWater || 0), day = F.localDay(new Date(now));
  feed.highWater = now;
  const sync = stored.sync?.endpoint && stored.sync?.token ? stored.sync : null;
  // Without sync the device's day rolls the budget over. With sync, the server decides the
  // day (its time zone may differ from this device's), so nothing resets locally.
  if (!sync && feed.budget.day !== day) { feed.budget = {day, usedMs:0}; feed.pendingSpendMs = 0; }
  if (op === 'snapshot') {
    const next = F.openSnapshot(feed.snapshot, TL.sanitizeTweets(payload.tweets), now);
    if (next !== feed.snapshot) { feed.snapshot = next; feed.pendingSnapshot = true; feed.snapshotRefused = false; }
  }
  if (op === 'spend') {
    const after = F.spend(feed.budget.usedMs, payload.ms);
    feed.pendingSpendMs += after - feed.budget.usedMs;
    feed.budget.usedMs = after;
  }
  let state = F.publicState(feed.snapshot, feed.budget.day, feed.budget.usedMs, now), synced = false, syncError = null, keptLocal = false;
  const due = fresh || feed.pendingSnapshot || (feed.pendingSpendMs > 0 && now - lastSpendFlush >= 15000) || now - lastRemote >= 10000;
  // Access to the server is an optional permission: without it, say so instead of a network error.
  const allowed = !sync || !chrome.permissions || await chrome.permissions.contains({origins:[`${sync.endpoint}/*`]}).catch(() => false);
  if (sync && !allowed) syncError = `Dreamscroll needs permission to reach ${new URL(sync.endpoint).host}. Click Reconnect.`;
  if (sync && allowed && due && !local) {
    try {
      // The first snapshot of a window wins: the server may answer with another device's.
      if (feed.pendingSnapshot && F.isActive(feed.snapshot, now)) {
        try { state = await remote(sync, 'snapshot', {tweets:feed.snapshot.tweets}); }
        catch (error) { if (!/\(4\d\d\)/.test(error.message)) throw error; feed.pendingSnapshot = false; feed.snapshotRefused = true; syncError = error.message; }
      }
      // Bounded per sync; anything left is sent next time rather than dropped.
      for (let i = 0; feed.pendingSpendMs > 0 && i < 6; i++) {
        const ms = Math.min(feed.pendingSpendMs, F.RULES.maxSpendPerReportMs);
        state = await remote(sync, 'spend', {ms});
        feed.pendingSpendMs -= ms;
        lastSpendFlush = now;
      }
      if (state.now === now) state = await remote(sync, 'state', {});
      feed.pendingSnapshot = false;
      // Keep a local batch the server refused (until it ends); otherwise the server's snapshot,
      // maybe another device's, wins.
      keptLocal = !(state.batch.active || !feed.snapshotRefused || !F.isActive(feed.snapshot, now));
      if (!keptLocal) feed.snapshot = state.batch.active ? {startedAt:state.batch.startedAt, endsAt:state.batch.endsAt, tweets:TL.sanitizeTweets(state.batch.tweets)} : null;
      // The server decides the day (in its configured time zone).
      feed.budget = {day:state.budget.day || day, usedMs:state.budget.usedMs};
      lastRemote = now;
      synced = !syncError;
    } catch (error) { syncError = error.message || 'The sync server is unreachable.'; }
  } else if (!sync) { feed.pendingSnapshot = false; feed.pendingSpendMs = 0; }
  if (!synced || syncError || keptLocal) state = F.publicState(feed.snapshot, feed.budget.day, feed.budget.usedMs, now);
  await chrome.storage.local.set({feed});
  return {...state, sync:{configured:!!sync, endpoint:sync?.endpoint ?? null, synced, error:syncError}};
}
/** Read tweet ids that are in this batch (so read state survives sync adopting the batch). */
async function readIds(tweets) {
  const inBatch=new Set((tweets || []).map(t => t.id));
  const {feedRead}=await chrome.storage.local.get(['feedRead']);
  return (feedRead?.ids || []).filter(id => inBatch.has(id));
}
/** What a granted tab may see right now, or null when its grant no longer applies. */
function feedView(g, state, url) {
  // The capture grant is this one hidden tab's, and grantedFeed has already checked it's X home.
  if (g?.mode === 'capture') return {kind:'capture', site:'x'};
  if (g?.mode === 'unlocked' && g.day === state.budget.day && state.budget.remainingMs > 0) return {kind:'feed', site:'x', mode:'unlocked'};
  return null;
}
const clockTime = ts => new Date(ts).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'});
const feedSummary = state => ({count:state.batch.tweets.length, size:state.batch.size, active:state.batch.active, startedAt:state.batch.startedAt, endsAt:state.batch.endsAt, remainingMs:state.budget.remainingMs, limitMs:state.budget.limitMs});
async function grantedFeed(tabId, url) {
  if (!FEED_HOME.test(url)) return null;
  const g = (await loadGrants())[tabId];
  if (!g) return null;
  // The local copy only: a slow sync server must never hold up every page check.
  const state = await feedOp('state', {}, {local:true});
  const view = feedView(g, state, url);
  if (!view) await revoke(tabId);
  return view && {view, state};
}

// Capture: load X home in a minimized window, take the first For You tweets from
// the timeline data X downloads (capture-main.js → content.js), then close it.
const captures = new Map();
async function captureFeed() {
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const win = await chrome.windows.create({url:'about:blank', state:'minimized', focused:false});
  const tabId = win.tabs[0].id;
  // If the worker restarts mid-capture, startup closes this window (see below).
  await chrome.storage.session.set({capture:{windowId:win.id, tabId}}).catch(() => {});
  let timer;
  try {
    await serial(() => grant(tabId, 'capture'));
    const captured = new Promise((resolve, reject) => {
      captures.set(tabId, {nonce, resolve});
      timer = setTimeout(() => reject(Error('X didn’t load your feed in time. Check you’re signed in to X, then try again.')), 30000);
    });
    // The nonce goes in the fragment: it reaches the page's scripts but is never sent to X.
    await chrome.tabs.update(tabId, {url:`https://x.com/home#sf_capture=${nonce}`});
    return await captured;
  } finally {
    clearTimeout(timer);
    captures.delete(tabId);
    await serial(() => revoke(tabId)).catch(() => {});
    await chrome.windows.remove(win.id).catch(() => {});
    await chrome.storage.session.remove('capture').catch(() => {});
  }
}
// A capture interrupted by a worker restart can't finish: close its window and grant.
void chrome.storage.session.get('capture').then(async ({capture}) => {
  if (!capture || captures.size) return;
  await chrome.windows.remove(capture.windowId).catch(() => {});
  await serial(() => revoke(capture.tabId)).catch(() => {});
  await chrome.storage.session.remove('capture').catch(() => {});
}).catch(() => {});
let capturing = null;
async function openFeed(sender) {
  // State changes go through the queue; only the capture itself runs outside it.
  let state = await serial(() => feedOp('state', {}, {fresh:true}));
  if (!state.batch.active) {
    // One capture at a time, even if the button is pressed twice.
    capturing ||= captureFeed().finally(() => { capturing = null; });
    const tweets = await capturing;
    if (!tweets.length) throw Error('Couldn’t read your For You feed. Try again in a moment.');
    state = await serial(() => feedOp('snapshot', {tweets}));
  }
  const url = chrome.runtime.getURL('feed.html');
  if (sender.tab) await chrome.tabs.update(sender.tab.id, {url, active:true});
  else await chrome.tabs.create({url, active:true});
  return {opened:true, ...feedSummary(state)};
}
async function openUnlocked(sender) {
  const state = await feedOp('state', {}, {fresh:true});
  if (state.budget.remainingMs <= 0) throw Error('Today’s scroll budget is used up.');
  // The rule must exist before the tab navigates, so a popup opens a blank tab first.
  const tab = sender.tab || await chrome.tabs.create({url:'about:blank', active:true});
  await grant(tab.id, 'unlocked', state.budget.day);
  await chrome.tabs.update(tab.id, {url:'https://x.com/home', active:true});
  return {opened:true, ...feedSummary(state)};
}

async function enforce(tabId,url) {
  // Leaving X (e.g. Done → the dashboard) ends this tab's feed grant.
  if (!P.social(url)) { if ((await loadGrants())[tabId]) await revoke(tabId); return; }
  if (allowed(url)) return;
  if (await grantedFeed(tabId, url)) return;
  const current=await chrome.tabs.get(tabId).catch(() => null);
  if (current?.url === url && (!current.pendingUrl || current.pendingUrl === url)) await chrome.tabs.update(tabId,{url:gateURL(P.site(url))}).catch(() => {});
}
function uiPage(sender) {
  if (sender.id !== chrome.runtime.id || (sender.tab && sender.frameId !== 0)) return null;
  try {
    const url=new URL(sender.url);
    if (url.protocol !== 'chrome-extension:' || url.hostname !== chrome.runtime.id) return null;
    return ['/blocked.html','/feed.html'].includes(url.pathname) ? url.pathname : null;
  } catch { return null; }
}
async function openDestination(url,sender) {
  if (sender.tab) await chrome.tabs.update(sender.tab.id,{url,active:true});
  else await chrome.tabs.create({url,active:true});
  return {opened:true};
}
chrome.runtime.onMessage.addListener((message,sender,respond) => {
  if (!message || typeof message.type !== 'string') { respond({error:'Invalid message.'}); return false; }
  const ui=uiPage(sender),content=sender.id === chrome.runtime.id && sender.tab && sender.frameId === 0 && P.social(sender.url);
  if (content && message.type === 'captured') {
    const pending=captures.get(sender.tab.id);
    if (!pending || message.nonce !== pending.nonce) { respond({error:'Not permitted.'}); return false; }
    pending.resolve(TL.sanitizeTweets(message.tweets));
    respond({ok:true}); return false;
  }
  if (ui && message.type === 'feed') { openFeed(sender).then(respond,error=>respond({error:error.message})); return true; }
  let task;
  // After an in-page (pushState) navigation, sender.url can still be the previous
  // page. The content script reports the URL it is actually on; trust it only
  // within the same site as the tab, so a page can't borrow another site's rules.
  const pageUrl=content && typeof message.url === 'string' && P.site(message.url) && P.site(message.url) === P.site(sender.url) ? message.url : sender.url;
  if (content && message.type === 'check') task=async()=>{
    const feed=await grantedFeed(sender.tab.id,pageUrl);
    if (feed) return {allowed:true,view:feed.view,post:null,feed:feed.view.kind === 'feed' ? feedSummary(feed.state) : null};
    return {allowed:allowed(pageUrl),view:P.view(pageUrl),post:P.post(pageUrl)};
  };
  else if (content && message.type === 'feedTick') task=async()=>{
    const g=(await loadGrants())[sender.tab.id];
    if (!FEED_HOME.test(pageUrl) || g?.mode !== 'unlocked') throw Error('Not permitted.');
    const state=await feedOp('spend',{ms:message.ms});
    // Budget gone: the unlocked tab closes back to the dashboard.
    if (state.budget.remainingMs <= 0) await revoke(sender.tab.id);
    return {mode:(await loadGrants())[sender.tab.id]?.mode || null, ...feedSummary(state)};
  };
  else if (content && message.type === 'feedDone') task=async()=>{
    if (!(await loadGrants())[sender.tab.id]) throw Error('Not permitted.');
    await revoke(sender.tab.id); return {done:true};
  };
  else if (content && message.type === 'unlock') task=async()=>{
    if (!FEED_HOME.test(pageUrl) || (await loadGrants())[sender.tab.id]?.mode !== 'unlocked') throw Error('Not permitted.');
    const state=await feedOp('state',{},{fresh:true});
    if (state.budget.remainingMs <= 0) throw Error('Today’s scroll budget is used up.');
    await grant(sender.tab.id,'unlocked',state.budget.day);
    return {mode:'unlocked', ...feedSummary(state)};
  };
  else if (ui && message.type === 'feedStatus') task=async()=>{
    const state=await feedOp('state',{},{fresh:true});
    return {...feedSummary(state), sync:state.sync};
  };
  else if (ui && message.type === 'snapshot') task=async()=>{
    const state=await feedOp('state');
    return {...feedSummary(state), tweets:state.batch.tweets, read:await readIds(state.batch.tweets)};
  };
  // Tweets swiped away as read. Only ids in the current batch are kept, so a stale page can't
  // mark another batch, and a new batch starts with nothing read (old ids are dropped).
  else if (ui === '/feed.html' && message.type === 'feedRead') task=async()=>{
    const ids=Array.isArray(message.ids) ? message.ids.filter(id => typeof id === 'string' && /^\d{1,25}$/.test(id)) : [];
    if (!ids.length) throw Error('Invalid message.');
    const {feed}=await chrome.storage.local.get(['feed']);
    const inBatch=new Set((feed?.snapshot?.tweets || []).map(t => t.id));
    const current=new Set(await readIds(feed?.snapshot?.tweets));
    for (const id of ids) if (inBatch.has(id)) message.read === false ? current.delete(id) : current.add(id);
    await chrome.storage.local.set({feedRead:{ids:[...current]}});
    return {read:[...current]};
  };
  else if (ui && message.type === 'unlock') task=()=>openUnlocked(sender);
  else if (ui === '/blocked.html' && message.type === 'syncConfig') task=async()=>{
    const endpoint=typeof message.endpoint === 'string' ? message.endpoint.trim().replace(/\/+$/,'') : '';
    if (!endpoint && !message.token) { await chrome.storage.local.remove('sync'); return {configured:false}; }
    let url;
    try { url=new URL(endpoint); } catch { throw Error('Enter your sync server’s https:// address.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('Enter your sync server’s https:// address (no path).');
    // An empty token field keeps the saved token, but only for the same server (never sent elsewhere).
    const saved=(await chrome.storage.local.get(['sync'])).sync;
    const token=typeof message.token === 'string' && message.token.trim() ? message.token.trim() : saved?.endpoint === url.origin ? saved.token : '';
    if (token.length < 32) throw Error('Enter the sync token (32+ characters).');
    // The page asks for this origin when Save is clicked (optional host permission).
    if (chrome.permissions && !(await chrome.permissions.contains({origins:[`${url.origin}/*`]}))) throw Error(`Allow Dreamscroll to reach ${url.host} to sync with it.`);
    await remote({endpoint:url.origin,token},'state',{});
    await chrome.storage.local.set({sync:{endpoint:url.origin,token}});
    lastRemote=0;
    return {configured:true};
  };
  // The sync details as a dreamscroll:// link, shown as a QR code on the main page for the
  // iPhone app to scan. Only the extension's own main page may read the token back.
  else if (ui === '/blocked.html' && message.type === 'syncShare') task=async()=>{
    const {sync}=await chrome.storage.local.get(['sync']);
    if (!sync?.endpoint || !sync?.token) throw Error('Save the sync URL and token here first.');
    return {link:`dreamscroll://sync?endpoint=${encodeURIComponent(sync.endpoint)}&token=${encodeURIComponent(sync.token)}`};
  };
  else if (ui && message.type === 'open') task=async()=>{
    const target=P.destination(message.url);
    if (!target) throw Error('Paste a full https:// link to a post, account, or personal destination.');
    return openDestination(target.url,sender);
  };
  else if (ui && message.type === 'profile') task=async()=>{
    if (!['x','instagram'].includes(message.site) || typeof message.username !== 'string') throw Error('Choose a site and enter a username.');
    const handle=message.username.trim().replace(/^@/,'');
    const url=`https://${message.site === 'x' ? 'x.com' : 'www.instagram.com'}/${encodeURIComponent(handle)}/`;
    if (P.view(url)?.kind !== 'profile') throw Error('Enter a valid account username.');
    return openDestination(url,sender);
  };
  else if (ui && message.type === 'search') task=async()=>{
    if (message.site !== 'x' || typeof message.query !== 'string' || !message.query.trim()) throw Error('Enter an X search.');
    return openDestination(`https://x.com/search?q=${encodeURIComponent(message.query.trim())}&src=typed_query`,sender);
  };
  else if (ui && message.type === 'personal') task=async()=>{
    const url=P.personalURLs[message.site]?.[message.action];
    if (typeof url !== 'string' || !P.view(url)) throw Error('Choose a supported action.');
    return openDestination(url,sender);
  };
  else { respond({error:'Not permitted.'}); return false; }
  serial(task).then(respond,error=>respond({error:error.message}));return true;
});
// The toolbar icon opens the main page in a new tab.
chrome.action.onClicked.addListener(()=>void chrome.tabs.create({url:chrome.runtime.getURL('blocked.html?site=x')}));
const guard=details=>{if(details.frameId===0)serial(()=>enforce(details.tabId,details.url)).catch(console.error);};
chrome.webNavigation.onCommitted.addListener(guard);
chrome.webNavigation.onHistoryStateUpdated.addListener(guard);
chrome.webNavigation.onReferenceFragmentUpdated.addListener(guard);
// Retire old modes and focused-home sessions. Home always returns to the launcher.
chrome.runtime.onInstalled.addListener(()=>{serial(async()=>{
  const [dynamic,session]=await Promise.all([dnr.getDynamicRules(),dnr.getSessionRules()]);
  await dnr.updateDynamicRules({removeRuleIds:dynamic.map(rule=>rule.id)});
  await dnr.updateSessionRules({removeRuleIds:session.map(rule=>rule.id)});
  await chrome.action.setBadgeText({text:''});
  // Re-gate open tabs first. After an install or update, scripts in already-open
  // tabs are orphaned (or absent) and Chrome won't inject new ones: send feeds to
  // the gate and reload allowed views so they run the current content script.
  const tabs=await chrome.tabs.query({url:['*://*.x.com/*','*://*.twitter.com/*','*://*.instagram.com/*']});
  await Promise.all(tabs.map(tab=>allowed(tab.url) ? chrome.tabs.reload(tab.id).catch(()=>{}) : enforce(tab.id,tab.url)));
  await validateRules(P.staticRules().filter(rule=>rule.condition.regexFilter));
}).catch(console.error);});
