import { canonHtml, checkHtmlBlock } from './rawhtml.js';
import { Refusal } from './errors.js';
import { SLIDE_ANIMATIONS } from './animations.js';

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Ordinary, allowlisted HTML: assets, markdown round trips and no-script readers need no new document format.
export function slideshowHtml(slides) {
  const bad = (message) => { throw new Refusal('bad-html', `Slideshow: ${message}`); };
  if (!Array.isArray(slides) || slides.length < 2 || slides.length > 10) bad('use 2-10 slides.');
  const figures = slides.map((slide, i) => {
    if (!slide || typeof slide !== 'object') bad(`slide ${i + 1}: expected slide fields.`);
    for (const k of ['image', 'alt', 'title', 'text', 'label', 'url']) {
      if (typeof slide[k] !== 'string' || /[\u0000-\u001f\u007f]/.test(slide[k])) bad(`slide ${i + 1}: ${k} must be a single line of text.`);
    }
    if (!slide.image.trim() || !slide.alt.trim()) bad(`slide ${i + 1}: an image and alternative text are required.`);
    if (!!slide.label.trim() !== !!slide.url.trim()) bad(`slide ${i + 1}: give both a link label and its address, or neither.`);
    for (const key of ['animation', 'imageAnimation', 'titleAnimation', 'textAnimation', 'labelAnimation']) {
      if (slide[key] !== undefined && !SLIDE_ANIMATIONS.includes(slide[key])) bad(`slide ${i + 1}: choose an animation from the dropdown (${key}).`);
    }
    const effect = (key) => slide[key] === undefined ? '' : ` class="webcli-animate-${slide[key]}"`;
    return `<figure class="webcli-slide${slide.animation === undefined ? '' : ` webcli-animate-${slide.animation}`}">
<img${effect('imageAnimation')} src="${escape(slide.image.trim())}" alt="${escape(slide.alt.trim())}">
<figcaption>${slide.title.trim() ? `<h2${effect('titleAnimation')}>${escape(slide.title.trim())}</h2>` : ''}${slide.text.trim() ? `<p${effect('textAnimation')}>${escape(slide.text.trim())}</p>` : ''}${slide.url.trim() ? `<a${effect('labelAnimation')} href="${escape(slide.url.trim())}">${escape(slide.label.trim())}</a>` : ''}</figcaption>
</figure>`;
  });
  const html = canonHtml(`<section class="webcli-slideshow" aria-label="Slideshow">\n${figures.join('\n')}\n</section>`);
  checkHtmlBlock(html);
  return html;
}

export const SLIDESHOW_FILE = 'webcli-slideshow.js';
export const hasSlideshow = (html) => /<section\b[^>]*\bclass="[^"]*\bwebcli-slideshow\b/.test(html);

export const SLIDESHOW_CSS = `
.webcli-slideshow{grid-column:1/-1;min-width:0;margin:0 0 2rem;position:relative;overflow:hidden;background:#142332;color:#fff}
.webcli-slideshow .webcli-slide{margin:0;position:relative;min-height:26rem;display:grid;align-items:center;isolation:isolate}
.webcli-slideshow .webcli-slide>img{position:absolute;inset:0;width:100%;height:100%;max-width:none;object-fit:cover;border-radius:0;z-index:0}
.webcli-slideshow .webcli-slide::before{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(0,0,0,.8),rgba(0,0,0,.12));z-index:1;pointer-events:none}
.webcli-slideshow .webcli-slide>figcaption{position:relative;z-index:2;padding:3rem clamp(1.25rem,5vw,5rem);max-width:48rem;color:#fff;text-align:left}
.webcli-slideshow .webcli-slide h2{color:inherit;margin:0 0 1rem;font-size:clamp(1.8rem,4vw,3rem);line-height:1.15}
.webcli-slideshow .webcli-slide p{margin:0 0 1.5rem;font:1.05rem/1.6 system-ui,sans-serif}
.webcli-slideshow .webcli-slide a{display:inline-block;padding:.65rem 1rem;border:2px solid #fff;color:#fff;font:700 1rem/1.4 system-ui,sans-serif;text-decoration:none}
.webcli-slideshow .webcli-slide a:hover{background:#fff;color:#142332}
.webcli-slideshow [hidden]{display:none!important}
.webcli-slideshow .webcli-slide-controls{position:relative;z-index:3;display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:.5rem;padding:.75rem}
.webcli-slideshow button{font:600 .9rem/1.4 system-ui,sans-serif;border:1px solid #fff;border-radius:3px;background:transparent;color:#fff;padding:.4rem .65rem;min-height:2.75rem;min-width:2.75rem;cursor:pointer}
.webcli-slideshow button[aria-current=true]{background:#fff;color:#142332}
.webcli-slideshow :focus-visible{outline:3px solid #ffdc65;outline-offset:3px}
@media(max-width:600px){.webcli-slideshow .webcli-slide{min-height:30rem}.webcli-slideshow .webcli-slide>figcaption{padding:2rem 1.25rem}}
`.trim();
