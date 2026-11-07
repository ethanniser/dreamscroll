// The For You batch: a stored snapshot of 10 tweets, rendered here instead of on X.
// One at a time: swipe left (read) or right (open on X, single-tweet view with replies).
// Built with Base UI components; bundled to extension/feed-page.js (bun run build:ui).
import {Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Avatar} from '@base-ui/react/avatar';
import {Button} from '@base-ui/react/button';
import {Collapsible} from '@base-ui/react/collapsible';
import {clock, request} from './shared.js';
import {Mark} from './Mark.jsx';

export function ago(ts, now = Date.now()) {
  if (!ts) return '';
  const minutes = Math.round((now - ts) / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)}h`;
  return new Date(ts).toLocaleDateString([], {month:'short', day:'numeric'});
}
const External = ({href, className, children}) => <a href={href} className={className} target="_blank" rel="noopener noreferrer">{children}</a>;
const Img = ({src, className, alt = ''}) => <img src={src} className={className} alt={alt} loading="lazy" referrerPolicy="no-referrer" />;

/** Text with real links, and @handles (not the middle of an email address) linking to profiles on X. */
function Text({segments, className}) {
  return (
    <p className={className}>
      {segments.map((segment, i) => segment.href
        ? <External key={i} href={segment.href} className="inline-link">{segment.text}</External>
        : <Fragment key={i}>{segment.text.split(/((?<![A-Za-z0-9_.])@[A-Za-z0-9_]{1,15}\b)/).map((part, j) =>
            /^@[A-Za-z0-9_]{1,15}$/.test(part) ? <a key={j} href={`https://x.com/${part.slice(1)}`} className="inline-link">{part}</a> : part)}</Fragment>)}
    </p>
  );
}
function Byline({author, createdAt, url, small = false}) {
  return (
    <div className={small ? 'byline small' : 'byline'}>
      {!small && (
        <Avatar.Root className="avatar">
          {author.avatar && <Avatar.Image src={author.avatar} alt="" referrerPolicy="no-referrer" className="avatar-img" />}
          <Avatar.Fallback className="avatar-fallback">{(author.name || author.handle).slice(0, 1).toUpperCase()}</Avatar.Fallback>
        </Avatar.Root>
      )}
      <div className="who">
        <span className="name">{author.name || author.handle}{author.verified && <span className="verified">✓</span>}</span>
        <span className="handle">@{author.handle}</span>
        {createdAt ? <>
          <span className="handle">·</span>
          {/* The timestamp is the tweet's real permalink (the card click is a convenience). */}
          <a href={url} className="time" title={new Date(createdAt).toLocaleString()}>{ago(createdAt)}</a>
        </> : null}
      </div>
    </div>
  );
}
function MediaGrid({media}) {
  return (
    <div className={`media media-${Math.min(media.length, 4)}`}>
      {media.map((item, i) => (
        <div key={i} className={item.sensitive ? 'media-item sensitive' : 'media-item'}>
          <Img src={item.src} className="media-img" alt={item.alt || ''} />
          {item.sensitive && <span className="sensitive-label">Sensitive media · open on X</span>}
          {item.type !== 'photo' && <span className="play">{item.type === 'gif' ? 'GIF' : '▶'}</span>}
        </div>
      ))}
    </div>
  );
}
function Preview({card}) {
  return (
    <External href={card.href} className="card">
      {card.image && <Img src={card.image} className="card-img" />}
      <div className="card-body">
        {card.domain && <span className="card-domain">{card.domain}</span>}
        <span className="card-title">{card.title}</span>
        {card.description && <span className="card-desc">{card.description}</span>}
      </div>
    </External>
  );
}
/** Leaves for X in this tab (replaceable, for tests: jsdom can't navigate). */
const go = url => (globalThis.SocialFeedPage?.navigate ?? (u => location.assign(u)))(url);
/** Opens a tweet on X: same tab, or a new one with Cmd/Ctrl. Not from a link, or while selecting text. */
function open(url, event) {
  if (event.target.closest('a') || String(getSelection?.() ?? '')) return;
  if (event.metaKey || event.ctrlKey) window.open(url, '_blank', 'noopener');
  else go(url);
}
function Tweet({tweet}) {
  const {quoted} = tweet;
  return (
    <article className="tweet" onClick={event => open(tweet.url, event)}>
      {tweet.retweetedBy && <div className="reposted">↻ {tweet.retweetedBy} reposted</div>}
      <Byline author={tweet.author} createdAt={tweet.createdAt} url={tweet.url} />
      {tweet.replyTo && <div className="replying">Replying to @{tweet.replyTo}</div>}
      {tweet.segments.length > 0 && <Text segments={tweet.segments} className="text" />}
      {tweet.media.length > 0 && <MediaGrid media={tweet.media} />}
      {tweet.card && !tweet.media.length && <Preview card={tweet.card} />}
      {quoted && (
        // A box, not a link: it contains links of its own.
        <div className="quoted" onClick={event => { event.stopPropagation(); open(quoted.url, event); }}>
          <Byline author={quoted.author} createdAt={quoted.createdAt} url={quoted.url} small />
          {quoted.segments.length > 0 && <Text segments={quoted.segments} className="quoted-text" />}
          {quoted.media[0] && <Img src={quoted.media[0].src} className="quoted-img" alt={quoted.media[0].alt || ''} />}
        </div>
      )}
    </article>
  );
}
/** One list item per tweet, or per conversation (root and replies together). */
export function group(tweets) {
  const entries = [];
  for (const tweet of tweets) {
    const last = entries.at(-1);
    if (tweet.thread && last?.thread === tweet.thread) last.tweets.push(tweet);
    else entries.push({thread:tweet.thread, tweets:[tweet]});
  }
  return entries;
}

