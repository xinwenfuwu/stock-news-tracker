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
  NEWS: 60,         // 新闻 / 快讯 —— 60 秒
  STATIC: 1800      // GitHub Pages 静态资源（/acc/*）—— 30 分钟（URL 带 ?v= 版本戳，发版自动失效）
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
  'emweb.securities.eastmoney.com',
  // 请求R：火热话题新增的实时新闻源
  'zhibo.sina.com.cn',        // 新浪财经 7x24 实时新闻
  'flash-api.jin10.com',      // 金十数据实时快讯
  /* 请求T：① 投实官网无任何公开新闻流（只有 App 落地页 + 备案号），换成证券时报；
   *       ② 华尔街见闻原先压根没进白名单（走代理必 403，这是它长期 0 条的原因之一），
   *          且旧域名 api-prod.wallstreetcn.com 已下线，改用实测可用的 api-one。 */
  'www.stcn.com',             // 证券时报（替代投实）
  'api-one.wallstcn.com'      // 华尔街见闻 7x24 快讯
];

// 请求R：部分源站校验自定义请求头（金十缺 x-app-id 会 403），按上游域名补发
const HOST_HEADERS = {
  'flash-api.jin10.com': { 'x-app-id': 'SO1EJGmNgCtmpcPF', 'x-version': '1.0.0', 'Referer': 'https://flash.jin10.com/' },
  'zhibo.sina.com.cn': { 'Referer': 'https://finance.sina.com.cn/7x24/' },
  // 请求T：华尔街见闻接口校验来源，缺 Referer 会被拒
  'api-one.wallstcn.com': { 'Referer': 'https://wallstreetcn.com/' }
};

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
  // 20261018：必须包含 POST（以及 PUT），否则浏览器对带 application/json 的跨域 POST
  // （/auth/register、/pay/claim、/pay/claims/resolve、/pay/create 等）触发预检(OPTIONS)时，
  // 因方法列表不含 POST 而预检失败 → POST 被拦截 → 无令牌设备的「经 Worker 代写云端」全部静默失败：
  // 注册/开通的账号写不进 registry.json，用户换设备登录时云端查无此号 → 报「用户名或密码不正确」。
  h.set('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,OPTIONS');
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
addEventListener('fetch', (event) => {
  event.respondWith(fetchHandler(event.request));
});

async function fetchHandler(request) {
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

    // ============ 支付与会员时长（batch84 / batch-A） ============
    if (url.pathname === '/pay/membership') return payMembershipGet(url);
    if (url.pathname === '/pay/create' && request.method === 'POST') return payCreate(request);
    if (url.pathname === '/pay/wx/notify' && request.method === 'POST') return payWxNotify(request);
    if (url.pathname === '/pay/ali/notify' && request.method === 'POST') return payAliNotify(request);
    // batch-A：个人收款码方案的「待开通」记录（普通用户无 GitHub 令牌，借 Worker + GH_PAT 写入仓库公开文件）
    if (url.pathname === '/pay/claim' && request.method === 'POST') return payClaim(request);
    // 20261007s：待审核申请「实时读」——直接读仓库最新内容，绕开 GitHub Pages 的 CDN/构建延迟，
    //            管理员点「刷新」即可看到刚提交的申请（此前要等 Pages 重建，最长数十秒）。
    if (url.pathname === '/pay/claims' && request.method === 'GET') return payClaimsGet();
    if (url.pathname === '/pay/claims/resolve' && request.method === 'POST') return payClaimResolve(request);
    // 20261016k：无令牌设备注册代写——把新账号写进云端注册表，管理员「审核通过区」必现
    if (url.pathname === '/auth/register' && request.method === 'POST') return authRegister(request);
    // 20261018e：管理员无令牌时经此通道把「重置后的密码哈希」写进云端注册表（防抢名 409 绕不开，另开专用通道）
    if (url.pathname === '/auth/admin-reset' && request.method === 'POST') return authAdminReset(request);
    // 20261018f：管理员删除账号专用通道——无 GitHub 令牌也能把账号从云端注册表真正删掉，
    //            否则「删了又出现」（recoverFromRegistry 会把云端残留合并回本机）。
    if (url.pathname === '/auth/admin-delete' && request.method === 'POST') return authAdminDelete(request);

    // ============ 路由 5：/acc/<path> —— GitHub Pages 静态资源加速（20261006g） ============
    // 背景：国内访问 xinwenfuwu.github.io 时快时慢，402KB 的 js/app.js 经常 20 秒拉不完，
    //       登录后动态装载业务脚本超时 →「资源加载失败」。auth-boot 第 2 次重试起改走本路由。
    // 说明：反代 GitHub Pages 的 stock-news-tracker 站点文件并做边缘缓存；
    //       只映射这一个站点路径，不是任意代理。URL 带 ?v= 版本戳，发新版后缓存键自然变化。
    if (url.pathname.startsWith('/acc/')) {
      const rest = url.pathname.slice('/acc/'.length);
      const target = 'https://xinwenfuwu.github.io/stock-news-tracker/' + rest + url.search;
      return proxyWithCache(request, target, 'xinwenfuwu.github.io', TTL.STATIC);
    }

    // ============ 路由 6：/rank/* —— 平台热度股票排行榜（20261006h） ============
    // 同花顺热股榜 / 东方财富人气榜 / 豆包搜索热度榜。
    // 背景：三平台均无公开免费的「股票热度排行榜」直连页面（CORS + 需鉴权），
    //       统一在此处做反代、归一化、边缘缓存，前端只调本 Worker 同源路由。
    if (url.pathname === '/rank/ths') return rankThs(request);
    if (url.pathname === '/rank/em') return rankEm(request);
    if (url.pathname === '/rank/doubao') return rankDoubao(request);
    if (url.pathname === '/rank/adboard') return rankAdBoard(request);
    if (url.pathname === '/rank/adspend') return rankAdSpend(request);

    // ============ 其它：健康检查 ============
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(JSON.stringify({
        ok: true,
        service: 'stock-news-tracker-edge-cache',
        ttl: TTL,
        allowHosts: ALLOW_HOSTS,
        member: { claimChannel: !!payEnv('GH_PAT'), registerChannel: !!payEnv('GH_PAT') },
        adminReset: !!payEnv('ADMIN_RESET_KEY'),
        adminDelete: !!payEnv('ADMIN_RESET_KEY'),
        routes: ['/news', '/q/<codes>', '/k/<code>/<n>', '/proxy?url=', '/auth/register', '/auth/admin-reset', '/auth/admin-delete']
      }, null, 2), { headers: withCors({ 'Content-Type': 'application/json' }) });
    }

    return new Response('Not Found', { status: 404, headers: withCors() });
}

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
    'Referer': 'https://' + targetHost + '/',
    // 请求R：按上游域名补发必需的请求头（金十 x-app-id 等）
    ...(HOST_HEADERS[targetHost] || {})
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

