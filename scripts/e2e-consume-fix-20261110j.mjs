/* ============================================================
 * e2e-consume-fix-20261110j.mjs — 验证「题材归类·消费」修正（20261110j）
 *
 * 用户诉求：题材归类中的「消费」子类被明显误分类；
 *   用户定义的「消费」= 国家拉动消费相关的新闻（政策/宏观拉动），
 *   而非把 家电/食品饮料/零售/餐饮/电商 等行业词混进来。
 *
 * 本轮改动：
 *   A) 收窄 t_消费 关键词为「国家拉动消费」语义（移除 家电/食品饮料/汽车消费/
 *      消费电子/零售/餐饮/电商/文旅消费 等行业词），只保留 促消费/扩内需/以旧换新/
 *      国补/社零/服务消费/消费政策… 等政策/宏观拉动词。
 *   B) 修复 t_家电 中文子串碰撞：「国家电网」会误命中裸词「家电」→ 改为长词
 *      （白色家电/家电以旧换新/空调/冰箱…），国家电网不再误入 家电 与 消费。
 *   C) 修复 dedupeDeptTheme 单一部委分支丢弃题材标签的不一致：使部委发文拉动消费
 *      的新闻（财政部促消费 / 国常会提振消费 / 发改委扩内需）也能归入 消费
 *      （与 isDeptDoc 分支行为保持一致）。
 *
 * 覆盖：
 *   1) t_消费 定义不再含行业词（家电/食品饮料/零售/餐饮/电商/汽车消费/消费电子/文旅消费）
 *   2) t_家电 不再含裸「家电」2字词（无子串碰撞源）
 *   3) 「国家电网…」文本不归 消费 / 家电（误命中消除）
 *   4) 部委拉动消费探针 归 消费（财政部促消费 / 国常会提振消费 / 发改委扩内需）
 *   5) 真实数据：消费类目存在且样本均为政策拉动类；国家电网条目不进消费
 *   6) 无 JS 报错
 *
 * 用法：node scripts/e2e-consume-fix-20261110j.mjs
 * ============================================================ */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const VUE_LOCAL = path.join(ROOT, '_repo_tmp', 'vue.global.prod.js');
const ADMIN_PW = 'Admin@2026';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  -> ' + extra : '')); }
}

function serveStatic(dir) {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/') p = '/index.html';
    const f = path.join(dir, p);
    if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('404'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port })));
}

