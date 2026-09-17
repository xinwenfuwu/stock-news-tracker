/* ============================================================
 * auth-sync.js — 跨设备免码登录：浏览器 ↔ 鉴权 Worker 的桥接层
 *
 * 只做一件事：把「注册 / 登录 / 拉待审 / 通过」这些动作发到 Cloudflare Worker，
 * 让管理员「通过」能自动同步到用户设备，用户无需再粘贴准入码。
 *
 * 配置（独立 localStorage 键，不进 D.settings，避免随「设置」导出泄露管理员密钥）：
 *   snt-auth-worker-url  —— 鉴权后端地址（管理员与普通用户都填）
 *   snt-auth-admin-token —— 管理员密钥（仅管理员设备填，用于调用通过/驳回）
 *
 * 所有请求失败时（网络抖动 / Worker 没部署）都走「本地 + 准入码」兜底，
 * 不会把用户挡在门外。
 * ============================================================ */
(function (global) {
  'use strict';

  var WORKER_KEY = 'snt-auth-worker-url';
  var TOKEN_KEY = 'snt-auth-admin-token';

  function getUrl() {
    try { return (localStorage.getItem(WORKER_KEY) || '').trim().replace(/\/+$/, ''); } catch (e) { return ''; }
  }
  function getToken() {
    try { return (localStorage.getItem(TOKEN_KEY) || '').trim(); } catch (e) { return ''; }
  }
  function isConfigured() { return !!getUrl(); }

  function jpost(path, body, token) {
    var url = getUrl() + path;
    var opt = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      cache: 'no-store'
    };
    if (token) opt.headers['Authorization'] = 'Bearer ' + token;
    return fetch(url, opt)
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) { return j || {}; });
  }
  function jget(path, token) {
    var url = getUrl() + path;
    var opt = { method: 'GET', headers: {}, cache: 'no-store' };
    if (token) opt.headers['Authorization'] = 'Bearer ' + token;
    return fetch(url, opt)
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) { return j || {}; });
  }

  global.Auth.Sync = {
    WORKER_KEY: WORKER_KEY,
    TOKEN_KEY: TOKEN_KEY,
    url: getUrl,
    adminToken: getToken,
    isConfigured: isConfigured,

    /** 注册：把账号写进 Worker（pending）。失败不影响本地注册（用户仍可手动发申请码） */
    registerRemote: function (username, password) {
      return jpost('/register', { username: username, password: password });
    },
    /** 登录：服务端校验密码 + 状态。返回 {ok, grant} 或 {status:'pending'|'disabled'} 或 {error} */
    loginRemote: function (username, password) {
      return jpost('/login', { username: username, password: password });
    },
    /** 查询某账号在 Worker 上的状态（公开，不含密码哈希） */
    statusRemote: function (username) {
      return jget('/status?u=' + encodeURIComponent(username));
    },
    /** 管理员拉待审列表（需管理员密钥） */
    fetchPending: function (token) {
      return jget('/pending', token);
    },
    /** 管理员通过（需管理员密钥） */
    approveRemote: function (username, grant, token) {
      return jpost('/approve', {
        username: username,
        trialDays: (grant && grant.trialDays) || 0,
        quotaMonths: (grant && grant.quotaMonths) || 0,
        disableDate: (grant && grant.disableDate) || '',
        registerDate: (grant && grant.registerDate) || ''
      }, token);
    },
    /** 管理员驳回（需管理员密钥） */
    rejectRemote: function (username, token) {
      return jpost('/reject', { username: username }, token);
    },
    /** 管理员停用（需管理员密钥） */
    disableRemote: function (username, token) {
      return jpost('/disable', { username: username }, token);
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = global.Auth.Sync;
})(typeof window !== 'undefined' ? window : globalThis);
