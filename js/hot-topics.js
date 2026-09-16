/* ============================================================
 * hot-topics.js — 火热话题共享逻辑
 * 1) 10 个金融软件来源（按用户指定排序）
 * 2) 7 大分类关键词词典 + classify()
 * 3) 跨站同话题聚类 clusterItems()（算出每条新闻在几个站出现）
 * 4) 标题归一化 / 相似度工具
 * 挂载到 window.HotTopics，供 stock-api.js / app.js 复用。
 * ============================================================ */
(function (global) {
  'use strict';

  /* ---------- 7 大分类（顺序即优先级，越靠前越优先命中） ----------
   * 财经前置：比特币/股票等金融强信号优先于经济类的弱信号（如“美元”）。 */
  const CATEGORIES = ['军事', '科技', '政治政策', '财经', '经济', '世界500强领导者动态', '社会热点'];

  const CATEGORY_COLORS = {
    '军事': '#8b5a2b',
    '科技': '#2563eb',
    '政治政策': '#9b2fb5',
    '经济': '#0a7d3e',
    '世界500强领导者动态': '#b45309',
    '社会热点': '#db2777',
    '财经': '#e63525',
    '其他': '#6b7280'
  };

  /* 关键词词典：命中任一即归该类（按 CATEGORIES 顺序判定） */
  const CATEGORY_KEYWORDS = {
    '军事': ['军事', '军工', '武器', '导弹', '战机', '航母', '军队', '国防', '北约', '俄乌', '中东', '冲突', '战争', '演习', '边防', '士兵', '潜艇', '空军', '海军', '陆军', '反恐', '边境', '核武', '军演', '战斗机', '驱逐舰'],
    '科技': ['科技', '芯片', '半导体', '人工智能', 'AI', '大模型', '算法', '量子', '机器人', '算力', '数据中心', '新能源技术', '5G', '6G', '鸿蒙', '操作系统', '光刻机', '自动驾驶', '电池技术', '元宇宙', '区块链', '云计算', '物联网', '卫星', '航天', 'SpaceX', '英伟达', 'OpenAI', '芯片制裁', 'GPU', '华为', '腾讯', '阿里', '阿里巴巴', '字节', '百度', '京东', '小米', '比亚迪', '宁德时代', '蔚来', '美团', '网易', '快手', '智能手机', 'APP', '鸿蒙', '昇腾', '寒武纪'],
    '政治政策': ['政策', '国务院', '央行', '政治局', '两会', '人大', '政府', '监管', '财政部', '发改委', '证监会', '主席', '总理', '部长', '法令', '法规', '制裁', '关税', '贸易战', '外交', '元首', '会谈', '峰会', '白宫', '国会', '选举', '法案', '批复', '指导意见', '新规', '出台', '落地', '台湾', '两岸', '统一', '会晤', '访华', '出访', '谈判', '声明', '讲话', '国防部', '外交部', '联合国', '北约', '制裁令', '反制', '协议', '宣言'],
    '经济': ['经济', 'GDP', 'CPI', 'PPI', '通胀', '衰退', '利率', '降息', '加息', '汇率', '人民币', '美元', '美联储', '就业', '消费', '进出口', '贸易', '制造业', 'PMI', '财政', '税收', '债务', '国债', '信用', '破产', '失业率', '稳增长', '刺激', '复苏', '宏观经济', '景气', '供需', '顺差', '逆差', '外储', '信贷'],
    '世界500强领导者动态': ['世界500强', '500强', '总裁', '董事长', '创始人', 'CEO', '高管', '换帅', '辞职', '任命', '退休', '离任', '接任', '掌门人', '接班人', '苹果', '微软', '特斯拉', '亚马逊', '谷歌', '英伟达', '伯克希尔', '马斯克', '库克', '黄仁勋', '贝索斯', '扎克伯格', '丰田', '三星', '壳牌', '沃尔玛', '华为', '腾讯', '阿里', '阿里巴巴', '字节', '百度', '京东', '小米', '比亚迪', '宁德时代', '美团', '网易', '快手', '蔚来', '理想', '小鹏', '滴滴'],
    '社会热点': ['社会', '民生', '教育', '医疗', '疫情', '地震', '灾害', '事故', '热搜', '网友', '舆论', '维权', '反腐', '落马', '判刑', '案件', '罢工', '游行', '抗议', '高考', '就业难', '房价', '养老', '生育', '彩礼', '举报', '曝光', '塌方', '暴雨', '洪灾', '火灾', '车祸', '食品安全', '打假', '维权'],
    '财经': ['股市', '股票', 'A股', '港股', '美股', '上市', '退市', 'IPO', '融资', '并购', '收购', '重组', '财报', '营收', '利润', '分红', '股价', '涨停', '跌停', '基金', '债券', '期货', '黄金', '原油', '比特币', '加密货币', '券商', '银行', '保险', '房地产', '新能源', '光伏', '锂电', '储能', '造车', '业绩', '市值', '成交额', '北向资金', '主力', '板块', '指数', '散户', '机构', '量化', '期权', '融券', '印花税']
  };

  /* ---------- 10 个金融软件来源（严格按用户指定排序） ---------- */
  /* parse 类型：
   *  json_<key>  -> 标准 JSON 解析
   *  html_<key>  -> 经 Worker /proxy 返回的 HTML，用正则/DOMParser 抽取
   */
  const SOURCE_ORDER = [
    { rank: 1, key: 'gelonghui', name: '格隆汇', color: '#c8102e', parse: 'html_gelonghui', endpoint: 'https://www.gelonghui.com/', base: 'https://www.gelonghui.com' },
    { rank: 2, key: 'toutiao', name: '今日头条', color: '#2a6cff', parse: 'json_toutiao', endpoint: 'https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc' },
    { rank: 3, key: 'ths', name: '同花顺', color: '#0a7d3e', parse: 'html_ths', endpoint: 'https://news.10jqka.com.cn/realtimenews.html', base: 'https://news.10jqka.com.cn' },
    { rank: 4, key: 'eastmoney', name: '东方财富', color: '#e63525', parse: 'news_eastmoney', endpoint: '', fallback: 'https://finance.eastmoney.com/', base: 'https://finance.eastmoney.com' },
    { rank: 5, key: 'cailian', name: '财联社', color: '#d92121', parse: 'json_cailian', endpoint: 'https://www.cailianpress.com/v2/articles/telegraph?last_time=0' },
    { rank: 6, key: 'kaipanla', name: '开盘啦', color: '#f59e0b', parse: 'html_kaipanla', endpoint: 'https://www.kaipanla.com/', base: 'https://www.kaipanla.com' },
    { rank: 7, key: 'xueqiu', name: '雪球', color: '#cc3333', parse: 'json_xueqiu', endpoint: 'https://xueqiu.com/statuses/topic/today.json' },
    { rank: 8, key: 'wscn', name: '华尔街见闻', color: '#222222', parse: 'json_wscn', endpoint: 'https://api-prod.wallstreetcn.com/apiv1/content/lives?channel=global&client=pc&limit=20' },
    { rank: 9, key: 'wind', name: '万得', color: '#0f766e', parse: 'html_wind', endpoint: 'https://www.wind.com.cn/', base: 'https://www.wind.com.cn' },
    { rank: 10, key: 'cs', name: '中国证券', color: '#b91c1c', parse: 'html_cs', endpoint: 'https://www.cs.com.cn/', base: 'https://www.cs.com.cn' }
  ];

  const SOURCE_BY_KEY = {};
  SOURCE_ORDER.forEach(s => { SOURCE_BY_KEY[s.key] = s; });

  /* ---------- 标题净化（Node 抓取脚本与浏览器共用同一套规则） ---------- */

  /** 解码常见 HTML 实体（&gt; &amp; &#39; 等） */
  function decodeEntities(s) {
    return String(s == null ? '' : s)
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&apos;/gi, "'")
      .replace(/&#39;/g, "'")
      .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d))
      .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&amp;/gi, '&');
  }

  /** 精确匹配的导航/栏目词，一律丢弃 */
  const JUNK_EXACT = new Set([
    '查看更多', '更多', '查看更多>', '更多>', '首页', '登录', '注册', '下一页', '上一页',
    '返回', '全部', '详情', '阅读全文', '点击查看', '快讯', '要闻', '热点', '推荐',
    '专题', '视频', '图片', '评论', '分享', '设为首页', '加入收藏', '联系我们'
  ]);

  /** 正则黑名单：模板残留、纯符号、导航短语、站点工具入口 */
  const JUNK_RES = [
    /^\$\{/,            // JS 模板串 ${title}
    /^\{\{/,            // 模板占位
    /^<!--/,            // 注释残留
    /^#/,               // 话题标签 #xxx
    /^7[xX×]24/,        // "7x24小时" 等栏目
    /^(更多|查看|点击|了解|展开|收起)\S{0,4}$/,
    /^(登录|注册|下载|客服|帮助|设置|反馈|订阅)/,
    /版本过低|请升[级至]|浏览器.*(过低|升级)/,     // "您的IE版本过低…"
    /^今日(利好|必读|要闻|公告|焦点)/,             // "今日利好公告" 等栏目
    /(免费版|软件下载|模拟炒股)/,                  // 客户端推广入口
    /(问财|智能选股)/,                             // 同花顺工具入口
    /(加入我们|极调研|关于格隆汇)/,                // 站点介绍入口
    /(公众号矩阵|搜索结果|申请认证)/,
    /^[>\u00bb\u203a<\u00ab\u2039\u300a\u300b|\uFF5C\u00b7\u3001,\uFF0C.\u3002:\uFF1A;\uFF1B!！?？\-—_~…\s]+$/
  ];

  /* 站点栏目/导航标签词：这些词互相拼接成的短串（如「财经要闻 宏观经济」）不是新闻 */
  const NAV_LABELS = [
    '财经要闻', '宏观经济', '产经新闻', '国际财经', '区域经济', '财经评论', '国内经济', '国际经济',
    '产经资讯', '热点扫描', '纵深调查', '市场数据', '基金数据', '经济时评', '股市评论', '证券要闻',
    '港股公告摘要', 'A股公告摘要', '大行评级', '业绩直击', '港股异动', '公司信息', '市场综述',
    '新股掘金', '个股聚焦', '公司新闻', '公司研究', '机构评级', '模拟炒股', '软件下载', '股民学校',
    '关于我们', '联系我们', '用户反馈', '设为首页', '加入收藏', '网站地图', '免责声明', '意见反馈',
    '友情链接', '商务合作', '申请认证', '加入我们', '版权所有', '搜索结果', '公众号矩阵',
    '首页', '要闻', '快讯', '直播', '视频', '专题', '评论', '行情', '自选股', '沪深', '港股',
    '美股', '基金', '期货', '外汇', '债券', '理财', '银行', '保险', '专栏', '研究院', '社区',
    '财富号', '下载', '客户端', '登录', '注册', '手机版', '无障碍', '繁体', '全部', '更多',
    '同花顺免费版', '免费版', '财富先锋', '问财', '智能选股', '利好公告', '今日利好', '数据', '指数'
  ];

  /** 是否由栏目词拼成的导航串（完全拼接、且至少 2 个词） */
  function isLabelCombo(compact) {
    if (compact.length < 4 || compact.length > 18) return false;
    let rest = compact, hit = 0;
    while (rest) {
      const w = NAV_LABELS.find(x => x.length >= 2 && rest.indexOf(x) === 0);
      if (!w) return false;
      rest = rest.slice(w.length);
      hit++;
      if (hit > 6) return false;
    }
    return hit >= 2;
  }

  /** 判定是否为无效/垃圾标题（导航链接、栏目拼盘、模板残留、乱码等） */
  function isJunkTitle(text) {
    const raw = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    const t = raw.replace(/\s+/g, '');
    if (t.length < 6) return true;                        // 太短：多为栏目名
    if (!/[\u4e00-\u9fa5A-Za-z]/.test(t)) return true;    // 无中英文字符
    if (t.indexOf('\uFFFD') >= 0) return true;            // 含乱码替换字符（编码错误）
    if (JUNK_EXACT.has(t) || JUNK_EXACT.has(raw)) return true;
    for (const re of JUNK_RES) if (re.test(t) || re.test(raw)) return true;
    if (isLabelCombo(t)) return true;                     // 栏目拼盘
    // 多段短词拼接（"首页 关于我们"）也是导航
    const parts = raw.split(' ');
    if (parts.length >= 2 && parts.every(p => p.length <= 6)) return true;
    // 纯 ASCII 短串：工具入口 / 代码残留（如 "level-2"）
    if (/^[\x20-\x7E]+$/.test(t) && t.length < 16) return true;
    // 无中文且无足够长的英文单词 → 代码/符号残留
    const cn = (t.match(/[\u4e00-\u9fa5]/g) || []).length;
    if (cn === 0 && !/[A-Za-z]{4,}/.test(t)) return true;
    return false;
  }

  /** 清洗标题：去标签 → 解实体 → 压空白 → 截断 → 校验。无效返回 '' */
  function cleanTitle(text) {
    let t = String(text == null ? '' : text).replace(/<[^>]*>/g, '');
    t = decodeEntities(t).replace(/\s+/g, ' ').trim().slice(0, 90);
    if (isJunkTitle(t)) return '';
    return t;
  }

  /** 本地日期格式化（避免 toISOString 的 UTC 时区偏移） */
  function fmtLocalDate(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  /** 今天的 YYYY-MM-DD */
  function todayStr() { return fmtLocalDate(new Date()); }

  /**
   * 实时抓取失败时，决定按优先级回退读取哪些「仓库内置快照」日期。
   * 返回：日期数组（降序，第一个即最优）。清单不可用时向前回溯 maxLookback 天。
   * @param {object|null} manifest 仓库清单 { dates: ['YYYY-MM-DD', ...] }
   * @param {string} today 'YYYY-MM-DD'
   * @param {number} maxLookback 无清单时向前回溯的天数
   */
  function snapshotCandidates(manifest, today, maxLookback) {
    maxLookback = maxLookback == null ? 14 : maxLookback;
    const out = [];
    const push = (d) => {
      if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && out.indexOf(d) < 0) out.push(d);
    };
    const dates = (manifest && Array.isArray(manifest.dates)) ? manifest.dates.slice() : [];
    // 清单里只取不晚于今天的日期，按降序优先
    dates.filter(d => typeof d === 'string' && d <= today).sort().reverse().forEach(push);
    if (out.length) return out;
    // 清单不可用：从今天起向前回溯
    const base = /^\d{4}-\d{2}-\d{2}$/.test(today || '') ? new Date(today + 'T00:00:00') : new Date();
    for (let i = 0; i < maxLookback; i++) {
      const d = new Date(base.getTime());
      d.setDate(d.getDate() - i);
      push(fmtLocalDate(d));
    }
    return out;
  }

  /* ---------- 分类 ---------- */
  function classify(text) {
    text = (text || '').toString();
    if (!text) return '财经';
    for (const cat of CATEGORIES) {
      const kws = CATEGORY_KEYWORDS[cat] || [];
      for (const kw of kws) {
        if (text.indexOf(kw) >= 0) return cat;
      }
    }
    return '财经'; // 投资工具语境下，未命中归为财经
  }

  /* ---------- 标题归一化（用于相似度比较） ---------- */
  const FILLER = /[的\s，。、：:；;！!？?""''「」()（）\[\]【】#@—\-_~·…“”‘’\u3000]/g;
  function normalizeTitle(t) {
    return (t || '').toString().toLowerCase().replace(FILLER, '');
  }

  /* 字符 bigram 集合 */
  function bigrams(s) {
    s = normalizeTitle(s);
    const set = new Set();
    if (s.length <= 2) { if (s) set.add(s); return set; }
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  }

  /* Jaccard 相似度 */
  function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    const uni = a.size + b.size - inter;
    return uni ? inter / uni : 0;
  }

  /* 抽取高信号 token（公司/人物/数字百分比/特定名词）用于交叉验证 */
  const SIGNAL_RE = /(比特币|以太坊|黄金|原油|美联储|央行|特斯拉|苹果|英伟达|华为|腾讯|阿里|字节|茅台|\d+(\.\d+)?%|\d+(\.\d+)?亿|\d+(\.\d+)?万|涨停|跌停|加息|降息|制裁|关税|重组|并购|上市|退市)/g;
  function signalTokens(t) {
    const m = (t || '').match(SIGNAL_RE) || [];
    return new Set(m.map(x => x.toLowerCase()));
  }

  /* 两标题是否同话题 */
  function isSameTopic(a, b) {
    const na = normalizeTitle(a), nb = normalizeTitle(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    if (Math.abs(na.length - nb.length) > Math.max(6, na.length * 0.6)) return false; // 长度差距过大不算
    const j = jaccard(bigrams(na), bigrams(nb));
    if (j >= 0.5) return true;
    const sa = signalTokens(a), sb = signalTokens(b);
    if (sa.size && sb.size) {
      let common = 0;
      for (const x of sa) if (sb.has(x)) common++;
      if (common >= 2) return true;
    }
    return false;
  }

  /**
   * 跨站聚类：把来自不同站的同话题新闻归并。
   * @param {Array<{sourceRank:number,sourceKey:string,sourceName:string,text:string,time:string,url:string,cat:string,date?:string}>} items
   * @returns {Array<{repTitle:string, count:number, siteRanks:number[], siteNames:string[], ratio:string, items:Array}>}
   *          按出现站点数降序。
   */
  function clusterItems(items) {
    const list = (items || []).filter(it => it && it.text);
    const clusters = [];
    for (const it of list) {
      let placed = false;
      for (const c of clusters) {
        if (isSameTopic(c.repTitle, it.text)) {
          c.items.push(it);
          if (c.siteRanks.indexOf(it.sourceRank) < 0) {
            c.siteRanks.push(it.sourceRank);
            c.siteNames.push(it.sourceName);
          }
          // 选取更长/更完整的标题作为代表
          if (it.text.length > c.repTitle.length) c.repTitle = it.text;
          placed = true;
          break;
        }
      }
      if (!placed) {
        clusters.push({
          repTitle: it.text,
          count: 1,
          siteRanks: [it.sourceRank],
          siteNames: [it.sourceName],
          items: [it]
        });
      }
    }
    clusters.sort((a, b) => b.siteRanks.length - a.siteRanks.length || b.count - a.count);
    const total = SOURCE_ORDER.length;
    clusters.forEach(c => { c.ratio = c.siteRanks.length + '/' + total; });
    return clusters;
  }

  /**
   * 各站分类统计：给定多日快照的扁平 items，按 sourceKey 统计每类数量。
   * @returns {Array<{rank,key,name,color,total,byCat:Object,dist:Array<{cat,count,pct}>}>}
   */
  function siteCategoryStats(items) {
    const bySource = {};
    SOURCE_ORDER.forEach(s => { bySource[s.key] = { rank: s.rank, key: s.key, name: s.name, color: s.color, byCat: {}, total: 0 }; });
    for (const it of (items || [])) {
      const st = bySource[it.sourceKey];
      if (!st) continue;
      const cat = it.cat || '财经';
      st.byCat[cat] = (st.byCat[cat] || 0) + 1;
      st.total++;
    }
    return SOURCE_ORDER.map(s => {
      const st = bySource[s.key];
      const dist = CATEGORIES.map(cat => ({ cat, count: st.byCat[cat] || 0 }))
        .filter(d => d.count > 0)
        .sort((a, b) => b.count - a.count);
      const max = dist.length ? dist[0].count : 1;
      dist.forEach(d => { d.pct = Math.round((d.count / (st.total || 1)) * 100); d.width = Math.max(6, (d.count / max) * 100); });
      return { rank: st.rank, key: st.key, name: st.name, color: st.color, total: st.total, byCat: st.byCat, dist };
    });
  }

  global.HotTopics = {
    CATEGORIES, CATEGORY_COLORS, SOURCE_ORDER, SOURCE_BY_KEY,
    classify, normalizeTitle, bigrams, jaccard, signalTokens, isSameTopic,
    clusterItems, siteCategoryStats,
    decodeEntities, isJunkTitle, cleanTitle,
    fmtLocalDate, todayStr, snapshotCandidates
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.HotTopics;
})(typeof window !== 'undefined' ? window : globalThis);
