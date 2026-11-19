import hljs from '../vendor/highlight/highlight.esm.js';

export const CODE_LANGUAGES = [
  ['', 'None'], ['html', 'HTML'], ['css', 'CSS'], ['javascript', 'JavaScript'],
  ['typescript', 'TypeScript'], ['json', 'JSON'], ['python', 'Python'], ['bash', 'Bash'],
  ['java', 'Java'], ['c', 'C'], ['cpp', 'C++'], ['csharp', 'C#'], ['go', 'Go'],
  ['rust', 'Rust'], ['sql', 'SQL'],
];

export function supportsCodeLanguage(language) {
  return !!language && !!hljs.getLanguage(language);
}

export function highlightedCode(source, language) {
  if (!supportsCodeLanguage(language)) {
    return source.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
  return hljs.highlight(source, { language, ignoreIllegals: true }).value;
}

export const CODE_HIGHLIGHT_CSS = `
pre code .hljs-comment,pre code .hljs-quote{color:#667080;font-style:italic}
pre code .hljs-keyword,pre code .hljs-selector-tag,pre code .hljs-literal{color:#a02879}
pre code .hljs-string,pre code .hljs-attr,pre code .hljs-regexp{color:#087842}
pre code .hljs-number,pre code .hljs-symbol,pre code .hljs-bullet{color:#a04b00}
pre code .hljs-title,pre code .hljs-section,pre code .hljs-function{color:#245ab0}
pre code .hljs-built_in,pre code .hljs-type,pre code .hljs-tag,pre code .hljs-name,pre code .hljs-attribute{color:#87510b}
@media(prefers-color-scheme:dark){
pre code .hljs-comment,pre code .hljs-quote{color:#a2aab8}
pre code .hljs-keyword,pre code .hljs-selector-tag,pre code .hljs-literal{color:#f4a8d7}
pre code .hljs-string,pre code .hljs-attr,pre code .hljs-regexp{color:#86efac}
pre code .hljs-number,pre code .hljs-symbol,pre code .hljs-bullet{color:#fbbf24}
pre code .hljs-title,pre code .hljs-section,pre code .hljs-function{color:#93c5fd}
pre code .hljs-built_in,pre code .hljs-type,pre code .hljs-tag,pre code .hljs-name,pre code .hljs-attribute{color:#e8bc78}
}
@supports (color:light-dark(#000,#fff)){
pre code .hljs-comment,pre code .hljs-quote{color:light-dark(#667080,#a2aab8)}
pre code .hljs-keyword,pre code .hljs-selector-tag,pre code .hljs-literal{color:light-dark(#a02879,#f4a8d7)}
pre code .hljs-string,pre code .hljs-attr,pre code .hljs-regexp{color:light-dark(#087842,#86efac)}
pre code .hljs-number,pre code .hljs-symbol,pre code .hljs-bullet{color:light-dark(#a04b00,#fbbf24)}
pre code .hljs-title,pre code .hljs-section,pre code .hljs-function{color:light-dark(#245ab0,#93c5fd)}
pre code .hljs-built_in,pre code .hljs-type,pre code .hljs-tag,pre code .hljs-name,pre code .hljs-attribute{color:light-dark(#87510b,#e8bc78)}
}`.trim();
