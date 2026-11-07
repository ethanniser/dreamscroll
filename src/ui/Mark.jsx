import {useId} from 'react';
import {MARK} from './shared.js';

/** The Dreamscroll mark (assets/mark.svg), drawn in the current text color. */
export function Mark() {
  const id = useId();
  return (
    <svg className="mark" viewBox="0 0 24 24" aria-hidden="true">
      <mask id={id}><rect width="24" height="24" fill="#fff" /><circle cx="15.5" cy="8" r="6.6" fill="#000" /></mask>
      <circle cx="11" cy="13" r="8.5" fill="currentColor" mask={`url(#${id})`} />
      <path d={MARK} fill="currentColor" />
    </svg>
  );
}
