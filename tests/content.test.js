import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM,VirtualConsole} from 'jsdom';
const policy = await readFile(new URL('../extension/policy.js',import.meta.url),'utf8');
const script = await readFile(new URL('../extension/content.js',import.meta.url),'utf8');
const timeline = await readFile(new URL('../extension/timeline.js',import.meta.url),'utf8');
const css = await readFile(new URL('../extension/content.css',import.meta.url),'utf8');
const pause = () => new Promise(resolve=>setTimeout(resolve,80));
const tweet = (id='123', text='Selected post') => `<article data-testid="tweet" id="post-${id}"><a href="/alice/status/${id}"><time>now</time></a><p>${text}</p></article>`;
const column = contents => `<div data-testid="primaryColumn" id="conversation">${contents}</div>`;
// The worker's reply in a tab it opened for an Instagram start page (Notifications panel, Saved).
const startReply=action=>win=>({allowed:true,post:null,view:{...win.SocialPolicy.startViews.instagram[action]}});
async function fixture(html, url, {fail=false, geometry=false, before, reply}={}) {
  const errors=[], virtualConsole=new VirtualConsole();
  virtualConsole.on('jsdomError',error=>{ if (!/navigation/i.test(error.message)) errors.push(error); });
  const dom = new JSDOM(html,{url,runScripts:'outside-only',pretendToBeVisual:true,virtualConsole});
  dom.window.addEventListener('unhandledrejection',event=>errors.push(event.reason));
  const shadows=new Map();
  const attachShadow=dom.window.Element.prototype.attachShadow;
  dom.window.Element.prototype.attachShadow=function(options) {const root=attachShadow.call(this,options);shadows.set(this,root);return root;};
  const style = dom.window.document.createElement('style'); style.textContent = css; dom.window.document.head.append(style);
  if (geometry) {
    // jsdom has no layout. Only the cutoff tests supply explicit page positions.
    dom.window.Element.prototype.getBoundingClientRect = function () {
      const top = this.hasAttribute('data-sf-hidden') ? 0 : Number(this.getAttribute('data-top') || 0);
      return {top,bottom:top+100,left:0,right:600,width:600,height:100};
    };
  }
  let checks=0;
  dom.window.eval(policy);
  dom.window.eval(timeline);
  dom.window.chrome = {runtime:{getURL:path=>`https://extension.test/${path}`,onMessage:{addListener(){}},sendMessage:async(message)=>{checks++;if(fail)throw Error('Disconnected');if(reply)return reply(dom.window,message);return {allowed:true,post:dom.window.SocialPolicy.post(dom.window.location.href),view:dom.window.SocialPolicy.view(dom.window.location.href)};}}};
  before?.(dom.window);
  dom.window.eval(script);
  await pause();
  // What the user can see: hidden by display:none, by the invisible loading state, or under the opaque cover.
  const concealed=node=>{
    for (let n=node;n;n=n.parentElement) { const style=dom.window.getComputedStyle(n); if (style.display==='none' || style.opacity==='0' || style.visibility==='hidden') return true; }
    const cover=dom.window.document.getElementById('sf-empty');
    return !!cover && !cover.contains(node) && dom.window.getComputedStyle(cover).position==='fixed';
  };
  return {dom,doc:dom.window.document,shadows,errors,checks:()=>checks,concealed,display:node=>dom.window.getComputedStyle(node).display};
}
test('keeps the native X conversation and replies while excluding outer navigation and rails',async()=>{
  const {dom,doc,concealed,display}=await fixture(`<body><nav id="nav">Home</nav><main>${column(`<header>Post</header>${tweet()}<div id="reply-composer">Reply composer</div><div id="replies">${tweet('456','A reply')}</div>`)}<aside id="rail">Trends</aside></main></body>`,'https://x.com/alice/status/123');
  try {
    assert.equal(doc.querySelector('[data-sf-target]').id,'conversation');
    assert.equal(doc.querySelector('#post-123').hasAttribute('data-sf-path'),false);
    assert.notEqual(display(doc.querySelector('#post-456')),'none');
    assert.notEqual(display(doc.querySelector('#replies')),'none');
    assert.notEqual(display(doc.querySelector('#reply-composer')),'none');
    assert.equal(display(doc.querySelector('#rail')),'none');
    assert.equal(display(doc.querySelector('#nav')),'none');
    assert.equal(doc.querySelector('#sf-bar,#sf-home,#sf-toolbar'),null);
  } finally {dom.window.close();}
});
test('unknown Instagram layout exposes only the explanation, never the site',async()=>{
  const {dom,doc,concealed,display,shadows}=await fixture('<body><main><div>Unknown Instagram recommendations</div></main></body>','https://www.instagram.com/p/abc/');
  try {
    // During the grace period the page stays blank rather than flashing the notice.
    assert.equal(doc.querySelector('#sf-empty'),null);assert.ok(concealed(doc.body));
    await new Promise(resolve=>setTimeout(resolve,900));assert.equal(doc.querySelector('[data-sf-target]'),null);assert.ok(concealed(doc.querySelector('main')));assert.ok(doc.querySelector('#sf-empty'));assert.notEqual(display(doc.querySelector('#sf-empty')),'none');assert.match(shadows.get(doc.querySelector('#sf-empty')).querySelector('a').href,/blocked\.html\?site=instagram&ready=1$/);}finally{dom.window.close();}
});
test('an unverified X column stays hidden even when it contains a quote of the requested post',async()=>{
  const {dom,doc,concealed,display}=await fixture(`<body><main>${column('<article data-testid="tweet"><a href="/bob/status/999"><time>now</time></a><div><a href="/alice/status/123"><time>quoted</time></a></div></article>')}</main></body>`,'https://x.com/alice/status/123');
  try {assert.equal(doc.querySelector('[data-sf-target]'),null);assert.ok(concealed(doc.querySelector('main')));}finally{dom.window.close();}
});
test('disconnected worker fails hidden without a retry loop',async()=>{
  const {dom,doc,concealed,checks,display}=await fixture('<body>Feed</body>','https://x.com/alice/status/123',{fail:true});
  try {assert.equal(doc.documentElement.hasAttribute('data-sf-ready'),false);assert.ok(concealed(doc.body));assert.ok(checks()<=2);}finally{dom.window.close();}
});
test('a post that quotes another post is found by its own timestamp, not the quote card above it',async()=>{
  // Live x.com (2026-11): on a post's page the quoted post's card, with an unlinked <time>, comes before the post's timestamp link.
  const focal='<article data-testid="tweet" id="focal"><div data-testid="User-Name">Jake</div><p>The sourcing is fascinating</p><div role="link" tabindex="0"><div data-testid="User-Name">Other<time datetime="2026-11-07T03:24:39.000Z">10h</time></div>Quoted text</div><a role="link" href="/jake/status/123"><time datetime="2026-11-07T05:19:51.000Z">2:19 PM</time></a></article>';
  const {dom,doc,concealed}=await fixture(`<body><main>${column(focal+tweet('456','A reply'))}</main></body>`,'https://x.com/jake/status/123');
  assert.equal(concealed(doc.getElementById('focal')),false);
  assert.equal(doc.getElementById('sf-empty'),null);
  dom.window.close();
});

