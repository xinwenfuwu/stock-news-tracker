/* ============================================================
 * auth-sync.js — 跨设备免码登录：浏览器 ↔ GitHub 公开注册表 的桥接层
 *
 * 思路（无需 Cloudflare Worker / 任何服务端）：
 *  - 共享账号表存为仓库里的公开文件 data/accounts/registry.json，
 *    由 GitHub Pages 直接托管，任何设备「读」都免鉴权（同源 GET）。
 *  - 「写」（新增 / 审核 / 停用）只在管理员设备发生，走 GitHub Contents API，
 *    用管理员在「设置」里填的 GitHub 细粒度令牌（仅本仓库 Contents 读写）。
 *  - 普通用户在他设备上登录时，只「读」注册表、本地校验密码，即可登录，
 *    无需再粘贴准入码。
 *
 * 配置（独立 localStorage 键，不进 D.settings，避免随设置导出泄露）：
 *   snt-auth-admin-token —— GitHub 细粒度 PAT（仅管理员设备填，用于写入）
 *
 * 安全说明：registry.json 是公开文件，会包含「用户名 + PBKDF2 密码哈希(带每账号随机盐)」。
 *   哈希用 15 万次 PBKDF2-SHA256 + 随机盐，离线爆破成本很高；这与「准入码」里本来就会
 *   携带哈希是同等暴露级别。写入令牌（PAT）绝不进注册表，只存在于管理员浏览器 localStorage。
 *   若需更强隔离（不公开账号表），可改用 worker/ 下的 Cloudflare Worker 方案。
 *
 * 所有请求失败都走「本地 + 准入码」兜底，不会把用户挡在门外。
 * ============================================================ */
