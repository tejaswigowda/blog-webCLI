import { Refusal } from './errors.js';
import { parseHtml } from './html-tree.js';

export const REL_VALUES = Object.freeze(['sponsored', 'nofollow', 'ugc', 'noopener', 'noreferrer', 'me', 'license', 'author']);
export const DEFAULT_AFFILIATE_PARAMS = Object.freeze(['tag', 'subId', 'sscid', 'clickid', 'irgwc', 'ranMID', 'awc']);

export function validateAffiliateParams(params) {
  if (!Array.isArray(params) || params.length > 200 || params.some((name) => typeof name !== 'string' || !/^[a-z0-9_.~-]{1,100}$/i.test(name))) {
    throw new Refusal('bad-blog-json', '"affiliateParams" must be a list of at most 200 URL query parameter names');
  }
}

export function validateAffiliateDomains(domains, field = 'affiliateDomains') {
  if (!Array.isArray(domains) || domains.length > 200) throw new Refusal('bad-blog-json', `"${field}" must be a list of at most 200 hostnames`);
  for (const domain of domains) {
    if (typeof domain !== 'string' || domain.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(domain)) {
      throw new Refusal('bad-blog-json', `"${field}" must contain hostnames without schemes, ports or wildcards: ${JSON.stringify(domain)}`);
    }
  }
}

export function outboundHost(href, base) {
  if (typeof href !== 'string' || href.startsWith('asset:')) return null;
  try {
    const url = new URL(href, base);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    const own = new URL(base).hostname.toLowerCase().replace(/\.$/, '');
    return host === own ? null : host;
  } catch {
    return null;
  }
}

export function matchesAffiliate(host, domains = []) {
  return !!host && domains.some((domain) => {
    const d = domain.toLowerCase();
    return host === d || host.endsWith(`.${d}`);
  });
}

export function linkRel(href, existing = '', { base, affiliates = [] } = {}) {
  const values = [...new Set(existing.trim().split(/\s+/).filter(Boolean))];
  if (base && matchesAffiliate(outboundHost(href, base), affiliates) && !values.includes('sponsored')) values.push('sponsored');
  return values.join(' ');
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
