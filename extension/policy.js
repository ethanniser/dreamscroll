(() => {
  const xHosts = ['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'];
  const igHosts = ['instagram.com', 'www.instagram.com', 'm.instagram.com'];
  const escape = value => value.replaceAll('.', '\\.');
  const end = '(?:[?#]|$)';
  const media = '(?:/(?:photo|video)/[1-4])?/?';
  // Small independent RE2 programs: no hostname alternatives or Unicode dot-star.
  const buildX = id => xHosts.flatMap(host => ['[A-Za-z0-9_]+/status', 'i/web/status'].map(route => `^https://${escape(host)}/${route}/${id}${media}${end}`));
  // Instagram also links posts as /<username>/p/<id>/ and /<username>/reel/<id>/ (2026).
  const buildIG = id => igHosts.flatMap(host => ['p', 'reel', '[A-Za-z0-9_.]+/p', '[A-Za-z0-9_.]+/reel'].map(route => `^https://${escape(host)}/${route}/${id}/?${end}`));
  const patterns = [...buildX('[0-9]+'), ...buildIG('[A-Za-z0-9_-]+')];
  function post(raw) {
    try {
      const url = new URL(raw.trim());
      if (url.username || url.password || url.port || url.protocol !== 'https:') return null;
      if (!patterns.some(pattern => new RegExp(pattern).test(url.href))) return null;
      const instagram = /(^|\.)instagram\.com$/.test(url.hostname);
      const match = instagram ? url.pathname.match(/^\/(?:[A-Za-z0-9_.]+\/)?(p|reel)\/([A-Za-z0-9_-]+)/) : url.pathname.match(/\/status\/([0-9]+)/);
      const id = instagram ? match[2] : match[1];
      const path = instagram ? `/${match[1]}/${id}/` : `/i/web/status/${id}`;
      return {site: instagram ? 'instagram' : 'x', id, key: `${instagram ? 'instagram' : 'x'}:${id}`, url: `https://${instagram ? 'www.instagram.com' : 'x.com'}${path}`};
    } catch { return null; }
  }
  function social(raw) {
    try { return /(^|\.)(x\.com|twitter\.com|instagram\.com)$/.test(new URL(raw).hostname); } catch { return false; }
  }
  const reservedX = ['home','search','grok','following','followers','topics','display','spaces','hashtag','bookmarks','communities','premium','jobs','lists','connect_people','who_to_follow','notifications','explore','messages','settings','compose','i','login','logout','signup','tos','privacy','account','intent','share'];
  const reservedIG = ['explore','reels','stories','direct','accounts','about','legal','privacy','terms','developer','p','reel'];
  function site(raw) {
    try {
      const host = new URL(raw).hostname;
      if (xHosts.includes(host)) return 'x';
      if (igHosts.includes(host)) return 'instagram';
      return null;
    } catch { return null; }
  }
  const personalEntries = [
    ...xHosts.flatMap(host => [
      ['notifications','/notifications(?:/(?:mentions|verified))?/?'],
      ['messages','/messages(?:/[A-Za-z0-9_:-]+)*/?'],
      ['messages','/i/chat(?:/[A-Za-z0-9_:-]+)*/?'],
      ['compose','/compose/(?:post|tweet)/?'],
      // Composer sub-pages: drafts, scheduling, GIF search. Leaving them would discard the draft.
      ['compose','/compose/(?:post|tweet)(?:/[A-Za-z0-9_-]+){1,3}/?',true],
      ['compose','/i/foundmedia/search/?',true],
      // Saved posts: Bookmarks and bookmark folders, which X now redirects to /i/history (live 2026-11).
      ['saved','/i/bookmarks(?:/[0-9]+)?/?'],
      ['saved','/i/history(?:/[a-z_]+)?/?'],
      // A post's quotes ("View quotes"): only posts quoting that one post.
      ['quotes','/[A-Za-z0-9_]+/status/[0-9]+/quotes/?'],
      ['quotes','/i/web/status/[0-9]+/quotes/?']
    ].map(([kind,path,subpage]) => ({site:'x',kind,...(subpage ? {subpage:true} : {}),pattern:`^https://${escape(host)}${path}${end}`}))),
    ...igHosts.flatMap(host => [
      ['notifications','/accounts/activity/?'],
      ['notifications','/notifications/?'],
      ['messages','/direct(?:/[A-Za-z0-9_-]+)*/?'],
      // Saved posts and collections (only your own are visible to you).
      // Unbounded repeats: Chrome compiles these with RE2 under a 2 KB budget, and {m,n} counts blow it.
      ['saved','/[A-Za-z0-9_.]+/saved(?:/all-posts|/[A-Za-z0-9_.-]+/[0-9]+)?/?']
    ].map(([kind,path]) => ({site:'instagram',kind,pattern:`^https://${escape(host)}${path}${end}`})))
  ];
  const personalURLs = {
    x:{notifications:'https://x.com/notifications',messages:'https://x.com/i/chat',compose:'https://x.com/compose/post',saved:'https://x.com/i/bookmarks'},
    instagram:{notifications:'https://www.instagram.com/',messages:'https://www.instagram.com/direct/inbox/',saved:'https://www.instagram.com/'}
  };
  // Instagram's desktop Notifications is a panel over home, and Saved lives at
  // /<you>/saved/: both start on a plain instagram.com/ that only the tab (or web
  // view) opened for them may load. content.js opens the panel, or finds "you" and
  // goes to your saved page.
  const startViews = {instagram:{notifications:{kind:'notifications',site:'instagram',panel:true,start:true},saved:{kind:'saved',site:'instagram',redirect:true,start:true}}};
  const instagramHome = raw => { const v = view(raw); return v?.kind === 'home' && v.site === 'instagram'; };
  function view(raw) {
    const target = post(raw);
    if (target) return {kind:'post', site:target.site, post:target};
    try {
      const url = new URL(raw), name = site(raw);
      if (!name || url.protocol !== 'https:' || url.port || url.username || url.password) return null;
      const personal = personalEntries.find(entry => new RegExp(entry.pattern).test(url.href));
      if (personal) return {kind:personal.kind,site:name,...(personal.subpage ? {subpage:true} : {})};
      const path = url.pathname.replace(/\/$/, '');
      if (!path || (name === 'x' && path === '/home')) return {kind:'home',site:name};
      // A search is a destination only when typed: cashtag/trend/hashtag clicks
      // (src=cashtag_click etc.) are one-click doors into an endless results feed.
      if (name === 'x' && path === '/search') {
        const src=url.searchParams.get('src');
        // Picking from X's own search box (typeahead, recent, spelling fix) is still typing.
        const typed=src === null || /^(?:typed_query|typeahead_click|recent_search_click|spelling_[a-z_]+)$/.test(src);
        return {kind:url.searchParams.get('q')?.trim() && typed ? 'search' : 'home',site:name};
      }
      const handle = path.slice(1);
      const reserved = name === 'x' ? reservedX : reservedIG;
      const valid = name === 'x' ? /^[A-Za-z0-9_]{1,15}$/ : /^(?!\.)(?!.*\.\.)(?!.*\.$)[A-Za-z0-9_.]{1,30}$/;
      if (valid.test(handle) && !reserved.includes(handle.toLowerCase())) return {kind:'profile',site:name};
      return null;
    } catch { return null; }
  }
  // Only a search with a non-empty q parameter is a destination; bare search stays gated.
  const searchPatterns=xHosts.map(host => `^https://${escape(host)}/search/?\\?(?:[^#]*&)?q=[^&#]`);
  const profilePatterns = [...xHosts.map(host => `^https://${escape(host)}/[A-Za-z0-9_]+/?${end}`), ...igHosts.map(host => `^https://${escape(host)}/[A-Za-z0-9_.]+/?${end}`)];
  function destination(raw) {
    const target = post(raw);
    if (target) return target;
    let url;
    try { url = new URL(String(raw).trim()); } catch { return null; }
    // A pasted search is deliberate, wherever it was copied from: keep only the query.
    if (site(url.href) === 'x' && url.pathname.replace(/\/$/, '') === '/search') {
      const q = url.searchParams.get('q')?.trim(), tab = url.searchParams.get('f');
      url.search = q ? '?q=' + encodeURIComponent(q) + (['live','user','media','list'].includes(tab) ? '&f=' + tab : '') : '';
    }
    url.hash = '';
    const kind = view(url.href);
    if (!['profile','search','notifications','messages','compose','saved','quotes'].includes(kind?.kind)) return null;
    if (kind.kind !== 'search') url.search = '';
    return {site:site(url.href),url:url.href};
  }
  function staticRules() {
    const rules = [
      {id:1,priority:1,action:{type:'redirect',redirect:{extensionPath:'/blocked.html?site=x'}},condition:{requestDomains:['x.com','twitter.com'],resourceTypes:['main_frame']}},
      {id:2,priority:1,action:{type:'redirect',redirect:{extensionPath:'/blocked.html?site=instagram'}},condition:{requestDomains:['instagram.com'],resourceTypes:['main_frame']}},
      {id:3,priority:1,action:{type:'block'},condition:{requestDomains:['x.com','twitter.com','instagram.com'],resourceTypes:['sub_frame']}}
    ];
    patterns.forEach((regexFilter,i) => rules.push({id:100+i,priority:100,action:{type:'allow'},condition:{regexFilter,isUrlFilterCaseSensitive:true,resourceTypes:['main_frame']}}));
    personalEntries.forEach((entry,i) => rules.push({id:400+i,priority:100,action:{type:'allow'},condition:{regexFilter:entry.pattern,isUrlFilterCaseSensitive:true,resourceTypes:['main_frame']}}));
    searchPatterns.forEach((regexFilter,i) => rules.push({id:500+i,priority:100,action:{type:'allow'},condition:{regexFilter,isUrlFilterCaseSensitive:true,resourceTypes:['main_frame']}}));
    profilePatterns.forEach((regexFilter,i) => rules.push({id:200+i,priority:10,action:{type:'allow'},condition:{regexFilter,isUrlFilterCaseSensitive:true,resourceTypes:['main_frame']}}));
    // Home/search are also syntactically single-segment handles: gate them above
    // profile rules. A search with a query has its own direct rule; blank search is gated.
    // A fixed block (600+), so adding personal routes (400+) never shifts these ids.
    let gate=600;
    for (const domain of ['x.com','twitter.com']) for (const path of ['home','search']) rules.push({id:gate++,priority:15,action:{type:'redirect',redirect:{extensionPath:'/blocked.html?site=x'}},condition:{urlFilter:`||${domain}/${path}^`,resourceTypes:['main_frame']}});
    for (const [name,domains,paths] of [['x',['x.com','twitter.com'],reservedX.filter(path => !['home','search'].includes(path))],['instagram',['instagram.com'],reservedIG]]) {
      for (const domain of domains) for (const path of paths) rules.push({id:1000+rules.length,priority:50,action:{type:'redirect',redirect:{extensionPath:`/blocked.html?site=${name}`}},condition:{urlFilter:`||${domain}/${path}^`,resourceTypes:['main_frame']}});
    }
    return rules;
  }
  globalThis.SocialPolicy = {post, social, patterns, site, view, searchPatterns, profilePatterns, personalEntries, personalURLs, startViews, instagramHome, destination, staticRules};
})();
