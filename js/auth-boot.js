/* ============================================================
 * auth-boot.js — 登录关卡与启动引导（浏览器专用）
 *
 * 职责：
 *   1) 启动时先判登录态：有效 → 动态注入业务脚本并放行；无效 → 停在登录界面
 *   2) 未登录时业务脚本（store / stock-api / app…）根本不会被加载，
 *      数据不会进入内存，比「只用一个遮罩挡住 UI」更干净
 *   3) 首次使用引导创建管理员账号
 *
 * 之所以「放行后才加载」，是因为纯静态站点没有服务端可以做重定向，
 * 用运行时按需注入脚本是最接近「未授权就拿不到」的做法。
 * ============================================================ */
(function (global) {
  'use strict';

  // 与 index.html 中静态资源版本号保持一致，避免升级后命中旧缓存
  var ASSET_V = '20260916g';

  // 业务脚本装载顺序（Vue 已在 <head> 静态加载，不在此列）
  var APP_SCRIPTS = [
    'js/store.js',
    'js/cloud-sync.js',
    'js/stock-api.js',
    'js/hot-topics.js',
    'js/app.js'
  ];

  var LOAD_TIMEOUT = 25000;

  function $(sel) { return document.querySelector(sel); }

  var elGate, elSub, elMsg, elLoading, elLoadingText, elSetupForm, elLoginForm, elRetry;
  var busy = false;

  /* ---------------- 界面状态 ---------------- */

  function showMsg(text, type) {
    if (!elMsg) return;
    if (!text) { elMsg.hidden = true; elMsg.textContent = ''; elMsg.className = 'auth-msg'; return; }
    elMsg.hidden = false;
    elMsg.textContent = text;
    elMsg.className = 'auth-msg auth-msg-' + (type || 'info');
  }

  function setBusy(text) {
    busy = !!text;
    if (elLoading) {
      elLoading.hidden = !busy;
      if (elLoadingText) elLoadingText.textContent = text || '';
    }
    [elSetupForm, elLoginForm].forEach(function (f) {
      if (!f) return;
      Array.prototype.forEach.call(f.querySelectorAll('input, button'), function (el) { el.disabled = busy; });
    });
  }

  function showForm(which) {
    if (elSetupForm) elSetupForm.hidden = which !== 'setup';
    if (elLoginForm) elLoginForm.hidden = which !== 'login';
    if (elSub) {
      elSub.textContent = which === 'setup'
        ? '首次使用，请先创建管理员账号'
        : '请登录后使用';
    }
    var first = which === 'setup' ? $('#setup-username') : $('#login-username');
    if (first) setTimeout(function () { first.focus(); }, 60);
  }

  function showRetry(message) {
    if (!elRetry) return;
    elRetry.textContent = message ? (message + '　点击重试') : '点击重试';
    elRetry.hidden = false;
  }

  /* ---------------- 动态装载业务脚本 ---------------- */

  function loadScripts(list) {
    var i = 0;
    return new Promise(function (resolve, reject) {
      (function next() {
        if (i >= list.length) { resolve(); return; }
        var src = list[i++] + '?v=' + ASSET_V;
        var s = document.createElement('script');
        var settled = false;
        var timer = setTimeout(function () {
          if (settled) return;
          settled = true;
          reject(new Error('加载超时：' + src));
        }, LOAD_TIMEOUT);
        s.src = src;
        s.async = false;
        s.onload = function () {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          next();
        };
        s.onerror = function () {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error('无法加载 ' + src));
        };
        document.body.appendChild(s);
      })();
    });
  }

  function hideGate() {
    if (!elGate) return;
    document.body.classList.remove('auth-locked');
    elGate.classList.add('auth-gate-hide');
    setTimeout(function () {
      if (elGate && elGate.parentNode) elGate.parentNode.removeChild(elGate);
    }, 340);
  }

  function enterApp() {
    showMsg('');
    setBusy('正在加载数据…');
    loadScripts(APP_SCRIPTS).then(function () {
      setBusy('');
      hideGate();
      // 通知业务层登录成功（app.js 若已就绪可据此刷新界面）
      try {
        document.dispatchEvent(new CustomEvent('auth:ready', {
          detail: { user: Auth.currentUser }
        }));
      } catch (e) { /* 老浏览器不支持 CustomEvent 构造器时忽略 */ }
    }).catch(function (err) {
      setBusy('');
      showMsg(String(err && err.message ? err.message : err), 'error');
      showForm(Auth.hasUsers() ? 'login' : 'setup');
      showRetry('资源加载失败，请检查网络后重试');
    });
  }

  /* ---------------- 事件绑定 ---------------- */

  function bind() {
    if (elSetupForm) {
      elSetupForm.addEventListener('submit', function (e) {
        e.preventDefault();
        if (busy) return;
        showMsg('');
        var u = $('#setup-username') ? $('#setup-username').value : '';
        var p = $('#setup-password') ? $('#setup-password').value : '';
        var c = $('#setup-confirm') ? $('#setup-confirm').value : '';
        setBusy('正在创建管理员账号…');
        Auth.setup(u, p, c).then(function (r) {
          if (!r.ok) { setBusy(''); showMsg(r.error, 'error'); return; }
          setBusy('账号已创建，正在进入…');
          enterApp();
        }).catch(function (err) {
          setBusy('');
          showMsg('创建失败：' + (err && err.message ? err.message : err), 'error');
        });
      });
    }

    if (elLoginForm) {
      elLoginForm.addEventListener('submit', function (e) {
        e.preventDefault();
        if (busy) return;
        showMsg('');
        var u = $('#login-username') ? $('#login-username').value : '';
        var p = $('#login-password') ? $('#login-password').value : '';
        var remember = $('#login-remember') ? $('#login-remember').checked : true;
        setBusy('正在验证…');
        Auth.login(u, p, remember).then(function (r) {
          if (!r.ok) { setBusy(''); showMsg(r.error, 'error'); return; }
          setBusy('登录成功，正在进入…');
          enterApp();
        }).catch(function (err) {
          setBusy('');
          showMsg('登录失败：' + (err && err.message ? err.message : err), 'error');
        });
      });
    }

    if (elRetry) {
      elRetry.addEventListener('click', function () {
        elRetry.hidden = true;
        showMsg('');
        if (Auth.isLoggedIn()) enterApp();
        else start();
      });
    }

    // 会话在别的标签页被登出时，本页也退回登录界面
    global.addEventListener('storage', function (e) {
      if (e.key === 'snt-auth-session-v1' && !e.newValue && !document.getElementById('auth-gate')) {
        location.reload();
      }
    });
  }

  /* ---------------- 启动 ---------------- */

  function start() {
    elGate = $('#auth-gate');
    elSub = $('#auth-sub');
    elMsg = $('#auth-msg');
    elLoading = $('#auth-loading');
    elLoadingText = $('#auth-loading-text');
    elSetupForm = $('#auth-setup-form');
    elLoginForm = $('#auth-login-form');
    elRetry = $('#auth-retry');

    if (!elGate) return; // 没有关卡节点（例如被裁剪过的页面）时不做任何拦截

    bind();
    Auth.init();

    if (!Auth.hasUsers()) {
      showForm('setup');
      return;
    }

    Auth.restore().then(function (r) {
      if (r.ok) { enterApp(); return; }
      var hint = (r.error && r.error !== '未登录') ? r.error : '';
      showForm('login');
      if (hint) showMsg(hint, 'warn');
    }).catch(function (err) {
      showForm('login');
      showMsg('初始化失败：' + (err && err.message ? err.message : err), 'error');
    });
  }

  /** 供业务层调用：退出登录（重新加载即可回到登录界面，业务脚本不会再装入） */
  function logout() {
    Auth.logout();
    try { sessionStorage.clear(); } catch (e) { /* ignore */ }
    location.reload();
  }

  global.AuthUI = {
    start: start,
    logout: logout,
    enterApp: enterApp,
    ASSET_V: ASSET_V,
    APP_SCRIPTS: APP_SCRIPTS
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})(typeof window !== 'undefined' ? window : globalThis);
