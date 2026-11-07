import {test} from 'node:test';
import assert from 'node:assert/strict';
import '../extension/policy.js';
const P=globalThis.SocialPolicy;
test('canonicalizes supported posts and removes tracking',()=>{
  assert.equal(P.post('https://twitter.com/ethanniser/status/12345?s=20#hello').url,'https://x.com/i/web/status/12345');
  assert.equal(P.post('https://www.instagram.com/p/AbC_-123/?igsh=abc').key,'instagram:AbC_-123');
  assert.equal(P.post('https://www.instagram.com/reel/AbC_-123/').key,'instagram:AbC_-123');
});
test('post parsing rejects feeds, impostors, bad protocols and suffixes',()=>{
  for (const value of ['https://x.com/home','https://x.com/explore','https://x.com/alice','https://instagram.com/reels/','https://instagram.com/p/a/extra','https://x.com/a/status/123/likes','https://evil.com/?x=https://x.com/a/status/123','https://x.com.evil.com/a/status/123','https://x.com@evil.com/a/status/123','https://evil@x.com/a/status/123','https://x.com:8443/a/status/123','http://x.com/a/status/123','javascript:alert(1)','https://api.x.com/a/status/123']) assert.equal(P.post(value),null,value);
});
test('direct-post patterns follow thread links and media but never home or profile routes',()=>{
  const matches=url=>P.patterns.some(pattern=>new RegExp(pattern).test(url));
  for (const url of ['https://x.com/i/web/status/123','https://x.com/alice/status/123/photo/1','https://mobile.twitter.com/bob/status/456?s=1','https://www.instagram.com/p/AbC/']) assert.ok(matches(url),url);
  for (const url of ['https://x.com/alice','https://x.com/alice/status/123/likes','https://x.com/home','https://x.com.evil.com/alice/status/123']) assert.ok(!matches(url),url);
});
test('classifies deliberate destinations and excludes reserved discovery routes',()=>{
  for (const [url,kind,site] of [
    ['https://x.com/','home','x'],['https://x.com/home','home','x'],['https://x.com/search','home','x'],['https://x.com/search?q=hello','search','x'],['https://x.com/alice','profile','x'],['https://www.instagram.com/','home','instagram'],['https://www.instagram.com/alice.name/','profile','instagram'],['https://x.com/alice/status/123','post','x']
  ]) { const view=P.view(url); assert.equal(view.kind,kind,url); assert.equal(view.site,site,url); }
  for (const url of ['https://x.com/explore','https://x.com/settings','https://x.com/i','https://www.instagram.com/reels/','https://www.instagram.com/explore/','https://www.instagram.com/accounts/','https://x.com/alice/with_replies','https://evil@x.com/alice','https://x.com:8443/alice','http://x.com/alice','https://x.com.evil.com/alice']) assert.equal(P.view(url),null,url);
});
test('search rules allow only a non-empty X query, above the bare-search gate',()=>{
  const matches=url=>P.searchPatterns.some(pattern=>new RegExp(pattern).test(url));
  for (const url of ['https://x.com/search?q=hello','https://mobile.x.com/search?q=a&src=typed_query','https://twitter.com/search?src=typed_query&q=web%20components','https://x.com/search/?q=1']) assert.ok(matches(url),url);
  for (const url of ['https://x.com/search','https://x.com/search?q=','https://x.com/search?f=live','https://x.com/search?q=&f=live','https://x.com/home?q=a','https://x.com/searching?q=a','https://www.instagram.com/search?q=a','https://x.com.evil.com/search?q=a','https://x.com/search#?q=a']) assert.ok(!matches(url),url);
  const rules=P.staticRules();
  const gate=rules.find(rule=>rule.condition.urlFilter==='||x.com/search^');
  const allow=rules.find(rule=>rule.action.type==='allow' && rule.condition.regexFilter && new RegExp(rule.condition.regexFilter).test('https://x.com/search?q=hello'));
  assert.ok(gate && allow && allow.priority>gate.priority);
  assert.equal(P.view('https://x.com/search?q=%20%20').kind,'home');
  assert.equal(P.destination('https://x.com/search?q=%20%20'),null);
  assert.equal(P.destination('https://x.com/search?f=live&q=%20cats%20&src=x#y').url,'https://x.com/search?q=cats&f=live');
  assert.equal(P.focusPatterns,undefined);
});
test('packaged direct-post rules outrank reserved-route gates and never allow embeds',()=>{
  const rules=P.staticRules(),ids=rules.map(rule=>rule.id);
  assert.equal(new Set(ids).size,ids.length);
  const direct=rules.filter(rule=>rule.action.type==='allow' && rule.id>=100 && rule.id<200);
  assert.equal(direct.length,P.patterns.length);
  for (const rule of direct) { assert.deepEqual(rule.condition.resourceTypes,['main_frame']); assert.equal(rule.condition.isUrlFilterCaseSensitive,true); }
  for (const url of ['https://x.com/i/web/status/123','https://instagram.com/p/AbC/','https://instagram.com/reel/AbC/']) {
    const allow=direct.find(rule=>new RegExp(rule.condition.regexFilter).test(url));
    assert.ok(allow,url);
    assert.ok(rules.filter(rule=>rule.action.type==='redirect').every(rule=>rule.priority<allow.priority));
  }
  for (const filter of ['||x.com/notifications^','||x.com/explore^','||twitter.com/messages^','||instagram.com/reels^','||instagram.com/direct^']) {
    const rule=rules.find(rule=>rule.condition.urlFilter===filter);
    assert.equal(rule.action.type,'redirect',filter); assert.ok(rule.priority>20,filter);
  }
  assert.ok(rules.some(rule=>rule.action.type==='block' && rule.condition.resourceTypes.includes('sub_frame')));
});
test('post parser and permanent rules agree for representative URLs',()=>{
  const urls=['https://x.com/a/status/1','https://x.com/i/web/status/1','https://x.com/a/status/1/video/1','https://instagram.com/p/AbC/','https://instagram.com/reel/AbC/','https://instagram.com/reels/','https://x.com/home','https://x.com/a/status/1/no'];
  for (const url of urls) assert.equal(P.patterns.some(r=>new RegExp(r).test(url)),!!P.post(url),url);
});