test('an edited post is found by its timestamp, which links to its edit history',async()=>{
  const edited='<article data-testid="tweet" id="edited"><p>Lecture notes</p><a role="link" href="/anj/status/123/history"><time>Last edited 9:00 AM</time></a></article>';
  const {dom,doc,concealed}=await fixture(`<body><main>${column(edited)}</main></body>`,'https://x.com/anj/status/123');
  try {
    assert.equal(concealed(doc.getElementById('edited')),false);
    assert.equal(doc.getElementById('sf-empty'),null);
  } finally { dom.window.close(); }
});

test('a post X can\'t show (suspended, deleted) shows X\'s own notice, not our cover',async()=>{
  const notice='<div data-testid="cellInnerDiv"><article id="tombstone"><span>This Post is from a suspended account.</span> <a href="https://help.x.com/rules-and-policies/notices-on-x">Learn more</a></article></div>';
  const {dom,doc,concealed}=await fixture(`<body><nav id="nav">Nav</nav><main>${column(notice)}</main></body>`,'https://x.com/gone/status/123');
  try {
    assert.equal(concealed(doc.getElementById('tombstone')),false);
    assert.equal(doc.getElementById('sf-empty'),null);
    assert.equal(concealed(doc.getElementById('nav')),true);
  } finally { dom.window.close(); }
});

test('videos inside a post stay visible; promoted posts (wrapped in placementTracking) are hidden',async()=>{
  // Live x.com (2026-11): X wraps a post's video player in placementTracking too.
  const post='<article data-testid="tweet" id="focal"><a href="/alice/status/123"><time>now</time></a><div data-testid="tweetPhoto"><div data-testid="placementTracking" id="video-wrap"><div data-testid="videoPlayer" id="video">video</div></div></div></article>';
  const ad='<div data-testid="cellInnerDiv"><div data-testid="placementTracking" id="ad"><article data-testid="tweet"><a href="/brand/status/999"><time>now</time></a>Promoted</article></div></div>';
  const {dom,doc,concealed}=await fixture(`<body><main>${column(post+ad)}</main></body>`,'https://x.com/alice/status/123');
  assert.equal(concealed(doc.getElementById('video')),false);
  assert.equal(concealed(doc.getElementById('video-wrap')),false);
  assert.equal(concealed(doc.getElementById('ad')),true);
  dom.window.close();
});

test('Instagram Saved: the start page finds the signed-in username in the page data and goes to its saved page',async()=>{
  const went=[];
  const data='<script type="application/json">{"x":{"pk":"424242","username":"someone_else"},"y":{"id":"4242","username":"me.demo","full_name":"Me"}}</script>';
  const {dom}=await fixture(`<head>${data}</head><body><main><article><a href="/someone_else/">someone_else</a></article></main></body>`,'https://www.instagram.com/',{reply:startReply('saved'),before(win){ win.document.cookie='ds_user_id=4242'; win.SocialContentHooks={replace:url=>went.push(url)}; }});
  try {
    await pause();
    // Once, and to the signed-in user's page, not to an account whose id merely starts the same.
    assert.deepEqual(went,['https://www.instagram.com/me.demo/saved/']);
  } finally { dom.window.close(); }
});
test('saved pages show their own column: X Bookmarks and Instagram Saved',async()=>{
  let r=await fixture(`<body><nav id="nav">Nav</nav><main>${column(tweet('5','Saved post'))}</main><aside id="side">Trends</aside></body>`,'https://x.com/i/bookmarks');
  assert.equal(r.concealed(r.doc.getElementById('post-5')),false);
  assert.equal(r.concealed(r.doc.getElementById('nav')),true);
  assert.equal(r.concealed(r.doc.getElementById('side')),true);
  r.dom.window.close();
  r=await fixture('<body><nav id="nav">Nav</nav><main id="main"><div id="grid">Saved grid</div></main></body>','https://www.instagram.com/me.demo/saved/');
  assert.equal(r.concealed(r.doc.getElementById('grid')),false);
  assert.equal(r.concealed(r.doc.getElementById('nav')),true);
  r.dom.window.close();
});