// ============================ batch84：支付与会员时长 ============================
// 设计：
//   · 会员到期时间存于 KV 绑定 MEMBERSHIP_KV（键 'm:<user>' → 到期时间戳 ms 字符串）。
//   · 商户密钥从 Worker Variables / Secrets 读取：
//       微信：WX_MCH_ID, WX_APPID, WX_SERIAL, WX_PRIVATE_KEY(PKCS#8 PEM), WX_APIV3_KEY, WX_PLATFORM_CERT(平台证书 PEM), WX_NOTIFY_URL(可选)
//       支付宝：ALI_APP_ID, ALI_PRIVATE_KEY(PKCS#8 PEM), ALI_PUBLIC_KEY(支付宝公钥 PEM), ALI_GATEWAY(可选), ALI_NOTIFY_URL(可选)
//   · 未配置任一支付商户号时，对应接口返回清晰错误，不影响既有行情代理功能。
//   · 下单把用户名(可逆 base64url)与购买月数写进 out_trade_no，支付成功回调时解析并写入会员到期时间。

const PLAN_AMOUNT = { '6m': 100000, '1y': 200000, '2y': 400000 }; // 单位：分（¥1000 / ¥2000 / ¥4000）
const PLAN_MONTHS = { '6m': 6, '1y': 12, '2y': 24 };

function payEnv(name) {
  try { return (typeof globalThis !== 'undefined' && globalThis[name] != null) ? String(globalThis[name]) : ''; } catch (e) { return ''; }
}
async function kvGet(user) {
  try { if (typeof MEMBERSHIP_KV === 'undefined' || !MEMBERSHIP_KV) return null; const v = await MEMBERSHIP_KV.get('m:' + user); return v ? Number(v) : null; } catch (e) { return null; }
}
async function kvSet(user, until) {
  try { if (typeof MEMBERSHIP_KV === 'undefined' || !MEMBERSHIP_KV) return false; await MEMBERSHIP_KV.put('m:' + user, String(until)); return true; } catch (e) { return false; }
}

