/**
 * 腾讯股票 API 封装层
 *
 * 数据源：
 *  1. 实时行情：https://qt.gtimg.cn/q=sh600519  （GBK 编码，返回 v_code="..." 格式，支持 CORS）
 *  2. 历史K线：https://web.ifzq.gtimg.cn/appstock/app/fqkline/get （JSON，支持 CORS，不复权取真实价）
 *  3. 东方财富（补充）：资金流向 / 财务数据 / 股东人数 （best-effort，部分网络受限）
 *
 * 股票代码格式：sh600519（上海）、sz000001（深圳）、sh688xxx（科创板）、sz30xxxx（创业板）
 */
const StockAPI = {

  // ============ 代码解析 ============

  /** 根据纯数字代码推断市场前缀 */
  inferPrefix(code) {
    code = String(code).trim();
    // 已经带前缀
    if (/^(sh|sz|bj)/i.test(code)) return code.toLowerCase();
    const pure = code.replace(/\D/g, '');
    if (/^6[89]/.test(pure)) return 'sh' + pure;        // 科创板 688 / 主板 60x
    if (/^6/.test(pure)) return 'sh' + pure;             // 上海主板
    if (/^[45]/.test(pure)) return 'sh' + pure;          // 权证等
    if (/^9/.test(pure)) return 'sh' + pure;
    if (/^3/.test(pure)) return 'sz' + pure;             // 创业板
    if (/^0/.test(pure)) return 'sz' + pure;             // 深圳主板
    if (/^2/.test(pure)) return 'sz' + pure;
    if (/^8/.test(pure)) return 'bj' + pure;             // 北交所
    return 'sz' + pure;
  },

  /**
   * 解析用户输入的股票字符串
   * 支持：贵州茅台(600519)、600519、sh600519、贵州茅台
   * 返回 [{ code, name }]
   */
  parseStockInput(text) {
    if (!text) return [];
    const results = [];
    // 按 逗号/分号/换行 分割
    const parts = text.split(/[,;，；\n\r]+/).map(s => s.trim()).filter(Boolean);
    for (const part of parts) {
      const m = part.match(/^(.*?)\s*[（(]\s*(\d{4,8})\s*[）)]\s*$/);
      if (m) {
        results.push({ name: m[1].trim(), code: this.inferPrefix(m[2]) });
        continue;
      }
      // 纯代码
      if (/^\d{4,8}$/.test(part)) {
        results.push({ name: '', code: this.inferPrefix(part) });
        continue;
      }
      // 已带前缀
      if (/^(sh|sz|bj)\d{4,8}$/i.test(part)) {
        results.push({ name: '', code: part.toLowerCase() });
        continue;
      }
      // 纯名称（暂无代码，后续可查）
      results.push({ name: part, code: '' });
    }
    return results;
  },

  // ============ 股票搜索联想 ============

  _searchSeq: 0,

  /**
   * 搜索股票（腾讯 smartbox 接口，通过 script 标签加载，绕过 CORS）
   * 输入名称或代码，返回联想结果
   * @returns {Array<{market, code, pureCode, name, pinyin}>}
   */
  searchStocks(keyword) {
    const kw = (keyword || '').trim();
    if (!kw) return Promise.resolve([]);
    const mySeq = ++this._searchSeq;
    return new Promise((resolve) => {
      const script = document.createElement('script');
      script.charset = 'utf-8';
      script.src = `https://smartbox.gtimg.cn/s3/?t=all&q=${encodeURIComponent(kw)}`;
      const cleanup = () => {
        if (script.parentNode) script.parentNode.removeChild(script);
        try { delete window.v_hint; } catch (e) { window.v_hint = undefined; }
      };
      script.onload = () => {
        // 只处理最新一次请求，避免快速输入时旧结果覆盖新结果
        if (mySeq !== this._searchSeq) { cleanup(); resolve([]); return; }
        const raw = window.v_hint;
        cleanup();
        resolve(this._parseHints(raw));
      };
      script.onerror = () => { cleanup(); resolve([]); };
      document.body.appendChild(script);
    });
  },

  _parseHints(raw) {
    if (!raw) return [];
    const items = raw.split('^');
    const results = [];
    for (const item of items) {
      const parts = item.split('~');
      if (parts.length >= 3 && parts[0] && parts[1] && parts[2]) {
        results.push({
          market: parts[0],
          code: parts[0] + parts[1],
          pureCode: parts[1],
          name: parts[2],
          pinyin: parts[3] || '',
          type: parts[4] || ''
        });
      }
    }
    return results;
  },

  /** 从 code 提取纯数字 */
  pureCode(code) {
    return String(code || '').replace(/^(sh|sz|bj)/i, '');
  },

  /** 东财 secid 格式：1.600519（沪）、0.000001（深） */
  toEastSecid(code) {
    const c = String(code);
    const pure = this.pureCode(c);
    if (/^sh/i.test(c) || /^bj/i.test(c)) return '1.' + pure;
    return '0.' + pure;
  },

  // ============ 实时行情 ============

  /**
   * 批量获取实时行情（腾讯接口）
   * @param {string[]} codes  ['sh600519','sz000001']
   * @returns {Object} { 'sh600519': { name, code, price, ... } }
   */
  async getQuotes(codes) {
    if (!codes || !codes.length) return {};
    const valid = codes.filter(c => c);
    if (!valid.length) return {};
    const query = valid.join(',');
    try {
      const resp = await fetch(`https://qt.gtimg.cn/q=${query}`, { cache: 'no-store' });
      const buffer = await resp.arrayBuffer();
      const text = new TextDecoder('gbk').decode(buffer);
      return this._parseQuotes(text);
    } catch (e) {
      console.error('获取行情失败', e);
      return {};
    }
  },

  /** 获取单只股票行情 */
  async getQuote(code) {
    const r = await this.getQuotes([code]);
    return r[code] || null;
  },

  _parseQuotes(text) {
    const result = {};
    // 匹配 v_sh600519="..."; 多组
    const reg = /v_(\w+)\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = reg.exec(text)) !== null) {
      const code = m[1];
      const fields = m[2].split('~');
      result[code] = this._buildQuote(code, fields);
    }
    return result;
  },

  _buildQuote(code, f) {
    // 字段索引（腾讯行情标准定义）
    // 0:市场 1:名称 2:代码 3:当前价 4:昨收 5:今开
    // 6:成交量(手) 9-28:五档买卖 30:时间戳 31:涨跌额 32:涨跌幅
    // 33:最高 34:最低 38:换手率 39:市盈率 43:振幅 44:流通市值 45:总市值 46:市净率
    const current = parseFloat(f[3]) || 0;
    const yclose = parseFloat(f[4]) || 0;
    const high = parseFloat(f[33]) || 0;
    const low = parseFloat(f[34]) || 0;
    const changePct = parseFloat(f[32]);
    const amplitude = parseFloat(f[43]);
    // 兜底计算振幅
    const ampCalc = yclose > 0 ? +((high - low) / yclose * 100).toFixed(2) : 0;
    return {
      code: code,
      name: f[1] || '',
      price: current,
      yesterdayClose: yclose,
      open: parseFloat(f[5]) || 0,
      volume: parseFloat(f[6]) || 0,        // 手
      amount: parseFloat(f[37]) || 0,        // 成交额(万)
      changePercent: isNaN(changePct) ? 0 : changePct,
      high: high,
      low: low,
      amplitude: isNaN(amplitude) ? ampCalc : amplitude,   // %
      turnover: parseFloat(f[38]) || 0,      // 换手率 %
      pe: parseFloat(f[39]) || 0,            // 市盈率
      floatMarketCap: parseFloat(f[44]) || 0, // 流通市值(亿)
      totalMarketCap: parseFloat(f[45]) || 0, // 总市值(亿)
      pb: parseFloat(f[46]) || 0,            // 市净率
      timestamp: f[30] || ''
    };
  },

  // ============ 历史价格 ============

  /**
   * 获取某日期的收盘价（不复权真实价）
   * @param {string} code  sh600519
   * @param {string} date  2024-09-24
   * @returns {number|null}
   */
  async getHistoryClose(code, date) {
    const d = new Date(date);
    const start = this._addDays(d, -10);
    const end = this._addDays(d, 5);
    const data = await this.getKline(code, this.fmtDate(start), this.fmtDate(end));
    if (!data || !data.length) return null;
    // 精确匹配日期
    const exact = data.find(k => k.date === date);
    if (exact) return exact.close;
    // 若目标日非交易日，取最近的前一个交易日
    let prev = null;
    for (const k of data) {
      if (k.date <= date) prev = k;
    }
    return prev ? prev.close : null;
  },

  /** 获取924收盘价（2024-09-24） */
  async get924Price(code) {
    return this.getHistoryClose(code, '2024-09-24');
  },

  /**
   * 获取日K线（不复权）
   * @returns {Array<{date,open,close,high,low,volume}>}
   */
  async getKline(code, startDate, endDate) {
    // 末尾参数留空 = 不复权（真实价格）
    const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},day,${startDate},${endDate},640,`;
    try {
      const resp = await fetch(url, {
        cache: 'no-store',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://gu.qq.com/'
        }
      });
      const json = await resp.json();
      const block = json.data && json.data[code];
      if (!block) return [];
      // 不复权在 day 字段，前复权在 qfqday
      const rows = block.day || block.qfqday || [];
      return rows.map(r => ({
        date: r[0],
        open: parseFloat(r[1]),
        close: parseFloat(r[2]),
        high: parseFloat(r[3]),
        low: parseFloat(r[4]),
        volume: parseFloat(r[5])
      }));
    } catch (e) {
      console.error('获取K线失败', code, e);
      return [];
    }
  },

  // ============ 东方财富 补充数据（best-effort） ============

  /**
   * 获取资金流向（近一日主力净流入）
   * 东财 push2 接口，部分网络/地区可能受限
   * @returns {number|null} 主力净流入(元)
   */
  async getCapitalFlow(code) {
    const secid = this.toEastSecid(code);
    const url = `https://push2.eastmoney.com/api/qt/stock/fflow/daykline/get?secid=${secid}&lmt=1&klt=101&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58`;
    try {
      const resp = await fetch(url, { cache: 'no-store' });
      const json = await resp.json();
      const kls = json.data && json.data.klines;
      if (kls && kls.length) {
        const last = kls[kls.length - 1].split(',');
        // f52:主力净流入
        return parseFloat(last[1]) || null;
      }
    } catch (e) {
      console.debug('资金流向获取失败', code);
    }
    return null;
  },

  /**
   * 获取财务指标（东财 F10 财务摘要）
   * @returns {{
   *   netProfit,        // 净利润(归母，元)
   *   kcfjcxjlr,        // 扣非净利润(元)
   *   revenue,          // 营业收入(元)
   *   profitYoY,        // 利润同比增长率(%)
   *   revenueYoY,       // 同比增长率(营收同比 %)
   *   hbGrowth,         // 环比增长率(净利润环比 %)
   *   contractLiab,     // 最新合同负债(元)
   *   shareholderCount, // 散户数量(本期股东人数)
   *   prevShareholderCount // 上期散户数量
   * }}
   */
  async getFinance(code) {
    const secucode = this.toSecucode(code);
    const result = {
      netProfit: null, kcfjcxjlr: null, revenue: null,
      profitYoY: null, revenueYoY: null, hbGrowth: null,
      contractLiab: null,
      shareholderCount: null, prevShareholderCount: null
    };
    // 财务摘要（净利润/扣非/营收/各类增长率）
    try {
      const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_F10_FINANCE_MAINFINADATA&columns=ALL&filter=(SECUCODE%3D%22${secucode}%22)&pageNumber=1&pageSize=1&sortColumns=REPORT_DATE&sortTypes=-1`;
      const resp = await fetch(url, { cache: 'no-store' });
      const json = await resp.json();
      const row = json.result && json.result.data && json.result.data[0];
      if (row) {
        result.netProfit = row.PARENTNETPROFIT != null ? parseFloat(row.PARENTNETPROFIT) : null;       // 净利润(元)
        result.kcfjcxjlr = row.KCFJCXSYJLR != null ? parseFloat(row.KCFJCXSYJLR) : null;               // 扣非净利润(元)
        result.revenue = row.TOTALOPERATEREVE != null ? parseFloat(row.TOTALOPERATEREVE) : null;       // 营业收入(元)
        result.profitYoY = row.PARENTNETPROFITTZ != null ? parseFloat(row.PARENTNETPROFITTZ) : null;   // 利润同比增长(%)
        result.revenueYoY = row.TOTALOPERATEREVETZ != null ? parseFloat(row.TOTALOPERATEREVETZ) : null;// 营收同比增长(%)
        result.hbGrowth = row.NETPROFITRPHBZC != null ? parseFloat(row.NETPROFITRPHBZC) : null;        // 净利润环比(%)
      }
    } catch (e) {
      console.debug('财务摘要获取失败', code);
    }
    // 资产负债表（最新合同负债）
    try {
      const bsUrl = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_F10_FINANCE_GBALANCE&columns=ALL&filter=(SECUCODE%3D%22${secucode}%22)&pageNumber=1&pageSize=1&sortColumns=REPORT_DATE&sortTypes=-1`;
      const bsResp = await fetch(bsUrl, { cache: 'no-store' });
      const bsJson = await bsResp.json();
      const bsRow = bsJson.result && bsJson.result.data && bsJson.result.data[0];
      if (bsRow && bsRow.CONTRACT_LIAB != null) {
        result.contractLiab = parseFloat(bsRow.CONTRACT_LIAB);   // 合同负债(元)
      }
    } catch (e) {
      console.debug('资产负债表获取失败', code);
    }
    // 股东人数（本期 + 上期）
    try {
      const holderUrl = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_F10_EH_HOLDERNUM&columns=ALL&filter=(SECUCODE%3D%22${secucode}%22)&pageNumber=1&pageSize=2&sortColumns=END_DATE&sortTypes=-1`;
      const hResp = await fetch(holderUrl, { cache: 'no-store' });
      const hJson = await hResp.json();
      const rows = hJson.result && hJson.result.data;
      if (rows && rows.length) {
        result.shareholderCount = rows[0].HOLDER_TOTAL_NUM != null ? rows[0].HOLDER_TOTAL_NUM : (rows[0].HOLDER_NUM || null);
        if (rows.length > 1) {
          result.prevShareholderCount = rows[1].HOLDER_TOTAL_NUM != null ? rows[1].HOLDER_TOTAL_NUM : (rows[1].HOLDER_NUM || null);
        }
      }
    } catch (e) {
      console.debug('股东人数获取失败', code);
    }
    return result;
  },

  /**
   * 获取当年年初第一个交易日的收盘价
   * （向上取本年第一个交易日，而非回退到上一年最后一个交易日）
   * @param {string} code sh600519
   * @param {string} year 年份，如 2026；缺省为当前年份
   * @returns {number|null}
   */
  async getYearStartPrice(code, year) {
    const y = year || new Date().getFullYear();
    const yearStart = new Date(`${y}-01-01`);
    const start = this._addDays(yearStart, -10);
    const end = this._addDays(yearStart, 30);
    const data = await this.getKline(code, this.fmtDate(start), this.fmtDate(end));
    if (!data || !data.length) return null;
    // 取本年(>= y-01-01)第一个交易日，K线按日期升序返回
    const prefix = `${y}-`;
    const first = data.find(k => k.date.startsWith(prefix));
    return first ? first.close : null;
  },

  /** 转换 SECUCODE：sh600519 → 600519.SH，sz000001 → 000001.SZ，bj → .BJ */
  toSecucode(code) {
    const pure = this.pureCode(code);
    const c = String(code);
    if (/^sh/i.test(c)) return `${pure}.SH`;
    if (/^bj/i.test(c)) return `${pure}.BJ`;
    return `${pure}.SZ`;
  },

  // ============ 热门板块/股票 ============

  /**
   * 获取板块涨幅排行（东财）
   * @returns {Array<{name, change}>}
   */
  async getBoardRanking() {
    // 行业板块 fs=m:90+t:2  概念板块 fs=m:90+t:3
    const results = [];
    try {
      const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=15&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f2,f3,f12,f14`;
      const resp = await fetch(url, { cache: 'no-store' });
      const json = await resp.json();
      if (json.data && json.data.diff) {
        for (const item of json.data.diff) {
          results.push({ name: item.f14, change: parseFloat(item.f3) });
        }
      }
    } catch (e) {
      console.debug('板块排行获取失败');
    }
    return results;
  },

  /**
   * 获取个股涨幅排行（热门股票）
   * @returns {Array<{name, code, change}>}
   */
  async getStockRanking() {
    const results = [];
    try {
      // 沪深A股，按涨幅降序
      const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=15&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23&fields=f2,f3,f12,f14`;
      const resp = await fetch(url, { cache: 'no-store' });
      const json = await resp.json();
      if (json.data && json.data.diff) {
        for (const item of json.data.diff) {
          const prefix = String(item.f12).startsWith('6') ? 'sh' : 'sz';
          results.push({
            name: item.f14,
            code: prefix + item.f12,
            change: parseFloat(item.f3)
          });
        }
      }
    } catch (e) {
      console.debug('个股排行获取失败');
    }
    return results;
  },

  // ============ 工具方法 ============

  _addDays(date, n) {
    const d = new Date(date);
    d.setDate(d.getDate() + n);
    return d;
  },

  fmtDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
};
