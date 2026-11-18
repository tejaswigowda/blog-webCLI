import { Refusal } from '../lib/errors.js';
import { decodeHtml } from '../lib/html-entities.js';
import { parseHtml } from '../lib/html-tree.js';
import { deltaToHtml } from '../lib/html.js';
import { deltaToMarkdownChecked, mdToDelta } from '../lib/markdown.js';
import { htmlToDelta } from '../lib/wp-html.js';

function markupTree(node) {
  if (typeof node === 'string') return decodeHtml(node);
  return [node.tag, Object.entries(node.attrs).sort(), node.children.map(markupTree)];
}

export function sameTutorialMarkup(a, b) {
  return a === b || JSON.stringify(markupTree(parseHtml(a))) === JSON.stringify(markupTree(parseHtml(b)));
}

export function nativeTutorialProse(body) {
  const original = mdToDelta(body);
  let converted = 0;
  const ops = original.ops.flatMap((op) => {
    const raw = op.insert.htmlblock;
    if (!raw || !/^<(?:p|h[1-3])>/.test(raw)) return [op];
    const { ops: candidate, notes } = htmlToDelta(raw, { link: (href) => href });
    if (notes.length || !candidate.length || candidate.some((item) => item.insert.htmlblock)) return [op];
    try {
      const { delta } = deltaToMarkdownChecked({ ops: candidate });
      if (!sameTutorialMarkup(deltaToHtml({ ops: [op] }), deltaToHtml(delta))) return [op];
      converted++;
      return delta.ops;
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      return [op];
    }
  });
  if (!converted) return { body, converted };
  const { md, delta } = deltaToMarkdownChecked({ ops });
  if (!sameTutorialMarkup(deltaToHtml(original), deltaToHtml(delta))) {
    throw new Error('native conversion changed the tutorial markup');
  }
  return { body: md, converted };
}
