/**
 * stock-news-tracker 边缘加速 Worker（第3项）
 * =============================================================================
 * 作用：把「行情 / K线 / 板块」三类高频只读请求收拢到 Cloudflare 边缘节点，
 *       在边缘做 30~60 秒缓存。效果：
 *         · 上千人同时刷新时，同一个 key 在同一个边缘节点只回源 1 次
 *         · 回源次数与「在线人数」解耦，只与「不同请求种类数 × 缓存过期次数」相关
 *         · 同时保留原有 /news 与 /proxy 两条路径，行为完全不变
 *
 * 部署：见同目录 DEPLOY_WORKER.md（全流程约 5 分钟，全免费）
 * =============================================================================
 */

// ============================ 可调参数 ============================
const TTL = {
  QUOTE: 30,        // 实时行情（腾讯 qt.gtimg.cn）—— 30 秒
  KLINE: 300,       // 日K线（腾讯 ifzq / 东财）—— 5 分钟
  SECTOR: 60,       // 板块列表 / 成分股 / 排行 —— 60 秒
  NEWS: 60          // 新闻 / 快讯 —— 60 秒
};

// 允许代理的上游域名白名单（安全：防止被当成任意代理滥用）
const ALLOW_HOSTS = [
  'qt.gtimg.cn',
  'web.ifzq.gtimg.cn',
  'proxy.finance.qq.com',
  'push2.eastmoney.com',
  'push2delay.eastmoney.com',
  'push2his.eastmoney.com',
  'datacenter-web.eastmoney.com',
  'searchapi.eastmoney.com',
  'np-anotice-stock.eastmoney.com',
  'emweb.securities.eastmoney.com'
];

// ============================ 工具函数 ============================

/** 解码被浏览器部分编码的路径片段；已经合法的字符原样返回 */
function decodeSafe(s) {
  try { return decodeURIComponent(s); } catch (e) { return s; }
}

/** 判断该 URL 属于哪一类，决定 TTL */
function ttlFor(pathname, targetHost) {
  if (targetHost === 'qt.gtimg.cn') return TTL.QUOTE;
  if (targetHost === 'web.ifzq.gtimg.cn' || targetHost === 'proxy.finance.qq.com') return TTL.KLINE;
  if (/\/kline\/get/.test(pathname)) return TTL.KLINE;
  if (/\/clist\/get|\/fflow\/|\/f10\/|RPT_/.test(pathname)) return TTL.SECTOR;
  return TTL.SECTOR;
}

/** 统一加 CORS 头，让浏览器可直连（东财部分接口不带 CORS 头） */
function withCors(headers) {
  const h = new Headers(headers || {});
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
  h.set('Access-Control-Allow-Headers', '*');
  return h;
}

/** 取缓存（Cloudflare 内置 caches.default） */
async function cacheGet(cacheKey) {
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (!hit) return null;
  // 命中：直接复用响应体，但补一个标记头便于前端/排查
  const body = await hit.arrayBuffer();
  const h = withCors(hit.headers);
  h.set('X-Cache', 'HIT');
  return new Response(body, { status: hit.status, headers: h });
}

/** 写缓存（只缓存 2xx） */
async function cachePut(cacheKey, resp, ttl) {
  if (resp.status < 200 || resp.status >= 300) return;
  try {
    const cache = caches.default;
    // resp.clone() 保证「进缓存的那份」和「返回给调用方的那份」各用各的 body 流
    const toStore = resp.clone();
    const h = withCors(toStore.headers);
    h.set('Cache-Control', 'public, max-age=' + ttl);
    await cache.put(cacheKey, new Response(toStore.body, { status: toStore.status, headers: h }));
  } catch (e) { /* 忽略缓存写失败：最多是没加速到，不影响正确性 */ }
}

