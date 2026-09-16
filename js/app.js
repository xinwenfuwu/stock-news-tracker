/**
 * 主应用 - Vue 3
 * 页面1：新闻追踪  页面2：股票池  页面3：热门板块
 */
const { createApp, ref, reactive, computed, onMounted, watch, nextTick } = Vue;

const app = createApp({
  setup() {
    Store.init(Vue);
    const D = Store.data;

    // ===== 数据迁移：relatedStocks 字符串 → 数组 =====
    D.news.forEach(n => {
      if (typeof n.relatedStocks === 'string') {
        n.relatedStocks = StockAPI.parseStockInput(n.relatedStocks);
      } else if (!Array.isArray(n.relatedStocks)) {
        n.relatedStocks = [];
      }
    });

    // ===== 路由 =====
    const currentPage = ref('news');
    const tabs = [
      { key: 'news', label: '新闻追踪', icon: '📰' },
      { key: 'finance', label: '全球信息', icon: '🌐' },
      { key: 'pools', label: '股票池', icon: '📅' },
      { key: 'sector', label: '概念行业选股', icon: '🧭' },
      { key: 'filter', label: '筛选板块', icon: '🎯' },
      { key: 'hot', label: '热门板块', icon: '🔥' }
    ];
    function goPage(key) {
      currentPage.value = key;
      location.hash = key;
      // 进入「全球信息」页：优先展示最近可用的内置快照（同源、无需代理），再考虑实时抓取
      if (key === 'finance') autoLoadHotTopics();
    }
    // 初始化路由
    const hash = location.hash.replace('#', '');
    if (['news', 'finance', 'pools', 'sector', 'filter', 'hot'].includes(hash)) currentPage.value = hash;

    // ===== 登录账号与权限 =====
    // Auth 由 js/auth.js 提供；auth-boot.js 只在登录通过后才加载本文件，
    // 因此正常情况下这里一定拿得到已登录用户。
    const A = (typeof Auth !== 'undefined' && Auth) ? Auth : null;
    const authUser = ref(A && A.user ? A.user : null);
    const userMenuOpen = ref(false);
    const userList = ref([]);
    const userModal = reactive({ show: false, newUsername: '', newPassword: '', newRole: 'user' });
    const pwModal = reactive({ show: false, username: '', oldPassword: '', newPassword: '', confirmPassword: '' });

    const authInitial = computed(() => {
      const n = (authUser.value && authUser.value.username) ? authUser.value.username : '?';
      return n.slice(0, 1).toUpperCase();
    });

    const authExpiryText = computed(() => {
      const s = A && A.session;
      if (!s || !s.exp) return '本次会话有效';
      const d = new Date(s.exp);
      const p = n => String(n).padStart(2, '0');
      return '有效期至 ' + Store.fmtDate(d) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    });

    /** 权限判定：UI 只是把入口藏起来，真正的拦截在 Auth 的方法内部再做一次 */
    function can(perm) { return !!(A && A.can(perm)); }

    function fmtDateTime(ts) {
      if (!ts) return '—';
      const d = new Date(ts);
      const p = n => String(n).padStart(2, '0');
      return Store.fmtDate(d) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }

    function doLogout() {
      userMenuOpen.value = false;
      if (typeof AuthUI !== 'undefined' && AuthUI.logout) AuthUI.logout();
      else if (A) { A.logout(); location.reload(); }
    }

    function refreshUserList() { userList.value = A ? A.listUsers() : []; }

    function openUserManage() {
      userMenuOpen.value = false;
      if (!can('users.manage')) { showToast('仅管理员可管理账号', 'error'); return; }
      userModal.newUsername = ''; userModal.newPassword = ''; userModal.newRole = 'user';
      refreshUserList();
      userModal.show = true;
    }

    function addUserByAdmin() {
      if (!A) return;
      A.addUser(userModal.newUsername, userModal.newPassword, userModal.newRole).then(r => {
        if (!r.ok) { showToast(r.error, 'error'); return; }
        showToast(`已添加用户「${r.user.username}」`, 'success');
        userModal.newUsername = ''; userModal.newPassword = ''; userModal.newRole = 'user';
        refreshUserList();
      }).catch(e => showToast('添加失败：' + e.message, 'error'));
    }

    function changeUserRole(u, role) {
      if (!A) return;
      const r = A.setUserRole(u.username, role);
      if (!r.ok) { showToast(r.error, 'error'); refreshUserList(); return; }
      showToast(`「${u.username}」已设为${A.roleName(role)}`, 'success');
      refreshUserList();
    }

    function toggleUserDisabled(u) {
      if (!A) return;
      const r = A.setUserDisabled(u.username, !u.disabled);
      if (!r.ok) { showToast(r.error, 'error'); return; }
      showToast(`「${u.username}」已${u.disabled ? '启用' : '停用'}`, 'success');
      refreshUserList();
    }

    function removeUserByAdmin(u) {
      if (!A) return;
      if (!confirm(`确定删除用户「${u.username}」？删除后该账号无法再登录。`)) return;
      const r = A.removeUser(u.username);
      if (!r.ok) { showToast(r.error, 'error'); return; }
      showToast('已删除用户', 'success');
      refreshUserList();
    }

    function resetUserPassword(u) {
      if (!A) return;
      const np = prompt(`为「${u.username}」设置新密码（至少 6 位）：`);
      if (np == null) return;
      A.changePassword(u.username, null, np).then(r => {
        if (!r.ok) { showToast(r.error, 'error'); return; }
        showToast(`「${u.username}」的密码已重置`, 'success');
      }).catch(e => showToast('重置失败：' + e.message, 'error'));
    }

    function exportUsersTable() {
      if (!A) return;
      const blob = new Blob([A.exportUsers()], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'stock-news-accounts-' + Store.today() + '.json';
      a.click();
      URL.revokeObjectURL(url);
      showToast('账号表已导出（只含哈希，不含明文密码）', 'success');
    }

    function importUsersTable(e) {
      const file = e.target.files && e.target.files[0];
      if (!file || !A) return;
      const reader = new FileReader();
      reader.onload = () => {
        const r = A.importUsers(String(reader.result), 'merge');
        if (!r.ok) { showToast(r.error, 'error'); return; }
        showToast(`已导入账号表，当前共 ${r.count} 个账号`, 'success');
        refreshUserList();
      };
      reader.readAsText(file);
      e.target.value = '';
    }

    function openChangePassword() {
      userMenuOpen.value = false;
      if (!A || !A.user) return;
      pwModal.username = A.user.username;
      pwModal.oldPassword = ''; pwModal.newPassword = ''; pwModal.confirmPassword = '';
      pwModal.show = true;
    }

    function submitChangePassword() {
      if (!A) return;
      if (pwModal.newPassword !== pwModal.confirmPassword) { showToast('两次输入的新密码不一致', 'error'); return; }
      A.changePassword(pwModal.username, pwModal.oldPassword, pwModal.newPassword).then(r => {
        if (!r.ok) { showToast(r.error, 'error'); return; }
        pwModal.show = false;
        authUser.value = A.user;
        showToast('密码已修改', 'success');
      }).catch(e => showToast('修改失败：' + e.message, 'error'));
    }

    // ===== Toast =====
    const toast = reactive({ show: false, msg: '', type: 'info', _t: null });
    function showToast(msg, type = 'info') {
      toast.msg = msg;
      toast.type = type;
      toast.show = true;
      clearTimeout(toast._t);
      toast._t = setTimeout(() => (toast.show = false), 2800);
    }

    // ===== 数据刷新总开关（顶部「暂停」按钮） =====
    // 语义：暂停的是「自动」发起的刷新——进入页面自动抓取热门话题、导入后自动补价、
    // 板块详情自动补历史价、数据变化后自动云同步。手动点击的刷新按钮一律照常执行，
    // 否则暂停后整个页面会变成「点什么都没反应」，那反而是个 bug。
    if (typeof D.settings.dataPaused !== 'boolean') D.settings.dataPaused = false;
    const dataPaused = computed({
      get: () => !!D.settings.dataPaused,
      set: (v) => { D.settings.dataPaused = !!v; }
    });
    /** 自动刷新是否已被暂停（各处自动刷新逻辑统一走这里判断） */
    function autoRefreshPaused() { return !!D.settings.dataPaused; }
    /** 被暂停时的统一提示（只在真正会发起自动请求的位置调用，避免刷屏） */
    function pauseHint(what) {
      showToast(`已暂停数据自动刷新：未执行${what || '自动刷新'}。可点顶部 ▶ 恢复，或手动点刷新按钮`, 'info');
    }
    function toggleDataPause() {
      dataPaused.value = !dataPaused.value;
      if (dataPaused.value) {
        showToast('已暂停数据自动刷新（进入页面不再自动抓取、不再自动云同步；手动刷新按钮照常可用）', 'info');
      } else {
        showToast('已恢复数据自动刷新', 'success');
        if (currentPage.value === 'finance') autoLoadHotTopics();
      }
    }

    // ===== 通用格式化 =====
    const allCategories = computed(() => D.settings.categories || Store.DEFAULT_CATEGORIES);

    function fmt(v) {
      if (v == null || v === '' || isNaN(v)) return '—';
      return (+v).toFixed(2);
    }
    function fmtPct(v) {
      if (v == null || v === '' || isNaN(v)) return '—';
      const n = +v;
      return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
    }
    /** 日期 YYYY-MM-DD → YYYY年MM月DD日 */
    function fmtDateCN(dateStr) {
      if (!dateStr) return '';
      const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m) return `${m[1]}年${m[2]}月${m[3]}日`;
      return dateStr;
    }
    function numClass(v) {
      if (v == null || v === '' || isNaN(v)) return 'muted';
      const n = +v;
      if (n > 0) return 'up';      // 正数：红
      if (n < 0) return 'down';    // 负数：绿
      return 'flat';
    }
    function pctClass(v) {
      if (v == null || v === '' || isNaN(v)) return 'muted';
      const n = +v;
      if (n > 0) return 'up';
      if (n < 0) return 'down';
      return 'flat';
    }

    // ===== 股票池财务字段格式化与计算 =====

    /** 金额(元) → 亿字符串，如 44516880421 → 445.17亿 */
    function fmtYi(v) {
      if (v == null || isNaN(v)) return '—';
      return (+v / 1e8).toFixed(2) + '亿';
    }
    /** 亿元数字 */
    function yiVal(v) {
      return v == null || isNaN(v) ? null : +(v / 1e8);
    }
    /** 数值相除工具（安全） */
    function ratio(a, b) {
      if (a == null || b == null || isNaN(a) || isNaN(b)) return null;
      if (+b === 0) return null;
      return +(+a / +b);
    }
    /**
     * 市值类比值计算。
     * 统一用「亿元」：总市值=totalMarketCap(亿)，净利润/扣非/营收=元→转亿。
     * 市净比(pbRatio) = 总市值 ÷ 净利润 ÷ 10
     * 市扣比(pkRatio) = 总市值 ÷ 扣非净利润 ÷ 10
     * 市营比(prRatio) = 总市值 ÷ 营业收入
     * 市净同比(pyRatio) = 总市值 ÷ 净利润同比增长率(profitYoY)
     * 市扣同比(pk2Ratio) = 总市值 ÷ 扣非净利润同比增长率(kcfYoY)
     * 市营同比(prrRatio) = 总市值 ÷ 营收同比增长率(revenueYoY)
     * 市净环比(ph2Ratio) = 总市值 ÷ 净利润环比增长率(hbGrowth)
     * 市扣环比(pkHbRatio) = 总市值 ÷ 扣非净利润环比增长率(kcfHb)
     * 市营环比(phRatio) = 总市值 ÷ 营收环比增长率(revHb)
     */
    function sRatio(s) {
      const cap = s.totalMarketCap;
      const net = yiVal(s.netProfit);     // 净利润(亿)
      const kcf = yiVal(s.kcfjcxjlr);     // 扣非净利润(亿)
      const rev = yiVal(s.revenue);       // 营业收入(亿)
      const p = ratio(cap, net);           // 总市值/净利润
      const k = ratio(cap, kcf);           // 总市值/扣非净利润
      const pr = ratio(cap, rev);          // 总市值/营业收入
      const pRatio = p != null ? +(p / 10).toFixed(2) : null;   // 市净比
      const kRatio = k != null ? +(k / 10).toFixed(2) : null;   // 市扣比
      const prRatio = pr != null ? +pr.toFixed(2) : null;       // 市营比
      // 市净同比 = 总市值 ÷ 净利润同比增长率(profitYoY)
      const py = s.profitYoY != null && +s.profitYoY !== 0 ? +(+cap / +s.profitYoY).toFixed(2) : null;
      // 市扣同比 = 总市值 ÷ 扣非净利润同比增长率(kcfYoY)
      const pk2 = s.kcfYoY != null && +s.kcfYoY !== 0 ? +(+cap / +s.kcfYoY).toFixed(2) : null;
      // 市营同比 = 总市值 ÷ 营收同比增长率(revenueYoY)
      const prrRatio = s.revenueYoY != null && +s.revenueYoY !== 0 ? +(+cap / +s.revenueYoY).toFixed(2) : null;
      // 市净环比 = 总市值 ÷ 净利润环比增长率(hbGrowth)
      const ph2 = s.hbGrowth != null && +s.hbGrowth !== 0 ? +(+cap / +s.hbGrowth).toFixed(2) : null;
      // 市扣环比 = 总市值 ÷ 扣非净利润环比增长率(kcfHb)
      const pkHb = s.kcfHb != null && +s.kcfHb !== 0 ? +(+cap / +s.kcfHb).toFixed(2) : null;
      // 市营环比 = 总市值 ÷ 营收环比增长率(revHb)
      const ph = s.revHb != null && +s.revHb !== 0 ? +(+cap / +s.revHb).toFixed(2) : null;
      return { pbRatio: pRatio, pkRatio: kRatio, pyRatio: py, pk2Ratio: pk2, phRatio: ph, prRatio, prrRatio, ph2Ratio: ph2, pkHbRatio: pkHb };
    }

    function parseStocks(val) {
      if (Array.isArray(val)) return val;
      if (typeof val === 'string') return StockAPI.parseStockInput(val);
      return [];
    }

    /** 从 stock 对象列表生成可读字符串 */
    function stocksText(val) {
      return parseStocks(val).map(s => s.name ? `${s.name}(${StockAPI.pureCode(s.code)})` : StockAPI.pureCode(s.code)).join(', ');
    }

    /** 取纯代码 */
    function pureCode(code) {
      return StockAPI.pureCode(code);
    }

    // ============================================================
    //  通用：收藏
    // ============================================================
    const favorites = computed(() => D.favorites || []);
    const sortedFavorites = computed(() => {
      const list = [...(D.favorites || [])];
      if (favSort.key) {
        const dir = favSort.dir === 'asc' ? 1 : -1;
        list.sort((a, b) => compareForSort(a, b, favSort.key) * dir);
      } else {
        list.sort((a, b) => (b.favDate || '').localeCompare(a.favDate || ''));
      }
      return list;
    });
    function isFav(code) { return Store.isFavorite(code); }
    /** 收藏/取消收藏（股票对象）—— 保存完整股票字段，使收藏板块可展示与概念选股一致的字段 */
    function toggleFavorite(stock) {
      if (!stock || !stock.code) return;
      if (Store.isFavorite(stock.code)) {
        Store.removeFavorite(stock.code);
        showToast(`已取消收藏「${stock.name || stock.code}」`, 'success');
      } else {
        const fav = _newStock(stock);
        fav.favDate = Store.today();
        fav.note = '';
        // 添加当日股价快照：供「距添加」字段计算基准，且不会被后续行情刷新覆盖
        fav.favPrice = (stock.todayPrice != null && !isNaN(stock.todayPrice)) ? +stock.todayPrice : null;
        // 复制现有数据字段（若来源已带行情/财务数据则一并保存）
        const keys = ['industry','dailyChange','amplitude','capitalFlow','shareholderCount','prevShareholderCount',
          'profitYoY','revenueYoY','hbGrowth','kcfYoY','revHb','kcfHb','q24Rev','q24Kcf',
          'netProfit','kcfjcxjlr','revenue','totalMarketCap',
          'contractLiab','todayPrice','yearStartPrice','price924','yearChange','change924',
          'weekAgoClose','monthAgoClose','weekChange','monthChange','turnover',
          'yearHighPrice','yearLowPrice','favPrice'];
        keys.forEach(k => { if (stock[k] != null) fav[k] = stock[k]; });
        const ok = Store.addFavorite(fav);
        if (ok) showToast(`已收藏「${stock.name || stock.code}」`, 'success');
      }
    }
    function removeFavorite(code) {
      const f = (D.favorites || []).find(f => f.code === code);
      if (f && confirm(`确认取消收藏「${f.name || code}」？`)) {
        Store.removeFavorite(code);
        showToast('已取消收藏', 'success');
      }
    }
    function updateFavNote(fav, note) {
      Store.updateFavoriteNote(fav.id, note);
      showToast('备注已保存', 'success');
    }
    /** 收藏距今天数 */
    function favDays(fav) {
      if (!fav.favDate) return null;
      return Store.daysSince(fav.favDate);
    }
    /**
     * 「距添加」：自加入收藏以来的涨跌幅(%)
     * 计算规则：(现价 - 添加当日股价) / 添加当日股价 × 100
     * 添加当日股价取自收藏快照字段 favPrice（收藏时写入，历史数据缺失时由刷新流程按收藏日期回填当日收盘价）。
     */
    function favGainPct(fav) {
      if (!fav) return null;
      const base = fav.favPrice;
      const cur = fav.todayPrice;
      if (base == null || cur == null || isNaN(base) || isNaN(cur) || !base) return null;
      return +(((cur - base) / base) * 100).toFixed(2);
    }
    /** 回填「添加当日股价」：缺失 favPrice 时，按收藏日期取当日收盘价（历史收藏同样适用） */
    async function ensureFavPrice(fav) {
      if (!fav || !fav.code || !fav.favDate) return;
      if (fav.favPrice != null && !isNaN(fav.favPrice)) return;
      try {
        // 收藏日若为非交易日则无K线，向后顺延 7 天取首个交易日收盘价
        const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const d0 = new Date(fav.favDate);
        const d1 = new Date(d0.getTime() + 7 * 86400000);
        const rows = await StockAPI.getKline(fav.code, ymd(d0), ymd(d1));
        const close = rows && rows.length ? rows[0].close : null;
        if (close != null && !isNaN(close)) {
          fav.favPrice = close;
          Store.save();
        }
      } catch (e) {
        console.debug('添加日股价回填失败', fav.code, e);
      }
    }
    // 收藏板块手动新增
    const favAddCode = ref('');
    const favAddName = ref('');
    function addFavoriteManual() {
      const code = String(favAddCode.value || '').trim();
      const name = String(favAddName.value || '').trim();
      if (!code) { showToast('请输入股票代码', 'error'); return; }
      // 手动添加也用完整字段结构，便于表格展示一致字段
      const fav = _newStock({ code, name: name || code });
      fav.favDate = Store.today();
      fav.note = '';
      const ok = Store.addFavorite(fav);
      if (ok) {
        showToast(`已收藏「${name || code}」`, 'success');
        favAddCode.value = '';
        favAddName.value = '';
      } else {
        showToast('该股票已在收藏中', 'info');
      }
    }
    /** 补全单只股票的财务/股东/历史价数据（东财，best-effort）。供收藏/股票池/热门表刷新复用。 */
    async function enrichStockFinancials(s) {
      if (!s || !s.code) return;
      try {
        const [flow, fin] = await Promise.all([
          StockAPI.getCapitalFlow(s.code),
          StockAPI.getFinance(s.code)
        ]);
        if (flow != null) s.capitalFlow = flow;
        if (fin.profitYoY != null) s.profitYoY = fin.profitYoY;
        if (fin.revenueYoY != null) s.revenueYoY = fin.revenueYoY;
        if (fin.hbGrowth != null) s.hbGrowth = fin.hbGrowth;
        if (fin.kcfYoY != null) s.kcfYoY = fin.kcfYoY;
        if (fin.revHb != null) s.revHb = fin.revHb;
        if (fin.kcfHb != null) s.kcfHb = fin.kcfHb;
        if (fin.netProfit != null) s.netProfit = fin.netProfit;
        if (fin.kcfjcxjlr != null) s.kcfjcxjlr = fin.kcfjcxjlr;
        if (fin.revenue != null) s.revenue = fin.revenue;
        if (fin.contractLiab != null) s.contractLiab = fin.contractLiab;
        if (fin.shareholderCount != null) s.shareholderCount = fin.shareholderCount;
        if (fin.prevShareholderCount != null) s.prevShareholderCount = fin.prevShareholderCount;
      } catch (e) { console.warn('财务数据获取失败', s.code, e); }
      try {
        const q24 = await StockAPI.getQuarterlyFinance(s.code);
        if (q24.q24Rev != null) s.q24Rev = q24.q24Rev;
        if (q24.q24Kcf != null) s.q24Kcf = q24.q24Kcf;
      } catch (e) { console.warn('季报对比获取失败', s.code, e); }
      // 历史价：优先「一次请求取四项」（getHistoryBundle，请求量降为 1/3），
      // 取不到的项再逐项兜底。各项独立 try —— 原先四项挤在同一个 try 里，
      // 只要 getYearStartPrice 抛异常，后面三项就永远不会执行，六个字段全部空白。
      try {
        const hb = await StockAPI.getHistoryBundle(s.code);
        if (hb) {
          if (hb.yearStartPrice != null) s.yearStartPrice = hb.yearStartPrice;
          if (hb.price924 != null) s.price924 = hb.price924;
          if (hb.yearHighPrice != null) s.yearHighPrice = hb.yearHighPrice;
          if (hb.yearLowPrice != null) s.yearLowPrice = hb.yearLowPrice;
          if (hb.yearHighDate != null) s.yearHighDate = hb.yearHighDate;
          if (hb.yearLowDate != null) s.yearLowDate = hb.yearLowDate;
          if (hb.weekAgoClose != null) s.weekAgoClose = hb.weekAgoClose;
          if (hb.monthAgoClose != null) s.monthAgoClose = hb.monthAgoClose;
        }
      } catch (e) { console.warn('历史价批量获取失败', s.code, e); }
      if (s.yearStartPrice == null) {
        try {
          const yp = await StockAPI.getYearStartPrice(s.code);
          if (yp != null) s.yearStartPrice = yp;
        } catch (e) { console.warn('年初价获取失败', s.code, e); }
      }
      if (s.price924 == null) {
        try {
          const p924 = await StockAPI.get924Price(s.code);
          if (p924 != null) s.price924 = p924;
        } catch (e) { console.warn('924价获取失败', s.code, e); }
      }
      if (s.yearHighPrice == null || s.yearLowPrice == null) {
        try {
          const yhl = await StockAPI.getYearHighLow(s.code);
          if (yhl) {
            if (yhl.high != null) s.yearHighPrice = yhl.high;
            if (yhl.low != null) s.yearLowPrice = yhl.low;
          }
        } catch (e) { console.warn('今年高低价获取失败', s.code, e); }
      }
      // 所属行业 / 主营构成（best-effort，仅在缺失时请求，避免重复拉取）
      try {
        if (!s.industry) {
          const ind = await StockAPI.getIndustry(s.code);
          if (ind) s.industry = ind;
        }
      } catch (e) { console.warn('行业获取失败', s.code, e); }
      try {
        if (!s.mainBusiness) {
          const mb = await StockAPI.getMainBusiness(s.code);
          if (mb) s.mainBusiness = mb;
        }
      } catch (e) { console.warn('主营构成获取失败', s.code, e); }
      if (s.todayPrice && s.yearStartPrice) {
        s.yearChange = +(((s.todayPrice - s.yearStartPrice) / s.yearStartPrice) * 100).toFixed(2);
      }
      if (s.todayPrice && s.price924) {
        s.change924 = +(((s.todayPrice - s.price924) / s.price924) * 100).toFixed(2);
      }
      // 一周涨跌 / 一月涨跌：现价 vs 5 / 20 个交易日前收盘价
      if (s.todayPrice && s.weekAgoClose) {
        s.weekChange = +(((s.todayPrice - s.weekAgoClose) / s.weekAgoClose) * 100).toFixed(2);
      }
      if (s.todayPrice && s.monthAgoClose) {
        s.monthChange = +(((s.todayPrice - s.monthAgoClose) / s.monthAgoClose) * 100).toFixed(2);
      }
    }

    // 刷新收藏股票行情与财务数据
    const favRefreshing = ref(false);
    async function refreshFavorites() {
      const favs = D.favorites || [];
      if (!favs.length) { showToast('暂无收藏股票', 'error'); return; }
      favRefreshing.value = true;
      showToast('正在刷新收藏行情...', 'info');
      try {
        // 1) 实时行情（腾讯）
        let quotes = {};
        try { quotes = await StockAPI.getQuotes(favs.map(f => f.code).filter(Boolean)); }
        catch (e) { console.warn('收藏行情刷新失败', e); }
        for (const f of favs) {
          const q = quotes[f.code];
          if (q) {
            f.name = f.name || q.name;
            f.dailyChange = q.changePercent;
            f.amplitude = q.amplitude;
            f.turnover = q.turnover;
            f.todayPrice = q.price || f.todayPrice;
            if (q.totalMarketCap) f.totalMarketCap = q.totalMarketCap;
          }
        }
        showToast('行情已刷新，正在获取财务数据...', 'info');
        // 2) 财务/股东数据（东财，best-effort，复用共享补全逻辑）
        for (let i = 0; i < favs.length; i++) {
          // 「距添加」基准价缺失时（如历史收藏/手动添加），按收藏日期回填当日收盘价
          await ensureFavPrice(favs[i]);
          await enrichStockFinancials(favs[i]);
        }
        showToast('收藏行情已刷新', 'success');
      } catch (e) {
        showToast('刷新失败，请重试', 'error');
        console.warn('收藏刷新异常', e);
      } finally {
        favRefreshing.value = false;
      }
    }

    // ============================================================
    //  页面1：新闻追踪
    // ============================================================
    const newsFilter = reactive({ date: '', keyword: '', category: '', customTag: '' });
    // 财经推送：右侧嵌入财经网页（与 Store 数据同源，自动持久化）
    const financePush = Store.data.financePush;
    function toggleFinanceLock() {
      if (!financePush.locked) {
        // 锁定：需先有网址
        if (!financePush.url || !financePush.url.trim()) {
          showToast('请先输入财经网址再锁定', 'error');
          return;
        }
        financePush.url = financePush.url.trim();
        financePush.locked = true;
        showToast('已锁定，财经网页已固定', 'success');
      } else {
        financePush.locked = false;
        showToast('已解锁财经推送', 'info');
      }
    }

    // 财经推送页面：推送新闻到「新闻追踪」
    const financePushNews = reactive({
      content: '',          // 新闻内容（必填）
      url: '',              // 来源链接（可选）
      date: Store.today(),  // 新闻日期
      category: '',         // 概念分类（可选）
      relatedStocks: [],    // 关联股票 [{name, code}]
      stockSearch: '',
      suggestions: [],
      _searchTimer: null
    });
    function onFinanceStockSearch() {
      clearTimeout(financePushNews._searchTimer);
      const kw = financePushNews.stockSearch.trim();
      if (!kw) { financePushNews.suggestions = []; return; }
      financePushNews._searchTimer = setTimeout(async () => {
        try {
          const results = await StockAPI.searchStocks(kw);
          const exist = new Set((financePushNews.relatedStocks || []).map(s => s.code));
          financePushNews.suggestions = results
            .filter(r => r.type === 'GP-A' || r.type === 'GP-S' || !r.type)
            .filter(r => !exist.has(r.code)).slice(0, 8);
        } catch (e) { financePushNews.suggestions = []; }
      }, 300);
    }
    function addFinanceStock(s) {
      if (!Array.isArray(financePushNews.relatedStocks)) financePushNews.relatedStocks = [];
      if (!financePushNews.relatedStocks.find(x => x.code === s.code)) {
        financePushNews.relatedStocks.push({ name: s.name, code: s.code });
      }
      financePushNews.stockSearch = '';
      financePushNews.suggestions = [];
    }
    function removeFinanceStock(idx) {
      if (Array.isArray(financePushNews.relatedStocks)) financePushNews.relatedStocks.splice(idx, 1);
    }
    function pushFinanceNews() {
      const content = (financePushNews.content || '').trim();
      if (!content) { showToast('请输入新闻内容', 'error'); return; }
      const url = (financePushNews.url || '').trim();
      const fullContent = url ? `🔗 ${url}\n${content}` : content;
      const item = {
        date: financePushNews.date || Store.today(),
        content: fullContent,
        conceptCategory: '',
        industryCategory: '',
        customTag: '',
        relatedStocks: (financePushNews.relatedStocks || []).map(s => ({ name: s.name, code: s.code })),
        category: financePushNews.category || '',
        newsDayPrice: null, price924: null, todayPrice: null
      };
      item.daysSince = Store.daysSince(item.date);
      const added = Store.addNews(item);
      fillPriceForNews(added, true);
      showToast('已推送到新闻追踪', 'success');
      // 重置表单（保留日期）
      financePushNews.content = '';
      financePushNews.url = '';
      financePushNews.relatedStocks = [];
      financePushNews.category = '';
      financePushNews.stockSearch = '';
      financePushNews.suggestions = [];
    }
    const selectedNewsIds = ref([]);
    const sortKey = ref('daysSince');
    const sortDir = ref('desc');
    const priceLoading = ref(false);

    const filteredNews = computed(() => {
      let list = D.news;
      if (newsFilter.date) list = list.filter(n => n.date === newsFilter.date);
      if (newsFilter.category) list = list.filter(n => n.category === newsFilter.category);
      if (newsFilter.customTag) {
        const kw = newsFilter.customTag.toLowerCase();
        list = list.filter(n => (n.customTag || '').toLowerCase().includes(kw));
      }
      if (newsFilter.keyword) {
        const kw = newsFilter.keyword.toLowerCase();
        list = list.filter(n =>
          (n.content || '').toLowerCase().includes(kw) ||
          stocksText(n.relatedStocks).toLowerCase().includes(kw) ||
          (n.conceptCategory || '').toLowerCase().includes(kw) ||
          (n.industryCategory || '').toLowerCase().includes(kw) ||
          (n.customTag || '').toLowerCase().includes(kw)
        );
      }
      return list;
    });

    const sortedNews = computed(() => {
      const list = [...filteredNews.value];
      const k = sortKey.value;
      const dir = sortDir.value === 'asc' ? 1 : -1;
      list.sort((a, b) => {
        let va = a[k], vb = b[k];
        if (k === 'daysSince') {
          va = Store.daysSince(a.date);
          vb = Store.daysSince(b.date);
        }
        va = parseFloat(va);
        vb = parseFloat(vb);
        if (isNaN(va)) va = dir > 0 ? Infinity : -Infinity;
        if (isNaN(vb)) vb = dir > 0 ? Infinity : -Infinity;
        return (va - vb) * dir;
      });
      return list;
    });

    function sortBy(key) {
      if (sortKey.value === key) {
        sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc';
      } else {
        sortKey.value = key;
        sortDir.value = 'desc';
      }
    }
    function sortIcon(key) {
      if (sortKey.value !== key) return '⇅';
      return sortDir.value === 'asc' ? '↑' : '↓';
    }

    // 选择相关
    const allNewsSelected = computed(() =>
      filteredNews.value.length > 0 && selectedNewsIds.value.length === filteredNews.value.length
    );
    function toggleSelectAll(e) {
      if (e.target.checked) {
        selectedNewsIds.value = filteredNews.value.map(n => n.id);
      } else {
        selectedNewsIds.value = [];
      }
    }
    function invertSelection() {
      const all = new Set(filteredNews.value.map(n => n.id));
      const sel = new Set(selectedNewsIds.value);
      selectedNewsIds.value = [...all].filter(id => !sel.has(id));
    }
    function selectAllNews() {
      selectedNewsIds.value = filteredNews.value.map(n => n.id);
    }
    function clearSelection() {
      selectedNewsIds.value = [];
    }
    function deleteSelectedNews() {
      if (!selectedNewsIds.value.length) return;
      if (!confirm(`确认删除选中的 ${selectedNewsIds.value.length} 条新闻？`)) return;
      Store.deleteNewsBatch(selectedNewsIds.value);
      selectedNewsIds.value = [];
      showToast('已删除选中新闻', 'success');
    }

    // 新闻增删改
    const newsModal = reactive({
      show: false,
      isEdit: false,
      data: {},
      stockSearch: '',
      suggestions: [],
      _searchTimer: null
    });
    function openAddNews() {
      newsModal.isEdit = false;
      newsModal.data = {
        date: Store.today(),
        content: '',
        conceptCategory: '',
        industryCategory: '',
        customTag: '',
        relatedStocks: [],
        category: '',
        newsDayPrice: null,
        price924: null,
        todayPrice: null
      };
      newsModal.stockSearch = '';
      newsModal.suggestions = [];
      newsModal.show = true;
    }
    function editNews(item) {
      newsModal.isEdit = true;
      newsModal.data = JSON.parse(JSON.stringify(item));
      // 确保 relatedStocks 是数组
      if (!Array.isArray(newsModal.data.relatedStocks)) {
        newsModal.data.relatedStocks = parseStocks(newsModal.data.relatedStocks);
      }
      newsModal.stockSearch = '';
      newsModal.suggestions = [];
      newsModal.show = true;
    }

    // 股票联想搜索（防抖）
    function onStockSearchInput() {
      clearTimeout(newsModal._searchTimer);
      const kw = newsModal.stockSearch.trim();
      if (!kw) { newsModal.suggestions = []; return; }
      newsModal._searchTimer = setTimeout(async () => {
        const results = await StockAPI.searchStocks(kw);
        // 过滤已添加的
        const exist = new Set((newsModal.data.relatedStocks || []).map(s => s.code));
        newsModal.suggestions = results.filter(r => r.type === 'GP-A' || r.type === 'GP-S' || !r.type).filter(r => !exist.has(r.code)).slice(0, 8);
      }, 300);
    }
    function addStock(s) {
      if (!Array.isArray(newsModal.data.relatedStocks)) newsModal.data.relatedStocks = [];
      if (!newsModal.data.relatedStocks.find(x => x.code === s.code)) {
        newsModal.data.relatedStocks.push({ name: s.name, code: s.code });
      }
      newsModal.stockSearch = '';
      newsModal.suggestions = [];
    }
    function removeStock(idx) {
      if (Array.isArray(newsModal.data.relatedStocks)) {
        newsModal.data.relatedStocks.splice(idx, 1);
      }
    }
    function closeStockSuggestions() {
      setTimeout(() => { newsModal.suggestions = []; }, 200);
    }

    function saveNews() {
      if (!newsModal.data.content || !newsModal.data.content.trim()) {
        showToast('请输入新闻内容', 'error');
        return;
      }
      if (!newsModal.data.date) {
        showToast('请选择日期', 'error');
        return;
      }
      const d = newsModal.data;
      // 确保 relatedStocks 是数组
      if (!Array.isArray(d.relatedStocks)) d.relatedStocks = parseStocks(d.relatedStocks);
      // 计算距今
      d.daysSince = Store.daysSince(d.date);
      if (newsModal.isEdit) {
        const original = D.news.find(n => n.id === d.id);
        const oldStockStr = original ? stocksText(original.relatedStocks) : '';
        const newStockStr = stocksText(d.relatedStocks);
        // 若关联股票变化，清空旧股价，避免刷新时仍显示旧股票的价位
        if (original && oldStockStr !== newStockStr) {
          d.newsDayPrice = null;
          d.price924 = null;
          d.todayPrice = null;
          d.todayChange = null;
          d.changeSinceNews = null;
          d.changeSince924 = null;
        }
        Store.updateNews(d.id, d);
        showToast('已更新', 'success');
        // 关联股票变化后自动补全新股价
        if (oldStockStr !== newStockStr) {
          const updated = D.news.find(n => n.id === d.id);
          if (updated) fillPriceForNews(updated, true);
        }
      } else {
        delete d.id;
        const item = Store.addNews(d);
        // 异步补全股价
        fillPriceForNews(item, true);
        showToast('已添加', 'success');
      }
      newsModal.show = false;
    }
    function deleteNews(id) {
      if (!confirm('确认删除该条新闻？')) return;
      Store.deleteNews(id);
      showToast('已删除', 'success');
    }

    // 为单条新闻补全股价
    async function fillPriceForNews(item, silent) {
      const stocks = parseStocks(item.relatedStocks);
      if (!stocks.length) {
        if (!silent) showToast('该新闻未关联股票', 'error');
        return;
      }
      const primary = stocks[0];
      if (!primary.code) {
        if (!silent) showToast('关联股票代码无效', 'error');
        return;
      }
      if (!silent) showToast('正在获取股价...', 'info');
      try {
        const tasks = [
          StockAPI.getQuote(primary.code),
          StockAPI.get924Price(primary.code),
          StockAPI.getHistoryClose(primary.code, item.date)
        ];
        const [quote, p924, newsDay] = await Promise.all(tasks);
        if (quote) {
          item.todayPrice = quote.price;
          item.todayChange = quote.changePercent;
        }
        if (p924 != null) item.price924 = p924;
        if (newsDay != null) item.newsDayPrice = newsDay;
        item.daysSince = Store.daysSince(item.date);
        // 计算涨幅
        if (item.newsDayPrice && item.todayPrice) {
          item.changeSinceNews = +(((item.todayPrice - item.newsDayPrice) / item.newsDayPrice) * 100).toFixed(2);
        }
        if (item.price924 && item.todayPrice) {
          item.changeSince924 = +(((item.todayPrice - item.price924) / item.price924) * 100).toFixed(2);
        }
        if (!silent) showToast('股价已更新', 'success');
      } catch (e) {
        if (!silent) showToast('股价获取失败', 'error');
      }
    }

    // 批量刷新所有新闻股价
    async function refreshAllPrices() {
      const list = filteredNews.value.filter(n => parseStocks(n.relatedStocks).length);
      if (!list.length) {
        showToast('没有可刷新股价的新闻', 'error');
        return;
      }
      priceLoading.value = true;
      showToast(`正在刷新 ${list.length} 条新闻的股价...`, 'info');
      // 按股票代码分组，避免同一只股票重复请求历史数据
      const stockGroups = {};
      for (const n of list) {
        const s = parseStocks(n.relatedStocks)[0];
        if (!s.code) continue;
        if (!stockGroups[s.code]) stockGroups[s.code] = [];
        stockGroups[s.code].push(n);
      }
      const codes = Object.keys(stockGroups);
      try {
        // 实时行情批量获取
        const quotes = await StockAPI.getQuotes(codes);
        let stockCount = 0;
        for (const [code, newsItems] of Object.entries(stockGroups)) {
          stockCount++;
          showToast(`正在获取 ${code} 的历史价格... (${stockCount}/${codes.length})`, 'info');
          // 924 股价：每只代码只请求一次
          const p924 = await StockAPI.get924Price(code);
          // 新闻日股价：按日期去重，每个日期只请求一次
          const dates = [...new Set(newsItems.map(n => n.date).filter(Boolean))];
          const newsDayPrices = {};
          for (const date of dates) {
            newsDayPrices[date] = await StockAPI.getHistoryClose(code, date);
          }
          const q = quotes[code];
          for (const n of newsItems) {
            if (q) {
              n.todayPrice = q.price;
              n.todayChange = q.changePercent;
            }
            if (p924 != null) n.price924 = p924;
            const nd = newsDayPrices[n.date];
            if (nd != null) n.newsDayPrice = nd;
            n.daysSince = Store.daysSince(n.date);
            if (n.newsDayPrice && n.todayPrice) {
              n.changeSinceNews = +(((n.todayPrice - n.newsDayPrice) / n.newsDayPrice) * 100).toFixed(2);
            }
            if (n.price924 && n.todayPrice) {
              n.changeSince924 = +(((n.todayPrice - n.price924) / n.price924) * 100).toFixed(2);
            }
          }
        }
        showToast(`已刷新 ${list.length} 条新闻股价`, 'success');
      } catch (e) {
        showToast('刷新失败：' + e.message, 'error');
      } finally {
        priceLoading.value = false;
      }
    }

    // ===== 导入新闻 =====
    const importModal = reactive({
      show: false,
      tab: 'paste',
      date: Store.today(),
      text: ''
    });
    function openImportDialog() {
      importModal.date = Store.today();
      importModal.text = '';
      importModal.tab = 'paste';
      importModal.show = true;
    }
    const previewImportCount = computed(() => {
      if (importModal.tab !== 'paste') return 0;
      return importModal.text.split(/\n+/).map(s => s.trim()).filter(Boolean).length;
    });
    function doPasteImport() {
      const lines = importModal.text.split(/\n+/).map(s => s.trim()).filter(Boolean);
      if (!lines.length) {
        showToast('没有可导入的内容', 'error');
        return;
      }
      let added = 0;
      for (const line of lines) {
        Store.addNews({
          date: importModal.date || Store.today(),
          content: line,
          conceptCategory: '',
          industryCategory: '',
          customTag: '',
          relatedStocks: [],
          category: '',
          newsDayPrice: null,
          price924: null,
          todayPrice: null,
          daysSince: Store.daysSince(importModal.date)
        });
        added++;
      }
      showToast(`已导入 ${added} 条新闻`, 'success');
      importModal.show = false;
      // 尝试批量补价（自动补价同样受顶部「暂停」开关控制）
      nextTick(() => {
        const fresh = D.news.slice(0, added);
        if (autoRefreshPaused()) pauseHint('导入后的自动补价');
        else setTimeout(() => refreshAllPrices(), 300);
      });
    }

    // 一键抓取财经快讯（通过 Cloudflare Worker 代理，免费）
    async function doScrapeImport() {
      const date = importModal.date;
      const base = (D.settings.proxyUrl || '').trim().replace(/\/+$/, '');
      if (!base) {
        showToast('请先在「设置」里填写新闻代理地址（免费Cloudflare Worker）', 'error');
        return;
      }
      showToast('正在通过代理抓取财经快讯...', 'info');
      try {
        // 抓取多页以确保覆盖所选日期
        const allItems = [];
        for (let page = 1; page <= 3; page++) {
          const resp = await fetch(`${base}/news?page=${page}&size=50`);
          if (!resp.ok) throw new Error('代理返回错误 ' + resp.status);
          const json = await resp.json();
          const list = (json.data && json.data.list) || [];
          if (!list.length) break;
          allItems.push(...list);
          // 如果最早一条已经早于所选日期，停止翻页
          const oldest = list[list.length - 1];
          if (oldest && oldest.showTime && oldest.showTime.slice(0, 10) < date) break;
        }
        // 按日期过滤
        const dateStr = date || Store.today();
        const filtered = allItems.filter(it => {
          const t = it.showTime || '';
          return t.slice(0, 10) === dateStr;
        });
        const news = (filtered.length ? filtered : allItems.slice(0, 50)).map(it => {
          const title = (it.title || '').trim();
          const summary = (it.summary || '').trim();
          const content = title && summary ? `${title}：${summary}` : (title || summary);
          return makeNewsItem(dateStr, content);
        }).filter(n => n.content);
        if (!news.length) {
          showToast('所选日期暂无快讯，可尝试换一天或用「粘贴导入」', 'error');
          return;
        }
        for (const n of news) Store.addNews(n);
        showToast(`抓取并导入 ${news.length} 条财经快讯`, 'success');
        importModal.show = false;
        if (autoRefreshPaused()) pauseHint('导入后的自动补价');
        else setTimeout(() => refreshAllPrices(), 300);
      } catch (e) {
        showToast('抓取失败：' + e.message + '。请检查代理地址是否正确', 'error');
      }
    }

    function parseScrapedNews(text, source, date) {
      const result = [];
      try {
        const json = JSON.parse(text);
        const list = json.result || json.data || json.list || (json.data && json.data.list) || [];
        for (const item of (Array.isArray(list) ? list : [])) {
          const content = item.title || item.content || item.summary || '';
          if (content) result.push(makeNewsItem(date, content));
        }
      } catch (e) {
        text.split(/\n+/).forEach(line => {
          line = line.trim();
          if (line.length > 5 && line.length < 200) result.push(makeNewsItem(date, line));
        });
      }
      return result;
    }
    function makeNewsItem(date, content) {
      return {
        date: date || Store.today(),
        content,
        conceptCategory: '', industryCategory: '', customTag: '',
        relatedStocks: [], category: '',
        newsDayPrice: null, price924: null, todayPrice: null,
        daysSince: Store.daysSince(date)
      };
    }

    // ============================================================
    //  页面2：股票池
    // ============================================================
    const poolLoading = ref(false);
    const poolModal = reactive({ show: false, isEdit: false, data: {} });
    const poolDetail = reactive({ show: false, data: { stocks: [] }, nameEdit: false, nameDraft: '', addText: '' });
    const poolDetailSort = reactive({ key: 'dailyChange', dir: 'desc' });

    const sortedPools = computed(() => {
      return [...D.stockPools].sort((a, b) => {
        const va = parseFloat(a.avgChange) || -Infinity;
        const vb = parseFloat(b.avgChange) || -Infinity;
        return vb - va; // 降序
      });
    });

    function openAddPool() {
      poolModal.isEdit = false;
      poolModal.data = { date: Store.today(), name: '', stockText: '' };
      poolModal.show = true;
    }
    function openEditPool(pool) {
      poolModal.isEdit = true;
      poolModal.data = {
        id: pool.id,
        date: pool.date,
        name: pool.name || '',
        stockText: pool.stocks.map(s => s.name ? `${s.name}(${StockAPI.pureCode(s.code)})` : StockAPI.pureCode(s.code)).join('\n')
      };
      poolModal.show = true;
    }
    /** 创建一个标准的股票池股票对象（初始化所有字段为 null） */
    function _newStock(s) {
      return {
        code: s.code,
        name: s.name || '',
        industry: s.industry || null,   // 所属一级行业
        dailyChange: null,
        amplitude: null,
        capitalFlow: null,
        shareholderCount: null,
        prevShareholderCount: null,
        profitYoY: null,
        revenueYoY: null,
        hbGrowth: null,
        kcfYoY: null,        // 扣非净利润同比增长率(%)
        revHb: null,         // 营收环比增长率(%)
        kcfHb: null,         // 扣非净利润环比增长率(%)
        q24Rev: null,        // 24营比：最新营收 vs 2024同期 增长率(%)
        q24Kcf: null,        // 24扣比：最新扣非 vs 2024同期 增长率(%)
        netProfit: null,       // 净利润(元)
        kcfjcxjlr: null,       // 扣非净利润(元)
        revenue: null,         // 营业收入(元)
        totalMarketCap: null,  // 总市值(亿)
        contractLiab: null,    // 最新合同负债(元)
        todayPrice: null,      // 当日收盘价
        yearStartPrice: null,  // 年初第1个交易日收盘价
        price924: null,        // 2024-09-24 收盘价
        yearChange: null,      // 年初涨跌幅(%)
        change924: null,       // 924涨跌幅(%)
        weekAgoClose: null,    // 一周前(5个交易日前)收盘价
        monthAgoClose: null,   // 一月前(20个交易日前)收盘价
        weekChange: null,      // 一周涨跌：现价 vs 一周前收盘价(%)
        monthChange: null,     // 一月涨跌：现价 vs 一月前收盘价(%)
        turnover: null
      };
    }

    function savePool() {
      const stocks = StockAPI.parseStockInput(poolModal.data.stockText);
      if (!stocks.length) {
        showToast('请输入至少一只股票', 'error');
        return;
      }
      const stockList = stocks.map(s => _newStock(s));
      if (poolModal.isEdit) {
        const existing = D.stockPools.find(p => p.id === poolModal.data.id);
        // 保留已有的手动数据
        if (existing) {
          const map = {};
          existing.stocks.forEach(s => { map[s.code] = s; });
          stockList.forEach(s => {
            if (map[s.code]) {
              const o = map[s.code];
              s.capitalFlow = o.capitalFlow;
              s.shareholderCount = o.shareholderCount;
              s.prevShareholderCount = o.prevShareholderCount;
              s.profitYoY = o.profitYoY;
              s.revenueYoY = o.revenueYoY;
              s.hbGrowth = o.hbGrowth;
              s.kcfYoY = o.kcfYoY;
              s.revHb = o.revHb;
              s.kcfHb = o.kcfHb;
              s.q24Rev = o.q24Rev;
              s.q24Kcf = o.q24Kcf;
              s.netProfit = o.netProfit;
              s.kcfjcxjlr = o.kcfjcxjlr;
              s.revenue = o.revenue;
              s.totalMarketCap = o.totalMarketCap;
              s.contractLiab = o.contractLiab;
              s.industry = o.industry;
              s.todayPrice = o.todayPrice;
              s.yearStartPrice = o.yearStartPrice;
              s.price924 = o.price924;
              s.yearChange = o.yearChange;
              s.change924 = o.change924;
              s.weekAgoClose = o.weekAgoClose;
              s.monthAgoClose = o.monthAgoClose;
              s.weekChange = o.weekChange;
              s.monthChange = o.monthChange;
            }
          });
        }
        Store.updatePool(poolModal.data.id, { name: (poolModal.data.name || '').trim(), date: poolModal.data.date, stocks: stockList, avgChange: null });
        showToast('股票池已更新', 'success');
      } else {
        Store.addPool({ name: (poolModal.data.name || '').trim(), date: poolModal.data.date, stocks: stockList, avgChange: null });
        showToast('股票池已创建', 'success');
      }
      poolModal.show = false;
      // 自动刷新
      nextTick(() => refreshPoolPrices());
    }
    function deletePool(id) {
      if (!confirm('确认删除该股票池？')) return;
      Store.deletePool(id);
      showToast('已删除', 'success');
    }

    /** 一键选择当日股票明细：从当日新闻关联股票生成，预填到股票列表 */
    function pickDailyStocks() {
      const date = poolModal.data.date;
      if (!date) {
        showToast('请先选择日期', 'error');
        return;
      }
      const dayNews = D.news.filter(n => n.date === date);
      const stockMap = {};
      for (const n of dayNews) {
        const stocks = parseStocks(n.relatedStocks);
        for (const s of stocks) {
          if (s.code && !stockMap[s.code]) stockMap[s.code] = s;
        }
      }
      const list = Object.values(stockMap);
      if (!list.length) {
        showToast(`所选日期（${date}）的新闻中暂无关联股票`, 'error');
        return;
      }
      poolModal.data.stockText = list.map(s =>
        s.name ? `${s.name}(${StockAPI.pureCode(s.code)})` : StockAPI.pureCode(s.code)
      ).join('\n');
      showToast(`已填入 ${list.length} 只当日股票，可再手动增删`, 'success');
    }

    // 刷新所有股票池涨跌幅
    async function refreshPoolPrices() {
      if (!D.stockPools.length) {
        showToast('暂无股票池', 'error');
        return;
      }
      poolLoading.value = true;
      showToast('正在刷新股票池行情...', 'info');
      try {
        // 收集所有代码
        const allCodes = new Set();
        D.stockPools.forEach(p => p.stocks.forEach(s => { if (s.code) allCodes.add(s.code); }));
        const quotes = await StockAPI.getQuotes([...allCodes]);
        for (const pool of D.stockPools) {
          let sum = 0, cnt = 0;
          for (const s of pool.stocks) {
            const q = quotes[s.code];
            if (q) {
              s.name = s.name || q.name;
              s.dailyChange = q.changePercent;
              s.amplitude = q.amplitude;
              s.turnover = q.turnover;
              if (q.totalMarketCap) s.totalMarketCap = q.totalMarketCap;   // 总市值(亿)
              if (!isNaN(q.changePercent)) { sum += q.changePercent; cnt++; }
            }
          }
          pool.avgChange = cnt > 0 ? +(sum / cnt).toFixed(2) : null;
        }
        showToast('股票池行情已刷新', 'success');
      } catch (e) {
        showToast('刷新失败', 'error');
      } finally {
        poolLoading.value = false;
      }
    }

    function openPoolDetail(pool) {
      poolDetail.data = pool;
      poolDetail.nameEdit = false;
      poolDetail.nameDraft = pool.name || '';
      poolDetail.addText = '';
      poolDetail.show = true;
    }

    /** 在详情弹窗中向当前股票池添加股票（支持多只，用逗号/换行/分号分隔） */
    async function addPoolStocks() {
      const txt = (poolDetail.addText || '').trim();
      if (!txt) { showToast('请输入要添加的股票代码或名称', 'error'); return; }
      const pool = poolDetail.data;
      const parsed = StockAPI.parseStockInput(txt);
      if (!parsed.length) { showToast('未识别到有效股票', 'error'); return; }
      const existing = new Set((pool.stocks || []).map(s => s.code));
      let added = 0;
      const newStocks = [];
      for (const p of parsed) {
        if (existing.has(p.code)) continue;
        const ns = _newStock(p);
        newStocks.push(ns);
        existing.add(p.code);
        added++;
      }
      if (!added) { showToast('这些股票已在该股票池中', 'info'); return; }
      // 补充名称
      try {
        const quotes = await StockAPI.getQuotes(newStocks.map(s => s.code));
        newStocks.forEach(s => { const q = quotes[s.code]; if (q) s.name = s.name || q.name; });
      } catch (e) { console.warn('补充名称失败', e); }
      pool.stocks.push(...newStocks);
      // 同步更新平均涨跌幅
      recomputePoolAvg(pool);
      poolDetail.addText = '';
      showToast(`已添加 ${added} 只股票`, 'success');
    }

    /** 从当前股票池删除一只股票 */
    function removePoolStock(code) {
      const pool = poolDetail.data;
      const idx = (pool.stocks || []).findIndex(s => s.code === code);
      if (idx === -1) return;
      const name = pool.stocks[idx].name || code;
      if (!confirm(`确认从股票池中删除「${name}」？`)) return;
      pool.stocks.splice(idx, 1);
      recomputePoolAvg(pool);
      showToast('已删除', 'success');
    }
    /** 筛选板块：从「当前选中的来源池（股票池或概念板块）」中删除某只股票 */
    function removeFilterStock(code) {
      const id = filterPanel.poolId;
      if (!id) return;
      let pool = null;
      if (id.startsWith('s-')) pool = (D.sectorPools || []).find(p => 's-' + p.id === id);
      else pool = (D.stockPools || []).find(p => 'p-' + p.id === id);
      if (!pool || !pool.stocks) return;
      const idx = pool.stocks.findIndex(s => s.code === code);
      if (idx === -1) return;
      const name = pool.stocks[idx].name || code;
      if (!confirm(`确认从「${pool.name || ''}」中删除「${name}」？`)) return;
      pool.stocks.splice(idx, 1);
      recomputePoolAvg(pool);
      showToast('已删除', 'success');
    }

    /** 重新计算股票池平均涨跌幅（增删股票后调用） */
    function recomputePoolAvg(pool) {
      let sum = 0, cnt = 0;
      (pool.stocks || []).forEach(s => {
        if (s.dailyChange != null && !isNaN(s.dailyChange)) { sum += s.dailyChange; cnt++; }
      });
      pool.avgChange = cnt > 0 ? +(sum / cnt).toFixed(2) : null;
    }

    function startEditPoolName() {
      poolDetail.nameDraft = poolDetail.data.name || '';
      poolDetail.nameEdit = true;
    }
    function savePoolName() {
      poolDetail.data.name = (poolDetail.nameDraft || '').trim();
      poolDetail.nameEdit = false;
      showToast('股票池名称已更新', 'success');
    }

    async function refreshPoolDetail(pool) {
      showToast('正在刷新行情与财务数据...', 'info');
      const codes = pool.stocks.map(s => s.code).filter(Boolean);
      // 1) 实时行情（腾讯，稳定）—— 无 codes 也能返回空对象
      let quotes = {};
      try {
        quotes = await StockAPI.getQuotes(codes);
      } catch (e) {
        console.warn('实时行情刷新失败', e);
      }
      for (const s of pool.stocks) {
        const q = quotes[s.code];
        if (q) {
          s.name = s.name || q.name;
          s.dailyChange = q.changePercent;
          s.amplitude = q.amplitude;
          s.turnover = q.turnover;
          s.todayPrice = q.price || s.todayPrice;                 // 当日价
          if (q.totalMarketCap) s.totalMarketCap = q.totalMarketCap;   // 总市值(亿)
        }
      }
      // 重新计算平均
      recomputePoolAvg(pool);
      showToast('行情已刷新，正在获取财务/股东数据...', 'info');
      // 2) 补充数据（东方财富，best-effort）：逐只 try/catch，避免单只失败中断整体
      const works = pool.stocks.filter(s => s.code);
      for (let i = 0; i < works.length; i++) {
        const s = works[i];
        try {
          const [flow, fin] = await Promise.all([
            StockAPI.getCapitalFlow(s.code),
            StockAPI.getFinance(s.code)
          ]);
          if (flow != null) s.capitalFlow = flow;
          if (fin.profitYoY != null) s.profitYoY = fin.profitYoY;
          if (fin.revenueYoY != null) s.revenueYoY = fin.revenueYoY;
          if (fin.hbGrowth != null) s.hbGrowth = fin.hbGrowth;
          if (fin.kcfYoY != null) s.kcfYoY = fin.kcfYoY;
          if (fin.revHb != null) s.revHb = fin.revHb;
          if (fin.kcfHb != null) s.kcfHb = fin.kcfHb;
          if (fin.netProfit != null) s.netProfit = fin.netProfit;
          if (fin.kcfjcxjlr != null) s.kcfjcxjlr = fin.kcfjcxjlr;
          if (fin.revenue != null) s.revenue = fin.revenue;
          if (fin.contractLiab != null) s.contractLiab = fin.contractLiab;
          if (fin.shareholderCount != null) s.shareholderCount = fin.shareholderCount;
          if (fin.prevShareholderCount != null) s.prevShareholderCount = fin.prevShareholderCount;
        } catch (e) {
          console.warn('补充数据获取失败', s.code, e);
        }
        // 所属行业（best-effort）
        try {
          if (!s.industry) {
            const ind = await StockAPI.getIndustry(s.code);
            if (ind) s.industry = ind;
          }
        } catch (e) {
          console.warn('行业获取失败', s.code, e);
        }
        // 主营构成（公司主业 + 占比，best-effort）
        try {
          if (!s.mainBusiness) {
            const mb = await StockAPI.getMainBusiness(s.code);
            if (mb) s.mainBusiness = mb;
          }
        } catch (e) {
          console.warn('主营构成获取失败', s.code, e);
        }
        // 24营比 / 24扣比（季报营收/扣非对比2024同期）
        try {
          const q24 = await StockAPI.getQuarterlyFinance(s.code);
          if (q24.q24Rev != null) s.q24Rev = q24.q24Rev;
          if (q24.q24Kcf != null) s.q24Kcf = q24.q24Kcf;
        } catch (e) {
          console.warn('季报对比获取失败', s.code, e);
        }
        // 历史价：优先「一次请求取四项 + 一周/一月」（getHistoryBundle，请求量降为 1/4 且腾讯优先），
        // 取不到的项再逐项兜底（各自独立 try，互不连坐）。旧实现把三项挤在同一 try 里，
        // 且 924 走 getHistoryClose 的窄窗口取不到 2024-09-24，导致「924涨跌」等字段长期为空。
        // 收藏/热门/筛选页早已改用此模式，唯独本函数（概念行业选股 + 股票池详情共用）遗漏。
        try {
          const hb = await StockAPI.getHistoryBundle(s.code);
          if (hb) {
            if (hb.yearStartPrice != null) s.yearStartPrice = hb.yearStartPrice;
            if (hb.price924 != null) s.price924 = hb.price924;
            if (hb.yearHighPrice != null) s.yearHighPrice = hb.yearHighPrice;
            if (hb.yearLowPrice != null) s.yearLowPrice = hb.yearLowPrice;
            if (hb.yearHighDate != null) s.yearHighDate = hb.yearHighDate;
            if (hb.yearLowDate != null) s.yearLowDate = hb.yearLowDate;
            if (hb.weekAgoClose != null) s.weekAgoClose = hb.weekAgoClose;
            if (hb.monthAgoClose != null) s.monthAgoClose = hb.monthAgoClose;
          }
        } catch (e) { console.warn('历史价批量获取失败', s.code, e); }
        if (s.yearStartPrice == null) {
          try {
            const yp = await StockAPI.getYearStartPrice(s.code);
            if (yp != null) s.yearStartPrice = yp;
          } catch (e) { console.warn('年初价获取失败', s.code, e); }
        }
        if (s.price924 == null) {
          try {
            const p924 = await StockAPI.get924Price(s.code);
            if (p924 != null) s.price924 = p924;
          } catch (e) { console.warn('924价获取失败', s.code, e); }
        }
        if (s.yearHighPrice == null || s.yearLowPrice == null) {
          try {
            const yhl = await StockAPI.getYearHighLow(s.code);
            if (yhl) {
              if (yhl.high != null) s.yearHighPrice = yhl.high;
              if (yhl.low != null) s.yearLowPrice = yhl.low;
            }
          } catch (e) { console.warn('今年高低价获取失败', s.code, e); }
        }
        // 重新计算年初涨跌幅、924涨跌幅
        if (s.todayPrice && s.yearStartPrice) {
          s.yearChange = +(((s.todayPrice - s.yearStartPrice) / s.yearStartPrice) * 100).toFixed(2);
        }
        if (s.todayPrice && s.price924) {
          s.change924 = +(((s.todayPrice - s.price924) / s.price924) * 100).toFixed(2);
        }
        // 一周涨跌 / 一月涨跌
        if (s.todayPrice && s.weekAgoClose) {
          s.weekChange = +(((s.todayPrice - s.weekAgoClose) / s.weekAgoClose) * 100).toFixed(2);
        }
        if (s.todayPrice && s.monthAgoClose) {
          s.monthChange = +(((s.todayPrice - s.monthAgoClose) / s.monthAgoClose) * 100).toFixed(2);
        }
        // 每 5 只让出一次事件循环，避免卡顿
        if ((i + 1) % 5 === 0) await new Promise(r => setTimeout(r, 0));
      }
      showToast('数据刷新完成', 'success');
    }

    /** 正数统计：区间字段中「数值为正的个数」与「有数据的字段总数」（空值/非数字不计入总数） */
    function positiveStat(s) {
      let pos = 0, total = 0;
      for (const k of POSITIVE_KEYS) {
        const v = poolVal(s, k);
        if (v == null || v === '' || isNaN(parseFloat(v))) continue;
        total++;
        if (parseFloat(v) > 0) pos++;
      }
      return { pos, total };
    }
    /** 正数统计个数（供排序与区间筛选使用，返回数值） */
    function positiveCount(s) { return positiveStat(s).pos; }
    /** 正数统计展示文本：正数个数 / 有数据字段总数 */
    function positiveCountText(s) {
      const r = positiveStat(s);
      return r.total ? (r.pos + '/' + r.total) : '—';
    }

    /**
     * 公司主业展示文本：取主营构成中占比最高的前 2 项，格式「名称 占比%」。
     * 仅展示，不参与排序/筛选。
     */
    function mainBusinessText(s) {
      const arr = s && s.mainBusiness;
      if (!arr || !arr.length) return '';
      // 注意：东财主营构成 MBI_RATIO 已是百分比(如 60.0)，与 mainBizShareRatio 保持一致，直接显示，勿再 ×100
      return arr.slice(0, 2)
        .map(it => `${it.name} ${it.ratio != null ? it.ratio.toFixed(1) + '%' : ''}`)
        .join(' · ');
    }

    /** 主营产品（主业）营收占比：取主营构成中占营收比例最高的主营项，返回其占比(%)。
     *  说明：东财主营构成只提供每项产品的「营收占比(MBI_RATIO/MBR_RATIO)」，无分产品扣非净利润占比。 */
    function mainBizShareRatio(s) {
      const arr = s && s.mainBusiness;
      if (!arr || !arr.length) return null;
      const top = [...arr].sort((a, b) => (b.ratio || 0) - (a.ratio || 0))[0];
      return top && top.ratio != null ? +top.ratio : null;
    }
    /** 主营扣占比 = 主业营收占比 / 主营扣非占比。当前仅有营收占比(见 mainBizShareRatio)；
     *  扣非占比暂无数据源，先以占位符返回，公式与文案保留。 */
    function mainBizKcfRatio(s) {
      const revShare = mainBizShareRatio(s);
      if (revShare == null) return null;
      return { revShare: revShare, kcfShare: null };   // kcfShare 缺失 → 单元格显示占比 + "—"
    }
    /** 概念标签：从该股已保存的行业(industry)与主营产品名中，抽取出最多3个中文概念/行业标签（三行展示）。 */
    function stockConcepts(s) {
      const tags = [];
      const push = t => { t = String(t || '').trim(); if (t && tags.length < 3 && !tags.includes(t)) tags.push(t); };
      push(s && s.industry);
      const arr = s && s.mainBusiness;
      if (arr && arr.length) {
        for (const it of arr) {
          if (tags.length >= 3) break;
          const m = String(it.name || '').replace(/[（(].*?[)）]/g, '').trim();
          // 中文连续片段（长度≥2）作为候选概念词
          const segs = m.match(/[\u4e00-\u9fa5]{2,}/g) || [];
          for (const sg of segs) { if (tags.length < 3) push(sg); }
        }
      }
      return tags;
    }
    /** 合同负债展示：`1.5亿/组内排名`。rank 依据传入列表按合同负债降序。 */
    function contractLiabCell(s, list) {
      if (s.contractLiab == null) return null;
      const val = fmtYi(s.contractLiab);
      if (!Array.isArray(list) || !list.length) return val;
      const ranked = [...list].filter(x => x && x.contractLiab != null)
        .sort((a, b) => (b.contractLiab || 0) - (a.contractLiab || 0));
      const idx = ranked.findIndex(x => x.code === s.code);
      return { text: val, rank: idx >= 0 ? idx + 1 : null, total: ranked.length };
    }
    /** 金额(元) → 亿展示，空则占位 */
    function fmtYiOr(s, v) { return v == null ? '—' : fmtYi(v); }

    // ============================================================
    //  统一股票表列定义（消息7规范，去重后）
    //  前 4 列为冻结列(fixed)：序号/代码/股票名称/正数统计；其余随横条滚动
    // ============================================================
    const STOCK_COLUMNS = [
      { key: '__idx', label: '序号', fixed: true, fixedIndex: 0, width: 46, sortable: false, type: 'idx' },
      { key: 'code', label: '代码', fixed: true, fixedIndex: 1, width: 88, sortable: true, type: 'code' },
      { key: 'name', label: '股票名称', fixed: true, fixedIndex: 2, width: 104, sortable: true, type: 'name' },
      { key: 'positiveCount', label: '统计', fixed: true, fixedIndex: 3, width: 60, sortable: true, type: 'pos' },
      // 财务估值段：净利润 / 扣非净利润 / 相关度 / 市营比 / 市净比 / 市扣比
      // 按需求：24营比、24扣比 紧随「市扣比」之后；「相关度」列位于「市营比」左侧（来自 AI 语义搜索的营收占比相关度）
      { key: 'netProfit', label: '净利润', width: 100, sortable: true, type: 'money' },
      { key: 'kcfjcxjlr', label: '扣非净利润', width: 100, sortable: true, type: 'money' },
      { key: 'relevance', label: '相关度', width: 88, sortable: true, type: 'relevance' },
      { key: 'prRatio', label: '市营比', width: 86, sortable: true, type: 'ratio' },
      { key: 'pbRatio', label: '市净比', width: 86, sortable: true, type: 'ratio' },
      { key: 'pkRatio', label: '市扣比', width: 86, sortable: true, type: 'ratio' },
      { key: 'q24Rev', label: '24营比', width: 88, sortable: true, type: 'pct' },
      { key: 'q24Kcf', label: '24扣比', width: 88, sortable: true, type: 'pct' },
      // 924涨跌 / 年涨跌：按需求置于「24扣比」右侧（紧贴 24扣比），二者位置互换
      { key: 'change924', label: '924涨跌', width: 88, sortable: true, type: 'pct' },
      { key: 'yearChange', label: '年涨跌', width: 88, sortable: true, type: 'pct' },
      // 现价：今日实时股价，固定红色显示，便于与各项涨跌幅直接对照
      { key: 'todayPrice', label: '现价', width: 84, sortable: true, type: 'curPrice' },
      // 涨跌幅段（日涨跌紧贴一周涨跌左侧；一周/一月涨跌置于「距高价」左侧）
      // 一周涨跌 = 现价 vs 5 个交易日前收盘价；一月涨跌 = 现价 vs 20 个交易日前收盘价
      { key: 'dailyChange', label: '日涨跌', width: 88, sortable: true, type: 'pct' },
      { key: 'weekChange', label: '一周涨跌', width: 88, sortable: true, type: 'pct' },
      { key: 'monthChange', label: '一月涨跌', width: 88, sortable: true, type: 'pct' },
      { key: 'distToYearHigh', label: '距高价', width: 88, sortable: true, type: 'pct' },
      { key: 'distToYearLow', label: '距低价', width: 88, sortable: true, type: 'pct' },
      { key: 'pyRatio', label: '市净同比', width: 92, sortable: true, type: 'num2' },
      { key: 'pk2Ratio', label: '市扣同比', width: 92, sortable: true, type: 'num2' },
      { key: 'prrRatio', label: '市营同比', width: 92, sortable: true, type: 'num2' },
      { key: 'phRatio', label: '市净环比', width: 92, sortable: true, type: 'num2' },
      { key: 'pkHbRatio', label: '市扣环比', width: 92, sortable: true, type: 'num2' },
      { key: 'ph2Ratio', label: '市营环比', width: 92, sortable: true, type: 'num2' },
      { key: 'profitYoY', label: '净利润同比', width: 96, sortable: true, type: 'pct' },
      { key: 'hbGrowth', label: '净利润环比', width: 96, sortable: true, type: 'pct' },
      { key: 'kcfYoY', label: '扣非同比', width: 92, sortable: true, type: 'pct' },
      { key: 'kcfHb', label: '扣非环比', width: 92, sortable: true, type: 'pct' },
      { key: 'revenueYoY', label: '营收同比', width: 92, sortable: true, type: 'pct' },
      { key: 'revHb', label: '营收环比', width: 92, sortable: true, type: 'pct' },
      { key: 'amplitude', label: '振幅', width: 78, sortable: true, type: 'num2pct' },
      { key: 'shareholderDiff', label: '散户差额', width: 92, sortable: true, type: 'diff' },
      { key: 'shareholderCount', label: '最新散户', width: 96, sortable: true, type: 'int' },
      { key: 'prevShareholderCount', label: '上期散户', width: 96, sortable: true, type: 'int' },
      // 按需求：今年高价、今年低价 置于「换手率」左侧
      { key: 'yearHighPrice', label: '今年高价', width: 88, sortable: true, type: 'price' },
      { key: 'yearHighDays', label: '距高天', width: 74, sortable: true, type: 'days' },
      { key: 'yearLowPrice', label: '今年低价', width: 88, sortable: true, type: 'price' },
      { key: 'yearLowDays', label: '距低天', width: 74, sortable: true, type: 'days' },
      { key: 'turnover', label: '换手率', width: 78, sortable: true, type: 'num2pct' },
      // 按需求：总市值、营业收入 移至「资金流入」左侧
      { key: 'totalMarketCap', label: '总市值', width: 96, sortable: true, type: 'cap' },
      { key: 'revenue', label: '营业收入', width: 100, sortable: true, type: 'money' },
      { key: 'capitalFlow', label: '资金流入', width: 104, sortable: true, type: 'flow' },
      { key: 'contractLiab', label: '合同负债及排名', width: 100, sortable: true, type: 'contractliab' },
      // 主业与主要产品 / 概念 / 行业：按需求置于字段栏最后（收藏/操作/备注之前）
      { key: 'mainBusiness', label: '主业与主要产品', width: 178, sortable: false, type: 'mainbiz' },
      { key: 'concept', label: '概念', width: 112, sortable: false, type: 'concept' },
      { key: 'industry', label: '行业', width: 96, sortable: true, type: 'text' },
      { key: '__fav', label: '收藏', width: 58, sortable: false, type: 'fav' },
      { key: '__action', label: '操作', width: 84, sortable: false, type: 'action' },
      { key: '__note', label: '备注', width: 132, sortable: false, type: 'note' }
    ];
    /**
     * 正数统计所覆盖的字段集合：日涨跌 + 财务/估值 + 涨跌幅 + 今年高低价 + 同比/环比系列。
     * 【注意】这里用显式清单而非按列顺序切片 —— 列顺序会随需求调整，
     * 若用切片，调整列顺序就会悄悄改变「统计」列的口径。
     */
    const POSITIVE_KEYS = [
      'dailyChange', 'totalMarketCap', 'revenue', 'netProfit', 'kcfjcxjlr',
      'prRatio', 'pbRatio', 'pkRatio', 'q24Rev', 'q24Kcf',
      'todayPrice', 'weekChange', 'monthChange', 'yearChange', 'change924',
      'distToYearHigh', 'distToYearLow', 'yearHighPrice', 'yearLowPrice',
      'pyRatio', 'pk2Ratio', 'prrRatio', 'phRatio', 'pkHbRatio', 'ph2Ratio',
      'profitYoY', 'hbGrowth', 'kcfYoY', 'kcfHb', 'revenueYoY', 'revHb'
    ];
    // 收藏板块专属附加列（保留原有「收藏日期/距今」，置于末尾，不丢数据；备注已并入 STOCK_COLUMNS 标准列）
    const FAV_EXTRA_COLUMNS = [
      { key: '__favDate', label: '收藏日期', width: 104, sortable: false, type: 'favDate' },
      // 距添加：(现价 - 添加当日股价) / 添加当日股价，百分比
      { key: '__favGain', label: '距添加', width: 88, sortable: true, type: 'favGain' },
      { key: '__favDays', label: '距今', width: 70, sortable: false, type: 'favDays' }
    ];

    /** HTML 转义，防止股票名/备注中的特殊字符破坏单元格结构 */
    function esc(x) {
      return String(x == null ? '' : x)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    /** 计算「日期当天距离今天多少天」（自然日差，按本地零点对齐，规避时区偏移）。
     *  @param {string} dateStr 'YYYY-MM-DD'；非法或缺失返回 null */
    function daysFromDate(dateStr) {
      if (!dateStr) return null;
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
      if (!m) return null;
      const d = new Date(+m[1], +m[2] - 1, +m[3]);
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const diff = Math.round((today - d) / 86400000);
      return isNaN(diff) ? null : diff;
    }
    /** 取某上下文对应的列定义（收藏表额外附加 3 列） */
    function getColumns(ctx) {
      return ctx === 'fav' ? STOCK_COLUMNS.concat(FAV_EXTRA_COLUMNS) : STOCK_COLUMNS;
    }
    /** 单元格内容（HTML 字符串），通过 v-html 渲染 */
    function cellHtml(col, s, idx, list, ctx) {
      const v = (k) => poolVal(s, k);
      switch (col.type) {
        case 'idx': return String((idx || 0) + 1);
        case 'code': return esc(s.code || '');
        case 'name': return esc(s.name || s.code || '');
        case 'pos': return positiveCountText(s);
        case 'mainbiz':
          return (s.mainBusiness && s.mainBusiness.length) ? esc(mainBusinessText(s)) : '<span class="muted small">—</span>';
        case 'text':
          return (s[col.key] != null && s[col.key] !== '') ? esc(String(s[col.key])) : '—';
        case 'concept': {
          const tags = stockConcepts(s);
          return tags.length ? tags.map(esc).join('<br>') : '<span class="muted small">—</span>';
        }
        case 'contractliab': {
          const c = contractLiabCell(s, list);
          if (!c) return '<span class="muted small">—</span>';
          return esc(c.text) + (c.rank != null ? '<span class="muted small">/' + c.rank + '</span>' : '');
        }
        case 'pct': { const val = v(col.key); return (val != null && !isNaN(val)) ? '<span class="' + pctClass(val) + '">' + fmtPct(val) + '</span>' : '—'; }
        case 'price': { const val = s[col.key]; return (val != null && !isNaN(val)) ? (+val).toFixed(2) : '—'; }
        case 'ratio': { const val = v(col.key); return (val != null && !isNaN(val)) ? (+val).toFixed(2) : '—'; }
        case 'num2': { const val = v(col.key); return (val != null && !isNaN(val)) ? (+val).toFixed(2) : '—'; }
        // 相关度：来自 AI 语义搜索的「营收占比相关度」(命中主营构成段营收占比之和 %)；无语义来源时显示占位
        case 'relevance': { const val = s[col.key]; return (val != null && !isNaN(val)) ? ((+val).toFixed(1) + '%') : '—'; }
        case 'num2pct': { const val = s[col.key]; return (val != null && !isNaN(val)) ? (+val).toFixed(2) + '%' : '—'; }
        case 'money': { const val = s[col.key]; return (val != null && !isNaN(val)) ? fmtYi(val) : '—'; }
        // 总市值：单位已是「亿元」，直接保留两位小数展示
        case 'cap': { const val = s[col.key]; return (val != null && !isNaN(val)) ? (+val).toFixed(2) + '亿' : '—'; }
        // 现价：今日实时股价，固定红色
        case 'curPrice': { const val = s[col.key]; return (val != null && !isNaN(val)) ? '<span class="price-red">' + (+val).toFixed(2) + '</span>' : '—'; }
        case 'int': { const val = s[col.key]; return (val != null && !isNaN(val)) ? Math.round(val).toLocaleString('en-US') : '—'; }
        case 'diff': { const val = v(col.key); return (val != null && !isNaN(val)) ? ((val > 0 ? '+' : '') + Math.round(val).toLocaleString('en-US')) : '—'; }
        case 'flow': {
          const val = s[col.key];
          if (val == null || isNaN(val)) return '—';
          return '<span class="' + numClass(val) + '">' + fmtYi(val) + '</span>';
        }
        case 'favDate': return esc(s.favDate || '—');
        // 距添加：自加入收藏以来的涨跌幅 (现价-添加日股价)/添加日股价
        case 'favGain': { const val = favGainPct(s); return (val != null && !isNaN(val)) ? '<span class="' + pctClass(val) + '">' + fmtPct(val) + '</span>' : '—'; }
        case 'favDays': { const d = favDays(s); return d != null ? d + '天' : '—'; }
        // 距高天 / 距低天：今年最高/最低价当天距今天数（自然日），无数据占位
        case 'days': { const val = poolVal(s, col.key); return (val != null && !isNaN(val)) ? (val + '天') : '—'; }
        case 'note': {
          if (ctx === 'fav') {
            return '<input class="fav-note-input" data-action="note" data-id="' + esc(s.id) + '" value="' + esc(s.note || '') + '" placeholder="备注">';
          }
          // 非收藏表：显示该股收藏备注（若已收藏），否则占位
          const f = isFav(s.code) ? (D.favorites || []).find(x => x.code === s.code) : null;
          return (f && f.note) ? esc(f.note) : '<span class="muted small">—</span>';
        }
        case 'fav': {
          const on = isFav(s.code);
          return '<button type="button" class="btn-icon fav-btn" data-action="fav" data-code="' + esc(s.code) + '" data-name="' + esc(s.name || '') + '">' + (on ? '★' : '☆') + '</button>';
        }
        case 'action': {
          const label = ctx === 'fav' ? '🗑' : '🗑 删除';
          return '<button type="button" class="btn-icon act-btn" data-action="remove" data-code="' + esc(s.code) + '">' + label + '</button>';
        }
        default: return '—';
      }
    }
    /**
     * 数值列（右对齐）判定 —— 表头与单元格必须共用同一套规则。
     * 原先表头只对部分类型、且排除冻结列才加 num-col，而单元格 cellClass 对更多类型
     * （cap / curPrice / favGain 等）也加 num-cell，导致「表头靠左、数据靠右」，
     * 字段与数据不在同一条中轴线上。这里统一为一份定义。
     */
    const NUMERIC_COL_TYPES = ['pct', 'price', 'ratio', 'num2', 'num2pct', 'money', 'flow', 'int', 'diff', 'cap', 'curPrice', 'favGain', 'relevance'];
    function isNumCol(col) { return !!col && NUMERIC_COL_TYPES.indexOf(col.type) >= 0; }

    /** 单元格 class（冻结列 + 数值列 + 涨跌色 + 多行展示） */
    function cellClass(col, s, idx, list, ctx) {
      const cls = [];
      if (col.fixed) cls.push('col-sticky', 'col-sticky-' + col.fixedIndex);
      // 注意：'pos'(正数统计) 是冻结列且与表头一样居中展示，不能加 num-cell（右对齐），
      // 否则会出现「表头居中、内容靠右」的错位
      if (isNumCol(col)) cls.push('num-cell');
      if (col.type === 'mainbiz') cls.push('mainbiz-cell');
      if (col.type === 'concept') cls.push('concept-cell');
      if (col.type === 'pct') cls.push(pctClass(poolVal(s, col.key)));
      if (col.type === 'favGain') cls.push(pctClass(favGainPct(s)));
      if (col.type === 'flow') cls.push(numClass(s[col.key]));
      return cls.join(' ');
    }

    // 排序状态：favSort 在此声明；SORT_STATES 延后到各表排序状态都声明之后定义（见下方 col-resize 段落）
    const favSort = reactive({ key: '', dir: 'desc' });
    function onStockSort(col, ctx) {
      if (!col.sortable) return;
      const st = SORT_STATES[ctx];
      if (!st) return;
      if (st.key === col.key) st.dir = st.dir === 'asc' ? 'desc' : 'asc';
      else { st.key = col.key; st.dir = 'desc'; }
    }
    function stockSortIcon(col, ctx) {
      const st = SORT_STATES[ctx];
      if (!st || st.key !== col.key) return '⇅';
      return st.dir === 'asc' ? '↑' : '↓';
    }
    /** 表格点击委托：收藏/删除按钮 */
    function onTableClick(event, ctx, rows) {
      const t = event.target.closest('[data-action]');
      if (!t) return;
      const action = t.getAttribute('data-action');
      const code = t.getAttribute('data-code');
      if (!code) return;
      if (action === 'fav') {
        const s = (rows || []).find(x => x.code === code) || { code: code, name: t.getAttribute('data-name') || code };
        toggleFavorite(s);
      } else if (action === 'remove') {
        if (ctx === 'fav') removeFavorite(code);
        else if (ctx === 'pool') removePoolStock(code);
        else if (ctx === 'sector') removeSectorStock(code);
        else if (ctx === 'filter') removeFilterStock(code);
        else if (ctx === 'hot') removeHotStock(code);
      }
    }
    /** 表格 change 委托：备注输入 */
    function onTableChange(event, ctx) {
      const t = event.target.closest('[data-action="note"]');
      if (!t) return;
      const id = t.getAttribute('data-id');
      const note = t.value;
      const fav = (D.favorites || []).find(f => f.id === id);
      if (fav) updateFavNote(fav, note);
    }

    /** 取股票池详情某列的排序值（含计算字段 市净比/市扣比/市营比/同比/环比系列、散户差额、正数统计） */
    function poolVal(s, key) {
      if (key === 'positiveCount') return positiveCount(s);
      if (key === 'pbRatio' || key === 'pkRatio' || key === 'pyRatio' || key === 'pk2Ratio' || key === 'phRatio' || key === 'prRatio' || key === 'prrRatio' || key === 'ph2Ratio' || key === 'pkHbRatio') {
        const r = sRatio(s);
        return r[key];
      }
      if (key === 'shareholderDiff') {
        return (s.shareholderCount != null && s.prevShareholderCount != null)
          ? +(s.shareholderCount - s.prevShareholderCount) : null;
      }
      // 距今年最高/最低价的涨跌幅（%，现价相对今年高低价）
      if (key === 'distToYearHigh') {
        return (s.todayPrice && s.yearHighPrice)
          ? +(((s.todayPrice - s.yearHighPrice) / s.yearHighPrice) * 100).toFixed(2) : null;
      }
      if (key === 'distToYearLow') {
        return (s.todayPrice && s.yearLowPrice)
          ? +(((s.todayPrice - s.yearLowPrice) / s.yearLowPrice) * 100).toFixed(2) : null;
      }
      // 距高天 / 距低天：今年最高价 / 最低价当天，距离今天的自然日数（无极值日期时为 null）
      if (key === 'yearHighDays') return daysFromDate(s.yearHighDate);
      if (key === 'yearLowDays') return daysFromDate(s.yearLowDate);
      return s[key];
    }

    /**
     * 通用排序比较：字符串按 localeCompare，数值按 parseFloat，
     * 空值（null/undefined/NaN/空串）始终排最后。
     * @returns 负数/0/正数（未乘方向，调用方需乘 dir）
     */
    function compareForSort(a, b, key) {
      const va = poolVal(a, key);
      const vb = poolVal(b, key);
      const na = va == null || va === '' || isNaN(parseFloat(va));
      const nb = vb == null || vb === '' || isNaN(parseFloat(vb));
      if (na && nb) return 0;
      if (na) return 1;
      if (nb) return -1;
      if (typeof va === 'string' || typeof vb === 'string') {
        return String(va).localeCompare(String(vb), 'zh-Hans-CN');
      }
      return parseFloat(va) - parseFloat(vb);
    }

    const sortedPoolDetailStocks = computed(() => {
      const list = [...(poolDetail.data.stocks || [])];
      const k = poolDetailSort.key;
      const dir = poolDetailSort.dir === 'asc' ? 1 : -1;
      list.sort((a, b) => compareForSort(a, b, k) * dir);
      return list;
    });
    function sortPoolDetailBy(key) {
      if (poolDetailSort.key === key) {
        poolDetailSort.dir = poolDetailSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        poolDetailSort.key = key;
        poolDetailSort.dir = 'desc';
      }
    }
    function poolSortIcon(key) {
      if (poolDetailSort.key !== key) return '⇅';
      return poolDetailSort.dir === 'asc' ? '↑' : '↓';
    }

    // ============================================================
    //  页面2.5：概念行业选股
    // ============================================================
    const sectorSearch = ref('');        // 搜索框
    const sectorResults = ref([]);       // 搜索结果
    // 搜索结果按「主行业概念（行业板块）＋ 多个次行业概念（概念板块）」分组（沿用板块自带 type 字段）
  const sectorResultsMain = computed(() => sectorResults.value.filter(s => s.type === '行业'));
  const sectorResultsSub = computed(() => sectorResults.value.filter(s => s.type === '概念'));
  const sectorResultsIdx = computed(() => sectorResults.value.filter(s => s.type === '指数'));
    const sectorSearching = ref(false);
    const sectorLoading = ref(false);    // 板块成分股加载中
    const sectorIndustryOpen = ref(false); // 板块详情内「行业」勾选下拉是否展开
    const sectorDetail = reactive({ show: false, data: { stocks: [] }, nameEdit: false, nameDraft: '' });
    const sectorDetailSort = reactive({ key: 'dailyChange', dir: 'desc' });
    // 板块详情：筛选栏与「字段含义」说明的一键收起/展开（收起以显示更多股票内容）
    const sectorFilterOpen = ref(true);
    // 字段含义与计算规则默认收起，把纵向空间让给个股列表（可一键展开查看）
    const sectorInfoOpen = ref(false);
    // 其余各页/弹窗的「字段含义与计算规则」同样默认隐藏，统一由「刷新行情」左侧的按钮一键切换
    const favInfoOpen = ref(false);
    const filterInfoOpen = ref(false);
    const poolInfoOpen = ref(false);
    // 勾选弹窗状态：选择板块成分股时使用
    const sectorPick = reactive({
      show: false, loading: false, name: '', bk: '', type: '', stocks: [], selected: {},
      // 筛选：去除301/688/北交所/ST；industry='' 表示不限行业
      filter: { no301: false, no688: false, noBj: false, noST: false, industry: '' },
      industryLoading: false,   // 是否正在补全行业字段
      industryDone: false       // 本次弹窗是否已尝试补全过行业
    });
    // 板块列表加载失败标志（用于显示重试/加载全部）
    const sectorLoadError = ref(false);
    const sectorLoadingAll = ref(false);

    // ===== AI 语义选股（自然语言 → 概念交叉 → 核心标的） =====
    const semantic = reactive({
      searching: false,
      error: '',
      query: '',
      concepts: [],
      modifiers: [],
      method: '',       // 'product' | 'revenue' | 'boards' | 'empty'
      productKey: '',
      productDesc: '',
      boards: [],       // 命中的板块（用于透明展示）
      stocks: [],       // 结果股票列表
      matchers: [],     // 营收占比相关度的主营段名匹配词（重算时回传，保持业务意图）
      done: false,
      saved: false,     // 是否已保存到我的板块
      recomputing: false // 编辑概念/板块后正在按条件重算
    });
    async function semanticSearch() {
      const q = String(sectorSearch.value || '').trim();
      if (!q) { showToast('请输入语义描述，如：主营为ai安全的核心上市公司', 'error'); return; }
      semantic.searching = true;
      semantic.error = '';
      semantic.boards = [];
      semantic.stocks = [];
      semantic.done = false;
      semantic.saved = false;
      try {
        const res = await StockAPI.semanticSearch(q);
        if (!res.ok) {
          semantic.error = res.error || '解析失败';
          showToast(semantic.error, 'error');
        } else {
          semantic.query = res.query;
          semantic.concepts = res.concepts;
          semantic.modifiers = res.modifiers;
          semantic.method = res.method;
          semantic.productKey = res.productKey || '';
          semantic.productDesc = res.productDesc || '';
          semantic.boards = res.boards;
          semantic.stocks = res.stocks;
          semantic.matchers = res.matchers || [];
          semantic.done = true;
          const m = res.method === 'product' ? '产品级语义命中（产业链真实标的，营收占比相关度）'
            : res.method === 'boards' ? '按当前板块重算（营收占比相关度）'
            : res.method === 'revenue' ? '营收占比相关度（主营构成匹配）' : '空';
          showToast(`AI语义筛选完成：${m}，命中 ${res.stocks.length} 只`, 'success');
        }
      } catch (e) {
        semantic.error = 'AI语义筛选失败：' + (e && e.message ? e.message : e);
        showToast(semantic.error, 'error');
        console.warn('AI语义筛选失败', e);
      } finally {
        semantic.searching = false;
      }
    }
    // 把语义筛选结果保存为「我的概念选股板块」
    function saveSemanticAsPool() {
      if (!semantic.stocks.length) { showToast('暂无可保存的结果', 'error'); return; }
      if (semantic.saved) { showToast('该结果已保存', 'info'); return; }
      const conceptLabel = semantic.concepts.join('+') || '语义';
      const modLabel = semantic.modifiers.includes('核心') ? '(核心)' : '';
      const sector = {
        name: `AI语义:${conceptLabel}${modLabel}`,
        bk: 'SEMANTIC_' + Date.now(),
        type: 'AI语义',
        date: Store.today(),
        stocks: semantic.stocks.map(s => ({ code: s.code, name: s.name, relevance: s.relevance != null ? s.relevance : null }))
      };
      Store.addSectorPool(sector);
      recomputePoolAvg(sector);
      semantic.saved = true;
      showToast(`已保存板块「${sector.name}」共 ${sector.stocks.length} 只`, 'success');
    }

    // ===== 反推业务：输入一只股票，反推其主营构成的相关度与热度 =====
    const reverseSort = ref('relevance'); // 'relevance' | 'heat'
    const reverse = reactive({
      loading: false,
      error: '',
      input: '',
      name: '',
      code: '',
      segments: [],
      done: false,
      hotTheme: '',         // 固定首行概念名（反推后自动填入该股最火概念，可改）
      hotConcept: null,     // 固定首行的「该股最火概念」计算数据 {bk,name,corr,heat,boardNames}
      customName: '',       // 固定次行业务名（用户自行填写）
      industry: ''          // 反推个股所属细分行业（明细到最细层级，如「电力设备 / 其他电源设备Ⅱ / 综合电力设备商」）
    });
    function setReverseSort(k) { reverseSort.value = k; }
    // 自定义业务行的计算数据（与下方主营构成行口径完全一致：营收占比/相关度/热度=股票数/对应板块）
    const reverseCustom = reactive({ ratio: null, relevance: null, heat: null, boardNames: [] });
    watch(
      [() => reverse.customName, () => reverse.done, () => reverse.name],
      async () => {
        const cn = (reverse.customName || '').trim();
        if (!reverse.done || !cn) {
          reverseCustom.ratio = null; reverseCustom.relevance = null; reverseCustom.heat = null; reverseCustom.boardNames = [];
          return;
        }
        // 1) 优先匹配该股票已有的主营构成业务，直接复用其计算数据
        const m = (reverse.segments || []).find(s => s.name && (s.name === cn || s.name.includes(cn) || cn.includes(s.name)));
        if (m) {
          reverseCustom.ratio = m.ratio; reverseCustom.relevance = m.relevance; reverseCustom.heat = m.heat; reverseCustom.boardNames = m.boardNames || [];
          return;
        }
        // 2) 否则按业务名解析东财板块，取成分股数作为热度（股票数）
        try {
          const boards = await StockAPI.searchSectors(cn);
          if (boards && boards.length) {
            const cnt = await StockAPI.getSectorStockCount(boards[0].code);
            reverseCustom.heat = cnt || null;
            reverseCustom.boardNames = [boards[0].name];
          } else {
            reverseCustom.heat = null; reverseCustom.boardNames = [];
          }
        } catch (e) {
          reverseCustom.heat = null; reverseCustom.boardNames = [];
        }
        reverseCustom.ratio = null; reverseCustom.relevance = null;
      }
    );
    const reverseSorted = computed(() => {
      const segs = reverse.segments || [];
      const rows = [];
      // ① 固定首行：该股最火概念（标签在股票名称列）
      //    数据取自「与个股日收益率联动最强(相关系数最高)的概念板块」：
      //    营收占比不适用(显示—)，相关度=联动强度(corr%)，热度=该概念板块成分股数。
      const hc = reverse.hotConcept;
      if (hc && hc.name) {
        rows.push({
          type: 'hot',
          name: (reverse.hotTheme || '').trim() || hc.name,
          ratio: null,
          relevance: (hc.corr != null) ? hc.corr : null,
          heat: hc.heat || null,
          boardNames: hc.boardNames || [hc.name]
        });
      } else {
        // 回退口径：主营构成中热度(同业公司数)最高的业务段
        const byHeat = [...segs].sort((a, b) => (b.heat || 0) - (a.heat || 0) || (b.relevance || 0) - (a.relevance || 0));
        let hotSeg = byHeat[0] || null;
        const htName = (reverse.hotTheme || '').trim();
        if (htName && hotSeg) {
          const m = segs.find(s => s.name && (s.name === htName || s.name.includes(htName) || htName.includes(s.name)));
          if (m) hotSeg = m;
        }
        rows.push({
          type: 'hot',
          name: htName || (hotSeg ? hotSeg.name : ''),
          ratio: hotSeg ? hotSeg.ratio : null,
          relevance: hotSeg ? hotSeg.relevance : null,
          heat: hotSeg ? hotSeg.heat : null,
          boardNames: hotSeg ? (hotSeg.boardNames || []) : []
        });
      }
      // ② 固定次行：自定义业务（名称可填，数据口径与下方一致）
      rows.push({
        type: 'custom',
        name: (reverse.customName || '').trim(),
        ratio: reverseCustom.ratio,
        relevance: reverseCustom.relevance,
        heat: reverseCustom.heat,
        boardNames: reverseCustom.boardNames
      });
      // 正常业务结果（排除已固定在首行的主营构成段，避免重复）
      let below = segs;
      if (hc && hc.bk) {
        // 若最火概念恰好命中某主营构成段，下方不再重复列出该段
        const hit = segs.find(s => (s.boardCodes || []).includes(hc.bk));
        if (hit) below = segs.filter(s => s !== hit);
      }
      if (reverseSort.value === 'heat') {
        below.sort((a, b) => (b.heat || 0) - (a.heat || 0) || (b.relevance || 0) - (a.relevance || 0));
      } else {
        below.sort((a, b) => (b.relevance || 0) - (a.relevance || 0) || (b.heat || 0) - (a.heat || 0));
      }
      below.forEach(s => rows.push({ type: 'seg', ...s }));
      return rows;
    });
    async function reverseBusiness() {
      const v = String(reverse.input || '').trim();
      if (!v) { showToast('请输入股票代码或名称，如：掌阅科技 / 603533', 'error'); return; }
      reverse.loading = true; reverse.error = ''; reverse.done = false; reverse.segments = []; reverse.industry = '';
      try {
        const res = await StockAPI.reverseBusiness(v);
        if (!res.ok) {
          reverse.error = res.error || '反推失败';
          showToast(reverse.error, 'error');
        } else {
          reverse.name = res.name; reverse.code = res.code; reverse.segments = res.segments; reverse.hotTheme = res.hotBusiness || ''; reverse.hotConcept = res.hotConcept || null; reverse.done = true;
          reverse.industry = '';
          // 异步补全细分行业（best-effort，不阻塞结果展示）
          try {
            const ind = await StockAPI.getIndustryDetail(res.code);
            if (ind) reverse.industry = ind;
          } catch (e) { console.debug('反推业务细分行业获取失败', res.code, e); }
          showToast(`反推完成：${res.name} 共 ${res.segments.length} 项主营构成`, 'success');
        }
      } catch (e) {
        reverse.error = '反推业务失败：' + (e && e.message ? e.message : e);
        showToast(reverse.error, 'error');
        console.warn('反推业务失败', e);
      } finally {
        reverse.loading = false;
      }
    }
    function reverseSortIcon(k) { return reverseSort.value === k ? '⬇️' : '↕️'; }

    // 用户编辑语义结果后，允许重新保存
    function markSemanticDirty() { semantic.saved = false; }

    // ===== 语义结果「重算引擎」：概念/板块是选股条件，股票列表由它们推导 =====

    // 根据当前概念列表，重新解析出对应的板块集合（替换 semantic.boards）
    async function rebuildBoardsFromConcepts() {
      const resolved = [];
      for (const c of semantic.concepts) {
        const bs = await StockAPI.resolveConceptToBoards(c);
        resolved.push(...bs);
      }
      const map = new Map();
      for (const b of resolved) if (!map.has(b.bk)) map.set(b.bk, b);
      semantic.boards = [...map.values()];
    }

    // 用当前板块 + 修饰词重算符合语义的上市公司
    async function recomputeSemanticStocks() {
      if (!semantic.boards.length) {
        semantic.stocks = [];
        if (semantic.method !== 'product') semantic.method = 'empty';
        semantic.recomputing = false;
        markSemanticDirty();
        showToast('当前没有命中板块，无法重算；请先添加板块或在概念里补充主题', 'info');
        return;
      }
      semantic.recomputing = true;
      try {
        const res = await StockAPI.recomputeSemanticStocks({
          boards: semantic.boards.map(b => ({ bk: b.bk, name: b.name })),
          modifiers: semantic.modifiers,
          concepts: semantic.concepts,
          matchers: semantic.matchers
        });
        semantic.stocks = res.stocks;
        semantic.method = res.method;
        semantic.saved = false;
        const m = res.method === 'intersect' ? '概念交集（同时归属这些板块的公司）'
          : res.method === 'union' ? '概念并集（无完全交集，已展示并集）'
          : res.method === 'single' ? '单板块' : (res.method === 'boards' ? '按当前板块重算（营收占比相关度）' : '空');
        showToast(`已按当前条件重算：${m}，命中 ${res.stocks.length} 只`, 'success');
      } catch (e) {
        showToast('重算失败：' + (e && e.message ? e.message : e), 'error');
        console.warn('语义重算失败', e);
      } finally {
        semantic.recomputing = false;
      }
    }

    // 概念变化：重建板块并立刻重算
    async function onConceptChanged() {
      if (semantic.method === 'product') { markSemanticDirty(); return; } // 产品级结果由产业链库定义，概念仅作标签
      await rebuildBoardsFromConcepts();
      await recomputeSemanticStocks();
    }
    // 板块变化：直接用当前板块重算
    async function onBoardChanged() {
      await recomputeSemanticStocks();
    }

    // ===== 语义结果 增删改：识别概念 =====
    const editingConceptIdx = ref(-1);
    const conceptDraft = ref('');
    const newConceptText = ref('');
    function startEditConcept(i) { editingConceptIdx.value = i; conceptDraft.value = semantic.concepts[i] || ''; }
    async function commitEditConcept() {
      const i = editingConceptIdx.value; const v = conceptDraft.value.trim();
      if (i >= 0 && v) semantic.concepts[i] = v;
      editingConceptIdx.value = -1;
      await onConceptChanged();
    }
    function cancelEditConcept() { editingConceptIdx.value = -1; }
    async function removeConcept(i) { if (i >= 0) semantic.concepts.splice(i, 1); await onConceptChanged(); }
    async function addConcept() {
      const v = newConceptText.value.trim(); if (v) { semantic.concepts.push(v); newConceptText.value = ''; await onConceptChanged(); }
    }

    // ===== 语义结果 增删改：命中板块 =====
    const editingBoardIdx = ref(-1);
    const boardDraft = ref('');
    const boardAddKw = ref('');
    const boardAddMatches = ref([]);
    const boardAdding = ref(false);
    function startEditBoard(i) { editingBoardIdx.value = i; boardDraft.value = semantic.boards[i] ? (semantic.boards[i].name || '') : ''; }
    async function commitEditBoard() {
      const i = editingBoardIdx.value; const v = boardDraft.value.trim();
      if (i >= 0 && semantic.boards[i]) semantic.boards[i].name = v;
      editingBoardIdx.value = -1;
      await onBoardChanged();
    }
    function cancelEditBoard() { editingBoardIdx.value = -1; }
    async function removeBoard(i) { if (i >= 0) semantic.boards.splice(i, 1); await onBoardChanged(); }
    async function searchBoardForAdd() {
      const kw = boardAddKw.value.trim(); if (!kw) { boardAddMatches.value = []; return; }
      boardAdding.value = true;
      try {
        const all = await StockAPI.getAllSectors();
        const k = kw.toLowerCase();
        boardAddMatches.value = all.filter(b => String(b.name || '').toLowerCase().includes(k)).slice(0, 8);
      } catch (e) { boardAddMatches.value = []; }
      finally { boardAdding.value = false; }
    }
    async function addBoard(b) {
      if (!b) return;
      semantic.boards.push({ bk: b.bk, name: b.name });
      boardAddMatches.value = []; boardAddKw.value = '';
      await onBoardChanged();
    }

    // ===== 语义结果 增删改：筛选出的股票 =====
    const editingStockCode = ref('');
    const stockNameDraft = ref('');
    const stockRoleDraft = ref('');
    const stockConceptsDraft = ref('');
    const stockAddCode = ref('');
    const stockAdding = ref(false);
    function startEditStock(s) {
      editingStockCode.value = s.code; stockNameDraft.value = s.name || '';
      stockRoleDraft.value = s.role || ''; stockConceptsDraft.value = (s.concepts || []).join(',');
    }
    function commitEditStock() {
      const s = semantic.stocks.find(x => x.code === editingStockCode.value);
      if (s) {
        s.name = stockNameDraft.value.trim() || s.name;
        s.role = stockRoleDraft.value.trim();
        s.concepts = (stockConceptsDraft.value || '').split(/[,，]/).map(t => t.trim()).filter(Boolean);
      }
      editingStockCode.value = ''; markSemanticDirty();
    }
    function cancelEditStock() { editingStockCode.value = ''; }
    function removeStock(code) {
      const i = semantic.stocks.findIndex(x => x.code === code);
      if (i >= 0) semantic.stocks.splice(i, 1); markSemanticDirty();
    }
    async function addStockByCode() {
      const raw = stockAddCode.value.trim();
      if (!raw) { showToast('请输入股票代码', 'error'); return; }
      const code = StockAPI.inferPrefix(raw);
      stockAdding.value = true;
      try {
        const q = await StockAPI.getQuotes([code]);
        const info = (q && q[code]) || {};
        const name = info.name || raw.toUpperCase();
        semantic.stocks.push({
          code, name,
          price: info.price != null ? info.price : null,
          changePercent: info.changePercent != null ? info.changePercent : null,
          marketCap: info.totalMarketCap != null ? info.totalMarketCap * 1e8 : null,
          role: '手动添加',
          concepts: semantic.concepts.slice(),
          relevance: null
        });
        stockAddCode.value = '';
        showToast('已添加 ' + name, 'success');
        markSemanticDirty();
      } catch (e) {
        showToast('添加失败：' + (e && e.message ? e.message : e), 'error');
      } finally { stockAdding.value = false; }
    }

    // 已保存板块顺序：一旦用户拖动过卡片（所有板块都有显式 order），就按 order 升序；
    // 否则沿用旧的「按创建时间倒序」（新板块在最前），保证老数据的观感不变。
    const sortedSectorPools = computed(() => {
      const list = [...D.sectorPools];
      const ordered = list.length > 0 && list.every(p => typeof p.order === 'number' && isFinite(p.order));
      if (ordered) return list.sort((a, b) => a.order - b.order);
      return list
        .map((p, i) => ({ p, i }))
        .sort((a, b) => ((b.p.createdAt || 0) - (a.p.createdAt || 0)) || (b.i - a.i))
        .map(x => x.p);
    });

    // ===== 板块卡片拖动排序 =====
    const poolDragId = ref('');     // 正在拖动的板块 id
    const poolDropId = ref('');     // 当前落点板块 id（用于高亮插入位置）
    let _poolDragged = false;       // 本次是否真的拖动过（用于拖完不误触发「打开详情」）

    /** 当前展示顺序固化为每个板块的 order 字段（持久化） */
    function _writePoolOrder(list) {
      list.forEach((p, i) => { p.order = i; });
    }
    function onPoolDragStart(pool, e) {
      if (sectorSubKeyword.value.trim()) {
        // 筛选状态下只能看到部分板块，拖动会导致顺序错乱，直接拦掉并说清原因
        showToast('子版块筛选状态下无法拖动排序，请先「✕ 清除筛选」', 'error');
        if (e && e.preventDefault) e.preventDefault();
        return;
      }
      _poolDragged = false;
      poolDragId.value = pool.id;
      if (e && e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', String(pool.id)); } catch (err) { /* 忽略 */ }
      }
    }
    function onPoolDragOver(pool) {
      if (!poolDragId.value || poolDragId.value === pool.id) return;
      _poolDragged = true;
      poolDropId.value = pool.id;
    }
    function onPoolDragEnd() {
      poolDragId.value = '';
      poolDropId.value = '';
      // 延迟复位，避免紧随其后的 click 把「打开详情」触发出来
      setTimeout(() => { _poolDragged = false; }, 60);
    }
    function onPoolDrop(pool) {
      const fromId = poolDragId.value;
      poolDragId.value = '';
      poolDropId.value = '';
      if (!fromId || fromId === pool.id) return;
      const list = sortedSectorPools.value.slice();   // 以当前展示顺序为基准
      const from = list.findIndex(p => p.id === fromId);
      const to = list.findIndex(p => p.id === pool.id);
      if (from === -1 || to === -1) return;
      const [moved] = list.splice(from, 1);
      list.splice(to, 0, moved);
      _writePoolOrder(list);
      showToast(`已调整顺序：「${moved.name || '未命名板块'}」移到第 ${to + 1} 位`, 'success');
    }
    /** 点击卡片打开详情（拖动后不触发，避免「拖一下就弹窗」） */
    function openPoolCard(pool) {
      if (_poolDragged) return;
      openSectorDetail(pool);
    }
    /** 恢复为默认顺序（按创建时间倒序） */
    function resetPoolOrder() {
      D.sectorPools.forEach(p => { delete p.order; });
      showToast('已恢复默认顺序（按创建时间倒序）', 'success');
    }

    // ===== 「我的概念选股板块」一键刷新（只刷新当日涨跌） =====
    const sectorPoolsRefreshing = ref(false);
    /**
     * 一键刷新：只刷新各板块成分股的「当日涨跌幅」（顺带更新现价以便重算平均涨跌幅），
     * 不拉取财务、股东户数、历史价等字段——目的就是快速看板块内当天谁在涨。
     * 代码数量多时按 60 只一批，避免单次 URL 过长被源站拒绝。
     */
    async function refreshSectorPoolsDailyChange() {
      const pools = sortedSectorPools.value;
      if (!pools.length) { showToast('暂无概念选股板块', 'error'); return; }
      if (sectorPoolsRefreshing.value) return;
      const codes = [];
      const seen = new Set();
      pools.forEach(p => (p.stocks || []).forEach(s => {
        if (s.code && !seen.has(s.code)) { seen.add(s.code); codes.push(s.code); }
      }));
      if (!codes.length) { showToast('板块内暂无股票', 'error'); return; }
      sectorPoolsRefreshing.value = true;
      showToast(`正在刷新 ${codes.length} 只股票的当日涨跌...`, 'info');
      try {
        const quotes = {};
        const BATCH = 60;
        for (let i = 0; i < codes.length; i += BATCH) {
          const batch = codes.slice(i, i + BATCH);
          try { Object.assign(quotes, (await StockAPI.getQuotes(batch)) || {}); }
          catch (e) { console.warn('批量行情获取失败', i, e); }
        }
        let hit = 0;
        pools.forEach(pool => {
          (pool.stocks || []).forEach(s => {
            const q = quotes[s.code];
            if (!q) return;
            if (q.changePercent != null && !isNaN(q.changePercent)) { s.dailyChange = q.changePercent; hit++; }
            if (q.price != null) s.todayPrice = q.price;
          });
          recomputePoolAvg(pool);
        });
        if (!hit) showToast('未取到行情（可能受网络限制），请稍后重试', 'error');
        else showToast(`已刷新 ${hit} 只股票的当日涨跌（其余字段未改动）`, 'success');
      } finally {
        sectorPoolsRefreshing.value = false;
      }
    }

    // 子版块搜索：在「我的概念选股板块」列表中，按名称关键字过滤已保存板块（空关键词=不筛选）
    const sectorSubKeyword = ref('');
    const filteredSectorPools = computed(() => {
      const kw = sectorSubKeyword.value.trim();
      if (!kw) return sortedSectorPools.value;
      return sortedSectorPools.value.filter(p => String(p.name || '').includes(kw));
    });
    function searchSubSectors() {
      const kw = String(sectorSearch.value || '').trim();
      if (!kw) {
        if (sectorSubKeyword.value) {
          sectorSubKeyword.value = '';
          showToast('已取消子版块筛选', 'info');
        } else {
          showToast('请先输入板块名称关键字', 'error');
        }
        return;
      }
      sectorSubKeyword.value = kw;
      const n = filteredSectorPools.value.length;
      if (n) showToast(`子版块筛选「${kw}」：命中 ${n} 个板块`, 'success');
      else showToast(`未找到名称含「${kw}」的子板块`, 'info');
    }
    function clearSubSectorSearch() {
      sectorSubKeyword.value = '';
      showToast('已取消子版块筛选', 'info');
    }

    // 搜索板块（防抖由模板 @input 触发，这里直接调用）
    async function searchSector() {
      const kw = sectorSearch.value.trim();
      if (!kw) { sectorResults.value = []; return; }
      sectorSearching.value = true;
      sectorLoadError.value = false;
      try {
        const all = await StockAPI.getAllSectors(false);
        if (!all.length) {
          sectorResults.value = [];
          sectorLoadError.value = true;
          showToast('板块数据加载失败，请检查网络后重试', 'error');
        } else {
          sectorResults.value = await StockAPI.searchSectors(kw);
          if (!sectorResults.value.length) {
            showToast(`未找到「${kw}」相关板块，可尝试「加载全部板块」`, 'info');
          }
        }
      } catch (e) {
        sectorResults.value = [];
        sectorLoadError.value = true;
        showToast('板块加载失败，请重试', 'error');
        console.warn('板块搜索失败', e);
      } finally {
        sectorSearching.value = false;
      }
    }

    // 强制重新加载板块列表（清除缓存）
    async function reloadSectors() {
      StockAPI._sectorCache = null;
      StockAPI._sectorCacheAt = 0;
      await searchSector();
    }

    // 顶部「刷新数据」：清除板块缓存后重新拉取（有搜索词按词刷新，否则加载全部板块）
    async function refreshSectorData() {
      StockAPI._sectorCache = null;
      StockAPI._sectorCacheAt = 0;
      if (sectorSearch.value.trim()) {
        await searchSector();
      } else {
        await loadAllSectors();
      }
    }

    // 加载全部板块（分页更多，用于搜索冷门概念）
    async function loadAllSectors() {
      sectorLoadingAll.value = true;
      sectorLoadError.value = false;
      showToast('正在加载全部板块（约1000个），可能需要几秒...', 'info');
      try {
        await StockAPI.getAllSectors(true);
        showToast('已加载全部板块', 'success');
        await searchSector();
      } catch (e) {
        sectorLoadError.value = true;
        showToast('全部板块加载失败，请重试', 'error');
        console.warn('加载全部板块失败', e);
      } finally {
        sectorLoadingAll.value = false;
      }
    }

    // 已选概念：主选板块 + 次选概念列表（用于交集筛选）
    const sectorSel = reactive({ main: null, subs: [] });
    const sectorSelIntersecting = ref(false);
    const sectorSelError = ref('');
    // 已选概念总数（主选+次选）
    const sectorSelCount = computed(() => (sectorSel.main ? 1 : 0) + sectorSel.subs.length);

    // 点击搜索结果板块：设为主选；无次选时直接加载成分股弹出勾选弹窗，有次选时引导交集筛选
    async function addSectorFromSearch(item) {
      // 查重：同名板块已存在则提示
      if (D.sectorPools.some(p => p.bk === item.bk)) {
        showToast('该板块已在列表中', 'info');
        return;
      }
      sectorSel.main = { bk: item.bk, name: item.name, type: item.type || '' };
      if (!sectorSel.subs.length) {
        // 无次选：直接打开单板块勾选弹窗
        await openSectorSelPick(sectorSel.main);
      } else {
        showToast(`已设「${item.name}」为主选，点击「开始交集筛选」得到交集`, 'info');
      }
    }

    // 把搜索项加入次选概念列表（查重，最多支持多个）
    function addSubSector(item) {
      if (sectorSel.subs.some(s => s.bk === item.bk)) {
        showToast(`「${item.name}」已在次选概念中`, 'info');
        return;
      }
      sectorSel.subs.push({ bk: item.bk, name: item.name, type: item.type || '' });
      showToast(`已加入次选概念：${item.name}`, 'success');
    }
    function removeSubSector(bk) {
      const i = sectorSel.subs.findIndex(s => s.bk === bk);
      if (i >= 0) sectorSel.subs.splice(i, 1);
    }
    function clearSectorSel() {
      sectorSel.main = null;
      sectorSel.subs = [];
      sectorSelError.value = '';
    }

    // 把一组板块成分股合并并取交集（同时属于所有板块的股票）
    async function _loadIntersectPick(blocks) {
      sectorPick.show = true;
      sectorPick.loading = true;
      sectorPick.stocks = [];
      sectorPick.selected = {};
      sectorPick.bk = '';
      sectorPick.filter.industry = '';      // 切换板块时重置行业筛选
      sectorPick.industryDone = false;
      const names = blocks.map(b => b.name).join(' ∩ ');
      sectorPick.name = names;
      sectorPick.type = '交集筛选';
      try {
        // 并行加载各板块成分股
        const results = await Promise.all(blocks.map(b => StockAPI.getSectorStocks(b.bk)));
        if (results.some(r => !r.length)) {
          showToast('部分板块未获取到成分股', 'error');
          return;
        }
        // 统计每只股票出现的板块数
        const codeCount = {};
        results.forEach(list => {
          list.forEach(s => {
            const c = String(s.code || '');
            if (c) codeCount[c] = (codeCount[c] || 0) + 1;
          });
        });
        const blockCount = blocks.length;
        // 取交集：出现在所有板块中的股票
        const common = [];
        const seen = {};
        results.forEach(list => {
          list.forEach(s => {
            const c = String(s.code || '');
            if (!c || seen[c]) return;
            seen[c] = true;
            if (codeCount[c] === blockCount) common.push(s);
          });
        });
        if (!common.length) {
          showToast(`未找到同时属于以上 ${blockCount} 个概念的股票（交集为空）`, 'error');
          return;
        }
        // 转成标准股票对象，默认全部勾选
        const list = common.map(s => {
          const ns = _newStock(s);
          ns.dailyChange = s.changePercent;
          ns.todayPrice = s.price;
          return ns;
        });
        sectorPick.stocks = list;
        list.forEach(s => { sectorPick.selected[s.code] = true; });
        loadSectorPickIndustries(true);   // 后台补全行业，供行业下拉筛选
        showToast(`交集筛选完成：${list.length} 只股票（同时属于 ${blockCount} 个概念）`, 'success');
      } catch (e) {
        console.warn('交集筛选失败', e);
        showToast('交集筛选失败，请重试', 'error');
      } finally {
        sectorPick.loading = false;
      }
    }

    // 打开某个已选概念的勾选弹窗（单板块）
    async function openSectorSelPick(block) {
      sectorPick.show = true;
      sectorPick.loading = true;
      sectorPick.sector = block;
      sectorPick.name = block.name;
      sectorPick.bk = block.bk;
      sectorPick.type = block.type || '';
      sectorPick.stocks = [];
      sectorPick.selected = {};
      sectorPick.filter.industry = '';      // 切换板块时重置行业筛选
      sectorPick.industryDone = false;
      showToast(`正在获取「${block.name}」成分股...`, 'info');
      try {
        const stocks = await StockAPI.getSectorStocks(block.bk);
        if (!stocks.length) { showToast('未获取到该板块成分股', 'error'); return; }
        const list = stocks.map(s => {
          const ns = _newStock(s);
          ns.dailyChange = s.changePercent;
          ns.todayPrice = s.price;
          return ns;
        });
        sectorPick.stocks = list;
        list.forEach(s => { sectorPick.selected[s.code] = true; });
        loadSectorPickIndustries(true);   // 后台补全行业，供行业下拉筛选
        showToast(`已加载 ${list.length} 只成分股，默认全选`, 'success');
      } catch (e) {
        console.warn('成分股获取失败', e);
        showToast('成分股获取失败，请重试', 'error');
      } finally {
        sectorPick.loading = false;
      }
    }

    // 开始交集筛选：主选 + 所有次选概念的成分股取交集
    async function startIntersectFilter() {
      const blocks = [];
      if (sectorSel.main) blocks.push(sectorSel.main);
      sectorSel.subs.forEach(s => blocks.push(s));
      if (blocks.length < 2) {
        showToast('交集筛选需要至少主选 + 1 个次选概念', 'error');
        return;
      }
      sectorSelIntersecting.value = true;
      sectorSelError.value = '';
      try {
        await _loadIntersectPick(blocks);
      } catch (e) {
        sectorSelError.value = '交集筛选失败，请稍后重试';
        console.warn('交集筛选异常', e);
      } finally {
        sectorSelIntersecting.value = false;
      }
    }

    // 全选 / 全不选
    function toggleSelectAllSector() {
      const stocks = visibleSectorPickStocks.value;
      if (!stocks.length) return;
      const allSel = stocks.every(s => sectorPick.selected[s.code]);
      stocks.forEach(s => { sectorPick.selected[s.code] = !allSel; });
    }
    // 判断股票是否被某筛选规则排除
    function sectorPickFiltered(s) {
      // 代码可能带 sh/sz/bj 前缀，统一取纯数字后再匹配板块规则
      const code = String(pureCode(s.code) || '');
      const name = String(s.name || '');
      const f = sectorPick.filter;
      if (f.no301 && /^30[01]/.test(code)) return true;      // 创业板（300/301）
      if (f.no688 && /^688/.test(code)) return true;          // 科创板
      if (f.noBj && /^(4|8|92)/.test(code)) return true;      // 北交所（4/8/92开头）
      if (f.noST && /ST/i.test(name)) return true;            // ST/*ST
      if (f.industry && (s.industry || '未知') !== f.industry) return true; // 行业筛选
      return false;
    }
    /** 当前成分股涉及的全部行业（去重、中文排序），用于下拉选项 */
    const sectorPickIndustries = computed(() => {
      const set = new Set();
      sectorPick.stocks.forEach(s => set.add(s.industry || '未知'));
      return [...set].sort((a, b) => String(a).localeCompare(String(b), 'zh-CN'));
    });
    /** 已获取到真实行业（非「未知」）的股票数量 */
    const sectorPickIndustryLoaded = computed(() => {
      return sectorPick.stocks.filter(s => s.industry).length;
    });
    /** 异步补全缺失的行业字段（best-effort，不阻塞弹窗交互） */
    async function loadSectorPickIndustries(force) {
      if (sectorPick.industryLoading) return;
      const missing = sectorPick.stocks.filter(s => !s.industry && s.code);
      if (!missing.length) { sectorPick.industryDone = true; return; }
      if (!force && sectorPick.industryDone) return;
      sectorPick.industryLoading = true;
      try {
        const CONC = 4;   // 低并发，避免触发接口限流
        for (let i = 0; i < missing.length; i += CONC) {
          const batch = missing.slice(i, i + CONC);
          await Promise.all(batch.map(async s => {
            try {
              const ind = await StockAPI.getIndustry(s.code);
              if (ind) s.industry = ind;
            } catch (e) { /* 单只失败忽略 */ }
            try {
              if (!s.mainBusiness) {
                const mb = await StockAPI.getMainBusiness(s.code);
                if (mb) s.mainBusiness = mb;
              }
            } catch (e) { /* 单只失败忽略 */ }
          }));
        }
        sectorPick.industryDone = true;
      } finally {
        sectorPick.industryLoading = false;
      }
    }
    // 过滤后可见的成分股列表
    const visibleSectorPickStocks = computed(() => {
      return sectorPick.stocks.filter(s => !sectorPickFiltered(s));
    });
    // 已勾选数量（基于过滤后可见股票）
    const sectorPickCount = computed(() => {
      return visibleSectorPickStocks.value.filter(s => sectorPick.selected[s.code]).length;
    });

    // 确认保存勾选的股票到概念选股板块
    function confirmSectorPick() {
      const selected = visibleSectorPickStocks.value.filter(s => sectorPick.selected[s.code]);
      if (!selected.length) { showToast('请至少勾选一只股票', 'error'); return; }
      // 交集筛选场景 bk 为空，生成唯一标识，避免详情刷新时误调用真实板块接口
      const bk = sectorPick.bk || ('INTERSECT_' + Date.now());
      const sector = {
        name: sectorPick.name,
        bk: bk,
        type: sectorPick.type,
        date: Store.today(),
        stocks: selected
      };
      Store.addSectorPool(sector);
      recomputePoolAvg(sector);
      sectorPick.show = false;
      sectorPick.filter = { no301: false, no688: false, noBj: false, noST: false };
      sectorResults.value = [];
      sectorSearch.value = '';
      showToast(`已保存板块「${sectorPick.name}」共 ${selected.length} 只股票`, 'success');
    }

    // 拉取某板块全部成分股并填充
    async function loadSectorStocks(sector) {
      sectorLoading.value = true;
      try {
        const stocks = await StockAPI.getSectorStocks(sector.bk);
        if (!stocks.length) { showToast('未获取到该板块成分股', 'error'); return; }
        // 转成股票池标准股票对象
        const list = stocks.map(s => {
          const ns = _newStock(s);
          ns.dailyChange = s.changePercent;
          ns.todayPrice = s.price;
          return ns;
        });
        sector.stocks = list;
        recomputePoolAvg(sector);
        showToast(`已加载 ${list.length} 只成分股`, 'success');
      } catch (e) {
        console.warn('成分股获取失败', e);
        showToast('成分股获取失败，请重试', 'error');
      } finally {
        sectorLoading.value = false;
      }
    }

    // 刷新板块成分股的行情与财务数据
    async function refreshSectorDetail(sector) {
      // 若尚未获取到成分股，先重新拉取
      if (!sector.stocks || !sector.stocks.length) {
        await loadSectorStocks(sector);
        return;
      }
      await refreshPoolDetail(sector);
    }

    // 详情弹窗打开
    function openSectorDetail(sector) {
      sectorDetail.data = sector;
      sectorDetail.nameEdit = false;
      sectorDetail.nameDraft = sector.name || '';
      sectorDetail.show = true;
      // 打开新板块时重置详情内筛选区间（已固定则保留）
      if (!sectorFilter.locked) resetSectorFilter();
      // 【修复】概念行业选股页点击子版块后，「今年高价/距高价/今年低价/距低价/年涨跌/924涨跌」
      // 六个依赖历史价的字段长期空白。根因：热门板块在 openHotBoard 后会自动 await refreshHotStocks()
      // 补全历史价，而本页 openSectorDetail 仅打开弹窗、不触发任何补全，须用户手动点「刷新行情」。
      // 这里在打开时检测：若成分股尚未补全历史价（yearStartPrice/yearHighPrice/price924 缺失），
      // 自动触发 refreshSectorDetail → refreshPoolDetail 补全，体验与热门板块一致。
      // 已补全过则跳过，避免重复请求触发接口限流。
      if (sector.stocks && sector.stocks.length) {
        const needHist = sector.stocks.some(s =>
          s.yearStartPrice == null || s.yearHighPrice == null || s.price924 == null);
        if (needHist && autoRefreshPaused()) {
          // 暂停期间不自动补全，避免「打开弹窗」就偷偷发一堆请求；手动「刷新行情」仍可用
          pauseHint('板块详情历史价自动补全');
        } else if (needHist) {
          sectorLoading.value = true;
          refreshSectorDetail(sector)
            .catch(e => console.warn('板块详情历史价自动补全失败', sector.name, e))
            .finally(() => { sectorLoading.value = false; });
        }
      }
    }
    function startEditSectorName() {
      sectorDetail.nameDraft = sectorDetail.data.name || '';
      sectorDetail.nameEdit = true;
    }
    function saveSectorName() {
      sectorDetail.data.name = (sectorDetail.nameDraft || '').trim();
      sectorDetail.nameEdit = false;
      showToast('板块名称已更新', 'success');
    }
    function deleteSectorPool(id) {
      if (!confirm('确认删除该概念选股板块？')) return;
      Store.deleteSectorPool(id);
      showToast('已删除', 'success');
    }

    /** 取板块详情某列的排序值（含计算字段） */
    function sectorVal(s, key) {
      return poolVal(s, key);
    }
    const sortedSectorDetailStocks = computed(() => {
      const list = [...filteredSectorDetailStocks.value];
      const k = sectorDetailSort.key;
      const dir = sectorDetailSort.dir === 'asc' ? 1 : -1;
      list.sort((a, b) => compareForSort(a, b, k) * dir);
      return list;
    });
    /**
     * 板块详情内的独立筛选状态（字段与筛选板块的 filterPanel 一致，
     * 但不含「板块筛选」选择器——详情页本身已锁定在某个板块）。
     */
    const sectorFilter = reactive({
      locked: false,
      pbMin: null, pbMax: null,
      pkMin: null, pkMax: null,
      prMin: null, prMax: null,
      q24Min: null, q24Max: null,
      q24kMin: null, q24kMax: null,
      posMin: null, posMax: null,
      ratioFilter: false,
      industry: '',
      industries: []   // 行业多选勾选（与单选 industry 二选一，勾选优先）
    });
    /** 当前板块详情成分股涉及的全部行业（去重、中文排序），供行业下拉筛选 */
    const sectorDetailIndustries = computed(() => {
      const set = new Set();
      (sectorDetail.data.stocks || []).forEach(s => set.add(s.industry || '未知'));
      return [...set].sort((a, b) => String(a).localeCompare(String(b), 'zh-CN'));
    });
    function resetSectorFilter() {
      if (sectorFilter.locked) {
        showToast('板块详情筛选区间已固定，请先取消固定再重置', 'error');
        return;
      }
      sectorFilter.pbMin = null; sectorFilter.pbMax = null;
      sectorFilter.pkMin = null; sectorFilter.pkMax = null;
      sectorFilter.prMin = null; sectorFilter.prMax = null;
      sectorFilter.q24Min = null; sectorFilter.q24Max = null;
      sectorFilter.q24kMin = null; sectorFilter.q24kMax = null;
      sectorFilter.posMin = null; sectorFilter.posMax = null;
      sectorFilter.ratioFilter = false; sectorFilter.industry = ''; sectorFilter.industries = [];
    }
    function toggleSectorFilterLock() {
      sectorFilter.locked = !sectorFilter.locked;
      showToast(sectorFilter.locked ? '已固定板块详情筛选区间，切换板块/重置将保留' : '已取消固定板块详情筛选区间',
        sectorFilter.locked ? 'success' : 'info');
    }
    /** 板块详情内按筛选条件过滤后的成分股 */
    const filteredSectorDetailStocks = computed(() => {
      return (sectorDetail.data.stocks || []).filter(s => passFilter(s, sectorFilter));
    });
    function sortSectorDetailBy(key) {
      if (sectorDetailSort.key === key) {
        sectorDetailSort.dir = sectorDetailSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        sectorDetailSort.key = key;
        sectorDetailSort.dir = 'desc';
      }
    }
    function sectorSortIcon(key) {
      if (sectorDetailSort.key !== key) return '⇅';
      return sectorDetailSort.dir === 'asc' ? '↑' : '↓';
    }
    // 板块详情内删除个股（复用股票池删除逻辑）
    function removeSectorStock(code) {
      const sec = sectorDetail.data;
      const idx = (sec.stocks || []).findIndex(s => s.code === code);
      if (idx === -1) return;
      const name = sec.stocks[idx].name || code;
      if (!confirm(`确认从板块中删除「${name}」？`)) return;
      sec.stocks.splice(idx, 1);
      recomputePoolAvg(sec);
      showToast('已删除', 'success');
    }

    // ============================================================
    //  个股搜索添加（三处入口共用同一套逻辑）
    //    · sector：点击「我的概念选股板块」卡片 → 板块详情弹窗「字段含义」左侧
    //    · hot   ：热门板块页「当日股票明细」工具栏「字段含义」左侧
    //    · filter：筛选板块页工具栏「字段含义」左侧
    //  支持：直接输代码（600519 / sh600519）、输入名称联想搜索后点击添加、
    //        多只用逗号/分号/换行分隔；自动去重、自动补名称与当日行情。
    // ============================================================
    const MAX_SUGGESTED_STOCKS = 30;   // 单个板块建议上限（服务器资源有限）
    const quickAdd = reactive({
      sector: { text: '', loading: false, suggestions: [], open: false, timer: null },
      hot: { text: '', loading: false, suggestions: [], open: false, timer: null },
      filter: { text: '', loading: false, suggestions: [], open: false, timer: null }
    });

    /** 该入口当前要往哪个列表里加股票（热门明细与筛选板块都作用于「当前选中的来源」） */
    function quickAddTarget(scope) {
      if (scope === 'sector') return sectorDetail.data.stocks || [];
      const id = filterPanel.poolId;
      // 没选任何来源（例如刚进热门板块页、还没点板块）时返回 null，
      // 由调用方提示「请先选择板块」——否则会把股票加进一个当前不显示的列表里，用户以为没反应。
      if (!id) return null;
      if (id === 'hot') return hotFilterStocks.value || [];
      if (id.startsWith('s-')) {
        const sp = (D.sectorPools || []).find(p => 's-' + p.id === id);
        return sp ? (sp.stocks || []) : null;
      }
      if (id.startsWith('p-')) {
        const pp = (D.stockPools || []).find(p => 'p-' + p.id === id);
        return pp ? (pp.stocks || []) : null;
      }
      return null;
    }
    /** 该入口对应的「板块对象」（用于重算平均涨跌幅；热门板块成分股列表无归属对象，返回 null） */
    function quickAddTargetPool(scope) {
      if (scope === 'sector') return sectorDetail.data;
      const id = filterPanel.poolId;
      if (!id || id === 'hot') return null;
      if (id.startsWith('s-')) return (D.sectorPools || []).find(p => 's-' + p.id === id) || null;
      if (id.startsWith('p-')) return (D.stockPools || []).find(p => 'p-' + p.id === id) || null;
      return null;
    }
    /** 输入变化：代码直接留白，名称走腾讯联想（用户主动操作，不受「暂停刷新」影响） */
    function quickAddSearch(scope) {
      const st = quickAdd[scope];
      clearTimeout(st.timer);
      const kw = String(st.text || '').trim();
      if (!kw || /^(sh|sz|bj)?\d{4,8}$/i.test(kw)) {
        st.suggestions = []; st.open = false; return;
      }
      st.timer = setTimeout(async () => {
        try {
          const hints = await StockAPI.searchStocks(kw);
          st.suggestions = (hints || []).slice(0, 6);
        } catch (e) {
          st.suggestions = [];
        }
        st.open = st.suggestions.length > 0;
      }, 260);
    }
    function quickAddBlur(scope) {
      const st = quickAdd[scope];
      setTimeout(() => { st.open = false; }, 260);
    }
    /** 点击联想项 → 直接加入 */
    function quickAddPick(scope, item) {
      const st = quickAdd[scope];
      if (!item) return;
      st.open = false;
      st.text = '';
      quickAddCommit(scope, [{ code: item.code, name: item.name }]);
    }
    /** 真正写入列表（去重 + 补行情 + 重算平均涨跌幅） */
    async function quickAddCommit(scope, parsed) {
      const st = quickAdd[scope];
      const target = quickAddTarget(scope);
      if (!target) { showToast('请先选择板块（或先点击一个热门板块）再添加个股', 'error'); return; }
      const existing = new Set(target.map(s => s.code));
      const news = [];
      for (const p of (parsed || [])) {
        if (!p || !p.code || existing.has(p.code)) continue;
        news.push(_newStock({ code: p.code, name: p.name || '' }));
        existing.add(p.code);
      }
      if (!news.length) { showToast('未识别到新股票（输入为空或已在列表中）', 'info'); return; }
      st.loading = true;
      try {
        const quotes = await StockAPI.getQuotes(news.map(s => s.code));
        news.forEach(s => {
          const q = quotes[s.code];
          if (!q) return;
          s.name = s.name || q.name || '';
          if (q.changePercent != null) s.dailyChange = q.changePercent;
          if (q.amplitude != null) s.amplitude = q.amplitude;
          if (q.turnover != null) s.turnover = q.turnover;
          if (q.price != null) s.todayPrice = q.price;
          if (q.totalMarketCap) s.totalMarketCap = q.totalMarketCap;
        });
      } catch (e) {
        console.warn('添加个股时行情获取失败', e);
      }
      target.push(...news);
      const pool = quickAddTargetPool(scope);
      if (pool) recomputePoolAvg(pool);
      st.text = ''; st.suggestions = []; st.open = false;
      st.loading = false;
      if (target.length > MAX_SUGGESTED_STOCKS) {
        showToast(`已添加 ${news.length} 只；该板块现有 ${target.length} 只，建议不超过 ${MAX_SUGGESTED_STOCKS} 只（服务器资源有限）`, 'info');
      } else {
        showToast(`已添加 ${news.length} 只股票`, 'success');
      }
    }
    /** 回车 / 点「＋ 添加」：解析输入，名称走联想接口解析成代码后再写入 */
    async function quickAddSubmit(scope) {
      const st = quickAdd[scope];
      const txt = String(st.text || '').trim();
      if (!txt) { showToast('请输入股票代码或名称', 'error'); return; }
      if (!quickAddTarget(scope)) { showToast('请先选择板块（或先点击一个热门板块）再添加个股', 'error'); return; }
      const parsed = StockAPI.parseStockInput(txt);
      if (!parsed.length) { showToast('未识别到有效股票', 'error'); return; }
      const needResolve = parsed.filter(p => !p.code);
      if (needResolve.length) {
        showToast(`正在按名称匹配「${needResolve.map(p => p.name).join('、')}」...`, 'info');
        for (const p of needResolve) {
          try {
            const hints = await StockAPI.searchStocks(p.name);
            const hit = (hints || []).find(h => h.name === p.name) || (hints || [])[0];
            if (hit) { p.code = hit.code; p.name = hit.name; }
          } catch (e) { /* 忽略单只失败 */ }
        }
        const rest = parsed.filter(p => p.code);
        if (!rest.length) {
          showToast(`未找到股票「${needResolve.map(p => p.name).join('、')}」，请检查名称或直接输入代码`, 'error');
          return;
        }
        await quickAddCommit(scope, rest);
        return;
      }
      await quickAddCommit(scope, parsed);
    }

    // ============================================================
    //  页面3：热门板块
    // ============================================================
    const hotDate = ref(Store.today());
    const hotLoading = ref(false);
    const hotBoards = ref([]);
    const hotStocks = ref([]);
    const preMarketBoards = ref([]);
    const amplitudeBoards = ref([]);
    const ampLoading = ref(false);
    const hotPanelsHidden = ref(false);
    const financePushHidden = ref(false);
    const hotSort = reactive({ key: 'dailyChange', dir: 'desc' });
    // 全球信息页：火热话题（10 个金融软件热门消息）+ 美股美债行情
    const hotTopicsSources = ref([]);
    const hotTopicsMerged = ref([]);
    const hotTopicsLoading = ref(false);
    const hotTopicsUpdated = ref('');
    const usMarket = ref([]);
    // 火热话题：每日话题 / 统计分析
    const htTab = ref('daily');                 // 'daily' | 'analysis'
    const htMode = ref('live');                 // 'live' | 'history'
    const hotTopicDate = ref(fmtDate(new Date()));
    const hotTopicDateHasData = ref(false);
    const htCatFilter = ref('');
    const htCategories = (typeof HotTopics !== 'undefined') ? HotTopics.CATEGORIES : [];
    const htRangeOptions = [
      { key: '1d', label: '1天内', days: 1 },
      { key: '3d', label: '3天内', days: 3 },
      { key: '5d', label: '5天内', days: 5 },
      { key: '10d', label: '10天内', days: 10 },
      { key: '1m', label: '一月内', days: 30 }
    ];
    const analysisRange = ref('3d');
    const analysisLoading = ref(false);
    const analysisResult = ref(null);

    function catColor(c) {
      return (typeof HotTopics !== 'undefined' && HotTopics.CATEGORY_COLORS[c]) || '#6b7280';
    }
    function htSourceByRank(rank) {
      const list = (typeof HotTopics !== 'undefined' && HotTopics.SOURCE_ORDER) || [];
      return list.find(s => s.rank === rank) || { name: String(rank), color: '#888' };
    }
    function htSourceColor(rank) { return htSourceByRank(rank).color; }
    function htSourceName(rank) { return htSourceByRank(rank).name; }
    function ratioClass(n) { return n >= 8 ? 'hot' : (n >= 4 ? 'warm' : ''); }
    function fmtDate(d) {
      const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }
    function dateMinusDays(dateStr, n) {
      const d = new Date(dateStr + 'T00:00:00');
      d.setDate(d.getDate() - n);
      return fmtDate(d);
    }
    const filteredHotSources = computed(() => {
      const list = hotTopicsSources.value || [];
      if (!htCatFilter.value) return list.map(s => ({ ...s, filteredItems: s.items, filteredCount: s.items.length }));
      return list.map(s => {
        const fi = (s.items || []).filter(it => it.cat === htCatFilter.value);
        return { ...s, filteredItems: fi, filteredCount: fi.length };
      });
    });
    // 点击热门板块 4 个子版块后，成分股同时载入下方「筛选板块」列表（与 filterPanel.poolId='hot' 联动）
    const hotFilterStocks = ref([]);

    // 概念频次（从当日新闻统计）
    const conceptFreq = computed(() => {
      const list = D.news.filter(n => n.date === hotDate.value && n.conceptCategory);
      const map = {};
      for (const n of list) {
        // 概念分类可能含多个，按顿号/逗号分割
        const cats = n.conceptCategory.split(/[、,，/]/).map(s => s.trim()).filter(Boolean);
        for (const c of cats) map[c] = (map[c] || 0) + 1;
      }
      const arr = Object.entries(map).map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);
      const max = arr.length ? arr[0].count : 1;
      arr.forEach(c => { c.width = Math.max(8, (c.count / max) * 100); });
      return arr;
    });

    // 当日股票表（从当日新闻关联股票汇总，或手动加载）
    function loadHotData() {
      const daily = Store.getDailyStocks(hotDate.value);
      // 若该日无数据，自动从当日新闻关联股票生成
      if (!daily.stocks.length) {
        const dayNews = D.news.filter(n => n.date === hotDate.value);
        const stockMap = {};
        for (const n of dayNews) {
          const stocks = parseStocks(n.relatedStocks);
          for (const s of stocks) {
            if (s.code && !stockMap[s.code]) {
              stockMap[s.code] = { code: s.code, name: s.name, amplitude: null, dailyChange: null, news: n.content, category: n.category };
            }
          }
        }
        daily.stocks = Object.values(stockMap);
      }
      showToast(`已加载 ${hotDate.value} 的 ${daily.stocks.length} 只股票`, 'success');
      refreshHotStocks();
    }

    const sortedHotStocks = computed(() => {
      const daily = D.dailyData[hotDate.value];
      let list = daily ? [...daily.stocks] : [];
      // 股票查询：按代码 / 名称关键字过滤（两者同时填写时取交集）
      const codeQ = String(hotSearchCode.value || '').trim().toLowerCase();
      const nameQ = String(hotSearchName.value || '').trim().toLowerCase();
      if (codeQ) list = list.filter(s => String(s.code || '').toLowerCase().indexOf(codeQ) >= 0);
      if (nameQ) list = list.filter(s => String(s.name || '').toLowerCase().indexOf(nameQ) >= 0);
      const k = hotSort.key;
      const dir = hotSort.dir === 'asc' ? 1 : -1;
      list.sort((a, b) => {
        const va = parseFloat(a[k]); const vb = parseFloat(b[k]);
        if (isNaN(va) && isNaN(vb)) return 0;
        if (isNaN(va)) return 1;
        if (isNaN(vb)) return -1;
        return (va - vb) * dir;
      });
      return list;
    });
    function sortHotBy(key) {
      if (hotSort.key === key) {
        hotSort.dir = hotSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        hotSort.key = key;
        hotSort.dir = 'desc';
      }
    }
    function hotSortIcon(key) {
      if (hotSort.key !== key) return '⇅';
      return hotSort.dir === 'asc' ? '↑' : '↓';
    }

    function removeHotStock(code) {
      const daily = D.dailyData[hotDate.value];
      if (daily) {
        daily.stocks = daily.stocks.filter(s => s.code !== code);
        showToast('已移除', 'success');
      }
    }

    // ===== 火热话题本地快照（替代 GitHub Action 的自动历史积累）=====
    const HT_SNAPSHOT_KEEP_DAYS = 60;
    /** 读取某日本地快照 */
    function getLocalHotTopicSnapshot(date) {
      const m = Store.data && Store.data.hotTopicSnapshots;
      return (m && m[date]) || null;
    }
    /** 保存当日本地快照（实时抓取成功后调用；随 localStorage 持久化与云端同步） */
    function saveLocalHotTopicSnapshot(sources) {
      if (!sources || !sources.length) return;
      if (!Store.data.hotTopicSnapshots) Store.data.hotTopicSnapshots = {};
      const slim = sources.map(s => ({
        rank: s.rank, key: s.key, name: s.name, color: s.color,
        items: (s.items || []).map(it => ({ text: it.text, time: it.time, url: it.url, cat: it.cat }))
      }));
      if (!slim.some(s => s.items.length)) return; // 全空则不覆盖已有快照
      const date = fmtDate(new Date());
      Store.data.hotTopicSnapshots[date] = { date, generatedAt: new Date().toISOString(), sources: slim };
      // 仅保留最近 N 天，避免数据过大
      const keys = Object.keys(Store.data.hotTopicSnapshots).sort();
      while (keys.length > HT_SNAPSHOT_KEEP_DAYS) {
        delete Store.data.hotTopicSnapshots[keys.shift()];
      }
    }
    /** 本地快照已有日期（降序） */
    const localSnapshotDates = computed(() => {
      const m = (Store.data && Store.data.hotTopicSnapshots) || {};
      return Object.keys(m).sort().reverse();
    });

    /** 从各源重建「综合最火」合并列表（按时间降序） */
    function buildMergedList(srcs) {
      const m = [];
      for (const s of (srcs || [])) for (const it of (s.items || [])) m.push({ ...it, source: s.name, color: s.color, sourceRank: s.rank });
      m.sort((a, b) => (b.time || '').localeCompare(a.time || ''));
      return m.slice(0, 20);
    }

    /**
     * 读取「仓库内置的最新可用快照」（同源，GitHub Pages 直出，不依赖任何代理）。
     * 先读清单 data/hot-topics/index.json 定位最新日期，读不到则从今天起向前回溯。
     */
    async function loadLatestRepoSnapshot() {
      const today = fmtDate(new Date());
      let manifest = null;
      try {
        const r = await fetch('./data/hot-topics/index.json', { cache: 'no-store' });
        if (r.ok) manifest = await r.json();
      } catch (e) { /* 忽略，走回溯 */ }
      const dates = (typeof HotTopics !== 'undefined' && HotTopics.snapshotCandidates)
        ? HotTopics.snapshotCandidates(manifest, today, 14)
        : [today];
      for (const d of dates) {
        try {
          const r = await fetch(`./data/hot-topics/${d}.json`, { cache: 'no-store' });
          if (!r.ok) continue;
          const snap = await r.json();
          const srcs = (snap.sources || []).map(s => ({
            ...s, loading: false,
            items: s.items || [],
            error: (s.items && s.items.length) ? null : '该源暂无数据'
          }));
          if (!srcs.some(s => s.items.length)) continue; // 全空快照跳过
          return { date: d, generatedAt: snap.generatedAt || '', sources: srcs };
        } catch (e) { /* 继续回溯前一天 */ }
      }
      return null;
    }

    // 全球信息页：刷新「火热话题」+「美股美债」行情
    // 代理地址支持填多个（空格/逗号/分号分隔），依次尝试；全部失败则回退到仓库内置快照
    async function refreshHotTopics() {      const proxies = String(D.settings.proxyUrl || '').split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
      htMode.value = 'live';
      hotTopicsLoading.value = true;
      let lastErrors = [];
      try {
        for (const p of proxies) {
          const ht = await StockAPI.fetchHotTopics(p);
          if (ht.sources && ht.sources.some(s => s.items.length)) {
            hotTopicsSources.value = ht.sources;
            hotTopicsMerged.value = ht.merged || [];
            saveLocalHotTopicSnapshot(ht.sources);   // 自动积累当日本地快照（随 Gist 同步）
            hotTopicsUpdated.value = new Date().toLocaleString('zh-CN', { hour12: false }) + '（实时）';
            try { usMarket.value = (await StockAPI.fetchUsMarket(p)) || []; } catch (e) { /* 忽略 */ }
            return;
          }
          lastErrors = (ht.sources || []).filter(s => !s.items.length).map(s => `${s.name}: ${s.error || '无数据'}`);
        }

        // 实时链路不可用（未配代理 / 域名被拦截 / 源站拒绝）→ 回退到自动抓取的快照
        const fb = await loadLatestRepoSnapshot();
        if (fb) {
          hotTopicsSources.value = fb.sources;
          hotTopicsMerged.value = buildMergedList(fb.sources);
          hotTopicDate.value = fb.date;
          hotTopicDateHasData.value = true;
          htMode.value = 'history';
          const when = fb.generatedAt ? new Date(fb.generatedAt).toLocaleString('zh-CN', { hour12: false }) : fb.date;
          hotTopicsUpdated.value = `${when}（自动抓取快照 ${fb.date}）`;
          if (proxies.length && proxies[0] !== '') {
            try { usMarket.value = (await StockAPI.fetchUsMarket(proxies[0])) || []; } catch (e) { /* 忽略 */ }
          }
          const why = lastErrors.length ? lastErrors.slice(0, 2).join('；') : '未配置新闻代理地址';
          showToast(`实时抓取不可用（${why}），已回退到自动抓取的快照 ${fb.date}`, 'info');
          return;
        }

        hotTopicsSources.value = (typeof HotTopics !== 'undefined' ? HotTopics.SOURCE_ORDER : [])
          .map(s => ({ ...s, items: [], loading: false, error: null }));
        showToast('实时抓取不可用，且暂无可展示的快照；请检查代理地址或稍后重试', 'error');
      } catch (e) {
        showToast('火热话题刷新失败：' + (e && e.message ? e.message : e), 'error');
      } finally {
        hotTopicsLoading.value = false;
      }
    }

    /**
     * 进入「全球信息」页时自动加载（幂等）。
     * 顺序：本地快照 → 仓库内置最新快照（同源，不依赖代理）→ 已配代理才实时抓取。
     */
    function autoLoadHotTopics() {
      if (hotTopicsSources.value.length || hotTopicsLoading.value) return;
      // 顶部「暂停」生效时，不发起任何自动抓取（含仓库快照请求）
      if (autoRefreshPaused()) { pauseHint('自动加载热门话题'); return; }
      htMode.value = 'history';
      loadHotTopicHistory(hotTopicDate.value).then(async () => {
        if (hotTopicDateHasData.value) return;
        const fb = await loadLatestRepoSnapshot();
        if (fb) {
          hotTopicsSources.value = fb.sources;
          hotTopicsMerged.value = buildMergedList(fb.sources);
          hotTopicDate.value = fb.date;
          hotTopicDateHasData.value = true;
          const when = fb.generatedAt ? new Date(fb.generatedAt).toLocaleString('zh-CN', { hour12: false }) : fb.date;
          hotTopicsUpdated.value = `${when}（自动抓取快照 ${fb.date}）`;
          return;
        }
        if ((D.settings.proxyUrl || '').trim()) refreshHotTopics();
      });
    }

    /** 加载某日历史快照（优先本地快照，回退到仓库内置 data/hot-topics/YYYY-MM-DD.json） */
    async function loadHotTopicHistory(date) {
      // 1) 优先本地快照（打开应用时自动积累）
      const local = getLocalHotTopicSnapshot(date);
      if (local) {
        hotTopicDateHasData.value = true;
        hotTopicsSources.value = (local.sources || []).map(s => ({ ...s, loading: false, error: (s.items && s.items.length) ? null : '该日该源无数据' }));
        hotTopicsUpdated.value = (local.generatedAt ? new Date(local.generatedAt).toLocaleString('zh-CN', { hour12: false }) : date) + '（本地快照）';
        return;
      }
      hotTopicsLoading.value = true;
      try {
        const resp = await fetch(`./data/hot-topics/${date}.json`, { cache: 'no-store' });
        if (!resp.ok) {
          hotTopicDateHasData.value = false;
          hotTopicsSources.value = (typeof HotTopics !== 'undefined' ? HotTopics.SOURCE_ORDER : []).map(s => ({ ...s, items: [], loading: false, error: '该日暂无历史快照' }));
          return;
        }
        const snap = await resp.json();
        hotTopicDateHasData.value = true;
        hotTopicsSources.value = (snap.sources || []).map(s => ({ ...s, loading: false, error: (s.items && s.items.length) ? null : '该日该源无数据' }));
        hotTopicsUpdated.value = (snap.generatedAt ? new Date(snap.generatedAt).toLocaleString('zh-CN', { hour12: false }) : date) + '（历史）';
      } catch (e) {
        hotTopicDateHasData.value = false;
        hotTopicsSources.value = [];
      } finally {
        hotTopicsLoading.value = false;
      }
    }

    function setHtMode(m) {
      htMode.value = m;
      if (m === 'history') loadHotTopicHistory(hotTopicDate.value);
      else refreshHotTopics();
    }
    function onHotTopicDateChange() {
      if (htMode.value === 'history') loadHotTopicHistory(hotTopicDate.value);
    }

    /** 统计分析：按时间段加载历史快照，跨站聚类 + 各站分类统计 */
    async function runAnalysis() {
      const opt = htRangeOptions.find(r => r.key === analysisRange.value) || htRangeOptions[1];
      analysisLoading.value = true;
      analysisResult.value = null;
      try {
        const today = hotTopicDate.value || fmtDate(new Date());
        const dates = [];
        for (let i = 0; i < opt.days; i++) dates.push(dateMinusDays(today, i));
        const snapshots = await Promise.all(dates.map(async d => {
          const local = getLocalHotTopicSnapshot(d);
          if (local) return local;
          try {
            const r = await fetch(`./data/hot-topics/${d}.json`, { cache: 'no-store' });
            if (!r.ok) return null;
            return await r.json();
          } catch (e) { return null; }
        }));
        const flat = [];
        let dayCount = 0;
        for (const snap of snapshots) {
          if (!snap || !snap.sources) continue;
          dayCount++;
          for (const s of snap.sources) {
            for (const it of (s.items || [])) {
              flat.push({
                sourceRank: s.rank, sourceKey: s.key, sourceName: s.name,
                text: it.text, time: it.time, url: it.url, cat: it.cat || '财经', date: snap.date
              });
            }
          }
        }
        const clusters = (typeof HotTopics !== 'undefined' ? HotTopics.clusterItems(flat) : []).map(c => ({ ...c, _open: false }));
        const siteStats = (typeof HotTopics !== 'undefined' ? HotTopics.siteCategoryStats(flat) : []);
        // 主题维度统计（行业/概念/产品/产业/科技），多标签命中，与跨站重合榜并排展示
        const themeStats = (typeof HotTopics !== 'undefined' && HotTopics.themeStats ? HotTopics.themeStats(flat) : [])
          .map(d => ({ ...d, _open: true, showAll: false, selTopic: null, newsLimit: 30 }));
        analysisResult.value = { clusters, siteStats, themeStats, dayCount, totalItems: flat.length };
      } catch (e) {
        showToast('统计分析失败：' + (e && e.message ? e.message : e), 'error');
      } finally {
        analysisLoading.value = false;
      }
    }

    /** 点击主题词（半导体 / 人工智能 / 医疗器械 …）：就地展开该主题命中的新闻明细；同一维度内一次只看一个主题 */
    function toggleThemeTopic(dim, topic) {
      dim.selTopic = dim.selTopic === topic.name ? null : topic.name;
    }
    /** 展开更多该主题的新闻（默认先显示 30 条） */
    function moreThemeNews(dim) { dim.newsLimit = (dim.newsLimit || 30) + 50; }

    async function fetchHotBoards() {
      hotLoading.value = true;
      showToast('正在获取热门板块...', 'info');
      try {
        const [boards, stocks, preBoards, ampBoards] = await Promise.all([
          StockAPI.getBoardRanking(),
          StockAPI.getStockRanking(),
          StockAPI.getPreMarketBoards(),
          StockAPI.getAmplitudeBoards()
        ]);
        hotBoards.value = boards;
        hotStocks.value = stocks;
        preMarketBoards.value = preBoards;
        amplitudeBoards.value = ampBoards;
        D.hotBoards = boards;
        D.hotStocks = stocks;
        D.preMarketBoards = preBoards;
        D.amplitudeBoards = ampBoards;
        const ok = boards.length || stocks.length || preBoards.length || ampBoards.length;
        showToast(ok ? `获取到 ${boards.length} 个当日板块、${preBoards.length} 个盘前热点、${ampBoards.length} 个振幅板块、${stocks.length} 只热门股票` : '获取失败：跨域/网络受限（已自动尝试 JSONP 兜底仍失败），请检查网络后重试', ok ? 'success' : 'error');
      } catch (e) {
        showToast('获取失败', 'error');
      } finally {
        hotLoading.value = false;
      }
    }

    async function refreshAmplitudeBoards() {
      ampLoading.value = true;
      showToast('正在刷新振幅板块...', 'info');
      try {
        const list = await StockAPI.getAmplitudeBoards();
        amplitudeBoards.value = list;
        D.amplitudeBoards = list;
        showToast(list.length ? `已刷新 ${list.length} 个振幅板块` : '刷新失败（网络限制），可稍后重试', list.length ? 'success' : 'error');
      } catch (e) {
        showToast('刷新失败', 'error');
      } finally {
        ampLoading.value = false;
      }
    }

    /**
     * 以固定并发度执行异步任务。
     * 板块成分股动辄上百只，若逐只串行补全（每只约 7 次请求），总耗时与失败率都会急剧上升，
     * 是「今年高价/距高价/今年低价/距低价/年涨跌/924涨跌」六个字段长期刷新不出的主因；
     * 但若一次性全并发又会被接口限流。这里取折中并发度（默认 6）。
     * @param {Array} items 待处理项
     * @param {number} limit 并发度
     * @param {(item:any, index:number)=>Promise<any>} worker 处理函数
     */
    async function runWithConcurrency(items, limit, worker) {
      const list = items || [];
      if (!list.length) return;
      const n = Math.max(1, Math.min(limit || 6, list.length));
      let idx = 0;
      const runners = [];
      for (let w = 0; w < n; w++) {
        runners.push((async () => {
          for (;;) {
            const i = idx++;
            if (i >= list.length) return;
            try { await worker(list[i], i); }
            catch (e) { console.warn('并发补全任务失败', e); }
          }
        })());
      }
      await Promise.all(runners);
    }

    async function refreshHotStocks() {
      const daily = D.dailyData[hotDate.value];
      if (!daily || !daily.stocks.length) {
        showToast('请先加载当日数据', 'error');
        return;
      }
      hotLoading.value = true;
      showToast('正在刷新股票行情...', 'info');
      const codes = daily.stocks.map(s => s.code).filter(Boolean);
      const quotes = await StockAPI.getQuotes(codes);
      for (const s of daily.stocks) {
        const q = quotes[s.code];
        if (q) {
          s.name = s.name || q.name;
          s.amplitude = q.amplitude;
          s.dailyChange = q.changePercent;
          s.turnover = q.turnover;
          s.todayPrice = q.price || s.todayPrice;
          if (q.totalMarketCap) s.totalMarketCap = q.totalMarketCap;
        }
      }
      showToast('行情已刷新，正在获取财务数据...', 'info');
      // 财务/股东/历史价（东财，best-effort，复用共享补全逻辑）
      // 并发补全：成分股数量多时串行会显著拖慢并触发限流，导致六项历史价字段取不到
      let done = 0;
      await runWithConcurrency(daily.stocks, 6, async (s) => {
        try { await enrichStockFinancials(s); } catch (e) { console.warn('热门股财务补全失败', s.code, e); }
        done++;
        // 给出进度提示
        if (done % 25 === 0) showToast(`已补全 ${done}/${daily.stocks.length} 只...`, 'info');
      });
      hotLoading.value = false;
      showToast('行情已刷新', 'success');
    }

    // 当日股票明细的「股票查询」条件：按代码 / 按名称关键字过滤
    const hotSearchCode = ref('');
    const hotSearchName = ref('');
    /** 清空股票查询条件 */
    function clearHotSearch() {
      hotSearchCode.value = '';
      hotSearchName.value = '';
    }
    // 当前选中的热门板块名（用于高亮与表头提示）
    const hotBoardActive = ref('');
    const hotBoardLoading = ref(false);
    // true=当前明细展示的是「单只个股」；false=展示的是「板块成分股」
    const hotDetailIsStock = ref(false);

    /**
     * 点击「当日热门板块」中的某个板块：
     * 把该板块的全部成分股载入下方「当日股票明细」，字段与格式与筛选板块完全一致。
     */
    async function openHotBoard(b) {
      if (!b) return;
      if (!b.bk) {
        showToast('该板块缺少板块代码，请重新「获取热门板块」', 'error');
        return;
      }
      if (hotBoardLoading.value) return;
      hotBoardLoading.value = true;
      showToast(`正在获取「${b.name}」成分股...`, 'info');
      try {
        const list = await StockAPI.getSectorStocks(b.bk);
        if (!list || !list.length) {
          showToast('未获取到成分股（可能受网络限制），可稍后重试', 'error');
          return;
        }
        const daily = Store.getDailyStocks(hotDate.value);
        daily.stocks = list.map(s => {
          const ns = _newStock(s);
          ns.dailyChange = s.changePercent;
          ns.todayPrice = s.price;
          return ns;
        });
        hotBoardActive.value = b.name;
        hotDetailIsStock.value = false;
        // 联动：把成分股同时载入下方「筛选板块」列表（尊重「固定筛选」区间）
        if (!filterPanel.locked) resetHotFilterRanges();
        filterPanel.poolId = 'hot';
        hotFilterStocks.value = daily.stocks;
        showToast(`已载入「${b.name}」${daily.stocks.length} 只成分股，正在补全字段...`, 'success');
        await refreshHotStocks();
      } catch (e) {
        console.warn('板块成分股获取失败', e);
        showToast('成分股获取失败，请重试', 'error');
      } finally {
        hotBoardLoading.value = false;
      }
    }

    /** 清除板块/个股选择，恢复当日新闻关联的股票 */
    function clearHotBoard() {
      hotBoardActive.value = '';
      hotDetailIsStock.value = false;
      hotFilterStocks.value = [];
      if (!filterPanel.locked) filterPanel.poolId = '';
      const daily = D.dailyData[hotDate.value];
      if (daily) daily.stocks = [];
      showToast('已清除选择', 'success');
    }

    /**
     * 点击「当日热门股票」中的某只个股：
     * 把该个股单独载入下方「当日股票明细」，字段与格式与筛选板块完全一致。
     * 与 openHotBoard（板块→成分股）互补：这里展示的是单只个股本身。
     */
    async function openHotStock(s) {
      if (!s) return;
      const code = s.code;
      if (!code) {
        showToast('该股票缺少代码，请重新「获取热门板块」', 'error');
        return;
      }
      if (hotBoardLoading.value) return;
      hotBoardLoading.value = true;
      const label = s.name || code;
      showToast(`正在获取「${label}」的行情与财务数据...`, 'info');
      try {
        const daily = Store.getDailyStocks(hotDate.value);
        const ns = _newStock({ code, name: s.name });
        if (s.change != null) ns.dailyChange = s.change;
        daily.stocks = [ns];
        hotBoardActive.value = label;
        hotDetailIsStock.value = true;
        // 联动：把个股同时载入下方「筛选板块」列表（尊重「固定筛选」区间）
        if (!filterPanel.locked) resetHotFilterRanges();
        filterPanel.poolId = 'hot';
        hotFilterStocks.value = daily.stocks;
        showToast(`已载入个股「${label}」，正在补全字段...`, 'success');
        await refreshHotStocks();
      } catch (e) {
        console.warn('个股载入失败', e);
        showToast('个股载入失败，请重试', 'error');
      } finally {
        hotBoardLoading.value = false;
      }
    }

    // 初始化时若有缓存的热门数据则恢复
    if (D.hotBoards && D.hotBoards.length) hotBoards.value = D.hotBoards;
    if (D.hotStocks && D.hotStocks.length) hotStocks.value = D.hotStocks;
    if (D.preMarketBoards && D.preMarketBoards.length) preMarketBoards.value = D.preMarketBoards;
    if (D.amplitudeBoards && D.amplitudeBoards.length) amplitudeBoards.value = D.amplitudeBoards;

    // ============================================================
    //  筛选板块（热门板块页 · 板块筛选 + 市值比区间筛选）
    // ============================================================
    const filterPanel = reactive({
      show: false,
      poolId: '',       // 's-板块id' 或 'p-股票池id'
      locked: false,      // 是否固定筛选区间（切换板块/重置时保持不变）
      pbMin: null, pbMax: null,   // 市净比区间
      pkMin: null, pkMax: null,   // 市扣比区间
      prMin: null, prMax: null,   // 市营比区间
      q24Min: null, q24Max: null,   // 24营比区间
      q24kMin: null, q24kMax: null, // 24扣比区间
      posMin: null, posMax: null,   // 正数统计区间（今涨跌→扣非环比 中为正的字段个数）
      ratioFilter: false,            // 比值筛选：924涨跌 < 24营比 + 24扣比
      industry: '',                  // 行业筛选（单选下拉，兼容旧值）
      industries: [],                // 行业筛选（多选勾选，与 sector 详情一致；勾选优先于 industry）
      mainBusiness: ''               // 主业产品筛选：关键字模糊匹配「主业与主要产品」文本，'' 表示不限
    });
    const filterIndustryOpen = ref(false); // 筛选栏「行业」勾选下拉是否展开
    // 各表初始列宽（px）：与 STOCK_COLUMNS 宽度一一对应（见下方 SORT_STATES 之后的定义）。

    // 列宽拖拽调整（鼠标拖动非冻结列右边缘）。通用：传入表格选择器、对应的存储键、
    // 以及初始列宽数组，以便「筛选板块」与「概念板块详情弹窗」各自独立保存列宽，
    // 且首次打开即有贴合内容的合理初始宽度。
    /**
     * 按 <colgroup> 各列「实际宽度」累加，动态写入冻结列的 left 偏移。
     * 冻结列宽度可被用户拖拽改变，若 left 仍用硬编码值，就会出现表头与内容错位、
     * 冻结列相互重叠或与滚动列之间留出无法消除的空档——故每次列宽变化后都必须同步。
     */
    function syncStickyOffsets(table) {
      if (!table) return;
      const cols = table.querySelectorAll('colgroup col');
      if (!cols.length) return;
      let acc = 0;
      for (let i = 0; i < cols.length; i++) {
        const cells = table.querySelectorAll('.col-sticky-' + i);
        if (!cells.length) break;                 // 已越过最后一个冻结列
        const left = acc + 'px';
        cells.forEach(c => { c.style.left = left; });
        acc += parseFloat(cols[i].style.width) || cols[i].getBoundingClientRect().width || 0;
      }
    }

    function initColResize(tableSelector, storageKey, defaultWidths) {
      const table = document.querySelector(tableSelector);
      if (!table) return;
      const header = table.querySelector('thead tr');
      if (!header) return;
      const ths = [...header.children];
      const thead = table.querySelector('thead');
      let colgroup = table.querySelector('colgroup');
      if (!colgroup) { colgroup = document.createElement('colgroup'); table.insertBefore(colgroup, thead); }
      const saved = Store.data[storageKey] || {};
      ths.forEach((th, i) => {
        // 列宽按「列 key」存储（而非索引），这样重排列后已保存的自定义宽度仍能正确对应到列
        const m = th.className.match(/col-([A-Za-z0-9_]+)/);
        const key = th.getAttribute('data-colkey') || (m ? m[1] : null);
        let col = colgroup.children[i];
        if (!col) { col = document.createElement('col'); colgroup.appendChild(col); }
        if (key) col.setAttribute('data-colkey', key);
        let w;
        if (key != null && saved[key] != null) w = saved[key];
        else if (defaultWidths && defaultWidths[i] != null) w = defaultWidths[i];
        else w = Math.round(th.getBoundingClientRect().width);
        col.style.width = w + 'px';
      });
      while (colgroup.children.length > ths.length) colgroup.removeChild(colgroup.lastChild);
      const applyTotal = () => {
        let total = 0;
        [...colgroup.children].forEach(c => { total += parseFloat(c.style.width) || 0; });
        table.style.width = total + 'px';
        // 表格总宽变化后，同步刷新屏幕最下方横向滚动条的可滚动宽度
        if (window.__ghostSync) window.__ghostSync();
      };
      applyTotal();
      syncStickyOffsets(table);
      ths.forEach((th, i) => {
        // 冻结列同样可拖拽调宽（拖后由 syncStickyOffsets 实时重算 left，保证不错位）
        if (th.querySelector('.col-resize-handle')) return;
        const h = document.createElement('div');
        h.className = 'col-resize-handle';
        h.addEventListener('mousedown', e => startColResize(e, i, table, applyTotal, storageKey));
        th.appendChild(h);
      });
    }
    function startColResize(e, colIndex, table, applyTotal, storageKey) {
      e.preventDefault(); e.stopPropagation();
      const col = table.querySelector('colgroup').children[colIndex];
      const startX = e.clientX;
      const startW = parseFloat(col.style.width) || 80;
      const colKey = col.getAttribute('data-colkey');
      const onMove = ev => {
        const w = Math.max(40, startW + (ev.clientX - startX));
        col.style.width = w + 'px';
        applyTotal();
        syncStickyOffsets(table);
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        const widths = Object.assign({}, Store.data[storageKey] || {});
        if (colKey != null) widths[colKey] = parseFloat(col.style.width);
        else widths[colIndex] = parseFloat(col.style.width);
        Store.data[storageKey] = widths;
        Store.saveNow();   // 立即落盘，避免刷新后列宽丢失
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }
    /** 当前板块成分股涉及的全部行业（去重、中文排序），供行业下拉筛选 */
    const filterIndustries = computed(() => {
      const set = new Set();
      filterPoolStocks.value.forEach(s => set.add(s.industry || '未知'));
      return [...set].sort((a, b) => String(a).localeCompare(String(b), 'zh-CN'));
    });
    function openFilterPanel() {
      filterPanel.show = true;
    }
    /** 一键固定/取消固定筛选区间：固定后切换板块、重置均不再清空已填的区间值 */
    function toggleFilterLock() {
      filterPanel.locked = !filterPanel.locked;
      if (filterPanel.locked) {
        showToast('已固定筛选区间，切换板块/重置将保留当前区间', 'success');
      } else {
        showToast('已取消固定筛选区间', 'info');
      }
    }
    function resetFilter() {
      if (filterPanel.locked) {
        showToast('筛选区间已固定，请先点击「固定筛选」解锁后再重置', 'error');
        return;
      }
      filterPanel.poolId = '';
      filterPanel.pbMin = null; filterPanel.pbMax = null;
      filterPanel.pkMin = null; filterPanel.pkMax = null;
      filterPanel.prMin = null; filterPanel.prMax = null;
      filterPanel.q24Min = null; filterPanel.q24Max = null;
      filterPanel.q24kMin = null; filterPanel.q24kMax = null;
      filterPanel.posMin = null; filterPanel.posMax = null;
      filterPanel.ratioFilter = false; filterPanel.industry = '';
      filterPanel.industries = []; filterPanel.mainBusiness = '';
      hotFilterStocks.value = [];   // 同步清空热门板块联动的筛选列表
    }
    /** 切换板块后重置区间筛选；若已固定则保留区间 */
    function applyFilterPool() {
      if (filterPanel.locked) return;
      filterPanel.pbMin = null; filterPanel.pbMax = null;
      filterPanel.pkMin = null; filterPanel.pkMax = null;
      filterPanel.prMin = null; filterPanel.prMax = null;
      filterPanel.q24Min = null; filterPanel.q24Max = null;
      filterPanel.q24kMin = null; filterPanel.q24kMax = null;
      filterPanel.posMin = null; filterPanel.posMax = null;
      filterPanel.ratioFilter = false; filterPanel.industry = '';
      filterPanel.industries = []; filterPanel.mainBusiness = '';
    }
    /** 切换热门板块时清空筛选区间（不触碰 poolId，由调用方设置）；调用方需自行判断「固定筛选」开关 */
    function resetHotFilterRanges() {
      filterPanel.pbMin = null; filterPanel.pbMax = null;
      filterPanel.pkMin = null; filterPanel.pkMax = null;
      filterPanel.prMin = null; filterPanel.prMax = null;
      filterPanel.q24Min = null; filterPanel.q24Max = null;
      filterPanel.q24kMin = null; filterPanel.q24kMax = null;
      filterPanel.posMin = null; filterPanel.posMax = null;
      filterPanel.ratioFilter = false; filterPanel.industry = '';
      filterPanel.industries = []; filterPanel.mainBusiness = '';
    }
    /** 区间判断工具：v 在 [min,max] 内（含边界），边界均为空则不限（含 null） */
    function inRange(v, min, max) {
      if (min == null && max == null) return true;   // 未设边界，全部通过
      if (v == null || isNaN(v)) return false;
      if (min != null && v < min) return false;
      if (max != null && v > max) return false;
      return true;
    }
    /** 所选板块的所有原始股票 */
    const filterPoolStocks = computed(() => {
      const id = filterPanel.poolId;
      if (!id) return [];
      if (id === 'hot') return hotFilterStocks.value;   // 点击热门板块 4 子版块载入的成分股
      if (id.startsWith('s-')) {
        const sp = (D.sectorPools || []).find(p => 's-' + p.id === id);
        return sp ? (sp.stocks || []) : [];
      }
      const pp = (D.stockPools || []).find(p => 'p-' + p.id === id);
      return pp ? (pp.stocks || []) : [];
    });
    /**
     * 通用区间/比值/行业筛选：对单只股票 s 应用筛选对象 f。
     * f 需包含 pbMin/pbMax/pkMin/pkMax/prMin/prMax/q24Min/q24Max/q24kMin/q24kMax/
     * posMin/posMax/ratioFilter/industry。筛选板块与板块详情共用同一套规则。
     */
    function passFilter(s, f) {
      const r = sRatio(s);
      if (!inRange(r.pbRatio, f.pbMin, f.pbMax)) return false;
      if (!inRange(r.pkRatio, f.pkMin, f.pkMax)) return false;
      if (!inRange(r.prRatio, f.prMin, f.prMax)) return false;
      if (!inRange(s.q24Rev, f.q24Min, f.q24Max)) return false;
      if (!inRange(s.q24Kcf, f.q24kMin, f.q24kMax)) return false;
      if (!inRange(positiveCount(s), f.posMin, f.posMax)) return false;
      // 行业筛选
      // 行业筛选：兼容「单选字符串(industry)」与「多选勾选(industries 数组)」
      {
        const multi = (f.industries && f.industries.length) ? f.industries : null;
        const picked = multi || (f.industry ? [f.industry] : []);
        if (picked.length && picked.indexOf(s.industry || '未知') === -1) return false;
      }
      // 比值筛选：924涨跌 < 24营比/2 + 24扣比/2（924涨跌 小于二者均值，三值均须有效）
      if (f.ratioFilter) {
        const c9 = s.change924, rv = s.q24Rev, kc = s.q24Kcf;
        if (c9 == null || isNaN(c9) || rv == null || isNaN(rv) || kc == null || isNaN(kc)) return false;
        if (!(c9 < rv / 2 + kc / 2)) return false;
      }
      // 主业产品筛选：关键字模糊匹配「主业与主要产品」文本（mainBusiness 为 {name,ratio} 数组）
      if (f.mainBusiness && f.mainBusiness.trim()) {
        const kw = f.mainBusiness.trim();
        const mb = s.mainBusiness;
        const text = Array.isArray(mb)
          ? mb.map(x => (x && x.name) || x).join(' ')
          : (mb ? String(mb) : '');
        if (text.indexOf(kw) === -1) return false;
      }
      return true;
    }
    /** 按板块 + 市净比/市扣比/市营比/24营比/24扣比区间过滤后的股票 */
    const filteredFilterStocks = computed(() => {
      return filterPoolStocks.value.filter(s => passFilter(s, filterPanel));
    });

    // 筛选结果排序
    const filterSort = reactive({ key: 'dailyChange', dir: 'desc' });
    const sortedFilterStocks = computed(() => {
      const list = [...filteredFilterStocks.value];
      const k = filterSort.key;
      const dir = filterSort.dir === 'asc' ? 1 : -1;
      list.sort((a, b) => compareForSort(a, b, k) * dir);
      return list;
    });
    function sortFilterBy(key) {
      if (filterSort.key === key) {
        filterSort.dir = filterSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        filterSort.key = key;
        filterSort.dir = 'desc';
      }
    }
    function filterSortIcon(key) {
      if (filterSort.key !== key) return '⇅';
      return filterSort.dir === 'asc' ? '↑' : '↓';
    }

    // 四表排序状态汇总（此时 filterSort/poolDetailSort/sectorDetailSort 均已声明）
    const SORT_STATES = { fav: favSort, filter: filterSort, pool: poolDetailSort, sector: sectorDetailSort, hot: hotSort };

    // 列宽默认值：与 STOCK_COLUMNS 宽度一一对应（收藏表额外 3 列）
    const STOCK_COL_WIDTHS = STOCK_COLUMNS.map(c => c.width);
    const FAV_COL_WIDTHS = STOCK_COL_WIDTHS.concat(FAV_EXTRA_COLUMNS.map(c => c.width));
    const FILTER_DEFAULT_COL_WIDTHS = STOCK_COL_WIDTHS;
    const SECTOR_DEFAULT_COL_WIDTHS = STOCK_COL_WIDTHS;
    const POOL_DEFAULT_COL_WIDTHS = STOCK_COL_WIDTHS;
    const FAV_DEFAULT_COL_WIDTHS = FAV_COL_WIDTHS;
    const HOT_DEFAULT_COL_WIDTHS = STOCK_COL_WIDTHS;
    // 列宽拖拽：初次挂载、切到对应页/打开弹窗、以及列表变化后均重新初始化（幂等）
    // 五张股票表（筛选 / 概念详情 / 股票池详情 / 收藏 / 当日股票明细）各自独立保存列宽
    const initResizeFor = (sel, key, widths) => {
      const el = document.querySelector(sel);
      if (el) initColResize(sel, key, widths);
    };
    /**
     * 把表格的横向滚动条「复制」一份固定在屏幕最下方：
     * 表格自带横向滚动条位于容器底部，纵向翻页时会随容器一起上移甚至移出视口，
     * 想左右拉动就得先滚到容器底部。这里用一个 fixed 底栏与真实滚动容器双向同步 scrollLeft，
     * 使其永远停留在屏幕最下方。
     */
    function initGhostHScroll() {
      let bar = document.getElementById('ghost-hscroll');
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'ghost-hscroll';
        bar.innerHTML = '<div class="ghs-spacer"></div>';
        document.body.appendChild(bar);
      }
      const spacer = bar.querySelector('.ghs-spacer');
      let target = null;    // 当前同步的真实滚动容器
      let lock = false;     // 防止双向同步互相触发形成回环
      let queued = false;

      /** 向上找到真正产生横向滚动的容器 */
      const containerOf = (tb) => {
        let el = tb.parentElement;
        while (el && el !== document.body) {
          const ox = getComputedStyle(el).overflowX;
          if (ox === 'auto' || ox === 'scroll') return el;
          el = el.parentElement;
        }
        return null;
      };
      /** 选取当前视口内可见面积最大、且确实横向溢出的表格容器 */
      const pick = () => {
        const vh = window.innerHeight || document.documentElement.clientHeight;
        const vw = window.innerWidth || document.documentElement.clientWidth;
        // 有弹窗打开时，只认最上层弹窗内的表格（否则会误选被遮住的页面表格）
        const overlays = [...document.querySelectorAll('.modal-overlay')].filter(o => o.offsetParent !== null);
        const scope = overlays.length ? overlays[overlays.length - 1] : document;
        let best = null, bestArea = 0;
        for (const tb of scope.querySelectorAll('.pool-detail-table')) {
          if (!tb.offsetParent) continue;
          const box = containerOf(tb);
          if (!box || box.scrollWidth - box.clientWidth < 4) continue;
          const r = tb.getBoundingClientRect();
          const visible = Math.min(r.bottom, vh) - Math.max(r.top, 0);
          if (visible <= 0) continue;
          const area = visible * Math.min(r.width, vw);
          if (area > bestArea) { bestArea = area; best = box; }
        }
        return best;
      };
      const sync = () => {
        const t = pick();
        target = t;
        if (!t) { bar.classList.remove('show'); return; }
        bar.classList.add('show');
        spacer.style.width = t.scrollWidth + 'px';
        if (Math.abs(bar.scrollLeft - t.scrollLeft) > 1) {
          lock = true;
          bar.scrollLeft = t.scrollLeft;
          requestAnimationFrame(() => { lock = false; });
        }
      };
      const scheduleSync = () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; sync(); });
      };

      // 拖动底栏 → 同步给真实表格容器
      bar.addEventListener('scroll', () => {
        if (lock || !target) return;
        lock = true;
        target.scrollLeft = bar.scrollLeft;
        requestAnimationFrame(() => { lock = false; });
      });
      // scroll 事件不冒泡，用捕获阶段统一监听（页面滚动 / 弹窗内滚动 / 容器横向滚动）
      document.addEventListener('scroll', (e) => {
        if (lock) return;
        if (e.target === target) {
          lock = true;
          bar.scrollLeft = e.target.scrollLeft;
          requestAnimationFrame(() => { lock = false; });
        } else {
          scheduleSync();
        }
      }, true);
      window.addEventListener('resize', scheduleSync);
      // 弹窗开关、翻页、数据刷新等 DOM 变化后重新判定当前该同步哪张表
      if (window.MutationObserver) {
        new MutationObserver(scheduleSync).observe(document.body, { childList: true, subtree: true });
      }
      window.__ghostSync = scheduleSync;   // 供列宽拖拽后主动刷新底栏宽度
      sync();
    }

    onMounted(() => {
      nextTick(() => {
        initGhostHScroll();
        initResizeFor('.filter-scroll table', 'filterColWidths', FILTER_DEFAULT_COL_WIDTHS);
        if (currentPage.value === 'filter') {
          initResizeFor('.fav-panel table', 'favColWidths', FAV_DEFAULT_COL_WIDTHS);
        }
        if (currentPage.value === 'hot') {
          initResizeFor('.hot-stock-table', 'hotColWidths', HOT_DEFAULT_COL_WIDTHS);
        }
      });
      // 点击页面其他位置时收起用户菜单（菜单内部与触发按钮已用 @click.stop 阻止冒泡）
      document.addEventListener('click', () => { userMenuOpen.value = false; });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') userMenuOpen.value = false;
      });
    });
    watch(currentPage, (k) => {
      if (k === 'finance') autoLoadHotTopics();
    }, { immediate: true });
    watch(sortedFilterStocks, () => nextTick(() => initResizeFor('.filter-scroll table', 'filterColWidths', FILTER_DEFAULT_COL_WIDTHS)), { flush: 'post' });
    watch(currentPage, (k) => {
      if (k === 'filter') {
        nextTick(() => initResizeFor('.filter-scroll table', 'filterColWidths', FILTER_DEFAULT_COL_WIDTHS));
        nextTick(() => initResizeFor('.fav-panel table', 'favColWidths', FAV_DEFAULT_COL_WIDTHS));
      }
      if (k === 'hot') {
        nextTick(() => initResizeFor('.hot-stock-table', 'hotColWidths', HOT_DEFAULT_COL_WIDTHS));
      }
    });
    // 当日股票明细表（hot 页）：列表变化后重新初始化列宽拖拽
    watch(sortedHotStocks, () => {
      if (currentPage.value === 'hot') nextTick(() => initResizeFor('.hot-stock-table', 'hotColWidths', HOT_DEFAULT_COL_WIDTHS));
    }, { flush: 'post' });
    // 概念板块详情弹窗：打开弹窗、排序/筛选结果变化后，重新初始化列宽拖拽
    watch(() => sectorDetail.show, (v) => {
      if (v) nextTick(() => initResizeFor('.sector-detail-modal .pool-detail-table', 'sectorColWidths', SECTOR_DEFAULT_COL_WIDTHS));
    });
    watch(sortedSectorDetailStocks, () => {
      if (sectorDetail.show) nextTick(() => initResizeFor('.sector-detail-modal .pool-detail-table', 'sectorColWidths', SECTOR_DEFAULT_COL_WIDTHS));
    }, { flush: 'post' });
    // 股票池详情弹窗
    watch(() => poolDetail.show, (v) => {
      if (v) nextTick(() => initResizeFor('.pool-detail-modal .pool-detail-table', 'poolColWidths', POOL_DEFAULT_COL_WIDTHS));
    });
    watch(sortedPoolDetailStocks, () => {
      if (poolDetail.show) nextTick(() => initResizeFor('.pool-detail-modal .pool-detail-table', 'poolColWidths', POOL_DEFAULT_COL_WIDTHS));
    }, { flush: 'post' });
    // 收藏板块（位于 筛选板块 页，筛选栏下方）
    watch(sortedFavorites, () => {
      if (currentPage.value === 'filter') nextTick(() => initResizeFor('.fav-panel table', 'favColWidths', FAV_DEFAULT_COL_WIDTHS));
    }, { flush: 'post' });

    // 刷新筛选板块下所有股票的行情/财务数据
    const filterRefreshing = ref(false);
    // 筛选板块页：顶部筛选栏与「字段含义」说明的一键收起/展开（收起以显示更多股票内容）
    const filterFilterOpen = ref(true);
    // 收藏板块折叠开关（收藏板块位于筛选结果表下方，可通过工具栏「收起收藏」隐藏）
    const favPanelOpen = ref(true);
    async function refreshFilterStocks() {
      const list = filterPoolStocks.value;
      if (!list || !list.length) {
        showToast('请先选择板块', 'error');
        return;
      }
      if (filterRefreshing.value) return;
      filterRefreshing.value = true;
      showToast(`正在刷新 ${list.length} 只股票...`, 'info');
      try {
        // 1) 实时行情（腾讯）
        const codes = list.map(s => s.code).filter(Boolean);
        let quotes = {};
        try { quotes = await StockAPI.getQuotes(codes); } catch (e) { console.warn('实时行情刷新失败', e); }
        for (const s of list) {
          const q = quotes[s.code];
          if (q) {
            s.name = s.name || q.name;
            s.dailyChange = q.changePercent;
            s.amplitude = q.amplitude;
            s.turnover = q.turnover;
            s.todayPrice = q.price || s.todayPrice;
            if (q.totalMarketCap) s.totalMarketCap = q.totalMarketCap;
          }
        }
        // 2) 补充财务/股东数据（东方财富，best-effort）
        const works = list.filter(s => s.code);
        // 并发补全：成分股数量多时串行会显著拖慢并触发限流
        let done = 0;
        await runWithConcurrency(works, 6, async (s) => {
          try {
            const [flow, fin] = await Promise.all([
              StockAPI.getCapitalFlow(s.code),
              StockAPI.getFinance(s.code)
            ]);
            if (flow != null) s.capitalFlow = flow;
            if (fin.profitYoY != null) s.profitYoY = fin.profitYoY;
            if (fin.revenueYoY != null) s.revenueYoY = fin.revenueYoY;
            if (fin.hbGrowth != null) s.hbGrowth = fin.hbGrowth;
            if (fin.kcfYoY != null) s.kcfYoY = fin.kcfYoY;
            if (fin.revHb != null) s.revHb = fin.revHb;
            if (fin.kcfHb != null) s.kcfHb = fin.kcfHb;
            if (fin.netProfit != null) s.netProfit = fin.netProfit;
            if (fin.kcfjcxjlr != null) s.kcfjcxjlr = fin.kcfjcxjlr;
            if (fin.revenue != null) s.revenue = fin.revenue;
            if (fin.contractLiab != null) s.contractLiab = fin.contractLiab;
            if (fin.shareholderCount != null) s.shareholderCount = fin.shareholderCount;
            if (fin.prevShareholderCount != null) s.prevShareholderCount = fin.prevShareholderCount;
          } catch (e) {
            console.warn('财务数据获取失败', s.code, e);
          }
          // 所属行业（best-effort）
          try {
            if (!s.industry) {
              const ind = await StockAPI.getIndustry(s.code);
              if (ind) s.industry = ind;
            }
          } catch (e) {
            console.warn('行业获取失败', s.code, e);
          }
          // 主营构成（公司主业 + 占比，best-effort）
          try {
            if (!s.mainBusiness) {
              const mb = await StockAPI.getMainBusiness(s.code);
              if (mb) s.mainBusiness = mb;
            }
          } catch (e) {
            console.warn('主营构成获取失败', s.code, e);
          }
          // 24营比 / 24扣比（季报对比2024同期）
          try {
            const q24 = await StockAPI.getQuarterlyFinance(s.code);
            if (q24.q24Rev != null) s.q24Rev = q24.q24Rev;
            if (q24.q24Kcf != null) s.q24Kcf = q24.q24Kcf;
          } catch (e) {
            console.warn('季报对比获取失败', s.code, e);
          }
          // 历史价：优先「一次请求取四项」，取不到的项再逐项兜底（各自独立 try，互不连坐）
          try {
            const hb = await StockAPI.getHistoryBundle(s.code);
            if (hb) {
              if (hb.yearStartPrice != null) s.yearStartPrice = hb.yearStartPrice;
              if (hb.price924 != null) s.price924 = hb.price924;
              if (hb.yearHighPrice != null) s.yearHighPrice = hb.yearHighPrice;
              if (hb.yearLowPrice != null) s.yearLowPrice = hb.yearLowPrice;
              if (hb.yearHighDate != null) s.yearHighDate = hb.yearHighDate;
              if (hb.yearLowDate != null) s.yearLowDate = hb.yearLowDate;
              if (hb.weekAgoClose != null) s.weekAgoClose = hb.weekAgoClose;
              if (hb.monthAgoClose != null) s.monthAgoClose = hb.monthAgoClose;
            }
          } catch (e) {
            console.warn('历史价批量获取失败', s.code, e);
          }
          if (s.yearStartPrice == null) {
            try {
              const yp = await StockAPI.getYearStartPrice(s.code);
              if (yp != null) s.yearStartPrice = yp;
            } catch (e) {
              console.warn('年初价获取失败', s.code, e);
            }
          }
          if (s.price924 == null) {
            try {
              const p924 = await StockAPI.get924Price(s.code);
              if (p924 != null) s.price924 = p924;
            } catch (e) {
              console.warn('924价获取失败', s.code, e);
            }
          }
          // 今年最高/最低价（用于「今年高价 / 距高价 / 今年低价 / 距低价」字段）
          if (s.yearHighPrice == null || s.yearLowPrice == null) {
            try {
              const yhl = await StockAPI.getYearHighLow(s.code);
              if (yhl) {
                if (yhl.high != null) s.yearHighPrice = yhl.high;
                if (yhl.low != null) s.yearLowPrice = yhl.low;
              }
            } catch (e) {
              console.warn('今年高低价获取失败', s.code, e);
            }
          }
          if (s.todayPrice && s.yearStartPrice) {
            s.yearChange = +(((s.todayPrice - s.yearStartPrice) / s.yearStartPrice) * 100).toFixed(2);
          }
          if (s.todayPrice && s.price924) {
            s.change924 = +(((s.todayPrice - s.price924) / s.price924) * 100).toFixed(2);
          }
          // 一周涨跌 / 一月涨跌
          if (s.todayPrice && s.weekAgoClose) {
            s.weekChange = +(((s.todayPrice - s.weekAgoClose) / s.weekAgoClose) * 100).toFixed(2);
          }
          if (s.todayPrice && s.monthAgoClose) {
            s.monthChange = +(((s.todayPrice - s.monthAgoClose) / s.monthAgoClose) * 100).toFixed(2);
          }
          done++;
          if (done % 25 === 0) showToast(`已补全 ${done}/${works.length} 只...`, 'info');
        });
        showToast('刷新完成', 'success');
      } finally {
        filterRefreshing.value = false;
      }
    }

    // ============================================================
    //  设置 / 导入导出
    // ============================================================
    const showSettings = ref(false);
    const settingsText = ref('');
    const proxyUrl = ref('');
    watch(showSettings, v => {
      if (v) {
        settingsText.value = (D.settings.categories || []).join('\n');
        proxyUrl.value = D.settings.proxyUrl || '';
      }
    });
    const dataStats = computed(() => ({
      news: D.news.length,
      pools: D.stockPools.length
    }));
    function saveSettings() {
      const cats = settingsText.value.split('\n').map(s => s.trim()).filter(Boolean);
      if (!cats.length) {
        showToast('至少保留一个分类', 'error');
        return;
      }
      Store.setCategories(cats);
      // 保存代理地址（去除末尾斜杠）
      D.settings.proxyUrl = (proxyUrl.value || '').trim().replace(/\/+$/, '');
      showToast('设置已保存', 'success');
      showSettings.value = false;
    }
    function clearAllData() {
      if (!confirm('确认清空全部数据？此操作不可恢复！建议先导出备份。')) return;
      Store.clearAll();
      showToast('已清空全部数据', 'success');
      showSettings.value = false;
    }

    function exportData() {
      const blob = new Blob([Store.exportJSON()], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `stock-news-backup-${Store.today()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('数据已导出', 'success');
    }
    function importData(e) {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        try {
          Store.importJSON(ev.target.result);
          showToast('数据已导入', 'success');
        } catch (err) {
          showToast('导入失败：文件格式错误', 'error');
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    }

    // ============================================================
    //  云端登录与数据同步（GitHub Gist）
    // ============================================================
    const cloud = reactive({
      loggedIn: false,
      user: '',
      token: '',
      gistId: '',
      autoSync: false,
      lastSync: '',
      syncing: false
    });
    const cloudModal = reactive({ show: false, token: '' });
    let _autoSyncTimer = null;
    let _autoSyncUnwatch = null;

    // 初始化：恢复登录状态
    (function initCloud() {
      const creds = CloudSync.getCreds();
      if (creds && creds.token) {
        cloud.token = creds.token;
        cloud.gistId = creds.gistId || '';
        cloud.autoSync = creds.autoSync || false;
        // 后台验证 token 是否仍然有效
        CloudSync.verifyToken(creds.token).then(u => {
          cloud.loggedIn = true;
          cloud.user = u.name || u.login;
          cloud.lastSync = creds.lastSync || '';
          if (cloud.autoSync) setupAutoSync();
        }).catch(() => {
          // token 失效，清除
          CloudSync.clearCreds();
        });
      }
    })();

    function openCloudModal() {
      cloudModal.token = cloud.token || '';
      cloudModal.show = true;
    }

    async function cloudLogin() {
      const token = (cloudModal.token || '').trim();
      if (!token) { showToast('请输入 GitHub Token', 'error'); return; }
      cloud.syncing = true;
      try {
        const result = await CloudSync.loginAndLoad(token);
        cloud.token = token;
        cloud.user = result.user.name || result.user.login;
        cloud.gistId = result.gistId || '';
        cloud.loggedIn = true;
        CloudSync.setCreds({ token, gistId: cloud.gistId, autoSync: cloud.autoSync, lastSync: cloud.lastSync });
        // 如果云端有数据，提示加载
        if (result.cloudData) {
          if (confirm('云端已有数据，是否加载到本地？（会覆盖当前本地数据）')) {
            loadCloudData(result.cloudData);
            cloud.lastSync = new Date().toLocaleString('zh-CN');
            CloudSync.setCreds({ token, gistId: cloud.gistId, autoSync: cloud.autoSync, lastSync: cloud.lastSync });
            showToast('已从云端加载数据', 'success');
          }
        } else {
          showToast('登录成功！可点「保存到云端」备份当前数据', 'success');
        }
        cloudModal.show = false;
      } catch (e) {
        showToast('登录失败：' + e.message, 'error');
      } finally {
        cloud.syncing = false;
      }
    }

    async function syncToCloud() {
      if (!cloud.token) { showToast('请先登录', 'error'); return; }
      cloud.syncing = true;
      try {
        const newId = await CloudSync.save(cloud.token, cloud.gistId, Store.exportJSON() ? JSON.parse(Store.exportJSON()) : D);
        cloud.gistId = newId;
        cloud.lastSync = new Date().toLocaleString('zh-CN');
        CloudSync.setCreds({ token: cloud.token, gistId: cloud.gistId, autoSync: cloud.autoSync, lastSync: cloud.lastSync });
        showToast('已保存到云端 ✓', 'success');
      } catch (e) {
        showToast('保存失败：' + e.message, 'error');
      } finally {
        cloud.syncing = false;
      }
    }

    async function syncFromCloud() {
      if (!cloud.token || !cloud.gistId) { showToast('云端暂无数据，请先保存', 'error'); return; }
      if (!confirm('从云端加载会覆盖当前本地数据，是否继续？')) return;
      cloud.syncing = true;
      try {
        const data = await CloudSync.loadGist(cloud.token, cloud.gistId);
        loadCloudData(data);
        cloud.lastSync = new Date().toLocaleString('zh-CN');
        CloudSync.setCreds({ token: cloud.token, gistId: cloud.gistId, autoSync: cloud.autoSync, lastSync: cloud.lastSync });
        showToast('已从云端加载 ✓', 'success');
      } catch (e) {
        showToast('加载失败：' + e.message, 'error');
      } finally {
        cloud.syncing = false;
      }
    }

    function loadCloudData(data) {
      // 用云端数据覆盖本地
      if (data.news) { D.news.splice(0, D.news.length, ...data.news); }
      if (data.stockPools) { D.stockPools.splice(0, D.stockPools.length, ...data.stockPools); }
      // 恢复「概念行业选股」板块（含 AI 语义搜索保存的板块及其相关度字段），否则跨设备从云端加载会丢失
      if (data.sectorPools) { D.sectorPools.splice(0, D.sectorPools.length, ...data.sectorPools); }
      if (data.dailyData) { Object.keys(D.dailyData).forEach(k => delete D.dailyData[k]); Object.assign(D.dailyData, data.dailyData); }
      if (data.settings) { Object.assign(D.settings, data.settings); }
      if (data.hotBoards) D.hotBoards = data.hotBoards;
      if (data.hotStocks) D.hotStocks = data.hotStocks;
      if (data.preMarketBoards) D.preMarketBoards = data.preMarketBoards;
      if (data.amplitudeBoards) D.amplitudeBoards = data.amplitudeBoards;
      // 迁移 relatedStocks
      D.news.forEach(n => {
        if (typeof n.relatedStocks === 'string') n.relatedStocks = StockAPI.parseStockInput(n.relatedStocks);
        else if (!Array.isArray(n.relatedStocks)) n.relatedStocks = [];
      });
    }

    function cloudLogout() {
      CloudSync.clearCreds();
      stopAutoSync();
      cloud.loggedIn = false;
      cloud.user = '';
      cloud.token = '';
      cloud.gistId = '';
      cloud.autoSync = false;
      showToast('已退出云端登录', 'info');
    }

    function toggleAutoSync() {
      CloudSync.setCreds({ token: cloud.token, gistId: cloud.gistId, autoSync: cloud.autoSync, lastSync: cloud.lastSync });
      if (cloud.autoSync) { setupAutoSync(); showToast('已开启自动同步', 'success'); }
      else { stopAutoSync(); showToast('已关闭自动同步', 'info'); }
    }

    function setupAutoSync() {
      if (_autoSyncUnwatch) { _autoSyncUnwatch(); _autoSyncUnwatch = null; }
      if (_autoSyncTimer) clearTimeout(_autoSyncTimer);
      _autoSyncUnwatch = Vue.watch(() => JSON.stringify(D), () => {
        if (!cloud.loggedIn || !cloud.autoSync) return;
        // 暂停自动刷新时同步暂停「自动云同步」（手动点「立即同步」仍可用）
        if (autoRefreshPaused()) return;
        clearTimeout(_autoSyncTimer);
        _autoSyncTimer = setTimeout(() => {
          syncToCloud();
        }, 10000); // 数据变化后 10 秒自动同步
      }, { deep: true });
    }

    function stopAutoSync() {
      if (_autoSyncUnwatch) { _autoSyncUnwatch(); _autoSyncUnwatch = null; }
      if (_autoSyncTimer) { clearTimeout(_autoSyncTimer); _autoSyncTimer = null; }
    }

    // 暴露到模板
    return {
      // 全局
      D, currentPage, tabs, goPage,
      toast, showToast,
      // 数据刷新总开关（顶部「暂停」按钮）
      dataPaused, autoRefreshPaused, toggleDataPause,
      allCategories, fmt, fmtPct, fmtDateCN, numClass, pctClass, parseStocks, stocksText, pureCode,
      fmtYi, sRatio,
      showSettings, settingsText, proxyUrl, saveSettings, clearAllData, dataStats,
      exportData, importData,
      // 云端同步
      cloud, cloudModal, openCloudModal, cloudLogin, syncToCloud, syncFromCloud, cloudLogout, toggleAutoSync,
      // 页面1
      newsFilter, selectedNewsIds, sortedNews, filteredNews,
      financePush, toggleFinanceLock,
      financePushNews, onFinanceStockSearch, addFinanceStock, removeFinanceStock, pushFinanceNews,
      sortKey, sortDir, sortBy, sortIcon,
      allNewsSelected, toggleSelectAll, invertSelection, selectAllNews, clearSelection, deleteSelectedNews,
      newsModal, openAddNews, editNews, saveNews, deleteNews,
      onStockSearchInput, addStock, removeStock, closeStockSuggestions,
      fillPriceForNews, refreshAllPrices, priceLoading,
      importModal, openImportDialog, previewImportCount, doPasteImport, doScrapeImport,
      // 页面2
      pools: D.stockPools, sortedPools, poolLoading,
      poolModal, openAddPool, openEditPool, savePool, deletePool, pickDailyStocks,
      poolDetail, openPoolDetail, startEditPoolName, savePoolName, refreshPoolPrices, refreshPoolDetail,
      addPoolStocks, removePoolStock, sortedPoolDetailStocks, sortPoolDetailBy, poolSortIcon,
      // 页面2.5：概念行业选股
      sectorSearch, sectorResults, sectorSearching, sectorLoading,
      sectorLoadError, sectorLoadingAll, reloadSectors, loadAllSectors, refreshSectorData,
      sectorDetail, sortedSectorPools, searchSector, addSectorFromSearch,
      sectorSubKeyword, searchSubSectors, clearSubSectorSearch, filteredSectorPools,
      // 板块卡片拖动排序 + 一键刷新（仅日涨跌）
      poolDragId, poolDropId, onPoolDragStart, onPoolDragOver, onPoolDrop, onPoolDragEnd,
      openPoolCard, resetPoolOrder, sectorPoolsRefreshing, refreshSectorPoolsDailyChange,
      // 个股搜索添加（板块详情 / 热门明细 / 筛选板块三处共用）
      quickAdd, quickAddSearch, quickAddBlur, quickAddPick, quickAddSubmit,
    sectorResultsMain, sectorResultsSub, sectorResultsIdx,
      sectorPick, sectorPickCount, toggleSelectAllSector, confirmSectorPick,
      visibleSectorPickStocks, sectorPickFiltered,
      sectorPickIndustries, sectorPickIndustryLoaded, loadSectorPickIndustries,
      sectorSel, sectorSelCount, sectorSelIntersecting, sectorSelError,
      addSubSector, removeSubSector, clearSectorSel, startIntersectFilter, openSectorSelPick,
      loadSectorStocks, refreshSectorDetail, openSectorDetail, startEditSectorName,
      saveSectorName, deleteSectorPool, removeSectorStock,
      sortedSectorDetailStocks, sortSectorDetailBy, sectorSortIcon,
      sectorFilter, sectorDetailIndustries, filteredSectorDetailStocks,
      resetSectorFilter, toggleSectorFilterLock, sectorIndustryOpen,
      sectorFilterOpen, sectorInfoOpen, favInfoOpen, filterInfoOpen, poolInfoOpen,
      // AI 语义选股（含结果 增删改）
      semantic, semanticSearch, saveSemanticAsPool,
      recomputeSemanticStocks, onConceptChanged, onBoardChanged,
      editingConceptIdx, conceptDraft, newConceptText, startEditConcept, commitEditConcept, cancelEditConcept, removeConcept, addConcept,
      editingBoardIdx, boardDraft, boardAddKw, boardAddMatches, boardAdding, startEditBoard, commitEditBoard, cancelEditBoard, removeBoard, searchBoardForAdd, addBoard,
      editingStockCode, stockNameDraft, stockRoleDraft, stockConceptsDraft, stockAddCode, stockAdding, startEditStock, commitEditStock, cancelEditStock, removeStock, addStockByCode,
      // 反推业务
      reverse, reverseSorted, reverseSort, setReverseSort, reverseBusiness, reverseSortIcon,
      // 页面3
      hotDate, hotLoading, hotBoards, hotStocks, preMarketBoards, amplitudeBoards, conceptFreq,
      hotBoardActive, hotBoardLoading, hotDetailIsStock, openHotBoard, openHotStock, clearHotBoard,
      hotFilterStocks,
      hotSearchCode, hotSearchName, clearHotSearch,
      sortedHotStocks, sortHotBy, hotSortIcon, removeHotStock,
      loadHotData, fetchHotBoards, refreshHotStocks,
      refreshAmplitudeBoards, ampLoading, hotPanelsHidden, financePushHidden,
      // 全球信息页：火热话题 + 美股美债
      hotTopicsSources, hotTopicsMerged, hotTopicsLoading, hotTopicsUpdated, usMarket, refreshHotTopics,
      htTab, htMode, hotTopicDate, hotTopicDateHasData, htCatFilter, htCategories, htRangeOptions, localSnapshotDates,
      analysisRange, analysisLoading, analysisResult, filteredHotSources,
      catColor, htSourceColor, htSourceName, ratioClass, setHtMode, onHotTopicDateChange, runAnalysis,
      toggleThemeTopic, moreThemeNews,
      // 筛选板块
      filterPanel, openFilterPanel, resetFilter, applyFilterPool, toggleFilterLock,
      filteredFilterStocks, sortedFilterStocks, sortFilterBy, filterSortIcon,
      positiveCount, POSITIVE_KEYS,
      mainBusinessText, mainBizKcfRatio, stockConcepts, contractLiabCell,
      // 统一股票表（四表共用列定义与单元格渲染）
      getColumns, cellHtml, cellClass, isNumCol, onStockSort, stockSortIcon, onTableClick, onTableChange, STOCK_COLUMNS,
      filterIndustries, filterIndustryOpen,
      filterRefreshing, refreshFilterStocks, filterFilterOpen, favPanelOpen,
      sortedSectorPools, sortedPools,
      // 通用：收藏
      favorites, sortedFavorites, isFav, toggleFavorite, removeFavorite,
      updateFavNote, favDays,
      favAddCode, favAddName, addFavoriteManual,
      favRefreshing, refreshFavorites
      ,
      // 登录账号与权限
      authUser, authInitial, authExpiryText, can, fmtDateTime, doLogout, userMenuOpen,
      userModal, userList, openUserManage, addUserByAdmin, changeUserRole,
      toggleUserDisabled, removeUserByAdmin, resetUserPassword,
      exportUsersTable, importUsersTable,
      pwModal, openChangePassword, submitChangePassword
    };
  }
});

app.mount('#app');
