// How much of one stylesheet's declaration blocks another stylesheet also has, word for word.
//
// This is a *signal*, not a detection and not proof. A theme that says it is "inspired-by" a reference (lib/provenance.js) is making a
// declaration nothing here can check. What can be done mechanically is to notice when the two stylesheets share many whole blocks of
// three or more declarations in identical form, which independent CSS written after looking at a page rarely does. A low number
// proves nothing (declarations can be reordered into new blocks, renamed or minified differently); a high one is a reason to look.

const MIN_DECLARATIONS = 3;

// Every rule's declaration block, as the sorted, normalised declarations joined; a block of fewer than three declarations is too common to say anything.
export function declarationBlocks(css) {
  const s = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, (m) => m.replace(/[{};]/g, '_'));
  const blocks = new Map();
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '{') {
      const prelude = s.slice(start, i).trim();
      const close = s.indexOf('}', i);
      if (/^@(media|supports|layer|container|document)\b/i.test(prelude)) { start = i + 1; continue; } // look inside
      if (close < 0) break;
      const body = s.slice(i + 1, close);
      start = close + 1;
      i = close;
      if (prelude.startsWith('@')) continue;
      const decls = [...new Set(body.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
        const k = d.indexOf(':');
        return k < 0 ? '' : `${d.slice(0, k).trim().toLowerCase()}:${d.slice(k + 1).replace(/\s+/g, ' ').replace(/\s*!\s*important/i, '!important').trim().toLowerCase()}`;
      }).filter(Boolean))].sort();
      if (decls.length < MIN_DECLARATIONS) continue;
      const key = decls.join(';');
      if (!blocks.has(key)) blocks.set(key, prelude.replace(/\s+/g, ' ').slice(0, 80));
    } else if (c === '}') start = i + 1;
  }
  return blocks;
}

// { blocks: how many multi-declaration blocks the generated CSS has, shared: how many of them the reference has identically, ratio, examples, warn }
export function declarationOverlap(generatedCss, referenceCss) {
  const gen = declarationBlocks(generatedCss);
  const ref = declarationBlocks(referenceCss);
  const sharedKeys = [...gen.keys()].filter((k) => ref.has(k));
  const ratio = gen.size ? sharedKeys.length / gen.size : 0;
  const warn = (sharedKeys.length >= 5 && ratio >= 0.2) || (sharedKeys.length >= 3 && ratio >= 0.4);
  return {
    blocks: gen.size,
    shared: sharedKeys.length,
    ratio: Math.round(ratio * 1000) / 1000,
    examples: sharedKeys.slice(0, 3).map((k) => ({ generated: gen.get(k), reference: ref.get(k), declarations: k.split(';').slice(0, 4).join('; ') })),
    warn,
    note: warn
      ? `${sharedKeys.length} of ${gen.size} multi-declaration blocks appear in the reference stylesheet word for word. That is a signal, not a finding: check that this theme is inspired-by the reference, not derived-from it.`
      : 'No unusual overlap. That proves nothing either way: this is a signal, not a detection.',
  };
}
