/* ============================================================
 * test-register-then-login.mjs — 「点一次注册申请」全链路闭环验证
 *
 * 用户诉求（2026-10-20）：点一次「注册申请」就要同时完成——
 *   ① 管理员「用户管理」里立刻出现该账号（云端 registry.json 已写入）；
 *   ② 注册者返回登录页用**刚输入的密码**立刻能登录；
 *   ③ 同账号的旧密码被本次注册覆盖（管理员面板显示的也是新密码）。
 *
 * 用户实测故障（截图）：注册后返回登录报
 *   「用户名或密码不正确（该账号会员已开通，有效期至 2028-10-07；会员有效但密码不符…）」
 * 根因：注册被「该用户名已被使用」拦下 / 云端对「异哈希 + 已付费」返回 409 →
 *       密码从未被更新，云端与本机都还是旧密码。
 *
 * 场景1：本机 + 云端都有同号（旧密码 + 会员）→ 注册新密码 → 本机可登录 + 云端哈希匹配新密码
 *        +「换设备（空存储）用新密码也能登录」。
 * 场景2：云端有同号（旧密码 + 会员）、本机为空、普通用户设备（无令牌，走 Worker selfSet）。
 * 场景3：云端是同号空占位（hash 空、有会员）→ 注册认领 → 云端写入真实哈希。
 * 场景4：管理员账号 → 注册接口拒绝（不能用注册改管理员密码）。
 * 场景5：被停用账号 → 注册接口拒绝（不能靠再注册自行解封）。
 * 场景6：静态接线——register 不再抛「用户名已被使用」、Worker 侧有 selfSet 分支、
 *        auth-sync 载荷带 selfSet。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

/* ---------- 内存 GitHub 仓库 + pay Worker 模拟 ---------- */
const ghFiles = new Map();
function b64utf8(s) { return Buffer.from(s, 'utf8').toString('base64'); }
function regOf() { return JSON.parse(ghFiles.get('data/accounts/registry.json').content); }
function setRegistryAccounts(accounts) {
  ghFiles.set('data/accounts/registry.json', {
    content: JSON.stringify({ version: 1, updatedAt: Date.now(), accounts }, null, 2),
    sha: 'sha-' + Math.random().toString(36).slice(2, 8),
  });
}
function resetWorld(accounts) { ghFiles.clear(); setRegistryAccounts(accounts || {}); }

const enc = new TextEncoder();
const b64 = b => Buffer.from(b).toString('base64');
async function hashOf(pw) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const k = await webcrypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await webcrypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' }, k, 256);
  return ['pbkdf2', 150000, b64(salt), b64(new Uint8Array(bits))].join('$');
}
/** 用参数表里存的 pbkdf2 哈希校验明文（与 app 同算法） */
async function verifyAgainst(hash, pw) {
  const p = String(hash || '').split('$');
  if (p.length !== 4 || p[0] !== 'pbkdf2') return false;
  const k = await webcrypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await webcrypto.subtle.deriveBits({ name: 'PBKDF2', salt: Buffer.from(p[2], 'base64'), iterations: parseInt(p[1], 10), hash: 'SHA-256' }, k, 256);
  return b64(new Uint8Array(bits)) === p[3];
}

