/**
 * scripts/gen-board-members.mjs —— 生成「板块 → 成分股」静态快照
 *
 * 为什么要有它：
 *   选股页的板块成分股此前依赖东财 push2（**会限流**，且实测在浏览器侧已直接 Failed to fetch）。
 *   本脚本把东财数据中心报表 RPT_F10_CORETHEME_BOARDTYPE 全表（约 9.4 万行 / 19 页）
 *   聚合成本站自有的**静态 JSON**，随站点一起发布到 GitHub Pages CDN：
 *     · 运行时**零第三方 API 调用**、零限流、零配额 —— 一万用户也只是各自从 CDN 拉一份（会被边缘缓存）；
 *     · 只有站点自身的静态文件，没有单点限流，也完全不经过 push2。
 *   站点侧只在「报表主路径失败」时才回退到这份快照，保证东财整体不可用时成分股依然出得来。
 *
 * 用法：
 *   node scripts/gen-board-members.mjs            # 直接写入 <cwd>/data/board-members.json
 *   node scripts/gen-board-members.mjs out.json   # 指定输出路径（第 1 个位置参数）
 *
 * 维护须知（改这个文件/重跑本脚本前先读）：
 *   1. 输出带 `t`（生成时间戳）→ **每次重跑体积都会变**。重新生成后必须：
 *      a) 重跑 `node verify_batch53.js`（D 段按快照真身断言板块数 / BK0473 成员）；
 *      b) `node build_mirror.js` 重建 `_mirror/`（该脚本会先整目录删 `_mirror/`，含 `data/`，
 *         所以它必须重新把 data/board-members.json 拷进去，否则 E2E 里快照档会 404）；
 *      c) 重新部署（`push.js` 的 FILES 已含 `data/board-members.json`），
 *         否则 `verify_live_batch53.js` 的 F8「线上与本地等长」会失败。
 *   2. 报表口径：pageSize 上限实测为 5000（写更大也只回 5000），19 页拿全约 9.4 万行；
 *      聚合后为 1031 个板块 / 90535 条成分股 / ~648KB。若某次抓取行数明显偏少，
 *      多半是中途某页失败 —— 脚本已内置 3 次退避重试，仍失败会直接抛错退出（不会写出半份快照）。
 *
 * 输出格式（尽量紧凑，减少 CDN 流量）：
 *   { "v": 1, "t": <生成时间戳>, "src": "RPT_F10_CORETHEME_BOARDTYPE",
 *     "boards": { "BK0900": ["新能源车", "600519,000001,..."], ... } }
 *   成分股为 **6 位纯代码**，逗号分隔（市场前缀在客户端按代码段推断，避免重复存储 "sh"/"sz"）。
 */
import fs from 'node:fs';
import path from 'node:path';

const DC = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
const REPORT = 'RPT_F10_CORETHEME_BOARDTYPE';
const COLS = 'SECUCODE,SECURITY_CODE,NEW_BOARD_CODE,BOARD_NAME';
const PS = 5000;
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; board-members-generator)' };

const outArg = process.argv[2] || path.join(process.cwd(), 'data', 'board-members.json');

function dcUrl(pn) {
  return DC + '?reportName=' + encodeURIComponent(REPORT)
    + '&columns=' + encodeURIComponent(COLS)
    + '&pageSize=' + PS + '&pageNumber=' + pn
    + '&source=WEB&client=WEB';
}

async function getPage(pn, attempt = 0) {
  try {
    const r = await fetch(dcUrl(pn), { headers: HEADERS });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    return {
      rows: (j && j.result && Array.isArray(j.result.data)) ? j.result.data : [],
      count: (j && j.result && j.result.count) || 0,
    };
  } catch (e) {
    if (attempt < 3) {
      await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
      return getPage(pn, attempt + 1);
    }
    throw e;
  }
}

/** 6 位纯代码（去掉 .SH/.SZ/.BJ，统一 SECURITY_CODE） */
function pureOf(row) {
  const p = String(row.SECURITY_CODE || '').trim();
  if (/^\d{6}$/.test(p)) return p;
  const m = String(row.SECUCODE || '').match(/^(\d{6})\./);
  return m ? m[1] : '';
}

const main = async () => {
  const first = await getPage(1);
  const total = first.count;
  const pages = Math.min(40, Math.ceil(total / PS) || 1);
  console.log(`报表 ${total} 行 / ${pages} 页（pageSize=${PS}）`);

  const acc = new Map();   // bk -> { name, codes: Set }
  const add = (rows) => {
    for (const r of rows) {
      const bk = String(r.NEW_BOARD_CODE || '').trim();
      const nm = String(r.BOARD_NAME || '').trim();
      const pure = pureOf(r);
      if (!bk || !pure) continue;
      let e = acc.get(bk);
      if (!e) { e = { name: nm, codes: new Set() }; acc.set(bk, e); }
      if (!e.name && nm) e.name = nm;
      e.codes.add(pure);
    }
  };
  add(first.rows);
  for (let p = 2; p <= pages; p++) {
    const r = await getPage(p);
    add(r.rows);
    if (r.rows.length < PS) break;
    if (p % 5 === 0 || p === pages) console.log(`  已聚合 ${p}/${pages} 页`);
  }

  // 组包：boards[bk] = [name, "code,code,..."]
  const boards = {};
  let memberRows = 0;
  for (const bk of [...acc.keys()].sort()) {
    const e = acc.get(bk);
    const codes = [...e.codes].sort();
    if (!codes.length) continue;
    boards[bk] = [e.name || bk, codes.join(',')];
    memberRows += codes.length;
  }

  const payload = { v: 1, t: Date.now(), src: REPORT, boards };
  const text = JSON.stringify(payload);

  fs.mkdirSync(path.dirname(outArg), { recursive: true });
  fs.writeFileSync(outArg, text, 'utf8');

  const kb = (n) => (n / 1024).toFixed(1) + 'KB';
  console.log(`\n板块数 ${Object.keys(boards).length}   成分股行数 ${memberRows}`);
  console.log(`输出 ${outArg}`);
  console.log(`体积 ${kb(Buffer.byteLength(text, 'utf8'))}（JSON 原文）`);
};

main().catch(e => { console.error('FAILED', e && e.stack || e); process.exit(1); });