test('Instagram preserves native comments inside its permalink article and hides recommendations',async()=>{
  const {dom,doc,concealed,display}=await fixture('<body><main><article id="target"><a href="/p/AbC/">Post</a><img src="post.jpg"><ul id="comments"><li>A comment</li></ul><form id="composer">Reply</form></article><article id="recommended"><a href="/p/Other/">Recommended</a></article></main></body>','https://www.instagram.com/p/AbC/');
  try {
    assert.equal(doc.querySelector('[data-sf-target]').id,'target');
    assert.notEqual(display(doc.querySelector('#comments')),'none');
    assert.notEqual(display(doc.querySelector('#composer')),'none');
    assert.equal(display(doc.querySelector('#recommended')),'none');
  }finally{dom.window.close();}
});
test('verified conversation remains available when X virtualizes away the root tweet',async()=>{
  const {dom,doc,concealed,display}=await fixture(`<body><main>${column(`${tweet()}<div id="replies">${tweet('456','A reply')}</div>`)}</main></body>`,'https://x.com/alice/status/123');
  try {
    doc.querySelector('#post-123').remove();
    await pause();
    assert.equal(doc.querySelector('[data-sf-target]').id,'conversation');
    assert.notEqual(display(doc.querySelector('#replies')),'none');
    assert.ok(doc.documentElement.hasAttribute('data-sf-ready'));
  }finally{dom.window.close();}
});
test('recycled root article remains within the already verified conversation',async()=>{
  const {dom,doc}=await fixture(`<body><main>${column(tweet())}</main></body>`,'https://x.com/alice/status/123');
  try {
    doc.querySelector('a[href="/alice/status/123"]').setAttribute('href','/alice/status/999');
    doc.querySelector('p').firstChild.data='Another reply in the same conversation';
    await pause();
    assert.equal(doc.querySelector('[data-sf-target]').id,'conversation');
  }finally{dom.window.close();}
});
test('reparented conversation gets a new outer path without touching its internal layout',async()=>{
  const {dom,doc}=await fixture(`<body><main>${column(tweet())}</main><section id="new"></section></body>`,'https://x.com/alice/status/123');
  try {
    doc.querySelector('#new').append(doc.querySelector('#conversation'));
    await pause();
    assert.ok(doc.querySelector('#new').hasAttribute('data-sf-path'));
    assert.ok(!doc.querySelector('main').hasAttribute('data-sf-path'));
    assert.equal(doc.querySelector('#post-123').hasAttribute('data-sf-path'),false);
  }finally{dom.window.close();}
});
test('recommendations are hidden after the boundary while preceding replies survive subsequent mutations',async()=>{
  const {dom,doc,concealed,display}=await fixture(`<body><main>${column(`<div data-testid="cellInnerDiv" data-top="100">${tweet()}</div><div id="reply" data-testid="cellInnerDiv" data-top="300">${tweet('456','A reply')}</div><div id="boundary" data-testid="cellInnerDiv" data-top="500"><h2>Discover more</h2></div><div id="recommended" data-testid="cellInnerDiv" data-top="600">${tweet('999','Recommendation')}</div>`)}</main></body>`,'https://x.com/alice/status/123',{geometry:true});
  try {
    assert.equal(display(doc.querySelector('#boundary')),'none');
    assert.equal(display(doc.querySelector('#recommended')),'none');
    assert.notEqual(display(doc.querySelector('#reply')),'none');
    doc.querySelector('#reply p').firstChild.data='Updated reply';
    await pause();
    assert.notEqual(display(doc.querySelector('#reply')),'none');
    assert.equal(display(doc.querySelector('#recommended')),'none');
  }finally{dom.window.close();}
});

for (const [site,url] of [['X','https://x.com/home'],['Instagram','https://www.instagram.com/']]) test(`${site} home never renders, even if a worker reply wrongly approves it`,async()=>{
  const {dom,doc,concealed,display}=await fixture(`<body><nav id="notifications">Notifications</nav><main id="feed">${tweet()}Infinite home feed</main></body>`,url,{
    reply:win=>({allowed:true,post:null,view:win.SocialPolicy.view(win.location.href)})
  });
  try {
    assert.equal(doc.querySelector('[data-sf-target]'),null);
    assert.equal(doc.documentElement.hasAttribute('data-sf-ready'),false);
    assert.ok(concealed(doc.body));
    assert.equal(doc.querySelector('#sf-home,#sf-bar'),null);
    assert.equal(doc.querySelector('#sf-empty'),null);
  }finally{dom.window.close();}
});
test('a non-post approval never falls through to post matching',async()=>{
  // A malformed approval (unknown kind, no post) must not match an arbitrary article.
  const {dom,doc,concealed,display}=await fixture(`<body><main>${column(tweet())}</main></body>`,'https://x.com/alice/status/123',{reply:()=>({allowed:true,view:{kind:'mystery',site:'x'}})});
  try {
    assert.equal(doc.querySelector('[data-sf-target]'),null);
    assert.ok(concealed(doc.body));
  }finally{dom.window.close();}
});
test('a post approval without a key never matches a link-less or keyless article',async()=>{
  const {dom,doc}=await fixture(`<body><main>${column('<article data-testid="tweet"><a href="/alice"><time>now</time></a></article>')}</main></body>`,'https://x.com/alice/status/123',{reply:()=>({allowed:true,view:{kind:'post',site:'x',post:{}}})});
  try { assert.equal(doc.querySelector('[data-sf-target]'),null); }finally{dom.window.close();}
});
test('post back button is hidden while comment thread links remain visible',async()=>{
  const {dom,doc,concealed,display}=await fixture(`<body><main>${column(`<button data-testid="app-bar-back">Back</button>${tweet()}${tweet('456','A reply')}`)}</main></body>`,'https://x.com/alice/status/123');
  try {
    assert.equal(display(doc.querySelector('[data-testid="app-bar-back"]')),'none');
    assert.notEqual(display(doc.querySelector('#post-456 a')),'none');
    dom.window.history.pushState({},'', '/alice/status/456');
    doc.querySelector('#post-456 p').firstChild.data='Opened reply thread';
    await pause();
    assert.equal(doc.querySelector('[data-sf-target]').id,'conversation');
    assert.ok(doc.documentElement.hasAttribute('data-sf-ready'));
  }finally{dom.window.close();}
});