// ============ batch-A：个人收款码方案的「待开通」记录（GitHub 写入，借 GH_PAT；普通用户无令牌，由 Worker 代写） ============
const GH_OWNER = 'xinwenfuwu';
const GH_REPO = 'stock-news-tracker';
const GH_BRANCH = 'main';
const CLAIMS_PATH = 'data/membership/claims.json';
function b64enc(str) { try { return btoa(unescape(encodeURIComponent(str))); } catch (e) { return ''; } }
function b64dec(b64) { try { return decodeURIComponent(escape(atob(String(b64).replace(/\s+/g, '')))); } catch (e) { return ''; } }
function ghApi(path, method, body) {
  const pat = payEnv('GH_PAT');
  if (!pat) return Promise.resolve({ ok: false, status: 401, body: { message: '未配置 GH_PAT' } });
  const url = 'https://api.github.com/repos/' + GH_OWNER + '/' + GH_REPO + path;
  const headers = {
    'Authorization': 'Bearer ' + pat,
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'snt-edge-claim',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  const init = { method, headers };
  if (body) init.body = JSON.stringify(body);
  return fetch(url, init).then(r => r.json().then(j => ({ ok: r.ok, status: r.status, body: j || {} })).catch(() => ({ ok: r.ok, status: r.status, body: {} })));
}
async function ghReadJson(path) {
  const r = await ghApi('/contents/' + path + '?ref=' + GH_BRANCH, 'GET');
  if (r.ok && r.body && r.body.content) {
    try { return { ok: true, sha: r.body.sha, data: JSON.parse(b64dec(r.body.content)) }; } catch (e) {}
  }
  return { ok: false, sha: null, data: null };
}
async function ghWriteJson(path, obj, sha, message) {
  const content = b64enc(JSON.stringify(obj, null, 2));
  const body = { message: message || ('chore(membership): update ' + path), content, branch: GH_BRANCH };
  if (sha) body.sha = sha;
  const r = await ghApi('/contents/' + path, 'PUT', body);
  return r.ok ? { ok: true } : { ok: false, error: (r.body && r.body.message) || ('HTTP ' + r.status), status: r.status };
}

// ============ 20261016k：注册即写云端注册表（无令牌设备经 Worker 代写） ============
// 背景：普通用户在自己设备（无 GitHub 令牌）注册只存本机，管理员在任意设备都看不到该账号，
// 违背「所有注册用户的账户信息必须出现在管理员审核通过区」。现在注册时经本端点把账号写进
// data/accounts/registry.json（Worker 持 GH_PAT）；管理员打开用户管理时
// recoverFromRegistry（只读合并）即把该账号并入本机列表，出现在「审核通过区」。
// 与本地 register() 同样的占用口径，避免云端抢名 / 覆盖付费账号：
//   · 已存在「管理员」或「付费会员」同名账号 → 拒绝（409）
//   · 已存在 active 同名账号 → 拒绝（409，请对方直接登录或联系管理员）
//   · 已存在 pending / rejected 同名账号 → 允许覆盖（真正的主人认领 / 重新申请）
const REGISTRY_PATH = 'data/accounts/registry.json';
const REG_USERNAME_RE = /^[A-Za-z0-9_\u4e00-\u9fa5.-]{2,20}$/;
async function authRegister(request) {
  let body; try { body = await request.json(); } catch (e) { return json({ error: 'invalid json' }, 400); }
  const username = String(body.username || '').trim();
  const hash = typeof body.hash === 'string' ? body.hash.trim() : '';
  if (!username) return json({ error: '缺少用户名' }, 400);
  if (!REG_USERNAME_RE.test(username)) return json({ error: '用户名只能包含中文、字母、数字、下划线、点或短横线（2-20 个字符）' }, 400);
  if (hash.indexOf('pbkdf2$') !== 0 || hash.split('$').length !== 4) return json({ error: '密码哈希格式不正确' }, 400);
  if (!payEnv('GH_PAT')) return json({ error: '注册同步通道未配置（请联系管理员）' }, 503);
  const now = Date.now();
  // 试用期只接受合理值（客户端注册即送 1 天；异常值按无试用处理，避免脏数据）
  let trialUntil = Number(body.trialUntil) || 0;
  if (trialUntil && (trialUntil < now - 30 * 86400000 || trialUntil > now + 30 * 86400000)) trialUntil = 0;
  const status = body.status === 'pending' ? 'pending' : 'active';
  try {
    // 并发注册可能撞 409 sha 冲突：失败重读一次再写（与 auth-sync.js writeRegistry 同策略）
    for (let attempt = 0; attempt < 2; attempt++) {
      const rd = await ghReadJson(REGISTRY_PATH);
      const reg = (rd.ok && rd.data && typeof rd.data === 'object') ? rd.data : {};
      reg.version = reg.version || 1;
      reg.accounts = reg.accounts || {};
      const exist = reg.accounts[username];
      // 20261018d：hash 为空的记录 = 管理员「核对并开通」时为尚未注册的用户名预发的
      // 「占位会员凭证」。本人来注册同名账号 → 认领：落真实密码哈希，并继承已开通的会籍
      // （会员有效期 / 支付信息 / 已核对申请 id），不能因为「已存在」把人挡在门外，
      // 也不能把会员洗成 0。
      const claiming = !!(exist && !exist.hash);
      if (exist && !claiming) {
        // 20261016l：同一份密码哈希 → 本人（或管理员代管）在同步最新状态，允许覆盖更新；
        // 哈希不同且对方是管理员 / 付费 / 已激活 → 拒绝抢名（409）。
        const sameHash = exist.hash === hash;
        const paid = (Number(exist.payMembershipUntil) || 0) > now || (Number(exist.quotaMonths) || 0) > 0;
        if (!sameHash && (exist.role === 'admin' || paid || (exist.status || 'pending') === 'active')) {
          return json({ ok: false, error: '该用户名已被使用，请更换一个' }, 409);
        }
        // sameHash（主人同步）/ pending / rejected → 允许覆盖（主人认领 / 重新申请 / 状态更新）
      }
      // 20261016l：会员字段透传——管理员「核对并开通」对无账号快照的申请兜底
      // 「创建账号并开通」后，经本端点把「账号 + 会员状态」一次性写入云端，
      // 无令牌设备也能落地，对方拿到密码后任意设备登录即带会员。
      const memUntil = Number(body.payMembershipUntil) || 0;
      const prevMemUntil = exist ? (Number(exist.payMembershipUntil) || 0) : 0;
      const prevQuota = exist ? (Number(exist.quotaMonths) || 0) : 0;
      const prevClaimIds = (exist && Array.isArray(exist.paidClaimIds)) ? exist.paidClaimIds : [];
      const claimIds = prevClaimIds.concat(Array.isArray(body.paidClaimIds) ? body.paidClaimIds : [])
        .map(x => String(x || '').trim()).filter((x, i, arr) => x && arr.indexOf(x) === i).slice(-30);
      reg.accounts[username] = {
        hash: hash,
        role: (exist && exist.role === 'admin') ? 'admin' : 'user',   // 不把已有管理员降级
        status: claiming ? 'active' : status,
        disabled: false,
        trialUntil: claiming ? (Number(exist.trialUntil) || 0) : trialUntil,
        trialDays: claiming ? (Number(exist.trialDays) || 0) : (Number(body.trialDays) || (trialUntil ? 1 : 0)),
        quotaMonths: claiming ? Math.max(Number(body.quotaMonths) || 0, prevQuota) : (Number(body.quotaMonths) || 0),
        disableDate: '',
        registerDate: (claiming && exist.registerDate) ? exist.registerDate : (typeof body.registerDate === 'string' ? body.registerDate : ''),
        payMembershipUntil: claiming ? Math.max(memUntil, prevMemUntil) : memUntil,
        paidAt: claiming ? (Number(exist.paidAt) || Number(body.paidAt) || 0) : (Number(body.paidAt) || 0),
        paidPlan: claiming ? (exist.paidPlan || (typeof body.paidPlan === 'string' ? body.paidPlan : '')) : (typeof body.paidPlan === 'string' ? body.paidPlan : ''),
        paidAmount: claiming ? (Number(exist.paidAmount) || Number(body.paidAmount) || 0) : (Number(body.paidAmount) || 0),
        paidClaimIds: claimIds,
        placeholder: false,
        createdAt: Number(body.createdAt) || (exist && Number(exist.createdAt)) || now,
        updatedAt: now
      };
      reg.updatedAt = now;
      const w = await ghWriteJson(REGISTRY_PATH, reg, rd.sha, 'chore(auth): register ' + username);
      if (w.ok) return json({ ok: true, created: true });
      if (attempt === 0 && w.status === 409) continue;   // sha 冲突：重读重试一次
      return json({ error: '写入失败：' + w.error }, 500);
    }
    return json({ error: '写入失败：并发冲突重试后仍未成功' }, 500);
  } catch (e) { return json({ error: String(e && e.message ? e.message : e) }, 500); }
}
/**
 * 20261018e：管理员「重置密码」专用通道（无 GitHub 令牌也能把新哈希写进云端注册表）。
 *
 * 背景（根因）：公开端点 /auth/register 对「已激活账号的【不同】哈希」一律 409（防抢名 / 防篡改），
 * 因此「改密码」永远走不通 register；而改密码又必须落到云端，否则对方设备读云端仍是旧哈希 → 登录失败。
 * 会员开通走的是「同哈希覆盖」分支（register 允许），所以出现了「会员开通了、密码却没更新」的割裂。
 *
 * 安全：本端点要求调用方携带 ADMIN_RESET_KEY（仅配置在 Worker 环境变量 + 管理员浏览器设置里），
 * 未配置该键则整条通道 503 关闭（默认安全）；密钥不符 403。仅更新目标账号的 hash / placeholder，
 * 不动会员 / 试用 / 角色等其它字段。有 GitHub 令牌的管理员仍优先走令牌直写（_syncUserToRegistry），
 * 本端点只是「无令牌管理员」的兜底通道。
 */
async function authAdminReset(request) {
  const key = payEnv('ADMIN_RESET_KEY');
  if (!key) return json({ error: '管理员重置通道未启用（Worker 未配置 ADMIN_RESET_KEY）' }, 503);
  let body; try { body = await request.json(); } catch (e) { return json({ error: 'invalid json' }, 400); }
  const username = String(body.username || '').trim();
  const hash = typeof body.hash === 'string' ? body.hash.trim() : '';
  const resetKey = String(body.resetKey || '');
  if (!username) return json({ error: '缺少用户名' }, 400);
  if (!REG_USERNAME_RE.test(username)) return json({ error: '用户名格式不正确（2-20 位中文/字母/数字/下划线/点/短横线）' }, 400);
  if (hash.indexOf('pbkdf2$') !== 0 || hash.split('$').length !== 4) return json({ error: '密码哈希格式不正确' }, 400);
  if (resetKey !== key) return json({ error: '重置密钥不正确' }, 403);
  if (!payEnv('GH_PAT')) return json({ error: '注册表写入通道未配置（请联系管理员）' }, 503);
  try {
    const rd = await ghReadJson(REGISTRY_PATH);
    const reg = (rd.ok && rd.data && typeof rd.data === 'object') ? rd.data : {};
    reg.version = reg.version || 1;
    reg.accounts = reg.accounts || {};
    const exist = reg.accounts[username];
    if (!exist) return json({ error: '账号不存在（请先让该用户注册或由管理员创建）' }, 404);
    // 仅更新密码哈希与占位标记，保留会员 / 试用 / 角色 / 支付等全部其它字段
    exist.hash = hash;
    exist.placeholder = false;
    reg.accounts[username] = exist;
    reg.updatedAt = Date.now();
    const w = await ghWriteJson(REGISTRY_PATH, reg, rd.sha, 'chore(auth): admin reset password ' + username);
    if (w.ok) return json({ ok: true, updated: true });
    return json({ error: '写入失败：' + (w.error || 'unknown') }, 500);
  } catch (e) { return json({ error: String(e && e.message ? e.message : e) }, 500); }
}

/**
 * 20261018f：管理员删除账号（无 GitHub 令牌设备也能真正从云端注册表删掉）。
 * 普通设备没有令牌，无法走 Contents API 直写；这里用 Worker 持有的 GH_PAT 服务端改写 registry.json。
 * 权限与 /auth/admin-reset 同口径：需 resetKey === ADMIN_RESET_KEY（未配置则 503 关闭）。
 * 幂等：云端本就没有该账号时返回 { ok:true, deleted:false }，不视为失败。
 */
async function authAdminDelete(request) {
  const key = payEnv('ADMIN_RESET_KEY');
  if (!key) return json({ error: '管理员删除通道未启用（Worker 未配置 ADMIN_RESET_KEY）' }, 503);
  let body; try { body = await request.json(); } catch (e) { return json({ error: 'invalid json' }, 400); }
  const username = String(body.username || '').trim();
  const resetKey = String(body.resetKey || '');
  if (!username) return json({ error: '缺少用户名' }, 400);
  if (!REG_USERNAME_RE.test(username)) return json({ error: '用户名格式不正确（2-20 位中文/字母/数字/下划线/点/短横线）' }, 400);
  if (resetKey !== key) return json({ error: '删除密钥不正确' }, 403);
  if (!payEnv('GH_PAT')) return json({ error: '注册表写入通道未配置（请联系管理员）' }, 503);
  try {
    const rd = await ghReadJson(REGISTRY_PATH);
    const reg = (rd.ok && rd.data && typeof rd.data === 'object') ? rd.data : {};
    reg.version = reg.version || 1;
    reg.accounts = reg.accounts || {};
    if (!reg.accounts[username]) return json({ ok: true, deleted: false }); // 云端本来就没有，幂等成功
    delete reg.accounts[username];
    reg.updatedAt = Date.now();
    const w = await ghWriteJson(REGISTRY_PATH, reg, rd.sha, 'chore(auth): admin delete account ' + username);
    if (w.ok) return json({ ok: true, deleted: true });
    return json({ error: '写入失败：' + (w.error || 'unknown') }, 500);
  } catch (e) { return json({ error: String(e && e.message ? e.message : e) }, 500); }
}

async function payClaim(request) {
  let body; try { body = await request.json(); } catch (e) { return json({ error: 'invalid json' }, 400); }
  const user = (body.user || '').trim(); const plan = (['6m', '1y', '2y'].indexOf(body.plan) >= 0) ? body.plan : '6m';
  if (!user) return json({ error: '请先登录后再提交' }, 400);
  if (!payEnv('GH_PAT')) return json({ error: '会员收款未配置（管理员尚未启用待开通通道，请直接把用户名发给管理员）' }, 503);
  try {
    const rd = await ghReadJson(CLAIMS_PATH);
    const claims = (rd.ok && rd.data && Array.isArray(rd.data.claims)) ? rd.data.claims : [];
    // 20261016h：账号快照透传。普通用户在自己设备（无 GitHub 令牌）注册的账号只存本机、
    // 从不进云端注册表，管理员「核对并开通」时查无此人；现在用户提交申请时附带账号快照，
    // 管理员即可按它自动创建账号并开通（app.js grantMemberClaim → createAccountFromSnapshot）。
    // 这里只接受结构合法且用户名一致的快照，hash 必须是 pbkdf2 自包含字符串，角色一律 user。
    let acct = null;
    if (body.acct && typeof body.acct === 'object' && !Array.isArray(body.acct)) {
      const a = body.acct;
      if (String(a.username || '').trim() === user && typeof a.hash === 'string' && a.hash.indexOf('pbkdf2$') === 0) {
        acct = {
          username: user,
          hash: a.hash,
          role: 'user',
          status: typeof a.status === 'string' ? a.status : 'active',
          disabled: false,
          trialUntil: Number(a.trialUntil) || 0,
          trialDays: Number(a.trialDays) || 0,
          quotaMonths: Number(a.quotaMonths) || 0,
          registerDate: typeof a.registerDate === 'string' ? a.registerDate : '',
          payMembershipUntil: Number(a.payMembershipUntil) || 0,
          paidAt: Number(a.paidAt) || 0,
          paidPlan: typeof a.paidPlan === 'string' ? a.paidPlan : '',
          paidAmount: Number(a.paidAmount) || 0,
          createdAt: Number(a.createdAt) || Date.now()
        };
      }
    }
    // 20261018d：申请没带账号快照（旧版客户端 / 在陌生设备上提交）→ 服务端按用户名
    // 从云端注册表补齐一份快照（含密码哈希），管理员点「核对并开通」就能一键完成，
    // 不必再让对方回注册设备重新提交。注册表与 claims.json 本就是同一公开仓库，
    // 哈希同属「自包含 PBKDF2 串」，不引入新的暴露面。
    if (!acct && user) {
      try {
        const rdReg = await ghReadJson(REGISTRY_PATH);
        const accs = (rdReg.ok && rdReg.data && rdReg.data.accounts) || {};
        let acc = accs[user];
        if (!acc) {
          const k = Object.keys(accs).find(x => String(x).trim().toLowerCase() === user.toLowerCase());
          acc = k ? accs[k] : null;
        }
        if (acc && typeof acc.hash === 'string' && acc.hash.indexOf('pbkdf2$') === 0) {
          acct = {
            username: user,
            hash: acc.hash,
            role: 'user',
            status: acc.status || 'active',
            disabled: false,
            trialUntil: Number(acc.trialUntil) || 0,
            trialDays: Number(acc.trialDays) || 0,
            quotaMonths: Number(acc.quotaMonths) || 0,
            registerDate: typeof acc.registerDate === 'string' ? acc.registerDate : '',
            payMembershipUntil: Number(acc.payMembershipUntil) || 0,
            paidAt: Number(acc.paidAt) || 0,
            paidPlan: typeof acc.paidPlan === 'string' ? acc.paidPlan : '',
            paidAmount: Number(acc.paidAmount) || 0,
            createdAt: Number(acc.createdAt) || Date.now()
          };
        }
      } catch (e) { /* 补不齐就走原流程（管理员仍可用占位凭证开通） */ }
    }
    // 20261007s：把用户端提交的支付时间 / 实付金额 / 时段一并落库，
    // 管理员「审核区」列表与开通后的用户表都能直接取用。
    const ts = Number(body.ts) || Date.now();
    const claim = { id: 'c_' + Date.now() + '_' + Math.floor(Math.random() * 1e6), user, plan, ts, resolved: false };
    if (body.amount != null) claim.amount = Number(body.amount) || 0;
    if (body.startTs) claim.startTs = Number(body.startTs) || ts;
    if (body.endTs) claim.endTs = Number(body.endTs) || 0;
    if (body.period) claim.period = String(body.period);
    if (acct) claim.acct = acct;
    // 20261016h：同一用户同一套餐的未决申请 → 「重新提交即取代最新」。
    // 旧逻辑是静默丢弃（exists 即返回 ok），用户补交/重交（如旧申请缺账号快照）永远进不来；
    // 现在用最新提交替换（含最新支付时间与账号快照），审核区始终是最新一条。
    const idx = claims.findIndex(c => !c.resolved && c.user === user && c.plan === plan);
    if (idx >= 0) claims[idx] = claim; else claims.push(claim);
    const w = await ghWriteJson(CLAIMS_PATH, { claims }, rd.sha, 'chore(membership): add claim ' + user);
    if (!w.ok) return json({ error: '提交失败：' + w.error }, 500);
    return json({ ok: true, replaced: idx >= 0 });
  } catch (e) { return json({ error: '提交异常：' + (e && e.message ? e.message : e) }, 500); }
}
/** 20261007s：待审核申请的实时读取（公开只读）。直接读仓库最新内容，绕开 Pages 构建/CDN 延迟。 */
async function payClaimsGet() {
  if (!payEnv('GH_PAT')) return json({ ok: true, configured: false, claims: [] });
  try {
    const rd = await ghReadJson(CLAIMS_PATH);
    const claims = (rd.ok && rd.data && Array.isArray(rd.data.claims)) ? rd.data.claims : [];
    return json({ ok: true, configured: true, claims });
  } catch (e) { return json({ ok: false, configured: true, claims: [], error: String(e && e.message || e) }, 500); }
}
async function payClaimResolve(request) {
  let body; try { body = await request.json(); } catch (e) { return json({ error: 'invalid json' }, 400); }
  const id = (body.id || '').trim();
  if (!id) return json({ error: '缺少 id' }, 400);
  if (!payEnv('GH_PAT')) return json({ error: '未配置 GH_PAT' }, 503);
  // 20261016i：rejected=true 时按「拒绝」处理——resolved 一并置 true（从审核区移除），
  // 另记 rejected / rejectedAt 两个审计字段。与「开通」共用同一端点、同一读写路径，
  // 管理员浏览器无 GitHub 令牌也能标记（借 Worker 的 GH_PAT）。
  const rejected = body.rejected === true;
  try {
    const rd = await ghReadJson(CLAIMS_PATH);
    const claims = (rd.ok && rd.data && Array.isArray(rd.data.claims)) ? rd.data.claims : [];
    const t = claims.find(c => c.id === id);
    if (t) { t.resolved = true; if (rejected) { t.rejected = true; t.rejectedAt = Date.now(); } }
    const w = await ghWriteJson(CLAIMS_PATH, { claims }, rd.sha, 'chore(membership): ' + (rejected ? 'reject' : 'resolve') + ' claim ' + id);
    return w.ok ? json({ ok: true, rejected: rejected }) : json({ error: w.error }, 500);
  } catch (e) { return json({ error: String(e && e.message || e) }, 500); }
}

// ---------- 编码 / 加密辅助 ----------
function b64ToBuf(b64) {
  const s = String(b64).replace(/[-_]/g, m => m === '-' ? '+' : '/').replace(/\s+/g, '');
  const bin = typeof atob === 'function' ? atob(s) : '';
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}
function pemToBuf(pem) {
  const b = String(pem).replace(/-----BEGIN[^-]+-----/, '').replace(/-----END[^-]+-----/, '').replace(/\s+/g, '');
  return b64ToBuf(b);
}
function bufToB64(buf) {
  const bytes = new Uint8Array(buf); let bin = ''; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return typeof btoa === 'function' ? btoa(bin) : '';
}
function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str); let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  const bin = typeof atob === 'function' ? atob(s) : ''; const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
async function importPrivate(pem) { return crypto.subtle.importKey('pkcs8', pemToBuf(pem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']); }
async function importPublic(pem) { return crypto.subtle.importKey('spki', pemToBuf(pem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']); }
async function rsaSign(privatePem, dataStr) {
  const key = await importPrivate(privatePem);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(dataStr));
  return bufToB64(sig);
}
async function rsaVerify(publicPem, dataStr, sigB64) {
  try { const key = await importPublic(publicPem); const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64ToBuf(sigB64), new TextEncoder().encode(dataStr)); return !!ok; } catch (e) { return false; }
}
async function aesGcmDecrypt(keyB64, nonceB64, cipherB64, aad) {
  const key = await crypto.subtle.importKey('raw', b64ToBuf(keyB64), { name: 'AES-GCM' }, false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBuf(nonceB64), additionalData: new TextEncoder().encode(aad || '') }, key, b64ToBuf(cipherB64));
  return new TextDecoder().decode(pt);
}
function nonceStr() { return Math.random().toString(36).slice(2, 12) + Date.now().toString(36); }
function selfUrl(req) { try { return new URL(req.url).origin; } catch (e) { return ''; } }
function json(obj, status) { return new Response(JSON.stringify(obj), { status: status || 200, headers: withCors({ 'Content-Type': 'application/json' }) }); }
function plain(text) { return new Response(text, { status: 200, headers: withCors({ 'Content-Type': 'text/plain' }) }); }
function parseOutTradeNo(out) {
  const m = /^SNT-([^-]+)-(\d+)-(\d+)-(\d+)$/.exec(out || '');
  if (!m) return { user: '', months: 0 };
  return { user: b64urlDecode(m[1]), months: parseInt(m[2], 10) || 0 };
}

// ---------- 微信 Native 支付 ----------
async function wxAuthorization(method, path, bodyStr) {
  const mchid = payEnv('WX_MCH_ID'), serial = payEnv('WX_SERIAL'), key = payEnv('WX_PRIVATE_KEY');
  const ts = Math.floor(Date.now() / 1000), nonce = nonceStr();
  const msg = `${method}\n${path}\n${ts}\n${nonce}\n${bodyStr}\n`;
  const sig = await rsaSign(key, msg);
  return `WECHATPAY2-SHA256-RSA2048 mchid="${mchid}",nonce_str="${nonce}",signature="${sig}",timestamp="${ts}",serial_no="${serial}"`;
}

// ---------- 支付宝 当面付（alipay.trade.precreate） ----------
function aliTimestamp() {
  const d = new Date(); const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
async function aliPrecreate({ outTradeNo, total, subject, notify }) {
  const appId = payEnv('ALI_APP_ID'), priv = payEnv('ALI_PRIVATE_KEY');
  const gateway = payEnv('ALI_GATEWAY') || 'https://openapi.alipay.com/gateway.do';
  const biz = { out_trade_no: outTradeNo, total_amount: total, subject: subject, qr_code_timeout_express: '2h' };
  const params = { app_id: appId, method: 'alipay.trade.precreate', format: 'JSON', charset: 'utf-8', sign_type: 'RSA2', timestamp: aliTimestamp(), version: '1.0', notify_url: notify, biz_content: JSON.stringify(biz) };
  const keys = Object.keys(params).filter(k => params[k] !== undefined && params[k] !== '').sort();
  const str = keys.map(k => `${k}=${params[k]}`).join('&');
  params.sign = await rsaSign(priv, str); // RSA2 = SHA256withRSA
  const form = new URLSearchParams(); for (const k in params) form.set(k, params[k]);
  const resp = await fetch(gateway, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' }, body: form.toString() });
  const j = await resp.json().catch(() => ({}));
  const r = j.alipay_trade_precreate_response;
  if (r && r.code === '10000' && r.qr_code) return r.qr_code;
  return '';
}

// ---------- 路由处理 ----------
async function payMembershipGet(url) {
  const user = url.searchParams.get('user') || '';
  if (!user) return json({ error: 'missing user' }, 400);
  const until = await kvGet(user);
  return json({ until: (until && until > Date.now()) ? until : 0 });
}

async function payCreate(request) {
  let body; try { body = await request.json(); } catch (e) { return json({ error: 'invalid json' }, 400); }
  const user = (body.user || '').trim(); const plan = body.plan || '6m';
  if (!user) return json({ error: '请先登录后再开通会员' }, 400);
  if (!PLAN_AMOUNT[plan]) return json({ error: '未知套餐' }, 400);
  const months = PLAN_MONTHS[plan], amount = PLAN_AMOUNT[plan];
  const outTradeNo = `SNT-${b64urlEncode(user)}-${months}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let wxQr = '', aliQr = '';
  const wxMch = payEnv('WX_MCH_ID'), wxAppid = payEnv('WX_APP_ID');
  if (wxMch && wxAppid && payEnv('WX_PRIVATE_KEY') && payEnv('WX_SERIAL')) {
    try {
      const path = '/v3/pay/transactions/native';
      const bodyObj = { mchid: wxMch, appid: wxAppid, description: '股票新闻追踪-会员' + months + '个月', out_trade_no: outTradeNo, notify_url: payEnv('WX_NOTIFY_URL') || (selfUrl(request) + '/pay/wx/notify'), amount: { total: amount, currency: 'CNY' } };
      const bodyStr = JSON.stringify(bodyObj);
      const auth = await wxAuthorization('POST', path, bodyStr);
      const resp = await fetch('https://api.mch.weixin.qq.com' + path, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': auth, 'Accept': 'application/json' }, body: bodyStr
      });
      const j = await resp.json().catch(() => ({}));
      if (j.code_url) wxQr = j.code_url;
    } catch (e) { /* 微信下单失败不影响支付宝 */ }
  }
  const aliAppid = payEnv('ALI_APP_ID');
  if (aliAppid && payEnv('ALI_PRIVATE_KEY')) {
    try {
      aliQr = await aliPrecreate({ outTradeNo, total: (amount / 100).toFixed(2), subject: '股票新闻追踪-会员' + months + '个月', notify: payEnv('ALI_NOTIFY_URL') || (selfUrl(request) + '/pay/ali/notify') });
    } catch (e) { /* 支付宝下单失败不影响微信 */ }
  }
  if (!wxQr && !aliQr) {
    const reasons = [];
    if (!(wxMch && wxAppid && payEnv('WX_PRIVATE_KEY'))) reasons.push('未配置微信支付商户号');
    if (!(aliAppid && payEnv('ALI_PRIVATE_KEY'))) reasons.push('未配置支付宝商户号');
    return json({ error: '支付未配置：' + (reasons.join('；') || '未知') + '。请在 Worker Variables 中填入商户密钥。' }, 503);
  }
  return json({ wxQr, aliQr, outTradeNo });
}

async function payWxNotify(request) {
  const ts = request.headers.get('Wechatpay-Timestamp');
  const nonce = request.headers.get('Wechatpay-Nonce');
  const sig = request.headers.get('Wechatpay-Signature');
  const pub = payEnv('WX_PLATFORM_CERT');
  const body = await request.text();
  if (pub && sig && ts && nonce) {
    const ok = await rsaVerify(pub, `${ts}\n${nonce}\n${body}\n`, sig);
    if (!ok) return json({ code: 'FAIL', message: 'sign verify failed' }, 400);
  }
  try {
    const data = JSON.parse(body);
    const res = data.resource || {};
    const key = payEnv('WX_APIV3_KEY');
    if (key && res.ciphertext) {
      const plain = await aesGcmDecrypt(key, res.nonce, res.ciphertext, res.associated_data || '');
      const obj = JSON.parse(plain);
      if (obj.trade_state === 'SUCCESS' && obj.out_trade_no) {
        const { user, months } = parseOutTradeNo(obj.out_trade_no);
        if (user && months) await kvSet(user, Date.now() + months * 30 * 24 * 3600 * 1000);
      }
    }
  } catch (e) { /* 解密/解析失败也返回 SUCCESS，避免微信重推风暴；可在日志侧排查 */ }
  return json({ code: 'SUCCESS', message: '成功' });
}

async function payAliNotify(request) {
  const text = await request.text();
  const params = new URLSearchParams(text);
  const map = {}; for (const [k, v] of params) map[k] = v;
  const pub = payEnv('ALI_PUBLIC_KEY');
  if (pub && map.sign) {
    const keys = Object.keys(map).filter(k => k !== 'sign' && k !== 'sign_type').sort();
    const str = keys.map(k => `${k}=${map[k]}`).join('&');
    const ok = await rsaVerify(pub, str, map.sign);
    if (!ok) return plain('failure');
  }
  const status = map.trade_status; const out = map.out_trade_no;
  if ((status === 'TRADE_SUCCESS' || status === 'TRADE_FINISHED') && out) {
    const { user, months } = parseOutTradeNo(out);
    if (user && months) await kvSet(user, Date.now() + months * 30 * 24 * 3600 * 1000);
  }
  return plain('success');
}

// ============ 平台热度股票排行榜（20261006h） ============

/** 同花顺热股榜：反代 dq.10jqka.com.cn，归一化为 {list:[{rank,code,name,heat,change,concepts}]} */
async function rankThs() {
  try {
    const upstream = await fetch('https://dq.10jqka.com.cn/fuyao/hot_list_data/out/hot_list/v1/stock?stock_type=a&type=hour&list_type=normal', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.10jqka.com.cn/' }
    });
    const j = await upstream.json();
    const list = (j && j.data && j.data.stock_list) || [];
    const out = list.slice(0, 30).map(it => ({
      rank: it.order != null ? it.order : 0,
      code: String(it.code || ''),
      name: it.name || '',
      heat: it.rate || '',
      change: it.rise_and_fall != null ? Number(it.rise_and_fall) : null,
      concepts: (it.tag && it.tag.concept_tag) || []
    }));
    return new Response(JSON.stringify({ list: out }), {
      status: 200,
      headers: withCors({ 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' })
    });
  } catch (e) {
    return json({ error: '同花顺热度榜获取失败：' + (e && e.message ? e.message : e) }, 502);
  }
}

/** 东方财富人气榜：POST emappdata.eastmoney.com，再用腾讯 qt.gtimg.cn 补全股票名称 */
async function rankEm() {
  try {
    const upstream = await fetch('https://emappdata.eastmoney.com/stockrank/getAllCurrentList', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://guba.eastmoney.com/' },
      body: JSON.stringify({ appId: 'gff', fields: '', secids: '', sortBy: '', sort: '', pageSize: '30', pageNumber: '1' })
    });
    const j = await upstream.json();
    const arr = (j && j.data) || [];
    const items = arr.map(d => {
      const sc = d.sc || '';
      const mkt = sc.slice(0, 2).toLowerCase();
      const cd = sc.slice(2);
      return { sc, mkt, cd, rank: d.rk };
    }).filter(x => x.cd);
    // 批量补全名称（腾讯 qt.gtimg.cn，单次请求）
    let nameMap = {};
    try {
      const q = items.map(x => x.mkt + x.cd).join(',');
      const qr = await fetch('https://qt.gtimg.cn/q=' + q, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      // 腾讯行情接口返回 GBK 编码，必须按字节解码，否则中文名称乱码（部署后实测出现 mojibake）
      const qrBuf = await qr.arrayBuffer();
      const txt = new TextDecoder('gbk').decode(new Uint8Array(qrBuf));
      txt.split(';').forEach(line => {
        const m = /v_(\w+)="([^"]*)"/.exec(line);
        if (m) { const f = m[2].split('~'); nameMap[m[1].toLowerCase()] = f[1] || ''; }
      });
    } catch (e) { /* 名称补全失败不阻断，回退用代码 */ }
    const out = items.map(x => ({
      rank: x.rank,
      code: x.cd,
      name: nameMap[(x.mkt + x.cd).toLowerCase()] || x.cd,
      heat: x.rank
    }));
    return new Response(JSON.stringify({ list: out }), {
      status: 200,
      headers: withCors({ 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' })
    });
  } catch (e) {
    return json({ error: '东方财富人气榜获取失败：' + (e && e.message ? e.message : e) }, 502);
  }
}

/** 豆包搜索热度榜：调豆包 Web 搜索 API（火山引擎联网搜索）。
 *  Key 优先级：请求头 X-Doubao-Key（普通用户自带 Key，各自消耗自己账户 500 次/月免费额度）
 *            > Worker 变量 DOUBAO_API_KEY（管理员共享额度）。两者皆空返回 503 友好提示。
 *  注意：用户 Key 只在本请求内透传给 feedcoopapi，不记录、不持久化。 */
async function rankDoubao(request) {
  const userKey = (request && request.headers) ? (request.headers.get('X-Doubao-Key') || '') : '';
  const userKeyTrim = (userKey || '').trim();
  const sharedKey = payEnv('DOUBAO_API_KEY');
  const key = userKeyTrim || sharedKey;
  const keySource = userKeyTrim ? 'user' : (sharedKey ? 'shared' : 'none');
  if (!key) {
    return json({ error: '豆包搜索未配置 Key：点面板上的「🔑 设置我的 API Key」填入你自己的火山引擎「联网搜索」Key，即可使用你账户每月 500 次免费额度；或等待管理员开通共享额度。', keySource: 'none' }, 503);
  }
  // 20261011p：支持 ?date=YYYY-MM-DD，使搜索按「所选日期当天」而非固定「今日」，满足「按日期当天的豆包搜索量排名」。
  // 未传或不合法时回退到「今日」（与旧行为一致，向后兼容）。
  let dateParam = '';
  try { const u = new URL(request.url); dateParam = (u.searchParams.get('date') || '').trim(); } catch (e) {}
  let query = 'A股 今日 股票 人气 热度 排行榜 前十';
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    const parts = dateParam.split('-');
    query = parts[0] + '年' + Number(parts[1]) + '月' + Number(parts[2]) + '日 A股 股票 人气 热度 排行榜 前十';
  }
  try {
    const r = await fetch('https://open.feedcoopapi.com/search_api/web_search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({ Query: query, SearchType: 'web', Count: 10, NeedContent: true, NeedUrl: true })
    });
    const data = await r.json().catch(() => ({}));
    // 豆包网关鉴权失败时常返回 200 + {ResponseMetadata:{Error:{CodeN:700901, Code:'invalid_api_key', Message:'invalid api key'}}, Result:null}
    const metaErr = (data && data.ResponseMetadata && data.ResponseMetadata.Error) || {};
    if (metaErr.CodeN || metaErr.Code || data.CodeN || data.code) {
      const msg = (metaErr.Message || metaErr.Code || data.Message || data.message || JSON.stringify(data)).toString().slice(0, 120);
      return json({ error: '豆包搜索 Key 无效（' + msg + '）。请确认填入的是火山引擎「联网搜索」控制台创建的 API Key，且不是方舟(ARK)的 ark- 开头 Key。', keySource }, 401);
    }
    const results = (data && data.Result && data.Result.WebResults) || [];
    const out = results.slice(0, 10).map((it, i) => ({
      rank: i + 1,
      title: it.Title || '',
      site: it.SiteName || '',
      url: it.Url || '',
      snippet: (it.Snippet || '').slice(0, 120)
    }));
    // 返回 date 字段，前端据此在面板展示「数据日期」（回退为请求日期或空）
    return new Response(JSON.stringify({ list: out, date: dateParam, keySource }), {
      status: 200,
      headers: withCors({ 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' })
    });
  } catch (e) {
    return json({ error: '豆包搜索请求失败：' + (e && e.message ? e.message : e), keySource }, 502);
  }
}

/** 广告投放排行榜（抖音 / 头条）：调豆包 Web 搜索 API（火山引擎联网搜索）。
 *  入参：?date=YYYY-MM-DD（可选，使搜索按「所选日期当天」而非固定「今日」）。
 *        Key 优先级：请求头 X-Doubao-Key（普通用户自带 Key，各自消耗自己账户 500 次/月免费额度）
 *                  > Worker 变量 DOUBAO_API_KEY（管理员共享额度）。两者皆空返回 503 友好提示。
 *  注意：用户 Key 只在本请求内透传给 feedcoopapi，不记录、不持久化。
 *  返回：{ douyin:[{title,site,url,snippet}], toutiao:[...], date, keySource }
 *        —— 前端据此用 getAllStockNames 抽取「上市公司」、按提及次数排名（非上市公司不计入）。 */
async function rankAdBoard(request) {
  const userKey = (request && request.headers) ? (request.headers.get('X-Doubao-Key') || '') : '';
  const userKeyTrim = (userKey || '').trim();
  const sharedKey = payEnv('DOUBAO_API_KEY');
  const key = userKeyTrim || sharedKey;
  const keySource = userKeyTrim ? 'user' : (sharedKey ? 'shared' : 'none');
  if (!key) {
    return json({ error: '广告排行榜未配置 Key：点面板上的「🔑 设置我的 API Key」填入你自己的火山引擎「联网搜索」Key，即可使用你账户每月 500 次免费额度；或等待管理员开通共享额度。', keySource: 'none' }, 503);
  }
  // 支持 ?date=YYYY-MM-DD，使搜索按「所选日期当天」而非固定「今日」（与 rankDoubao 一致）。
  let dateParam = '';
  try { const u = new URL(request.url); dateParam = (u.searchParams.get('date') || '').trim(); } catch (e) {}
  let dateStr = '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    const parts = dateParam.split('-');
    dateStr = parts[0] + '年' + Number(parts[1]) + '月' + Number(parts[2]) + '日';
  }
  const platforms = [
    { key: 'douyin', name: '抖音' },
    { key: 'toutiao', name: '头条' }
  ];
  const out = {};
  try {
    for (const p of platforms) {
      // 搜索语义：在「所选平台」上「广告投放」且涉及「上市公司」；日期命中则拼接「YYYY年M月D日」。
      const query = p.name + ' 广告投放 上市公司' + (dateStr ? ' ' + dateStr : '');
      const r = await fetch('https://open.feedcoopapi.com/search_api/web_search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({ Query: query, SearchType: 'web', Count: 10, NeedContent: true, NeedUrl: true })
      });
      const data = await r.json().catch(() => ({}));
      // 豆包网关鉴权失败时常返回 200 + {ResponseMetadata:{Error:{...}}, Result:null}
      const metaErr = (data && data.ResponseMetadata && data.ResponseMetadata.Error) || {};
      if (metaErr.CodeN || metaErr.Code || data.CodeN || data.code) {
        const msg = (metaErr.Message || metaErr.Code || data.Message || data.message || JSON.stringify(data)).toString().slice(0, 120);
        return json({ error: '豆包搜索 Key 无效（' + msg + '）。请确认填入的是火山引擎「联网搜索」控制台创建的 API Key，且不是方舟(ARK)的 ark- 开头 Key。', keySource }, 401);
      }
      const results = (data && data.Result && data.Result.WebResults) || [];
      out[p.key] = results.slice(0, 10).map((it, i) => ({
        rank: i + 1,
        title: it.Title || '',
        site: it.SiteName || '',
        url: it.Url || '',
        snippet: (it.Snippet || '').slice(0, 200)
      }));
    }
    return new Response(JSON.stringify({ douyin: out.douyin || [], toutiao: out.toutiao || [], date: dateParam, keySource }), {
      status: 200,
      headers: withCors({ 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' })
    });
  } catch (e) {
    return json({ error: '广告排行榜请求失败：' + (e && e.message ? e.message : e), keySource }, 502);
  }
}

/**
 * 广告投放力度榜（按上市公司「销售费用」排名，免费·准确）。
 * -----------------------------------------------------------------------------
 * 为什么用「销售费用」而不是搜索引擎：
 *   - 抖音/头条的真正投放数据归字节跳动私有（巨量引擎/巨量纵横），是付费数据；
 *     第三方广告监测（App Growing、蝉妈妈、飞瓜）也是付费的。免费渠道拿不到「真实的平台投放额」。
 *   - 搜索引擎搜不到「谁正在投广告」（广告不是网页，不被收录），搜出来的只是财经媒体的「XX概念股」分类文章。
 *   - 因此用「上市公司财报披露的销售费用（SALE_EXPENSE，审计过的真实数字）」作为最准确的免费代理：
 *     抖音/头条是当下国内最大的效果广告渠道，重投放公司几乎都在这两个平台投流，谁销售费用高谁就是你在抖音/头条看到的广告主。
 * 数据源：东财数据中心利润表 RPT_DMSK_FN_INCOME（仅取有 SALE_EXPENSE 科目的公司，银行/公用事业等本身不报销售费用属正常）。
 * 计算：拉取最新期全量 → 按 SECUCODE 取最新报告期 → 过滤 null → 按 SALE_EXPENSE 降序 → Top50。结果缓存 6 小时。
 */
async function rankAdSpend(request) {
  try {
    const CACHE_KEY = 'https://sichina.dpdns.org/rank/adspend';
    const cache = caches.default;
    let cached = await cache.match(CACHE_KEY);
    if (cached) return cached;

    const B = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
    const cols = 'SECUCODE,SECURITY_NAME_ABBR,REPORT_DATE,TOTAL_OPERATE_INCOME,SALE_EXPENSE';
    const hdrs = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://emweb.securities.eastmoney.com/' };
    // 并行拉取前 10 页（每页 500，按报告期倒序 → 最新期在前；覆盖 ~5000 家最新期去重足够）
    const pages = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        fetch(B + '?reportName=' + encodeURIComponent('RPT_DMSK_FN_INCOME') +
          '&columns=' + encodeURIComponent(cols) +
          '&pageSize=500&pageNumber=' + (i + 1) +
          '&sortColumns=REPORT_DATE&sortTypes=-1&source=WEB&client=WEB', { headers: hdrs })
          .then(r => r.json().catch(() => ({})))
          .then(j => (j && j.result && j.result.data) || [])
          .catch(() => [])
      )
    );
    const seen = new Map();
    for (const d of pages) {
      for (const x of d) { if (x && x.SECUCODE && !seen.has(x.SECUCODE)) seen.set(x.SECUCODE, x); }
    }
    const arr = [...seen.values()]
      .filter(x => x.SALE_EXPENSE != null)
      .sort((a, b) => b.SALE_EXPENSE - a.SALE_EXPENSE);
    const list = arr.slice(0, 50).map((x, i) => ({
      rank: i + 1,
      code: x.SECUCODE,
      name: x.SECURITY_NAME_ABBR,
      saleExpense: x.SALE_EXPENSE,            // 元
      operateIncome: x.TOTAL_OPERATE_INCOME,  // 元（可能为 null）
      reportDate: (x.REPORT_DATE || '').slice(0, 10)
    }));
    const body = JSON.stringify({
      list,
      count: arr.length,
      generatedAt: new Date().toISOString(),
      note: '按上市公司最新财报「销售费用」排名（免费·源自东财利润表 SALE_EXPENSE）；抖音/头条为当前最大广告渠道，重投放公司多在此投流'
    });
    const resp = new Response(body, {
      status: 200,
      headers: withCors({ 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=21600' })
    });
    await cache.put(CACHE_KEY, resp.clone());
    return resp;
  } catch (e) {
    return json({ error: '广告投放力度榜计算失败：' + (e && e.message ? e.message : e) }, 502);
  }
}
