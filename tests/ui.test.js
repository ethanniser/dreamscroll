import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const script = await readFile(new URL('../extension/popup.js', import.meta.url), 'utf8');
async function ui(page = 'blocked.html', query = '', feed = {size:20, count:0, active:false, remainingMs:900000, endsAt:null, sync:{configured:false}}) {
  const html = await readFile(new URL(`../extension/${page}`, import.meta.url), 'utf8');
  const dom = new JSDOM(html, {url:`https://extension.local/${page}${query}`, runScripts:'outside-only', pretendToBeVisual:true});
  const calls = [];
  dom.window.chrome = {runtime:{sendMessage:async payload => { if (payload.type === 'feedStatus') return feed; calls.push(JSON.parse(JSON.stringify(payload))); return {ok:true}; }}};
  dom.window.eval(script);
  await until(() => dom.window.document.getElementById('go'));
  return {dom, document:dom.window.document, calls};
}
function submit(document, id) {
  const form = document.getElementById(id);
  form.dispatchEvent(new document.defaultView.Event('submit', {bubbles:true, cancelable:true}));
}
// React renders asynchronously: wait for a condition rather than a fixed number of ticks.
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(check, what = 'condition') {
  for (let i = 0; i < 200; i++) { const value = check(); if (value) return value; await settle(); }
  throw Error(`Timed out waiting for ${what}`);
}
/** Types into a React-controlled input (React tracks the native value setter). */
function type(input, value) {
  const window = input.ownerDocument.defaultView;
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
  input.dispatchEvent(new window.Event('input', {bubbles:true}));
}

test('one input for both sites: links open; otherwise search X or open either account', async () => {
  const {dom, document, calls} = await ui('blocked.html');
  const {choices} = dom.window.SocialDashboard;
  const labels = value => JSON.parse(JSON.stringify(choices(value).map(c => c.label)));
  assert.deepEqual(labels(''), []);
  assert.deepEqual(labels('x.com/ada/status/1'), ['Open link']);
  assert.deepEqual(labels('nathan'), ['Search X for “nathan”', '@nathan on X', '@nathan on Instagram']);
  assert.deepEqual(labels('@nat.geo'), ['@nat.geo on Instagram', 'Search X for “@nat.geo”']);
  assert.deepEqual(labels('web components'), ['Search X for “web components”']);
  // Enter takes the first choice; choices can be clicked.
  const input = document.getElementById('go');
  const go = async (value, count) => { type(input, value); await settle(); submit(document, 'go-form'); await until(() => calls.length === count, value); };
  await go('https://x.com/example/status/123', 1);
  await go('instagram.com/natgeo/', 2);
  await go('@nathan', 3);
  await go('web components', 4);
  type(input, 'natgeo'); await settle();
  // A real browser opens the choices as you type; jsdom's synthetic input doesn't, so open them with ArrowDown.
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', {key:'ArrowDown', bubbles:true}));
  const options = await until(() => { const o = [...document.querySelectorAll('#suggestions [role="option"]')]; return o.length === 3 && o; }, 'choices');
  assert.equal(options[2].textContent, '@natgeo on Instagram');
  options[2].click(); await until(() => calls.length === 5, 'choice click');
  assert.equal(input.value, 'natgeo');
  assert.deepEqual(calls, [
    {type:'open', url:'https://x.com/example/status/123'},
    {type:'open', url:'https://instagram.com/natgeo/'},
    {type:'profile', site:'x', username:'nathan'},
    {type:'search', site:'x', query:'web components'},
    {type:'profile', site:'instagram', username:'natgeo'},
  ]);
  dom.window.close();
});

test('both sites on one page: X and Instagram actions, no site switch', async () => {
  const {dom, document, calls} = await ui('blocked.html', '?site=instagram');
  assert.equal(document.querySelector('.seg'), null);
  assert.deepEqual([...document.querySelectorAll('.site-label')].map(h => h.textContent), ['X', 'Instagram']);
  assert.equal(document.getElementById('feed-panel').hidden, false);
  for (const [site, action] of [['x','notifications'], ['x','compose'], ['instagram','messages']]) {
    const before = calls.length;
    await until(() => !document.querySelector(`[data-site="${site}"][data-action="${action}"]`).disabled);
    document.querySelector(`[data-site="${site}"][data-action="${action}"]`).click();
    await until(() => calls.length > before);
  }
  assert.deepEqual(calls, [{type:'personal', site:'x', action:'notifications'}, {type:'personal', site:'x', action:'compose'}, {type:'personal', site:'instagram', action:'messages'}]);
  dom.window.close();
});

