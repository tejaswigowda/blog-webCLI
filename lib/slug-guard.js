// "Fry's" is one authored word, not evidence for the dictionary word "fry".
const words = (text) => (text.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').match(/\p{L}+(?:['\u2019]\p{L}+)*/gu) || [])
  .map((word) => word.replace(/['\u2019]/g, ''));

function oneEdit(a, b) {
  if (Math.abs(a.length - b.length) > 1 || a === b) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else {
      if (++edits > 1) return false;
      if (a.length >= b.length) i++;
      if (b.length >= a.length) j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) === 1;
}

export function slugWarnings({ slug, title, body }, knownWords) {
  const present = [...new Set(words(`${title}\n${body}`))].filter((word) => knownWords.has(word));
  return [...new Set(slug.split('-'))].filter((token) => /^[a-z]{2,}$/.test(token) && !knownWords.has(token))
    .map((token) => ({ token, corrections: present.filter((word) => oneEdit(token, word)).sort() }))
    .filter((warning) => warning.corrections.length);
}
