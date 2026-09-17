/* ============================================================
 * fetch-hot-topics.mjs — 每日定时抓取 10 个金融软件 Top10 热点
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

/** 取「今天」：一律按北京时间（UTC+8），不跟随运行器本地时区。
 *  GitHub Actions 运行器是 UTC，而定时任务每 2 小时一次，
 *  其中 UTC 22:00（= 北京时间次日 06:00）那一跑，若按 UTC 判日期会认为"今天"是前一天，
 *  进而把当天早上的实时榜单写进前一天的快照文件，污染历史数据。 */
function todayStr(d = new Date()) {
  const bj = new Date(d.getTime() + 8 * 3600 * 1000);
  const y = bj.getUTCFullYear(), m = String(bj.getUTCMonth() + 1).padStart(2, '0'), day = String(bj.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
const DATE = process.argv[2] || todayStr();

function normTime(t) {
  if (t == null) return '';
  t = String(t).trim();
  if (/^\d{10}$/.test(t)) return new Date(+t * 1000).toISOString().slice(0, 16).replace('T', ' ');
  if (/^\d{13}$/.test(t)) return new Date(+t).toISOString().slice(0, 16).replace('T', ' ');
  return t.replace('T', ' ').slice(0, 16);
}

function decodeBuffer(buf, enc) {
  try { return new TextDecoder(enc, { fatal: false }).decode(buf); }
  catch (e) { return buf.toString('utf8'); }
}
const countBad = s => { const m = s.match(/\uFFFD/g); return m ? m.length : 0; };

/** 智能解码：优先 UTF-8，若出现替换字符（乱码）则改用 GBK，取更干净的一版。
 *  国内财经站点（如同花顺）多为 GBK，海外 runner 上必须显式转码。 */
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

async function fetchText(url, { timeout = 8000, isJson = false, encoding = '' } = {}) {
  let resp;
  try {
    resp = await withTimeout(fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json,text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      }
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

function mkItem(text, time, url) {
  const t = ht.cleanTitle(text);
  if (!t) return null;
  return { text: t, time: normTime(time), url: url || '', cat: ht.classify(t) };
}

function parseSource(parse, key, payload) {
  const out = [];
  const push = (text, time, url) => { const it = mkItem(text, time, url); if (it) out.push(it); };

  if (parse === 'news_eastmoney') {
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
    const arr = (payload && payload.data && payload.data.items) || [];
    for (const it of arr.slice(0, HOT_TOPN)) push(it.content_text || it.content, it.display_time, it.uri ? 'https://wallstreetcn.com/' + it.uri : '');
  } else if (parse === 'json_cailian') {
    const arr = Array.isArray(payload && payload.data) ? payload.data : ((payload && payload.data && payload.data.data) || []);
    for (const it of arr.slice(0, HOT_TOPN)) push(it.content || it.title, it.publish_time || it.ctime, 'https://www.cailianpress.com/');
  } else if (parse === 'json_xueqiu') {
    const arr = (payload && payload.items) || (payload && payload.list) || [];
    for (const it of arr.slice(0, HOT_TOPN)) push(it.title || it.description || it.text, '', it.target ? ('https://xueqiu.com' + it.target) : '');
  } else if (parse === 'json_gelonghui') {
    const arr = (payload && payload.result && payload.result.data) || (payload && payload.data) || [];
    for (const it of arr.slice(0, HOT_TOPN)) push(it.content || it.title || it.text, it.created_at || it.time, 'https://www.gelonghui.com/');
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

/** 抓单个源：主端点，必要时回退到备用端点（如东财 JSON 失效时改抓 HTML 列表页） */
async function fetchSource(s) {
  const tryEndpoint = async (url, forceHtml) => {
    if (!url) return [];
    if (forceHtml || (s.parse && s.parse.startsWith('html_'))) {
      const html = await fetchText(url);
      return parseSource('html_body', s.key, html);
    }
    const j = await fetchText(url, { isJson: true });
    return parseSource(s.parse, s.key, j);
  };

  let items = [];
  try {
    if (s.parse === 'news_eastmoney') {
      const url = 'https://newsapi.eastmoney.com/kuaixun/v1/getlist_102_ajax.html?_=' + Date.now();
      try { items = await tryEndpoint(url, false); }
      catch (e) { console.warn(`  [${s.name}] 7x24 接口异常: ${e.message}`); }
    } else {
      items = await tryEndpoint(s.endpoint, false);
    }
  } catch (e) {
    console.warn(`  [${s.name}] 主端点失败: ${e.message}`);
  }

  if (items.length < 3 && s.fallback) {
    console.log(`  [${s.name}] 主端点仅 ${items.length} 条，改试备用端点 ${s.fallback}`);
    try {
      const alt = await tryEndpoint(s.fallback, true);
      if (alt.length > items.length) items = alt;
    } catch (e) {
      console.warn(`  [${s.name}] 备用端点失败: ${e.message}`);
    }
  }
  return items;
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

async function main() {
  const isToday = DATE === todayStr();
  const dir = join(ROOT, 'data', 'hot-topics');
  mkdirSync(dir, { recursive: true });

  // ===== 10 个金融软件热点榜（只能取"当前实时榜单"，无法回溯历史）=====
  const sources = [];
  if (isToday) {
    console.log(`开始抓取 ${DATE} 的 10 个金融软件热点...`);
    for (const s of ht.SOURCE_ORDER) {
      const items = await fetchSource(s);
      sources.push({ rank: s.rank, key: s.key, name: s.name, color: s.color, items });
      console.log(`  ${s.rank}. ${s.name}: ${items.length} 条`);
    }
    const snapshot = { date: DATE, generatedAt: new Date().toISOString(), sources };
    const file = join(dir, `${DATE}.json`);
    writeFileSync(file, JSON.stringify(snapshot, null, 2), 'utf8');
    console.log(`已写入 ${file}`);
  } else {
    console.log(`跳过「10 个金融软件热点」：目标日 ${DATE} 不是今天（${todayStr()}）。`);
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
  }
}

main().catch(e => { console.error(e); process.exit(1); });