test('typing N in the input is not intercepted', async () => {
  const {dom, document} = await ui('blocked.html');
  const input = document.getElementById('go');
  const key = new dom.window.KeyboardEvent('keydown', {key:'n', bubbles:true, cancelable:true});
  input.dispatchEvent(key);
  assert.equal(key.defaultPrevented, false);
  dom.window.close();
});

test('errors appear under what caused them and clear when typing again', async () => {
  const {dom, document} = await ui('blocked.html');
  dom.window.chrome.runtime.sendMessage = async payload => payload.type === 'feedStatus' ? {size:20, count:0, active:false, remainingMs:900000, sync:{configured:false}} : {error:'Enter a valid account username.'};
  const input = document.getElementById('go');
  type(input, '@nope'); await settle(); submit(document, 'go-form');
  const message = await until(() => document.getElementById('message'), 'error');
  assert.equal(message.textContent, 'Enter a valid account username.');
  assert.equal(document.getElementById('go-form').nextElementSibling, message);
  type(input, '@nop');
  await until(() => !document.getElementById('message'), 'error cleared');
  dom.window.close();
});

test('For You card shows the batch and opens it through the worker; no unlock offered', async () => {
  const {dom, document, calls} = await ui('blocked.html', '', {size:20, count:20, active:true, remainingMs:12*60_000, endsAt:Date.now()+3600_000, sync:{configured:true, synced:true}});
  await until(() => document.getElementById('feed-status').textContent, 'feed status');
  assert.match(document.getElementById('feed-status').textContent, /^20 tweets · until /);
  assert.equal(document.getElementById('unlock-feed'), null);
  assert.equal(/unlock/i.test(document.body.textContent), false);
  assert.equal(document.getElementById('sync-badge').textContent, 'on');
  document.getElementById('open-feed').click(); await until(() => calls.length === 1);
  assert.deepEqual(calls, [{type:'feed'}]);
  dom.window.close();
});

test('a fresh batch; without sync there is no QR to show', async () => {
  const {dom, document} = await ui('blocked.html', '', {size:20, count:0, active:false, remainingMs:0, endsAt:null, sync:{configured:false}});
  await until(() => document.getElementById('feed-status').textContent, 'feed status');
  assert.equal(document.getElementById('feed-status').textContent, '20 new tweets');
  assert.equal(document.getElementById('sync-badge').textContent, 'off');
  assert.equal(document.getElementById('sync-qr'), null);
  dom.window.close();
});

test('sync settings are sent to the worker and the token field is cleared', async () => {
  const {dom, document, calls} = await ui('blocked.html', '?site=x');
  assert.equal(document.getElementById('sync-form').closest('[hidden]') !== null, true);
  document.querySelector('.sync-trigger').click();
  await until(() => !document.getElementById('sync-form').closest('[hidden]'), 'sync panel open');
  type(document.getElementById('sync-endpoint'), 'https://sync.example.com');
  type(document.getElementById('sync-token'), 'k'.repeat(40));
  await settle();
  submit(document, 'sync-form');
  await until(() => calls.length === 1, 'sync call');
  assert.deepEqual(calls, [{type:'syncConfig', endpoint:'https://sync.example.com', token:'k'.repeat(40)}]);
  await until(() => document.getElementById('sync-token').value === '', 'token cleared');
  dom.window.close();
});

test('saving a sync server asks Chrome for access to that origin first', async () => {
  const {dom, document, calls} = await ui('blocked.html');
  const asked = [];
  let allow = false;
  dom.window.chrome.permissions = {request: async ({origins}) => { asked.push(...origins); return allow; }};
  document.querySelector('.sync-trigger').click();
  await until(() => !document.getElementById('sync-form').closest('[hidden]'), 'sync panel open');
  type(document.getElementById('sync-endpoint'), 'https://sync.example.com/');
  type(document.getElementById('sync-token'), 'k'.repeat(40));
  await settle();
  submit(document, 'sync-form');
  const message = await until(() => document.getElementById('message'), 'denied');
  assert.match(message.textContent, /needs access/);
  assert.deepEqual(calls, []);
  allow = true;
  submit(document, 'sync-form');
  await until(() => calls.length === 1, 'sync call');
  assert.deepEqual(asked, ['https://sync.example.com/*', 'https://sync.example.com/*']);
  dom.window.close();
});