// ============================ 主逻辑 ============================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- 预检 ---
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: withCors() });
    }

    // ============ 路由 1：/news?page=&size= —— 东方财富 7x24 快讯（行为与原来一致） ============
    if (url.pathname === '/news') {
      const page = url.searchParams.get('page') || '1';
      const size = url.searchParams.get('size') || '20';
      const target = `https://np-anotice-stock.eastmoney.com/api/security/ann?page_size=${size}&page_index=${page}`;
      // 东财快讯真实接口（沿用原有实现）
      const real = `https://newsapi.eastmoney.com/kuaixun/v1/getlist_102_ajaxResult_50_${page}.html?r=${Date.now()}`;
      const cacheKey = new Request('https://cache.local/news?page=' + page + '&size=' + size, { method: 'GET' });
      const cached = await cacheGet(cacheKey);
      if (cached) return cached;

      try {
        const upstream = await fetch(real, {
          headers: {
            'Referer': 'https://kuaixun.eastmoney.com/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
          }
        });
        const text = await upstream.text();
        const h = withCors({ 'Content-Type': 'application/json; charset=utf-8' });
        h.set('X-Cache', 'MISS');
        const resp = new Response(text, { status: 200, headers: h });
        await cachePut(cacheKey, resp.clone(), TTL.NEWS);
        return resp;
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), {
          status: 502, headers: withCors({ 'Content-Type': 'application/json' })
        });
      }
    }

    // ============ 路由 2：/q/<codes> —— 腾讯行情（新增，带 30s 边缘缓存） ============
    if (url.pathname.startsWith('/q/')) {
      // 浏览器可能把 codes 里的逗号编码成 %2C，这里统一解码
      const raw = decodeSafe(url.pathname.slice(3)) + url.search;
      const target = 'https://qt.gtimg.cn/q=' + raw;
      return proxyWithCache(request, target, 'qt.gtimg.cn', TTL.QUOTE);
    }

    // ============ 路由 3：/k/<rest> —— 腾讯日K线（新增，带 5min 边缘缓存） ============
    if (url.pathname.startsWith('/k/')) {
      const rest = decodeSafe(url.pathname.slice(3));
      const target = 'https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=' + rest;
      return proxyWithCache(request, target, 'web.ifzq.gtimg.cn', TTL.KLINE);
    }

    // ============ 路由 4：/proxy?url=<encoded> —— 通用代理（沿用原有行为 + 按目标加缓存） ============
    if (url.pathname === '/proxy') {
      const raw = url.searchParams.get('url');
      if (!raw) {
        return new Response(JSON.stringify({ error: 'missing url' }), {
          status: 400, headers: withCors({ 'Content-Type': 'application/json' })
        });
      }
      let target;
      try { target = decodeURIComponent(raw); } catch (e) { target = raw; }
      let th = '';
      try { th = new URL(target).hostname; } catch (e) {
        return new Response(JSON.stringify({ error: 'bad url' }), {
          status: 400, headers: withCors({ 'Content-Type': 'application/json' })
        });
      }
      if (ALLOW_HOSTS.indexOf(th) < 0) {
        return new Response(JSON.stringify({ error: 'host not allowed: ' + th }), {
          status: 403, headers: withCors({ 'Content-Type': 'application/json' })
        });
      }
      const ttl = ttlFor(new URL(target).pathname, th);
      return proxyWithCache(request, target, th, ttl);
    }

    // ============ 其它：健康检查 ============
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(JSON.stringify({
        ok: true,
        service: 'stock-news-tracker-edge-cache',
        ttl: TTL,
        allowHosts: ALLOW_HOSTS,
        routes: ['/news', '/q/<codes>', '/k/<code>/<n>', '/proxy?url=']
      }, null, 2), { headers: withCors({ 'Content-Type': 'application/json' }) });
    }

    return new Response('Not Found', { status: 404, headers: withCors() });
  }
};

/**
 * 通用「带边缘缓存的代理」。
 * 关键点：缓存键 = 目标 URL（去掉随机参数），所以同一份数据在 TTL 内只回源一次。
 */
async function proxyWithCache(request, target, targetHost, ttl) {
  // 缓存键：用规范化后的目标 URL（剥掉 _t / r 之类的防缓存时间戳，避免缓存永不命中）
  const norm = target.replace(/([?&])(_t|_r|r|t)=\d+/g, '$1').replace(/[?&]$/, '');
  const cacheKey = new Request('https://cache.local/p?u=' + encodeURIComponent(norm) + '&h=' + targetHost, { method: 'GET' });

  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  const headers = {
    // 不带自定义 UA 才是「简单请求」，避免触发 CORS 预检（东财不支持 OPTIONS 预检）
    'Accept': '*/*',
    'Referer': 'https://' + targetHost + '/'
  };
  try {
    const upstream = await fetch(target, { headers, redirect: 'follow' });
    const buf = await upstream.arrayBuffer();
    const h = withCors(upstream.headers);
    h.set('X-Cache', 'MISS');
    h.set('Cache-Control', 'public, max-age=' + ttl);
    const resp = new Response(buf, { status: upstream.status, headers: h });
    await cachePut(cacheKey, resp.clone(), ttl);
    return resp;
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e), target }), {
      status: 502, headers: withCors({ 'Content-Type': 'application/json' })
    });
  }
}