test('site pages get no injected toolbar or input that could collide with site hotkeys',async()=>{
  const {dom,doc}=await fixture(`<body><main>${column(tweet())}</main></body>`,'https://x.com/alice/status/123');
  try {
    let siteKeys=0;
    dom.window.addEventListener('keydown',()=>siteKeys++,true);
    assert.equal(doc.querySelectorAll('input,textarea,[contenteditable]').length,0);
    assert.equal([...doc.body.children].some(node=>node.id?.startsWith('sf-')),false);
    doc.body.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'n',bubbles:true,cancelable:true}));
    assert.equal(siteKeys,1);
  }finally{dom.window.close();}
});
for (const url of ['https://x.com/i/chat','https://www.instagram.com/direct/inbox/']) test(`${url} preserves inbox and conversation panes without global navigation`,async()=>{
  const {dom,doc,concealed,display}=await fixture('<body><nav id="global">Home feed</nav><main id="messages"><section id="inbox">Inbox</section><section id="conversation-pane"><textarea id="message-input"></textarea></section></main></body>',url);
  try {
    assert.equal(doc.querySelector('[data-sf-target]').id,'messages');
    assert.notEqual(display(doc.querySelector('#inbox')),'none');
    assert.notEqual(display(doc.querySelector('#conversation-pane')),'none');
    assert.equal(display(doc.querySelector('#global')),'none');
  }finally{dom.window.close();}
});
test('personal message setup dialog stays visible instead of exposing the background',async()=>{
  const {dom,doc,concealed,display}=await fixture('<body><main id="background">Inbox</main><div role="dialog" id="pin"><input aria-label="Chat PIN"></div></body>','https://x.com/i/chat');
  try {
    assert.equal(doc.querySelector('[data-sf-target]').id,'pin');
    assert.equal(display(doc.querySelector('#background')),'none');
  }finally{dom.window.close();}
});
test('native tweet composer is isolated without exposing its background feed',async()=>{
  const {dom,doc,concealed,display}=await fixture('<body><main id="feed"><div contenteditable="true" data-testid="tweetTextarea_0">Home inline composer</div>Home feed</main><div role="dialog" id="compose"><div contenteditable="true" data-testid="tweetTextarea_0">Draft text</div><button>Post</button></div></body>','https://x.com/compose/post');
  try {
    assert.equal(doc.querySelector('[data-sf-target]').id,'compose');
    assert.equal(display(doc.querySelector('#feed')),'none');
    assert.notEqual(display(doc.querySelector('#compose [data-testid="tweetTextarea_0"]')),'none');
  }finally{dom.window.close();}
});
test('X notifications preserve the primary column while hiding the side rail',async()=>{
  const {dom,doc,concealed,display}=await fixture(`<body><nav id="nav">Global navigation</nav><main>${column('<div id="alerts">Notifications</div>')}<aside id="rail">Trends</aside></main></body>`,'https://x.com/notifications');
  try {
    assert.equal(doc.querySelector('[data-sf-target]').id,'conversation');
    assert.notEqual(display(doc.querySelector('#alerts')),'none');
    assert.equal(display(doc.querySelector('#rail')),'none');
    assert.equal(display(doc.querySelector('#nav')),'none');
  }finally{dom.window.close();}
});

test('compose route stays hidden while only the background inline composer exists',async()=>{
  const {dom,doc,concealed,display}=await fixture('<body><main id="feed"><div data-testid="tweetTextarea_0">Inline composer</div>Home feed</main></body>','https://x.com/compose/post');
  try { assert.equal(doc.querySelector('[data-sf-target]'),null); assert.ok(concealed(doc.querySelector('#feed'))); }finally{dom.window.close();}
});

test('a start view is honored only on Instagram home',async()=>{
  for (const url of ['https://www.instagram.com/explore/','https://x.com/home']) {
    const {dom,doc,concealed}=await fixture('<body><main id="feed">Feed</main></body>',url,{reply:startReply('notifications')});
    try { assert.equal(dom.window.location.href,url); assert.ok(concealed(doc.getElementById('feed')),url); assert.equal(doc.querySelector('[data-sf-target]'),null); } finally { dom.window.close(); }
  }
});
test('Instagram personal notifications activate native hash-link panel without exposing home',async()=>{
  let clicks=0;
  const {dom,doc,concealed,display}=await fixture('<body><nav><a href="#" id="trigger">NotificationsNotifications</a></nav><main id="feed">Home feed</main></body>','https://www.instagram.com/',{reply:startReply('notifications'),before(win){
    win.document.querySelector('#trigger').addEventListener('click',event=>{
      event.preventDefault(); clicks++;
      const panel=win.document.createElement('div');panel.id='activity';panel.setAttribute('role','dialog');panel.textContent='Notifications: a reply';win.document.body.append(panel);
    });
  }});
  try {
    assert.equal(clicks,1);
    assert.equal(doc.querySelector('[data-sf-target]').id,'activity');
    assert.equal(display(doc.querySelector('#feed')),'none');
    doc.querySelector('#activity').textContent='Notifications: updated';await pause();
    assert.equal(clicks,1);
  }finally{dom.window.close();}
});

test('composer targets the innermost dialog around the editor, not X\'s outer modal shell',async()=>{
  const html=`<body><main id="feed"><div data-testid="tweetTextarea_0">Inline</div>Home feed</main>
    <div id="layers"><div role="dialog" id="outer" aria-modal="true"><div id="mask">backdrop</div>
      <div role="group" id="fixed-group"><div id="centerer"><div role="dialog" id="inner"><header id="drafts">Drafts</header>
        <div data-testid="tweetTextarea_0" contenteditable="true">Draft</div><div id="toolbar"><button>Post</button></div>
      </div></div></div></div></div></body>`;
  const {dom,doc,concealed,display}=await fixture(html,'https://x.com/compose/post');
  try {
    assert.equal(doc.querySelector('[data-sf-target]').id,'inner');
    for (const id of ['outer','fixed-group','centerer','layers']) assert.ok(doc.getElementById(id).hasAttribute('data-sf-path'),id);
    for (const id of ['drafts','toolbar']) assert.notEqual(display(doc.getElementById(id)),'none',id);
    assert.equal(display(doc.getElementById('feed')),'none');
    assert.equal(display(doc.getElementById('mask')),'none');
    assert.equal(doc.documentElement.getAttribute('data-sf-view'),'compose');
  }finally{dom.window.close();}
});
const notesInbox=(label='Your note',extra='')=>`<body><nav id="global">Home</nav><main id="inbox-main"><div id="container">
  <div id="carousel"><div id="arrow-wrap"><div role="presentation" id="scroller" style="overflow-x:auto"><ul><li><button><span>${label}</span></button></li><li><button><span>friend</span></button></li></ul></div><div role="button" aria-label="Next"><svg></svg></div></div></div>
  ${extra}<h2 id="heading">Messages</h2><div id="threads" role="list"><a href="/direct/t/1/">A thread</a></div>
</div><input id="search" placeholder="Search"></main></body>`;
test('Instagram Notes carousel is hidden while DM search, heading and threads stay visible',async()=>{
  const {dom,doc,concealed,display}=await fixture(notesInbox(),'https://www.instagram.com/direct/inbox/');
  try {
    assert.equal(doc.querySelector('[data-sf-notes]').id,'carousel');
    assert.equal(display(doc.getElementById('carousel')),'none');
    for (const id of ['search','heading','threads','container']) assert.notEqual(display(doc.getElementById(id)),'none',id);
    assert.equal(display(doc.getElementById('global')),'none');
    // Live updates keep exactly one marked carousel.
    doc.querySelector('#threads a').textContent='New message'; await pause();
    assert.equal(doc.querySelectorAll('[data-sf-notes]').length,1);
  }finally{dom.window.close();}
});
test('Notes detection refuses wrappers that also hold the Messages heading or thread list',async()=>{
  // Scroller beside the heading and list in one wrapper: hiding it would hide the inbox.
  const html=`<body><main id="inbox-main"><div id="combined"><div role="presentation" id="scroller" style="overflow-x:auto"><ul><li><span>Your note</span></li></ul></div><h2 id="heading">Messages</h2><div id="threads"><a href="/direct/t/1/">A thread</a></div></div></main></body>`;
  const {dom,doc,concealed,display}=await fixture(html,'https://www.instagram.com/direct/inbox/');
  try {
    assert.equal(doc.querySelector('[data-sf-notes]'),null);
    for (const id of ['heading','threads']) assert.notEqual(display(doc.getElementById(id)),'none',id);
  }finally{dom.window.close();}
});
test('Notes detection is a no-op without the label or a horizontal scroller',async()=>{
  for (const html of [notesInbox('Something else'),notesInbox().replace('overflow-x:auto','overflow-x:visible')]) {
    const {dom,doc,concealed,display}=await fixture(html,'https://www.instagram.com/direct/inbox/');
    try { assert.equal(doc.querySelector('[data-sf-notes]'),null); assert.notEqual(display(doc.getElementById('threads')),'none'); }finally{dom.window.close();}
  }
});

