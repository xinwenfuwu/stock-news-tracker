/* ============================================================
 * fetch-hot-topics.mjs — 每日定时抓取 10 个金融软件 Top10 热点
 * 供 GitHub Action 使用：结果写入 data/hot-topics/YYYY-MM-DD.json
 * 复用 js/hot-topics.js 的分类与来源配置（单一数据源）。
 * 用法：node scripts/fetch-hot-topics.mjs [YYYY-MM-DD]
 * ============================================================ */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import ht from '../js/hot-topics.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

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

async function fetchText(url, { timeout = 8000, isJson = false } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': 'application/json,text/html,*/*' }
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return isJson ? await resp.json() : await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

function mkItem(text, time, url) {
  text = (text || '').toString().replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 90);
  if (!text) return null;
  return { text, time: normTime(time), url: url || '', cat: ht.classify(text) };
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
    // HTML 兜底：正则抽取 <a> 文本
    const html = payload || '';
    const base = (ht.SOURCE_BY_KEY && ht.SOURCE_BY_KEY[key] && ht.SOURCE_BY_KEY[key].base) || '';
    const normUrl = (u) => {
      if (!u) return '';
      if (/^https?:/i.test(u)) return u;
      if (u.startsWith('//')) return 'https:' + u;
      if (u.startsWith('/') && base) return base + u;
      return base ? (base + '/' + u.replace(/^\//, '')) : u;
    };
    const re = /<a[^>]*href=["']([^"']*)["'][^>]*>([^<]{6,80})<\/a>/gi;
    let m; const seen = new Set();
    while ((m = re.exec(html)) && out.length < 10) {
      const t = m[2].replace(/\s+/g, ' ').trim();
      if (seen.has(t)) continue;
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

async function fetchSource(s) {
  try {
    if (s.parse === 'news_eastmoney') {
      const url = 'https://newsapi.eastmoney.com/kuaixun/v1/getlist_102_ajax.html?_=' + Date.now();
      const j = await fetchText(url, { isJson: true });
      return parseSource(s.parse, s.key, j);
    }
    const payload = s.parse.startsWith('html_')
      ? await fetchText(s.endpoint)
      : await fetchText(s.endpoint, { isJson: true });
    return parseSource(s.parse, s.key, payload);
  } catch (e) {
    console.warn(`  [${s.name}] 抓取失败: ${e.message}`);
    return [];
  }
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
}

main().catch(e => { console.error(e); process.exit(1); });
