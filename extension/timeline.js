// Turns X's own timeline data (the GraphQL response its web app downloads) into a
// small, safe tweet model for the Dreamscroll feed page. Pure: used by the
// content script, the worker, the feed page, and the iPhone app's page.
(() => {
  const MAX_TWEETS = 20;
  const IMAGE = /^https:\/\/(?:pbs|abs|video)\.twimg\.com\//;
  const TWEET_ID = /^[0-9]{1,25}$/;
  const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
  const str = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
  const https = value => {
    try { const url = new URL(value); return url.protocol === 'https:' ? url.href : null; } catch { return null; }
  };
  const image = value => (typeof value === 'string' && IMAGE.test(value) ? value : null);
  const decode = text => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

  function unwrap(result) {
    if (!result || typeof result !== 'object') return null;
    if (result.__typename === 'TweetWithVisibilityResults') return unwrap(result.tweet);
    return result.legacy && result.rest_id ? result : null;
  }
  function author(tweet) {
    const user = tweet.core?.user_results?.result || {};
    return {
      name: str(user.core?.name ?? user.legacy?.name, 80),
      handle: str(user.core?.screen_name ?? user.legacy?.screen_name, 15),
      avatar: image(user.avatar?.image_url ?? user.legacy?.profile_image_url_https),
      verified: !!user.is_blue_verified,
    };
  }
  /** Text as segments: plain text and links (t.co replaced by the real URL). */
  function segments(tweet) {
    const note = tweet.note_tweet?.note_tweet_results?.result;
    // X's display_text_range counts code points of the *unescaped* text: decode first.
    let text = decode(String(note?.text ?? tweet.legacy.full_text ?? ''));
    // Replies: the range drops the leading @mentions (shown as "Replying to" instead).
    const range = tweet.legacy.display_text_range;
    if (!note && Array.isArray(range) && range.length === 2) text = [...text].slice(range[0], range[1]).join('');
    const urls = (note?.entity_set?.urls ?? tweet.legacy.entities?.urls ?? []).filter(u => typeof u?.url === 'string');
    // Media and quote permalinks are shown as previews, not as links in the text.
    for (const m of tweet.legacy.extended_entities?.media ?? tweet.legacy.entities?.media ?? []) if (typeof m?.url === 'string') text = text.split(m.url).join('');
    const quoteLink = tweet.quoted_status_permalink?.url;
    if (typeof quoteLink === 'string' && unwrap(tweet.quoted_status_result?.result)) text = text.split(quoteLink).join('');
    const out = [];
    let rest = text.trim();
    while (rest) {
      let next = null;
      for (const u of urls) {
        const i = rest.indexOf(u.url);
        if (i !== -1 && (!next || i < next.i)) next = {i, u};
      }
      if (!next) { out.push({text: rest}); break; }
      if (next.i) out.push({text: rest.slice(0, next.i)});
      const href = https(next.u.expanded_url) || https(next.u.url);
      out.push(href ? {text: str(next.u.display_url || href, 120), href} : {text: next.u.url});
      rest = rest.slice(next.i + next.u.url.length);
    }
    return out.slice(0, 60);
  }
  function media(tweet, url) {
    const sensitive = !!tweet.legacy.possibly_sensitive;
    return (tweet.legacy.extended_entities?.media ?? []).slice(0, 4).map(m => ({
      type: m.type === 'video' ? 'video' : m.type === 'animated_gif' ? 'gif' : 'photo',
      src: image(m.media_url_https),
      href: url,
      alt: str(m.ext_alt_text, 1000),
      sensitive: sensitive || !!m.sensitive_media_warning,
    })).filter(m => m.src);
  }
  function card(tweet) {
    const values = Object.fromEntries((tweet.card?.legacy?.binding_values ?? []).filter(b => b && typeof b.key === 'string').map(b => [b.key, b.value]));
    const title = str(values.title?.string_value, 200);
    const cardUrl = values.card_url?.string_value;
    if (!title || typeof cardUrl !== 'string') return null;
    const entity = (tweet.legacy.entities?.urls ?? []).find(u => u?.url === cardUrl);
    const href = https(entity?.expanded_url ?? cardUrl);
    if (!href) return null;
    const pick = ['summary_photo_image_large', 'thumbnail_image_large', 'photo_image_full_size_large', 'summary_photo_image', 'thumbnail_image', 'player_image_large', 'player_image'];
    const img = pick.map(k => image(values[k]?.image_value?.url)).find(Boolean) || null;
    let domain = str(values.domain?.string_value || values.vanity_url?.string_value, 80);
    if (!domain) { try { domain = new URL(href).hostname.replace(/^www\./, ''); } catch {} }
    return {title, description: str(values.description?.string_value, 300), domain, image: img, href};
  }
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function parseDate(value) {
    const m = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) (\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2}) (\d{4})$/.exec(String(value));
    if (!m || !MONTHS.includes(m[1])) return null;
    const offset = (m[6] === '-' ? -1 : 1) * (Number(m[7]) * 60 + Number(m[8])) * 60000;
    return Date.UTC(Number(m[9]), MONTHS.indexOf(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])) - offset;
  }
  function toTweet(raw, depth = 0) {
    let tweet = unwrap(raw);
    if (!tweet) return null;
    let retweetedBy = null;
    const inner = unwrap(tweet.legacy.retweeted_status_result?.result);
    if (inner && depth === 0) { retweetedBy = author(tweet).name || author(tweet).handle; tweet = inner; }
    const id = tweet.rest_id, who = author(tweet);
    if (!TWEET_ID.test(id) || !HANDLE.test(who.handle)) return null;
    const url = `https://x.com/${who.handle}/status/${id}`;
    const created = parseDate(tweet.legacy.created_at);
    const quotedTweet = depth === 0 ? toTweet(tweet.quoted_status_result?.result, 1) : null;
    return {
      id, url, author: who,
      createdAt: Number.isFinite(created) ? created : null,
      retweetedBy,
      replyTo: HANDLE.test(tweet.legacy.in_reply_to_screen_name || '') ? tweet.legacy.in_reply_to_screen_name : null,
      segments: segments(tweet),
      media: media(tweet, url),
      card: card(tweet),
      quoted: quotedTweet && {id: quotedTweet.id, url: quotedTweet.url, author: quotedTweet.author, createdAt: quotedTweet.createdAt, segments: quotedTweet.segments.slice(0, 20), media: quotedTweet.media.slice(0, 1)},
    };
  }
  /** Tweets in timeline order from any GraphQL timeline response; ads and modules skipped. */
  function parseTimeline(json, max = MAX_TWEETS) {
    const instructions = [];
    (function find(node, depth) {
      if (!node || typeof node !== 'object' || depth > 12) return;
      if (Array.isArray(node.instructions)) { instructions.push(...node.instructions); return; }
      for (const value of Object.values(node)) find(value, depth + 1);
    })(json, 0);
    const tweets = [], seen = new Set();
    for (const instruction of instructions) {
      const entries = instruction?.entries ?? (instruction?.entry ? [instruction.entry] : []);
      for (const entry of entries) {
        const content = entry?.content;
        const items = content?.itemContent ? [content.itemContent] : (content?.items ?? []).map(i => i?.item?.itemContent);
        // A conversation module (root + replies) stays together as one thread.
        const thread = items.length > 1 && typeof entry.entryId === 'string' ? entry.entryId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60) : null;
        for (const item of items) {
          if (!item || item.promotedMetadata || !item.tweet_results) continue;
          const tweet = toTweet(item.tweet_results.result);
          if (tweet && thread) tweet.thread = thread;
          if (tweet && !seen.has(tweet.id)) { seen.add(tweet.id); tweets.push(tweet); }
          if (tweets.length >= max) return tweets;
        }
      }
    }
    return tweets;
  }
  /** Re-validates a stored or synced tweet before it is rendered. */
  function sanitizeTweet(t, depth = 0) {
    if (!t || typeof t !== 'object' || !TWEET_ID.test(t.id) || !HANDLE.test(t.author?.handle)) return null;
    const url = `https://x.com/${t.author.handle}/status/${t.id}`;
    const segs = (Array.isArray(t.segments) ? t.segments : []).slice(0, 60).map(s => {
      const text = str(s?.text, 25000);
      const href = s?.href ? https(s.href) : null;
      return href ? {text, href} : {text};
    }).filter(s => s.text);
    const c = t.card && typeof t.card === 'object' && https(t.card.href) ? {title: str(t.card.title, 200), description: str(t.card.description, 300), domain: str(t.card.domain, 80), image: image(t.card.image), href: https(t.card.href)} : null;
    return {
      id: t.id, url,
      author: {name: str(t.author.name, 80), handle: t.author.handle, avatar: image(t.author.avatar), verified: !!t.author.verified},
      createdAt: Number.isFinite(t.createdAt) ? t.createdAt : null,
      retweetedBy: t.retweetedBy ? str(t.retweetedBy, 80) : null,
      replyTo: HANDLE.test(t.replyTo || '') ? t.replyTo : null,
      thread: typeof t.thread === 'string' && /^[A-Za-z0-9_-]{1,60}$/.test(t.thread) ? t.thread : null,
      segments: segs,
      media: (Array.isArray(t.media) ? t.media : []).slice(0, 4).map(m => ({type: ['photo', 'video', 'gif'].includes(m?.type) ? m.type : 'photo', src: image(m?.src), href: url, alt: str(m?.alt, 1000), sensitive: !!m?.sensitive})).filter(m => m.src),
      card: c && c.title ? c : null,
      quoted: depth === 0 && t.quoted ? sanitizeTweet(t.quoted, 1) : null,
    };
  }
  const sanitizeTweets = list => (Array.isArray(list) ? list : []).slice(0, MAX_TWEETS).map(t => sanitizeTweet(t)).filter(Boolean);
  globalThis.SocialTimeline = {MAX_TWEETS, parseTimeline, sanitizeTweet, sanitizeTweets};
})();
