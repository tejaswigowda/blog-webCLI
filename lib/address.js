export const isFlatAddress = (addr) => addr.endsWith('.html');
export const addressHref = (addr) => isFlatAddress(addr) ? addr : `${addr}/`;
export const addressFile = (addr) => isFlatAddress(addr) ? addr : `${addr}/index.html`;
