import { decodeEntities } from './xml.js';

const HTML_NAMED = {
  hellip: '\u2026', mdash: '\u2014', ndash: '\u2013', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d', sbquo: '\u201a', bdquo: '\u201e', copy: '\u00a9', reg: '\u00ae', trade: '\u2122',
  laquo: '\u00ab', raquo: '\u00bb', bull: '\u2022', middot: '\u00b7', times: '\u00d7', divide: '\u00f7', deg: '\u00b0', euro: '\u20ac', pound: '\u00a3', yen: '\u00a5', cent: '\u00a2', sect: '\u00a7', para: '\u00b6',
  larr: '\u2190', rarr: '\u2192', uarr: '\u2191', darr: '\u2193', hearts: '\u2665', eacute: '\u00e9', egrave: '\u00e8', agrave: '\u00e0', aacute: '\u00e1', uuml: '\u00fc', ouml: '\u00f6', auml: '\u00e4', szlig: '\u00df',
  ccedil: '\u00e7', ntilde: '\u00f1', iexcl: '\u00a1', iquest: '\u00bf', frac12: '\u00bd', plusmn: '\u00b1', micro: '\u00b5', thinsp: '\u2009', ensp: '\u2002', emsp: '\u2003', zwnj: '', zwj: '',
};

export function decodeHtml(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === '#' || ['lt', 'gt', 'amp', 'quot', 'apos', 'nbsp'].includes(e)) return decodeEntities(m);
    return HTML_NAMED[e] ?? m;
  });
}
