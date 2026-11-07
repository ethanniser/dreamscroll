import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

function storageArea() {
  const data = new Map();
  return {
    data,
    async get(keys) { const list = Array.isArray(keys) ? keys : [keys]; return Object.fromEntries(list.filter(k => data.has(k)).map(k => [k, structuredClone(data.get(k))])); },
    async set(items) { for (const [k,v] of Object.entries(items)) data.set(k, structuredClone(v)); },
    async remove(keys) { for (const k of [].concat(keys)) data.delete(k); }
  };
}
function harness({now = Date.parse('2026-11-07T10:00:00Z'), remote = null, beforeLoad = null, granted = () => true} = {}) {
  const listeners = {};
  const clock = {now};
  const event = name => ({addListener(fn) { listeners[name] = fn; }});
  const dynamic = new Map(), session = new Map(), tabs = new Map();
  const calls = [];
  let nextTab = 100, failSessionRead = false, rejectRegex = false, skipRule = false;
  const chrome = {
    runtime: {id:'unit',getURL:path => `chrome-extension://unit/${path}`,onMessage:event('message'),onInstalled:event('installed')},
    declarativeNetRequest: {
      async isRegexSupported(options) { calls.push(['validate',options]); return {isSupported:!rejectRegex,reason:rejectRegex ? 'memoryLimitExceeded' : undefined}; },
      async getDynamicRules() { return [...dynamic.values()]; },
      async getSessionRules() { if (failSessionRead) throw Error('read failed'); return [...session.values()]; },
      async updateDynamicRules({removeRuleIds = [],addRules = []}) { removeRuleIds.forEach(id => dynamic.delete(id)); addRules.forEach(rule => dynamic.set(rule.id,rule)); },
      async updateSessionRules({removeRuleIds = [],addRules = []}) { calls.push(['session',addRules,removeRuleIds]); removeRuleIds.forEach(id => session.delete(id)); addRules.filter((_,i) => !skipRule || i !== 0).forEach(rule => session.set(rule.id,rule)); }
    },
    action:{async setBadgeText(props) { calls.push(['badge',props]); }, onClicked:event('actionClicked')},
    tabs:{
      async create(props) { const tab = {id:nextTab++,...props}; tabs.set(tab.id,tab); calls.push(['create',tab]); return {...tab}; },
      async get(id) { if (!tabs.has(id)) throw Error('No tab'); return {...tabs.get(id)}; },
      async query() { return [...tabs.values()].filter(tab => /^https:\/\/(x\.com|www\.instagram\.com)/.test(tab.url)); },
      async update(id,props) { if (!tabs.has(id)) throw Error('No tab'); calls.push(['navigate',id,props]); Object.assign(tabs.get(id),props); return {...tabs.get(id)}; },
      async sendMessage() {},
      async remove(id) { tabs.delete(id); calls.push(['remove',id]); },
      async reload(id) { if (!tabs.has(id)) throw Error('No tab'); calls.push(['reload',id]); },
      onRemoved:event('removed')
    },
    webNavigation:{onCommitted:event('committed'),onHistoryStateUpdated:event('history'),onReferenceFragmentUpdated:event('fragment')},
    storage:{local:storageArea(), session:storageArea()},
    permissions:{async contains({origins}) { return origins.every(granted); }},
    windows:{
      async create(props) { const tab = {id:nextTab++,url:props.url,windowId:900+nextTab}; tabs.set(tab.id,tab); windows.set(tab.windowId,{...props,tabId:tab.id}); calls.push(['window',props]); return {id:tab.windowId,tabs:[{...tab}]}; },
      async remove(id) { const w = windows.get(id); if (w) tabs.delete(w.tabId); windows.delete(id); calls.push(['closeWindow',id]); }
    }
  };
  const windows = new Map();
  // A fake sync server: records requests and answers from a handler, or fails if none is given.
  const requests = [];
  const fetch = async (url, init = {}) => {
    requests.push({url:String(url), method:init.method, auth:init.headers?.authorization, body:init.body ? JSON.parse(init.body) : null});
    if (!remote) throw Error('offline');
    const {status = 200, body} = await remote(String(url), init.body ? JSON.parse(init.body) : null);
    return {ok: status < 300, status, json: async () => body};
  };
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [clock.now])); } static now() { return clock.now; } }
  // Long timeouts (the 30 s capture limit) fire after 50 ms in tests.
  const quickTimeout = (fn, ms, ...args) => setTimeout(fn, ms >= 10000 ? 50 : ms, ...args);
  let uuid = 0;
  const crypto = {randomUUID: () => `${String(++uuid).padStart(8,'0')}-0000-4000-8000-000000000000`};
  const context = vm.createContext({chrome,URL,console,fetch,AbortController,setTimeout:quickTimeout,clearTimeout,structuredClone,crypto,Date:FixedDate});
  vm.runInContext(readFileSync(new URL('../extension/policy.js',import.meta.url),'utf8'),context);
  beforeLoad?.({chrome, tabs, windows});
  vm.runInContext(readFileSync(new URL('../extension/feed.js',import.meta.url),'utf8'),context);
  vm.runInContext(readFileSync(new URL('../extension/timeline.js',import.meta.url),'utf8'),context);
  vm.runInContext(readFileSync(new URL('../extension/background.js',import.meta.url),'utf8').replace("import './policy.js';",'').replace("import './feed.js';",'').replace("import './timeline.js';",''),context);
  const mainPage = {id:'unit',url:'chrome-extension://unit/blocked.html?site=x'};
  const send = (message,sender = mainPage) => new Promise(resolve => listeners.message(message,sender,resolve));
  const gate = (id=1,site='x') => { const url = `chrome-extension://unit/blocked.html?site=${site}`; tabs.set(id,{id,url}); return {id:'unit',url,frameId:0,tab:{id}}; };
  const content = (url,id=1) => ({id:'unit',url,frameId:0,tab:{id}});
  return {windows,clock,requests,storage:chrome.storage,context,send,listeners,tabs,session,dynamic,calls,gate,content,drain:()=>vm.runInContext('queue',context),failReads() { failSessionRead=true; },rejectRegex() { rejectRegex=true; },skipRule() { skipRule=true; }};
}

