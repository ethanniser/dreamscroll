// Shared by the main page and the feed page.
export const UNAVAILABLE = 'Extension unavailable. Reload Dreamscroll and try again.';

export async function request(payload) {
  let result;
  try { result = await chrome.runtime.sendMessage(payload); }
  catch { throw Error(UNAVAILABLE); }
  if (!result || result.error) throw Error(result?.error || UNAVAILABLE);
  return result;
}

/** The Dreamscroll mark (assets/mark.svg): a sleeping crescent and a sparkle, in the text color. */
export const MARK = 'M19 15.2c.25 1.35.55 1.65 1.9 1.9-1.35.25-1.65.55-1.9 1.9-.25-1.35-.55-1.65-1.9-1.9 1.35-.25 1.65-.55 1.9-1.9Z';

export const clock = ts => new Date(ts).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'});
