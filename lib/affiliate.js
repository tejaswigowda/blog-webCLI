import { Refusal } from './errors.js';
import { parseHtml } from './html-tree.js';

export function validateAffiliateDomains(domains) {
  if (!Array.isArray(domains) || domains.length > 200) throw new Refusal('bad-blog-json', '"affiliateDomains" must be a list of at most 200 hostnames');
  for (const domain of domains) {
    if (typeof domain !== 'string' || domain.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(domain)) {
      throw new Refusal('bad-blog-json', `"affiliateDomains" must contain hostnames without schemes, ports or wildcards: ${JSON.stringify(domain)}`);
    }
  }
}

export function checkAffiliatePages(files, blog) {
  const domains = (blog.affiliateDomains || []).map((domain) => domain.toLowerCase());
  if (!domains.length) return;
  for (const [file, html] of Object.entries(files)) {
    if (!file.endsWith('.html')) continue;
    const visit = (node) => {
      if (typeof node === 'string') return;
      if (node.tag === 'a' && node.attrs.href) {
        let url;
        try {
          url = new URL(node.attrs.href, blog.domain + '/');
        } catch {
          throw new Refusal('affiliate-link', `invalid link address "${node.attrs.href}"`, file);
        }
        const host = url.hostname.toLowerCase().replace(/\.$/, '');
        if (['http:', 'https:'].includes(url.protocol) && domains.some((domain) => host === domain || host.endsWith('.' + domain)) && !String(node.attrs.rel || '').toLowerCase().split(/\s+/).includes('sponsored')) {
          throw new Refusal('affiliate-link', `link to "${node.attrs.href}" needs rel="sponsored"`, file);
        }
      }
      for (const child of node.children) visit(child);
    };
    visit(parseHtml(html));
  }
}