test('direct posts and comment threads require no gate or per-post grant',async()=>{
  const h=harness();
  for (const url of ['https://x.com/alice/status/123','https://x.com/bob/status/456','https://www.instagram.com/p/AbC/','https://www.instagram.com/reel/DeF/']) {
    const result=await h.send({type:'check'},h.content(url,9));
    assert.equal(result.allowed,true,url); assert.equal(result.view.kind,'post');
  }
  assert.equal(h.session.size,0);
  assert.equal((await h.send({type:'check'},h.content('https://x.com/home',9))).allowed,false);
  assert.equal((await h.send({type:'check'},h.content('https://x.com/explore',9))).allowed,false);
});

const destinations=[
  [{type:'open',url:'https://twitter.com/a/status/123?s=1'},'https://x.com/i/web/status/123'],
  [{type:'open',url:'https://www.instagram.com/alice.name/?igsh=1'},'https://www.instagram.com/alice.name/'],
  [{type:'profile',site:'x',username:'@alice'},'https://x.com/alice/'],
  [{type:'profile',site:'instagram',username:' nathan.n '},'https://www.instagram.com/nathan.n/'],
  [{type:'search',site:'x',query:' web components '},'https://x.com/search?q=web%20components&src=typed_query'],
  [{type:'personal',site:'x',action:'notifications'},'https://x.com/notifications'],
  [{type:'personal',site:'x',action:'messages'},'https://x.com/i/chat'],
  [{type:'personal',site:'x',action:'compose'},'https://x.com/compose/post'],
  [{type:'personal',site:'instagram',action:'messages'},'https://www.instagram.com/direct/inbox/'],
  [{type:'personal',site:'instagram',action:'notifications'},'https://www.instagram.com/?sf_personal=notifications'],
  [{type:'personal',site:'x',action:'saved'},'https://x.com/i/bookmarks'],
  [{type:'personal',site:'instagram',action:'saved'},'https://www.instagram.com/?sf_personal=saved']
];
test('a tab-less main page opens each concrete destination in a new tab, and every destination passes its own check',async()=>{
  const h=harness();
  for (const [message,url] of destinations) {
    const before=h.tabs.size;
    assert.equal((await h.send(message)).opened,true,JSON.stringify(message));
    assert.equal(h.tabs.size,before+1);
    const tab=[...h.tabs.values()].at(-1);
    assert.equal(tab.url,url); assert.equal(tab.active,true);
    const check=await h.send({type:'check'},h.content(url,tab.id));
    assert.equal(check.allowed,true,url); assert.notEqual(check.view.kind,'home');
  }
  assert.equal(h.calls.some(call=>call[0]==='navigate'),false);
  assert.equal(h.session.size,0); assert.equal(h.dynamic.size,0);
});
test('a full dashboard page replaces its own tab instead of opening another',async()=>{
  for (const page of ['blocked.html?site=x','blocked.html?site=instagram&ready=1']) {
    const h=harness(),sender=h.gate(7,'x');
    sender.url=`chrome-extension://unit/${page}`; h.tabs.get(7).url=sender.url;
    for (const [message,url] of destinations) {
      assert.equal((await h.send(message,sender)).opened,true,page);
      assert.equal(h.tabs.get(7).url,url,page);
    }
    assert.equal(h.tabs.size,1,page);
    assert.equal(h.calls.some(call=>call[0]==='create'),false,page);
  }
});
test('choosing an intent never navigates: retired entry messages are refused',async()=>{
  const h=harness(),gate=h.gate(1,'x');
  for (const type of ['enter','personalHome','finish','gate']) {
    assert.equal((await h.send({type,site:'x'},gate)).error,'Not permitted.',type);
    assert.equal((await h.send({type,site:'x'})).error,'Not permitted.',type);
  }
  assert.equal(h.tabs.get(1).url,gate.url);
  assert.equal(h.calls.some(call=>['create','navigate'].includes(call[0])),false);
});
test('home and discovery are never destinations, however they are requested',async()=>{
  const h=harness(),before=h.tabs.size;
  for (const url of ['https://x.com/','https://x.com/home','https://twitter.com/home?s=1','https://x.com/explore','https://x.com/search','https://x.com/search?q=%20','https://x.com/search?f=live','https://www.instagram.com/','https://www.instagram.com/?sf_personal=home','https://www.instagram.com/explore/','https://www.instagram.com/reels/','https://www.instagram.com/stories/a/1/','http://x.com/alice','https://x.com:444/alice','https://evil.com/alice','javascript:alert(1)',42,null]) {
    assert.ok((await h.send({type:'open',url})).error,String(url));
  }
  for (const [site,username] of [['x','home'],['x','explore'],['x','search'],['x','i'],['instagram','explore'],['instagram','reels'],['x','a/b'],['x','../home'],['x',''],['x','sixteen_chars_xx'],['evil','alice'],['x',7]]) {
    assert.ok((await h.send({type:'profile',site,username})).error,`${site}:${username}`);
  }
  for (const [site,query] of [['x',''],['x','   '],['instagram','cats'],['x',null]]) assert.ok((await h.send({type:'search',site,query})).error,`${site}:${query}`);
  for (const [site,action] of [['instagram','compose'],['evil','messages'],['x','delete'],['x','home'],['__proto__','toString'],['x','constructor']]) assert.ok((await h.send({type:'personal',site,action})).error,`${site}:${action}`);
  assert.equal(h.tabs.size,before);
  for (const url of ['https://x.com/','https://x.com/home','https://www.instagram.com/','https://x.com/search?q=']) {
    const check=await h.send({type:'check'},h.content(url,5));
    assert.equal(check.allowed,false,url);
  }
});
test('only top-level extension UI pages may request destinations; site pages may only check',async()=>{
  const h=harness(),gate=h.gate();
  const page=h.content('https://x.com/a/status/1');
  const forged=[
    page,
    {...gate,frameId:1},
    {...gate,id:'other'},
    {...gate,url:'https://evil.example/blocked.html?site=x'},
    {...gate,url:'chrome-extension://other/blocked.html?site=x'},
    {...gate,url:'chrome-extension://unit/options.html'},
    {...gate,url:'chrome-extension://unit/personal.html?site=x'},
    {id:'other',url:'chrome-extension://other/popup.html'}
  ];
  for (const sender of forged) for (const message of [{type:'open',url:'https://x.com/a/status/1'},{type:'profile',site:'x',username:'alice'},{type:'search',site:'x',query:'a'},{type:'personal',site:'x',action:'compose'},{type:'leave'}]) {
    assert.equal((await h.send(message,sender)).error,'Not permitted.',`${sender.url} ${message.type}`);
  }
  // A UI page cannot use the content-only check, and a popup cannot close a tab.
  assert.equal((await h.send({type:'check'},gate)).error,'Not permitted.');
  assert.equal((await h.send({type:'check'})).error,'Not permitted.');
  assert.equal((await h.send({type:'leave'})).error,'Not permitted.');
  assert.equal((await h.send({type:'check'},h.content('https://evil.example/',1))).error,'Not permitted.');
  assert.equal(h.tabs.get(1).url,gate.url);
  assert.equal(h.calls.some(call=>['create','navigate','remove'].includes(call[0])),false);
});
test('in-page navigation to home or discovery sends the tab back to the intent page',async()=>{
  const h=harness();
  for (const [id,url,site] of [[1,'https://x.com/home','x'],[2,'https://www.instagram.com/explore/','instagram'],[3,'https://x.com/search?q=','x']]) {
    h.tabs.set(id,{id,url});
    h.listeners.history({frameId:0,tabId:id,url}); await h.drain();
    assert.equal(h.tabs.get(id).url,`chrome-extension://unit/blocked.html?site=${site}`,url);
  }
  for (const [id,url] of [[4,'https://x.com/alice/status/1'],[5,'https://x.com/compose/post'],[6,'https://www.instagram.com/direct/t/123/'],[7,'https://x.com/search?q=cats']]) {
    h.tabs.set(id,{id,url});
    h.listeners.history({frameId:0,tabId:id,url}); await h.drain();
    assert.equal(h.tabs.get(id).url,url,url);
  }
  // Subframes are ignored; a tab already moving elsewhere is not overwritten.
  h.tabs.set(8,{id:8,url:'https://x.com/home'});
  h.listeners.committed({frameId:3,tabId:8,url:'https://x.com/home'}); await h.drain();
  assert.equal(h.tabs.get(8).url,'https://x.com/home');
  h.tabs.set(9,{id:9,url:'https://x.com/home',pendingUrl:'https://example.com/'});
  h.listeners.committed({frameId:0,tabId:9,url:'https://x.com/home'}); await h.drain();
  assert.equal(h.tabs.get(9).url,'https://x.com/home');
});
test('stale history event cannot replace a newer external page',async()=>{
  const h=harness(); h.tabs.set(1,{id:1,url:'https://example.com/'});
  h.listeners.history({frameId:0,tabId:1,url:'https://x.com/home'}); await h.drain();
  assert.equal(h.tabs.get(1).url,'https://example.com/');
});
test('installation migrates old modes and grants while retaining direct destinations',async()=>{
  const h=harness();
  h.dynamic.set(100,{id:100}); h.dynamic.set(7,{id:7}); h.session.set(1000,{id:1000,condition:{tabIds:[1]}}); h.session.set(1001,{id:1001});
  h.tabs.set(1,{id:1,url:'https://x.com/home'}); h.tabs.set(2,{id:2,url:'https://x.com/a/status/123'});
  h.tabs.set(3,{id:3,url:'https://www.instagram.com/'}); h.tabs.set(4,{id:4,url:'https://x.com/compose/post'});
  h.listeners.installed(); await h.drain();
  assert.equal(h.dynamic.size,0); assert.equal(h.session.size,0);
  assert.equal(h.tabs.get(1).url,'chrome-extension://unit/blocked.html?site=x');
  assert.equal(h.tabs.get(3).url,'chrome-extension://unit/blocked.html?site=instagram');
  assert.equal(h.tabs.get(2).url,'https://x.com/a/status/123');
  assert.equal(h.tabs.get(4).url,'https://x.com/compose/post');
  // Allowed views reload so they run the new content script; gated tabs are redirected instead.
  assert.deepEqual(h.calls.filter(call=>call[0]==='reload').map(call=>call[1]).sort(),[2,4]);
  assert.ok(h.calls.some(call=>call[0]==='badge' && call[1].text===''));
  const validated=h.calls.filter(call=>call[0]==='validate').map(call=>call[1].regex);
  assert.ok(validated.length>50);
  for (const regex of [...vm.runInContext('SocialPolicy.searchPatterns',h.context)]) assert.ok(validated.includes(regex));
  assert.equal((await h.send(null)).error,'Invalid message.');
});
test('install-time regex rejection is surfaced after open tabs are re-gated',async()=>{
  const h=harness(); h.rejectRegex();
  h.tabs.set(1,{id:1,url:'https://x.com/home'});
  const errors=[]; h.context.console={error:e=>errors.push(e)};
  h.listeners.installed(); await h.drain();
  assert.equal(errors.length,1); assert.match(String(errors[0]),/memoryLimitExceeded/);
  assert.equal(h.tabs.get(1).url,'chrome-extension://unit/blocked.html?site=x');
});

