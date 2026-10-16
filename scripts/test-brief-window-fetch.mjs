/* ============================================================
 * test-brief-window-fetch.mjs — 20261016e 验证：
 *   全球信息 → 每日快讯「按新闻统计开始时间~结束时间区间抓取」
 *
 * 用户诉求：刷新时的此刻重新获取新闻，只获取 [开始, 结束] 区间内的新闻
 *   参与系统计算，超出时间范围的新闻不需要获取。
 *
 * 覆盖：
 *   T1  窗口 → 快照日期最小文件集（自然日交集）
 *   T2  格隆汇：只保留窗口内条目 + 翻到窗口起点即停止（不多拉历史）
 *   T3  格隆汇：晚于窗口终点的条目不入列
 *   T4  格隆汇：无窗口边界时行为与旧版完全一致（兼容）
 *   T5  同花顺：晚于终点不入列 + 早于起点停止翻页
 *   T6  东方财富：晚于终点不入列 + 早于起点停止翻页
 *   T7  app.js 接线静态断言（调用点/双界/复合缓存键/提示语/无旧变量）
 *   T8  计算侧精筛口径：起点/终点闭区间，区间外一律剔除
 *
 * 用法：node scripts/test-brief-window-fetch.mjs
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

/* 北京时间 wall-clock → unix 秒（与 _mapGelonghuiV4Items/_mapThsNews 的 +8h 口径一致） */
const bjSec = (y, mo, d, h, mi) => Math.floor(Date.UTC(y, mo - 1, d, h - 8, mi, 0) / 1000);

// ---- 加载真实 hot-topics.js + stock-api.js 到同一 vm 沙箱 ----
const sandbox = { console, setTimeout, clearTimeout, AbortController, fetch: null, document: undefined };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/hot-topics.js'), 'utf8'), sandbox, { filename: 'hot-topics.js' });
vm.runInContext(
  fs.readFileSync(path.join(ROOT, 'js/stock-api.js'), 'utf8') + '\n;globalThis.StockAPI = StockAPI;',
  sandbox, { filename: 'stock-api.js' });
const HT = sandbox.HotTopics;
const StockAPI = sandbox.StockAPI;

console.log('TZ=' + Intl.DateTimeFormat().resolvedOptions().timeZone + '  now=' + new Date().toString());

/* 用户诉求场景：2026-10-16 15:00 → 2026-10-19 09:30 */
const WIN = {
  start: new Date(2026, 9, 16, 15, 0),
  end: new Date(2026, 9, 19, 9, 30),
};
const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/* ---------- T1 窗口 → 快照日期最小文件集 ---------- */
console.log('\n[T1] 窗口覆盖的快照日期（自然日交集）');
{
  const days = HT.windowSnapshotDates(WIN.start.getTime(), WIN.end.getTime());
  check('10/16 15:00 → 10/19 09:30 取 4 个自然日文件', JSON.stringify(days) === JSON.stringify(['2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19']), JSON.stringify(days));
  const d2 = HT.windowSnapshotDates(new Date(2026, 9, 16, 15, 0).getTime(), new Date(2026, 9, 16, 18, 0).getTime());
  check('同日窗口只取 1 个文件', JSON.stringify(d2) === JSON.stringify(['2026-10-16']), JSON.stringify(d2));
}

/* ---------- T2 格隆汇：窗口内保留 + 翻到起点即停 ---------- */
console.log('\n[T2] 格隆汇 v4 翻页：双界过滤 + 提前停止');
{
  const pages = [
    { result: [
      { id: 90, createTimestamp: bjSec(2026, 10, 16, 20, 0), content: 'IN-2000' },
      { id: 89, createTimestamp: bjSec(2026, 10, 16, 19, 0), content: 'IN-1900' },
      { id: 88, createTimestamp: bjSec(2026, 10, 16, 16, 0), content: 'IN-1600' },
    ] },
    { result: [
      { id: 87, createTimestamp: bjSec(2026, 10, 16, 15, 30), content: 'IN-1530' },
      { id: 86, createTimestamp: bjSec(2026, 10, 16, 14, 0), content: 'OUT-1400' },   // 早于起点
    ] },
    { result: [
      { id: 85, createTimestamp: bjSec(2026, 10, 16, 10, 0), content: 'NEVER-1000' }, // 永远不该被拉到
    ] },
  ];
  let calls = 0;
  const fetcher = async () => JSON.stringify(pages[calls++] || { result: [] });
  const items = await StockAPI._fetchGelonghuiV4Pages(
    (cursor) => 'https://gm.test/?liveId=' + cursor, 12, 50, fetcher,
    { untilMs: WIN.start.getTime(), endMs: WIN.end.getTime() });
  const texts = items.map(x => x.text);
  check('只保留窗口内 4 条', items.length === 4, JSON.stringify(texts));
  check('早于起点的条目被剔除', !texts.includes('OUT-1400'));
  check('翻到窗口起点即停止（未拉第 3 页）', calls === 2, 'calls=' + calls);
}

