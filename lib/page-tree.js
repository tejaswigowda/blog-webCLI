// Page identifiers stay flat; only their published addresses follow the parent chain.
import { Refusal } from './errors.js';

export function resolvePagePaths(pages) {
  const bySlug = new Map(pages.map((p) => [p.slug, p]));
  const paths = new Map();
  for (const page of pages) {
    const chain = [];
    const visiting = new Set();
    let current = page;
    while (current && !paths.has(current.slug)) {
      if (visiting.has(current.slug)) throw new Refusal('page-cycle', `the parent chain of "${current.slug}" contains a cycle`, current.source);
      visiting.add(current.slug);
      chain.push(current);
      const parent = current.parent ? bySlug.get(current.parent) : null;
      if (current.parent && (!parent || (current.published && !parent.published))) throw new Refusal('no-such-parent', `"${current.slug}" needs parent "${current.parent}"${current.published ? ' to be published' : ''}`, current.source);
      current = parent;
    }
    let path = current ? paths.get(current.slug) : '';
    while (chain.length) {
      const node = chain.pop();
      path = path ? `${path}/${node.slug}` : node.slug;
      if (path.split('/').length > 3) throw new Refusal('page-too-deep', `"${node.slug}" is more than three levels deep`, node.source);
      paths.set(node.slug, path);
    }
  }
  return paths;
}

// Paths are supplied by the index; the menu never derives them again.
export function pageMenu(pages) {
  const nodes = new Map(pages.map((p) => [p.slug, { page: p, children: [] }]));
  const roots = [];
  for (const node of nodes.values()) {
    const parent = nodes.get(node.page.parent);
    (parent ? parent.children : roots).push(node);
  }
  const order = (a, b) => (a.page.menu ?? Infinity) - (b.page.menu ?? Infinity) || (a.page.slug < b.page.slug ? -1 : a.page.slug > b.page.slug ? 1 : 0);
  function render(nodes_) {
    return nodes_.sort(order).flatMap(({ page, children }) => {
      const nested = render(children);
      if (page.menu == null && !nested.length) return [];
      return [{ label: page.title, path: `${page.path || page.slug}/`, ...(nested.length ? { children: nested } : {}) }];
    });
  }
  return render(roots);
}

export function renderPageMenu(menu, escape, classic = false) {
  const link = (item) => `<a href="${escape(item.href)}">${escape(item.label)}</a>`;
  const item = (node) => `<li class="menu-item">${link(node)}${node.children?.length ? `<ul class="sub-menu">${node.children.map(item).join('')}</ul>` : ''}</li>`;
  return (menu || []).map((node) => classic ? item(node) : `${link(node)}${node.children?.length ? `<ul class="sub-menu">${node.children.map(item).join('')}</ul>` : ''}`).join('');
}