test('account links bypass the gate in fresh tabs while bare domains still need intent',async()=>{
  const h=harness();
  for (const url of ['https://x.com/alice','https://twitter.com/bob/','https://www.instagram.com/alice.name/']) {
    const result=await h.send({type:'check'},h.content(url,99));
    assert.equal(result.allowed,true,url); assert.equal(result.view.kind,'profile');
    assert.equal((await h.send({type:'open',url})).opened,true);
  }
  for (const url of ['https://x.com/','https://twitter.com/','https://x.com/home','https://www.instagram.com/','https://x.com/explore','https://www.instagram.com/explore/']) assert.equal((await h.send({type:'check'},h.content(url,99))).allowed,false,url);
  assert.equal(h.session.size,0);
});

test('personal destinations are available without a focused-entry session',async()=>{
  const h=harness();
  for (const [url,kind] of [['https://x.com/notifications','notifications'],['https://x.com/messages/1-2','messages'],['https://x.com/i/chat','messages'],['https://x.com/compose/post','compose'],['https://www.instagram.com/direct/inbox/','messages'],['https://www.instagram.com/accounts/activity/','notifications']]) {
    const result=await h.send({type:'check'},h.content(url,99));
    assert.equal(result.allowed,true,url); assert.equal(result.view.kind,kind,url);
  }
  assert.equal(h.session.size,0);
  assert.equal((await h.send({type:'check'},h.content('https://x.com/home',99))).allowed,false);
});