test('account links have permanent rules while home and reserved routes override those rules',()=>{
  const rules=P.staticRules();
  for (const url of ['https://twitter.com/alice','https://x.com/alice/','https://www.instagram.com/alice.name/?igsh=123']) {
    assert.equal(P.view(url).kind,'profile');
    assert.ok(P.destination(url));
    assert.ok(rules.some(r=>r.action.type==='allow' && r.priority===10 && new RegExp(r.condition.regexFilter).test(url)));
  }
  for (const route of ['home','search','explore']) {
    const gate=rules.find(r=>r.condition.urlFilter===`||x.com/${route}^`);
    assert.ok(gate.priority>10);
    assert.equal(P.destination(`https://x.com/${route}`),null);
  }
  for (const url of ['https://x.com/','https://twitter.com/','https://instagram.com/']) {
    assert.equal(P.destination(url),null);
    assert.ok(!P.profilePatterns.some(r=>new RegExp(r).test(url)));
  }
  assert.equal(P.destination('https://www.instagram.com/alice/?igsh=tracking#fragment').url,'https://www.instagram.com/alice/');
});

test('personal routes are explicit and outrank reserved gates without allowing feeds',()=>{
  const urls=[
    ['https://x.com/notifications','notifications'],['https://x.com/notifications/mentions','notifications'],['https://x.com/notifications/verified/','notifications'],
    ['https://twitter.com/messages','messages'],['https://x.com/messages/123-456','messages'],['https://x.com/i/chat','messages'],['https://x.com/i/chat/123:456','messages'],
    ['https://x.com/compose/post','compose'],['https://x.com/compose/tweet/','compose'],
    ['https://www.instagram.com/direct/inbox/','messages'],['https://instagram.com/direct/t/123/','messages'],['https://www.instagram.com/accounts/activity/','notifications'],['https://instagram.com/notifications/','notifications']
  ];
  const rules=P.staticRules();
  for (const [url,kind] of urls) {
    assert.equal(P.view(url)?.kind,kind,url);
    assert.ok(P.destination(url),url);
    const allow=rules.find(rule=>rule.action.type==='allow' && rule.priority===100 && new RegExp(rule.condition.regexFilter).test(url));
    assert.ok(allow,url); assert.deepEqual(allow.condition.resourceTypes,['main_frame']);
    assert.ok(rules.filter(rule=>rule.action.type==='redirect').every(rule=>rule.priority<allow.priority));
  }
  for (const url of ['https://x.com/home','https://x.com/explore','https://x.com/i/bookmarks/all','https://x.com/compose/delete','https://instagram.com/reels/','https://instagram.com/accounts/password/change/','https://x.com.evil.test/messages','http://x.com/messages']) {
    assert.ok(!P.personalEntries.some(entry=>new RegExp(entry.pattern).test(url)),url);
  }
  assert.equal(P.view('https://x.com/notifications/unknown'),null);
});

test('pasting the Instagram notification-panel link preserves its purpose marker',()=>{
  assert.equal(P.destination('https://www.instagram.com/?sf_personal=notifications&tracking=remove#fragment').url,'https://www.instagram.com/?sf_personal=notifications');
  assert.equal(P.view(P.personalURLs.instagram.notifications).panel,true);
});