async function main() {
  // 数据前置检查
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/hot-topics/index.json'), 'utf8'));
  const briefDates = (idx.briefsDates || []).filter(Boolean).slice(-6);
  check('index.json 已含快讯日期清单 briefsDates（最近6天）', briefDates.length > 0, JSON.stringify(briefDates));
  let allItems = [];
  briefDates.forEach(d => {
    const f = path.join(ROOT, 'data/hot-topics', `briefs-${d}.json`);
    if (fs.existsSync(f)) { const j = JSON.parse(fs.readFileSync(f, 'utf8')); allItems = allItems.concat(j.items || []); }
  });
  check('合并真实快讯 items 条数充足（>=100）', allItems.length >= 100, '共 ' + allItems.length + ' 条');
  const briefJson = { items: allItems };
  console.log(`（使用真实数据：最近 ${briefDates.length} 天，共 ${allItems.length} 条）\n`);

  const { srv, port } = await serveStatic(ROOT);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  if (fs.existsSync(VUE_LOCAL)) {
    await page.route('**unpkg.com/**', r => r.fulfill({ path: VUE_LOCAL, contentType: 'text/javascript' }));
  }
  await page.route(u => /gtimg\.cn|eastmoney\.com|workers\.dev/.test(u.href), r => r.abort());

  console.log('1) 进入系统并打开「全球信息」页');
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  await page.waitForSelector('#auth-gate', { timeout: 20000 });
  await page.evaluate(async (pw) => { await Auth.setup('admin', pw, pw); AuthUI.enterApp(); }, ADMIN_PW);
  await page.waitForFunction(() => !document.getElementById('auth-gate') && document.getElementById('app').__vue_app__, { timeout: 45000 });
  await page.locator('.nav-item', { hasText: '全球信息' }).click();
  await page.waitForSelector('.brief-panel', { timeout: 30000 });

  console.log('2) 关键词定义校验（收窄 + 去碰撞）');
  const defs = await page.evaluate(() => {
    const H = window.HotTopics;
    if (!H || !H.BRIEF_KEYWORDS) return { missing: true };
    const consume = H.BRIEF_KEYWORDS['t_消费'] || [];
    const home = H.BRIEF_KEYWORDS['t_家电'] || [];
    return { consume, home };
  });
  check('HotTopics.BRIEF_KEYWORDS 可用', !defs.missing);
  const IND_WORDS = ['家电', '食品饮料', '汽车消费', '消费电子', '零售', '餐饮', '电商', '直播带货', '文旅消费', '手机消费'];
  const leaked = IND_WORDS.filter(w => defs.consume.includes(w));
  check('t_消费 不再含行业词（家电/食品饮料/零售/餐饮/电商/汽车消费/消费电子/文旅消费…）', leaked.length === 0, 'leaked=' + JSON.stringify(leaked));
  const POLICY_OK = ['促消费', '扩内需', '以旧换新', '国补', '社零', '服务消费', '消费政策'].every(w => defs.consume.includes(w));
  check('t_消费 保留政策/宏观拉动词（促消费/扩内需/以旧换新/国补/社零/服务消费/消费政策）', POLICY_OK);
  // 裸「家电」2字词（碰撞源）应不再出现
  const hasBare = defs.home.includes('家电');
  check('t_家电 不再含裸「家电」2字词（消除与国家电网的子串碰撞）', !hasBare, 'hasBare=' + hasBare);
  const hasLong = defs.home.some(w => w.length >= 3);
  check('t_家电 含长词（白色家电/家电以旧换新/空调/冰箱…）以精准命中', hasLong);

  console.log('3) 误命中消除：国家电网 不进 消费 / 家电');
  const grid = await page.evaluate(() => {
    const H = window.HotTopics;
    const items = [
      { text: '国家电网与中国中车集团举行会谈' },
      { text: '国家电网召开年度工作会议部署电网建设' }
    ];
    const cats = H.briefStats(items, 'theme').map(t => t.name);
    return { cats };
  });
  check('「国家电网…」文本不归 消费', !grid.cats.includes('消费'), JSON.stringify(grid.cats));
  check('「国家电网…」文本不归 家电', !grid.cats.includes('家电'), JSON.stringify(grid.cats));

  console.log('4) 部委拉动消费 归入 消费（修复 false negative）');
  const minProbes = await page.evaluate(() => {
    const H = window.HotTopics;
    const items = [
      { text: '财政部下达促消费专项资金，支持家电以旧换新' },
      { text: '国务院常务会议部署提振消费专项行动' },
      { text: '发改委：扩内需促消费一揽子政策落地' }
    ];
    const res = items.map(it => {
      const cats = H.briefStats([it], 'theme').map(t => t.name);
      return { text: it.text.slice(0, 12), inConsume: cats.includes('消费'), cats };
    });
    return res;
  });
  let allIn = true; const detail = [];
  minProbes.forEach(r => { if (!r.inConsume) allIn = false; detail.push(`${r.text} => 消费:${r.inConsume}`); });
  check('三类部委拉动消费新闻均归入 消费', allIn, detail.join(' ; '));

  console.log('5) 真实数据：消费样本为政策拉动类 + 国家电网不进消费');
  const real = await page.evaluate((base) => {
    const H = window.HotTopics;
    const consumeKw = H.BRIEF_KEYWORDS['t_消费'] || [];
    const st = H.briefStats(base, 'theme');
    const xf = st.find(t => t.name === '消费');
    const cnt = xf ? xf.count : 0;
    const news = xf ? (xf.news || []) : [];
    const sample = news.slice(0, 6).map(n => (n.text || '').slice(0, 40));
    // 每条消费样本必须命中 t_消费 的真实政策词之一（证明不是碰撞/行业词混入）
    const bad = news.filter(n => !consumeKw.some(kw => (n.text || '').includes(kw))).slice(0, 3).map(n => (n.text || '').slice(0, 50));
    const allMatched = news.length > 0 && bad.length === 0;
    // 国家电网条目是否进消费
    let gridIn = 0;
    base.forEach(it => { if (it.text.includes('国家电网')) { const r = H.briefStats([it], 'theme').map(t => t.name); if (r.includes('消费')) gridIn++; } });
    return { cnt, sample, bad, allMatched, gridIn };
  }, briefJson.items.map(it => ({ text: it.text || '' })));
  check('真实数据中存在 消费 类目', real.cnt > 0, 'cnt=' + real.cnt);
  check('消费 样本均命中 t_消费 真实政策词（无碰撞/行业词混入）', real.allMatched,
    real.bad.join(' | '));
  check('真实数据中含「国家电网」的条目不进 消费', real.gridIn === 0, 'gridIn=' + real.gridIn);

  check('无 JS 报错', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  srv.close();

  console.log(`\n==== e2e 结果：${pass} 通过 / ${fail} 失败 ====`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error('运行异常:', e); process.exit(2); });