test('check uses the page-reported URL after in-page navigation, but only within the same site',async()=>{
  const h=harness();
  // Chrome still reports the profile while the page has pushState'd to a DM thread.
  const stale=h.content('https://x.com/ksw_arman',4);
  const dm=await h.send({type:'check',url:'https://x.com/i/chat/1234567-89012345'},stale);
  assert.equal(dm.allowed,true); assert.equal(dm.view.kind,'messages');
  const thread=await h.send({type:'check',url:'https://x.com/ksw_arman/status/123'},stale);
  assert.equal(thread.view.kind,'post');
  // A home pushState is still refused.
  assert.equal((await h.send({type:'check',url:'https://x.com/home'},stale)).allowed,false);
  // Cross-site or junk URLs fall back to the tab's own URL.
  for (const url of ['https://www.instagram.com/direct/inbox/','https://evil.example/i/chat','javascript:1',42]) {
    const r=await h.send({type:'check',url},stale);
    assert.equal(r.view.kind,'profile',String(url));
  }
});


// ============ Feed snapshots and scroll budget ============
const HOUR = 3600_000;
const sampleTweets = n => Array.from({length:n}, (_, i) => ({id:String(1000+i), author:{name:`User ${i}`, handle:`user${i}`, avatar:`https://pbs.twimg.com/profile_images/${i}.jpg`}, createdAt:Date.parse('2026-11-07T09:00:00Z'), segments:[{text:`tweet ${i}`}], media:[], card:null, quoted:null}));
const tick = () => new Promise(r => setTimeout(r, 5));
/** Starts a feed request and, when the hidden window loads X, answers as the capture tab would. */
async function capture(h, tweets = sampleTweets(20), sender) {
  const reply = h.send({type:'feed'}, sender);
  let tab;
  for (let i = 0; i < 200 && !tab; i++) { await tick(); tab = [...h.tabs.values()].find(t => /#sf_capture=/.test(t.url || '')); }
  if (tab && tweets) {
    const nonce = new URLSearchParams(new URL(tab.url).hash.slice(1)).get('sf_capture');
    const page = h.content(tab.url, tab.id);
    const check = await h.send({type:'check', url:tab.url}, page);
    assert.deepEqual({...check.view}, {kind:'capture', site:'x'});
    assert.equal((await h.send({type:'captured', nonce, tweets}, page)).ok, true);
  }
  return {result:await reply, tab};
}

test('a batch is captured once from a hidden window, stored, and opened on the feed page',async()=>{
  const h=harness();
  const {result,tab}=await capture(h);
  assert.equal(result.opened,true); assert.equal(result.count,10);
  // The hidden window was minimized and unfocused, its rule scoped to that tab, and it's gone now.
  const win=h.calls.find(c=>c[0]==='window')[1];
  assert.deepEqual({state:win.state,focused:win.focused},{state:'minimized',focused:false});
  assert.ok(h.calls.some(c=>c[0]==='session' && c[1].some(r=>r.condition.tabIds?.includes(tab.id))));
  assert.ok(h.calls.some(c=>c[0]==='closeWindow'));
  assert.equal(h.tabs.has(tab.id),false);
  assert.equal([...h.session.values()].length,0);
  assert.equal([...h.tabs.values()].at(-1).url,'chrome-extension://unit/feed.html');
  const page={id:'unit',url:'chrome-extension://unit/feed.html',frameId:0,tab:{id:[...h.tabs.values()].at(-1).id}};
  const snap=await h.send({type:'snapshot'},page);
  assert.equal(snap.tweets.length,10); assert.equal(snap.tweets[0].url,'https://x.com/user0/status/1000');
  // Within the window the same snapshot opens again without another capture.
  const windowsBefore=h.calls.filter(c=>c[0]==='window').length;
  assert.equal((await h.send({type:'feed'})).count,10);
  assert.equal(h.calls.filter(c=>c[0]==='window').length,windowsBefore);
  // Two hours later a fresh batch is captured.
  h.clock.now+=2*HOUR;
  assert.equal((await h.send({type:'feedStatus'})).active,false);
  const next=await capture(h,sampleTweets(5));
  assert.equal(next.result.count,5);
});

test('a dashboard tab is replaced by the feed page; X home itself stays blocked everywhere',async()=>{
  const h=harness(), g=h.gate(3,'x');
  await capture(h,sampleTweets(20),g);
  assert.equal(h.tabs.get(3).url,'chrome-extension://unit/feed.html');
  for (const id of [3,4]) assert.equal((await h.send({type:'check',url:'https://x.com/home'},h.content('https://x.com/home',id))).allowed,false);
});

test('capture rejects wrong nonces, other tabs and plain home; a stuck capture times out and cleans up',async()=>{
  const h=harness();
  const pending=h.send({type:'feed'});
  let tab;
  for (let i=0;i<200 && !tab;i++) { await tick(); tab=[...h.tabs.values()].find(t=>/#sf_capture=/.test(t.url||'')); }
  const page=h.content(tab.url,tab.id);
  assert.equal((await h.send({type:'captured',nonce:'0'.repeat(32),tweets:sampleTweets(3)},page)).error,'Not permitted.');
  assert.equal((await h.send({type:'captured',nonce:new URLSearchParams(new URL(tab.url).hash.slice(1)).get('sf_capture'),tweets:sampleTweets(3)},h.content(tab.url,77))).error,'Not permitted.');
  // The capture grant covers X home in that tab (X may drop the #fragment), and nothing else.
  assert.equal((await h.send({type:'check',url:'https://x.com/home'},h.content('https://x.com/home',tab.id))).allowed,true);
  assert.equal((await h.send({type:'check',url:'https://x.com/explore'},h.content('https://x.com/explore',tab.id))).allowed,false);
  assert.equal((await h.send({type:'check',url:'https://x.com/home'},h.content('https://x.com/home',99))).allowed,false);
  const result=await pending;
  assert.match(result.error,/didn’t load your feed/);
  assert.equal(h.tabs.has(tab.id),false); assert.equal([...h.session.values()].length,0);
  assert.equal((await h.send({type:'feedStatus'})).active,false);
});

test('captured tweets are sanitized before they are stored',async()=>{
  const h=harness();
  const tweets=[...sampleTweets(2),{id:'nope',author:{handle:'x'}},{id:'5',author:{handle:'ok',avatar:'https://evil.example/a.png'},segments:[{text:'hi',href:'javascript:alert(1)'}]}];
  const {result}=await capture(h,tweets);
  assert.equal(result.count,3);
  const snap=await h.send({type:'snapshot'},{id:'unit',url:'chrome-extension://unit/feed.html',frameId:0,tab:{id:1}});
  assert.equal(snap.tweets[2].author.avatar,null); assert.deepEqual(snap.tweets[2].segments,[{text:'hi'}]);
});

test('read tweets are kept for the current batch only; stale or foreign ids are ignored',async()=>{
  const J=v=>JSON.parse(JSON.stringify(v)), h=harness(), feedPage={id:'unit',url:'chrome-extension://unit/feed.html',frameId:0,tab:{id:1}};
  await capture(h,sampleTweets(3));
  const snap=await h.send({type:'snapshot'},feedPage);
  const [a,b]=snap.tweets.map(t=>t.id);
  assert.deepEqual(J(snap.read),[]);
  // Ids not in this batch (another batch's, or junk) are dropped.
  assert.deepEqual(J((await h.send({type:'feedRead',ids:[a,'999999','not-an-id'],read:true},feedPage)).read),[a]);
  assert.deepEqual(J((await h.send({type:'snapshot'},feedPage)).read),[a]);
  assert.deepEqual(J((await h.send({type:'feedRead',ids:[b]},feedPage)).read),[a,b]);
  assert.deepEqual(J((await h.send({type:'feedRead',ids:[a],read:false},feedPage)).read),[b]);
  // A new batch (here: the stored one replaced) starts with nothing read.
  const feed=h.storage.local.data.get('feed');
  feed.snapshot.tweets=feed.snapshot.tweets.map((t,i)=>({...t,id:String(7000+i)}));
  h.storage.local.data.set('feed',feed);
  assert.deepEqual(J((await h.send({type:'snapshot'},feedPage)).read),[]);
  // Only the feed page may write it.
  assert.equal((await h.send({type:'feedRead',ids:['7000']})).error,'Not permitted.');
  assert.equal((await h.send({type:'feedRead',ids:['7000']},h.content('https://x.com/home',3))).error,'Not permitted.');
  assert.equal((await h.send({type:'feedRead',ids:[]},feedPage)).error,'Invalid message.');
});

test('only extension pages can open, read or unlock the feed; site pages can only report a capture',async()=>{
  const h=harness(), page=h.content('https://x.com/home',3);
  for (const type of ['feed','snapshot','feedStatus','syncConfig','syncShare']) assert.equal((await h.send({type},page)).error,'Not permitted.',type);
  for (const type of ['feedTick','unlock','feedDone']) assert.ok((await h.send({type,ms:5000,url:'https://x.com/home'},page)).error,type);
});

test('unlocking spends the daily budget only through ticks from the unlocked tab',async()=>{
  const h=harness(), g=h.gate(3,'x'), page=h.content('https://x.com/home',3);
  await h.send({type:'unlock'},g);
  assert.equal(h.tabs.get(3).url,'https://x.com/home');
  assert.equal((await h.send({type:'check',url:'https://x.com/home'},page)).view.mode,'unlocked');
  let r=await h.send({type:'feedTick',ms:5000,url:'https://x.com/home'},page);
  assert.equal(r.remainingMs,15*60_000-5000);
  r=await h.send({type:'feedTick',ms:10*60_000,url:'https://x.com/home'},page);
  assert.equal(r.remainingMs,15*60_000-35_000);
  assert.equal((await h.send({type:'feedTick',ms:5000,url:'https://x.com/explore'},page)).error,'Not permitted.');
  assert.equal((await h.send({type:'feedTick',ms:5000,url:'https://x.com/home'},h.content('https://x.com/home',9))).error,'Not permitted.');
  for (let i=0;i<40 && r.remainingMs>0;i++) r=await h.send({type:'feedTick',ms:30_000,url:'https://x.com/home'},page);
  assert.equal(r.remainingMs,0); assert.equal(r.mode,null);
  assert.equal((await h.send({type:'check',url:'https://x.com/home'},page)).allowed,false);
  assert.match((await h.send({type:'unlock'},h.gate(4,'x'))).error,/used up/);
  h.clock.now+=24*HOUR;
  assert.equal((await h.send({type:'feedStatus'})).remainingMs,15*60_000);
});

test('an unlock ends when the tab leaves X, taps Done, closes, or the day changes',async()=>{
  const h=harness();
  await h.send({type:'unlock'},h.gate(3,'x'));
  h.tabs.set(3,{id:3,url:'https://example.com/'});
  h.listeners.committed({frameId:0,tabId:3,url:'https://example.com/'}); await h.drain();
  assert.equal((await h.send({type:'check',url:'https://x.com/home'},h.content('https://x.com/home',3))).allowed,false);
  await h.send({type:'unlock'},h.gate(4,'x'));
  assert.equal((await h.send({type:'feedDone',url:'https://x.com/home'},h.content('https://x.com/home',4))).done,true);
  assert.equal((await h.send({type:'check',url:'https://x.com/home'},h.content('https://x.com/home',4))).allowed,false);
  await h.send({type:'unlock'},h.gate(5,'x'));
  h.listeners.removed(5); await h.drain();
  assert.equal([...h.session.values()].some(r=>r.condition.tabIds?.includes(5)),false);
  await h.send({type:'unlock'},h.gate(6,'x'));
  h.clock.now+=24*HOUR;
  assert.equal((await h.send({type:'check',url:'https://x.com/home'},h.content('https://x.com/home',6))).allowed,false);
});

test('offline, winding the clock back neither reopens a batch nor restarts the day',async()=>{
  const h=harness();
  await capture(h);
  const page=h.content('https://x.com/home',3);
  await h.send({type:'unlock'},h.gate(3,'x'));
  for (let i=0;i<4;i++) await h.send({type:'feedTick',ms:30_000,url:'https://x.com/home'},page);
  h.clock.now-=5*HOUR;
  const windowsBefore=h.calls.filter(c=>c[0]==='window').length;
  assert.equal((await h.send({type:'feed'})).count,10);
  assert.equal(h.calls.filter(c=>c[0]==='window').length,windowsBefore);
  assert.equal((await h.send({type:'feedStatus'})).remainingMs,15*60_000-120_000);
});

test('sync settings: any https server the user allowed, a long token, verified before saving',async()=>{
  const h=harness({granted:origin => origin !== 'https://not-allowed.example/*', remote:async()=>({body:{now:0,batch:{active:false,tweets:[],size:20,startedAt:null,endsAt:null},budget:{day:'2026-11-07',usedMs:0,limitMs:900000,remainingMs:900000}}})});
  const token='k'.repeat(40);
  for (const endpoint of ['http://a.convex.site','https://a.convex.site/path','https://user:pw@a.example','https://a.example/?x=1','not a url']) assert.match((await h.send({type:'syncConfig',endpoint,token})).error,/https:\/\//,endpoint);
  assert.match((await h.send({type:'syncConfig',endpoint:'https://a.convex.site',token:'short'})).error,/token/);
  assert.match((await h.send({type:'syncConfig',endpoint:'https://not-allowed.example',token})).error,/Allow Dreamscroll to reach not-allowed\.example/);
  assert.equal(h.requests.length,0);
  assert.equal((await h.send({type:'syncConfig',endpoint:'https://sync.example.com:8443/',token})).configured,true);
  assert.deepEqual(h.storage.local.data.get('sync'),{endpoint:'https://sync.example.com:8443',token});
  assert.equal(h.requests.at(-1).url,'https://sync.example.com:8443/dreamscroll/state?day=2026-11-07');
  assert.equal((await h.send({type:'syncConfig',endpoint:'https://a.convex.site/',token})).configured,true);
  assert.deepEqual(h.storage.local.data.get('sync'),{endpoint:'https://a.convex.site',token});
  assert.equal(h.requests.at(-1).auth,`Bearer ${token}`);
  // Re-saving with an empty token field keeps the saved token, for the same server only.
  assert.equal((await h.send({type:'syncConfig',endpoint:'https://a.convex.site',token:''})).configured,true);
  assert.deepEqual(h.storage.local.data.get('sync'),{endpoint:'https://a.convex.site',token});
  const before=h.requests.length;
  assert.match((await h.send({type:'syncConfig',endpoint:'https://other.example',token:''})).error,/token/);
  assert.equal(h.requests.length,before);
  // The feed page can't change sync settings.
  assert.equal((await h.send({type:'syncConfig',endpoint:'https://a.convex.site',token},{id:'unit',url:'chrome-extension://unit/feed.html',frameId:0,tab:{id:1}})).error,'Not permitted.');
  // The main page can show the details as a QR link for the iPhone app; the feed page can't read them.
  assert.equal((await h.send({type:'syncShare'})).link,`dreamscroll://sync?endpoint=https%3A%2F%2Fa.convex.site&token=${token}`);
  assert.equal((await h.send({type:'syncShare'},{id:'unit',url:'chrome-extension://unit/feed.html',frameId:0,tab:{id:1}})).error,'Not permitted.');
  assert.equal((await h.send({type:'syncConfig',endpoint:'',token:''})).configured,false);
  assert.equal(h.storage.local.data.has('sync'),false);
  assert.match((await h.send({type:'syncShare'})).error,/first/);
  assert.match((await h.send({type:'syncConfig',endpoint:'https://a.convex.site',token:''})).error,/token/);
});

test('without access to the saved server, status says to reconnect and nothing is sent',async()=>{
  let allow=true;
  const h=harness({granted:()=>allow, remote:async()=>({body:{now:0,batch:{active:false,tweets:[],size:10,startedAt:null,endsAt:null},budget:{day:'2026-11-07',usedMs:0,limitMs:900000,remainingMs:900000}}})});
  const token='k'.repeat(40);
  assert.equal((await h.send({type:'syncConfig',endpoint:'https://sync.example.com',token})).configured,true);
  allow=false;
  const before=h.requests.length;
  const status=await h.send({type:'feedStatus'});
  assert.equal(status.sync.configured,true); assert.equal(status.sync.synced,false);
  assert.equal(status.sync.endpoint,'https://sync.example.com');
  assert.match(status.sync.error,/permission to reach sync\.example\.com\. Click Reconnect/);
  assert.equal(h.requests.length,before);
  // The token itself never goes to the page.
  assert.equal(JSON.stringify(status).includes(token),false);
});

test('with sync, another device’s snapshot is used instead of capturing a new one',async()=>{
  const phone=sampleTweets(20).map(t=>({...t,id:String(Number(t.id)+5000)}));
  const state={now:0,batch:{active:true,startedAt:Date.parse('2026-11-07T09:30:00Z'),endsAt:Date.parse('2026-11-07T11:30:00Z'),tweets:phone,size:20},budget:{day:'2026-11-07',usedMs:600_000,limitMs:900_000,remainingMs:300_000}};
  const h=harness({remote:async()=>({body:{...state,now:Date.now()}})});
  h.storage.local.data.set('sync',{endpoint:'https://a.convex.site',token:'k'.repeat(40)});
  const r=await h.send({type:'feed'});
  assert.equal(r.count,20); assert.equal(r.remainingMs,300_000);
  assert.equal(h.calls.some(c=>c[0]==='window'),false);
  const snap=await h.send({type:'snapshot'},{id:'unit',url:'chrome-extension://unit/feed.html',frameId:0,tab:{id:1}});
  assert.equal(snap.tweets[0].id,'6000');
  // The mirror holds if the sync server becomes unreachable.
  h.storage.local.data.delete('sync');
  assert.equal((await h.send({type:'feedStatus'})).count,20);
});

test('a snapshot captured offline is sent to the sync server when it is back, and the server’s answer wins',async()=>{
  let online=false, received=null;
  const h=harness({remote:async(url,body)=>{
    if (!online) throw Error('offline');
    if (/\/snapshot$/.test(url)) received=body.tweets;
    const tweets=received||[];
    return {body:{now:Date.now(),batch:{active:tweets.length>0,startedAt:Date.now()-1000,endsAt:Date.now()+HOUR,tweets,size:20},budget:{day:'2026-11-07',usedMs:0,limitMs:900000,remainingMs:900000}}};
  }});
  h.storage.local.data.set('sync',{endpoint:'https://a.convex.site',token:'k'.repeat(40)});
  const {result}=await capture(h,sampleTweets(20));
  assert.equal(result.count,10);
  online=true;
  const status=await h.send({type:'feedStatus'});
  assert.equal(status.sync.synced,true); assert.equal(received.length,10); assert.equal(received[0].id,'1000');
});

test('page checks never wait on the sync server; dashboard status does',async()=>{
  const h=harness({remote:async()=>{ throw Error('slow'); }});
  h.storage.local.data.set('sync',{endpoint:'https://a.convex.site',token:'k'.repeat(40)});
  await h.send({type:'unlock'},h.gate(3,'x'));
  const before=h.requests.length;
  for (let i=0;i<3;i++) { h.clock.now+=20_000; await h.send({type:'check',url:'https://x.com/home'},h.content('https://x.com/home',3)); }
  assert.equal(h.requests.length,before);
  const status=await h.send({type:'feedStatus'});
  assert.equal(h.requests.length,before+1); assert.equal(status.sync.synced,false); assert.ok(status.sync.error);
});

test('the toolbar icon opens the main page in a new tab',async()=>{
  const h=harness();
  h.listeners.actionClicked({id:1}); await new Promise(r=>setTimeout(r,5));
  assert.equal([...h.tabs.values()].at(-1).url,'chrome-extension://unit/blocked.html?site=x');
});

test('with sync, the server’s day is used: an unlock survives this device’s midnight and unsent time is kept',async()=>{
  // Device is past midnight (Nov 8); the sync server's zone is still on Nov 7.
  let used=0;
  const h=harness({now:Date.parse('2026-11-07T15:30:00Z'), remote:async(url,body)=>{
    if (/\/spend$/.test(url)) used+=body.ms;
    return {body:{now:Date.now(),batch:{active:false,tweets:[],size:20,startedAt:null,endsAt:null},budget:{day:'2026-11-07',usedMs:used,limitMs:900000,remainingMs:900000-used}}};
  }});
  const realDay=h.context.SocialFeed.localDay; h.context.SocialFeed.localDay=()=> '2026-11-08';
  h.storage.local.data.set('sync',{endpoint:'https://a.convex.site',token:'k'.repeat(40)});
  await h.send({type:'unlock'},h.gate(3,'x'));
  const page=h.content('https://x.com/home',3);
  assert.equal((await h.send({type:'feedTick',ms:5000,url:'https://x.com/home'},page)).remainingMs,895_000);
  assert.equal((await h.send({type:'check',url:'https://x.com/home'},page)).view.mode,'unlocked');
  h.context.SocialFeed.localDay=realDay;
});

test('a snapshot the sync server refuses is kept locally instead of recapturing on every click',async()=>{
  const h=harness({remote:async(url)=>{
    if (/\/snapshot$/.test(url)) return {status:422,body:{error:'invalid snapshot'}};
    return {body:{now:Date.now(),batch:{active:false,tweets:[],size:20,startedAt:null,endsAt:null},budget:{day:'2026-11-07',usedMs:0,limitMs:900000,remainingMs:900000}}};
  }});
  h.storage.local.data.set('sync',{endpoint:'https://a.convex.site',token:'k'.repeat(40)});
  const {result}=await capture(h);
  assert.equal(result.count,10);
  const windows=h.calls.filter(c=>c[0]==='window').length;
  const again=await h.send({type:'feed'});
  assert.equal(again.count,10); assert.equal(h.calls.filter(c=>c[0]==='window').length,windows);
});

test('a capture window left by a worker restart is closed on startup',async()=>{
  // The previous worker recorded a capture and its window; this worker starts fresh.
  const h=harness({beforeLoad({chrome,tabs,windows}){
    chrome.storage.session.data.set('capture',{windowId:5, tabId:6});
    windows.set(5,{tabId:6}); tabs.set(6,{id:6,url:'https://x.com/home#sf_capture=0'});
  }});
  await new Promise(r=>setTimeout(r,20)); await h.drain();
  assert.ok(h.calls.some(c=>c[0]==='closeWindow' && c[1]===5));
  assert.equal(h.storage.session.data.has('capture'),false);
  assert.equal(h.tabs.has(6),false);
});
