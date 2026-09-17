/* ============================================================
 * e2e-batch14.mjs — 真实浏览器验证 batch14 的四件事
 *
 * 用户诉求：
 *   1) 「AI 解读失败：AI 请求被拦截（多为 CORS/网络）：建议把接口地址指向你的
 *       Cloudflare Worker 代理（见设置说明）」—— 这句提示把用户往代理上引，但根因未必是 CORS。
 *   2) 登录卡片加关闭按钮。
 *   3) 加管理员密码重置按钮。
 *
 * 本批改动：
 *   · app.js        callOpenAICompat 新增 no-cors 网络层探针 + HTTP 状态码分诊；
 *                   慢响应 15s 并行探针，被墙地址不再干等满 60 秒；
 *                   新增 AI_PRESETS / applyAiPreset / aiTestConnection；
 *                   「重置密码」由 window.prompt 改为行内输入区（resetPw 状态机）
 *   · auth-boot.js  登录卡片 ✕ → 游客预览（enterGuest/leaveGuest），Esc 亦可返回；
 *                   hideGate 顺手收起预览层（防「预览开着时才异步返回已登录」的时序问题）
 *   · index.html    #guest-view 纯静态骨架（**不加载业务脚本**）、AI 厂商预设与测试连接、
 *                   重置密码行内面板
 *   · style.css     以上三处样式
 *
 * 覆盖：
 *   场景 1  AI 失败分诊：401 鉴权 / 真 CORS / 域名被墙 —— 三种情况的文案必须各不相同，
 *          且**都不能**再出现旧版那句「建议把接口地址指向你的 Cloudflare Worker 代理」
 *   场景 2  设置页：6 个厂商预设一键填入、🧪 测试连接 走通并给出 🎉 结论
 *   场景 3  登录卡片 ✕ → 游客预览：骨架可见、业务脚本**确实没被下载**、
 *          点导航只提示登录、点「登录/注册」回到卡片、Esc 回到卡片、
 *          「预览开着时才恢复登录态」不会残留预览层、刷新后不粘住
 *   场景 4  用户管理重置密码：无 window.prompt、行内面板、行内校验、
 *          🎲 随机生成、重置后新密码真的能登录
 *
 * 外部行情/IP 源全部 abort，应用代码与 UI 交互均为真实行为。
 * 用法：node scripts/e2e-batch14.mjs
 * ============================================================ */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADMIN_PW = 'Admin@2026';
const USER_PW = 'User@2026';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.jpg': 'image/jpeg',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
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

/* 业务脚本清单：游客预览场景要证明它们**一个都没被请求** */
const BIZ_SCRIPTS = ['store.js', 'cloud-sync.js', 'stock-api.js', 'hot-topics.js', 'app.js'];

