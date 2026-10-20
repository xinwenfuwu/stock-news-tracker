/* ============================================================
 * test-login-nocred.mjs — 「会员已开通却提示用户名或密码不正确」专项回归（20261019d）
 *
 * 用户实况：hy123 已开通 6 月期（到期 2027-04-16），登录却报「用户名或密码不正确」。
 *
 * 根因（线上实测）：云端注册表里 hy123 是「空占位」——
 *   { hash:'', pwSeal:'', placeholder:true, payMembershipUntil: <2027-04-16> }
 * 于是：
 *   ① loginRemote 见 !acc.hash 直接返回 {notFound:true} → 回落本机；
 *   ② 用户设备本机没有该账号（它是管理员设备建的）→ 必然「用户名或密码不正确」；
 *   ③ 本机明明有密码，但 registryKeyFields 不含凭证差异 → 「💾 保存 / 🔄 刷新」永远判不出脏，
 *      云端空白永远不会被补传，形成死循环。
 *
 * 本测试覆盖修复后的完整闭环：
 *   场景1 云端有 pwSeal、无 hash → 全新设备用正确密码登录成功
 *   场景2 同账号输错密码 → 报「会员已开通（有效期至 …）、密码不符」，不再是笼统密码错
 *   场景3 云端纯空占位 + 会员有效 → 明确报「缺少登录密码」，指引重置密码
 *   场景4 本机有密码 + 云端空占位 → 判脏，且「保存」把 hash/pwSeal 补传上云
 *   场景5 占位开通不得抹掉本机已有密码凭证
 *   场景6 grantMembership / grantMembershipPlaceholder 必须回执 loginReady / needPassword
 *   场景7 静态断言：recoverFromRegistry 作用域变量、app.js 回执文案、保存过滤放宽
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

/* ---------- mock GitHub 仓库（内存） ---------- */
const ghFiles = new Map();
function b64utf8(s) { return Buffer.from(s, 'utf8').toString('base64'); }
function regOf() { return JSON.parse(ghFiles.get('data/accounts/registry.json').content); }
function setRegistryAccounts(accounts) {
  ghFiles.set('data/accounts/registry.json', {
    content: JSON.stringify({ version: 1, updatedAt: Date.now(), accounts }, null, 2),
    sha: 'sha-reg-' + Math.random().toString(36).slice(2, 8),
  });
}
setRegistryAccounts({});

function makeStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); },
    clear: () => { m.clear(); },
  };
}

