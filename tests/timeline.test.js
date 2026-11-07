import {test} from 'node:test';
import assert from 'node:assert/strict';
import '../extension/timeline.js';
const T = globalThis.SocialTimeline;

// Synthetic data in the shape of X's GraphQL timelines (observed 2026-11):
// user name/handle under core.user_results.result.core, avatar under .avatar.image_url.
const user = (handle, name = handle) => ({user_results: {result: {__typename: 'User', core: {name, screen_name: handle}, avatar: {image_url: `https://pbs.twimg.com/profile_images/1/${handle}.jpg`}, is_blue_verified: true}}});
const tweet = (id, handle, text, extra = {}) => ({
  __typename: 'Tweet', rest_id: String(id), core: user(handle),
  legacy: {full_text: text, created_at: 'Sat Nov 07 10:00:00 +0000 2026', display_text_range: [0, [...text].length], entities: {urls: []}, ...extra.legacy},
  ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'legacy')),
});
const entry = (id, result) => ({entryId: `tweet-${id}`, content: {entryType: 'TimelineTimelineItem', itemContent: {itemType: 'TimelineTweet', tweet_results: {result}}}});
const home = entries => ({data: {home: {home_timeline_urt: {instructions: [{type: 'TimelineClearCache'}, {type: 'TimelineAddEntries', entries}]}}}});

test('parses home timeline tweets in order, skipping ads, cursors and modules', () => {
  const json = home([
    entry(1, tweet(1, 'alice', 'First')),
    {entryId: 'promoted-tweet-2', content: {itemContent: {itemType: 'TimelineTweet', promotedMetadata: {advertiser: {}}, tweet_results: {result: tweet(2, 'ad', 'Buy')}}}},
    {entryId: 'who-to-follow-3', content: {items: [{item: {itemContent: {itemType: 'TimelineUser', user_results: {}}}}]}},
    {entryId: 'home-conversation-4', content: {items: [{item: {itemContent: {tweet_results: {result: tweet(4, 'bob', 'Root')}}}}, {item: {itemContent: {tweet_results: {result: {__typename: 'TweetWithVisibilityResults', tweet: tweet(5, 'carol', 'Reply')}}}}}]}},
    entry(1, tweet(1, 'alice', 'Duplicate')),
    {entryId: 'cursor-bottom-9', content: {value: 'x'}},
  ]);
  const out = T.parseTimeline(json);
  assert.deepEqual(out.map(t => t.id), ['1', '4', '5']);
  assert.deepEqual(out[0].author, {name: 'alice', handle: 'alice', avatar: 'https://pbs.twimg.com/profile_images/1/alice.jpg', verified: true});
  assert.equal(out[0].url, 'https://x.com/alice/status/1');
  assert.equal(out[0].createdAt, Date.parse('2026-11-07T10:00:00Z'));
});

test('caps at 20 tweets', () => {
  const json = home(Array.from({length: 30}, (_, i) => entry(100 + i, tweet(100 + i, 'u' + i, 'x'))));
  assert.equal(T.parseTimeline(json).length, 20);
});

test('links: t.co replaced by real URLs, entities decoded, media and quote links removed', () => {
  const text = 'Read &amp; ship https://t.co/aaa now https://t.co/media https://t.co/quote';
  const out = T.parseTimeline(home([entry(1, tweet(1, 'alice', text, {
    legacy: {
      entities: {urls: [{url: 'https://t.co/aaa', expanded_url: 'https://vercel.com/blog/post', display_url: 'vercel.com/blog/post'}]},
      extended_entities: {media: [{url: 'https://t.co/media', type: 'photo', media_url_https: 'https://pbs.twimg.com/media/a.jpg'}]},
    },
    quoted_status_permalink: {url: 'https://t.co/quote'},
    quoted_status_result: {result: tweet(2, 'bob', 'Quoted')},
  }))]))[0];
  assert.deepEqual(out.segments, [{text: 'Read & ship '}, {text: 'vercel.com/blog/post', href: 'https://vercel.com/blog/post'}, {text: ' now'}]);
  assert.deepEqual(out.media, [{type: 'photo', src: 'https://pbs.twimg.com/media/a.jpg', href: 'https://x.com/alice/status/1', alt: '', sensitive: false}]);
});