test('a saved server shows its status, not an empty form; Reconnect re-asks for access with the saved token', async () => {
  const status = {size:20, count:0, active:false, remainingMs:900000, sync:{configured:true, endpoint:'https://sync.example.com', synced:false, error:'Dreamscroll needs permission to reach sync.example.com. Click Reconnect.'}};
  const {dom, document, calls} = await ui('blocked.html', '', status);
  const asked = [];
  dom.window.chrome.permissions = {request: async ({origins}) => { asked.push(...origins); return true; }};
  // An error opens the section and says why.
  await until(() => document.getElementById('sync-status') && !document.getElementById('sync-status').closest('[hidden]'), 'status shown');
  assert.equal(document.getElementById('sync-form'), null);
  assert.match(document.querySelector('.sync-line').textContent, /Not syncing with sync\.example\.com/);
  assert.match(document.querySelector('.sync-error').textContent, /Click Reconnect/);
  document.getElementById('sync-reconnect').click();
  await until(() => calls.length === 1, 'reconnect');
  assert.deepEqual(asked, ['https://sync.example.com/*']);
  assert.deepEqual(calls, [{type:'syncConfig', endpoint:'https://sync.example.com', token:''}]);
  // Change server shows the form, filled in with the current address.
  document.getElementById('sync-change').click();
  const field = await until(() => document.getElementById('sync-endpoint'), 'form');
  assert.equal(field.value, 'https://sync.example.com');
  document.getElementById('sync-cancel').click();
  await until(() => document.getElementById('sync-status'), 'back to status');
  dom.window.close();
});

test('with sync on, the QR dialog shows the sync link as a QR code', async () => {
  const {dom, document, calls} = await ui('blocked.html', '', {size:20, count:0, active:false, remainingMs:900000, endsAt:null, sync:{configured:true, synced:true}});
  dom.window.chrome.runtime.sendMessage = async payload => payload.type === 'feedStatus' ? {size:20, count:0, active:false, remainingMs:900000, sync:{configured:true, synced:true}}
    : payload.type === 'syncShare' ? (calls.push(payload.type), {link:'dreamscroll://sync?endpoint=https%3A%2F%2Fsync.example.com&token=' + 'k'.repeat(40)}) : {ok:true};
  document.querySelector('.sync-trigger').click();
  const button = await until(() => document.getElementById('sync-qr'), 'QR button');
  button.click();
  const qr = await until(() => document.querySelector('svg.qr path'), 'QR code');
  assert.deepEqual(calls, ['syncShare']);
  assert.ok(qr.getAttribute('d').length > 500);
  assert.match(document.querySelector('.dialog').textContent, /Don’t share it/);
  dom.window.close();
});

test('the main page is minimal: no intro copy, no popup, at most one primary action', async () => {
  const {dom, document} = await ui('blocked.html', '?site=x');
  const text = document.body.textContent;
  for (const phrase of ['Go with a purpose', 'Your conversations', 'endless feed', 'LOCAL', 'HAVE A SPECIFIC LINK']) assert.equal(text.includes(phrase), false, phrase);
  assert.equal(document.querySelectorAll('form').length, 2);
  assert.equal(document.querySelectorAll('[data-site][aria-pressed]').length, 0);
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.action.default_popup, undefined);
  dom.window.close();
});

