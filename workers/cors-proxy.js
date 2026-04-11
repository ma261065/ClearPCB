/**
 * ClearPCB CORS Proxy — Cloudflare Worker
 *
 * Proxies requests to allowed API endpoints (EasyEDA, LCSC, GitLab)
 * and adds CORS headers so the browser-based app can access them.
 *
 * Deploy: Cloudflare Dashboard → Workers & Pages → clearpcb → Edit Code
 * Domain: https://clearpcb.mikealex.workers.dev
 */
export default {
  async fetch(request) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Expose-Headers': 'x-total, x-total-pages, x-page, x-per-page, x-next-page',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    const url = new URL(request.url);
    const target = url.searchParams.get('url');
    if (!target) return new Response('Missing ?url=', { status: 400 });

    // Only proxy to known, trusted API domains
    const allowed = [
      /^https?:\/\/(www\.)?lcsc\.com\//i,
      /^https?:\/\/(wwwapi|api)\.lcsc\.com\//i,
      /^https?:\/\/(www\.)?easyeda\.com\//i,
      /^https?:\/\/gitlab\.com\//i,
      /^https?:\/\/image\.lceda\.cn\//i,
      /^https?:\/\/modules\.easyeda\.com\//i
    ];
    if (!allowed.some(rx => rx.test(target))) {
      return new Response('Blocked', { status: 403 });
    }

    const init = {
      method: request.method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': request.headers.get('accept') || 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Content-Type': request.headers.get('content-type') || 'application/x-www-form-urlencoded; charset=UTF-8',
        'Origin': 'https://easyeda.com',
        'Referer': 'https://easyeda.com/',
      },
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text()
    };

    const resp = await fetch(target, init);

    const headers = new Headers(resp.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Headers', '*');

    // Expose GitLab pagination headers so JS can read them
    const exposeHeaders = ['x-total', 'x-total-pages', 'x-page', 'x-per-page', 'x-next-page'];
    headers.set('Access-Control-Expose-Headers', exposeHeaders.join(', '));

    return new Response(resp.body, { status: resp.status, headers });
  }
};