test('replies drop the leading @mentions using X’s display range', () => {
  const text = '@bob @carol thanks 🙏 really';
  const out = T.parseTimeline(home([entry(1, tweet(1, 'alice', text, {legacy: {display_text_range: [11, [...text].length]}}))]))[0];
  assert.deepEqual(out.segments, [{text: 'thanks 🙏 really'}]);
});

test('long posts use the note text; link previews come from the card', () => {
  const out = T.parseTimeline(home([entry(1, tweet(1, 'alice', 'Short… https://t.co/card', {
    note_tweet: {note_tweet_results: {result: {text: 'The full long post https://t.co/card', entity_set: {urls: [{url: 'https://t.co/card', expanded_url: 'https://example.com/a', display_url: 'example.com/a'}]}}}},
    legacy: {entities: {urls: [{url: 'https://t.co/card', expanded_url: 'https://example.com/a', display_url: 'example.com/a'}]}},
    card: {legacy: {binding_values: [
      {key: 'title', value: {string_value: 'A great article', type: 'STRING'}},
      {key: 'description', value: {string_value: 'What it is about', type: 'STRING'}},
      {key: 'domain', value: {string_value: 'example.com', type: 'STRING'}},
      {key: 'card_url', value: {string_value: 'https://t.co/card', type: 'STRING'}},
      {key: 'summary_photo_image_large', value: {image_value: {url: 'https://pbs.twimg.com/card_img/1/a.jpg'}, type: 'IMAGE'}},
    ]}},
  }))]))[0];
  assert.equal(out.segments[0].text, 'The full long post ');
  assert.deepEqual(out.card, {title: 'A great article', description: 'What it is about', domain: 'example.com', image: 'https://pbs.twimg.com/card_img/1/a.jpg', href: 'https://example.com/a'});
});

test('retweets show the original with who retweeted; quotes are nested once', () => {
  const original = tweet(7, 'bob', 'Original', {quoted_status_result: {result: tweet(8, 'carol', 'Quoted', {quoted_status_result: {result: tweet(9, 'dan', 'Too deep')}})}});
  const rt = tweet(6, 'alice', 'RT @bob: Original', {legacy: {retweeted_status_result: {result: original}}});
  const out = T.parseTimeline(home([entry(6, rt)]))[0];
  assert.equal(out.id, '7'); assert.equal(out.retweetedBy, 'alice');
  assert.equal(out.quoted.id, '8'); assert.equal(out.quoted.url, 'https://x.com/carol/status/8');
  assert.equal(out.quoted.quoted, undefined);
});

test('videos and gifs are previews linking to the tweet; unsafe URLs never survive', () => {
  const out = T.parseTimeline(home([entry(1, tweet(1, 'alice', 'Clip', {legacy: {
    entities: {urls: [{url: 'https://t.co/js', expanded_url: 'javascript:alert(1)', display_url: 'click'}]},
    extended_entities: {media: [
      {type: 'video', media_url_https: 'https://pbs.twimg.com/ext_tw_video_thumb/1.jpg'},
      {type: 'animated_gif', media_url_https: 'https://pbs.twimg.com/tweet_video_thumb/2.jpg'},
      {type: 'photo', media_url_https: 'https://evil.example/tracker.png'},
    ]},
    full_text: 'Clip https://t.co/js',
    display_text_range: [0, 20],
  }}))]))[0];
  assert.deepEqual(out.media.map(m => m.type), ['video', 'gif']);
  // A javascript: target is never linked; the https t.co address is used instead.
  assert.deepEqual(out.segments.filter(s => s.href).map(s => s.href), ['https://t.co/js']);
  const bad = T.sanitizeTweets([
    {...out, author: {...out.author, avatar: 'https://evil.example/a.png'}, card: {title: 't', href: 'javascript:alert(1)'}, segments: [{text: 'x', href: 'http://plain.example'}]},
    {id: 'nope', author: {handle: 'alice'}},
    {id: '2', author: {handle: 'bad handle!'}},
  ]);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].author.avatar, null); assert.equal(bad[0].card, null); assert.deepEqual(bad[0].segments, [{text: 'x'}]);
  assert.equal(bad[0].url, 'https://x.com/alice/status/1');
});

