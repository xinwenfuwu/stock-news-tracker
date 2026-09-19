/* ============================================================
 * fetch-all-a-stocks.mjs — 生成「全 A 股名单」静态文件
 *
 * 输出：data/stocks/all-a.json
 *   {
 *     "date": "2026-09-19",
 *     "generatedAt": "2026-09-19T02:00:00.000Z",
 *     "source": "eastmoney-clist",
 *     "total": 5432,
 *     "items": [ { "code": "sh600000", "pureCode": "600000", "name": "浦发银行" }, ... ]
 *   }
 *
 * 用途：前端 js/stock-api.js 的 getAllAStocks() 会优先读这个文件拿到「股票代码+名称」名单，
 *       从而直接算出精确分页数（不再逐页试探），只去拉实时行情。
 *       名单本身几乎不变（仅新股上市/退市时变化），所以非常适合静态化。
 *
 * 为什么名单里不含价格/涨跌幅/市值？
 *   那些是盘中实时数据，一旦静态化就会过期，用来做「尾盘买入法」筛选会得出错误结论。
 *   价格由前端实时接口补齐，本脚本只负责稳定的名单部分。
 *
 * 用法：
 *   node scripts/fetch-all-a-stocks.mjs              # 按北京时间今天生成
 *   node scripts/fetch-all-a-stocks.mjs 2026-09-19   # 指定日期
 *
 * 保护：若本次抓到的数量比已存在文件少 20% 以上，判定为网络抖动导致的残缺结果，
 *       放弃写入并保留上一次的好文件（避免用坏数据覆盖好数据）。
 * ============================================================ */
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT_DIR = join(ROOT, 'data', 'stocks');
const OUT_FILE = join(OUT_DIR, 'all-a.json');

/** 东财板块筛选：沪深主板 + 创业板 + 科创板（与前端 _allAPageUrl 保持一致） */
const FS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23';
const FIELDS = 'f2,f3,f12,f14,f20';
const CONC = 6;          // 批内并发
const GAP_MS = 60;       // 批间间隔
const MAX_PAGES = 80;    // 最大探测页数（8000 只，远超当前市场规模）
const MIN_SIZE = 1000;   // 低于此值视为抓取失败
const SHRINK_TOL = 0.2;  // 相对上次缩水超过 20% 则拒绝覆盖

/** 北京时间今天（Actions runner 是 UTC，必须显式 +8，否则跨日会写错日期） */
function todayBJ(d = new Date()) {
  const bj = new Date(d.getTime() + 8 * 3600 * 1000);
  const y = bj.getUTCFullYear();
  const m = String(bj.getUTCMonth() + 1).padStart(2, '0');
  const day = String(bj.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
const DATE = process.argv[2] || todayBJ();

/** 超时包装：用 Promise.race 而非 AbortSignal，兼容 Node 20/22 各版本 */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout: ' + label)), ms))
  ]);
}

async function fetchJson(url, timeout = 15000) {
  const resp = await withTimeout(fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Referer': 'https://quote.eastmoney.com/',
      'Accept-Language': 'zh-CN,zh;q=0.9'
    }
  }), timeout, url);
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  return await resp.json();
}

function pageUrl(pn, pz = 100) {
  return `https://push2.eastmoney.com/api/qt/clist/get?pn=${pn}&pz=${pz}&po=1&np=1&fltt=2&invt=2&fid=f12`
    + `&fs=${FS}&fields=${FIELDS}`;
}

function diffArray(json) {
  const d = json && json.data && json.data.diff;
  if (!d) return [];
  if (Array.isArray(d)) return d;
  return Object.keys(d).map(k => d[k]);
}

/** 证件类型：6/9/4/8 开头归沪市，其余归深市（与前端保持一致） */
function prefixOf(pure) {
  return /^(6|9|4|8)/.test(pure) ? 'sh' : 'sz';
}

async function fetchAllA() {
  const map = new Map();
  let total = null;
  let emptyBatches = 0;

  for (let start = 1; start <= MAX_PAGES; start += CONC) {
    const pages = [];
    for (let k = start; k < Math.min(start + CONC, MAX_PAGES + 1); k++) pages.push(k);
    const results = await Promise.all(pages.map(pn =>
      fetchJson(pageUrl(pn)).catch(e => {
        console.warn(`  页 ${pn} 失败: ${e.message}`);
        return null;
      })
    ));
    let got = 0;
    for (const j of results) {
      if (!j) continue;
      if (total == null && j.data && j.data.total) total = j.data.total;
      for (const it of diffArray(j)) {
        const pure = String(it.f12 || '').trim();
        if (!pure || map.has(pure)) continue;
        map.set(pure, {
          code: prefixOf(pure) + pure,
          pureCode: pure,
          name: String(it.f14 || '')
        });
        got++;
      }
    }
    console.log(`  页 ${pages[0]}~${pages[pages.length - 1]}: +${got}，累计 ${map.size}${total ? '/' + total : ''}`);
    if (total != null && map.size >= total) break;
    if (!got) {
      emptyBatches++;
      if (emptyBatches >= 2) break;
    } else emptyBatches = 0;
    if (start + CONC <= MAX_PAGES) await new Promise(r => setTimeout(r, GAP_MS));
  }
  return { list: Array.from(map.values()), total };
}

async function main() {
  console.log(`生成全 A 股名单（目标日 ${DATE}）...`);
  const { list, total } = await fetchAllA();
  console.log(`抓到 ${list.length} 只${total ? '（接口总数 ' + total + '）' : ''}`);

  if (list.length < MIN_SIZE) {
    throw new Error(`数量异常（${list.length} < ${MIN_SIZE}），判定为抓取失败，不写入`);
  }

  // 缩水保护：明显少于上次 => 网络抖动导致残缺，保留旧文件
  if (existsSync(OUT_FILE)) {
    try {
      const prev = JSON.parse(readFileSync(OUT_FILE, 'utf8'));
      const prevCount = prev && Array.isArray(prev.items) ? prev.items.length : 0;
      if (prevCount > 0 && list.length < prevCount * (1 - SHRINK_TOL)) {
        throw new Error(
          `本次 ${list.length} 只，比上次 ${prevCount} 只缩水 ${((1 - list.length / prevCount) * 100).toFixed(1)}%` +
          `（超过 ${SHRINK_TOL * 100}%），判定为残缺结果，保留旧文件不覆盖`
        );
      }
    } catch (e) {
      if (e instanceof Error && /残缺结果/.test(e.message)) throw e;
      // 旧文件损坏无法解析：直接覆盖
    }
  }

  const named = list.filter(x => x.name);
  if (named.length < MIN_SIZE) {
    throw new Error(`有名称的股票仅 ${named.length} 只，异常，不写入`);
  }

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const payload = {
    date: DATE,
    generatedAt: new Date().toISOString(),
    source: 'eastmoney-clist',
    note: '仅含代码+名称；价格/涨跌幅/市值由前端实时接口补齐',
    total: named.length,
    items: named
  };
  writeFileSync(OUT_FILE, JSON.stringify(payload), 'utf8');
  const kb = (Buffer.byteLength(JSON.stringify(payload)) / 1024).toFixed(0);
  console.log(`已写入 ${OUT_FILE}（${named.length} 只，${kb}KB，gzip 后约 ${(kb / 6).toFixed(0)}KB）`);
}

main().catch(e => {
  console.error('[fetch-all-a-stocks] 失败:', e && e.message ? e.message : e);
  // 文件已存在时不让 CI 变红后无声无息：这里仍以 0 退出，因为保留旧文件是可接受的降级
  if (!existsSync(OUT_FILE)) process.exit(1);
});