test('a target that appears during the grace period never shows the unavailable notice',async()=>{
  const {dom,doc,concealed,display}=await fixture(`<body><main id="loading">Loading…</main></body>`,'https://x.com/alice/status/123');
  try {
    await new Promise(resolve=>setTimeout(resolve,300));
    doc.querySelector('main').innerHTML=column(tweet());
    await pause();
    assert.equal(doc.querySelector('[data-sf-target]').id,'conversation');
    await new Promise(resolve=>setTimeout(resolve,700));
    assert.equal(doc.querySelector('#sf-empty'),null);
    assert.equal(concealed(doc.body),false);
  }finally{dom.window.close();}
});
const composerLayers=extra=>`<body><main id="feed"><div data-testid="primaryColumn">Home feed</div></main><div id="layers">
  <div id="composer-layer"><div role="dialog" id="outer"><div id="mask"></div><div role="dialog" id="inner"><div data-testid="tweetTextarea_0">Draft</div></div></div></div>
  ${extra}</div></body>`;
test('composer keeps X\'s sibling sheets, toasts and menus, but never a timeline layer',async()=>{
  const {dom,doc,concealed,display}=await fixture(composerLayers(''),'https://x.com/compose/post');
  try {
    assert.equal(doc.querySelector('[data-sf-target]').id,'inner');
    const layers=doc.getElementById('layers');
    // Shapes observed live on x.com: the drawers share one layer; menus open in a HoverCard layer with cellInnerDiv rows.
    layers.insertAdjacentHTML('afterbegin','<div id="drawers"><div data-testid="GrokDrawer"><button>Grok</button></div><div data-testid="chat-drawer-root"><button>Chat</button></div><nav data-testid="BottomBar"></nav></div>');
    layers.insertAdjacentHTML('beforeend','<div id="sheet"><div role="alertdialog" data-testid="confirmationSheetDialog">Save post?</div></div><div id="toast"><div role="alert" data-testid="toast">Something went wrong</div></div><div id="audience"><div data-testid="hoverCardParent"><div data-testid="HoverCard"><div data-testid="cellInnerDiv"><div role="menuitem">Everyone</div></div></div></div></div><div id="timeline-layer"><div role="dialog"><article data-testid="tweet">Feed</article></div></div><div id="drawer"><div data-testid="DMDrawer">Messages</div></div><div id="unknown"><div>Some future layer</div></div>');
    await pause();
    for (const id of ['sheet','toast','audience']) assert.notEqual(display(doc.getElementById(id)),'none',id);
    for (const id of ['drawers','timeline-layer','drawer','unknown','feed','mask']) assert.equal(display(doc.getElementById(id)),'none',id);
    assert.equal(doc.querySelector('[data-sf-target]').id,'inner');
  }finally{dom.window.close();}
});
test('sibling layers stay hidden on every non-compose view',async()=>{
  const {dom,doc,concealed,display}=await fixture(`<body><main>${column(tweet())}</main><div id="layers"><div id="hover">Hover card</div></div></body>`,'https://x.com/alice/status/123');
  try { assert.equal(doc.querySelector('[data-sf-overlay]'),null); assert.equal(display(doc.getElementById('layers')),'none'); }finally{dom.window.close();}
});
test('on a post, X\'s own menus (Repost / Quote) and sheets are usable; drawers and other layers stay hidden',async()=>{
  // Live x.com (2026-11): the Repost button opens a role=menu in #layers, a sibling of the app.
  const html=`<body><div id="app"><main>${column(tweet())}</main></div><div id="layers"><div id="menu-layer"><div role="menu" id="menu"><div role="menuitem">Repost</div><div role="menuitem" id="quote">Quote</div></div></div><div id="drawer"><div data-testid="DMDrawer">Messages</div></div><div id="other"><div>Some future layer</div></div></div></body>`;
  const {dom,doc,concealed,display}=await fixture(html,'https://x.com/alice/status/123');
  try {
    assert.equal(concealed(doc.getElementById('quote')),false);
    assert.equal(concealed(doc.getElementById('post-123')),false);
    assert.equal(concealed(doc.getElementById('drawer')),true);
    assert.equal(concealed(doc.getElementById('other')),true);
    // When the menu closes, #layers is hidden again.
    doc.getElementById('menu-layer').remove();
    await pause();
    assert.equal(display(doc.getElementById('layers')),'none');
    assert.equal(doc.querySelector('[data-sf-layer-path]'),null);
  } finally { dom.window.close(); }
});
test('the topmost composer wins over an editor in a lower dialog layer',async()=>{
  const html=`<body><div id="layers"><div id="photo-layer"><div role="dialog" id="photo"><article data-testid="tweet">Photo replies</article><div data-testid="tweetTextarea_0">Inline reply</div></div></div>
    <div id="composer-layer"><div role="dialog" id="outer"><div role="dialog" id="inner"><div data-testid="tweetTextarea_0">Draft</div></div></div></div></div></body>`;
  const {dom,doc,concealed,display}=await fixture(html,'https://x.com/compose/post');
  try { assert.equal(doc.querySelector('[data-sf-target]').id,'inner'); assert.equal(display(doc.getElementById('photo-layer')),'none'); }finally{dom.window.close();}
});
for (const url of ['https://x.com/compose/post/unsent/drafts','https://x.com/compose/post/schedule','https://x.com/i/foundmedia/search']) test(`composer sub-page ${url} shows its own dialog instead of leaving and losing the draft`,async()=>{
  const {dom,doc,concealed,display}=await fixture(`<body><main id="feed">${column(tweet())}</main><div id="layers"><div><div role="dialog" id="outer-modal"><div role="dialog" id="sub">Drafts / schedule / GIFs</div></div></div></div></body>`,url);
  try {
    assert.equal(doc.documentElement.getAttribute('data-sf-view'),'compose');
    assert.equal(doc.querySelector('[data-sf-target]').id,'sub');
    assert.equal(display(doc.getElementById('feed')),'none');
  }finally{dom.window.close();}
});
test('composer sub-page never falls back to a dialog that holds a timeline',async()=>{
  const {dom,doc}=await fixture(`<body><div id="layers"><div role="dialog" id="photo"><article data-testid="tweet">Replies</article></div></div></body>`,'https://x.com/compose/post/schedule');
  try { assert.equal(doc.querySelector('[data-sf-target]'),null); }finally{dom.window.close();}
});
test('native back stays available in DMs but is hidden on posts',async()=>{
  const dm=await fixture('<body><main id="messages"><button data-testid="app-bar-back" id="back">Back to inbox</button><section>Conversation</section></main></body>','https://x.com/i/chat/1-2');
  try { assert.notEqual(dm.display(dm.doc.getElementById('back')),'none'); }finally{dm.dom.window.close();}
});

