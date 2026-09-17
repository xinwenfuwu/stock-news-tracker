/* ============================================================
 * e2e-news-ai.mjs — 新闻追踪页「概念分类/行业分类/自定义标记」
 * 改造为「新闻解读参考/利好利空/散户参考」+ 🤖 AI 生成解读 真实浏览器验证
 * 断言点：
 *   1) 列表表头三列已改名（新闻解读参考/利好利空/散户参考）
 *   2) 新增/编辑模态框三字段改名 + 出现「🤖 AI 生成解读」按钮
 *   3) 未配置 AI 时点击按钮给出「请先配置」提示，不报错
 *   4) 配置 AI 后用 page.route 伪造接口，点击按钮能把三段内容回填到三个字段
 * 用法：node scripts/e2e-news-ai.mjs
 * ============================================================ */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const VUE_LOCAL = path.join(ROOT, '_repo_tmp', 'vue.global.prod.js');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  -> ' + extra : '')); }
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

async function loginAs(page, username, password) {
  const u = username || 'e2e', p = password || 'E2ePass123';
  await page.waitForSelector('#auth-gate', { timeout: 20000 });
  await page.evaluate(async ([name, pass]) => {
    Auth.init();
    if (!Auth.hasUsers()) await Auth.setup(name, pass, pass);
    else if (!Auth.isLoggedIn()) await Auth.login(name, pass, true);
    AuthUI.enterApp();
  }, [u, p]);
  await page.waitForFunction(() => !document.getElementById('auth-gate'), { timeout: 45000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el && el.__vue_app__);
  }, { timeout: 45000 });
}

async function openApp(browser, port, settings) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  if (fs.existsSync(VUE_LOCAL)) {
    await page.route('**unpkg.com/**', r => r.fulfill({ path: VUE_LOCAL, contentType: 'text/javascript' }));
  }
  const saved = { settings: Object.assign({ categories: ['测试分类'], proxyUrl: '' }, settings || {}) };
  await page.addInitScript((s) => localStorage.setItem('stock-news-tracker-v1', JSON.stringify(s)), saved);
  await page.goto(`http://127.0.0.1:${port}/#news`, { waitUntil: 'load' });
  await loginAs(page);
  return { ctx, page, errors };
}

const AI_MOCK = {
  choices: [{ message: { content:
    '【新闻解读参考】\n这是一条利好半导体国产替代的政策新闻，意味着自主可控提速；利好设备与材料，利空进口依赖型企业。\n\n【利好利空】\n利好概念：半导体、国产替代、设备\n利好行业：半导体、电子\n利空概念：进口替代\n利空行业：消费电子\n\n【散户参考】\n可关注半导体ETF分批建仓、控制仓位；警惕追高风险。仅供参考，不构成投资建议' } }]
};

const main = async () => {
  const A = await serveStatic(ROOT);
  const browser = await chromium.launch();

  // ---------------- 场景 1：未配置 AI ----------------
  console.log('1) 未配置 AI：表头改名 + 模态框字段改名 + 按钮存在 + 提示配置');
  {
    const { ctx, page, errors } = await openApp(browser, A.port, {});
    await page.waitForSelector('.news-table', { timeout: 20000 });
    const heads = await page.locator('.news-table thead th').allInnerTexts();
    check('表头含「新闻解读参考」', heads.some(h => h.includes('新闻解读参考')), heads.join('|'));
    check('表头含「利好利空」', heads.some(h => h.includes('利好利空')), heads.join('|'));
    check('表头含「散户参考」', heads.some(h => h.includes('散户参考')), heads.join('|'));
    check('表头不再含旧名「概念分类」', !heads.some(h => h.includes('概念分类')), heads.join('|'));

    // 打开新增模态框
    await page.locator('.toolbar-right button:has-text("手动添加")').click();
    await page.waitForSelector('.modal:has-text("新闻解读参考")', { timeout: 10000 });
    check('模态框出现「新闻解读参考」标签', true);
    check('模态框出现「利好利空」标签', await page.locator('.modal label:has-text("利好利空")').count() > 0);
    check('模态框出现「散户参考」标签', await page.locator('.modal label:has-text("散户参考")').count() > 0);
    const aiBtn = page.locator('button:has-text("🤖 AI 生成解读")');
    check('出现「🤖 AI 生成解读」按钮', await aiBtn.count() > 0);

    // 填内容后按钮应可用，但点击应提示先配置
    await page.locator('.modal textarea[placeholder*="输入或粘贴新闻内容"]').fill('国家出台政策大力支持半导体国产替代。');
    await page.waitForTimeout(200);
    const disabledNoContent = await aiBtn.isDisabled();
    check('有内容后 AI 按钮可用', !disabledNoContent);
    await aiBtn.click();
    await page.waitForSelector('.toast', { timeout: 10000 });
    const toast = (await page.locator('.toast').innerText()).replace(/\s+/g, ' ');
    check('未配置时提示先配置 AI 接口', /设置\s*→\s*AI 解读|配置 AI/.test(toast), toast);
    await ctx.close();
  }

  // ---------------- 场景 2：配置 AI + 伪造接口 ----------------
  console.log('2) 配置 AI 并用伪造接口：点击按钮回填三段内容');
  {
    const aiEndpoint = 'https://ai.local.test/v1/chat/completions';
    const { ctx, page, errors } = await openApp(browser, A.port, {
      aiEndpoint, aiKey: 'sk-test', aiModel: 'deepseek-chat'
    });
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': '*'
    };
    await page.route('**/v1/chat/completions', route => {
      if (route.request().method() === 'OPTIONS') {
        return route.fulfill({ status: 204, headers: cors });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(AI_MOCK) });
    });

    await page.waitForSelector('.news-table', { timeout: 20000 });
    await page.locator('.toolbar-right button:has-text("手动添加")').click();
    await page.waitForSelector('.modal:has-text("新闻解读参考")', { timeout: 10000 });
    await page.locator('.modal textarea[placeholder*="输入或粘贴新闻内容"]').fill('国家出台政策大力支持半导体国产替代。');
    await page.waitForTimeout(200);
    await page.locator('button:has-text("🤖 AI 生成解读")').click();
    // 等待三段回填（成功 toast 出现）
    await page.waitForFunction(() => {
      const t = document.querySelector('.toast');
      return t && /AI 解读已生成/.test(t.innerText);
    }, { timeout: 20000 }).catch(() => {});

    const aiFields = page.locator('.modal textarea[rows="3"]');
    const ref = await aiFields.nth(0).inputValue();
    const bull = await aiFields.nth(1).inputValue();
    const retail = await aiFields.nth(2).inputValue();
    check('新闻解读参考已回填', /利好半导体|国产替代/.test(ref), ref.slice(0, 40));
    check('利好利空已回填（含利好概念）', /利好概念/.test(bull), bull.slice(0, 40));
    check('散户参考已回填', /散户|仅供参考/.test(retail), retail.slice(0, 40));
    check('无 JS 运行时错误', errors.length === 0, errors.join('; '));
    await ctx.close();
  }

  await browser.close();
  A.srv.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
};

main().catch(e => { console.error('E2E 异常', e); process.exit(2); });