// ============ Feed page ============
const timelineScript = await readFile(new URL('../extension/timeline.js', import.meta.url), 'utf8');
const feedScript = await readFile(new URL('../extension/feed-page.js', import.meta.url), 'utf8');
async function feedPage(state, run) {
  const html = await readFile(new URL('../extension/feed.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, {url:'https://extension.local/feed.html', runScripts:'outside-only', pretendToBeVisual:true});
  const calls = [], opened = [], sent = [], navigated = [];
  dom.window.chrome = {runtime:{sendMessage:async payload => {
    calls.push(payload.type); sent.push(JSON.parse(JSON.stringify(payload)));
    return payload.type === 'snapshot' ? state : payload.type === 'feedRead' ? {read:[]} : {ok:true};
  }}};
  dom.window.open = (url, target) => { opened.push([url, target]); return null; };
  dom.window.eval(timelineScript); dom.window.eval(feedScript);
  dom.window.SocialFeedPage.navigate = url => navigated.push(url);
  await until(() => dom.window.document.getElementById('feed-end') || dom.window.document.getElementById('deck') || dom.window.document.getElementById('message'), 'feed page');
  try { await run({dom, document:dom.window.document, calls, opened, sent, navigated}); } finally { dom.window.close(); }
}
const live = extra => ({active:true, startedAt:1_000, endsAt:Date.now()+3600_000, remainingMs:600_000, ...extra});
const topCard = document => document.querySelector('.deck-slot.top');
const topText = document => topCard(document)?.textContent || '';
const fullTweet = {
  id:'42', author:{name:'Ada', handle:'ada', avatar:'https://pbs.twimg.com/profile_images/a.jpg', verified:true}, createdAt:Date.now()-2*3600_000,
  retweetedBy:'Grace', segments:[{text:'Shipping today @bob, mail a@b.com '}, {text:'vercel.com/blog', href:'https://vercel.com/blog'}],
  media:[{type:'video', src:'https://pbs.twimg.com/ext_tw_video_thumb/1.jpg', alt:'A demo'}, {type:'photo', src:'https://pbs.twimg.com/media/s.jpg', sensitive:true}],
  card:null,
  quoted:{id:'7', author:{name:'Bob', handle:'bob'}, createdAt:Date.now()-60_000, segments:[{text:'Original idea '}, {text:'link', href:'https://example.com/q'}], media:[]},
};
test('feed page shows one tweet at a time: text, links, previews, quotes; valid markup', async () => {
  const cardTweet = {id:'43', author:{name:'Lin', handle:'lin'}, segments:[{text:'Worth a read'}], media:[], card:{title:'A great article', description:'About it', domain:'example.com', image:'https://pbs.twimg.com/card_img/1/a.jpg', href:'https://example.com/a'}};
  await feedPage(live({tweets:[fullTweet, cardTweet, {id:'bad', author:{handle:'x'}}]}), ({document}) => {
    const first = topCard(document).querySelector('.tweet');
    assert.match(first.querySelector('.reposted').textContent, /Grace reposted/);
    assert.equal(first.querySelector('.name').textContent, 'Ada✓');
    // The timestamp is the real permalink.
    const time = first.querySelector('a.time');
    assert.equal(time.textContent, '2h'); assert.equal(time.href, 'https://x.com/ada/status/42');
    const links = [...first.querySelectorAll(':scope > .text a')].map(a => [a.textContent, a.href, a.target]);
    assert.deepEqual(links, [['@bob', 'https://x.com/bob', ''], ['vercel.com/blog', 'https://vercel.com/blog', '_blank']]);
    assert.match(first.querySelector(':scope > .text').textContent, /mail a@b\.com/);
    assert.equal(first.querySelector('.media-img').alt, 'A demo');
    assert.ok(first.querySelector('.media-item.sensitive .sensitive-label'));
    assert.equal(first.querySelector('.play').textContent, '▶');
    // No link inside a link: the quoted tweet is a box with its own links.
    const quoted = first.querySelector('.quoted');
    assert.equal(quoted.tagName, 'DIV');
    assert.equal(document.querySelectorAll('a a').length, 0);
    assert.equal(quoted.querySelector('a.time').href, 'https://x.com/bob/status/7');
    // The next one waits underneath (hidden from assistive tech); the invalid tweet is dropped.
    const under = document.querySelector('.deck-slot.under');
    assert.equal(under.getAttribute('aria-hidden'), 'true');
    const card = under.querySelector('.card');
    assert.equal(card.href, 'https://example.com/a'); assert.equal(card.target, '_blank'); assert.equal(card.rel, 'noopener noreferrer');
    assert.equal(card.querySelector('.card-title').textContent, 'A great article');
    assert.match(document.getElementById('feed-meta').textContent, /^2 left · until /);
    assert.equal(document.getElementById('feed-action'), null);
    assert.equal(/unlock/i.test(document.body.textContent), false);
    assert.equal(document.querySelectorAll('iframe').length, 0);
    assert.equal(document.querySelectorAll('script').length, 2);
  });
});
test('left marks read and shows the next; right opens on X and leaves it unread', async () => {
  const tweets = ['1', '2', '3'].map(id => ({id, author:{name:`N${id}`, handle:`h${id}`}, segments:[{text:`Tweet ${id}`}], media:[]}));
  await feedPage(live({tweets}), async ({dom, document, sent, navigated}) => {
    assert.match(topText(document), /Tweet 1/);
    document.getElementById('read-button').click();
    await until(() => /Tweet 2/.test(topText(document)), 'next card');
    assert.deepEqual(sent.filter(m => m.type === 'feedRead'), [{type:'feedRead', ids:['1'], read:true}]);
    // Right: opens it in this tab; it stays on top, unread.
    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', {key:'ArrowRight', bubbles:true}));
    await until(() => navigated.length, 'navigation');
    assert.deepEqual(navigated, ['https://x.com/h2/status/2']);
    assert.match(topText(document), /Tweet 2/);
    assert.equal(sent.filter(m => m.type === 'feedRead').length, 1);
    // Left arrow reads it; Undo puts it back.
    await settle(); await new Promise(resolve => setTimeout(resolve, 200));
    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', {key:'ArrowLeft', bubbles:true}));
    await until(() => /Tweet 3/.test(topText(document)), 'third card');
    assert.equal(document.querySelector('.read-trigger').textContent, 'Read · 2');
    document.getElementById('undo-button').click();
    await until(() => /Tweet 2/.test(topText(document)), 'undo');
    assert.deepEqual(sent.filter(m => m.type === 'feedRead').at(-1), {type:'feedRead', ids:['2'], read:false});
  });
});
test('read tweets are remembered for the batch and listed below; all read shows the next batch time', async () => {
  const tweets = ['1', '2'].map(id => ({id, author:{name:`N${id}`, handle:`h${id}`}, segments:[{text:`Tweet ${id}`}], media:[]}));
  await feedPage(live({tweets, read:['1', '2']}), async ({document, sent}) => {
    assert.equal(document.getElementById('deck'), null);
    assert.match(document.getElementById('feed-end-text').textContent, /^All read · next batch at /);
    assert.equal(document.querySelectorAll('#read-list > li').length, 2);
    document.querySelector('#read-list > li .put-back').click();
    await until(() => /Tweet 1/.test(topText(document)), 'put back');
    assert.deepEqual(sent.at(-1), {type:'feedRead', ids:['1'], read:false});
  });
});
test('conversations are one card; tapping opens, Cmd/Ctrl-click opens a new tab', async () => {
  const root = {id:'1', thread:'home-conversation-1', author:{name:'Bob', handle:'bob'}, segments:[{text:'Root'}], media:[]};
  const reply = {id:'2', thread:'home-conversation-1', replyTo:'bob', author:{name:'Cy', handle:'cy'}, segments:[{text:'Reply'}], media:[]};
  const solo = {id:'3', author:{name:'Di', handle:'di'}, segments:[{text:'Solo'}], media:[]};
  await feedPage(live({tweets:[root, reply, solo]}), async ({dom, document, opened, sent, navigated}) => {
    const card = topCard(document);
    assert.ok(card.querySelector('.deck-card').classList.contains('thread'));
    assert.equal(card.querySelectorAll('.tweet').length, 2);
    assert.equal(card.querySelectorAll('.tweet')[1].querySelector('.replying').textContent, 'Replying to @bob');
    card.querySelectorAll('.tweet .text')[1].dispatchEvent(new dom.window.MouseEvent('click', {bubbles:true, metaKey:true}));
    assert.deepEqual(opened, [['https://x.com/cy/status/2', '_blank']]);
    card.querySelectorAll('.tweet .text')[0].dispatchEvent(new dom.window.MouseEvent('click', {bubbles:true}));
    assert.deepEqual(navigated, ['https://x.com/bob/status/1']);
    // Reading the conversation reads both tweets.
    document.getElementById('read-button').click();
    await until(() => /Solo/.test(topText(document)), 'next card');
    assert.deepEqual(sent.find(m => m.type === 'feedRead').ids, ['1', '2']);
  });
});
test('feed page never renders unsafe data as markup or links', async () => {
  const evil = {id:'1', author:{name:'<img src=x onerror=alert(1)>', handle:'eve', avatar:'https://evil.example/a.png'}, segments:[{text:'<b>hi</b>', href:'javascript:alert(1)'}], media:[{type:'photo', src:'https://evil.example/p.png'}], card:{title:'t', href:'javascript:alert(1)'}};
  await feedPage(live({remainingMs:0, tweets:[evil]}), ({document}) => {
    const item = topCard(document).querySelector('.tweet');
    assert.equal(item.querySelector('.name').textContent, '<img src=x onerror=alert(1)>');
    assert.equal(item.querySelectorAll('img').length, 0);
    assert.equal(item.querySelector('.text').textContent, '<b>hi</b>');
    assert.equal(item.querySelectorAll('a[href^="javascript"]').length, 0);
  });
});
test('an ended batch offers to fetch a new one', async () => {
  await feedPage({active:false, endsAt:null, remainingMs:900_000, tweets:[]}, async ({document, calls}) => {
    assert.equal(document.getElementById('feed-end-text').textContent, 'This batch has ended.');
    document.getElementById('feed-action').click(); await until(() => calls.length === 2);
    assert.deepEqual(calls, ['snapshot', 'feed']);
  });
});
