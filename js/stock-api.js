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
  // 把东财 klines 文本数组解析成统一结构
  _parseEastKline(kl) {
    const out = [];
    for (const line of kl) {
      // klines 每项：日期,开盘,收盘,最高,最低,成交量,成交额,振幅,...（顺序由 fields2 决定）
      const p = String(line).split(',');
      const close = parseFloat(p[2]);
      if (!p[0] || isNaN(close)) continue;
      out.push({
        date: p[0],
        open: parseFloat(p[1]),
        close,
        high: parseFloat(p[3]),
        low: parseFloat(p[4]),
        volume: parseFloat(p[5])
      });
    }
    return out;
  },

  // 腾讯历史日K线兜底：web.ifzq.gtimg.cn 对浏览器返回 Access-Control-Allow-Origin:*，
  // 简单 fetch（不带自定义头）即可直连，无需 JSONP。返回节点 .day 为 [日期,开,收,高,低,量,...]。
  async _tencentKline(code, startDate, endDate, count) {
    const pure = this.pureCode(code);
    const c = String(code).toLowerCase();
    let market = 'sh';
    if (/^sz/.test(c)) market = 'sz';
    else if (/^bj/.test(c)) market = 'bj';
    else if (/^sh/.test(c)) market = 'sh';
    else if (/^[69]/.test(pure)) market = 'sh';
    else if (/^[48]/.test(pure)) market = 'bj';
    else market = 'sz';
    const beg = String(startDate || '').replace(/-/g, '');
    const end = String(endDate || '').replace(/-/g, '');
    // 根数需覆盖区间交易日数：两年区间约 480 个交易日，硬编码 320 会截断导致算不出年初价/924价
    const n = count || this._barCount(startDate, endDate);
    const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${market}${pure},day,${beg},${end},${n},bfq`;
    try {
      const resp = await fetch(url, { cache: 'no-store' });
      if (!resp.ok) return [];
      const j = await resp.json();
      const node = j && j.data && j.data[market + pure];
      const arr = node && (node.day || node.bfqday || node.qfqday);
      if (!arr || !arr.length) return [];
      const out = [];
      for (const r of arr) {
        const date = r[0];
        const close = parseFloat(r[2]);
        if (!date || isNaN(close)) continue;
        out.push({ date, open: parseFloat(r[1]), close, high: parseFloat(r[3]), low: parseFloat(r[4]), volume: parseFloat(r[5]) });
      }
      return out;
    } catch (e) {
      console.debug('腾讯K线获取失败', code, e);
      return [];
    }
  },

  async getKline(code, startDate, endDate, count) {
    const secid = this.toEastSecid(code);
    const beg = String(startDate || '').replace(/-/g, '');
    const end = String(endDate || '').replace(/-/g, '');
    // 东财日K线（klt=101 日线，fqt=0 不复权真实价）。
    // 【关键修复】必须带 ut token，否则 push2his 返回 data:null / 空 klines，
    // 导致今年高价/距高价/今年低价/距低价/年涨跌/924涨跌 六个字段空白。
    // 现仍走 _eastGet（fetch → JSONP 兜底）；若东财仍取不到，再降级到腾讯历史K线。
    const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?ut=fa5fd1943c7b386f172d6893dbfba10b&secid=${secid}` +
      `&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58` +
      `&klt=101&fqt=0&beg=${beg}&end=${end}&lmt=1000`;
    try {
      const json = await this._eastGet(url);
      const kl = json && json.data && json.data.klines;
      if (kl && kl.length) {
        const out = this._parseEastKline(kl);
        if (out.length) return out;
      }
    } catch (e) {
      console.debug('东财K线失败，尝试腾讯兜底', code, e);
    }
    // 兜底：腾讯历史日K线（已验证可达且 CORS 开放）
    try {
      const bars = await this._tencentKline(code, startDate, endDate, count);
      if (bars && bars.length) return bars;
    } catch (e) {
      console.debug('腾讯K线亦失败', code, e);
    }
    return [];
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
   *   kcfYoY,           // 扣非净利润同比增长率(%)
   *   revHb,            // 营收环比增长率(%)
   *   kcfHb,            // 扣非净利润环比增长率(%)
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
      kcfYoY: null, revHb: null, kcfHb: null,
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
        result.kcfYoY = row.KCFJCXSYJLRTZ != null ? parseFloat(row.KCFJCXSYJLRTZ) : null;               // 扣非净利润同比增长(%)
        result.revHb = row.YYZSRGDHBZC != null ? parseFloat(row.YYZSRGDHBZC) : null;                    // 营收环比增长(%)
        result.kcfHb = row.KFJLRGDHBZC != null ? parseFloat(row.KFJLRGDHBZC) : null;                    // 扣非净利润环比增长(%)
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
   * 获取个股所属一级行业（东财 F10 公司概况，best-effort）。
   * @param {string} code sh600519
   * @returns {Promise<string|null>} 如「食品饮料」「银行」
   */
  async getIndustry(code) {
    const secucode = this.toSecucode(code);
    try {
      const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_F10_ORG_BASICINFO&columns=ALL&filter=(SECUCODE%3D%22${secucode}%22)&pageNumber=1&pageSize=1`;
      const resp = await fetch(url, { cache: 'no-store' });
      const json = await resp.json();
      const row = json.result && json.result.data && json.result.data[0];
      if (row) {
        if (row.BOARD_NAME_1LEVEL) return row.BOARD_NAME_1LEVEL;
        if (row.SWINDUSTRY_NAME2) return row.SWINDUSTRY_NAME2;
        if (row.CSRC_INDUSTRY_NAME) {
          // CSRC 形如「制造业-酒、饮料和精制茶制造业」，取最后一个「-」之后的部分
          const parts = String(row.CSRC_INDUSTRY_NAME).split('-');
          return parts[parts.length - 1];
        }
      }
    } catch (e) {
      console.debug('获取行业失败', code);
    }
    return null;
  },

  /**
   * 获取个股主营构成（东财 F10 主营构成，RPT_F10_FN_MAINOP）。
   * 取最新报告期的「按产品」(MAINOP_TYPE=2) 构成，按收入占比降序返回前若干主业。
   * @param {string} code sh600519
   * @returns {Promise<Array<{name:string, ratio:number}>|null>}
   *   如 [{ name: '茅台酒', ratio: 85.7 }, { name: '其他系列酒', ratio: 14.3 }]
   */
  async getMainBusiness(code) {
    const secucode = this.toSecucode(code);
    try {
      const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_F10_FN_MAINOP&columns=ALL&filter=(SECUCODE%3D%22${secucode}%22)&pageNumber=1&pageSize=60&sortColumns=REPORT_DATE&sortTypes=-1`;
      const resp = await fetch(url, { cache: 'no-store' });
      const json = await resp.json();
      const rows = (json.result && json.result.data) || [];
      if (!rows.length) return null;
      // 报告期倒序排列，取最新一期全部构成行
      const latest = rows[0].REPORT_DATE.slice(0, 10);
      const period = rows.filter(r => (r.REPORT_DATE || '').slice(0, 10) === latest);
      // 优先「按产品」(2)，其次「按行业」(1)
      let items = period.filter(r => String(r.MAINOP_TYPE) === '2');
      if (!items.length) items = period.filter(r => String(r.MAINOP_TYPE) === '1');
      if (!items.length) items = period;
      items.sort((a, b) => (b.MBI_RATIO || 0) - (a.MBI_RATIO || 0));
      const out = [];
      for (const it of items) {
        if (!it.ITEM_NAME) continue;
        let ratio = it.MBI_RATIO != null ? it.MBI_RATIO
                  : (it.MBR_RATIO != null ? it.MBR_RATIO : null);
        if (ratio == null) continue;
        out.push({ name: String(it.ITEM_NAME), ratio: +ratio });
      }
      return out.length ? out : null;
    } catch (e) {
      console.debug('获取主营构成失败', code);
      return null;
    }
  },

  /**
   * 获取季报营收/扣非累计值序列，计算「今年最新报告期 vs 2024年同期」的增长率。
   * 用于「24营比」和「24扣比」字段。
   * @param {string} code sh600519
   * @returns {Promise<{q24Rev: number|null, q24Kcf: number|null}>}
   *   q24Rev：最新报告期营业收入 vs 2024年同期营业收入 的同比增长率(%)
   *   q24Kcf：最新报告期扣非净利润 vs 2024年同期扣非净利润 的同比增长率(%)
   */
  async getQuarterlyFinance(code) {
    const secucode = this.toSecucode(code);
    const result = { q24Rev: null, q24Kcf: null };
    try {
      // 取最近 12 期（覆盖2024全年至今），按报告期倒序
      const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_F10_FINANCE_MAINFINADATA&columns=ALL&filter=(SECUCODE%3D%22${secucode}%22)&pageNumber=1&pageSize=12&sortColumns=REPORT_DATE&sortTypes=-1`;
      const resp = await fetch(url, { cache: 'no-store' });
      const json = await resp.json();
      const rows = (json.result && json.result.data) || [];
      if (!rows.length) return result;

      // 解析每一期的报告期与数值，key 形如 "2025-09-30"
      const parse = (r) => {
        const date = (r.REPORT_DATE || '').replace('T00:00:00', '').slice(0, 10);
        return {
          date,
          rev: r.TOTALOPERATEREVE != null ? parseFloat(r.TOTALOPERATEREVE) : null,
          kcf: r.KCFJCXSYJLR != null ? parseFloat(r.KCFJCXSYJLR) : null
        };
      };
      const periods = rows.map(parse).filter(p => p.date);

      // 最新报告期
      const latest = periods[0];
      if (!latest) return result;

      // 找到与最新报告期「同年同期」的 2024 期。同期的判断：取报告的 月份日（如 09-30/06-30/03-31/12-31）
      const md = latest.date.slice(5);            // "09-30"
      const key2024 = `2024-${md}`;               // "2024-09-30"
      const target2024 = periods.find(p => p.date === key2024);
      if (!target2024) return result;

      // 营收增长
      if (latest.rev != null && target2024.rev != null && +target2024.rev !== 0) {
        result.q24Rev = +(((latest.rev - target2024.rev) / target2024.rev) * 100).toFixed(2);
      }
      // 扣非净利润增长
      if (latest.kcf != null && target2024.kcf != null && +target2024.kcf !== 0) {
        result.q24Kcf = +(((latest.kcf - target2024.kcf) / target2024.kcf) * 100).toFixed(2);
      }
    } catch (e) {
      console.debug('季报营收/扣非获取失败', code, e);
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

  /**
   * 获取某股票「今年」的最高价 / 最低价（不复权真实价）。
   * 拉取年初至今天的全部日K线，扫描 high/low 极值。
   * @param {string} code sh600519
   * @param {number} year 年份，缺省为当前年份
   * @returns {Promise<{high:number, low:number}|null>}
   */
  async getYearHighLow(code, year) {
    const y = year || new Date().getFullYear();
    try {
      const data = await this.getKline(code, `${y}-01-01`, this.fmtDate(new Date()));
      if (!data || !data.length) return null;
      let hi = -Infinity, lo = Infinity;
      for (const k of data) {
        if (k.high != null && !isNaN(k.high) && k.high > hi) hi = k.high;
        if (k.low != null && !isNaN(k.low) && k.low < lo) lo = k.low;
      }
      if (hi === -Infinity || lo === Infinity) return null;
      return { high: +hi.toFixed(2), low: +lo.toFixed(2) };
    } catch (e) {
      console.debug('今年高低价获取失败', code, e);
      return null;
    }
  },

  /**
   * 估算区间所需的 K 线根数。
   * 腾讯 fqkline 的第 5 个参数即返回根数，硬编码 320 在两年区间（约 480 个交易日）
   * 会被截断，导致取不到年初价/924价。这里按自然日折算交易日并留冗余。
   */
  _barCount(startDate, endDate) {
    try {
      const s = new Date(startDate), e = new Date(endDate);
      const days = Math.ceil((e - s) / 86400000) + 1;
      // 两年区间约 480 个交易日；根数过大时腾讯会直接返回空，故上限取 800
      return Math.min(800, Math.max(320, Math.ceil(days * 7 / 5) + 40));
    } catch (e) {
      return 640;
    }
  },

  /**
   * 一次请求取回「年初价 / 924价 / 今年最高价 / 今年最低价」四项历史价。
   *
   * 【为什么要合并】原先每只股票要分别调用 getYearStartPrice / get924Price /
   * getYearHighLow，即 3 次 K 线请求。热门板块点击后的成分股动辄上百只，
   * 串行请求量达数百至上千次，极易触发接口限流与浏览器超时，表现为
   * 「今年高价/距高价/今年低价/距低价/年涨跌/924涨跌」六个字段长期刷新不出数据
   * （其他页面股票数少、能跑完，所以看起来「都正常」）。
   * 改为一次拉取 2024-09-01 至今的全部日 K，一次性算出四项，请求量降为原来的 1/3。
   * @param {string} code sh600519
   * @returns {Promise<{yearStartPrice,price924,yearHighPrice,yearLowPrice}>} 取不到的项为 null
   */
  async getHistoryBundle(code) {
    const out = { yearStartPrice: null, price924: null, yearHighPrice: null, yearLowPrice: null };
    if (!code) return out;
    const y = new Date().getFullYear();
    const start = '2024-09-01';
    const end = this.fmtDate(new Date());
    const n = this._barCount(start, end);
    let data = [];
    try {
      data = await this.getKline(code, start, end, n);
    } catch (e) {
      data = [];
    }
    if (!data || !data.length) return out;
    // 今年高低价 + 年初第一个交易日收盘价（K 线按日期升序，首个即年初首个交易日）
    const prefix = `${y}-`;
    let hi = -Infinity, lo = Infinity, first = null;
    for (const k of data) {
      if (k.date && k.date.indexOf(prefix) === 0) {
        if (k.high != null && !isNaN(k.high) && k.high > hi) hi = k.high;
        if (k.low != null && !isNaN(k.low) && k.low < lo) lo = k.low;
        if (!first) first = k;
      }
    }
    if (hi !== -Infinity) out.yearHighPrice = +hi.toFixed(2);
    if (lo !== Infinity) out.yearLowPrice = +lo.toFixed(2);
    if (first) out.yearStartPrice = first.close;
    // 924 收盘价：优先精确匹配，非交易日则取之前最近一个交易日
    const exact = data.find(k => k.date === '2024-09-24');
    if (exact) {
      out.price924 = exact.close;
    } else {
      let prev = null;
      for (const k of data) { if (k.date && k.date <= '2024-09-24') prev = k; }
      if (prev) out.price924 = prev.close;
    }
    return out;
  },

  /** 转换 SECUCODE：sh600519 → 600519.SH，sz000001 → 000001.SZ，bj → .BJ */
  toSecucode(code) {
    const pure = this.pureCode(code);
    const c = String(code);
    if (/^sh/i.test(c)) return `${pure}.SH`;
    if (/^bj/i.test(c)) return `${pure}.BJ`;
    // 纯数字/未知前缀时按代码段判断市场：6/9 沪市，4/8 北交所，其余(0/3等)深市
    if (/^[69]/.test(pure)) return `${pure}.SH`;
    if (/^[48]/.test(pure)) return `${pure}.BJ`;
    return `${pure}.SZ`;
  },

  // ============ 热门板块/股票 ============

  /**
   * 将东财 clist 返回的 diff 统一成数组。
   * 新版接口可能返回以序号为键的对象，旧版为数组，这里做兼容。
   */
  _diffArray(json) {
    const d = json && json.data && json.data.diff;
    if (!d) return [];
    if (Array.isArray(d)) return d;
    return Object.keys(d).map(k => d[k]);
  },

  /**
   * JSONP 请求（东财接口支持 cb 回调参数）。
   * 通过注入 <script> 加载数据，不受浏览器同源策略（CORS）限制，
   * 是静态站点（如 GitHub Pages）直连东财接口失败时最可靠的兜底方案。
   */
  _eastJsonp(url, timeout = 7000) {
    return new Promise((resolve, reject) => {
      const cbName = '__emcb_' + Math.random().toString(36).slice(2) + '_' + Date.now();
      let script = null;
      let settled = false;
      const cleanup = () => {
        try { delete window[cbName]; } catch (e) {}
        if (script && script.parentNode) script.parentNode.removeChild(script);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true; cleanup(); reject(new Error('jsonp timeout'));
      }, timeout);
      window[cbName] = (data) => {
        if (settled) return;
        settled = true; clearTimeout(timer); cleanup();
        if (data) resolve(data); else reject(new Error('jsonp empty'));
      };
      try {
        // 注意：不能用 URL.searchParams.set() 追加 cb —— 它会重新编码整个查询串，
        // 把 fs=m:90+t:2 中的 "+" 变成空格/ %2B，导致东财返回空数据。
        // 这里直接字符串拼接，完整保留原有参数编码。
        const src = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'cb=' + cbName;
        script = document.createElement('script');
        script.charset = 'utf-8';
        script.onerror = () => {
          if (settled) return;
          settled = true; clearTimeout(timer); cleanup(); reject(new Error('jsonp error'));
        };
        script.src = src;
        document.head.appendChild(script);
      } catch (e) {
        if (settled) return;
        settled = true; clearTimeout(timer); cleanup(); reject(e);
      }
    });
  },

  /**
   * 统一的东财 GET：
   * 1) 优先 fetch —— 注意不携带任何自定义请求头，保持「简单请求」以避免触发 CORS 预检；
   * 2) 失败则降级 JSONP —— 完全绕过 CORS。
   * @returns {object|null}
   */
  async _eastGet(url) {
    let u = null;
    try { u = new URL(url); } catch (e) { u = null; }
    const isKline = !!(u && u.pathname.indexOf('/kline/') >= 0);
    let hosts;
    if (u && u.hostname.indexOf('push2') === 0) {
      // K 线只有 push2his / push2delay 提供真实数据；push2 主节点对 kline 接口返回
      // data:{klines:[]} 这类「成功但空」的响应。若把 push2 排在最前，_eastGet 会把它当成成功
      // 直接短路返回，导致「今年高价/距高价/今年低价/距低价/年涨跌/924涨跌」永远取不到数据。
      // 故 K 线请求跳过 push2，且只在确有 klines 时才算成功（空数据继续尝试下一节点）。
      hosts = isKline
        ? ['push2his.eastmoney.com', 'push2delay.eastmoney.com']
        : ['push2.eastmoney.com', 'push2delay.eastmoney.com', 'push2his.eastmoney.com'];
    } else {
      hosts = [null];   // 非 push2 域名（如 datacenter-web）不做替换
    }
    for (const host of hosts) {
      // 用字符串拼接而非 URL 序列化，避免 searchParams 重新编码把 "fs=m:90+t:2" 的 "+" 变成空格
      let target = url;
      if (host && u && u.hostname !== host) {
        target = u.protocol + '//' + host + u.pathname + (u.search || '');
      }
      // 1) 简单请求 fetch（不带任何自定义头，避免 CORS 预检）
      try {
        const resp = await fetch(target, { cache: 'no-store' });
        if (resp.ok) {
          const j = await resp.json();
          if (j && j.data != null) {
            if (isKline) { if (j.data.klines && j.data.klines.length) return j; }
            else return j;
          }
        }
      } catch (e) {
        console.debug('[stock-api] fetch 失败，改用 JSONP 兜底:', e && e.message);
      }
      // 2) JSONP：注入 <script> 加载，完全绕过 CORS
      try {
        const j = await this._eastJsonp(target, 9000);
        if (j && j.data != null) {
          if (isKline) { if (j.data.klines && j.data.klines.length) return j; }
          else return j;
        }
      } catch (e) {
        console.debug('[stock-api] JSONP 亦失败:', e && e.message);
      }
    }
    return null;
  },

  /**
   * 获取板块涨幅排行（东财）
   * @returns {Array<{bk, name, change}>}
   */
  async getBoardRanking() {
    // 行业板块 fs=m:90+t:2  概念板块 fs=m:90+t:3
    const results = [];
    try {
      const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=15&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f2,f3,f12,f14`;
      const json = await this._eastGet(url);
      for (const item of this._diffArray(json)) {
        // bk=板块代码(f12)，供点击板块时拉取其成分股
        results.push({ bk: item.f12, name: item.f14, change: parseFloat(item.f3) });
      }
    } catch (e) {
      console.debug('板块排行获取失败', e);
    }
    return results;
  },

  /**
   * 获取振幅板块排行（东财）
   * 计算规则：对板块振幅（f7）突然拉升/放大进行排名，取概念板块按振幅降序。
   * @returns {Array<{bk, name, change}>} change 为振幅(%)
   */
  async getAmplitudeBoards() {
    const results = [];
    try {
      // 概念板块 fs=m:90+t:3，按振幅(f7)降序取前 15
      const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=15&po=1&np=1&fltt=2&invt=2&fid=f7&fs=m:90+t:3&fields=f2,f3,f7,f12,f14`;
      const json = await this._eastGet(url);
      for (const item of this._diffArray(json)) {
        const amp = item.f7 != null ? parseFloat(item.f7) : parseFloat(item.f3);
        results.push({ bk: item.f12, name: item.f14, change: isNaN(amp) ? 0 : amp });
      }
    } catch (e) {
      console.debug('振幅板块获取失败', e);
    }
    return results;
  },

  /**
   * 获取盘前热点板块（概念板块，按涨幅排序）
   * 与「当日热门板块」（行业板块）互补：概念板块更偏题材/热点，
   * 适合作为盘前关注的热点方向。
   * @returns {Array<{bk, name, change}>}
   */
  async getPreMarketBoards() {
    const results = [];
    try {
      // 概念板块 fs=m:90+t:3，按涨幅降序取前 15
      const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=15&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:3&fields=f2,f3,f12,f14`;
      const json = await this._eastGet(url);
      for (const item of this._diffArray(json)) {
        results.push({ bk: item.f12, name: item.f14, change: parseFloat(item.f3) });
      }
    } catch (e) {
      console.debug('盘前热点板块获取失败', e);
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
      const json = await this._eastGet(url);
      for (const item of this._diffArray(json)) {
        const prefix = String(item.f12).startsWith('6') ? 'sh' : 'sz';
        results.push({
          name: item.f14,
          code: prefix + item.f12,
          change: parseFloat(item.f3)
        });
      }
    } catch (e) {
      console.debug('个股排行获取失败', e);
    }
    return results;
  },

  // ============ 概念/行业板块选股 ============

  /**
   * 东财接口多节点轮询：单个节点对连续请求限流敏感，
   * 通过多个同源数据节点（push2 / push2delay / push2his 等）轮询降级，
   * 任一节点成功即返回，全部失败返回 null。全程免费（东财公开接口）。
   * @param {string} url 完整 url，host 会被自动替换到各节点
   */
  async _eastFetch(url) {
    // 多节点列表：优先主节点，其次延迟节点（独立服务器，通常不同时被限流）
    const hosts = [
      'push2.eastmoney.com',
      'push2delay.eastmoney.com',
      'push2his.eastmoney.com'
    ];
    let u;
    try { u = new URL(url); } catch (e) { return null; }
    // 打乱节点顺序的起始偏移，避免多用户同时命中同一节点
    const start = Math.floor(Math.random() * hosts.length);
    // 1) 各节点尝试「简单」fetch：
    //    注意不要携带任何自定义请求头（如 User-Agent）——自定义头会把请求变成
    //    「非简单请求」，浏览器会先发 CORS 预检 OPTIONS，而东财不支持预检，
    //    导致请求直接失败。这也是此前「获取失败（网络限制）」的主要诱因之一。
    for (let h = 0; h < hosts.length; h++) {
      u.hostname = hosts[(start + h) % hosts.length];
      try {
        const resp = await fetch(u.href, { cache: 'no-store' });
        if (resp.ok) {
          const json = await resp.json();
          if (json && json.data !== undefined) return json;
        }
      } catch (e) { /* 切下一个节点 */ }
      await new Promise(r => setTimeout(r, 250));
    }
    // 2) 全部失败 → JSONP 兜底（<script> 注入，绕过 CORS 预检与响应头限制）
    u.hostname = hosts[0];
    try {
      const json = await this._eastJsonp(u.href, 6000);
      if (json && json.data !== undefined) return json;
    } catch (e) { /* 忽略，返回 null */ }
    return null;
  },

  /**
   * 分页拉取某类板块列表（概念 m:90+t:3 / 行业 m:90+t:2）
   * 东财单页上限 100 条。因 _eastFetch 已多节点轮询降级，
   * 此处保持合理页间间隔避免过度请求，支持加载完整板块列表。
   * @param {string} fs 板块筛选条件
   * @param {number} maxPages 最多加载几页，默认 6（概念约 6 页、行业约 5 页）
   * @returns {Array<{bk, name, change}>}
   */
  async _loadSectors(fs, maxPages = 6) {
    const all = [];
    for (let pn = 1; pn <= maxPages; pn++) {
      const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=${pn}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=${encodeURIComponent(fs)}&fields=f12,f14,f3`;
      const json = await this._eastFetch(url);
      const diff = this._diffArray(json);
      all.push(...diff);
      const total = json && json.data && json.data.total;
      if (!diff.length || all.length >= total) break;
      // 页间等待，降低单节点请求频率
      await new Promise(r => setTimeout(r, 500));
    }
    return all.map(b => ({ bk: b.f12, name: b.f14, change: b.f3 != null ? parseFloat(b.f3) : null }));
  },

  /** 板块缓存（避免重复加载） */
  _sectorCache: null,
  /** 板块缓存过期时间戳 */
  _sectorCacheAt: 0,

  /**
   * 获取板块列表（概念+行业，去重）。
   * 借助多节点轮询降级，默认加载完整板块列表（概念约 504 + 行业约 496），
   * 确保任何概念/行业板块都能被搜索到。结果缓存 2 小时避免重复请求。
   * @param {boolean} loadAll 兼容参数；当前无论是否传 true 均加载完整列表
   * @returns {Promise<Array<{bk, name, type, change}>>} type: '概念'|'行业'
   */
  async getAllSectors(loadAll = false) {
    const now = Date.now();
    const cacheTtl = 2 * 60 * 60 * 1000; // 2 小时
    if (this._sectorCache && this._sectorCache._full >= 1 && now - this._sectorCacheAt < cacheTtl) {
      return this._sectorCache.data;
    }
    const maxPg = 6; // 概念约6页、行业约5页，足够覆盖全部板块
    // 概念与行业分开请求，各自失败不互相影响
    let concepts = [], industries = [];
    try { concepts = await this._loadSectors('m:90+t:3', maxPg); } catch (e) { console.debug('概念板块加载失败', e); }
    try { industries = await this._loadSectors('m:90+t:2', maxPg); } catch (e) { console.debug('行业板块加载失败', e); }
    const seen = new Set();
    const all = [];
    concepts.forEach(s => { if (!seen.has(s.bk)) { seen.add(s.bk); all.push({ ...s, type: '概念' }); } });
    industries.forEach(s => { if (!seen.has(s.bk)) { seen.add(s.bk); all.push({ ...s, type: '行业' }); } });
    // 缓存（始终标记为完整加载，供搜索使用）
    this._sectorCache = { data: all, _full: 1 };
    this._sectorCacheAt = now;
    return all;
  },

  /**
   * 按关键词搜索板块（本地过滤，中文匹配名称）
   * @param {string} keyword
   * @returns {Promise<Array<{bk, name, type, change}>>}
   */
  async searchSectors(keyword) {
    const kw = (keyword || '').trim().toLowerCase();
    if (!kw) return [];
    const all = await this.getAllSectors();
    return all.filter(s => s.name.toLowerCase().includes(kw)).slice(0, 20);
  },

  /**
   * 获取某板块的全部成分股
   * @param {string} bk 板块代码，如 BK0896
   * @returns {Promise<Array<{code, name, price, changePercent}>>} code 为带前缀格式
   */
  async getSectorStocks(bk) {
    const all = [];
    for (let pn = 1; pn <= 15; pn++) {
      const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=${pn}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=b%3A${bk}&fields=f12,f14,f3,f2`;
      const json = await this._eastFetch(url);
      const diff = this._diffArray(json);
      for (const it of diff) {
        const pure = String(it.f12);
        const prefix = /^(6|9|4|8)/.test(pure) ? 'sh' : 'sz';
        all.push({
          code: prefix + pure,
          name: it.f14 || '',
          price: it.f2 != null ? parseFloat(it.f2) : null,
          changePercent: it.f3 != null ? parseFloat(it.f3) : null
        });
      }
      const total = json && json.data && json.data.total;
      if (!diff.length || all.length >= total) break;
      await new Promise(r => setTimeout(r, 300));
    }
    return all;
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
