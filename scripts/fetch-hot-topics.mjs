/* ============================================================
 * fetch-hot-topics.mjs — 每日定时抓取 10 个金融软件 Top10 热点
 * 供 GitHub Action 使用：结果写入 data/hot-topics/YYYY-MM-DD.json
 * 复用 js/hot-topics.js 的分类与来源配置（单一数据源）。
 * 用法：node scripts/fetch-hot-topics.mjs [YYYY-MM-DD]
 * ============================================================ */
import { writeFileSync, readFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import ht from '../js/hot-topics.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
/** 快照保留天数（与前端 HT_SNAPSHOT_KEEP_DAYS 保持一致） */
const HT_SNAPSHOT_KEEP_DAYS = 60;

function todayStr(d = new Date()) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
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

async function fetchText(url, { timeout = 8000, isJson = false, encoding = '' } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json,text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      }
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    if (isJson) return await resp.json();
    const buf = Buffer.from(await resp.arrayBuffer());
    let text = decodeSmart(buf, encoding);
    return text.replace(/^\uFEFF/, '');
  } finally {
    clearTimeout(timer);
  }
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
    for (const it of (list || []).slice(0, 10)) push([it.title, it.summary].filter(Boolean).join('：'), it.showTime, it.uniqueUrl || '');
  } else if (parse === 'json_toutiao') {
    const arr = (payload && payload.data) || [];
    for (const it of arr.slice(0, 10)) {
      let u = it.Url || '';
      if (u && !/^https?:/i.test(u)) u = 'https://www.toutiao.com/' + u.replace(/^\//, '');
      push(it.Title || it.title, '', u);
    }
  } else if (parse === 'json_wscn') {
    const arr = (payload && payload.data && payload.data.items) || [];
    for (const it of arr.slice(0, 10)) push(it.content_text || it.content, it.display_time, it.uri ? 'https://wallstreetcn.com/' + it.uri : '');
  } else if (parse === 'json_cailian') {
    const arr = Array.isArray(payload && payload.data) ? payload.data : ((payload && payload.data && payload.data.data) || []);
    for (const it of arr.slice(0, 10)) push(it.content || it.title, it.publish_time || it.ctime, 'https://www.cailianpress.com/');
  } else if (parse === 'json_xueqiu') {
    const arr = (payload && payload.items) || (payload && payload.list) || [];
    for (const it of arr.slice(0, 10)) push(it.title || it.description || it.text, '', it.target ? ('https://xueqiu.com' + it.target) : '');
  } else if (parse === 'json_gelonghui') {
    const arr = (payload && payload.result && payload.result.data) || (payload && payload.data) || [];
    for (const it of arr.slice(0, 10)) push(it.content || it.title || it.text, it.created_at || it.time, 'https://www.gelonghui.com/');
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
      if (out.length >= 10 || ++scanned > 600) break;   // 扫描全页候选，过滤后取前 10
      const t = ht.cleanTitle(m[2]);
      if (!t || seen.has(t)) continue;
      seen.add(t);
      push(t, '', normUrl(m[1]));
    }
  } else if (payload && typeof payload === 'object') {
    const arr = payload.data || payload.result || payload.list || payload.items || (payload.data && payload.data.list) || [];
    if (Array.isArray(arr)) {
      for (const it of arr.slice(0, 10)) {
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

async function main() {
  console.log(`开始抓取 ${DATE} 的 10 个金融软件热点...`);
  const sources = [];
  for (const s of ht.SOURCE_ORDER) {
    const items = await fetchSource(s);
    sources.push({ rank: s.rank, key: s.key, name: s.name, color: s.color, items });
    console.log(`  ${s.rank}. ${s.name}: ${items.length} 条`);
  }
  const snapshot = { date: DATE, generatedAt: new Date().toISOString(), sources };
  const dir = join(ROOT, 'data', 'hot-topics');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${DATE}.json`);
  writeFileSync(file, JSON.stringify(snapshot, null, 2), 'utf8');
  console.log(`已写入 ${file}`);

  // 维护日期清单 index.json：供前端在没有代理时定位「最近可用快照」
  const idxPath = join(dir, 'index.json');
  let dates = [];
  try {
    const prev = JSON.parse(readFileSync(idxPath, 'utf8'));
    if (prev && Array.isArray(prev.dates)) dates = prev.dates;
  } catch (e) { /* 首次生成 */ }
  dates = dates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (dates.indexOf(DATE) < 0) dates.push(DATE);
  dates.sort().reverse();
  const keep = dates.slice(0, HT_SNAPSHOT_KEEP_DAYS);
  writeFileSync(idxPath, JSON.stringify({
    updatedAt: new Date().toISOString(),
    latest: keep[0] || DATE,
    keepDays: HT_SNAPSHOT_KEEP_DAYS,
    dates: keep
  }, null, 2), 'utf8');
  console.log(`已更新清单 ${idxPath}（共 ${keep.length} 天，最新 ${keep[0]}）`);

  // 清理超出保留期的历史快照，避免仓库无限增长
  const stale = dates.slice(HT_SNAPSHOT_KEEP_DAYS);
  for (const d of stale) {
    try { unlinkSync(join(dir, `${d}.json`)); console.log(`  清理过期快照 ${d}.json`); } catch (e) { /* ignore */ }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