/* ---------- T3 格隆汇：终点上界 ---------- */
console.log('\n[T3] 格隆汇 v4 翻页：晚于窗口终点不入列');
{
  const pages = [
    { result: [
      { id: 30, createTimestamp: bjSec(2026, 10, 16, 20, 0), content: 'OUT-2000' },   // 晚于终点 18:00
      { id: 29, createTimestamp: bjSec(2026, 10, 16, 19, 30), content: 'OUT-1930' },
      { id: 28, createTimestamp: bjSec(2026, 10, 16, 17, 0), content: 'IN-1700' },
    ] },
    { result: [
      { id: 27, createTimestamp: bjSec(2026, 10, 16, 16, 0), content: 'IN-1600' },
      { id: 26, createTimestamp: bjSec(2026, 10, 16, 14, 0), content: 'OUT-1400' },
    ] },
  ];
  let calls = 0;
  const fetcher = async () => JSON.stringify(pages[calls++] || { result: [] });
  const items = await StockAPI._fetchGelonghuiV4Pages(
    () => 'https://gm.test/', 12, 50, fetcher,
    { untilMs: new Date(2026, 9, 16, 15, 0).getTime(), endMs: new Date(2026, 9, 16, 18, 0).getTime() });
  check('窗口 [15:00, 18:00] 只留 17:00/16:00 两条', items.map(x => x.text).join(',') === 'IN-1700,IN-1600', JSON.stringify(items.map(x => x.text)));
  check('翻 2 页后因早于起点停止', calls === 2, 'calls=' + calls);
}

/* ---------- T4 格隆汇：无边界兼容旧行为 ---------- */
console.log('\n[T4] 格隆汇 v4 翻页：无窗口边界时行为不变');
{
  const pages = [
    { result: [{ id: 1, createTimestamp: bjSec(2026, 10, 16, 20, 0), content: 'A' }, { id: 2, createTimestamp: bjSec(2026, 10, 16, 19, 0), content: 'B' }] },
    { result: [{ id: 3, createTimestamp: bjSec(2026, 10, 15, 20, 0), content: 'C' }, { id: 4, createTimestamp: bjSec(2026, 10, 15, 19, 0), content: 'D' }] },
    { result: [{ id: 5, createTimestamp: bjSec(2026, 10, 14, 20, 0), content: 'E' }, { id: 6, createTimestamp: bjSec(2026, 10, 14, 19, 0), content: 'F' }] },
  ];
  let calls = 0;
  const fetcher = async () => JSON.stringify(pages[calls++] || { result: [] });
  const items = await StockAPI._fetchGelonghuiV4Pages(() => 'https://gm.test/', 12, 50, fetcher, {});
  // 注：第 4 次调用是「多拉一页空页才发现到底」的终止探测，旧逻辑同样如此（arr 为空即 break）
  check('拉满 3 页数据共 6 条（与旧版一致）', calls === 4 && items.length === 6, 'calls=' + calls + ' n=' + items.length);
}

/* ---------- T5 同花顺 ---------- */
console.log('\n[T5] 同花顺实时快讯：endTime 上界 + untilTime 停止');
{
  const thsPages = {
    1: [
      { id: 't1', ctime: bjSec(2026, 10, 16, 20, 0), title: 'OUT-2000' },
      { id: 't2', ctime: bjSec(2026, 10, 16, 19, 0), title: 'OUT-1900' },
      { id: 't3', ctime: bjSec(2026, 10, 16, 17, 0), title: 'IN-1700' },
    ],
    2: [
      { id: 't4', ctime: bjSec(2026, 10, 16, 16, 0), title: 'IN-1600' },
      { id: 't5', ctime: bjSec(2026, 10, 16, 10, 0), title: 'OUT-1000' },
    ],
  };
  let fetchCalls = 0;
  sandbox.fetch = async (u) => {
    fetchCalls++;
    const m = /page=(\d+)/.exec(u);
    return { ok: true, json: async () => ({ code: '200', data: { list: thsPages[Number(m[1])] || [] } }) };
  };
  const ths = await StockAPI.fetchThsLiveBriefs({
    untilTime: new Date(2026, 9, 16, 15, 0).getTime(),
    endTime: new Date(2026, 9, 16, 18, 0).getTime(),
    maxPages: 50,
  });
  check('窗口 [15:00, 18:00] 只留 17:00/16:00', ths.map(x => x.text).join(',') === 'IN-1700,IN-1600', JSON.stringify(ths.map(x => x.text)));
  check('第 2 页最旧早于起点 → 停止翻页（共 2 页）', fetchCalls === 2, 'fetchCalls=' + fetchCalls);
}

