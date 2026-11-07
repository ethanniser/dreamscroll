// Made-up tweets and state for README screenshots (no real accounts or posts).
const minutes = m => Date.now() - m * 60_000;

export function demoTweets() {
  return [
    {id:'1001', author:{name:'Mara Okafor', handle:'mara_demo', verified:true}, createdAt:minutes(42),
      segments:[{text:'Shipped the offline mode today. The trick was treating the network as an optimization, not a requirement. Write-up: '}, {text:'example.com/offline-first', href:'https://example.com/offline-first'}]},
    {id:'1002', author:{name:'Tidepool', handle:'tidepool_demo'}, createdAt:minutes(95),
      segments:[{text:'Small habit that changed my week: one batch of reading in the morning, then nothing until lunch.'}],
      card:{title:'The case for batching your inputs', description:'Why checking less often leaves more room for deep work.', domain:'example.com', href:'https://example.com/batching'}},
    {id:'1003', thread:'demo-thread-1', author:{name:'Jonas Weber', handle:'jonas_demo'}, createdAt:minutes(130),
      segments:[{text:'Hot take: most dashboards should be a single sentence.'}]},
    {id:'1004', thread:'demo-thread-1', replyTo:'jonas_demo', author:{name:'Priya Raman', handle:'priya_demo', verified:true}, createdAt:minutes(118),
      segments:[{text:'@jonas_demo "Everything is fine, nothing needs you" is the best dashboard.'}]},
    {id:'1005', retweetedBy:'Tidepool', author:{name:'Lena Park', handle:'lena_demo'}, createdAt:minutes(200),
      segments:[{text:'Reminder that a walk is a perfectly good debugging tool.'}]},
    {id:'1006', author:{name:'Sam Rivera', handle:'sam_demo'}, createdAt:minutes(260),
      segments:[{text:'This is the right framing:'}],
      quoted:{id:'1007', author:{name:'Mara Okafor', handle:'mara_demo'}, createdAt:minutes(600),
        segments:[{text:'Your attention is the product. Spend it on purpose.'}]}},
    {id:'1008', author:{name:'Field Notes', handle:'notes_demo'}, createdAt:minutes(320),
      segments:[{text:'New essay on building tools that respect your time. Feedback welcome '}, {text:'@priya_demo'}],
      card:{title:'Tools that let you leave', description:'Software that finishes the job and gets out of the way.', domain:'example.com', href:'https://example.com/leave'}},
    {id:'1009', author:{name:'Ada Byte', handle:'ada_demo'}, createdAt:minutes(410),
      segments:[{text:'Twenty good posts beat two hundred mediocre ones. Fight me.'}]},
  ];
}

export function demoState() {
  const now = Date.now();
  return {
    startedAt: now - 28 * 60_000,
    endsAt: now + 92 * 60_000,
    remainingMs: 900_000,
    tweets: demoTweets(),
  };
}

/** A sync link with a placeholder token (never a real one). */
export const DEMO_SYNC_LINK = `dreamscroll://sync?endpoint=${encodeURIComponent('https://your-sync-server.example')}&token=${'0'.repeat(64)}`;