test('works for other timeline wrappers (profile timelines use data.user.result.timeline)', () => {
  const json = {data: {user: {result: {timeline: {timeline: {instructions: [{type: 'TimelinePinEntry', entry: entry(3, tweet(3, 'vercel', 'Pinned'))}, {type: 'TimelineAddEntries', entries: [entry(4, tweet(4, 'vercel', 'Next'))]}]}}}}}};
  assert.deepEqual(T.parseTimeline(json).map(t => t.id), ['3', '4']);
});

test('entities are decoded before X’s display range is applied (nothing cut off the end)', () => {
  const raw = 'Tom &amp; Jerry &lt;3';
  const out = T.parseTimeline(home([entry(1, tweet(1, 'alice', raw, {legacy: {display_text_range: [0, 14]}}))]))[0];
  assert.deepEqual(out.segments, [{text: 'Tom & Jerry <3'}]);
});

test('conversation modules stay together as a thread, replies say who they answer', () => {
  const reply = tweet(5, 'carol', '@bob Agreed', {legacy: {in_reply_to_screen_name: 'bob', display_text_range: [5, 11]}});
  const json = home([{entryId: 'home-conversation-4', content: {items: [{item: {itemContent: {tweet_results: {result: tweet(4, 'bob', 'Root')}}}}, {item: {itemContent: {tweet_results: {result: reply}}}}]}}, entry(9, tweet(9, 'dan', 'Solo'))]);
  const out = T.parseTimeline(json);
  assert.deepEqual(out.map(t => [t.id, t.thread, t.replyTo]), [['4', 'home-conversation-4', null], ['5', 'home-conversation-4', 'bob'], ['9', undefined, null]]);
  assert.deepEqual(out[1].segments, [{text: 'Agreed'}]);
  const clean = T.sanitizeTweets(out);
  assert.equal(clean[1].thread, 'home-conversation-4'); assert.equal(clean[1].replyTo, 'bob'); assert.equal(clean[2].thread, null);
});

test('image alt text and sensitive flags are kept; an unavailable quote keeps its link', () => {
  const out = T.parseTimeline(home([entry(1, tweet(1, 'alice', 'Look https://t.co/m https://t.co/q', {
    legacy: {possibly_sensitive: true, display_text_range: [0, 34], extended_entities: {media: [{url: 'https://t.co/m', type: 'photo', media_url_https: 'https://pbs.twimg.com/media/a.jpg', ext_alt_text: 'A cat on a laptop'}]}, entities: {urls: [{url: 'https://t.co/q', expanded_url: 'https://x.com/bob/status/2', display_url: 'x.com/bob/status/2'}]}},
    quoted_status_permalink: {url: 'https://t.co/q'},
    quoted_status_result: {result: {__typename: 'TweetTombstone'}},
  }))]))[0];
  assert.deepEqual(out.media[0], {type: 'photo', src: 'https://pbs.twimg.com/media/a.jpg', href: 'https://x.com/alice/status/1', alt: 'A cat on a laptop', sensitive: true});
  assert.equal(out.quoted, null);
  assert.deepEqual(out.segments.at(-1), {text: 'x.com/bob/status/2', href: 'https://x.com/bob/status/2'});
});

test('X’s created_at is parsed by hand (engines differ), with its offset', () => {
  const t = id => T.parseTimeline(home([entry(id, tweet(id, 'a', 'x', {legacy: {created_at: id === 1 ? 'Sat Nov 07 10:00:00 +0000 2026' : 'Sat Nov 07 10:00:00 +0900 2026'}}))]))[0].createdAt;
  assert.equal(t(1), Date.UTC(2026, 10, 7, 10)); assert.equal(t(2), Date.UTC(2026, 10, 7, 1));
});