/* ---------- T6 东方财富 ---------- */
console.log('\n[T6] 东方财富实时快讯：endTime 上界 + untilTime 停止');
{
  const emPages = {
    1: [
      { id: 'e1', title: 'OUT-2000', showtime: '2026-10-16 20:00:00' },
      { id: 'e2', title: 'IN-1730', showtime: '2026-10-16 17:30:00' },
    ],
    2: [
      { id: 'e3', title: 'IN-1600', showtime: '2026-10-16 16:00:00' },
      { id: 'e4', title: 'OUT-0900', showtime: '2026-10-16 09:00:00' },
    ],
  };
  let pageCalls = 0;
  StockAPI._fetchEmPage = async (page) => { pageCalls++; return emPages[page] || []; };
  const em = await StockAPI.fetchEmLiveBriefs({
    untilTime: new Date(2026, 9, 16, 15, 0).getTime(),
    endTime: new Date(2026, 9, 16, 18, 0).getTime(),
    maxPages: 50,
  });
  check('窗口 [15:00, 18:00] 只留 17:30/16:00', em.map(x => x.text).join(',') === 'IN-1730,IN-1600', JSON.stringify(em.map(x => x.text)));
  check('第 2 页最旧早于起点 → 停止翻页（共 2 页）', pageCalls === 2, 'pageCalls=' + pageCalls);
}

/* ---------- T7 app.js 接线静态断言 ---------- */
console.log('\n[T7] app.js 接线（静态断言）');
{
  const src = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  check('调用点传入窗口终点', /fetchLiveBriefsForWindow\(w\.start\.getTime\(\), true, w\.end\.getTime\(\)\)/.test(src));
  check('实时源同时传 untilTime 与 endTime', /winOpts = \{ untilTime: winStart, endTime: winEnd \}/.test(src));
  check('格隆汇直连传 untilMs+endMs', /fetchGelonghuiLiveBriefsDirect\(12, 50, \{ untilMs: winStart, endMs: winEnd \}\)/.test(src));
  check('格隆汇代理回退传 untilMs+endMs', /fetchGelonghuiLiveBriefs\(proxyUrl, 12, \{ untilMs: winStart, endMs: winEnd \}\)/.test(src));
  check('东财/同花顺翻页参数含 endTime', /Object\.assign\(\{\s*maxPages: 50,\s*proxyUrl: \(D\.settings && D\.settings\.proxyUrl\) \|\| ''\s*\}, winOpts\)/.test(src) && /fetchThsLiveBriefs\(Object\.assign\(\{ maxPages: 50 \}, winOpts\)\)/.test(src));
  check('缓存键为「起点:终点」复合键', /const key = winStart \+ ':' \+ winEnd;/.test(src) && /_emCacheWinKey === key/.test(src) && /_thsCacheWinKey === key/.test(src));
  check('成功提示注明区间外不纳入', /区间外不纳入/.test(src));
  check('无旧缓存变量残留', !/_emCacheUntilMs|_thsCacheUntilMs/.test(src));
}

/* ---------- T8 计算侧精筛口径（与 refreshBriefCloseWindow 同表达式） ---------- */
console.log('\n[T8] 计算侧：起点/终点闭区间，区间外剔除');
{
  const startStr = fmt(WIN.start), endStr = fmt(WIN.end);
  const merged = [
    { time: '2026-10-15 23:59', text: '窗口外-前一天' },
    { time: '2026-10-16 14:59', text: '边界外-早1分钟' },
    { time: '2026-10-16 15:00', text: '边界内-起点' },
    { time: '2026-10-17 12:00', text: '窗口内' },
    { time: '2026-10-19 09:30', text: '边界内-终点' },
    { time: '2026-10-19 09:31', text: '边界外-晚1分钟' },
  ];
  const inWin = merged.filter(it => { const t = String(it.time); return t >= startStr && t <= endStr; });
  const texts = inWin.map(x => x.text);
  check('恰好 3 条入窗（含起止边界）', inWin.length === 3, JSON.stringify(texts));
  check('起点/终点均为闭区间', texts.includes('边界内-起点') && texts.includes('边界内-终点'));
  check('起止前后 1 分钟与前一天全部剔除', !texts.some(t => t.includes('边界外')) && !texts.includes('窗口外-前一天'));
}

console.log('\n===== ' + pass + ' passed, ' + fail + ' failed =====');
process.exit(fail ? 1 : 0);
