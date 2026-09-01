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
      { key: 'pools', label: '股票池', icon: '📅' },
      { key: 'sector', label: '概念行业选股', icon: '🧭' },
      { key: 'filter', label: '筛选板块', icon: '🎯' },
      { key: 'hot', label: '热门板块', icon: '🔥' }
    ];
    function goPage(key) {
      currentPage.value = key;
      location.hash = key;
    }
    // 初始化路由
    const hash = location.hash.replace('#', '');
    if (['news', 'pools', 'sector', 'filter', 'hot'].includes(hash)) currentPage.value = hash;

    // ===== Toast =====
    const toast = reactive({ show: false, msg: '', type: 'info', _t: null });
    function showToast(msg, type = 'info') {
      toast.msg = msg;
      toast.type = type;
      toast.show = true;
      clearTimeout(toast._t);
      toast._t = setTimeout(() => (toast.show = false), 2800);
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
      return [...(D.favorites || [])].sort((a, b) => (b.favDate || '').localeCompare(a.favDate || ''));
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
        // 复制现有数据字段（若来源已带行情/财务数据则一并保存）
        const keys = ['industry','dailyChange','amplitude','capitalFlow','shareholderCount','prevShareholderCount',
          'profitYoY','revenueYoY','hbGrowth','kcfYoY','revHb','kcfHb','q24Rev','q24Kcf',
          'netProfit','kcfjcxjlr','revenue','totalMarketCap',
          'contractLiab','todayPrice','yearStartPrice','price924','yearChange','change924','turnover'];
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
        // 2) 财务/股东数据（东财，best-effort）
        for (let i = 0; i < favs.length; i++) {
          const f = favs[i];
          try {
            const [flow, fin] = await Promise.all([
              StockAPI.getCapitalFlow(f.code),
              StockAPI.getFinance(f.code)
            ]);
            if (flow != null) f.capitalFlow = flow;
            if (fin.profitYoY != null) f.profitYoY = fin.profitYoY;
            if (fin.revenueYoY != null) f.revenueYoY = fin.revenueYoY;
            if (fin.hbGrowth != null) f.hbGrowth = fin.hbGrowth;
            if (fin.kcfYoY != null) f.kcfYoY = fin.kcfYoY;
            if (fin.revHb != null) f.revHb = fin.revHb;
            if (fin.kcfHb != null) f.kcfHb = fin.kcfHb;
            if (fin.netProfit != null) f.netProfit = fin.netProfit;
            if (fin.kcfjcxjlr != null) f.kcfjcxjlr = fin.kcfjcxjlr;
            if (fin.revenue != null) f.revenue = fin.revenue;
            if (fin.contractLiab != null) f.contractLiab = fin.contractLiab;
            if (fin.shareholderCount != null) f.shareholderCount = fin.shareholderCount;
            if (fin.prevShareholderCount != null) f.prevShareholderCount = fin.prevShareholderCount;
          } catch (e) { console.warn('收藏财务数据获取失败', f.code, e); }
          // 24营比 / 24扣比（季报营收/扣非对比2024同期）
          try {
            const q24 = await StockAPI.getQuarterlyFinance(f.code);
            if (q24.q24Rev != null) f.q24Rev = q24.q24Rev;
            if (q24.q24Kcf != null) f.q24Kcf = q24.q24Kcf;
          } catch (e) { console.warn('收藏季报对比获取失败', f.code, e); }
          try {
            const yp = await StockAPI.getYearStartPrice(f.code);
            if (yp != null) f.yearStartPrice = yp;
            if (f.price924 == null) {
              const p924 = await StockAPI.get924Price(f.code);
              if (p924 != null) f.price924 = p924;
            }
          } catch (e) { console.warn('收藏历史价获取失败', f.code, e); }
          if (f.todayPrice && f.yearStartPrice) {
            f.yearChange = +(((f.todayPrice - f.yearStartPrice) / f.yearStartPrice) * 100).toFixed(2);
          }
          if (f.todayPrice && f.price924) {
            f.change924 = +(((f.todayPrice - f.price924) / f.price924) * 100).toFixed(2);
          }
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
      // 尝试批量补价
      nextTick(() => {
        const fresh = D.news.slice(0, added);
        setTimeout(() => refreshAllPrices(), 300);
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
        setTimeout(() => refreshAllPrices(), 300);
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
        // 24营比 / 24扣比（季报营收/扣非对比2024同期）
        try {
          const q24 = await StockAPI.getQuarterlyFinance(s.code);
          if (q24.q24Rev != null) s.q24Rev = q24.q24Rev;
          if (q24.q24Kcf != null) s.q24Kcf = q24.q24Kcf;
        } catch (e) {
          console.warn('季报对比获取失败', s.code, e);
        }
        // 年初价 + 924价（不复权历史收盘），每只容错
        try {
          const yp = await StockAPI.getYearStartPrice(s.code);
          if (yp != null) s.yearStartPrice = yp;
          if (s.price924 == null) {
            const p924 = await StockAPI.get924Price(s.code);
            if (p924 != null) s.price924 = p924;
          }
        } catch (e) {
          console.warn('历史价获取失败', s.code, e);
        }
        // 重新计算年初涨跌幅、924涨跌幅
        if (s.todayPrice && s.yearStartPrice) {
          s.yearChange = +(((s.todayPrice - s.yearStartPrice) / s.yearStartPrice) * 100).toFixed(2);
        }
        if (s.todayPrice && s.price924) {
          s.change924 = +(((s.todayPrice - s.price924) / s.price924) * 100).toFixed(2);
        }
        // 每 5 只让出一次事件循环，避免卡顿
        if ((i + 1) % 5 === 0) await new Promise(r => setTimeout(r, 0));
      }
      showToast('数据刷新完成', 'success');
    }

    /** 取股票池详情某列的排序值（含计算字段 市净比/市扣比/市营比/同比/环比系列、散户差额） */
    function poolVal(s, key) {
      if (key === 'pbRatio' || key === 'pkRatio' || key === 'pyRatio' || key === 'pk2Ratio' || key === 'phRatio' || key === 'prRatio' || key === 'prrRatio' || key === 'ph2Ratio' || key === 'pkHbRatio') {
        const r = sRatio(s);
        return r[key];
      }
      if (key === 'shareholderDiff') {
        return (s.shareholderCount != null && s.prevShareholderCount != null)
          ? +(s.shareholderCount - s.prevShareholderCount) : null;
      }
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
    const sectorSearching = ref(false);
    const sectorLoading = ref(false);    // 板块成分股加载中
    const sectorDetail = reactive({ show: false, data: { stocks: [] }, nameEdit: false, nameDraft: '' });
    const sectorDetailSort = reactive({ key: 'dailyChange', dir: 'desc' });
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

    // 已保存板块按创建时间倒序
    const sortedSectorPools = computed(() => [...D.sectorPools].slice().reverse());

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
      const list = [...(sectorDetail.data.stocks || [])];
      const k = sectorDetailSort.key;
      const dir = sectorDetailSort.dir === 'asc' ? 1 : -1;
      list.sort((a, b) => compareForSort(a, b, k) * dir);
      return list;
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
    //  页面3：热门板块
    // ============================================================
    const hotDate = ref(Store.today());
    const hotLoading = ref(false);
    const hotBoards = ref([]);
    const hotStocks = ref([]);
    const hotSort = reactive({ key: 'dailyChange', dir: 'desc' });

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
      const list = daily ? [...daily.stocks] : [];
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

    async function fetchHotBoards() {
      hotLoading.value = true;
      showToast('正在获取热门板块...', 'info');
      try {
        const [boards, stocks] = await Promise.all([
          StockAPI.getBoardRanking(),
          StockAPI.getStockRanking()
        ]);
        hotBoards.value = boards;
        hotStocks.value = stocks;
        D.hotBoards = boards;
        D.hotStocks = stocks;
        showToast(boards.length ? `获取到 ${boards.length} 个板块、${stocks.length} 只热门股票` : '获取失败（网络限制），可稍后重试', boards.length ? 'success' : 'error');
      } catch (e) {
        showToast('获取失败', 'error');
      } finally {
        hotLoading.value = false;
      }
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
        }
      }
      hotLoading.value = false;
      showToast('行情已刷新', 'success');
    }

    // 初始化时若有缓存的热门数据则恢复
    if (D.hotBoards && D.hotBoards.length) hotBoards.value = D.hotBoards;
    if (D.hotStocks && D.hotStocks.length) hotStocks.value = D.hotStocks;

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
      q24kMin: null, q24kMax: null  // 24扣比区间
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
    }
    /** 切换板块后重置区间筛选；若已固定则保留区间 */
    function applyFilterPool() {
      if (filterPanel.locked) return;
      filterPanel.pbMin = null; filterPanel.pbMax = null;
      filterPanel.pkMin = null; filterPanel.pkMax = null;
      filterPanel.prMin = null; filterPanel.prMax = null;
      filterPanel.q24Min = null; filterPanel.q24Max = null;
      filterPanel.q24kMin = null; filterPanel.q24kMax = null;
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
      if (id.startsWith('s-')) {
        const sp = (D.sectorPools || []).find(p => 's-' + p.id === id);
        return sp ? (sp.stocks || []) : [];
      }
      const pp = (D.stockPools || []).find(p => 'p-' + p.id === id);
      return pp ? (pp.stocks || []) : [];
    });
    /** 按板块 + 市净比/市扣比/市营比/24营比/24扣比区间过滤后的股票 */
    const filteredFilterStocks = computed(() => {
      return filterPoolStocks.value.filter(s => {
        const r = sRatio(s);
        if (!inRange(r.pbRatio, filterPanel.pbMin, filterPanel.pbMax)) return false;
        if (!inRange(r.pkRatio, filterPanel.pkMin, filterPanel.pkMax)) return false;
        if (!inRange(r.prRatio, filterPanel.prMin, filterPanel.prMax)) return false;
        if (!inRange(s.q24Rev, filterPanel.q24Min, filterPanel.q24Max)) return false;
        if (!inRange(s.q24Kcf, filterPanel.q24kMin, filterPanel.q24kMax)) return false;
        return true;
      });
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

    // 刷新筛选板块下所有股票的行情/财务数据
    const filterRefreshing = ref(false);
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
          // 24营比 / 24扣比（季报对比2024同期）
          try {
            const q24 = await StockAPI.getQuarterlyFinance(s.code);
            if (q24.q24Rev != null) s.q24Rev = q24.q24Rev;
            if (q24.q24Kcf != null) s.q24Kcf = q24.q24Kcf;
          } catch (e) {
            console.warn('季报对比获取失败', s.code, e);
          }
          // 年初价 + 924价
          try {
            const yp = await StockAPI.getYearStartPrice(s.code);
            if (yp != null) s.yearStartPrice = yp;
            if (s.price924 == null) {
              const p924 = await StockAPI.get924Price(s.code);
              if (p924 != null) s.price924 = p924;
            }
          } catch (e) {
            console.warn('历史价获取失败', s.code, e);
          }
          if (s.todayPrice && s.yearStartPrice) {
            s.yearChange = +(((s.todayPrice - s.yearStartPrice) / s.yearStartPrice) * 100).toFixed(2);
          }
          if (s.todayPrice && s.price924) {
            s.change924 = +(((s.todayPrice - s.price924) / s.price924) * 100).toFixed(2);
          }
        }
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
      if (data.dailyData) { Object.keys(D.dailyData).forEach(k => delete D.dailyData[k]); Object.assign(D.dailyData, data.dailyData); }
      if (data.settings) { Object.assign(D.settings, data.settings); }
      if (data.hotBoards) D.hotBoards = data.hotBoards;
      if (data.hotStocks) D.hotStocks = data.hotStocks;
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
      allCategories, fmt, fmtPct, fmtDateCN, numClass, pctClass, parseStocks, stocksText, pureCode,
      fmtYi, sRatio,
      showSettings, settingsText, proxyUrl, saveSettings, clearAllData, dataStats,
      exportData, importData,
      // 云端同步
      cloud, cloudModal, openCloudModal, cloudLogin, syncToCloud, syncFromCloud, cloudLogout, toggleAutoSync,
      // 页面1
      newsFilter, selectedNewsIds, sortedNews, filteredNews,
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
      sectorLoadError, sectorLoadingAll, reloadSectors, loadAllSectors,
      sectorDetail, sortedSectorPools, searchSector, addSectorFromSearch,
      sectorPick, sectorPickCount, toggleSelectAllSector, confirmSectorPick,
      visibleSectorPickStocks, sectorPickFiltered,
      sectorPickIndustries, sectorPickIndustryLoaded, loadSectorPickIndustries,
      sectorSel, sectorSelCount, sectorSelIntersecting, sectorSelError,
      addSubSector, removeSubSector, clearSectorSel, startIntersectFilter, openSectorSelPick,
      loadSectorStocks, refreshSectorDetail, openSectorDetail, startEditSectorName,
      saveSectorName, deleteSectorPool, removeSectorStock,
      sortedSectorDetailStocks, sortSectorDetailBy, sectorSortIcon,
      // 页面3
      hotDate, hotLoading, hotBoards, hotStocks, conceptFreq,
      sortedHotStocks, sortHotBy, hotSortIcon, removeHotStock,
      loadHotData, fetchHotBoards, refreshHotStocks,
      // 筛选板块
      filterPanel, openFilterPanel, resetFilter, applyFilterPool, toggleFilterLock,
      filteredFilterStocks, sortedFilterStocks, sortFilterBy, filterSortIcon,
      filterRefreshing, refreshFilterStocks,
      sortedSectorPools, sortedPools,
      // 通用：收藏
      favorites, sortedFavorites, isFav, toggleFavorite, removeFavorite,
      updateFavNote, favDays,
      favAddCode, favAddName, addFavoriteManual,
      favRefreshing, refreshFavorites
    };
  }
});

app.mount('#app');
