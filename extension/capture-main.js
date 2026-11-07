// Runs in X's own page world, only in the hidden capture tab (x.com/home#sf_capture=…).
// The marker is in the URL fragment, which browsers never send to X's servers.
// Passes the For You timeline data X's web app downloads to the content script,
// which parses the batch's tweets. Nothing is changed or sent anywhere else.
(() => {
  const nonce = new URLSearchParams(location.hash.slice(1)).get('sf_capture');
  if (!nonce || !/^[a-f0-9]{32}$/.test(nonce)) return;
  // For You is "HomeTimeline"; Following is "HomeLatestTimeline" and is ignored.
  const isForYou = url => /\/graphql\/[^/]+\/HomeTimeline(?:[?#]|$)/.test(String(url));
  const forward = body => {
    if (typeof body === 'string' && body.includes('tweet_results')) window.postMessage({sfCapture: nonce, body}, location.origin);
  };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (isForYou(url)) this.addEventListener('load', () => {
      try { forward(this.responseType === 'json' ? JSON.stringify(this.response) : this.responseText); } catch {}
    });
    return open.apply(this, arguments);
  };
  const nativeFetch = window.fetch;
  window.fetch = async function (input) {
    const response = await nativeFetch.apply(this, arguments);
    if (isForYou(input?.url ?? input)) response.clone().text().then(forward, () => {});
    return response;
  };
})();
