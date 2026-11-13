/* ============================================================
 * fetch-hot-topics.mjs — 每日定时抓取 11 个金融软件 Top10 热点
 * 供 GitHub Action 使用：结果写入 data/hot-topics/YYYY-MM-DD.json
 * 复用 js/hot-topics.js 的分类与来源配置（单一数据源）。
 * 用法：node scripts/fetch-hot-topics.mjs [YYYY-MM-DD]
 * ============================================================ */
import { writeFileSync, readFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import ht from '../js/hot-topics.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
/** 快照保留天数（与前端 HT_SNAPSHOT_KEEP_DAYS 保持一致） */
const HT_SNAPSHOT_KEEP_DAYS = 60;
/** 格隆汇快讯保留天数：单日约 0.45MB，比热点快照大，单独控制以约束仓库体积 */
const BRIEF_KEEP_DAYS = 30;
/** 每个站点抓取并保留的热点条数。
 * batch16：以前固定 10 条，用户反馈「统计的还是前 10 个」；
 * 现在提高到 50 条，让跨站重合榜 / 主题分类统计能覆盖时间段内的更多实时快讯。
 */
const HOT_TOPN = 50;

/** 单条快讯正文最大保留字符数（快讯正文通常在 100~300 字，超长多为转载长文） */
const BRIEF_TEXT_MAX = 500;

/** 取「今天」：一律��北京时间（UTC+8），不跟随运行器本地时区。
 *  GitHub Actions 运行器是 UTC，而定时任务每 2 小时一次，
 *  其中 UTC 22:00（= 北京时间次日 06:00）那一跑，若按 UTC 判日期会认为"今天"是前一天，
 *  进而把当天早上的实时榜单写进前一天的快照文件，污染历史数据。 */
function todayStr(d = new Date()) {
  const bj = new Date(d.getTime() + 8 * 3600 * 1000);
  const y = bj.getUTCFullYear(), m = String(bj.getUTCMonth() + 1).padStart(2, '0'), day = String(bj.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
const DATE = process.argv[2] || todayStr();

/* 20261113a：Unix 秒/毫秒一律换算成**北京时间**。
 * 旧版直接 toISOString() 输出 UTC，比真实发生时刻早整整 8 小时：
 * 上午 9 点的快讯被写成凌晨 1 点，落在「新闻统计开始时间」窗口外被整批丢弃，
 * 表现为「这个平台没有新闻」。bjStr 在文件后半段定义（函数声明提升，此处可直接调用）。 */
function normTime(t) {
  if (t == null) return '';
  t = String(t).trim();
  if (/^\d{10}$/.test(t)) return bjStr(+t);
  if (/^\d{13}$/.test(t)) return bjStr(+t / 1000);
  return t.replace('T', ' ').slice(0, 16);
}

/** 本次抓取时刻（北京，精确到分钟）。源站确实不提供发布时间时，
 *  用它作为「观测时刻」并标 timeKind:'observed'，不冒充新闻发布时间。 */
function observedBjNow() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
}
const OBSERVED_AT = observedBjNow();
const OBSERVED_DATE = OBSERVED_AT.slice(0, 10);

/** 日期字符串 ±N 天 */
function dayShift(dateStr, delta) {
  return new Date(Date.parse(dateStr + 'T00:00:00Z') + delta * 86400000).toISOString().slice(0, 10);
}
/** 从新闻 URL 里取发布日期（中证网 /2026/11/13/、/20261113/ 两种形态） */
function timeFromUrlDate(url) {
  const s = String(url || '');
  let m = s.match(/\/(20\d{2})[\/-](\d{1,2})[\/-](\d{1,2})\//);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/(20\d{2})(\d{2})(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return OBSERVED_DATE;
}
/** 页面只给 HH:mm 时，与日期拼成 'YYYY-MM-DD HH:mm'；
 *  若该时刻晚于当前时刻 10 分钟以上，判为前一天的条目（如昨夜 21:26 的稿子）。 */
function htmlItemTime(dateStr, hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return '';
  let d = /^\d{4}-\d{2}-\d{2}$/.test(dateStr || '') ? dateStr : OBSERVED_DATE;
  const cur = OBSERVED_AT.slice(11);
  const nowMin = (+cur.slice(0, 2)) * 60 + (+cur.slice(3, 5));
  const itMin = (+m[1]) * 60 + (+m[2]);
  if (d === OBSERVED_DATE && itMin > nowMin + 10) d = dayShift(d, -1);
  return `${d} ${m[1].padStart(2, '0')}:${m[2]}`;
}
/** 上海证券报 __NEXT_DATA__.pubTime：仅接受能精确到分钟的「N分钟/小时/天前」；
 *  只有月日或日期的相对时间无法证明发生时刻，返回 '' 交由观测时刻兜底。 */
function cnstockPubTime(p) {
  const s = String(p || '').trim();
  const m = s.match(/^(\d+)\s*(分钟|小时|天)前$/);
  if (!m) return '';
  const n = +m[1];
  const ms = m[2] === '分钟' ? n * 60000 : (m[2] === '小时' ? n * 3600000 : n * 86400000);
  return new Date(Date.now() - ms + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

/** 统一把 HTTP 响应文本转成解析器可用的 payload：
 *  · html_* 原样返回字符串；· 纯 JSON 直接 parse；
 *  · 东财 `var ajaxResult={...}` 这类 JS 赋值，剥掉外壳再 parse；
 *  · 都不成（一般是 HTML 兜底页）返回原字符串，由调用方改用通用 HTML 抽取。 */
function toPayload(txt, parse) {
  if (typeof txt !== 'string') return txt;
  const t = txt.replace(/^\uFEFF/, '').trim();
  if (!t) return null;
  if (parse && parse.indexOf('html_') === 0) return t;
  try { return JSON.parse(t); } catch (e) { /* 可能是 JSONP */ }
  const start = t.search(/[{[]/);
  const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (start >= 0 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch (e) { /* 落到 HTML 兜底 */ }
  }
  return t;
}

function decodeBuffer(buf, enc) {
  try { return new TextDecoder(enc, { fatal: false }).decode(buf); }
  catch (e) { return buf.toString('utf8'); }
}
const countBad = s => { const m = s.match(/\uFFFD/g); return m ? m.length : 0; };

/** 智能解码：优先 UTF-8，若出现替换字符（乱码）则改用 GBK，取更干净的一版。
 *  国内财经站点（如同花顺）多为 GBK，海外 runner ���必须显式转码。 */
function decodeSmart(buf, encoding) {
  if (encoding) return decodeBuffer(buf, encoding);
  const utf8 = decodeBuffer(buf, 'utf-8');
  if (countBad(utf8) === 0) return utf8;
  const gbk = decodeBuffer(buf, 'gbk');
  return countBad(gbk) < countBad(utf8) ? gbk : utf8;
}

/** 超时包装：用 Promise.race 而非 AbortController.signal，兼容 Node 20/22（部分 Node 22 构建里
 *  fetch 不认全局 AbortController 实例，会抛 "member signal is not of type AbortSignal"）。 */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout: ' + label)), ms))
  ]);
}

/** 请求R：部分源站校验自定义请求头（金十需 x-app-id / x-version），否则直接 403。 */
const SRC_HEADERS = {
  json_jin10: { 'x-app-id': 'SO1EJGmNgCtmpcPF', 'x-version': '1.0.0', Referer: 'https://flash.jin10.com/' },
  json_sina: { Referer: 'https://finance.sina.com.cn/7x24/' }
};

async function fetchText(url, { timeout = 8000, isJson = false, encoding = '', headers: extraHeaders = null } = {}) {
  let resp;
  try {
    resp = await withTimeout(fetch(url, {
      headers: Object.assign({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json,text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      }, extraHeaders || {})
    }), timeout, url);
  } catch (e) {
    throw new Error((e && e.message) || 'fetch failed');
  }
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  if (isJson) return await resp.json();
  const buf = Buffer.from(await resp.arrayBuffer());
  let text = decodeSmart(buf, encoding);
  return text.replace(/^\uFEFF/, '');
}

/* 20261113a：HTML 兜底页会混进行情导航 / 刷新提示（旧东财快照里的
 * 「纳斯达克综合指数」「60秒后刷新」等），它们不是新闻，必须挡在落库之前。 */
const JUNK_TITLE_RE = /^(?:60秒后刷新|刷新页面|加载中|行情中心|.{0,8}(?:综合指数|工业平均指数|成份指数|指数报价))$/;
function mkItem(text, time, url) {
  const t = ht.cleanTitle(text);
  if (!t || JUNK_TITLE_RE.test(t)) return null;
  return { text: t, time: normTime(time), url: url || '', cat: ht.classify(t) };
}

/* 20261113c：上海证券报首页 __NEXT_DATA__ 会混入专题 / 专栏 / 观察家 / 创业故事 /
 * 特刊 / 研选 / 招聘 等非快讯类别（源站甚至把一条社会招聘广告误标在「快讯」channel 下），
 * 这些不是「热点 / 快讯 / 24h」新闻，必须剔除。同时用于解析期与「累积合并」期，
 * 确保即便历史快照里残留的旧条目也会被清掉。 */
const CNSTOCK_BLOCK_CAT = new Set(['专题', '专栏', '观察家', '创业故事', '特刊', '聚焦', '研选']);
const CNSTOCK_BLOCK_TITLE = /^(?:专题|上证聚焦|上证观察家|创业故事|直面掌门人|聚贤才|社会招聘|招聘|诚聘|招贤|招募|特刊|研选|每日研选|创刊|公益行动|论坛|年会|大奖|直播|视频)/;
/** 判断一条上海证券报标题是否属于应剔除的非快讯类别 */
function isCnstockBlocked(text) {
  const t = String(text || '');
  return CNSTOCK_BLOCK_CAT.has((t && t.nodeInfo && t.nodeInfo.name) || '') || CNSTOCK_BLOCK_TITLE.test(t);
}

function parseSource(parse, key, payload) {
  const out = [];
  const push = (text, time, url) => { const it = mkItem(text, time, url); if (it) out.push(it); };
  const html = typeof payload === 'string' ? payload : '';

  /* ---------- 20261113a：返回真实发布时间的解析器 ---------- */
  if (parse === 'json_gh_live') {
    // 格隆汇 v4 live：createTimestamp（Unix 秒）→ 北京时间，content 为快讯正文
    const arr = (payload && payload.result) || (Array.isArray(payload) ? payload : []);
    for (const it of arr.slice(0, HOT_TOPN)) {
      push(String(it.content || it.title || '').replace(/<[^>]*>/g, ''),
        bjStr(it.createTimestamp || it.updateTimestamp),
        it.route || 'https://www.gelonghui.com/live');
    }
  } else if (parse === 'json_ths_push') {
    // 同花顺 7×24 push：data.list[].ctime（Unix 秒）
    const arr = (payload && payload.data && payload.data.list) || (payload && payload.list) || [];
    for (const it of arr.slice(0, HOT_TOPN)) {
      push(it.title || it.digest, bjStr(it.ctime || it.rtime), it.url || it.shareUrl || '');
    }
  } else if (parse === 'jsonp_eastmoney') {
    // 东方财富 ajaxResult：LivesList[].showtime（'YYYY-MM-DD HH:mm:ss'）
    const arr = (payload && payload.LivesList) || (payload && payload.data && payload.data.list) || [];
    for (const it of arr.slice(0, HOT_TOPN)) {
      push([it.title, it.digest].filter(Boolean).join('：'),
        normTime(it.showtime || it.showTime || it.ordertime),
        it.url_unique || it.url_w || '');
    }
  } else if (parse === 'json_sina_roll') {
    // 新浪财经滚动：result.data[].ctime（Unix 秒），Action 已验证该域名可达
    const arr = (payload && payload.result && payload.result.data) || (payload && payload.data) || [];
    for (const it of (Array.isArray(arr) ? arr : []).slice(0, HOT_TOPN)) {
      push(it.title || it.stitle || it.summary, bjStr(it.ctime || it.intime),
        it.url || it.wapurl || 'https://finance.sina.com.cn/');
    }
  } else if (parse === 'html_cnstock_next') {
    // 上海证券报 __NEXT_DATA__：只取「新闻 / 快讯 / 要闻」类条目（见模块顶部 CNSTOCK_BLOCK_* 说明）。
    const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (m) {
      try {
        const seenObj = new Set();
        const walk = (v) => {
          if (!v || typeof v !== 'object' || seenObj.has(v)) return;
          seenObj.add(v);
          if (typeof v.name === 'string' && v.pubTime) {
            const t = String(v.name);
            if (!CNSTOCK_BLOCK_CAT.has((v.nodeInfo && v.nodeInfo.name) || '') && !CNSTOCK_BLOCK_TITLE.test(t)) {
              const tt = cnstockPubTime(v.pubTime);
              if (tt) push(t, tt, v.link || ('https://www.cnstock.com/commonDetail/' + (v.contId || '')));
            }
          }
          for (const k of Object.keys(v)) walk(v[k]);
        };
        walk(JSON.parse(m[1]));
      } catch (e) { /* 结构变化则由 fetchSource 回退通用 HTML 抽取 */ }
    }
  } else if (parse === 'html_stcn_timed') {
    // 证券时报：<li> 内 <span>HH:mm</span> + <a href="/article/detail/...">标题</a>
    const pageDate = (html.match(/（\s*(20\d{2}-\d{2}-\d{2})[^）]*）/) || [])[1] || OBSERVED_DATE;
    const blocks = html.split(/<li\b/i).slice(1);
    for (const b of blocks) {
      if (out.length >= HOT_TOPN) break;
      const a = b.match(/<a[^>]*href=["']([^"']*\/article\/detail\/\d+\.html)["'][^>]*>([\s\S]{4,200}?)<\/a>/i);
      const hm = b.match(/<span[^>]*>\s*(\d{1,2}:\d{2})\s*<\/span>/);
      if (!a || !hm) continue;
      const u = /^https?:/i.test(a[1]) ? a[1] : ('https://www.stcn.com' + a[1]);
      push(String(a[2]).replace(/<[^>]*>/g, ''), htmlItemTime(pageDate, hm[1]), u);
    }
  } else if (parse === 'html_cs_timed') {
    // 中证网：<em>HH:mm</em> + <a href=".../YYYY/MM/DD/...">，日期来自 URL
    const re = /<em>\s*(\d{1,2}:\d{2})\s*<\/em>\s*<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{4,200}?)<\/a>/gi;
    let mm;
    while ((mm = re.exec(html)) && out.length < HOT_TOPN) {
      const d = timeFromUrlDate(mm[2]);
      push(String(mm[3]).replace(/<[^>]*>/g, ''), htmlItemTime(d, mm[1]), mm[2]);
    }
  } else if (parse === 'news_eastmoney') {
    // Node 直连东财 7×24 公开接口（浏览器走 Worker /news）
    let list = [];
    if (Array.isArray(payload)) list = payload;
    else if (payload && payload.r) list = payload.r;
    else if (payload && payload.data && payload.data.list) list = payload.data.list;
    for (const it of (list || []).slice(0, HOT_TOPN)) push([it.title, it.summary].filter(Boolean).join('：'), it.showTime, it.uniqueUrl || '');
  } else if (parse === 'json_toutiao') {
    const arr = (payload && payload.data) || [];
    for (const it of arr.slice(0, HOT_TOPN)) {
      let u = it.Url || '';
      if (u && !/^https?:/i.test(u)) u = 'https://www.toutiao.com/' + u.replace(/^\//, '');
      push(it.Title || it.title, '', u);
    }
  } else if (parse === 'json_wscn') {
    // 请求T：华尔街见闻旧接口域名已下线（连接超时），改用 api-one + channel=global-channel（同 js/stock-api.js）
    // ① uri 已是完整 https://wallstreetcn.com/livenews/<id>，不能再在前面拼域名；② content 是 HTML，兜底时先去标签
    const arr = (payload && payload.data && payload.data.items) || [];
    for (const it of arr.slice(0, HOT_TOPN)) {
      let u = String(it.uri || '').trim();
      if (u && !/^https?:/i.test(u)) u = (u.indexOf('//') === 0) ? ('https:' + u) : ('https://wallstreetcn.com/' + u.replace(/^\//, ''));
      push(it.content_text || it.title || String(it.content || '').replace(/<[^>]*>/g, ''), it.display_time, u || 'https://wallstreetcn.com/');
    }
  } else if (parse === 'json_sina') {
    // 请求R：新浪财经 7x24 实时新闻 → result.data.feed.list[]，字段 rich_text / create_time / docurl
    let arr = (payload && payload.result && payload.result.data && payload.result.data.feed && payload.result.data.feed.list)
      || (payload && payload.data && payload.data.feed && payload.data.feed.list)
      || (payload && payload.data && payload.data.list) || (payload && payload.result && payload.result.list)
      || (Array.isArray(payload) ? payload : []);
    if (!Array.isArray(arr)) arr = [];
    for (const it of arr.slice(0, HOT_TOPN)) push(it.rich_text || it.content || it.title || it.text, it.create_time || it.time || it.ctime, it.docurl || it.url || 'https://finance.sina.com.cn/7x24/');
  } else if (parse === 'json_jin10') {
    // 请求R：金十数据实时快讯 → data[]（或 data.items[]），字段 time / data.content / data.title / id
    let arr = Array.isArray(payload) ? payload : (Array.isArray(payload && payload.data) ? payload.data : ((payload && payload.data && payload.data.items) || []));
    if (!Array.isArray(arr)) arr = [];
    for (const it of arr.slice(0, HOT_TOPN)) push((it.data && (it.data.content || it.data.title)) || it.content || it.title, it.time || it.ctime, it.id ? ('https://flash.jin10.com/detail/' + it.id) : 'https://flash.jin10.com/');
  } else if (parse === 'json_gelonghui') {
    const arr = (payload && payload.result && payload.result.data) || (payload && payload.data) || [];
    for (const it of arr.slice(0, HOT_TOPN)) push(it.content || it.title || it.text, it.created_at || it.time, 'https://www.gelonghui.com/');
  } else if (parse === 'json_cls') {
    /* 20261108e：财联社 7×24 滚动电报 → data.roll_data[]。
     * ctime 是 Unix 秒，必须显式 +8h 换成北京时间字符串；若直接交给 normTime 会按 UTC 输出，
     * 比实际早 8 小时，进而被「新闻统计开始时间」窗口误杀。 */
    const arr = (payload && payload.data && payload.data.roll_data)
      || (payload && payload.data && payload.data.depth_list) || [];
    for (const it of arr.slice(0, HOT_TOPN)) {
      const text = it.title || it.brief || String(it.content || '').replace(/<[^>]*>/g, '');
      const ts = Number(it.ctime || it.time || 0);
      const time = ts >= 1e9 && ts < 1e11
        ? new Date((ts + 8 * 3600) * 1000).toISOString().slice(0, 16).replace('T', ' ')
        : (it.time || '');
      const u = it.id ? ('https://www.cls.cn/detail/' + it.id) : 'https://www.cls.cn/telegraph';
      push(text, time, u);
    }
  } else if (parse && parse.startsWith('html_')) {
    // HTML 兜底：剥离脚本/样式/注释后，正则抽取正文标题链接
    const html = String(payload || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ');
    const base = (ht.SOURCE_BY_KEY && ht.SOURCE_BY_KEY[key] && ht.SOURCE_BY_KEY[key].base) || '';
    const normUrl = (u) => {
      u = (u || '').trim();
      if (!u || /^javascript:/i.test(u) || u.startsWith('#')) return '';
      if (/^https?:/i.test(u)) return u;
      if (u.startsWith('//')) return 'https:' + u;
      if (u.startsWith('/') && base) return base + u;
      return base ? (base + '/' + u.replace(/^\//, '')) : u;
    };
    const re = /<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]{6,160}?)<\/a>/gi;
    let m; const seen = new Set(); let scanned = 0;
    while ((m = re.exec(html))) {
      if (out.length >= HOT_TOPN || ++scanned > 600) break;   // 扫描全页候选，过滤后取前 10
      const t = ht.cleanTitle(m[2]);
      if (!t || seen.has(t)) continue;
      seen.add(t);
      push(t, '', normUrl(m[1]));
    }
  } else if (payload && typeof payload === 'object') {
    const arr = payload.data || payload.result || payload.list || payload.items || (payload.data && payload.data.list) || [];
    if (Array.isArray(arr)) {
      for (const it of arr.slice(0, HOT_TOPN)) {
        if (typeof it === 'string') push(it);
        else push(it.title || it.text || it.content || it.summary || it.subject || it.digest || it.intro, it.time || it.ctime || it.created_at, it.url || it.link || it.uri);
      }
    }
  }
  // 去重
  const seen2 = new Set();
  return out.filter(it => { if (seen2.has(it.text)) return false; seen2.add(it.text); return true; });
}

/** 抓单个源（20261113a 重写）：
 *  ① 优先 s.timed —— 返回真实发布时间的接口（东财 404 / 境外 fetch failed 的老端点已替换）；
 *  ② 时间源整体失败时自动回退原 endpoint/parse + 候选端点；
 *  ③ 不论走哪条路径，产出的每条都必须有 time：源站确实不给发布时间的，
 *     补「本次观测时刻」并标 timeKind:'observed'，绝不把旧闻伪装成今天新发。
 *  这样 11 个平台不会因为「无精确时间」在任意时间窗口里整批消失。 */
async function fetchSource(s) {
  const legacyTimeout = Number(s.timeout) || 8000;
  const groups = [];
  if (s.timed) {
    groups.push({
      label: '时间源',
      parse: s.timed.parse,
      timeout: Number(s.timed.timeout) || legacyTimeout,
      headers: s.timed.headers || null,
      urls: [s.timed.endpoint, ...(Array.isArray(s.timed.fallbacks) ? s.timed.fallbacks : [])].filter(Boolean)
    });
  }
  groups.push({
    label: '原端点',
    parse: s.parse,
    timeout: legacyTimeout,
    headers: SRC_HEADERS[s.parse] || null,
    urls: [s.endpoint, ...(Array.isArray(s.fallbacks) ? s.fallbacks : [])]
      .concat(s.fallback ? [s.fallback] : []).filter(Boolean)
  });

  let items = [];
  for (const g of groups) {
    for (let i = 0; i < g.urls.length; i++) {
      const url = g.urls[i];
      try {
        const txt = await fetchText(url, { headers: g.headers, timeout: g.timeout });
        const payload = toPayload(txt, g.parse);
        // 返回的是 HTML 兜底页（如东财首页）时改走通用 HTML 抽取，否则 JSON 解析器会得 0 条
        const useParse = (typeof payload === 'string' && /^\s*</.test(payload) && !/^html_/.test(g.parse))
          ? 'html_body' : g.parse;
        const got = parseSource(useParse, s.key, payload);
        if (got.length > items.length) items = got;
        if (items.length >= 3) break;
      } catch (e) {
        console.warn(`  [${s.name}] ${g.label} 端点 ${i + 1}/${g.urls.length} 失败: ${e.message}`);
      }
    }
    if (items.length >= 3) break;
  }
  /* runId = 本轮抓取标识，供 main() 区分「本轮真实观测到的条目」与
   * 旧版本快照里遗留的无时间条目（后者不能再被补成现在的时间）。 */
  return items.map(it => ({
    ...(it.time ? it : { ...it, time: OBSERVED_AT, timeKind: 'observed' }),
    runId: OBSERVED_AT
  }));
}

/** 从最近 N 天快照里取某源的历史条目：仅当「本次 + 当日累积」全为空时兜底，
 *  避免境外 IP 被源站拦截时该平台长期 0 条（20261108e 证券时报）。 */
function prevDateStr(date, days) {
  return new Date(Date.parse(date + 'T00:00:00Z') - days * 86400000).toISOString().slice(0, 10);
}
function fallbackItemsFromRecent(dir, key, date, maxDays = 14) {
  for (let i = 1; i <= maxDays; i++) {
    const d = prevDateStr(date, i);
    try {
      const p = JSON.parse(readFileSync(join(dir, d + '.json'), 'utf8'));
      const s = (p.sources || []).find(x => x.key === key);
      if (s && Array.isArray(s.items) && s.items.length) {
        /* 20261113a：历史快照里大量条目无 time，直接继承会被时间窗硬约束永久排除，
         * 表现就是这个平台长期空白。用「该快照生成时刻」作为可核查的观测时刻，
         * 标 timeKind:'inherited-observed'：既不臆造发布时间，也不把旧闻写成今天新发。 */
        const observedAt = p.generatedAt
          ? new Date(Date.parse(p.generatedAt) + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ')
          : (d + ' 12:00');
        return s.items.slice(0, HOT_TOPN)
          .filter(it => !JUNK_TITLE_RE.test(String(it.text || '')))
          .map(it => it.time
            ? it
            : { ...it, time: observedAt, timeKind: 'inherited-observed' });
      }
    } catch (e) { /* 该日无快照，继续往前找 */ }
  }
  return [];
}

/* ============================================================
 * 格隆汇每日快讯（全量）
 * 快讯页 https://www.gelonghui.com/live 的 SSR 首屏只有 15 条，
 * 完整列表走接口：/api/live-channels/all/lives/v4?category=all&liveId=<游标>&limit=15
 * 游标取上一页最小 id（服务端固定每页 15 条，limit 参数无效）。
 * 单日约 760~1000 条，落到 data/hot-topics/briefs-YYYY-MM-DD.json。
 * ============================================================ */
const GH_BRIEF_API = 'https://www.gelonghui.com/api/live-channels/all/lives/v4';
const GH_BRIEF_MAX_PAGES = 140;   // 上限 2100 条，足够覆盖单日
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/** Unix 秒 → 北京时间 "YYYY-MM-DD HH:mm" */
function bjStr(ts) {
  if (!ts) return '';
  return new Date((Number(ts) + 8 * 3600) * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

async function ghGetJson(url) {
  let r;
  try {
    r = await withTimeout(fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://www.gelonghui.com/live',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      }
    }), 10000, url);
  } catch (e) {
    throw new Error((e && e.message) || 'fetch failed');
  }
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return await r.json();
}

function mkBrief(it) {
  const text = String(it.content || it.title || '')
    .replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, BRIEF_TEXT_MAX);
  if (!text) return null;
  return {
    id: it.id,
    time: bjStr(it.createTimestamp),
    text,
    url: it.route || '',
    stocks: (it.relatedStocks || []).map(s => `${s.name}(${s.code})`).filter(Boolean).slice(0, 4),
    subjects: (it.relatedInfos || []).map(s => s.name).filter(Boolean).slice(0, 4),
    cat: ht.classify(text)
  };
}

/** 抓取指定日期（北京时区）的全部快讯；knownMaxId 用于增量（已抓过的不再重复翻页） */
async function fetchGelonghuiBriefs(date, knownMaxId) {
  const dayStart = Math.floor(Date.parse(`${date}T00:00:00+08:00`) / 1000);
  const dayEnd = dayStart + 86400;
  const out = [];
  let cursor = null;
  for (let page = 0; page < GH_BRIEF_MAX_PAGES; page++) {
    const url = `${GH_BRIEF_API}?category=all${cursor ? '&liveId=' + cursor : ''}&limit=15&timestamp=${Date.now()}`;
    let arr = [];
    try {
      const j = await ghGetJson(url);
      arr = (j && j.result) || [];
    } catch (e) {
      console.warn(`  [格隆汇快讯] 第 ${page + 1} 页失败: ${e.message}`);
      break;
    }
    if (!arr.length) break;
    let oldest = Infinity; let allKnown = true;
    for (const it of arr) {
      const ts = it.createTimestamp || 0;
      if (ts) oldest = Math.min(oldest, ts);
      if (!knownMaxId || it.id > knownMaxId) allKnown = false;
      if (ts < dayStart || ts >= dayEnd) continue;   // 只保留目标日
      const b = mkBrief(it);
      if (b) out.push(b);
    }
    cursor = Math.min(...arr.map(x => x.id));
    if (oldest < dayStart) break;                    // 已翻到目标日之前
    if (knownMaxId && allKnown) break;               // 增量：本页都抓过了
    await new Promise(r => setTimeout(r, 180));
  }
  return out;
}

/** 今日头条热榜（实时热榜，无历史回溯，仅当天有意义）。
 *  接口：https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc
 *  返回 data[].Title / data[].Url；无时间戳，落库时用北京时间"现在"作为 time。 */
const TT_HOT_URL = 'https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc';
const TT_SOURCE = 'toutiao';
const TT_SOURCE_NAME = '今日头条';
async function fetchToutiaoBriefs() {
  let r;
  try {
    r = await withTimeout(fetch(TT_HOT_URL, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://www.toutiao.com/',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      }
    }), 10000, TT_HOT_URL);
  } catch (e) {
    throw new Error((e && e.message) || 'fetch failed');
  }
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const arr = (j && j.data) || [];
  const nowBj = bjStr(Math.floor(Date.now() / 1000));
  const out = [];
  arr.forEach((it, idx) => {
    const title = ht.cleanTitle(it.Title || it.title || '');
    if (!title) return;
    const u = String(it.Url || it.url || '').trim();
    const url = /^https?:/i.test(u) ? u : '';
    const m = url.match(/trending\/(\d+)/);
    const id = m ? ('tt-' + m[1]) : ('tt-' + idx + '-' + Date.now());
    out.push({
      id,
      time: nowBj,
      text: title.slice(0, BRIEF_TEXT_MAX),
      url,
      stocks: [],
      subjects: [],
      cat: (ht.classify ? ht.classify(title) : '')
    });
  });
  return out;
}

/** 新浪财经 7×24 滚动快讯（带真实发布时间戳，可按时间段精确过滤）。
 *  接口：https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2516&num=50&page=N
 *  返回 result.data[].title / .ctime(Unix秒) / .url / .wapurl / .media_name。
 *  分页抓取：每页 num=50，page 递增直到末页（返回不足 num 即末页），
 *  去掉原先"只取一页 50 条"的人为上限，使「按时间段统计」能覆盖全天滚动快讯。 */
const SINA_BRIEF_BASE = 'https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2516&num=50';
const SINA_BRIEF_MAX_PAGES = 24;   // 24 页 × 50 = 最多 1200 条，足够覆盖全天
const SINA_SOURCE = 'sina';
const SINA_SOURCE_NAME = '新浪财经';
async function fetchSinaBriefs() {
  const out = [];
  const seen = new Set();
  for (let page = 1; page <= SINA_BRIEF_MAX_PAGES; page++) {
    const url = `${SINA_BRIEF_BASE}&page=${page}&k=&r=${Date.now()}`;
    let r;
    try {
      r = await withTimeout(fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json, text/plain, */*',
          'Referer': 'https://finance.sina.com.cn/',
          'Accept-Language': 'zh-CN,zh;q=0.9'
        }
      }), 10000, url);
    } catch (e) {
      console.warn(`  [新浪财经] 第 ${page} 页失败: ${(e && e.message) || 'fetch failed'}`);
      break;
    }
    if (!r.ok) { console.warn(`  [新浪财经] 第 ${page} 页 HTTP ${r.status}`); break; }
    const j = await r.json();
    const arr = (j && j.result && Array.isArray(j.result.data)) ? j.result.data : [];
    if (!arr.length) break;
    let added = 0;
    arr.forEach((it, idx) => {
      const title = ht.cleanTitle(it.title || it.stitle || '');
      if (!title) return;
      const u = String(it.url || it.wapurl || '').trim();
      const url2 = /^https?:/i.test(u) ? u : '';
      const ts = Number(it.ctime || it.intime || 0);
      const id = 'sina-' + (it.docid || it.oid || (ts + '-' + idx));
      if (seen.has(id)) return;
      seen.add(id);
      out.push({
        id,
        time: ts ? bjStr(ts) : '',
        text: title.slice(0, BRIEF_TEXT_MAX),
        url: url2,
        stocks: [],
        subjects: [],
        cat: (ht.classify ? ht.classify(title) : '')
      });
      added++;
    });
    if (arr.length < 50) break;   // 已是最后一页
    await new Promise(res => setTimeout(res, 120));
  }
  return out;
}

async function main() {
  const isToday = DATE === todayStr();
  const dir = join(ROOT, 'data', 'hot-topics');
  mkdirSync(dir, { recursive: true });

  // ===== 11 个金融软件热点榜（只能取"当前实时榜单"，无法回溯历史）=====
  // 请求R3：由「每 2h 覆盖写」改为「按天累积去重」——否则当天早中段出现的
  // 热点会被后续 run 覆盖丢失，时间窗统计覆盖不全（正是用户反馈"远少于平台实际"的残余根因之一）。
  const SOURCE_ACCUM_MAX = 200;   // 单源单日累积上限（12 次/天 × 50 兜底），约束仓库体积
  const sources = [];
  if (isToday) {
    // 读取已有当日快照，按「源 key + 文本」去重累积；保留更早抓到的 time（补全实时接口缺失的时间戳）
    const prevByKey = {};
    const prevFile = join(dir, `${DATE}.json`);
    try {
      const prev = JSON.parse(readFileSync(prevFile, 'utf8'));
      if (prev && Array.isArray(prev.sources)) {
        for (const ps of prev.sources) prevByKey[ps.key] = new Map((ps.items || []).map(it => [it.text, it]));
      }
    } catch (e) { /* 首次生成 */ }
    console.log(`开始抓取 ${DATE} 的 ${ht.SOURCE_ORDER.length} 个金融软件热点（累积模式）...`);
    for (const s of ht.SOURCE_ORDER) {
      let items = [];
      try { items = await fetchSource(s); }
      catch (e) { console.warn(`  [${s.name}] 抓取异常: ${e.message}`); }
      const m = prevByKey[s.key] || new Map();
      for (const it of items) {
        const ex = m.get(it.text);
        if (ex) {
          if (!ex.time && it.time) { ex.time = it.time; ex.timeKind = it.timeKind; }
          ex.runId = it.runId;                 // 本轮仍观测到 → 不算历史遗留
        } else m.set(it.text, it);
      }
      /* 20261113a：旧版本写入的无时间条目一律淘汰，绝不给它们补「现在」的时间。
       * 否则昨天/上午的旧闻（还混着「纳斯达克综合指数」「60秒后刷新」这类页面垃圾）
       * 会被统一标成本轮抓取时刻，在同一分钟聚集几百条，污染跨站重合榜与主题分类统计，
       * 也违背「只统计设定窗口内、且有精确发生时间的新闻」的口径。
       * 保留：本轮抓到的（runId 匹配）、真实发布时间的、继承兜底的可核查观测条目。 */
      const beforeClean = [...m.values()].length;
      let merged = [...m.values()].filter(it => {
        if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(it.time || ''))) return false;
        if (it.runId === OBSERVED_AT) return true;
        if (it.timeKind === 'inherited-observed') return true;
        if (!it.timeKind) return true;                    // 真实发布时间
        return false;                                      // 历史遗留的 observed 条目
      }).map(({ runId, ...rest }) => rest);                // runId 不落盘
      if (beforeClean > merged.length) {
        console.log(`     [${s.name}] 清理旧版无时间/伪观测时刻遗留条目 ${beforeClean - merged.length} 条`);
      }
      if (!merged.length) {
        // 本次与当日累积都为 0（多为境外 runner 被源站拦截）→ 继承最近快照，避免平台空白
        const inherited = fallbackItemsFromRecent(dir, s.key, DATE);
        if (inherited.length) {
          merged = inherited;
          console.log(`     [${s.name}] 本次 0 条，继承最近快照 ${inherited.length} 条`);
        }
      }
      if (merged.length > SOURCE_ACCUM_MAX) merged = merged.slice(0, SOURCE_ACCUM_MAX);
      /* 20261113c：上海证券报的历史快照 / 继承兜底里可能残留专题 / 招聘 / 特刊 等非快讯条目，
       * 合并后再过一遍黑名单，保证落库快照里始终是热点 / 快讯 / 要闻。 */
      if (s.key === 'cnstock') {
        const before = merged.length;
        merged = merged.filter(it => !isCnstockBlocked(String(it.text || '')));
        if (merged.length < before) console.log(`     [${s.name}] 合并期再剔除非快讯类别 ${before - merged.length} 条`);
      }
      sources.push({ rank: s.rank, key: s.key, name: s.name, color: s.color, items: merged });
      const timed = merged.filter(x => /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(String(x.time || ''))).length;
      console.log(`  ${s.rank}. ${s.name}: 本次 ${items.length} 条，累积 ${merged.length} 条，带精确时间 ${timed} 条`);
    }
    const snapshot = { date: DATE, generatedAt: new Date().toISOString(), sources };
    const file = join(dir, `${DATE}.json`);
    writeFileSync(file, JSON.stringify(snapshot, null, 2), 'utf8');
    console.log(`已写入 ${file}（累积模式）`);
  } else {
    console.log(`跳过「${ht.SOURCE_ORDER.length} 个金融软件热点」：目标日 ${DATE} 不是今天（${todayStr()}）。`);
    console.log('  各来源只提供"当前实时榜单"，没有历史接口；若照写会把今天的榜单盖上昨天的日期，污染历史快照。');
    console.log('  本次只抓取可按时间回溯的「格隆汇每日快讯」。');
  }

  // ===== 格隆汇每日快讯（全量，供「全球信息」页右栏 13 分类统计使用）=====
  const briefsFile = join(dir, `briefs-${DATE}.json`);
  let prevBriefs = [];
  try {
    const prev = JSON.parse(readFileSync(briefsFile, 'utf8'));
    if (prev && Array.isArray(prev.items)) prevBriefs = prev.items;
  } catch (e) { /* 首次生成 */ }
  const knownMaxId = prevBriefs.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0);
  console.log(`抓取格隆汇快讯（目标日 ${DATE}，已存 ${prevBriefs.length} 条，增量起点 id=${knownMaxId || '-'}）...`);
  const fresh = await fetchGelonghuiBriefs(DATE, knownMaxId);
  const briefMap = new Map();
  for (const b of [...fresh, ...prevBriefs]) {
    if (b && b.id && !briefMap.has(b.id)) briefMap.set(b.id, b);
  }
  const briefs = [...briefMap.values()].sort((a, b) => b.id - a.id);
  if (!fresh.length && prevBriefs.length) {
    console.log(`  本次未取到新快讯，保留已存 ${prevBriefs.length} 条`);
  }
  writeFileSync(briefsFile, JSON.stringify({
    date: DATE,
    source: 'gelonghui',
    sourceName: '格隆汇',
    generatedAt: new Date().toISOString(),
    total: briefs.length,
    items: briefs
  }), 'utf8');
  const briefMB = (Buffer.byteLength(JSON.stringify(briefs)) / 1048576).toFixed(2);
  console.log(`已写入 ${briefsFile}（本次新增 ${fresh.length} 条，累计 ${briefs.length} 条 / ${briefMB}MB）`);

  // ===== 今日头条 热榜（实时热榜，无历史回溯；仅当天有意义）=====
  if (isToday) {
    const ttFile = join(dir, `briefs-${TT_SOURCE_NAME}-${DATE}.json`);
    let prevTt = [];
    try {
      const p = JSON.parse(readFileSync(ttFile, 'utf8'));
      if (p && Array.isArray(p.items)) prevTt = p.items;
    } catch (e) { /* 首次生成 */ }
    console.log(`抓取今日头条热榜（目标日 ${DATE}）...`);
    let ttItems = [];
    try { ttItems = await fetchToutiaoBriefs(); }
    catch (e) { console.warn(`  [今日头条] 抓取失败: ${e.message}`); }
    const ttMap = new Map();
    for (const b of [...ttItems, ...prevTt]) { if (b && b.id && !ttMap.has(b.id)) ttMap.set(b.id, b); }
    const ttBriefs = [...ttMap.values()].sort((a, b) => String(b.time).localeCompare(String(a.time)));
    writeFileSync(ttFile, JSON.stringify({
      date: DATE,
      source: TT_SOURCE,
      sourceName: TT_SOURCE_NAME,
      generatedAt: new Date().toISOString(),
      total: ttBriefs.length,
      items: ttBriefs
    }), 'utf8');
    console.log(`已写入 ${ttFile}（本次 ${ttItems.length} 条，累计 ${ttBriefs.length} 条）`);
  } else {
    console.log(`跳过「今日头条热榜」：目标日 ${DATE} 不是今天（热榜无历史回溯）。`);
  }

  // ===== 新浪财经 滚动快讯（带真实时间戳，可按时间段精确过滤；仅当天抓取）=====
  if (isToday) {
    const sinaFile = join(dir, `briefs-${SINA_SOURCE_NAME}-${DATE}.json`);
    let prevSina = [];
    try {
      const p = JSON.parse(readFileSync(sinaFile, 'utf8'));
      if (p && Array.isArray(p.items)) prevSina = p.items;
    } catch (e) { /* 首次生成 */ }
    console.log(`抓取新浪财经快讯（目标日 ${DATE}）...`);
    let sinaItems = [];
    try { sinaItems = await fetchSinaBriefs(); }
    catch (e) { console.warn(`  [新浪财经] 抓取失败: ${e.message}`); }
    const sinaMap = new Map();
    for (const b of [...sinaItems, ...prevSina]) { if (b && b.id && !sinaMap.has(b.id)) sinaMap.set(b.id, b); }
    const sinaBriefs = [...sinaMap.values()].sort((a, b) => String(b.time).localeCompare(String(a.time)));
    writeFileSync(sinaFile, JSON.stringify({
      date: DATE,
      source: SINA_SOURCE,
      sourceName: SINA_SOURCE_NAME,
      generatedAt: new Date().toISOString(),
      total: sinaBriefs.length,
      items: sinaBriefs
    }), 'utf8');
    console.log(`已写入 ${sinaFile}（本次 ${sinaItems.length} 条，累计 ${sinaBriefs.length} 条）`);
  } else {
    console.log(`跳过「新浪财经快讯」：目标日 ${DATE} 不是今天��`);
  }

  // 维护日期清单 index.json：供前端在没有代理时定位「最近可用快照」
  const idxPath = join(dir, 'index.json');
  let dates = [], briefsDates = [];
  try {
    const prev = JSON.parse(readFileSync(idxPath, 'utf8'));
    if (prev && Array.isArray(prev.dates)) dates = prev.dates;
    if (prev && Array.isArray(prev.briefsDates)) briefsDates = prev.briefsDates;
  } catch (e) { /* 首次生成 */ }
  dates = dates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
  // 只有真正抓到当日热点榜单时才登记该日，避免把没有快照文件的日期列进清单（点了会 404）
  if (isToday && dates.indexOf(DATE) < 0) dates.push(DATE);
  dates.sort().reverse();
  const keep = dates.slice(0, HT_SNAPSHOT_KEEP_DAYS);

  briefsDates = briefsDates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (briefs.length && briefsDates.indexOf(DATE) < 0) briefsDates.push(DATE);
  briefsDates.sort().reverse();
  const keepBriefs = briefsDates.slice(0, BRIEF_KEEP_DAYS);

  writeFileSync(idxPath, JSON.stringify({
    updatedAt: new Date().toISOString(),
    latest: keep[0] || (isToday ? DATE : ''),
    latestBriefs: keepBriefs[0] || '',
    keepDays: HT_SNAPSHOT_KEEP_DAYS,
    briefKeepDays: BRIEF_KEEP_DAYS,
    dates: keep,
    briefsDates: keepBriefs
  }, null, 2), 'utf8');
  console.log(`已更新清单 ${idxPath}（快照 ${keep.length} 天，快讯 ${keepBriefs.length} 天，最新快讯 ${keepBriefs[0] || '-'}）`);

  // 清理超出保留期的历史文件，避免仓库无限增长
  const stale = dates.slice(HT_SNAPSHOT_KEEP_DAYS);
  for (const d of stale) {
    try { unlinkSync(join(dir, `${d}.json`)); console.log(`  清理过期快照 ${d}.json`); } catch (e) { /* ignore */ }
  }
  for (const d of briefsDates.slice(BRIEF_KEEP_DAYS)) {
    const f = join(dir, `briefs-${d}.json`);
    if (existsSync(f)) { try { unlinkSync(f); console.log(`  清理过期快讯 briefs-${d}.json`); } catch (e) { /* ignore */ } }
    const tf = join(dir, `briefs-${TT_SOURCE_NAME}-${d}.json`);
    if (existsSync(tf)) { try { unlinkSync(tf); console.log(`  清理过期快讯 briefs-${TT_SOURCE_NAME}-${d}.json`); } catch (e) { /* ignore */ } }
    const sf = join(dir, `briefs-${SINA_SOURCE_NAME}-${d}.json`);
    if (existsSync(sf)) { try { unlinkSync(sf); console.log(`  清理过期快讯 briefs-${SINA_SOURCE_NAME}-${d}.json`); } catch (e) { /* ignore */ } }
  }

  // 20261109d：顺带生成「突发 / 人物」实时数据。输出落在 data/hot-topics/ 下，
  // 随本 workflow 的 `git add -A data/hot-topics` 一起提交；Pages 为 legacy(main 根目录)，push 即发布。
  // 用 try/catch 隔离，保证抓取失败绝不影响原有火热话题快照。
  try {
    await import('./fetch-breaking-events.mjs');
  } catch (e) {
    console.warn('  [突发/人物抓取] 失败（不影响火热话题）：' + (e && e.message));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