test('a worker reply describing a different view than the current URL is not applied',async()=>{
  const {dom,doc,concealed,display}=await fixture(`<body><main>${column('<div>Home timeline</div>')}</main></body>`,'https://x.com/home',{reply:()=>({allowed:true,view:{kind:'profile',site:'x'}})});
  try { assert.equal(doc.querySelector('[data-sf-target]'),null); assert.ok(concealed(doc.body)); }finally{dom.window.close();}
});

test('Instagram notification trigger that fires popstate synchronously does not crash isolation',async()=>{
  // Chrome fires popstate synchronously for href="#" fragment navigation, re-entering check()
  // from inside isolate(). Live crash: "Cannot read properties of null (reading 'kind')".
  let clicks=0;
  const {dom,doc,concealed,errors,display}=await fixture('<body><nav><a href="#" id="trigger">Notifications</a></nav><main id="feed">Home feed</main></body>','https://www.instagram.com/',{reply:startReply('notifications'),before(win){
    win.document.querySelector('#trigger').addEventListener('click',()=>{
      clicks++;
      win.history.pushState({},'',win.location.href.replace(/#.*$/,'')+'#');
      win.dispatchEvent(new win.PopStateEvent('popstate'));
      const panel=win.document.createElement('div');panel.id='activity';panel.setAttribute('role','dialog');panel.textContent='Notifications: a reply';win.document.body.append(panel);
    });
  }});
  try {
    await pause(); await pause();
    assert.deepEqual(errors.map(error=>String(error?.message||error)),[]);
    assert.equal(clicks,1);
    assert.equal(doc.querySelector('[data-sf-target]')?.id,'activity');
    assert.equal(display(doc.getElementById('feed')),'none');
  }finally{dom.window.close();}
});

test('composer drafts list rendered as virtualized cells is still shown',async()=>{
  const {dom,doc}=await fixture(`<body><div id="layers"><div><div role="dialog" id="outer"><div role="dialog" id="drafts"><div data-testid="cellInnerDiv">Draft one</div></div></div></div></div></body>`,'https://x.com/compose/post/unsent/drafts');
  try { assert.equal(doc.querySelector('[data-sf-target]').id,'drafts'); }finally{dom.window.close();}
});

test('live-shaped Instagram notification panel: early click retried, fixed container isolated, shell hidden',async()=>{
  // Shape observed on instagram.com: shell(main + nav) > fixed > relative > absolute > 460px > ... > heading.
  let clicks=0;
  const html=`<body><div id="shell"><nav id="nav"><a href="/">Home</a><a href="#" id="trigger"><svg aria-label="Notifications"></svg>Notifications</a><a href="/explore/">Explore</a></nav><main id="feed"><article>Feed post</article></main></div></body>`;
  const {dom,doc,concealed,errors,display}=await fixture(html,'https://www.instagram.com/',{reply:startReply('notifications'),before(win){
    win.document.querySelector('#trigger').addEventListener('click',event=>{
      event.preventDefault(); clicks++;
      if (clicks===1) return; // not hydrated yet: the first click is lost
      win.document.getElementById('shell').insertAdjacentHTML('beforeend','<div id="fixed" style="position:fixed;width:fit-content"><div style="position:relative"><div style="position:absolute"><div id="box" style="width:460px"><div role="heading"><span>Notifications</span></div><div id="items"><a href="/someone/">someone liked your post</a></div></div></div></div></div>');
    });
  }});
  try {
    assert.equal(clicks,1);
    await new Promise(resolve=>setTimeout(resolve,1800));
    assert.equal(clicks,2);
    assert.equal(doc.querySelector('[data-sf-target]')?.id,'fixed');
    assert.ok(doc.documentElement.hasAttribute('data-sf-panel'));
    assert.notEqual(display(doc.getElementById('items')),'none');
    for (const id of ['feed','nav']) assert.equal(display(doc.getElementById(id)),'none',id);
    await new Promise(resolve=>setTimeout(resolve,1700));
    assert.equal(clicks,2); // an open panel is never toggled shut
    assert.deepEqual(errors.map(String),[]);
  }finally{dom.window.close();}
});

test('a login view (iOS app sign-in pages) is shown untouched, and leaving it re-checks',async()=>{
  const {dom,doc,concealed,display}=await fixture('<body><main id="form"><input name="username"></main><nav id="nav">Nav</nav></body>','https://x.com/i/flow/login',{reply:()=>({allowed:true,view:{kind:'login',site:'x'}}),before(win){ const view=win.SocialPolicy.view; win.SocialPolicy.view=url=>/\/i\/flow\/login/.test(url) ? {kind:'login',site:'x'} : view(url); }});
  try {
    assert.equal(doc.documentElement.getAttribute('data-sf-view'),'login');
    assert.ok(doc.documentElement.hasAttribute('data-sf-ready'));
    for (const id of ['form','nav']) assert.notEqual(display(doc.getElementById(id)),'none',id);
    assert.equal(doc.querySelector('[data-sf-path],[data-sf-target],#sf-empty'),null);
  }finally{dom.window.close();}
});

test('mobile Instagram inbox without <main> uses its section shell, never one holding a feed',async()=>{
  const inbox=`<body><div id="app"><section id="shell"><div><div style="position:fixed"><div role="navigation" id="inbox"><h1>Messages</h1><label><input placeholder="Search"></label><div role="button" id="thread">A chat</div></div></div></div></section><div id="other">Other</div></div></body>`;
  const ok=await fixture(inbox,'https://www.instagram.com/direct/inbox/');
  try {
    assert.equal(ok.doc.querySelector('[data-sf-target]').id,'shell');
    assert.notEqual(ok.display(ok.doc.getElementById('thread')),'none');
    assert.equal(ok.display(ok.doc.getElementById('other')),'none');
  }finally{ok.dom.window.close();}
  const feed=await fixture(inbox.replace('<div id="other">','<div id="x"></div><div id="other">').replace('</section>','<article>Feed post</article></section>'),'https://www.instagram.com/direct/inbox/');
  try { assert.equal(feed.doc.querySelector('[data-sf-target]'),null); }finally{feed.dom.window.close();}
});

test('the content script reports its own URL with each check',async()=>{
  const seen=[];
  const {dom}=await fixture(`<body><main>${column(tweet())}</main></body>`,'https://x.com/alice/status/123',{before(win){ const send=win.chrome.runtime.sendMessage; win.chrome.runtime.sendMessage=async message=>{ seen.push(message); return send(message); }; }});
  try { assert.deepEqual(JSON.parse(JSON.stringify(seen[0])),{type:'check',url:'https://x.com/alice/status/123'}); }finally{dom.window.close();}
});

for (const url of ['https://x.com/ethanniser','https://x.com/search?q=cats']) test(`${url}: a mid-timeline "Who to follow" block is hidden but later tweets keep scrolling`,async()=>{
  // Live shape (x.com profile, 2026-11): tweets, heading cell, UserCells, "Show more" + spacer cells, tweets again.
  const cell=(id,inner)=>`<div data-testid="cellInnerDiv" id="${id}">${inner}</div>`;
  const html=`<body><main>${column(cell('t1',tweet('1','one'))+cell('t2',tweet('2','two'))+cell('wtf','<h2>Who to follow</h2>')+cell('u1','<div data-testid="UserCell">Someone</div>')+cell('u2','<div data-testid="UserCell">Someone else</div>')+cell('more','<a href="/i/connect_people">Show more</a>')+cell('spacer','')+cell('t3',tweet('3','three'))+cell('t4',tweet('4','four')))}</main></body>`;
  const {dom,doc,concealed,display}=await fixture(html,url);
  try {
    for (const id of ['wtf','u1','u2','more','spacer']) assert.equal(display(doc.getElementById(id)),'none',id);
    for (const id of ['t1','t2','t3','t4']) assert.notEqual(display(doc.getElementById(id)),'none',id);
  }finally{dom.window.close();}
});

test('links to destinations navigate natively; only links into feeds are intercepted',async()=>{
  const html=`<body><main>${column(tweet()+'<a id="profile" href="/bob">Bob</a><a id="thread" href="/bob/status/456">Reply</a><a id="dm" href="/i/chat/1-2">DM</a><a id="latest" href="/search?q=cats&src=typed_query&f=live">Latest</a><a id="home" href="/home">Home</a><a id="explore" href="/explore">Explore</a>')}</main></body>`;
  const {dom,doc}=await fixture(html,'https://x.com/alice/status/123');
  try {
    const click=id=>{ const event=new dom.window.MouseEvent('click',{bubbles:true,cancelable:true}); doc.getElementById(id).dispatchEvent(event); return event.defaultPrevented; };
    for (const id of ['profile','thread','dm','latest']) assert.equal(click(id),false,id);
    for (const id of ['home','explore']) assert.equal(click(id),true,id);
  }finally{dom.window.close();}
});

test('X request signature: the page is never display:none while booting, and empty top-level elements keep a box',async()=>{
  // X computes its x-client-transaction-id at start-up from a paused animation's computed
  // transform. Under display:none that reads "none", the signature is wrong and search 404s.
  const {dom,doc,display,concealed}=await fixture(`<body><main>${column(tweet())}</main><nav id="nav"><a href="/home">Home</a></nav></body>`,'https://x.com/alice/status/123',{before(win){
    win.__bootDisplay=win.getComputedStyle(win.document.body).display;
  }});
  try {
    assert.notEqual(dom.window.__bootDisplay,'none');
    const probe=doc.createElement('div'); doc.body.append(probe); await pause();
    assert.notEqual(display(probe),'none');            // X's animation element: empty, keeps its box
    assert.equal(display(doc.getElementById('nav')),'none'); // real content is still removed
    assert.equal(concealed(doc.getElementById('nav')),true);
  }finally{dom.window.close();}
});
test('while a view is not found the page keeps its boxes under an opaque cover',async()=>{
  const {dom,doc,display,concealed}=await fixture('<body><main id="feed">Home feed</main></body>','https://x.com/compose/post');
  try {
    assert.notEqual(display(doc.body),'none'); assert.notEqual(display(doc.getElementById('feed')),'none');
    assert.equal(concealed(doc.getElementById('feed')),true);
    await new Promise(resolve=>setTimeout(resolve,900));
    const cover=doc.getElementById('sf-empty');
    assert.ok(cover); assert.equal(cover.style.position,'fixed'); assert.equal(cover.style.zIndex,'2147483647');
    assert.notEqual(display(doc.getElementById('feed')),'none');
    assert.equal(concealed(doc.getElementById('feed')),true);
  }finally{dom.window.close();}
});

// ============ Unlocked X home and snapshot capture ============
const feedCell=(id,top)=>`<div data-testid="cellInnerDiv" id="c${id}" data-top="${top}">${tweet(String(id),'t'+id)}</div>`;
function feedHome(n, {extra='', following=false}={}) {
  const cells=Array.from({length:n},(_,i)=>feedCell(5000+i,i*100)).join('');
  return `<body><main><div data-testid="primaryColumn" id="column"><div role="tablist"><div role="presentation"><a role="tab" id="foryou" aria-selected="${!following}">For you</a></div><div role="presentation"><a role="tab" id="following" aria-selected="${following}">Following</a></div></div><section><div id="list" data-top="0">${cells}${extra}</div></section></div><nav id="nav">Nav</nav></main></body>`;
}
function feedWorker({mode='batch', seen=[], size=20, remainingMs=600_000, onMessage}={}) {
  const sent=[];
  const reply=(win,message)=>{
    sent.push(JSON.parse(JSON.stringify(message)));
    const extra=onMessage?.(message);
    if (extra) return extra;
    if (message.type==='feedSeen') { for (const id of message.ids) if (seen.length<size && !seen.includes(id)) seen.push(id); return {seen:[...seen],size,endsAt:Date.now()+3600_000,remainingMs}; }
    return {allowed:true,view:{kind:'feed',site:'x',mode},post:null,feed:{seen:[...seen],size,endsAt:Date.now()+3600_000,remainingMs,limitMs:900_000}};
  };
  return {reply,sent};
}

test('feed unlocked: no cap, a countdown pill, and time charged only while visible and in use',async()=>{
  const w=feedWorker({mode:'unlocked',onMessage:m=>m.type==='feedTick' ? {mode:'unlocked',seen:[],size:20,endsAt:Date.now()+3600_000,remainingMs:300_000} : null});
  const {dom,doc,display,shadows,concealed}=await fixture(feedHome(25),'https://x.com/home',{geometry:true,reply:w.reply});
  try {
    for (let i=0;i<25;i++) assert.equal(concealed(doc.getElementById(`c${5000+i}`)),false,i);
    assert.equal(doc.getElementById('list').hasAttribute('data-sf-clipped'),false);
    const pill=doc.getElementById('sf-feed-pill');
    assert.ok(pill); assert.match(shadows.get(pill).textContent,/Scrolling unlocked · 10:00 left/);
    // Idle: nothing is charged and the countdown holds.
    await new Promise(r=>setTimeout(r,2200));
    assert.match(shadows.get(pill).textContent,/10:00 left/);
    // Scrolling (even without window focus) charges time in 5-second reports.
    const scroll=setInterval(()=>doc.dispatchEvent(new dom.window.Event('wheel')),300);
    await new Promise(r=>setTimeout(r,5600));
    clearInterval(scroll);
    assert.deepEqual(w.sent.filter(m=>m.type==='feedTick').map(m=>m.ms),[5000]);
    assert.match(shadows.get(pill).textContent,/[0-9]:[0-9]{2} left/);
  }finally{dom.window.close();}
});
test('granted views are only accepted for X home (feed needs its details; capture needs nothing else)',async()=>{
  for (const [url,reply] of [
    ['https://x.com/explore',()=>({allowed:true,view:{kind:'feed',site:'x',mode:'unlocked'},feed:{remainingMs:1}})],
    ['https://x.com/home',()=>({allowed:true,view:{kind:'feed',site:'x',mode:'unlocked'}})],
    ['https://www.instagram.com/',()=>({allowed:true,view:{kind:'feed',site:'instagram',mode:'unlocked'},feed:{remainingMs:1}})],
    ['https://x.com/explore',()=>({allowed:true,view:{kind:'capture',site:'x'}})],
  ]) {
    const {dom,doc,concealed}=await fixture(feedHome(3),url,{reply});
    try { assert.equal(doc.documentElement.getAttribute('data-sf-view'),null,url); assert.ok(concealed(doc.getElementById('c5000')),url); }finally{dom.window.close();}
  }
});

const NONCE='0123456789abcdef0123456789abcdef';
const timelineBody=n=>JSON.stringify({data:{home:{home_timeline_urt:{instructions:[{type:'TimelineAddEntries',entries:Array.from({length:n},(_,i)=>({entryId:`tweet-${i}`,content:{itemContent:{itemType:'TimelineTweet',tweet_results:{result:{__typename:'Tweet',rest_id:String(7000+i),core:{user_results:{result:{core:{name:'N',screen_name:'n'+i},avatar:{image_url:'https://pbs.twimg.com/a.jpg'}}}},legacy:{full_text:'hello '+i,created_at:'Sat Nov 07 10:00:00 +0000 2026',entities:{urls:[]}}}}}}}))}]}}}});
test('capture window: stays invisible, switches to For You, and reports the first 20 tweets once',async()=>{
  const sent=[];
  const reply=(win,message)=>{ sent.push(JSON.parse(JSON.stringify(message))); return message.type==='check' ? {allowed:true,view:{kind:'capture',site:'x'}} : {ok:true}; };
  let clicks=0;
  const url=`https://x.com/home#sf_capture=${NONCE}`;
  const {dom,doc,concealed,errors}=await fixture(feedHome(3,{following:true}),url,{reply,before(win){ win.document.getElementById('foryou').addEventListener('click',()=>clicks++); }});
  try {
    assert.ok(concealed(doc.getElementById('c5000')));
    assert.equal(clicks,1);
    const post=(data,source=dom.window)=>dom.window.dispatchEvent(new dom.window.MessageEvent('message',{data,source}));
    post({sfCapture:'f'.repeat(32),body:timelineBody(25)});      // wrong nonce
    post({sfCapture:NONCE,body:timelineBody(25)},null);           // not from the page itself
    post({sfCapture:NONCE,body:'not json'});
    await pause();
    assert.equal(sent.filter(m=>m.type==='captured').length,0);
    post({sfCapture:NONCE,body:timelineBody(25)});
    post({sfCapture:NONCE,body:timelineBody(25)});
    await pause();
    const captured=sent.filter(m=>m.type==='captured');
    assert.equal(captured.length,1);
    assert.equal(captured[0].nonce,NONCE); assert.equal(captured[0].tweets.length,20);
    assert.equal(captured[0].tweets[0].url,'https://x.com/n0/status/7000');
    assert.ok(concealed(doc.getElementById('c5000')));
  }finally{dom.window.close();}
});