test('saved posts: X Bookmarks (and folders) and Instagram Saved (and collections) are destinations',()=>{
  const rules=P.staticRules();
  const allowed=url=>rules.some(rule=>rule.action.type==='allow' && rule.condition.regexFilter && new RegExp(rule.condition.regexFilter).test(url));
  for (const url of ['https://x.com/i/bookmarks','https://x.com/i/bookmarks/1834567890','https://twitter.com/i/bookmarks','https://x.com/i/history','https://x.com/i/history/bookmarks','https://www.instagram.com/someone/saved/','https://www.instagram.com/some.one/saved/all-posts/','https://www.instagram.com/someone/saved/recipes/17890000000000000/','https://www.instagram.com/?sf_personal=saved']) {
    assert.equal(P.view(url)?.kind,'saved',url); assert.ok(allowed(url),url);
  }
  assert.equal(P.view('https://www.instagram.com/?sf_personal=saved').redirect,true);
  for (const url of ['https://x.com/i/bookmarksX','https://x.com/i/bookmarks/abc','https://www.instagram.com/someone/saved/a/b/c/','https://www.instagram.com/someone/savedx/']) assert.notEqual(P.view(url)?.kind,'saved',url);
  assert.equal(P.destination('https://x.com/i/bookmarks').url,'https://x.com/i/bookmarks');
  assert.equal(P.destination('https://www.instagram.com/someone/saved/').url,'https://www.instagram.com/someone/saved/');
});

test('composer sub-pages are compose destinations while unrelated i/ and compose routes stay gated',()=>{
  const rules=P.staticRules();
  const allowed=url=>rules.some(rule=>rule.action.type==='allow' && rule.condition.regexFilter && new RegExp(rule.condition.regexFilter).test(url));
  for (const url of ['https://x.com/compose/post/unsent/drafts','https://x.com/compose/post/schedule','https://twitter.com/compose/tweet/unsent/scheduled','https://x.com/i/foundmedia/search']) {
    assert.deepEqual({kind:P.view(url)?.kind,subpage:P.view(url)?.subpage},{kind:'compose',subpage:true},url);
    assert.ok(allowed(url),url);
  }
  assert.equal(P.view('https://x.com/compose/post').subpage,undefined);
  for (const url of ['https://x.com/compose/','https://x.com/compose/post/a/b/c/d','https://x.com/i/foundmedia/other','https://x.com/i/bookmarks','https://x.com/compose/post/../../home']) {
    assert.notEqual(P.view(url)?.kind,'compose',url);
  }
});

test('only typed searches are destinations; one-click cashtag, trend and hashtag searches are gated',()=>{
  for (const url of ['https://x.com/search?q=cats','https://x.com/search?q=cats&src=typed_query&f=live']) assert.equal(P.view(url).kind,'search',url);
  for (const url of ['https://x.com/search?q=%24TSLA&src=cashtag_click','https://x.com/search?q=trend&src=trend_click','https://x.com/search?q=%23tag&src=hashtag_click']) {
    assert.equal(P.view(url).kind,'home',url);
    assert.equal(P.destination(url).url.includes('src='),false,url); // pasting one deliberately strips the click source
  }
  for (const url of ['https://x.com/hashtag/cats','https://x.com/grok','https://x.com/following','https://x.com/topics','https://x.com/display']) assert.notEqual(P.view(url)?.kind,'profile',url);
});
test('Instagram handles reject dot tricks that alias reserved routes',()=>{
  for (const handle of ['explore.','reels.','.explore','a..b','....']) assert.equal(P.view(`https://www.instagram.com/${handle}/`),null,handle);
  for (const handle of ['alice.name','a_b.c','x']) assert.equal(P.view(`https://www.instagram.com/${handle}/`).kind,'profile',handle);
});

test('picking from X\'s own search box stays a search; pasted searches keep their results tab',()=>{
  for (const src of ['typeahead_click','recent_search_click','spelling_expansion_revert_click','spelling_suggestion_click']) assert.equal(P.view(`https://x.com/search?q=cats&src=${src}`).kind,'search',src);
  assert.equal(P.view('https://x.com/search?q=cats&src=typeahead_click_evil').kind,'home');
  assert.equal(P.destination('https://x.com/search?q=cats&src=cashtag_click&f=live').url,'https://x.com/search?q=cats&f=live');
  assert.equal(P.destination('https://x.com/search?q=cats&f=evil').url,'https://x.com/search?q=cats');
});

test('Instagram username-prefixed post and reel links are posts, canonicalized without the username',()=>{
  for (const [url,canonical] of [['https://www.instagram.com/instagram/reel/DfaHGpjJsCq/','https://www.instagram.com/reel/DfaHGpjJsCq/'],['https://www.instagram.com/some.user/p/AbC_-1/?img_index=2','https://www.instagram.com/p/AbC_-1/']]) {
    assert.equal(P.view(url).kind,'post',url);
    assert.equal(P.post(url).url,canonical);
    assert.ok(P.patterns.some(pattern=>new RegExp(pattern).test(url.replace(/\?.*$/,''))),url);
  }
  assert.equal(P.post('https://www.instagram.com/instagram/reels/'),null);
  assert.equal(P.post('https://www.instagram.com/a/b/p/AbC/'),null);
  assert.equal(P.post('https://www.instagram.com/instagram/reel/AbC/extra'),null);
});
