/* ============================================================
 * auth-boot.js — 登录关卡与启动引导（浏览器专用）
 *
 * 职责：
 *   1) 启动时先判登录态：有效 → 动态注入业务脚本并放行；无效 → 停在登录界面
 *   2) 未登录时业务脚本（store / stock-api / app…）根本不会被加载，
 *      数据不会进入内存，比「只用一个遮罩挡住 UI」更干净
 *   3) 首次使用引导创建管理员账号；日常使用提供「自助注册 + 审核」入口
 *
 * 关于注册审核（纯静态站的能力边界）：
 *   账号表存在各自浏览器的 localStorage 里，没有共享服务端。
 *   · 同一台设备：注册后立即出现在管理员的「用户管理 → 待审核」，点通过即可登录。
 *   · 不同设备：注册者把生成的「申请码」发给管理员 → 管理员粘贴导入并审核
 *     → 把系统生成的「准入码」发回 → 注册者粘贴后即可用自己的密码登录。
 *
 * 之所以「放行后才加载」，是因为纯静态站点没有服务端可以做重定向，
 * 用运行时按需注入脚本是最接近「未授权就拿不到」的做法。
 * ============================================================ */
(function (global) {
  'use strict';

  // 与 index.html 中静态资源版本号保持一致，避免升级后命中旧缓存
  var ASSET_V = '20260917b';

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

  var elGate, elSub, elMsg, elLoading, elLoadingText, elRetry;
  var elLoginForm, elRegisterForm, elRegDone, elCodePanel;
  var elRegCode, elCodeInput, elStrength;
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
    [elLoginForm, elRegisterForm, elCodePanel].forEach(function (f) {
      if (!f) return;
      Array.prototype.forEach.call(f.querySelectorAll('input, button'), function (el) { el.disabled = busy; });
    });
  }

  var SUB_TEXT = {
    setup: '首次使用，请先创建管理员账号',
    login: '请登录后使用',
    register: '注册新账号 · 提交后需管理员审核',
    regdone: '注册申请已提交',
    code: '粘贴管理员发来的准入码'
  };

  function showForm(which) {
    if (elLoginForm) elLoginForm.hidden = which !== 'login';
    if (elRegisterForm) elRegisterForm.hidden = which !== 'register';
    if (elRegDone) elRegDone.hidden = which !== 'regdone';
    if (elCodePanel) elCodePanel.hidden = which !== 'code';
    if (elSub) elSub.textContent = SUB_TEXT[which] || SUB_TEXT.login;
    var focusMap = {
      setup: '#setup-username',
      register: '#reg-username',
      code: '#auth-code-input',
      login: '#login-username'
    };
    var sel = focusMap[which];
    var first = sel ? $(sel) : null;
    if (first) setTimeout(function () { try { first.focus(); } catch (e) { /* ignore */ } }, 60);
  }

  function showRetry(message) {
    if (!elRetry) return;
    elRetry.textContent = message ? (message + '　点击重试') : '点击重试';
    elRetry.hidden = false;
  }

  /** 密码强度提示（注册时实时显示，仅作提示不拦截） */
  function updateStrength() {
    if (!elStrength) return;
    var input = $('#reg-password');
    var pw = input ? input.value : '';
    if (!pw) { elStrength.hidden = true; return; }
    var s = (typeof Auth !== 'undefined' && Auth.passwordStrength)
      ? Auth.passwordStrength(pw) : { level: 1, text: '' };
    elStrength.hidden = false;
    elStrength.className = 'auth-strength lv' + s.level;
    var bar = elStrength.querySelector('i');
    var txt = elStrength.querySelector('span');
    if (bar) bar.style.width = Math.max(12, s.level * 20) + '%';
    if (txt) txt.textContent = '密码强度：' + s.text;
  }

  /** 复制到剪贴板：优先 clipboard API，失败退回 execCommand */
  function copyText(text, okMsg) {
    function fallback() {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        showMsg(ok ? okMsg : '复制失败，请手动选中上面的申请码复制', ok ? 'ok' : 'error');
      } catch (e) {
        showMsg('复制失败，请手动选中上面的申请码复制', 'error');
      }
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { showMsg(okMsg, 'ok'); }).catch(fallback);
        return;
      }
    } catch (e) { /* 落到 fallback */ }
    fallback();
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
      showForm(Auth.hasUsers() ? 'login' : 'register');
      showRetry('资源加载失败，请检查网络后重试');
    });
  }

  /* ---------------- 事件绑定 ---------------- */

  function bind() {
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

    /* ----- 注册：提交后进入待审核，并展示申请码 ----- */
    if (elRegisterForm) {
      elRegisterForm.addEventListener('submit', function (e) {
        e.preventDefault();
        if (busy) return;
        showMsg('');
        var u = $('#reg-username') ? $('#reg-username').value : '';
        var p = $('#reg-password') ? $('#reg-password').value : '';
        var c = $('#reg-confirm') ? $('#reg-confirm').value : '';
        // 先在本地把密码规则与二次确认校验掉，避免为一个必然失败的表单去算哈希
        var vw = Auth.validateUsername(u);
        if (!vw.ok) { showMsg(vw.error, 'error'); return; }
        var vp = Auth.validatePassword(p, c);
        if (!vp.ok) { showMsg(vp.error, 'error'); return; }
        setBusy('正在提交注册申请…');
        Auth.register(u, p).then(function (r) {
          setBusy('');
          if (!r.ok) { showMsg(r.error, 'error'); return; }
          var code = r.requestCode || '';
          if (elRegCode) elRegCode.value = code;
          var hint = $('#reg-code-hint');
          if (hint) hint.textContent = code
            ? '申请码共 ' + code.length + ' 个字符，请完整复制（漏掉一段会校验失败）'
            : '';
          showForm('regdone');
          showMsg('');   // 面板本身已说明状态，这里不再重复提示
          // 记录注册来源（异步，失败不影响注册结果）
          try {
            Auth.resolveIp().then(function (got) {
              Auth.attachRegisterMeta(r.user.username, {
                ip: got && got.ip ? got.ip : '',
                loc: got && got.loc ? got.loc : '',
                ua: (navigator && navigator.userAgent) || ''
              });
            }).catch(function () { /* ignore */ });
          } catch (e) { /* ignore */ }
        }).catch(function (err) {
          setBusy('');
          showMsg('注册失败：' + (err && err.message ? err.message : err), 'error');
        });
      });
      var regPw = $('#reg-password');
      if (regPw) regPw.addEventListener('input', updateStrength);
    }

    /* ----- 注册者：粘贴准入码 ----- */
    if (elCodePanel) {
      var submitCode = function () {
        if (busy) return;
        showMsg('');
        var code = elCodeInput ? elCodeInput.value : '';
        var r = Auth.importApproveCode(code);
        if (!r.ok) { showMsg(r.error, 'error'); return; }
        if (elCodeInput) elCodeInput.value = '';
        var lu = $('#login-username');
        if (lu) lu.value = r.user.username;
        showForm('login');
        showMsg('准入码已生效，请用注册时设置的密码登录', 'ok');
      };
      var codeBtn = $('#auth-code-submit');
      if (codeBtn) codeBtn.addEventListener('click', submitCode);
    }

    /* ----- 视图切换 ----- */
    [['#auth-to-register', 'register'], ['#auth-to-code', 'code']].forEach(function (pair) {
      var btn = $(pair[0]);
      if (btn) btn.addEventListener('click', function () { showMsg(''); showForm(pair[1]); });
    });
    ['#auth-reg-back', '#auth-reg-done-back', '#auth-code-back'].forEach(function (sel) {
      var btn = $(sel);
      if (btn) btn.addEventListener('click', function () { showMsg(''); showForm(Auth.hasUsers() ? 'login' : 'register'); });
    });
    var copyBtn = $('#auth-reg-copy');
    if (copyBtn) copyBtn.addEventListener('click', function () {
      var text = elRegCode ? elRegCode.value : '';
      if (!text) return;
      copyText(text, '申请码已复制，发给管理员即可');
    });

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
    elLoginForm = $('#auth-login-form');
    elRegisterForm = $('#auth-register-form');
    elRegDone = $('#auth-reg-done');
    elCodePanel = $('#auth-code-panel');
    elRegCode = $('#reg-code');
    elCodeInput = $('#auth-code-input');
    elStrength = $('#reg-strength');
    elRetry = $('#auth-retry');

    if (!elGate) return; // 没有关卡节点（例如被裁剪过的页面）时不做任何拦截

    bind();
    Auth.init();

    if (!Auth.hasUsers()) {
      // 首次使用：登录页不再提供「创建管理员」入口，直接展示注册表单。
      // 首个管理员由后台（Auth.setup，开发者在控制台调用）创建，符合「管理员创建功能后台分配」。
      showForm('register');
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
    showForm: showForm,
    ASSET_V: ASSET_V,
    APP_SCRIPTS: APP_SCRIPTS
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})(typeof window !== 'undefined' ? window : globalThis);