(function (global) {
  'use strict';

  var TOKEN_KEY = 'snt-auth-admin-token';
  var REGISTRY_PATH = 'data/accounts/registry.json';
  var REPO_OWNER = 'xinwenfuwu';
  var REPO_NAME = 'stock-news-tracker';
  var REPO_BRANCH = 'main';

  /* ---------- 静态文件基址：Cloudflare 托管时统一走代理 Worker ----------
   * GitHub Pages：同源相对路径（data/... 由 Pages 托管，免鉴权同源 GET）。
   * Cloudflare Workers / Pages：页面与 GitHub 不同源，直接 fetch github.io 会被 CORS 拦，
   *   故统一改走 snt-registry-proxy Worker（Cloudflare 边缘回源 GitHub，补 CORS 头）。
   *   注意：写操作仍走下方 gh() → api.github.com，读写同指 GitHub 仓库，
   *   不会出现「Cloudflare 读到旧快照、GitHub 才是新数据」的分裂。
   *   REGISTRY_PATH / MEMBER_*_PATH 仍保持「仓库内相对路径」不变（写接口按它拼 URL）。 */
  var REGISTRY_PROXY_BASE = 'https://snt-registry-proxy.hui-zhou.workers.dev';
  function isCfHost() {
    try {
      var h = String((typeof location !== 'undefined' && location.hostname) || '').toLowerCase();
      return /(^|\.)workers\.dev$/.test(h) || /(^|\.)pages\.dev$/.test(h);
    } catch (e) { return false; }
  }
  /** 把仓库内相对路径解析成「当前宿主可读」的 URL。 */
  function staticUrl(path) {
    var p = String(path || '').replace(/^\/+/, '');
    return isCfHost() ? (REGISTRY_PROXY_BASE + '/' + p) : p;
  }

  function getToken() {
    try { return (localStorage.getItem(TOKEN_KEY) || '').trim(); } catch (e) { return ''; }
  }
  function isAdminConfigured() { return !!getToken(); }

  /** 读取注册表：同源静态文件，免鉴权。失败返回空表，绝不抛异常。
   *  加时间戳参数绕开 GitHub Pages 的 CDN 缓存 —— 否则管理员刚开通的会员 / 刚变更的状态
   *  最长要等十几分钟才能在别的设备上看到。 */
  function readRegistry() {
    return fetch(staticUrl(REGISTRY_PATH) + '?_=' + Date.now(), { method: 'GET', cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) return { version: 1, updatedAt: null, accounts: {} };
        return r.json().catch(function () { return { version: 1, updatedAt: null, accounts: {} }; });
      })
      .then(function (j) {
        if (!j || typeof j !== 'object' || !j.accounts || typeof j.accounts !== 'object') {
          return { version: 1, updatedAt: null, accounts: {} };
        }
        return j;
      })
      .catch(function () { return { version: 1, updatedAt: null, accounts: {} }; });
  }

  /** UTF-8 安全转 base64（用于把注册表 JSON 写进 GitHub） */
  function b64utf8(str) {
    try { return btoa(unescape(encodeURIComponent(str))); }
    catch (e) {
      var bytes = new TextEncoder().encode(str);
      var bin = '';
      for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    }
  }

  function apiHeaders(token) {
    return {
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'snt-auth-registry',
      'X-GitHub-Api-Version': '2022-11-28',
      'Authorization': token ? ('Bearer ' + token) : ''
    };
  }

  function gh(path, method, token, body) {
    var url = 'https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME + path;
    var opt = { method: method, headers: apiHeaders(token), cache: 'no-store' };
    if (body) opt.body = JSON.stringify(body);
    return fetch(url, opt).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        return { ok: r.ok, status: r.status, body: j || {} };
      });
    });
  }

  /** 写入整个注册表（带 sha 冲突重试一次） */
  function writeRegistry(reg) {
    var token = getToken();
    if (!token) return Promise.resolve({ ok: false, error: '未配置 GitHub 令牌' });
    var content = b64utf8(JSON.stringify(reg, null, 2));
    function doPut(sha) {
      var body = { message: 'chore(auth): sync account registry', content: content, branch: REPO_BRANCH };
      if (sha) body.sha = sha;
      return gh('/contents/' + REGISTRY_PATH, 'PUT', token, body).then(function (res) {
        if (res.ok) return { ok: true };
        if (res.status === 409 && !sha) {
          // 并发冲突：重新拿 sha 再试一次
          return gh('/contents/' + REGISTRY_PATH + '?ref=' + REPO_BRANCH, 'GET', token).then(function (g) {
            return doPut(g.body && g.body.sha ? g.body.sha : null);
          });
        }
        var errs = res.body && res.body.errors;
        var msg = (res.body && res.body.message)
          || (errs && errs[0] && errs[0].message)
          || ('HTTP ' + res.status);
        return { ok: false, error: msg };
      });
    }
    return gh('/contents/' + REGISTRY_PATH + '?ref=' + REPO_BRANCH, 'GET', token).then(function (g) {
      return doPut(g.body && g.body.sha ? g.body.sha : null);
    }).catch(function (e) { return { ok: false, error: String((e && e.message) || e) }; });
  }

  /** 写入单个用户（upsert）。record 来自本地账号，仅挑注册表需要的字段。 */
  function writeUser(record) {
    if (!record || !record.username) return Promise.resolve({ ok: false, error: '缺少用户名' });
    var uname = String(record.username);
    return readRegistry().then(function (reg) {
      reg.version = reg.version || 1;
      reg.updatedAt = Date.now();
      reg.accounts = reg.accounts || {};
      reg.accounts[uname] = {
        hash: record.hash || '',
        role: record.role || 'user',
        status: record.status || 'pending',
        disabled: !!record.disabled,
        trialUntil: record.trialUntil || 0,
        trialDays: record.trialDays || 0,
        quotaMonths: record.quotaMonths || 0,
        disableDate: record.disableDate || '',
        registerDate: record.registerDate || '',
        payMembershipUntil: record.payMembershipUntil || 0,   // batch-A：扫码/后台开通的会员到期时间戳(ms)
        paidAt: Number(record.paidAt) || 0,                   // 20261007q：支付日期(ms)
        paidPlan: record.paidPlan || '',                      // 20261007q：支付套餐 6m / 1y / 2y
        paidAmount: Number(record.paidAmount) || 0,           // 20261007q：实付金额
        createdAt: record.createdAt || Date.now(),
        updatedAt: Date.now()
      };
      return writeRegistry(reg);
    });
  }

  /* ---------- 会员相关共享文件（个人收款码配置 / 待开通记录），复用同一套 GitHub 读写 ---------- */
  var MEMBER_CFG_PATH = 'data/membership/config.json';
  var MEMBER_CLAIMS_PATH = 'data/membership/claims.json';

  /** 读取静态 JSON 文件；bust=true 时追加时间戳参数，绕开 GitHub Pages 的 CDN 缓存。 */
  function readJsonFile(path, bust) {
    var base = staticUrl(path);
    var url = base + (bust ? ((base.indexOf('?') >= 0 ? '&' : '?') + '_=' + Date.now()) : '');
    return fetch(url, { method: 'GET', cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) return null;
        return r.json().catch(function () { return null; });
      })
      .catch(function () { return null; });
  }
  function writeJsonFile(path, obj, message) {
    var token = getToken();
    if (!token) return Promise.resolve({ ok: false, error: '未配置 GitHub 令牌' });
    var content = b64utf8(JSON.stringify(obj, null, 2));
    function doPut(sha) {
      var body = { message: message || 'chore(membership): update ' + path, content: content, branch: REPO_BRANCH };
      if (sha) body.sha = sha;
      return gh('/contents/' + path, 'PUT', token, body).then(function (res) {
        if (res.ok) return { ok: true };
        if (res.status === 409 && !sha) {
          return gh('/contents/' + path + '?ref=' + REPO_BRANCH, 'GET', token).then(function (g) {
            return doPut(g.body && g.body.sha ? g.body.sha : null);
          });
        }
        var errs = res.body && res.body.errors;
        var msg = (res.body && res.body.message) || (errs && errs[0] && errs[0].message) || ('HTTP ' + res.status);
        return { ok: false, error: msg };
      });
    }
    return gh('/contents/' + path + '?ref=' + REPO_BRANCH, 'GET', token).then(function (g) {
      return doPut(g.body && g.body.sha ? g.body.sha : null);
    }).catch(function (e) { return { ok: false, error: String((e && e.message) || e) }; });
  }

  /** 读取个人收款码配置（公开，免鉴权） */
  function readMembershipConfig() { return readJsonFile(MEMBER_CFG_PATH); }
  /** 写入个人收款码配置（管理员令牌） */
  function writeMembershipConfig(cfg) { return writeJsonFile(MEMBER_CFG_PATH, cfg || {}, 'chore(membership): update config'); }

  /* ---------- 20261012e：会员到期时间查询（登录门禁兜底用） ---------- */

  /** 会员后端基地址：优先页面注入的 __SNT_MEMBER_API__（业务层按用户设置回填），否则用加速域名 */
  function memberApiBase() {
    var b = (typeof window !== 'undefined' && window.__SNT_MEMBER_API__) ? String(window.__SNT_MEMBER_API__).trim().replace(/\/+$/, '') : '';
    if (b) return b;
    var a = (typeof window !== 'undefined' && window.__SNT_ACCEL__) ? String(window.__SNT_ACCEL__).trim().replace(/\/+$/, '') : '';
    return a || '';
  }

  /**
   * 查会员后端（Cloudflare Worker KV）里某用户的会员到期时间。
   * 商户扫码支付成功回调会写这个 KV；管理员「核对并开通」也会尽量同步到这里。
   * 任何失败都返回 { ok:false, until:0 }，绝不抛异常（门禁兜底不能把用户挡在门外）。
   */
  function queryMembershipRemote(username) {
    var base = memberApiBase();
    var uname = String(username == null ? '' : username).trim();
    if (!base || !uname) return Promise.resolve({ ok: false, until: 0 });
    return fetch(base + '/pay/membership?user=' + encodeURIComponent(uname), {
      headers: { 'Accept': 'application/json' }, cache: 'no-store'
    }).then(function (r) {
      if (!r.ok) return { ok: false, until: 0 };
      return r.json().catch(function () { return {}; });
    }).then(function (j) {
      return { ok: true, until: Number(j && j.until) || 0 };
    }).catch(function () { return { ok: false, until: 0 }; });
  }
  /** 读取待开通记录（公开，免鉴权）。始终带时间戳参数，保证管理员点「刷新」拿到的是最新申请。 */
  function readClaims() {
    return readJsonFile(MEMBER_CLAIMS_PATH, true).then(function (j) {
      if (j && Array.isArray(j.claims)) return { ok: true, claims: j.claims };
      return { ok: true, claims: [] };
    });
  }
  /** 覆盖写入待开通记录（管理员令牌 / Worker 持 GH_PAT 调用） */
  function writeClaims(claims) { return writeJsonFile(MEMBER_CLAIMS_PATH, { claims: Array.isArray(claims) ? claims : [] }, 'chore(membership): update claims'); }

  /** 登录：读注册表 → 校验密码 → 返回授权或状态。找不到用户返回 {} 让 auth.js 回落本地。 */
  function loginRemote(username, password) {
    var uname = String(username == null ? '' : username).trim();
    if (!uname || !password) return Promise.resolve({});
    return readRegistry().then(function (reg) {
      var acc = reg.accounts && reg.accounts[uname];
      // 20261016k：注册表里没有这个账号时返回 { notFound: true }（仍回落本地登录），
      // 让 auth.js 在本地登录成功后补写一次云端——注册时离线没同步上的账号，
      // 下次登录即进入云端注册表，管理员的「审核通过区」随之可见。
      if (!acc || !acc.hash) return { notFound: true };
      var verify = global.Auth
        ? global.Auth.verifyPassword(password, acc.hash)
        : Promise.resolve(false);
      return Promise.resolve(verify).then(function (ok) {
        if (!ok) {
          // 20261016d：注册表里的哈希与所输密码不符（典型：用户在别的设备改过密码但没同步上去 /
          // 管理员手动添加时设了另一套密码）→ 不再硬报「用户名或密码不正确」把用户锁死，
          // 改为返回 {} 让 auth.js 回落本机校验：本机账号表里有正确哈希就能正常登录。
          // 本机也没有该账号时，_localLogin 会给出同样的错误提示，安全性不变。
          return {};
        }
        var st = acc.status || 'pending';
        var disabled = !!acc.disabled;
        if (st === 'pending') return { ok: false, status: 'pending', error: '该账号正在等待管理员审核，通过后即可直接登录' };
        if (st === 'rejected') return { ok: false, status: 'rejected', error: '该注册申请未通过审核，请联系管理员' };
        if (disabled) return { ok: false, status: 'disabled', error: '该账号已被停用，请联系管理员' };
        return {
          ok: true,
          grant: {
            role: acc.role || 'user',           // 20261012e：跨设备首次落地时角色以注册表为准
            trialDays: acc.trialDays || 0,
            trialUntil: acc.trialUntil || 0,
            quotaMonths: acc.quotaMonths || 0,
            disableDate: acc.disableDate || '',
            registerDate: acc.registerDate || '',
            payMembershipUntil: acc.payMembershipUntil || 0,
            paidAt: Number(acc.paidAt) || 0,
            paidPlan: acc.paidPlan || '',
            paidAmount: Number(acc.paidAmount) || 0
          }
        };
      });
    }).catch(function () { return {}; });
  }

  function statusRemote(username) {
    return readRegistry().then(function (reg) {
      var acc = reg.accounts && reg.accounts[String(username)];
      return { ok: true, status: acc ? (acc.status || 'pending') : 'unknown', disabled: acc ? !!acc.disabled : false };
    }).catch(function () { return { ok: false }; });
  }

  function fetchPending() {
    return readRegistry().then(function (reg) {
      var list = [];
      var a = reg.accounts || {};
      for (var k in a) if (a[k].status === 'pending') list.push({ username: k, createdAt: a[k].createdAt || 0 });
      return { ok: true, list: list };
    }).catch(function () { return { ok: true, list: [] }; });
  }

  /* ---------- 以下为兼容 / 手动接口 ---------- */
  function approveRemote(username, grant, hash) {
    return writeUser({
      username: username, hash: hash || '', role: 'user', status: 'active',
      trialUntil: (grant && grant.trialUntil) || 0,
      quotaMonths: (grant && grant.quotaMonths) || 0,
      disableDate: (grant && grant.disableDate) || '',
      registerDate: (grant && grant.registerDate) || ''
    });
  }
  function rejectRemote(username, hash) {
    return writeUser({ username: username, hash: hash || '', role: 'user', status: 'rejected' });
  }
  function disableRemote(username, hash, disabled) {
    return writeUser({ username: username, hash: hash || '', role: 'user', status: 'active', disabled: !!disabled });
  }
  /**
   * 20261016d：从注册表删除某个账号（管理员删除用户时调用）。
   * 没有令牌时返回 skip（调用方据此决定是否提示）；删除失败绝不抛异常。
   */
  function deleteUser(username) {
    var uname = String(username == null ? '' : username).trim();
    if (!uname) return Promise.resolve({ ok: false, error: '缺少用户名' });
    if (!isAdminConfigured()) return Promise.resolve({ ok: false, skip: true, error: '未配置 GitHub 令牌（设置 → 云端同步）' });
    return readRegistry().then(function (reg) {
      if (!reg.accounts || !reg.accounts[uname]) return { ok: true, skipped: true }; // 云端本来就没有，视为成功
      delete reg.accounts[uname];
      reg.updatedAt = Date.now();
      return writeRegistry(reg).then(function (w) {
        return w.ok ? { ok: true } : { ok: false, error: w.error || '注册表删除失败' };
      });
    }).catch(function (e) { return { ok: false, error: String((e && e.message) || e) }; });
  }
  /** 注册写注册表需要令牌；没有令牌（普通用户设备）静默跳过，回落本地 + 准入码流程 */
  function registerRemote(username, password) {
    if (!isAdminConfigured()) return Promise.resolve({ ok: false, local: true });
    var mk = global.Auth ? global.Auth.makePasswordHash(password) : Promise.resolve(null);
    return Promise.resolve(mk).then(function (hash) {
      if (!hash) return { ok: false, local: true };
      return writeUser({ username: username, hash: hash, role: 'user', status: 'pending' });
    });
  }

  /**
   * 20261016k：无令牌设备（普通用户）注册时，经 pay Worker 把账号代写进云端注册表。
   * 与 registerRemote（需管理员令牌直写）二选一：有令牌走 GitHub 直写，无令牌走这里
   * （Worker 持 GH_PAT，落库后管理员打开用户管理即经 recoverFromRegistry 看到该账号）。
   * 任何失败都返回 { ok:false }，调用方离线兜底，不阻塞注册流程。
   */
  function registerRemoteViaWorker(acct) {
    var base = memberApiBase();
    var uname = String(acct && acct.username || '').trim();
    if (!base || !uname || !acct || typeof acct.hash !== 'string' || acct.hash.indexOf('pbkdf2$') !== 0) {
      return Promise.resolve({ ok: false, error: '参数不完整' });
    }
    var payload = {
      username: uname,
      hash: acct.hash,
      status: 'active',
      trialUntil: Number(acct.trialUntil) || 0,
      trialDays: Number(acct.trialDays) || 0,
      registerDate: typeof acct.registerDate === 'string' ? acct.registerDate : '',
      createdAt: Number(acct.createdAt) || 0,
      // 20261016l：会员字段透传——管理员「创建并开通」后经本端点把
      // 「账号 + 会员状态」一次性落库（无令牌设备也能上云）。
      payMembershipUntil: Number(acct.payMembershipUntil) || 0,
      paidAt: Number(acct.paidAt) || 0,
      paidPlan: typeof acct.paidPlan === 'string' ? acct.paidPlan : '',
      paidAmount: Number(acct.paidAmount) || 0,
      quotaMonths: Number(acct.quotaMonths) || 0
    };
    return fetch(base + '/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        return { ok: r.ok && !!(j && j.ok), status: r.status, error: (j && j.error) ? String(j.error) : '' };
      });
    }).catch(function (e) { return { ok: false, error: String((e && e.message) || e) }; });
  }

  global.Auth = global.Auth || {};
  // 20261012e：登录门禁的云端会员兜底查询（auth.js 的 accessDenyWithRemote 会调用）。
  // 单独挂到 Auth 上（不进 Sync），让 auth.js 不依赖同步模块的加载顺序。
  global.Auth.remoteMembershipQuery = queryMembershipRemote;
  global.Auth.Sync = {
    TOKEN_KEY: TOKEN_KEY,
    adminToken: getToken,
    isConfigured: function () { return true; }, // 同源读注册表始终可用；写需令牌
    isAdminConfigured: isAdminConfigured,
    readRegistry: readRegistry,
    writeRegistry: writeRegistry,
    writeUser: writeUser,
    loginRemote: loginRemote,
    statusRemote: statusRemote,
    fetchPending: fetchPending,
    approveRemote: approveRemote,
    rejectRemote: rejectRemote,
    disableRemote: disableRemote,
    deleteUser: deleteUser,
    registerRemote: registerRemote,
    registerRemoteViaWorker: registerRemoteViaWorker,
    // batch-A：会员个人收款码配置 + 待开通记录（公开读、令牌写）
    MEMBER_CFG_PATH: MEMBER_CFG_PATH,
    MEMBER_CLAIMS_PATH: MEMBER_CLAIMS_PATH,
    readMembershipConfig: readMembershipConfig,
    writeMembershipConfig: writeMembershipConfig,
    readClaims: readClaims,
    writeClaims: writeClaims,
    // 20261012e：会员到期时间查询 + 后端基地址（业务层复用同一基地址）
    memberApiBase: memberApiBase,
    queryMembershipRemote: queryMembershipRemote
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = global.Auth.Sync;
})(typeof window !== 'undefined' ? window : globalThis);
