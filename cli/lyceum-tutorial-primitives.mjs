import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Refusal } from '../lib/errors.js';
import { splitFile, joinFile } from '../lib/frontmatter.js';
import { decodeHtml } from '../lib/html-entities.js';
import { parseHtml } from '../lib/html-tree.js';
import { deltaToMarkdownChecked, mdToDelta } from '../lib/markdown.js';
import { widgetHtml } from '../lib/widget-markup.js';
import { nativeTutorialProse } from './strata-native-prose.mjs';

export const LYCEUM_TUTORIALS = ['makeshort', 'a-plus-b-cubed', 'hardy-weinberg', 'area-volume', 'projectile', 'piston'];

function plainFigure(raw) {
  const root = parseHtml(raw).children;
  if (root.length !== 1 || root[0].tag !== 'figure' || Object.keys(root[0].attrs).length) return null;
  const children = root[0].children.filter((n) => typeof n !== 'string' || decodeHtml(n).trim());
  if (children.length !== 2 || children[0].tag !== 'img' || children[1].tag !== 'figcaption') return null;
  const [img, caption] = children;
  if (Object.keys(img.attrs).sort().join(',') !== 'alt,src' || Object.keys(caption.attrs).length ||
      caption.children.some((n) => typeof n !== 'string')) return null;
  const originalCaption = caption.children.map(decodeHtml).join('');
  if (originalCaption !== originalCaption.trim()) return null;
  return widgetHtml({ type: 'figure-caption', image: img.attrs.src, alt: img.attrs.alt, caption: originalCaption });
}

function codeText(raw) {
  const roots = parseHtml(raw).children;
  if (roots.length !== 1 || roots[0].tag !== 'pre' || Object.keys(roots[0].attrs).length) return null;
  const children = roots[0].children;
  if (children.length !== 1 || children[0].tag !== 'code' || Object.keys(children[0].attrs).length ||
      children[0].children.some((n) => typeof n !== 'string')) return null;
  return children[0].children.map(decodeHtml).join('');
}

export function convertLyceumTutorial(body) {
  const prose = nativeTutorialProse(body);
  const original = mdToDelta(prose.body).ops;
  const report = { prose: prose.converted, code: 0, figures: 0, retained: [] };
  const ops = original.flatMap((op, index) => {
    const raw = op.insert?.htmlblock;
    if (!raw) return [op];
    if (raw.startsWith('<figure')) {
      try {
        const figure = plainFigure(raw);
        if (figure) {
          report.figures++;
          return [{ insert: { htmlblock: figure } }];
        }
      } catch (error) {
        if (!(error instanceof Refusal)) throw error;
      }
      report.retained.push('Figure contains formatting or attributes the figure editor cannot preserve.');
    } else if (raw.startsWith('<pre')) {
      const code = codeText(raw);
      const adjacent = [original[index - 1], original[index + 1]].some((other) =>
        other?.insert?.htmlblock?.startsWith('<pre') || other?.attributes?.['code-block']);
      if (code !== null && !adjacent) {
        const candidate = [];
        for (const line of code.split('\n')) {
          if (line) candidate.push({ insert: line });
          candidate.push({ insert: '\n', attributes: { 'code-block': 'javascript' } });
        }
        try {
          const checked = deltaToMarkdownChecked({ ops: candidate });
          const decoded = checked.delta.ops.map((item) => item.insert).join('').slice(0, -1);
          if (decoded !== code) throw new Error('Code conversion changed its text.');
          report.code++;
          return checked.delta.ops;
        } catch (error) {
          if (!(error instanceof Refusal)) throw error;
          report.retained.push(`Code cannot round-trip: ${error.detail || error.message}`);
          return [op];
        }
      }
      report.retained.push('Code has additional markup or is adjacent to another code block.');
    }
    return [op];
  });
  return { body: deltaToMarkdownChecked({ ops }).md, report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2];
  if (!root) throw new Error('Usage: node cli/lyceum-tutorial-primitives.mjs <Strata checkout>');
  const folder = path.join(root, 'docs/about/tutorials/pages');
  for (const slug of LYCEUM_TUTORIALS) {
    const file = path.join(folder, `${slug}.md`);
    const { front, body } = splitFile(await readFile(file, 'utf8'), file);
    const result = convertLyceumTutorial(body);
    await writeFile(file, joinFile(front, result.body));
    console.log(`${slug}: ${result.report.prose} prose, ${result.report.code} code, ${result.report.figures} figures`);
    for (const reason of result.report.retained) console.log(`  retained HTML: ${reason}`);
  }
}