/* Worker /auth/register 真实口径（含 20261020c selfSet 分支） */
const workerCalls = [];
function authRegisterWorker(body) {
  const username = String(body.username || '').trim();
  const hash = typeof body.hash === 'string' ? body.hash.trim() : '';
  const now = Date.now();
  if (!username) return { status: 400, body: { error: '缺少用户名' } };
  if (!/^[A-Za-z0-9_\u4e00-\u9fa5.-]{2,20}$/.test(username)) return { status: 400, body: { error: '用户名格式不正确' } };
  const isPlaceholder = body.placeholder === true && !hash;
  if (!isPlaceholder && (hash.indexOf('pbkdf2$') !== 0 || hash.split('$').length !== 4)) return { status: 400, body: { error: '密码哈希格式不正确' } };
  const reg = regOf(); reg.accounts = reg.accounts || {};
  const exist = reg.accounts[username];
  const claiming = !!(exist && !exist.hash);
  if (exist && body.selfSet === true && !claiming) {
    if (exist.role === 'admin') return { status: 409, body: { error: '管理员账号不能通过注册接口设置密码' } };
    if (exist.disabled) return { status: 403, body: { error: '该账号已被管理员停用' } };
    exist.hash = hash;
    if (body.pwSeal) exist.pwSeal = body.pwSeal;
    exist.placeholder = false; exist.status = 'active'; exist.role = 'user';
    exist.payMembershipUntil = Math.max(Number(exist.payMembershipUntil) || 0, Number(body.payMembershipUntil) || 0);
    exist.quotaMonths = Math.max(Number(exist.quotaMonths) || 0, Number(body.quotaMonths) || 0);
    if (Number(body.trialUntil) > (Number(exist.trialUntil) || 0)) exist.trialUntil = Number(body.trialUntil);
    exist.updatedAt = now;
    setRegistryAccounts(reg.accounts);
    return { status: 200, body: { ok: true, updated: true, passwordSet: true } };
  }
  if (exist && !claiming) {
    const sameHash = exist.hash === hash;
    const paid = (Number(exist.payMembershipUntil) || 0) > now || (Number(exist.quotaMonths) || 0) > 0;
    if (!sameHash && (exist.role === 'admin' || paid || (exist.status || 'pending') === 'active')) {
      return { status: 409, body: { ok: false, error: '该用户名已被使用，请更换一个' } };
    }
  }
  reg.accounts[username] = {
    hash, pwSeal: body.pwSeal || '', role: 'user', status: 'active', disabled: false,
    trialUntil: Number(body.trialUntil) || 0, trialDays: Number(body.trialDays) || 0,
    // claiming（认领空占位凭证）必须继承已开通的会籍，不能洗成 0（与真实 Worker 同口径）
    payMembershipUntil: Math.max(Number(body.payMembershipUntil) || 0, claiming ? (Number(exist.payMembershipUntil) || 0) : 0),
    quotaMonths: Math.max(Number(body.quotaMonths) || 0, claiming ? (Number(exist.quotaMonths) || 0) : 0),
    placeholder: !!isPlaceholder,
    createdAt: Number(body.createdAt) || (exist && Number(exist.createdAt)) || now, updatedAt: now,
  };
  setRegistryAccounts(reg.accounts);
  return { status: 200, body: { ok: true, created: true } };
}

function makeStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); }, clear: () => m.clear() };
}
async function loadDevice(storage, { withToken = false, withWorker = false } = {}) {
  const sandbox = {
    localStorage: storage, sessionStorage: makeStorage(),
    location: { hostname: 'xinwenfuwu.github.io', href: 'https://xinwenfuwu.github.io/stock-news-tracker/index.html' },
    navigator: { userAgent: 'ReproNode' },
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
        if (m === 'GET') {
          const mm = /\/contents\/(.+?)(\?|$)/.exec(u); const p = decodeURIComponent(mm[1]);
          const f = ghFiles.get(p);
          if (!f) return { ok: false, status: 404, json: async () => ({}) };
          return { ok: true, status: 200, json: async () => ({ sha: f.sha, content: b64utf8(f.content), encoding: 'base64' }) };
        }
        if (m === 'PUT') {
          const mm = /\/contents\/(.+?)(\?|$)/.exec(u); const p = decodeURIComponent(mm[1]);
          const body = JSON.parse(opt.body);
          ghFiles.set(p, { content: Buffer.from(body.content, 'base64').toString('utf8'), sha: 'sha-' + Math.random().toString(36).slice(2, 10) });
          return { ok: true, status: 200, json: async () => ({ content: { sha: 'x' } }) };
        }
      }
      if (/\/auth\/register$/.test(u) && withWorker) {
        const body = JSON.parse(opt.body || '{}'); workerCalls.push(body);
        const r = authRegisterWorker(body);
        return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    },
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    crypto: webcrypto, TextEncoder, TextDecoder, console, setTimeout, clearTimeout,
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
  if (withWorker) sandbox.__SNT_ACCEL__ = 'https://sichina.dpdns.org';
  const ctx = vm.createContext(sandbox);
  for (const f of ['js/auth.js', 'js/auth-sync.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  if (withToken) storage.setItem('snt-auth-admin-token', 'ghp_mocktoken');
  return { sandbox, Auth: sandbox.Auth, storage };
}
const tick = () => new Promise(r => setTimeout(r, 60));

const NEW_PW = 'NewPass@2026';
const OLD_PW = 'OldPass@2026';
const UNTIL_2028 = Date.parse('2028-10-07T00:00:00+08:00');

async function main() {
  console.log('\n[场景1] 本机 + 云端都有同号（旧密码 + 会员）→ 注册新密码');
  {
    resetWorld({});
    const oldHash = await hashOf(OLD_PW);
    setRegistryAccounts({
      huyun1: { hash: oldHash, pwSeal: '', role: 'user', status: 'active', disabled: false, placeholder: false, payMembershipUntil: UNTIL_2028, createdAt: 1, updatedAt: 1 },
    });
    const store = makeStorage();
    store.setItem('snt-auth-users-v1', JSON.stringify([{
      username: 'huyun1', role: 'user', hash: oldHash, pwSeal: '', disabled: false, status: 'active',
      payMembershipUntil: UNTIL_2028, createdAt: 1, updatedAt: 1, logins: [],
    }]));
    const D = await loadDevice(store, { withToken: true });
    const reg = await D.Auth.register('huyun1', NEW_PW);
    await tick();
    check('注册成功（不再报「用户名已被使用」）', reg.ok === true, JSON.stringify(reg.error));
    check('返回 alreadyRegistered + passwordUpdated', reg.alreadyRegistered === true && reg.passwordUpdated === true, JSON.stringify({ a: reg.alreadyRegistered, p: reg.passwordUpdated }));
    check('注册后本机记录已是新密码', await verifyAgainst((JSON.parse(store.getItem('snt-auth-users-v1'))[0] || {}).hash, NEW_PW) === true);
    check('注册时已同步云端成功', !!(reg.cloudSync && reg.cloudSync.ok), JSON.stringify(reg.cloudSync));
    const cloud = regOf().accounts.huyun1;
    check('云端哈希 = 本次新密码（换设备可登）', await verifyAgainst(cloud.hash, NEW_PW) === true);
    check('云端保留会员有效期', Number(cloud.payMembershipUntil) === UNTIL_2028, String(cloud.payMembershipUntil));
    check('云端不再显示旧密码', await verifyAgainst(cloud.hash, OLD_PW) === false);
    const lg = await D.Auth.login('huyun1', NEW_PW);
    check('返回登录：本机用新密码登录成功', lg.ok === true, JSON.stringify(lg.error));
    // 换设备：空存储 + 无令牌（走云端 loginRemote）
    const other = await loadDevice(makeStorage(), { withWorker: true });
    const lg2 = await other.Auth.login('huyun1', NEW_PW);
    check('换设备（空存储）用新密码登录成功', lg2.ok === true, JSON.stringify(lg2.error));
  }

  console.log('\n[场景2] 云端有同号（旧密码 + 会员）、本机为空、普通用户设备（Worker selfSet）');
  {
    resetWorld({});
    const oldHash = await hashOf(OLD_PW);
    setRegistryAccounts({
      huyun2: { hash: oldHash, role: 'user', status: 'active', disabled: false, placeholder: false, payMembershipUntil: UNTIL_2028, createdAt: 1, updatedAt: 1 },
    });
    workerCalls.length = 0;
    const store = makeStorage();
    const D = await loadDevice(store, { withWorker: true });
    const reg = await D.Auth.register('huyun2', NEW_PW);
    await tick();
    check('注册成功', reg.ok === true, JSON.stringify(reg.error));
    check('Worker 写入成功（selfSet 覆盖旧哈希）', !!(reg.cloudSync && reg.cloudSync.ok), JSON.stringify(reg.cloudSync));
    check('Worker 载荷带 selfSet=true', workerCalls.length > 0 && workerCalls[0].selfSet === true, JSON.stringify(workerCalls.map(c => c.selfSet)));
    check('云端哈希 = 新密码', await verifyAgainst(regOf().accounts.huyun2.hash, NEW_PW) === true);
    const lg = await D.Auth.login('huyun2', NEW_PW);
    check('返回登录成功', lg.ok === true, JSON.stringify(lg.error));
  }

  console.log('\n[场景3] 云端是同号空占位（无哈希 + 会员）→ 注册认领');
  {
    resetWorld({});
    setRegistryAccounts({
      huyun3: { hash: '', role: 'user', status: 'active', disabled: false, placeholder: true, payMembershipUntil: UNTIL_2028, createdAt: 1, updatedAt: 1 },
    });
    const D = await loadDevice(makeStorage(), { withWorker: true });
    const reg = await D.Auth.register('huyun3', NEW_PW);
    await tick();
    check('注册成功（认领占位凭证）', reg.ok === true, JSON.stringify(reg.error));
    const cloud = regOf().accounts.huyun3;
    check('云端写入真实哈希', await verifyAgainst(cloud.hash, NEW_PW) === true);
    check('云端 placeholder=false', cloud.placeholder === false, String(cloud.placeholder));
    check('云端保留会员', Number(cloud.payMembershipUntil) === UNTIL_2028);
    const lg = await D.Auth.login('huyun3', NEW_PW);
    check('返回登录成功', lg.ok === true, JSON.stringify(lg.error));
  }

  console.log('\n[场景4] 管理员账号不能被注册接口改密码');
  {
    resetWorld({});
    const adminHash = await hashOf('Admin@2026');
    setRegistryAccounts({ boss: { hash: adminHash, role: 'admin', status: 'active', placeholder: false } });
    const store = makeStorage();
    store.setItem('snt-auth-users-v1', JSON.stringify([{ username: 'boss', role: 'admin', hash: adminHash, status: 'active', logins: [] }]));
    const D = await loadDevice(store, { withToken: true });
    const reg = await D.Auth.register('boss', 'Hacked@2026');
    check('注册被拒', reg.ok === false, JSON.stringify(reg));
    check('提示管理员账号不可用注册改密码', /管理员账号/.test(reg.error || ''), reg.error);
    check('管理员密码未被改动', await verifyAgainst(regOf().accounts.boss.hash, 'Admin@2026') === true);
  }

  console.log('\n[场景5] 被停用账号不能靠再注册自行解封');
  {
    resetWorld({});
    const h = await hashOf(OLD_PW);
    setRegistryAccounts({ banned: { hash: h, role: 'user', status: 'active', disabled: true, payMembershipUntil: UNTIL_2028 } });
    const store = makeStorage();
    store.setItem('snt-auth-users-v1', JSON.stringify([{ username: 'banned', role: 'user', hash: h, status: 'active', disabled: true, logins: [] }]));
    const D = await loadDevice(store, { withToken: true });
    const reg = await D.Auth.register('banned', NEW_PW);
    check('注册被拒', reg.ok === false, JSON.stringify(reg));
    check('提示账号已停用', /停用/.test(reg.error || ''), reg.error);
  }

  console.log('\n[场景6] 静态接线');
  {
    const auth = fs.readFileSync(path.join(ROOT, 'js/auth.js'), 'utf8');
    const sync = fs.readFileSync(path.join(ROOT, 'js/auth-sync.js'), 'utf8');
    const worker = fs.readFileSync(path.join(ROOT, 'cloudflare-worker-prod/worker.js'), 'utf8');
    const boot = fs.readFileSync(path.join(ROOT, 'js/auth-boot.js'), 'utf8');
    check('register 已不再抛「该用户名已被使用」', auth.indexOf("'该用户名已被使用，请换一个'") === -1);
    check('register 以本次密码重建凭证（pwSeal 赋值）', /u\.pwSeal = sealPassword\(v\.password\)/.test(auth));
    check('_syncAccountToCloud 带 selfSet 调 Worker', /registerRemoteViaWorker\(u, \{ selfSet: true \}\)/.test(auth));
    check('auth-sync 载荷含 selfSet', /selfSet: !!\(opts && opts\.selfSet\)/.test(sync));
    check('Worker 有 selfSet 分支', /body\.selfSet === true/.test(worker) && /self-set password/.test(worker));
    check('Worker 禁止管理员经 selfSet 改密', /exist\.role === 'admin'[\s\S]{0,160}管理员账号不能通过注册接口设置密码/.test(worker));
    check('注册页提示已说明密码已更新', boot.indexOf('已把登录密码更新为你本次输入的密码') !== -1);
  }

  console.log('\n===== 结果：' + pass + ' PASS / ' + fail + ' FAIL =====');
  if (fail) process.exitCode = 1;
}

main().catch(e => { console.error('ERR', e); process.exitCode = 1; });
