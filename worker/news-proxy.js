/**
 * 财经新闻代理 - Cloudflare Worker（免费）
 *
 * 部署步骤：
 * 1. 打开 https://dash.cloudflare.com → 注册/登录（免费，无需信用卡）
 * 2. 左侧菜单 → Workers & Pages → Create application → Create Worker
 * 3. 名字填 news-proxy → Deploy
 * 4. 点击「Edit code」→ 把本文件全部内容粘贴进去 → Save and deploy
 * 5. 复制得到的地址（形如 https://news-proxy.你的子域.workers.dev）
 * 6. 在应用「设置」里把这个地址填入「新闻代理地址」
 *
 * 免费额度：每天 10 万次请求，个人使用完全够用。
 *
 * 接口：
 *   GET /news?page=1&size=50   → 抓取东方财富7x24财经快讯（JSON，已加CORS头）
 *   GET /proxy?url=编码后的URL  → 通用跨域代理
 */
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*'
    };

    // 预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // 健康检查
    if (url.pathname === '/' || url.pathname === '') {
      return new Response('News Proxy OK. Endpoints: /news?page=1&size=50 | /proxy?url=ENCODED', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders }
      });
    }

    // 东方财富 7x24 财经快讯
    if (url.pathname === '/news') {
      const page = url.searchParams.get('page') || '1';
      const size = url.searchParams.get('size') || '50';
      const target = `https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?client=web&biz=web_news_col&column=350&order=1&needInteractData=0&page_index=${page}&page_size=${size}&req_trace=cfworker`;
      try {
        const resp = await fetch(target, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Referer': 'https://finance.eastmoney.com/' }
        });
        const data = await resp.json();
        return new Response(JSON.stringify(data), {
          headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    // 通用跨域代理：/proxy?url=<URL编码的目标地址>
    if (url.pathname === '/proxy') {
      const target = url.searchParams.get('url');
      if (!target) {
        return new Response('Missing "url" parameter', { status: 400, headers: corsHeaders });
      }
      try {
        const resp = await fetch(target, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        const text = await resp.text();
        const ct = resp.headers.get('Content-Type') || 'application/json; charset=utf-8';
        return new Response(text, {
          headers: { 'Content-Type': ct, ...corsHeaders }
        });
      } catch (e) {
        return new Response(e.message, { status: 502, headers: corsHeaders });
      }
    }

    return new Response('Not Found. Use /news or /proxy?url=', {
      status: 404,
      headers: { 'Content-Type': 'text/plain', ...corsHeaders }
    });
  }
};