function NewBatch({onError}) {
  const [fetching, setFetching] = useState(false);
  return (
    <Button id="feed-action" className="quiet" disabled={fetching} onClick={async () => {
      setFetching(true);
      try { await request({type:'feed'}); } catch (error) { onError(error); setFetching(false); }
    }}>{fetching ? 'Fetching…' : 'Get new batch'}</Button>
  );
}

const SWIPE = 100;  // px past which a released drag counts as a swipe
const entryKey = entry => entry.tweets[0].id;
/** The tweet a swipe right opens: the last of a conversation (X shows its parents above it). */
const entryURL = entry => entry.tweets.at(-1).url;
const EntryTweets = ({entry}) => entry.tweets.map(tweet => <Tweet key={tweet.id} tweet={tweet} />);

/**
 * One tweet (or conversation) at a time. Left: read, next. Right: open it on X; it stays
 * here, unread, for when you come back. Drag or swipe, the buttons, or the arrow keys.
 */
function Deck({entries, onRead, onUndo, canUndo}) {
  const [current, next] = entries;
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const gesture = useRef(null), moved = useRef(false), leaving = useRef(false);

  const swipe = useCallback(direction => {
    if (!current || leaving.current) return;
    leaving.current = true;
    setDragging(false);
    if (direction === 'left') {
      setDx(-Math.max(window.innerWidth, 600));
      // `leaving` stays set until the next card is on screen (see the layout effect below).
      setTimeout(() => { onRead(current); setDx(0); }, 200);
    } else {
      // Nudge toward the right, then open it; the card is back in place on return.
      setDx(Math.min(window.innerWidth / 3, 160));
      setTimeout(() => { setDx(0); leaving.current = false; go(entryURL(current)); }, 160);
    }
  }, [current, onRead]);

  // Keys always act on the card on screen: `keys` is refreshed, and a finished swipe
  // released, only once a new top card has been committed.
  const keys = useRef(null);
  const currentKey = current ? entryKey(current) : null;
  useLayoutEffect(() => { keys.current = {swipe, onUndo, canUndo}; });
  useLayoutEffect(() => { leaving.current = false; setDx(0); }, [currentKey]);
  useEffect(() => {
    const onKey = event => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const {swipe, onUndo, canUndo} = keys.current;
      if (event.key === 'ArrowLeft') { event.preventDefault(); swipe('left'); }
      else if (event.key === 'ArrowRight') { event.preventDefault(); swipe('right'); }
      else if ((event.key === 'u' || event.key === 'U') && canUndo) onUndo();
    };
    // Back from X (bfcache): the card is in place, ready to be marked read.
    const onShow = () => { setDx(0); setDragging(false); leaving.current = false; };
    addEventListener('keydown', onKey);
    addEventListener('pageshow', onShow);
    return () => { removeEventListener('keydown', onKey); removeEventListener('pageshow', onShow); };
  }, []);

  if (!current) return null;
  const pointer = {
    onPointerDown(event) {
      // One finger at a time: a second pointer doesn't take over (or strand) a drag.
      if (event.button !== 0 || leaving.current || gesture.current) return;
      gesture.current = {id:event.pointerId, x:event.clientX, y:event.clientY, lastX:event.clientX, lastT:event.timeStamp, v:0, active:false};
      moved.current = false;
    },
    onPointerMove(event) {
      const g = gesture.current;
      if (!g || event.pointerId !== g.id) return;
      const ddx = event.clientX - g.x, ddy = event.clientY - g.y;
      if (!g.active) {
        // Horizontal drags swipe; vertical ones scroll the card.
        if (Math.abs(ddy) > 10 && Math.abs(ddy) > Math.abs(ddx)) { gesture.current = null; return; }
        if (Math.abs(ddx) < 8) return;
        g.active = true; moved.current = true; setDragging(true);
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }
      const dt = event.timeStamp - g.lastT;
      if (dt > 0) g.v = (event.clientX - g.lastX) / dt;
      g.lastX = event.clientX; g.lastT = event.timeStamp;
      setDx(ddx);
    },
    onPointerUp(event) {
      const g = gesture.current;
      if (!g || event.pointerId !== g.id) return;
      gesture.current = null;
      if (!g.active) return;
      const ddx = event.clientX - g.x;
      if (ddx < -SWIPE || (g.v < -0.6 && ddx < -30)) swipe('left');
      else if (ddx > SWIPE || (g.v > 0.6 && ddx > 30)) swipe('right');
      else { setDragging(false); setDx(0); }
    },
    onPointerCancel(event) {
      if (gesture.current && event.pointerId !== gesture.current.id) return;
      gesture.current = null; setDragging(false); setDx(0);
    },
    // A drag isn't a tap: don't open the tweet (or a link) when it ends.
    onClickCapture(event) { if (moved.current) { event.preventDefault(); event.stopPropagation(); moved.current = false; } },
    onDragStart(event) { event.preventDefault(); },
  };
  const progress = Math.min(Math.abs(dx) / SWIPE, 1);
  return (
    <section id="deck" className="deck" aria-label="Your For You batch">
      <div className="deck-stack">
        {next && (
          <div className="deck-slot under" aria-hidden="true" style={{transform:`scale(${0.96 + 0.04 * progress}) translateY(${10 * (1 - progress)}px)`, opacity:0.5 + 0.5 * progress, '--reveal':progress}}>
            <div className={next.tweets.length > 1 ? 'deck-card thread' : 'deck-card'}><EntryTweets entry={next} /></div>
          </div>
        )}
        <div key={entryKey(current)} className={dragging ? 'deck-slot top dragging' : 'deck-slot top'} {...pointer}
          style={{transform:`translateX(${dx}px) rotate(${dx / 24}deg)`}}>
          <div className={current.tweets.length > 1 ? 'deck-card thread' : 'deck-card'}><EntryTweets entry={current} /></div>
          <span className="hint hint-read" style={{opacity:dx < 0 ? progress : 0}}>Read</span>
          <span className="hint hint-open" style={{opacity:dx > 0 ? progress : 0}}>Open</span>
        </div>
      </div>
      <div className="deck-actions">
        <Button id="read-button" className="swipe-button" onClick={() => swipe('left')}><span aria-hidden="true">←</span> Read</Button>
        <Button id="open-button" className="swipe-button" onClick={() => swipe('right')}>Open <span aria-hidden="true">→</span></Button>
      </div>
      <p className="deck-help">
        {canUndo && <Button id="undo-button" className="quiet" onClick={onUndo}>Undo</Button>}
        <span className="keys">← → keys</span>
      </p>
    </section>
  );
}

