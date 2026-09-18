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

  function getToken() {
    try { return (localStorage.getItem(TOKEN_KEY) || '').trim(); } catch (e) { return ''; }
  }
  function isAdminConfigured() { return !!getToken(); }

  /** 读取注册表：同源静态文件，免鉴权。失败返回空表，绝不抛异常。 */
  function readRegistry() {
    return fetch(REGISTRY_PATH, { method: 'GET', cache: 'no-store' })
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
        quotaMonths: record.quotaMonths || 0,
        disableDate: record.disableDate || '',
        registerDate: record.registerDate || '',
        createdAt: record.createdAt || Date.now(),
        updatedAt: Date.now()
      };
      return writeRegistry(reg);
    });
  }

  /** 登录：读注册表 → 校验密码 → 返回授权或状态。找不到用户返回 {} 让 auth.js 回落本地。 */
  function loginRemote(username, password) {
    var uname = String(username == null ? '' : username).trim();
    if (!uname || !password) return Promise.resolve({});
    return readRegistry().then(function (reg) {
      var acc = reg.accounts && reg.accounts[uname];
      if (!acc || !acc.hash) return {}; // 注册表里没有 → 回落本地
      var verify = global.Auth
        ? global.Auth.verifyPassword(password, acc.hash)
        : Promise.resolve(false);
      return Promise.resolve(verify).then(function (ok) {
        if (!ok) return { ok: false, error: '用户名或密码不正确' };
        var st = acc.status || 'pending';
        var disabled = !!acc.disabled;
        if (st === 'pending') return { ok: false, status: 'pending', error: '该账号正在等待管理员审核，通过后即可直接登录' };
        if (st === 'rejected') return { ok: false, status: 'rejected', error: '该注册申请未通过审核，请联系管理员' };
        if (disabled) return { ok: false, status: 'disabled', error: '该账号已被停用，请联系管理员' };
        return {
          ok: true,
          grant: {
            trialDays: acc.trialDays || 0,
            trialUntil: acc.trialUntil || 0,
            quotaMonths: acc.quotaMonths || 0,
            disableDate: acc.disableDate || '',
            registerDate: acc.registerDate || ''
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
  /** 注册写注册表需要令牌；没有令牌（普通用户设备）静默跳过，回落本地 + 准入码流程 */
  function registerRemote(username, password) {
    if (!isAdminConfigured()) return Promise.resolve({ ok: false, local: true });
    var mk = global.Auth ? global.Auth.makePasswordHash(password) : Promise.resolve(null);
    return Promise.resolve(mk).then(function (hash) {
      if (!hash) return { ok: false, local: true };
      return writeUser({ username: username, hash: hash, role: 'user', status: 'pending' });
    });
  }

  global.Auth = global.Auth || {};
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
    registerRemote: registerRemote
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = global.Auth.Sync;
})(typeof window !== 'undefined' ? window : globalThis);