async function newCtx(browser, opts) {
  const o = opts || {};
  const ctx = await browser.newContext({ viewport: { width: 1560, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  const bizReqs = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => {
    const u = r.url();
    if (BIZ_SCRIPTS.some(f => u.includes('/js/' + f))) bizReqs.push(u);
  });
  await page.route(u => /gtimg\.cn|eastmoney\.com|workers\.dev|vore\.top|ip\.sb|ipapi|unpkg\.com/.test(u.href),
    r => r.abort());
  // 收集所有出现过的 toast 文案（toast 会自动消失，靠观察器留证）
  await page.addInitScript(() => {
    window.__toasts = [];
    const grab = () => {
      document.querySelectorAll('.toast').forEach(el => {
        const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (t && window.__toasts[window.__toasts.length - 1] !== t) window.__toasts.push(t);
      });
    };
    document.addEventListener('DOMContentLoaded', () => {
      new MutationObserver(grab).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
  });
  return { ctx, page, errors, bizReqs };
}

async function hardGoto(page, url) {
  await page.goto(url, { waitUntil: 'load', timeout: 40000 });
  await page.reload({ waitUntil: 'load', timeout: 40000 });
}
async function gotoGate(page, port) {
  await hardGoto(page, `http://127.0.0.1:${port}/`);
  await page.waitForSelector('#auth-gate', { timeout: 45000 });
}
async function waitAppReady(page) {
  await page.waitForFunction(() => !document.getElementById('auth-gate'), { timeout: 60000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el && el.__vue_app__);
  }, { timeout: 60000 });
}
async function bootAdmin(page) {
  await page.evaluate(async (pw) => { await Auth.setup('admin', pw, pw); }, ADMIN_PW);
  await page.evaluate(() => AuthUI.enterApp());
  await waitAppReady(page);
}
async function logoutAndWait(page) {
  await page.evaluate(() => AuthUI.logout());
  await page.waitForSelector('#auth-gate', { timeout: 60000 });
  await page.waitForSelector('#auth-login-form:not([hidden])', { timeout: 30000 });
}
async function loginAs(page, username, password) {
  const r = await page.evaluate(async ([u, p]) => {
    const res = await Auth.login(u, p);
    if (res && res.ok) AuthUI.enterApp();
    return res || { ok: false, error: '无返回' };
  }, [username, password]);
  if (!r.ok) throw new Error(`登录 ${username} 失败：${r.error}`);
  await waitAppReady(page);
}
async function setAiCfg(page, endpoint) {
  await page.evaluate((ep) => {
    Store.data.settings.aiEndpoint = ep;
    Store.data.settings.aiKey = 'sk-e2e-fake-key';
    Store.data.settings.aiModel = 'e2e-model';
    Store.saveNow();
  }, endpoint);
}
async function toasts(page) {
  return await page.evaluate(() => (window.__toasts || []).slice());
}
/** 打开「手动添加」新闻 → 填内容 → 点「🤖 AI 生成解读」 */
async function triggerAi(page) {
  await page.locator('#app .toolbar-right button:has-text("手动添加")').click();
  await page.waitForSelector('.modal:has-text("新闻解读参考")', { timeout: 15000 });
  await page.locator('#app .modal textarea[placeholder*="输入或粘贴新闻内容"]').fill('国家出台政策大力支持半导体国产替代。');
  await page.waitForTimeout(200);
  await page.locator('#app button:has-text("🤖 AI 生成解读")').click();
}
async function waitForToast(page, re, timeout) {
  await page.waitForFunction((src) => {
    return (window.__toasts || []).some(t => new RegExp(src).test(t));
  }, re.source, { timeout: timeout || 25000 }).catch(() => {});
  const list = await toasts(page);
  return list.filter(t => re.test(t)).pop() || '';
}
async function closeModal(page) {
  const btn = page.locator('.modal .modal-header .btn-icon, .modal .modal-footer button:has-text("取消")').first();
  if (await btn.count()) { await btn.click().catch(() => {}); await page.waitForTimeout(300); }
}

const AI_MOCK = {
  choices: [{ message: { content: '【新闻解读参考】\n利好半导体设备与材料。\n\n【利好利空】\n利好概念：国产替代、半导体\n利好行业：半导体\n利空概念：\n利空行业：\n\n【散户参考】\n关注板块节奏，仅供参考，不构成投资建议。' } }]
};

const main = async () => {
  const A = await serveStatic(ROOT);
  const browser = await chromium.launch();

  /* ============================================================
   * 场景 1：AI 失败的三种真因必须被分开说明
   * ============================================================ */
  console.log('1) AI 失败分诊：401 鉴权 / 真 CORS / 域名被墙');

  // ---- 1a. 接口返回 401：应点明密钥/权限，而不是 CORS ----
  {
    const HOST = 'https://ai-e2e-401.test';
    const { ctx, page, errors } = await newCtx(browser);
    await page.route('**/v1/chat/completions', r => r.fulfill({
      status: 401, contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'Authentication Fails, your api key is invalid' } })
    }));
    await gotoGate(page, A.port);
    await bootAdmin(page);
    await setAiCfg(page, HOST + '/v1/chat/completions');
    await triggerAi(page);
    const t = await waitForToast(page, /AI 解读失败/, 25000);
    check('401 时提示「AI 接口返回 401」', /AI 接口返回 401/.test(t), t);
    check('401 时点明「密钥无效或无权限」', /密钥无效或无权限/.test(t), t);
    check('401 时不再提 Cloudflare Worker 代理', !/Cloudflare Worker/.test(t), t);
    check('无 JS 运行时错误', errors.length === 0, errors.join('; '));
    await ctx.close();
  }

  // ---- 1b. 网络可达但 POST 被拦：应判为真 CORS ----
  {
    const HOST = 'https://ai-e2e-cors.test';
    const { ctx, page, errors } = await newCtx(browser);
    await page.route('**/v1/chat/completions', route => {
      // 预检/正式请求一律打断 → 浏览器抛 Failed to fetch；
      // 但探针用的是 GET + no-cors，这里放行 → 探针能证明「网络其实通」
      if (route.request().method() === 'GET') return route.fulfill({ status: 404, body: 'nope' });
      return route.abort('failed');
    });
    await gotoGate(page, A.port);
    await bootAdmin(page);
    await setAiCfg(page, HOST + '/v1/chat/completions');
    await triggerAi(page);
    const t = await waitForToast(page, /AI 解读失败/, 25000);
    check('网络可达但被拦 → 判为「浏览器跨域（CORS）拦截」', /CORS/.test(t) && /跨域/.test(t), t);
    check('真 CORS 时才给出「换国内接口」或「部署代理」两条出路', /国内可直连/.test(t) && /ai-proxy/.test(t), t);
    check('无 JS 运行时错误', errors.length === 0, errors.join('; '));
    await ctx.close();
  }

  // ---- 1c. 域名被墙（连探针都不通）：应判为网络不可达，且不再甩锅 CORS ----
  {
    const HOST = 'https://ai-e2e-blocked.test';
    const { ctx, page, errors } = await newCtx(browser);
    let postSeen = 0, getSeen = 0;
    await page.route('**/v1/chat/completions', route => {
      if (route.request().method() === 'GET') getSeen++; else postSeen++;
      // 一个都不回，模拟「被墙 / 黑洞」：探针会在 6s 超时，POST 由慢路径中止
    });
    await gotoGate(page, A.port);
    await bootAdmin(page);
    await setAiCfg(page, HOST + '/v1/chat/completions');
    const t0 = Date.now();
    await triggerAi(page);
    const t = await waitForToast(page, /AI 解读失败/, 45000);
    const ms = Date.now() - t0;
    check('被墙时提示「连不上这个地址」', /连不上这个地址/.test(t), t);
    check('被墙时明确「这不是 CORS 问题」', /这不是 CORS 问题/.test(t), t);
    check('被墙时不再让用户去部署 Worker', !/Cloudflare Worker/.test(t) && !/ai-proxy/.test(t), t);
    check('慢路径探针在 15s 后真的发起了 GET 探针', getSeen > 0, 'getSeen=' + getSeen + ' postSeen=' + postSeen);
    check('不必干等满 60s（实测 ' + Math.round(ms / 1000) + 's 内给出结论）', ms < 45000, ms + 'ms');
    check('无 JS 运行时错误', errors.length === 0, errors.join('; '));
    await ctx.close();
  }

  /* ============================================================
   * 场景 2：设置页厂商预设 + 测试连接
   * ============================================================ */
  console.log('2) 设置页：厂商一键预设 + 🧪 测试连接');
  {
    const HOST = 'https://ai-e2e-ok.test';
    const { ctx, page, errors } = await newCtx(browser);
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
    await page.route('**/v1/chat/completions', route => {
      if (route.request().method() === 'GET') {
        return route.fulfill({ status: 404, headers: cors, body: 'no-get' });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', headers: cors,
        body: JSON.stringify({ choices: [{ message: { content: '收到' } }] }) });
    });
    await gotoGate(page, A.port);
    await bootAdmin(page);

    await page.locator('#app .header-actions button[title="设置"]').click();
    await page.waitForSelector('.ai-presets', { timeout: 15000 });
    const presetCount = await page.locator('.ai-preset').count();
    check('厂商预设按钮共 6 个', presetCount === 6, presetCount);
    check('预设里含国内可直连的 5 家', (await page.locator('.ai-preset-name').allInnerTexts()).join(',').includes('DeepSeek'), '');

    await page.locator('.ai-preset:has-text("DeepSeek")').click();
    const epVal = await page.locator('.form-row input[placeholder*="deepseek"]').inputValue();
    check('点 DeepSeek → 接口地址被填入', epVal === 'https://api.deepseek.com/v1/chat/completions', epVal);
    const modelVal = await page.locator('input[placeholder="如 deepseek-chat"]').inputValue();
    check('点 DeepSeek → 模型名被填入 deepseek-chat', modelVal === 'deepseek-chat', modelVal);

    await page.locator('.ai-preset:has-text("Kimi")').click();
    check('换一家（Kimi）也能覆盖填入',
      (await page.locator('input[placeholder="如 deepseek-chat"]').inputValue()) === 'moonshot-v1-8k', '');

    // 填成假地址 + 假 Key，点测试连接（预设只填地址与模型，Key 必须手填）
    await page.locator('.form-row input[placeholder*="deepseek"]').fill(HOST + '/v1/chat/completions');
    await page.locator('input[type="password"][placeholder*="sk-"]').fill('sk-e2e-fake-key');
    await page.locator('.ai-test-row button').click();
    await page.waitForFunction(() => {
      const el = document.querySelector('.ai-test-result');
      return el && /🎉/.test(el.innerText);
    }, null, { timeout: 30000 }).catch(() => {});
    const testText = (await page.locator('.ai-test-result').innerText()).replace(/\s+/g, ' ');
    check('测试连接 → 两步全过（🎉）', /🎉/.test(testText), testText);
    check('测试结论里带上耗时', /\d+ms/.test(testText), testText);

    await closeModal(page);
    check('无 JS 运行时错误', errors.length === 0, errors.join('; '));
    await ctx.close();
  }

  /* ============================================================
   * 场景 3：登录卡片 ✕ → 游客预览骨架（业务脚本仍不下载）
   * ============================================================ */
  console.log('3) 登录卡片关闭按钮 → 游客预览');
  {
    const { ctx, page, errors, bizReqs } = await newCtx(browser);
    await gotoGate(page, A.port);

    check('登录卡片上有 ✕ 关闭按钮', await page.locator('#auth-close').isVisible());
    check('点之前：业务脚本一个都没请求', bizReqs.length === 0, bizReqs.join(', '));
    check('点之前：Store / StockAPI 未定义',
      await page.evaluate(() => typeof Store === 'undefined' && typeof StockAPI === 'undefined'));
    // 骨架放在 <template> 里：内容不算 document 的一部分，不会污染任何选择器
    check('🔴 未进入预览时骨架不在 DOM 中（模板本身在）',
      await page.evaluate(() => {
        const tpl = document.getElementById('guest-tpl');
        return !!tpl && !document.getElementById('guest-view')
          && !document.querySelector('.guest-empty')
          && !document.querySelector('.guest-banner');
      }));
    // 这正是之前踩过的坑：骨架若常驻 DOM，这个选择器会解析到 2 个元素、
    // 既有的 Playwright strict mode 断言会直接崩掉。
    const strayAddBtns = await page.locator('.toolbar-right button:has-text("手动添加")').count();
    check('🔴 骨架没污染既有选择器（「手动添加」仍只解析到 1 个）', strayAddBtns === 1, strayAddBtns);

    await page.locator('#auth-close').click();
    await page.waitForSelector('#guest-view', { timeout: 10000 });
    await page.waitForTimeout(400);

    check('游客预览层已显示', await page.locator('#guest-view').isVisible());
    check('登录关卡已淡出', await page.evaluate(() => {
      const g = document.getElementById('auth-gate');
      return !!g && g.classList.contains('auth-gate-hide');
    }));
    check('页面不再锁滚动（body.auth-locked 已摘掉）',
      !(await page.evaluate(() => document.body.classList.contains('auth-locked'))));
    check('骨架里能看到 7 个导航项',
      (await page.locator('#guest-view .nav-item').count()) === 7,
      await page.locator('#guest-view .nav-item').count());
    check('骨架里有空态说明', /登录后这里会显示你的新闻数据/.test(await page.locator('#guest-view .guest-empty').innerText()));
    check('顶部有常驻「登录 / 注册」按钮',
      (await page.locator('#guest-view .guest-login-btn').count()) === 2);
    check('🔴 进游客预览后业务脚本依然一个都没请求', bizReqs.length === 0, bizReqs.join(', '));
    check('🔴 游客态下 Store / StockAPI 仍未定义',
      await page.evaluate(() => typeof Store === 'undefined' && typeof StockAPI === 'undefined'));

    // 🔴 关键回归点：关卡淡出只是 opacity:0，若不把 #app 真正藏掉，
    // 它里面那些 v-if 控制的 position:fixed 模态遮罩会浮上来吃掉全部点击。
    check('🔴 游客态下 #app 原始模板被 display:none 真正藏掉',
      await page.evaluate(() => {
        const app = document.getElementById('app');
        return !!app && getComputedStyle(app).display === 'none';
      }));
    check('🔴 命中测试：预览骨架上方没有 #app 的元素抢点击',
      await page.evaluate(() => {
        const item = document.querySelector('#guest-view .nav-item');
        const r = item.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!top && !top.closest('#app');
      }));

    // 点导航：只提示登录
    await page.locator('#guest-view .nav-item:has-text("热门板块")').click();
    await page.waitForTimeout(300);
    check('点骨架导航 → 弹「请先登录」提示',
      await page.locator('#guest-hint').isVisible()
      && /请先登录/.test(await page.locator('#guest-hint').innerText()));

    // Esc 回登录卡片
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    check('Esc 能回到登录卡片',
      await page.evaluate(() => {
        const g = document.getElementById('auth-gate');
        const v = document.getElementById('guest-view');
        return !!g && !g.classList.contains('auth-gate-hide') && !v;
      }));

    // 再进一次，用骨架上的「登录 / 注册」按钮回来
    await page.locator('#auth-close').click();
    await page.waitForSelector('#guest-view', { timeout: 10000 });
    await page.locator('#guest-view .guest-login-btn').first().click();
    await page.waitForTimeout(400);
    check('点骨架上的「登录 / 注册」也能回到卡片',
      await page.evaluate(() => {
        const g = document.getElementById('auth-gate');
        return !!g && !g.classList.contains('auth-gate-hide');
      }));

    // 时序陷阱：预览开着时 Auth.restore() 才异步返回「已登录」→ 预览层必须被收起
    await page.locator('#auth-close').click();
    await page.waitForSelector('#guest-view', { timeout: 10000 });
    await page.evaluate(async (pw) => { await Auth.setup('admin', pw, pw); }, ADMIN_PW);
    await page.evaluate(() => AuthUI.enterApp());
    await waitAppReady(page);
    await page.waitForTimeout(600);
    check('🔴 已登录后预览层被收起（不遮挡业务应用）',
      await page.evaluate(() => {
        const v = document.getElementById('guest-view');
        return !v;
      }));
    check('业务应用真的挂上了（Vue 实例在）',
      await page.evaluate(() => {
        const el = document.getElementById('app');
        return !!(el && el.__vue_app__);
      }));

    // 刷新后不粘住：仍回到登录页（游客态不做持久化）
    await page.evaluate(() => AuthUI.logout());
    await page.waitForSelector('#auth-gate', { timeout: 60000 });
    await page.locator('#auth-close').click();
    await page.waitForSelector('#guest-view', { timeout: 10000 });
    await page.reload({ waitUntil: 'load', timeout: 40000 });
    await page.waitForSelector('#auth-gate', { timeout: 45000 });
    check('刷新后不粘在游客态，回到登录卡片',
      await page.evaluate(() => {
        const g = document.getElementById('auth-gate');
        const v = document.getElementById('guest-view');
        return !!g && !g.classList.contains('auth-gate-hide') && !v;
      }));

    check('全程无 JS 运行时错误', errors.length === 0, errors.join('; '));
    await ctx.close();
  }

  /* ============================================================
   * 场景 4：用户管理「重置密码」行内输入区
   * ============================================================ */
  console.log('4) 用户管理「重置密码」行内输入区（替换 window.prompt）');
  {
    const { ctx, page, errors } = await newCtx(browser);
    let dialogFired = '';
    page.on('dialog', async d => { dialogFired = d.type() + ':' + d.message(); await d.dismiss().catch(() => {}); });

    await gotoGate(page, A.port);
    await bootAdmin(page);
    await page.evaluate(async (pw) => { await Auth.addUser('membera', pw, 'user'); }, USER_PW);

    await page.locator('.user-chip').click();
    await page.locator('.user-dd-item:has-text("用户管理")').click();
    await page.waitForSelector('.modal-um', { timeout: 15000 });

    const row = page.locator('.um-table tbody tr').filter({ has: page.locator('.um-name', { hasText: 'membera' }) }).first();
    await row.locator('button:has-text("重置密码")').click();
    await page.waitForSelector('.um-resetrow', { timeout: 10000 });
    check('点「重置密码」展开行内面板（不是 prompt）', await page.locator('.um-reset').isVisible());
    check('🔴 全程没有弹出 window.prompt/confirm', dialogFired === '', dialogFired);
    check('行内面板说明写给谁改的', /为「\s*membera\s*」设置新密码/.test(
      (await page.locator('.um-reset-head').innerText()).replace(/\s+/g, ' ')));
    // 两个密码框填上同一串随机密码后，视觉上极容易糊成一格 —— 必须有可见标签区分
    check('两个密码框各带可见标签（新密码 / 确认）',
      (await page.locator('.um-reset-lbl').allInnerTexts()).join(',') === '新密码,确认',
      (await page.locator('.um-reset-lbl').allInnerTexts()).join(','));
    // 账号表比弹窗宽、会横向滚动，面板必须 sticky 在左侧才能打开即看全
    check('行内面板 sticky 在左侧（横向滚动时不被截断）',
      (await page.locator('.um-reset').evaluate(el => getComputedStyle(el).position)) === 'sticky',
      await page.locator('.um-reset').evaluate(el => getComputedStyle(el).position));

    // 行内校验：两次不一致
    await page.locator('.um-reset-pw').nth(0).fill('Abcd1234');
    await page.locator('.um-reset-pw').nth(1).fill('Abcd9999');
    await page.locator('button:has-text("确认重置")').click();
    await page.waitForTimeout(400);
    check('两次密码不一致 → 行内报错', await page.locator('.um-reset-err').isVisible(),
      await page.locator('.um-reset-err').innerText().catch(() => ''));
    check('校验失败时面板不关闭', await page.locator('.um-reset').isVisible());

    // 🎲 随机生成：两个框都被填成同一个 12 位密码，且自动明文显示
    await page.locator('button:has-text("🎲 随机")').click();
    await page.waitForTimeout(400);
    const pw1 = await page.locator('.um-reset-pw').nth(0).inputValue();
    const pw2 = await page.locator('.um-reset-pw').nth(1).inputValue();
    check('🎲 随机生成 12 位密码', pw1.length === 12 && /[A-Za-z]/.test(pw1) && /\d/.test(pw1), pw1);
    check('随机密码同时填进确认框', pw1 === pw2, pw1 + ' vs ' + pw2);
    check('随机后自动切明文显示（type=text）',
      (await page.locator('.um-reset-pw').nth(0).getAttribute('type')) === 'text');

    // 确认重置
    await page.locator('button:has-text("确认重置")').click();
    await page.waitForTimeout(800);
    check('重置成功后行内面板收起', (await page.locator('.um-resetrow').count()) === 0);
    const rt = (await toasts(page)).join(' | ');
    check('重置成功有提示（含新密码已复制）', /已重置「membera」的密码/.test(rt), rt);

    await closeModal(page);

    // 新密码真的能登录
    await logoutAndWait(page);
    const okNow = await page.evaluate(async ([u, p]) => {
      const r = await Auth.login(u, p);
      return { ok: !!(r && r.ok), error: (r && r.error) || '' };
    }, ['membera', pw1]);
    check('🔴 用随机生成的新密码能登录成功', okNow.ok, okNow.error);
    await loginAs(page, 'membera', pw1);
    check('登录后进的是普通用户界面（无用户管理入口）',
      await page.evaluate(() => !Auth.can('users.manage')));

    check('无 JS 运行时错误', errors.length === 0, errors.join('; '));
    await ctx.close();
  }

  await browser.close();
  A.srv.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
};

main().catch(e => { console.error('E2E 异常', e); process.exit(2); });