/** Tweets already swiped away, to read through again. */
function ReadList({entries, onUnread}) {
  if (!entries.length) return null;
  return (
    <Collapsible.Root className="read">
      <Collapsible.Trigger className="read-trigger">Read · {entries.length}</Collapsible.Trigger>
      <Collapsible.Panel keepMounted className="read-panel">
        <ol id="read-list" className="tweets" aria-label="Read tweets">
          {entries.map(entry => (
            <li key={entryKey(entry)} className={entry.tweets.length > 1 ? 'entry thread' : 'entry'}>
              <EntryTweets entry={entry} />
              <Button className="quiet put-back" onClick={() => onUnread(entry)}>Put back</Button>
            </li>
          ))}
        </ol>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function FeedPage() {
  const [state, setState] = useState(null);
  const [read, setRead] = useState(() => new Set());
  const [history, setHistory] = useState([]);  // entries read this visit, for Undo
  const [error, setError] = useState('');
  const endsAt = useRef(null);
  const load = useCallback(async () => {
    setError('');
    try {
      const next = await request({type:'snapshot'});
      endsAt.current = next.active ? next.endsAt : null;
      setState(next);
      setRead(new Set(Array.isArray(next.read) ? next.read : []));
    } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => {
    void load();
    // Once the window has passed, show the ended state instead of a stale time
    // (retried every 30 s until a load succeeds; a successful load updates endsAt).
    const timer = setInterval(() => { if (endsAt.current && Date.now() >= endsAt.current) void load(); }, 30000);
    return () => clearInterval(timer);
  }, [load]);

  const mark = useCallback((entry, isRead) => {
    const ids = entry.tweets.map(t => t.id);
    setRead(previous => { const next = new Set(previous); for (const id of ids) isRead ? next.add(id) : next.delete(id); return next; });
    request({type:'feedRead', ids, read:isRead}).catch(e => setError(e.message));
  }, []);
  const onRead = useCallback(entry => { mark(entry, true); setHistory(h => [...h, entry]); }, [mark]);
  // Entries are rebuilt every render, so compare them by key.
  const onUnread = useCallback(entry => { mark(entry, false); setHistory(h => h.filter(e => entryKey(e) !== entryKey(entry))); }, [mark]);
  const onUndo = useCallback(() => { const last = history.at(-1); if (last) onUnread(last); }, [history, onUnread]);

  const tweets = state ? globalThis.SocialTimeline.sanitizeTweets(state.tweets) : [];
  const entries = group(tweets);
  const isRead = entry => entry.tweets.every(t => read.has(t.id));
  const unread = entries.filter(e => !isRead(e)), done = entries.filter(isRead);
  const live = state?.active && tweets.length > 0;
  return (
    <main className="feed">
      <header className="feed-header">
        <a className="brand" href="blocked.html?site=x"><Mark />Dreamscroll</a>
        <span id="feed-meta" className="feed-meta">{live ? `${unread.length ? `${unread.length} left · ` : ''}until ${clock(state.endsAt)}` : ''}</span>
      </header>
      {live && <Deck entries={unread} onRead={onRead} onUndo={onUndo} canUndo={history.length > 0} />}
      {state && (!live || !unread.length) && (
        <footer id="feed-end" className="feed-end">
          {live ? <>
            <p id="feed-end-text">All read · next batch at {clock(state.endsAt)}</p>
            {history.length > 0 && <Button id="undo-button" className="quiet" onClick={onUndo}>Undo</Button>}
          </> : <>
            <p id="feed-end-text">This batch has ended.</p>
            <NewBatch onError={e => setError(e.message)} />
          </>}
        </footer>
      )}
      {error && <p id="message" role="alert">{error}</p>}
      {live && <ReadList entries={done} onUnread={onUnread} />}
    </main>
  );
}

globalThis.SocialFeedPage = {ago, group, navigate:null};
createRoot(document.getElementById('root')).render(<FeedPage />);