async function loadAuthForDevice(storage, { withToken = false } = {}) {
  const sandbox = {
    localStorage: storage,
    sessionStorage: makeStorage(),
    location: { hostname: 'xinwenfuwu.github.io', href: 'https://xinwenfuwu.github.io/stock-news-tracker/index.html' },
    navigator: { userAgent: 'Mozilla/5.0 (ReproNode)' },
    fetch: async (url, opt = {}) => {
      const u = String(url);
      if (!/^https?:/.test(u)) {
        const p = u.split('?')[0].replace(/^\.?\//, '');
        const f = ghFiles.get(p);
        if (!f) return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => JSON.parse(f.content) };
      }
      if (u.includes('api.github.com')) {
        const m = (opt.method || 'GET').toUpperCase();
        const mm = /\/contents\/(.+?)(\?|$)/.exec(u);
        const p = mm ? decodeURIComponent(mm[1]) : '';
        if (m === 'GET') {
          const f = ghFiles.get(p);
          if (!f) return { ok: false, status: 404, json: async () => ({}) };
          return { ok: true, status: 200, json: async () => ({ sha: f.sha, content: b64utf8(f.content), encoding: 'base64' }) };
        }
        if (m === 'PUT') {
          const body = JSON.parse(opt.body);
          const content = Buffer.from(body.content, 'base64').toString('utf8');
          ghFiles.set(p, { content, sha: 'sha-' + Math.random().toString(36).slice(2, 10) });
          return { ok: true, status: 200, json: async () => ({ content: { sha: ghFiles.get(p).sha } }) };
        }
      }
      return { ok: false, status: 500, json: async () => ({}) };
    },
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    crypto: (await import('node:crypto')).webcrypto,
    TextEncoder, TextDecoder, console, setTimeout, clearTimeout,
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);
  for (const f of ['js/auth.js', 'js/auth-sync.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  }
  if (withToken) storage.setItem('snt-auth-admin-token', 'ghp_mocktoken');
  return { ctx, sandbox, Auth: sandbox.Auth };
}

const FUTURE = Date.now() + 180 * 24 * 3600 * 1000;   // ≈ 6 个月后（2027-04 量级）

(async () => {
  /* ========== 场景1：云端有 pwSeal、无 hash → 全新设备正确密码可登录 ========== */
  console.log('\n[场景1] 云端无 hash 但有 pwSeal → 全新设备用正确密码登录成功');
  let sealOfSub = '';
  {
    const probe = await loadAuthForDevice(makeStorage(), {});
    sealOfSub = probe.Auth.sealPassword('qq123456');
    setRegistryAccounts({
      hy123: {
        hash: '', pwSeal: sealOfSub, placeholder: true, role: 'user', status: 'active', disabled: false,
        payMembershipUntil: FUTURE, paidAt: Date.now() - 1000, paidPlan: '6m', paidAmount: 1000,
        quotaMonths: 6, trialUntil: 0, trialDays: 0, createdAt: 1, updatedAt: 1,
      },
    });
    const C = await loadAuthForDevice(makeStorage(), {});
    const lg = await C.Auth.login('hy123', 'qq123456');
    check('全新设备用 qq123456 登录成功（会员有效期内）', lg.ok === true, JSON.stringify(lg.error || 'ok'));
    check('登录落地本机并带会员到期时间', lg.ok && Number(lg.user && lg.user.payMembershipUntil) === FUTURE, JSON.stringify(lg.user && lg.user.payMembershipUntil));
    check('落地后不再是占位账号', lg.ok && lg.user && lg.user.placeholder === false, 'placeholder=' + (lg.user && lg.user.placeholder));
    check('落地后本机可用原密码再登一次（密码已在本地重建）', (await C.Auth.login('hy123', 'qq123456')).ok === true);
  }

  /* ========== 场景2：密码不符 → 明确说明「会员已开通、只是密码不对」 ========== */
  console.log('\n[场景2] 会员有效但密码不符 → 回执说明会员已开通');
  {
    setRegistryAccounts({
      hy123: {
        hash: '', pwSeal: sealOfSub, placeholder: true, role: 'user', status: 'active',
        payMembershipUntil: FUTURE, quotaMonths: 6, createdAt: 1, updatedAt: 1,
      },
    });
    const C = await loadAuthForDevice(makeStorage(), {});
    const lg = await C.Auth.login('hy123', 'wrongpass');
    check('密码错误时登录失败', lg.ok === false);
    check('回执点明「会员已开通」而非笼统密码错', /会员已开通/.test(String(lg.error || '')), lg.error);
    check('回执带有效期日期', /\d{4}-\d{2}-\d{2}/.test(String(lg.error || '')), lg.error);
  }

  /* ========== 场景3：云端纯空占位 + 会员有效 → 明确指出缺登录密码 ========== */
  console.log('\n[场景3] 云端空占位（无 hash 无 pwSeal）+ 会员有效 → 明确「缺少登录密码」');
  {
    setRegistryAccounts({
      hy123: {
        hash: '', pwSeal: '', placeholder: true, role: 'user', status: 'active',
        payMembershipUntil: FUTURE, quotaMonths: 6, createdAt: 1, updatedAt: 1,
      },
    });
    const C = await loadAuthForDevice(makeStorage(), {});
    const lg = await C.Auth.login('hy123', 'qq123456');
    check('登录仍失败（无凭证不能放行，安全）', lg.ok === false);
    check('回执说明「缺少登录密码」', /缺少登录密码/.test(String(lg.error || '')), lg.error);
    check('回执指引管理员「重置密码」', /重置密码/.test(String(lg.error || '')), lg.error);
    check('不再是笼统的「用户名或密码不正确」', !/^用户名或密码不正确$/.test(String(lg.error || '')), lg.error);
  }

  /* ========== 场景4：本机有密码 + 云端空占位 → 判脏并补传上云 ========== */
  console.log('\n[场景4] 本机有密码、云端空占位 → 判脏，「保存」把 hash/pwSeal 补传上云');
  {
    setRegistryAccounts({
      hy123: {
        hash: '', pwSeal: '', placeholder: true, role: 'user', status: 'active',
        payMembershipUntil: FUTURE, quotaMonths: 6, paidPlan: '6m', paidAmount: 1000,
        paidAt: 1700000000000, registerDate: '2026-10-18', trialUntil: 0, trialDays: 0, createdAt: 1, updatedAt: 1,
      },
    });
    const store = makeStorage();
    const A = await loadAuthForDevice(store, { withToken: true });
    await A.Auth.setup('admin', 'Admin@2026', 'Admin@2026');
    // 管理员本机为 hy123 设置密码（模拟用户在管理员面板设过密码）
    const ar = await A.Auth.addUser('hy123', 'qq123456', { role: 'user' });
    check('本机成功为 hy123 设置密码', ar.ok === true, JSON.stringify(ar.error || 'ok'));

    const detail = A.Auth.listUsersDetail().find(u => u.username === 'hy123');
    check('本机账号视图暴露 hasCred=true（不含密码值）', !!detail && detail.hasCred === true, 'hasCred=' + (detail && detail.hasCred));

    const localKey = A.Auth.registryKeyFields(detail);
    const cloudKey = A.Auth.registryKeyFields(regOf().accounts['hy123']);
    check('本机 hasCred=true / 云端 hasCred=false', localKey.hasCred === true && cloudKey.hasCred === false, JSON.stringify({ localKey, cloudKey }));
    check('两端指纹不一致 → 判为「未保存」（可被保存/刷新补传）', JSON.stringify(localKey) !== JSON.stringify(cloudKey));

    const sr = await A.Auth.saveUsersToRegistry(['hy123']);
    check('保存成功（至少 1 个上云）', sr.ok === true && (sr.saved || []).includes('hy123'), JSON.stringify(sr));
    const cloud = regOf().accounts['hy123'];
    check('云端已获得 pbkdf2 哈希', !!cloud && /^pbkdf2\$/.test(String(cloud.hash)), 'hash=' + (cloud && cloud.hash));
    check('云端已获得 pwSeal（管理员可查看密码）', !!cloud && !!cloud.pwSeal, 'pwSeal=' + (cloud && cloud.pwSeal));
    check('云端 placeholder 已清除', !!cloud && cloud.placeholder === false, 'placeholder=' + (cloud && cloud.placeholder));
    check('云端会员到期时间未被改动', !!cloud && Number(cloud.payMembershipUntil) === FUTURE, 'pmu=' + (cloud && cloud.payMembershipUntil));

    // 补传后，另一台全新设备用原密码即可登录（用户侧闭环）
    const C = await loadAuthForDevice(makeStorage(), {});
    const lg = await C.Auth.login('hy123', 'qq123456');
    check('补传后全新设备用原密码登录成功', lg.ok === true, JSON.stringify(lg.error || 'ok'));
  }

  /* ========== 场景5：已有真实账号时不得走占位（避免把有密码账号变成空占位） ========== */
  console.log('\n[场景5] 已有真实账号 → 占位开通必须拒绝，改走正常开通且保留凭证');
  {
    setRegistryAccounts({});
    const A = await loadAuthForDevice(makeStorage(), { withToken: true });
    await A.Auth.setup('admin', 'Admin@2026', 'Admin@2026');
    check('管理员已就绪', !!A.Auth.isAdmin && A.Auth.isAdmin() === true);
    await A.Auth.addUser('edgecase', 'Edge@123456', { role: 'user' });
    const ph = await A.Auth.grantMembershipPlaceholder('edgecase', 6, { paidAt: Date.now(), amount: 1000 });
    check('已有真实账号时占位开通被拒绝（exists）', ph && ph.ok === false && ph.exists === true, JSON.stringify(ph));
    // 走正常开通：凭证必须保留，并明确回执可登录
    const g = A.Auth.grantMembership('edgecase', 6, { paidAt: Date.now(), amount: 1000 });
    check('正常开通成功', g.ok === true, JSON.stringify(g.error));
    check('正常开通回执 loginReady=true', g.loginReady === true, JSON.stringify(g));
    const d2 = A.Auth.listUsersDetail().find(u => u.username === 'edgecase');
    check('本机 pwSeal 未被抹掉', !!d2 && d2.hasPassword === true, 'hasPassword=' + (d2 && d2.hasPassword));
    const sr2 = await A.Auth.saveUsersToRegistry(['edgecase']);
    check('保存成功', sr2.ok === true && (sr2.saved || []).includes('edgecase'), JSON.stringify(sr2));
    const cl = regOf().accounts['edgecase'];
    check('云端记录带凭证（未写成空占位）', !!cl && /^pbkdf2\$/.test(String(cl.hash)) && !!cl.pwSeal, JSON.stringify(cl && { hash: String(cl.hash).slice(0, 12), pwSeal: !!cl.pwSeal }));
    check('云端会籍已写入', !!cl && Number(cl.payMembershipUntil) > Date.now(), 'pmu=' + (cl && cl.payMembershipUntil));
  }

  /* ========== 场景6：开通回执必须含 loginReady / needPassword ========== */
  console.log('\n[场景6] grantMembership 回执 loginReady / needPassword');
  {
    setRegistryAccounts({});
    const A = await loadAuthForDevice(makeStorage(), { withToken: true });
    await A.Auth.setup('admin', 'Admin@2026', 'Admin@2026');
    await A.Auth.addUser('paidguy', 'Paid@123456', { role: 'user' });
    const g = A.Auth.grantMembership('paidguy', 6, { paidAt: Date.now(), amount: 1000 });
    check('开通成功', g.ok === true, JSON.stringify(g.error));
    check('回执 loginReady=true（有密码，可登录）', g.loginReady === true, JSON.stringify(g));
    check('回执 needPassword=false', g.needPassword === false, JSON.stringify(g));
    // 无密码账号：开通后 needPassword 必须为 true，提示管理员设密码
    const ph2 = await A.Auth.grantMembershipPlaceholder('nopw123', 6, { paidAt: Date.now(), amount: 1000 });
    check('无密码账号占位开通 ok', ph2 && ph2.ok === true, JSON.stringify(ph2 && ph2.error));
    check('无密码账号回执 needPassword=true', ph2 && ph2.needPassword === true, JSON.stringify(ph2));
    check('无密码账号回执 loginReady=false', ph2 && ph2.loginReady === false, JSON.stringify(ph2));
  }

  /* ========== 场景8：显示密码与实际哈希不一致 → 以显示密码为准重算，保证「看到什么就能用什么」 ========== */
  console.log('\n[场景8] 面板显示密码与实际哈希不一致 → 同步时以显示密码为准修正');
  {
    setRegistryAccounts({});
    const store = makeStorage();
    const A = await loadAuthForDevice(store, { withToken: true });
    await A.Auth.setup('admin', 'Admin@2026', 'Admin@2026');
    await A.Auth.addUser('mismatch', 'AAA@123456', { role: 'user' });
    A.Auth.grantMembership('mismatch', 6, { paidAt: Date.now(), amount: 1000 });
    // 人为制造「哈希=AAA@123456，但 pwSeal 显示 BBB@123456」的历史脏数据
    const raw = JSON.parse(store.getItem('snt-auth-users-v1'));
    const arr = Array.isArray(raw) ? raw : (raw && raw.users) || [];
    const target = arr.find(x => x && x.username === 'mismatch');
    check('找到本机 mismatch 账号', !!target);
    target.pwSeal = A.Auth.sealPassword('BBB@123456');
    store.setItem('snt-auth-users-v1', JSON.stringify(raw));

    const sr = await A.Auth.saveUsersToRegistry(['mismatch']);
    check('保存成功', sr.ok === true && (sr.saved || []).includes('mismatch'), JSON.stringify(sr));
    const C = await loadAuthForDevice(makeStorage(), {});
    const lgB = await C.Auth.login('mismatch', 'BBB@123456');
    check('用户用「面板显示的那个密码」登录成功（哈希已按显示密码修正）', lgB.ok === true, JSON.stringify(lgB.error || 'ok'));
  }

  /* ========== 场景7：静态断言（接线与文案） ========== */
  console.log('\n[场景7] 静态断言：接线 / 作用域 / 文案');
  {
    const auth = fs.readFileSync(path.join(ROOT, 'js/auth.js'), 'utf8');
    const sync = fs.readFileSync(path.join(ROOT, 'js/auth-sync.js'), 'utf8');
    const app = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');

    check('auth-sync.js 云端无 hash 时用 pwSeal 兜底比对', /unsealPassword\(acc\.pwSeal\)/.test(sync));
    check('auth-sync.js 会员有效但无凭证返回 nocred', /status: 'nocred'/.test(sync));
    check('auth-sync.js 密码不符回执带 mismatch/until', /return \{ mismatch: true, until:/.test(sync));
    check('auth.js 本机也不通时补充会员有效性说明', /会员已开通，有效期至/.test(auth));
    check('auth.js registryKeyFields 含 hasCred', /hasCred: \(typeof rec\.hasCred === 'boolean'\)/.test(auth));
    check('publicUser 暴露 hasCred 布尔（不暴露密码）', /hasCred: !!\(u\.hash \|\| u\.pwSeal\)/.test(auth));
    check('saveUsersToRegistry 放宽到 pwSeal / placeholder', /\(u\.hash \|\| u\.pwSeal \|\| u\.placeholder\)/.test(auth));
    check('_syncUserToRegistry 放行 pwSeal 账号', /var usable = !!u && !!\(u\.pwSeal/.test(auth));
    check('grantMembershipPlaceholder 保留已有 hash/pwSeal', /var keepHash = \(exist && exist\.hash/.test(auth));
    check('grantMembership 回执 loginReady', /loginReady: loginReady, needPassword: !loginReady/.test(auth));
    check('recoverFromRegistry 不再引用跨作用域 now（改用 nowTs）', /var nowTs = Date\.now\(\);/.test(auth) && /lu\.updatedAt = nowTs/.test(auth));
    check('app.js 开通回执提示「重置密码」', /没有登录密码，用户无法登录/.test(app));
    check('app.js 手动开通也回执 needPassword', /grantMemberManual[\s\S]{0,1600}needPassword/.test(app));
    check('app.js 跨设备登录清占位标记前的落地逻辑仍在', /_applyRemoteGrantAndLogin/.test(auth));
  }

  console.log('\n========== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ==========');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常：', e); process.exit(1); });
