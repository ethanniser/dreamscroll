(() => {
  const P = globalThis.SocialPolicy;
  let approved = null, lastUrl = '', checking = false, targetNode = null;
  let conversation = null, conversationKey = null;
  let emptyNotice, missingSince=0, missingTimer=null;
  const GRACE_MS=800;
  let notificationRequestKey=null, notificationClicks=0, lastNotificationClick=0;
  // Unlocked X home (spends the daily budget) and the hidden snapshot capture window.
  let feed=null, forYouClicked=false, feedPill=null, captureSent=false;
  function hide() { document.documentElement?.removeAttribute('data-sf-ready'); }
  function showUnavailable() {
    if (!document.body || emptyNotice?.isConnected) return;
    emptyNotice=document.createElement('div');emptyNotice.id='sf-empty';
    // An opaque cover, not display:none on the page (see content.css on X's signature).
    emptyNotice.style.cssText='position:fixed!important;inset:0!important;z-index:2147483647!important;display:block!important;background:Canvas!important;color-scheme:light dark!important;overflow:auto!important';
    const shadow=emptyNotice.attachShadow({mode:'closed'}), style=document.createElement('style');
    style.textContent=':host{display:block}section{max-width:520px;margin:15vh auto;padding:28px;font:16px system-ui;line-height:1.6;color:#718078}a{color:inherit;font-weight:600}';
    const section=document.createElement('section'), message=document.createElement('p'), link=document.createElement('a');
    message.textContent='This view isn’t available yet. Try refreshing, or choose another destination.';
    link.textContent='Choose a destination';link.href=chrome.runtime.getURL(`blocked.html?site=${approved.site}&ready=1`);
    section.append(message,link);shadow.append(style,section);document.body.append(emptyNotice);
  }
  function matchArticle() {
    const key=approved?.post?.key;
    if (approved?.kind !== 'post' || !key) return null;
    const selector = approved.site === 'x' ? 'article[data-testid="tweet"]' : 'article';
    for (const article of document.querySelectorAll(selector)) {
      // X: the post's own timestamp link. A quoted post's card (a non-<a> role=link) has its own
      // time, which comes first on a post's page (live 2026-11), so skip times inside one.
      const own = approved.site === 'x' && [...article.querySelectorAll('time')].find(time => {
        const card = time.closest('[role="link"]:not(a)');
        return !(card && article.contains(card));
      });
      const links = approved.site === 'x' ? [own?.closest('a')].filter(Boolean) : [...article.querySelectorAll('a[href]')];
      // An edited post's timestamp links to its edit history (/status/<id>/history, live 2026-11).
      const postKey = href => P.post(href)?.key || P.post(href.replace(/(\/status\/[0-9]+)\/history\/?(?=[?#]|$)/, '$1'))?.key;
      if (links.some(a => postKey(a.href) === key)) return article;
    }
    return null;
  }
  function instagramNotificationPanel() {
    const dialog=document.querySelector('[role="dialog"]:not([aria-hidden="true"]):not([hidden])');
    if (dialog && !dialog.querySelector('main,nav,article')) return dialog;
    // Live Instagram (2026-11): heading → 460px panel → position:fixed container,
    // whose parent is the app shell holding main + nav. Take the highest bounded
    // ancestor below the shell. Width is read from CSS, not layout: while the
    // page is hidden, auto widths can't be measured.
    for (const heading of document.querySelectorAll('[role="heading"],h1,h2,h3,span')) {
      if (heading.textContent.trim() !== 'Notifications' || heading.closest('a,button')) continue;
      let node=heading.parentElement, best=null, bounded=false;
      while (node && node !== document.body) {
        if (node.matches('main,[role="main"],nav') || node.querySelector('main,[role="main"],nav,article,a[href="/explore/"],a[href="/direct/inbox/"],a[href="/reels/"]')) break;
        const style=getComputedStyle(node), width=style.width.endsWith('px') ? parseFloat(style.width) : NaN;
        if (style.position === 'fixed' || (width >= 240 && width <= 520)) bounded=true;
        if (bounded) best=node;
        node=node.parentElement;
      }
      if (best && best.textContent.trim().length > heading.textContent.trim().length) return best;
    }
    return null;
  }
  function instagramNotifications() {
    const panel=instagramNotificationPanel();
    if (panel) return panel;
    // Instagram's Notifications navigation is an href="#" panel toggle. A click
    // before the app hydrates does nothing, so retry a few times, spaced out;
    // checking for the panel first means an open panel is never toggled shut.
    const key=location.origin+location.pathname+location.search;
    if (notificationRequestKey !== key) { notificationRequestKey=key; notificationClicks=0; lastNotificationClick=0; }
    if (notificationClicks < 4 && Date.now()-lastNotificationClick >= 1500) {
      const link=[...document.querySelectorAll('a[href="#"]')].find(node => /^(Notifications)+$/i.test(node.textContent.trim()) || node.querySelector('svg[aria-label="Notifications"]'));
      if (link) {
        notificationClicks++; lastNotificationClick=Date.now();
        setTimeout(() => { if (approved?.panel) isolate(); }, 1600);
        link.click();
      }
    }
    return null;
  }
  /** The signed-in Instagram username: the session cookie's user id, looked up in the page's own data. */
  function instagramOwnUsername() {
    const id=(document.cookie.match(/(?:^|; )ds_user_id=(\d{1,25})(?:;|$)/) || [])[1];
    if (id) {
      // The exact id (not a longer one that starts with it), then that object's username.
      const pattern=new RegExp('"(?:id|pk|pk_id)":"?'+id+'(?!\\d)"?[^{}]{0,600}?"username":"([A-Za-z0-9_.]{1,30})"');
      for (const script of document.querySelectorAll('script:not([src])')) { const match=script.textContent.match(pattern); if (match) return match[1]; }
    }
    const link=[...document.querySelectorAll('a[href]')].find(a => /^\/[A-Za-z0-9_.]{1,30}\/$/.test(a.getAttribute('href')) && /^Profile$/i.test(a.textContent.trim()));
    return link ? link.getAttribute('href').slice(1, -1) : null;
  }
  /** Instagram's Saved is /<you>/saved/: from the start page, go there once "you" is known. */
  let savedRedirectFrom=null;
  function goToInstagramSaved() {
    if (savedRedirectFrom === location.href) return true;  // already on its way
    const user=instagramOwnUsername();
    if (!user) return false;
    const target=`${location.origin}/${user}/saved/`;
    if (P.view(target)?.kind !== 'saved') return false;
    savedRedirectFrom=location.href;
    // Tests replace this (jsdom can't navigate); the page itself can't reach this isolated world.
    (globalThis.SocialContentHooks?.replace ?? (url => location.replace(url)))(target);
    return true;
  }
  function instagramInboxShell() {
    // Mobile web (iOS app, 2026-11): no <main>. The inbox list is a role=navigation
    // column inside a <section> shell; a thread is the same shell with a message box.
    const anchor=document.querySelector('a[href^="/direct/t/"]') ||
      [...document.querySelectorAll('input')].find(input => /search/i.test(input.placeholder || input.getAttribute('aria-label') || '')) ||
      document.querySelector('[role="textbox"],textarea') ||
      [...document.querySelectorAll('h1')].find(h => /^(Messages|Chats)$/.test(h.textContent.trim()));
    const shell=anchor?.closest('section');
    return shell && !shell.querySelector('article,a[href="/explore/"],a[href="/reels/"]') ? shell : null;
  }
  function hideInstagramNotes(root) {
    for (const node of document.querySelectorAll('[data-sf-notes]')) node.removeAttribute('data-sf-notes');
    // Narrow scan: Instagram mutates constantly and open threads hold thousands of spans.
    for (const label of root.querySelectorAll('[role="presentation"] ul span')) {
      if (label.textContent.trim().toLowerCase() !== 'your note') continue;
      const list=label.closest('ul'), scroller=list?.closest('[role="presentation"]');
      if (!list || !scroller || !['auto','scroll'].includes(getComputedStyle(scroller).overflowX)) continue;
      // Live Instagram structure: notes UL inside horizontal presentation scroller,
      // beside a carousel arrow, inside one wrapper above Messages + thread list.
      let wrapper=scroller.parentElement;
      // The carousel's own wrapper holds only the scroller plus arrow controls.
      // If Instagram ever puts the scroller beside the Messages heading or the
      // thread list, hiding this wrapper would hide them too: leave it alone.
      if (!wrapper || [...wrapper.children].some(child => child !== scroller && (child.querySelector('a[href],input,[role="textbox"],[role="list"],ul,h1,h2,h3,[role="heading"]') || child.textContent.trim().length > 2))) continue;
      while (wrapper?.parentElement && wrapper.parentElement !== root && wrapper.parentElement.children.length === 1) wrapper=wrapper.parentElement;
      if (wrapper && !wrapper.querySelector('input,[role="textbox"],main,[role="main"]')) wrapper.setAttribute('data-sf-notes','');
    }
  }
  // Live x.com (2026-11): audience menu and emoji picker open in a HoverCard
  // layer that also holds cellInnerDiv rows; Grok/chat drawers and the bottom
  // bar share one layer. Keep popovers by allowlist, never drawers or tweets.
  const COMPOSER_POPOVER='[data-testid="HoverCard"],[data-testid="toast"],[data-testid="confirmationSheetDialog"],[role="menu"],[role="listbox"],[role="alertdialog"],[role="alert"],[role="dialog"]';
  const NEVER_OVERLAY='article[data-testid="tweet"],[data-testid="primaryColumn"],[data-testid="DMDrawer"],[data-testid="chat-drawer-root"],[data-testid="GrokDrawer"],[data-testid="BottomBar"]';
  // Pop-ups X opens from a post, profile, notifications etc.: the Repost/Quote and "…" menus,
  // confirmation sheets, toasts and hover cards. Never plain dialogs, drawers or timelines.
  const VIEW_POPOVER='[data-testid="HoverCard"],[data-testid="toast"],[data-testid="confirmationSheetDialog"],[role="menu"],[role="listbox"],[role="alertdialog"],[role="alert"]';
  function markComposerLayers(candidate) {
    // X renders menus, sheets and toasts as sibling layers in #layers. Keep the ones that
    // belong to what's on screen usable; never a timeline or drawer.
    for (const node of document.querySelectorAll('[data-sf-overlay]')) node.removeAttribute('data-sf-overlay');
    for (const node of document.querySelectorAll('[data-sf-layer-path]')) { node.removeAttribute('data-sf-layer-path'); node.removeAttribute('data-sf-path'); }
    const layers=document.getElementById('layers');
    if (!candidate || !layers || approved?.site !== 'x') return;
    if (approved.kind === 'compose') {
      if (!layers.contains(candidate)) return;
      for (const layer of layers.children) {
        if (layer.contains(candidate) || layer.querySelector(NEVER_OVERLAY)) continue;
        if (layer.matches(COMPOSER_POPOVER) || layer.querySelector(COMPOSER_POPOVER)) layer.setAttribute('data-sf-overlay','');
      }
      return;
    }
    if (layers.contains(candidate)) return;
    let shown=false;
    for (const layer of layers.children) {
      if (layer.querySelector(NEVER_OVERLAY)) continue;
      if (layer.matches(VIEW_POPOVER) || layer.querySelector(VIEW_POPOVER)) { layer.setAttribute('data-sf-overlay',''); shown=true; }
    }
    if (!shown) return;
    // Reveal #layers as a path (so its other layers stay hidden), marking what we add to undo it later.
    for (let node=layers; node && !node.hasAttribute('data-sf-path'); node=node.parentElement) { node.setAttribute('data-sf-path',''); node.setAttribute('data-sf-layer-path',''); }
  }
  // On a post, "Discover more" ends the replies: everything after it is recommendations.
  // On profiles and search, X inserts self-contained blocks (e.g. "Who to follow" with
  // follow cards, then "Show more") mid-timeline: hide the block, keep later tweets.
  const END_OF_THREAD=/^(Discover more|More posts)$/i;
  const RECOMMENDATION_BLOCK=/^(Who to follow|You might like|Discover more|More posts|Topics to follow|Creators for you)$/i;
  function trimRecommendations(column, kind) {
    // DOM order is stable across reflow; pixel cutoffs are not (reply expansion,
    // resizing, and display:none all change geometry). Recompute for recycled cells.
    let pastBoundary = false, inBlock = false;
    for (const cell of column.querySelectorAll('[data-testid="cellInnerDiv"]')) {
      const title = cell.querySelector('h2,h3,[role="heading"]')?.textContent.trim() || '';
      if (kind === 'post' && END_OF_THREAD.test(title)) pastBoundary = true;
      if (RECOMMENDATION_BLOCK.test(title)) inBlock = true;
      else if (cell.querySelector('article[data-testid="tweet"]')) inBlock = false;
      cell.toggleAttribute('data-sf-hidden', pastBoundary || inBlock);
    }
  }
  const SHADOW_STYLE=':host{all:initial}*{box-sizing:border-box;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}'+
    '.card{margin:24px 16px 48px;padding:22px;border:1px solid #c7d1c2;border-radius:14px;background:#f6f5ef;color:#193c33}'+
    'h2{font:400 26px Georgia,serif;margin:0 0 6px}p{margin:0 0 16px;font-size:14px;line-height:1.5;color:#62736a}'+
    '.row{display:flex;gap:8px;flex-wrap:wrap}button,a{font:600 14px Inter,-apple-system,sans-serif;border-radius:9px;padding:11px 14px;cursor:pointer;text-decoration:none}'+
    '.primary{background:#234e3d;color:#fffdf4;border:1px solid #234e3d}.quiet{background:transparent;color:#234e3d;border:1px solid #c7d1c2}[hidden]{display:none!important}'+
    '.pill{white-space:nowrap;max-width:calc(100vw - 24px);position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:2147483646;display:flex;gap:10px;align-items:center;padding:7px 8px 7px 14px;border-radius:999px;background:#234e3d;color:#fffdf4;font:600 13px Inter,-apple-system,sans-serif;box-shadow:0 4px 18px #0003}'+
    '.pill button{padding:5px 10px;font-size:12px;background:#fffdf4;color:#234e3d;border:0}'+
    ':host([data-theme="dark"]) .card{background:#131a17;color:#e3ebe3;border-color:#3a4a42}:host([data-theme="dark"]) p{color:#a3b2a8}'+
    ':host([data-theme="dark"]) .quiet{color:#cfe3d4;border-color:#3a4a42}:host([data-theme="dark"]) .primary{background:#8cc4a2;color:#10201a;border-color:#8cc4a2}';
  const clock=ts=>new Date(ts).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'});
  const mmss=ms=>{ const sec=Math.max(0,Math.ceil(ms/1000)); return `${Math.floor(sec/60)}:${String(sec%60).padStart(2,'0')}`; };
  function shadowBox(id) {
    const host=document.createElement('div'); host.id=id;
    const root=host.attachShadow({mode:'closed'}), style=document.createElement('style');
    style.textContent=SHADOW_STYLE; root.append(style);
    return {host, root};
  }
  function clearFeedUi() {
    feedPill?.host.remove(); feedPill=null;
  }
  async function feedRequest(message) {
    try { return await chrome.runtime.sendMessage({url:location.href, ...message}); } catch { return null; }
  }
  function feedTimerPill() {
    if (!feedPill) {
      const {host, root}=shadowBox('sf-feed-pill');
      const pill=document.createElement('div'); pill.className='pill';
      const label=document.createElement('span');
      const done=document.createElement('button'); done.textContent='Done';
      done.addEventListener('click', () => void feedRequest({type:'feedDone'}).finally(() => location.assign(chrome.runtime.getURL('blocked.html?site=x&ready=1'))));
      pill.append(label, done); root.append(pill);
      feedPill={host, label, remaining:feed.remainingMs};
    }
    if (!feedPill.host.isConnected) document.body?.append(feedPill.host);
    feedPill.label.textContent=`Scrolling unlocked · ${mmss(feedPill.remaining)} left`;
  }
  function isolateUnlocked(column) {
    trimRecommendations(column, 'feed');
    feedTimerPill();
  }
  // Capture window only: X's For You timeline data arrives from capture-main.js. The nonce is
  // in the URL fragment (never sent to X); read it at start, before X can tidy its URL.
  const CAPTURE_NONCE=(() => {
    const nonce=new URLSearchParams(location.hash.slice(1)).get('sf_capture');
    return nonce && /^[a-f0-9]{32}$/.test(nonce) ? nonce : null;
  })();
  addEventListener('message', event => {
    const nonce=CAPTURE_NONCE;
    if (event.source !== window || !nonce || captureSent || event.data?.sfCapture !== nonce || typeof event.data.body !== 'string') return;
    let tweets=[];
    try { tweets=globalThis.SocialTimeline.parseTimeline(JSON.parse(event.data.body)); } catch { return; }
    if (!tweets.length) return;
    captureSent=true;
    void feedRequest({type:'captured', nonce, tweets});
  });
  function isolateCapture() {
    // Stay invisible; make sure the For You timeline is the one X loads.
    const tabs=[...document.querySelectorAll('[data-testid="primaryColumn"] [role="tab"]')];
    const forYou=tabs.find(tab => /^for you$/i.test(tab.textContent.trim()));
    if (forYou && forYou.getAttribute('aria-selected') !== 'true' && !forYouClicked) { forYouClicked=true; forYou.click(); }
  }
  // Unlocked time counts while the feed is visible and in use (scroll, pointer or keys
  // in the last 15 s), whether or not the window has focus.
  let lastActivity=0, owedMs=0, tickInFlight=false;
  for (const type of ['wheel', 'scroll', 'pointermove', 'pointerdown', 'keydown', 'touchmove']) document.addEventListener(type, () => { lastActivity=Date.now(); }, {capture:true, passive:true});
  async function sendTick(url=location.href) {
    if (!owedMs || tickInFlight) return;
    const ms=Math.min(owedMs, 30000); owedMs-=ms; tickInFlight=true;
    const reply=await feedRequest({type:'feedTick', ms, url});
    tickInFlight=false;
    // Not delivered: keep the time owed (a refusal means the unlock already ended).
    if (!reply) { owedMs+=ms; return; }
    if (reply.error || !feed) return;
    feed={...feed, ...reply};
    if (feedPill) feedPill.remaining=reply.remainingMs;
    if (!reply.mode) void check(true);
  }
  setInterval(() => {
    if (approved?.kind !== 'feed' || approved.mode !== 'unlocked' || !feed) return;
    if (document.visibilityState === 'visible' && Date.now() - lastActivity < 15000) {
      owedMs+=1000;
      if (feedPill) feedPill.remaining=Math.max(0, feedPill.remaining - 1000);
    }
    if (feedPill) feedTimerPill();
    if (owedMs >= 5000) void sendTick();
  }, 1000);
  const flushFeed=() => { if (owedMs) void sendTick(); };
  addEventListener('pagehide', flushFeed);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushFeed(); });
  function isolate() {
    if (!approved) { hide(); return; }
    if (location.href !== lastUrl) { hide(); void check(); return; }
    // Work from a snapshot: activating a native control (Instagram's href="#"
    // Notifications link) can synchronously fire popstate, which re-enters
    // check() and clears `approved` while this call is still running.
    const view = approved;
    document.documentElement.setAttribute('data-sf-site', view.site);
    if (view.kind !== 'feed') clearFeedUi();
    if (view.kind === 'login') {
      // Sign-in and challenge pages (only the iOS app classifies these) show as-is.
      for (const node of document.querySelectorAll('[data-sf-path], [data-sf-target], [data-sf-overlay]')) { node.removeAttribute('data-sf-path'); node.removeAttribute('data-sf-target'); node.removeAttribute('data-sf-overlay'); }
      targetNode=null; missingSince=0; emptyNotice?.remove(); emptyNotice=null;
      document.documentElement.setAttribute('data-sf-view','login');
      document.documentElement.setAttribute('data-sf-ready','');
      return;
    }
    let candidate = null;
    if (view.kind === 'saved' && view.redirect) { if (goToInstagramSaved()) { hide(); return; } }
    else if (view.kind === 'notifications' && view.panel) candidate=instagramNotifications();
    else if (view.kind === 'compose') {
      // Home also contains tweetTextarea_0. Reveal only the composer dialog,
      // never the background timeline's inline editor or its enclosing main.
      // The topmost (last) layer wins, e.g. a composer opened over the photo viewer.
      const open=dialog=>dialog && dialog.getAttribute('aria-hidden') !== 'true' && !dialog.hidden;
      const editors=[...document.querySelectorAll('[data-testid="tweetTextarea_0"]')];
      candidate=editors.map(editor=>editor.closest('[role="dialog"]')).filter(open).at(-1) || null;
      // Composer sub-pages (drafts, schedule, GIF search) replace the editor with
      // their own dialog in the same modal (drafts may be a cellInnerDiv list);
      // never one that holds tweets or a timeline column.
      if (!candidate && view.subpage) candidate=[...document.querySelectorAll('[role="dialog"]')].filter(dialog=>open(dialog) && !dialog.querySelector('[role="dialog"],article[data-testid="tweet"],[data-testid="primaryColumn"]')).at(-1) || null;
    } else if (view.kind === 'messages') {
      // PIN/setup and new-conversation dialogs are part of the native inbox.
      candidate=document.querySelector('[role="dialog"]:not([aria-hidden="true"]):not([hidden])') || document.querySelector('main,[role="main"]') || (view.site === 'instagram' ? instagramInboxShell() : null);
    } else if (view.kind === 'profile' || view.kind === 'search' || view.kind === 'notifications' || view.kind === 'saved') {
      candidate = document.querySelector(view.site === 'x' ? '[data-testid="primaryColumn"]' : 'main');
    } else if (view.kind === 'capture') {
      isolateCapture();
      hide();
      return;
    } else if (view.kind === 'feed' && feed) {
      candidate = document.querySelector('[data-testid="primaryColumn"]');
      if (candidate) isolateUnlocked(candidate);
    } else if (view.kind === 'post') {
      const article = matchArticle();
      candidate = article;
      if (view.site === 'x') {
        const column = article?.closest('[data-testid="primaryColumn"]');
        if (column) { conversation = column; conversationKey = view.post.key; }
        // Preserve the verified conversation while the root post virtualizes away.
        candidate = conversation?.isConnected && conversationKey === view.post.key ? conversation : null;
        // A post X can't show, and no posts at all: show X's own notice rather than our
        // "not available" cover. A suspended or protected author's post is an article that
        // isn't a tweet; a deleted post is the column's "this page doesn't exist" error-detail
        // (live 2026-11).
        if (!candidate) {
          const only = document.querySelector('[data-testid="primaryColumn"]');
          if (only && !only.querySelector('article[data-testid="tweet"]')) candidate = only.querySelector('article:not([data-testid])') ? only : only.querySelector('[data-testid="error-detail"]');
        }
      }
    }
    if (approved !== view) return; // A newer check took over; it will isolate again.
    if (candidate && view.site === 'x' && ['post','profile','search','saved'].includes(view.kind)) trimRecommendations(candidate, view.kind);
    if (candidate && view.site === 'instagram' && view.kind === 'messages') hideInstagramNotes(candidate);
    document.documentElement.setAttribute('data-sf-view',view.kind);
    document.documentElement.toggleAttribute('data-sf-panel',!!view.panel);
    const pathIntact = candidate && (() => {
      let parent = candidate.parentElement;
      while (parent) { if (!parent.hasAttribute('data-sf-path')) return false; parent = parent.parentElement; }
      return true;
    })();
    if (candidate !== targetNode || !targetNode?.isConnected || !pathIntact) {
      hide();
      for (const node of document.querySelectorAll('[data-sf-path], [data-sf-target]')) { node.removeAttribute('data-sf-path'); node.removeAttribute('data-sf-target'); }
      targetNode = candidate;
      if (candidate) {
        candidate.setAttribute('data-sf-target','');
        let parent = candidate.parentElement;
        while (parent) { parent.setAttribute('data-sf-path',''); parent = parent.parentElement; }
      }
    }
    markComposerLayers(candidate);
    if (candidate) { missingSince=0; emptyNotice?.remove(); emptyNotice=null; }
    else {
      // Slow loads and post-submit transitions briefly have no target: stay
      // blank for a moment instead of flashing the "not available" notice.
      missingSince ||= Date.now();
      const wait=GRACE_MS-(Date.now()-missingSince);
      if (wait > 0 && !emptyNotice?.isConnected) {
        hide(); clearTimeout(missingTimer);
        missingTimer=setTimeout(() => { if (approved) isolate(); }, wait+10);
        return;
      }
      showUnavailable();
    }
    document.documentElement?.setAttribute('data-sf-ready','');
  }
  async function check() {
    if (checking) return;
    checking = true; hide(); approved = null;
    const url = location.href;
    // Leaving unlocked home in-page: report its owed time from its own URL first.
    if (url !== lastUrl && owedMs && feed) void sendTick(lastUrl);
    if (url !== lastUrl) {
      conversation = null; conversationKey = null; emptyNotice?.remove(); emptyNotice=null; missingSince=0; feed=null; clearFeedUi();
      // Only a different page re-arms the For You click (X may drop the #fragment from the same page).
      if (!lastUrl || new URL(url).pathname !== new URL(lastUrl).pathname) forYouClicked=false;
    }
    lastUrl = url;
    try {
      const reply = await chrome.runtime.sendMessage({type:'check', url});
      if (location.href !== url) return;
      // Home is never a destination, even if a worker reply ever claims otherwise.
      // The reply must also describe this exact URL (guards a worker reply that lags a pushState).
      // Feed (unlocked) and capture views are the worker's grant for X home in this tab only;
      // a start view (Instagram's Notifications panel or Saved) is its grant for Instagram home.
      const xGrant = reply?.view?.kind === 'feed' || reply?.view?.kind === 'capture';
      const startGrant = reply?.view?.start === true && reply.view.site === 'instagram' && ['notifications','saved'].includes(reply.view.kind);
      const expected = xGrant || startGrant ? 'home' : reply?.view?.kind;
      if (!reply?.allowed || !reply.view || reply.view.kind === 'home' || P.view(url)?.kind !== expected || P.view(url)?.site !== reply.view.site ||
          (xGrant && reply.view.site !== 'x') || (reply.view.kind === 'feed' && !reply.feed)) { feed=null; location.replace(chrome.runtime.getURL(`blocked.html?site=${P.site(url) || 'x'}`)); return; }
      approved = reply.view;
      feed = reply.view.kind === 'feed' ? {...reply.feed} : null;
    } catch { /* Extension reload or failure: stay hidden. */ }
    finally { checking = false; }
    isolate();
  }
  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) { hide(); void check(); }
    else if (approved) isolate();
  });
  observer.observe(document, {subtree:true, childList:true, characterData:true, attributes:true, attributeFilter:['href','data-testid','aria-hidden','aria-selected','hidden','role']});
  addEventListener('pageshow', () => void check());
  addEventListener('popstate', () => void check());
  setInterval(() => { if (location.href !== lastUrl) void check(); }, 200);
  chrome.runtime.onMessage.addListener(message => { if (message.type === 'recheck') void check(); });
  document.addEventListener('click', event => {
    const a = event.composedPath().find(node => node instanceof HTMLAnchorElement);
    if (!a || !P.social(a.href)) return;
    // Native panel triggers (notably Instagram Notifications) use href="#".
    if (a.getAttribute('href')?.startsWith('#')) return;
    // Deliberate destinations (threads, profiles, DMs, search tabs) navigate natively
    // in-page; the URL-change check isolates them. Only links into a feed are stopped
    // here, and loaded for real so the request rules send them to the intent page.
    const target=P.view(a.href);
    if (target && target.kind !== 'home') return;
    event.preventDefault(); event.stopImmediatePropagation(); hide();
    location.assign(a.href);
  }, true);
  void check();
})();
