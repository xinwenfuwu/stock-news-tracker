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

  /* ============================================================
   * 主题维度统计（行业 / 概念 / 产品 / 产业 / 科技）
   * 与 7 大类（军事/科技/政治政策…）是不同维度：
   *   - 7 大类：每条新闻只归 1 类（互斥），回答「这是什么性质的新闻」
   *   - 主题维度：多标签命中，一条新闻可同时命中多个主题，回答「涉及哪些板块方向」
   * ============================================================ */

  const THEME_DIMENSIONS = [
    { key: 'industry', name: '行业', icon: '🏭', color: '#2563eb' },
    { key: 'concept', name: '概念', icon: '💡', color: '#e63525' },
    { key: 'product', name: '产品', icon: '📦', color: '#0a7d3e' },
    { key: 'chain', name: '产业', icon: '⛓️', color: '#b45309' },
    { key: 'tech', name: '科技', icon: '🔬', color: '#7c3aed' }
  ];

  /* 维度 → { 主题名: [别名…] }。命中任一别名即该主题 +1（同一主题每条只计一次） */
  const THEME_KEYWORDS = {
    industry: {
      '半导体': ['半导体', '芯片', '晶圆', '芯片制造', '封测', '光刻', '硅片', '集成电路', 'IC设计', '硅光', '存储芯片', '封装基板'],
      '消费电子': ['消费电子', 'PCB', '面板', 'LED', '光学', '摄像模组', '被动元件', '手机产业链'],
      '计算机软件': ['计算机', '软件', 'SaaS', '操作系统', '数据库', '网络安全', '信创', '云原生'],
      '传媒': ['传媒', '影视', '出版', '广告', '文娱', '短剧', '院线', 'IP衍生'],
      '通信': ['通信', '运营商', '光模块', '光通信', '基站', '卫星通信', '光纤'],
      '互联网': ['互联网', '电商', '平台经济', '直播带货', '外卖', '短视频', '游戏', '腾讯', '阿里', '京东', '美团', '字节', '百度', '快手', '网易', '携程', '拼多多', '小红书'],
      '汽车': ['汽车', '乘用车', '商用车', '整车', '车企', '汽车零部件', '特斯拉', '比亚迪', '零跑', '蔚来', '理想', '小鹏', '赛力斯', '长城汽车', '吉利', '奇瑞', '上汽', '广汽'],
      '机械设备': ['机械', '工程机械', '机床', '工业母机', '自动化设备', '减速器', '叉车'],
      '电力设备': ['电力设备', '光伏', '风电', '储能', '锂电', '电池', '逆变器', '特高压', '电网', '核电', '输配电', '充电桩'],
      '国防军工': ['军工', '国防', '航空工业', '导弹', '雷达', '军贸', '军用', '兵器'],
      '医药生物': ['医药', '生物', '医疗', '创新药', '疫苗', '医院', '中药', '器械', '超声', '影像', 'CXO', '集采', '药企', '制药', '医疗健康'],
      '食品饮料': ['食品', '饮料', '白酒', '啤酒', '乳业', '调味品', '预制菜', '茅台', '五粮液', '伊利', '农夫山泉'],
      '家电': ['家电', '白电', '黑电', '空调', '冰箱', '洗衣机', '美的', '格力', '海尔'],
      '银行': ['银行', '商业银行', '信贷', '存款', '贷款', '息差', '招商银行', '工商银行', '建行'],
      '非银金融': ['券商', '证券', '保险', '信托', '公募', '私募', '投行', '财富管理', 'IPO'],
      '房地产': ['房地产', '地产', '楼市', '房价', '房企', '物业', '住建', '土地出让', '保交楼'],
      '石油石化': ['石油', '原油', '油价', '石化', '天然气', '炼化', 'OPEC', '油轮', '布伦特', '成品油'],
      '煤炭': ['煤炭', '焦煤', '动力煤', '煤价', '煤化工', '煤电'],
      '有色金属': ['有色', '黄金', '白银', '铜价', '铝价', '锂矿', '稀土', '钨', '镍', '贵金属', '金价'],
      '钢铁': ['钢铁', '钢材', '螺纹钢', '铁矿', '粗钢', '特钢'],
      '基础化工': ['化工', '化肥', '农药', '树脂', '纯碱', '维生素', '新材料', '精细化工'],
      '农林牧渔': ['农业', '养殖', '生猪', '猪肉', '种业', '饲料', '粮食', '水产', '禽类', '乡村振兴'],
      '建筑建材': ['建筑', '基建', '水泥', '玻璃', '防水', '钢结构', '工程承包'],
      '交通运输': ['航运', '港口', '航空', '机场', '快递', '物流', '铁路', '高速', '运费', '集装箱'],
      '公用事业': ['公用事业', '环保', '水务', '燃气', '电力运营', '垃圾发电', '城市供水'],
      '纺织服装': ['纺织', '服装', '鞋帽', '棉花', '服饰'],
      '商贸零售': ['零售', '超市', '百货', '免税', '连锁店'],
      '社会服务': ['旅游', '酒店', '餐饮', '教育', '人力资源', '景区', '演出']
    },
    concept: {
      '人工智能': ['AI', '人工智能', '机器学习', '深度学习', '生成式', 'AGI', 'OpenAI', 'AIGC'],
      '大模型': ['大模型', 'GPT', 'ChatGPT', '文心', '豆包', '通义', 'DeepSeek', 'Llama', '千问', '基础模型'],
      '算力': ['算力', '数据中心', 'IDC', '服务器', '液冷', '超节点', '东数西算', '智算', 'GPU'],
      '机器人': ['机器人', '人形机器人', '具身智能', '灵巧手', '机器狗', '机械臂'],
      '自动驾驶': ['自动驾驶', '无人驾驶', '智驾', 'Robotaxi', '智能座舱', '车路协同', '激光雷达'],
      '低空经济': ['低空经济', 'eVTOL', '飞行汽车', '通航', '低空'],
      '商业航天': ['商业航天', '卫星互联网', '火箭', '星链', '空间站', '探月'],
      '数据要素': ['数据要素', '数据资产', '数据交易', '数据确权', '数据流通'],
      '数字经济': ['数字经济', '数字化', '产业数字化', '数字人民币', '数字贸易'],
      '国产替代': ['国产替代', '自主可控', '国产化', '信创', '鸿蒙', '昇腾', '国产芯片'],
      '华为产业链': ['华为', '问界', '海思', '鸿蒙', '昇腾', '麦芒'],
      '固态电池': ['固态电池', '半固态', '全固态'],
      '加密货币': ['加密货币', '比特币', '以太坊', '稳定币', '数字货币', '区块链', 'USDT', 'BTC'],
      '量子科技': ['量子', '量子计算', '量子通信', '量子密钥', '量子比特'],
      '可控核聚变': ['核聚变', '托卡马克', '聚变'],
      '创新药': ['创新药', 'ADC', 'GLP-1', '减肥药', '单抗', 'License-out', '临床三期'],
      '脑机接口': ['脑机接口', '神经接口', '脑科学'],
      '并购重组': ['并购', '重组', '借壳', '资产注入', '吸收合并', '控股权'],
      '市值管理': ['市值管理', '回购', '增持', '分红', '高股息', '破净'],
      '涨价题材': ['涨价', '提价', '价格上调', '缺口', '供需紧张', '周期反转', '稀缺'],
      '中特估': ['中特估', '央企', '国企改革', '国资', '混改'],
      '元宇宙': ['元宇宙', 'VR', 'AR', 'XR', '虚拟现实', '虚拟人'],
      '合成生物': ['合成生物', '生物制造', '酶催化'],
      '新能源': ['新能源', '光伏', '风电', '储能', '锂电', '氢能', '绿电']
    },
    product: {
      '芯片': ['芯片', '处理器', 'CPU', 'GPU', 'SoC', 'AI芯片', '算力芯片', '存储', '封装基板', '晶圆'],
      '手机': ['手机', '智能手机', '折叠屏', '旗舰机', 'iPhone', 'Mate', '小米', '努比亚', '荣耀', 'OPPO', 'vivo'],
      '电动车': ['电动车', '新能源车', '纯电', '混动', '插混', '换电', 'Cybercab', '车型'],
      '光伏组件': ['光伏组件', '硅料', '硅片', '电池片', '多晶硅', '组件价格'],
      '锂电池': ['锂电池', '动力电池', '电芯', '磷酸铁锂', '三元', '碳酸锂', '钠电池'],
      '储能产品': ['储能电池', '储能电站', '抽水蓄能', '储能系统'],
      '无人机': ['无人机', '飞行器', 'eVTOL', '无人机配送'],
      '医疗器械': ['医疗器械', 'DR', 'CT', 'MRI', 'IVD', '内窥镜', '成像技术', '医疗设备'],
      '药品': ['药品', '注射液', '仿制药', '生物药', '疫苗', '胶囊', '适应症'],
      '白酒': ['白酒', '酱酒', '浓香', '白酒价格'],
      '游戏': ['游戏', '手游', '版号', '电竞', '页游'],
      '软件产品': ['办公软件', '工业软件', 'ERP', 'AI应用', 'APP'],
      '家电产品': ['空调', '冰箱', '洗衣机', '油烟机', '小家电'],
      '原油产品': ['成品油', '汽油', '柴油', '燃料油', '原油期货', '液化气'],
      '黄金白银': ['金条', '黄金ETF', '银价', '黄金期货', '现货黄金'],
      '稀土': ['稀土', '永磁', '钕铁硼', '稀土配额']
    },
    chain: {
      '新能源汽车产业链': ['新能源汽车', '整车', '动力电池', '三电', '汽车产业链', '充电网络'],
      '半导体产业链': ['半导体产业', '芯片产业链', '晶圆厂', '半导体设备', '封测厂', '半导体材料'],
      '光伏产业链': ['光伏产业', '光伏产业链', '硅料环节', '组件厂', '光伏装机'],
      '储能产业': ['储能产业', '储能项目', '新型储能', '储能招标'],
      '氢能产业': ['氢能', '氢燃料', '绿氢', '电解槽', '加氢站'],
      '生物医药产业': ['生物医药', '医药产业', '医疗产业链', 'CRO', 'CDMO', '医药园'],
      '低空经济产业': ['低空产业', '通航产业', '低空基础设施'],
      '算力产业': ['算力网', '算力产业', '算力基础设施', '智算中心', '算力中心'],
      '商业航天产业': ['航天产业', '卫星产业', '火箭制造', '卫星制造'],
      '文旅产业': ['文旅', '文化旅游', '旅游产业', '演艺产业'],
      '农业产业': ['农业产业', '农业现代化', '粮食安全', '种业振兴'],
      '化工产业': ['化工产业', '化工园区', '新材料产业'],
      '军工产业': ['军工产业', '国防工业', '武器装备'],
      '数据中心产业': ['数据中心', '云计算中心', '机房', '数据基础设施']
    },
    tech: {
      '人工智能': ['AI', '人工智能', '大模型', '生成式', 'AGI', '机器学习', 'OpenAI', 'AIGC'],
      '量子计算': ['量子计算', '量子比特', '量子科技', '量子密钥'],
      '通信技术': ['5G', '6G', '基站', '毫米波', '光通信', '卫星通信'],
      '区块链': ['区块链', 'Web3', '链上', '分布式账本', '智能合约'],
      '云计算': ['云计算', '云服务', '公有云', '云原生', '混合云'],
      '物联网': ['物联网', 'IoT', '传感器', '智能家居', '可穿戴'],
      '自动驾驶': ['自动驾驶', '无人驾驶', '激光雷达', '智驾', 'Robotaxi'],
      '航天探索': ['航天', '火箭', '卫星', '空间站', '探月', '火星探测'],
      '核聚变': ['核聚变', '托卡马克', '聚变堆'],
      '基因技术': ['基因', '基因编辑', '细胞治疗', 'mRNA', '合成生物'],
      '脑科学': ['脑机接口', '脑科学', '神经调控'],
      '先进制造': ['光刻机', '3D打印', '增材制造', '精密制造', '工业母机', '纳米'],
      '光通信技术': ['硅光', '光模块', '光芯片', '光电'],
      'AR/VR': ['VR', 'AR', 'XR', '元宇宙', '虚拟现实'],
      '数字孪生': ['数字孪生', '仿真', '工业互联网'],
      '网络安全': ['网络安全', '数据安全', '密码', '零信任']
    }
  };

  /** 取某条文本命中的主题（该维度内的主题名数组，去重） */
  function _hitTopics(text, dimKey) {
    const dict = THEME_KEYWORDS[dimKey];
    if (!dict) return [];
    const hits = [];
    for (const name in dict) {
      const aliases = dict[name];
      for (let i = 0; i < aliases.length; i++) {
        if (text.indexOf(aliases[i]) >= 0) { hits.push(name); break; }
      }
    }
    return hits;
  }

  /**
   * 主题维度统计：对一批新闻按 行业/概念/产品/产业/科技 五个维度做多标签命中统计。
   * @param {Array<{text:string, date?:string, sourceName?:string}>} items
   * @param {number} sampleMax 每个主题保留的样例标题数（用于悬停查看）
   * @returns {Array<{key,name,icon,color,total,baseTotal,topics:Array<{name,count,pct,width,samples,news}>}>}
   *          topics[].news 为该主题命中的全部新闻（引用原对象，按日期降序、站点序号升序），供点击主题就地展开
   */
  function themeStats(items, sampleMax) {
    sampleMax = sampleMax == null ? 3 : sampleMax;
    const list = (items || []).filter(it => it && it.text);
    const base = list.length;
    return THEME_DIMENSIONS.map(dim => {
      const counter = {};
      const samples = {};
      const bucket = {};
      let hitCount = 0;
      for (const it of list) {
        const hits = _hitTopics(it.text, dim.key);
        if (!hits.length) continue;
        hitCount++;
        for (const name of hits) {
          counter[name] = (counter[name] || 0) + 1;
          if (!samples[name]) samples[name] = [];
          if (samples[name].length < sampleMax) samples[name].push(it.text);
          if (!bucket[name]) bucket[name] = [];
          bucket[name].push(it);
        }
      }
      const topics = Object.keys(counter)
        .map(name => ({ name, count: counter[name], samples: samples[name] || [], news: bucket[name] || [] }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
      const max = topics.length ? topics[0].count : 1;
      topics.forEach(t => {
        t.pct = base ? Math.round((t.count / base) * 100) : 0;
        t.width = Math.max(6, Math.round((t.count / max) * 100));
        // 点击主题就地展开用：日期新的在前，同一天按站点序号
        t.news.sort((a, b) =>
          String(b.date || '').localeCompare(String(a.date || '')) || ((a.sourceRank || 0) - (b.sourceRank || 0)));
      });
      return {
        key: dim.key, name: dim.name, icon: dim.icon, color: dim.color,
        total: hitCount, baseTotal: base, topics
      };
    });
  }

  /* ============================================================
   * 格隆汇每日快讯：13 个题材分类（供「全球信息」页右栏使用）
   * 与上面的 THEME_DIMENSIONS 不同：这里是「一层 13 项」，每项直接带该类全部快讯，
   * 点某项即展开该类消息（用户需求：点开可以看到分类的消息）。
   * 同样是多标签命中——一条快讯可同时进入多个分类。
   * ============================================================ */
  const BRIEF_DIMENSIONS = [
    { key: 'policy', name: '国家政策类', icon: '🏛️', color: '#9b2fb5' },
    { key: 'fortune500', name: '世界500强', icon: '🌍', color: '#b45309' },
    { key: 'society', name: '社会热点', icon: '🔥', color: '#db2777' },
    { key: 'southbound', name: '南下资金', icon: '💧', color: '#0a7d3e' },
    { key: 'tech', name: '科技突破', icon: '🔬', color: '#2563eb' },
    { key: 'leader', name: '行业标杆', icon: '🏆', color: '#0369a1' },
    { key: 'institution', name: '大行机构', icon: '🏦', color: '#7c3aed' },
    { key: 'ust', name: '美债', icon: '📉', color: '#334155' },
    { key: 'usstock', name: '美股', icon: '🇺🇸', color: '#e63525' },
    { key: 'jpkstock', name: '日韩股', icon: '🎌', color: '#0f766e' },
    { key: 'hkstock', name: '港股', icon: '🇭🇰', color: '#c8102e' },
    { key: 'gold', name: '黄金', icon: '🥇', color: '#ca8a04' },
    { key: 'oil', name: '石油', icon: '🛢️', color: '#57534e' }
  ];

  /* 分类 → 关键词。命中任一即归入该类。
   * 刻意避开「社会」「规划」「监管」「台风」这类过于宽泛或歧义的词：
   * 实测过宽会误伤（如「台风」会命中 F-15「台风」战斗机、「规划」会命中投资者提问）。 */
  const BRIEF_KEYWORDS = {
    policy: [
      '国务院', '发改委', '央行', '中国人民银行', '财政部', '证监会', '金融监管总局', '银保监', '国常会', '政治局',
      '工信部', '商务部', '住建部', '交通运输部', '农业农村部', '水利部', '国家能源局', '国资委', '市场监管总局', '海关总署',
      '政策', '监管', '印发', '新闻发布会', '国新办', '实施意见', '指导意见', '条例', '法规', '法案', '税收', '关税',
      '补贴', '试点', '批复', '五年规划', '发展规划', '规划纲要', '部委', '省政府', '市政府', '施政报告',
      '议会', '国会', '白宫', '内阁', '制裁', '反制', '预算案', '政府', '立法'
    ],
    fortune500: [
      '世界500强', '500强', '苹果', '微软', '英伟达', '特斯拉', '亚马逊', '谷歌', 'Meta', '台积电', '三星', '丰田',
      '大众汽车', '宝马', '奔驰', '波音', '可口可乐', '沃尔玛', '强生', '辉瑞', '伯克希尔', '沙特阿美', '壳牌',
      '埃克森美孚', '英特尔', '高通', 'OpenAI', '马斯克', '库克', '黄仁勋', '奥特曼', '巴菲特', '贝索斯', '扎克伯格',
      'CEO', '首席执行官', '董事长', '创始人', '总裁', '高管', '换帅', '任命', '辞职', '离任', '接任', '掌门人'
    ],
    society: [
      '社会热点', '社会各界', '社会关注', '网友', '热搜', '事故', '灾害', '地震', '台风预警', '台风登陆', '暴雨',
      '洪水', '火灾', '车祸', '坠机', '伤亡', '遇难', '救援', '塌方', '塌房', '医疗', '教育部', '高校', '就业',
      '物价', '房价', '养老', '生育', '判刑', '反腐', '落马', '游行', '抗议', '罢工', '食品安全', '民生'
    ],
    southbound: [
      '南下资金', '南向资金', '港股通', '沪深港通', '陆股通', '北向资金', '南向', '北向'
    ],
    tech: [
      '突破', '研发成功', '全球首次', '全球首个', '行业首个', '首次实现', '首次成功', '问世', '量产', '新技术', '专利', '创新',
      '量子', '核聚变', '光刻', '固态电池', '脑机接口', '人形机器人', '大模型', '人工智能', 'AI', '6G', '商业航天',
      '基因编辑', 'mRNA', '超导', 'HBM', '算力', '芯片', '半导体', '机器人', '商业卫星', '自动驾驶', '昇腾', '光通信'
    ],
    leader: [
      '贵州茅台', '宁德时代', '比亚迪', '中芯国际', '隆基绿能', '招商银行', '中国平安', '万科', '海康威视', '立讯精密',
      '格力电器', '美的集团', '五粮液', '京东方', '三一重工', '紫金矿业', '北方稀土', '恒瑞医药', '迈瑞医疗', '药明康德',
      '寒武纪', '中际旭创', '工业富联', '长江电力', '中国神华', '中国移动', '中国石油', '中国石化', '中国人寿', '中信证券',
      '牧原股份', '伊利股份', '海天味业', '金山办公', '科大讯飞', '阳光电源', '亿纬锂能', '赣锋锂业', '天齐锂业', '中国中免',
      '东方财富', '同花顺', '顺丰控股', '中兴通讯', '海光信息', '中国建筑', '中国中铁', '京沪高铁'
    ],
    institution: [
      '高盛', '摩根士丹利', '大摩', '摩根大通', '小摩', '花旗', '美银', '美国银行', '瑞银', '野村', '汇丰', '中金公司',
      '华泰证券', '国泰君安', '招商证券', '广发证券', '中信建投', '长江证券', '华鑫证券', '里昂', '贝莱德', '桥水',
      '先锋领航', '黑石', '凯雷', '软银', '评级', '上调', '下调', '目标价', '研报', '分析师', '投行', '资管'
    ],
    ust: [
      '美债', '美债收益率', '美国国债', '十年期', '两年期', '美联储', '鲍威尔', 'FOMC', '联邦基金利率', '加息', '降息', '基点',
      '缩表', '隔夜逆回购', '美元指数', '国债拍卖'
    ],
    usstock: [
      '美股', '纳斯达克', '道琼斯', '标普500', '标普', '纽交所', 'ADR', '盘前', '盘后', '美国股市', '纳指', '美国上市', 'SEC'
    ],
    jpkstock: [
      '日经', '东证', '日股', '日本股市', 'KOSPI', '韩股', '韩国股市', '日本央行', '日元', '韩元', '日本内阁',
      '韩国央行', '三星电子', 'SK海力士', '东京证券交易所', '韩国交易所'
    ],
    hkstock: [
      '港股', '恒生指数', '恒指', '恒生科技', '港交所', 'H股', '香港股市', '中概股', '香港交易所', '恒生中国企业'
    ],
    gold: [
      '黄金', '金价', '现货金', 'COMEX黄金', '伦敦金', '央行购金', '金矿', '贵金属', '白银价格', '金条', '黄金ETF'
    ],
    oil: [
      '原油', '油价', 'WTI', '布伦特', 'OPEC', '石油', '页岩油', '炼油', '成品油', '天然气', '油轮', '原油期货',
      '石油输出国', '柴油', '汽油'
    ]
  };

  /* ============================================================
   * 概念分类（batch15）：把全部快讯按「题材概念」归类。
   * 与上面的题材维度不同——这里只看概念本身（AI / 固态电池 / 机器人…），
   * 不区分国家、市场、机构，一条快讯可同时命中多个概念。
   * ============================================================ */
  const BRIEF_CONCEPT_DIMS = [
    { key: 'c_ai', name: '人工智能', icon: '🤖', color: '#4f46e5' },
    { key: 'c_chip', name: '芯片半导体', icon: '🔲', color: '#0f766e' },
    { key: 'c_robot', name: '机器人', icon: '🦾', color: '#7c3aed' },
    { key: 'c_ce', name: '消费电子', icon: '📱', color: '#0891b2' },
    { key: 'c_frontier', name: '前沿科技', icon: '🧬', color: '#6366f1' },
    { key: 'c_data', name: '数字经济', icon: '💾', color: '#2563eb' },
    { key: 'c_nev', name: '新能源车', icon: '🚗', color: '#16a34a' },
    { key: 'c_battery', name: '电池储能', icon: '🔋', color: '#65a30d' },
    { key: 'c_pv', name: '光伏风电', icon: '☀️', color: '#ca8a04' },
    { key: 'c_space', name: '商业航天', icon: '🚀', color: '#1d4ed8' },
    { key: 'c_defense', name: '军工国防', icon: '🛡️', color: '#475569' },
    { key: 'c_pharma', name: '创新药', icon: '💊', color: '#be185d' },
    { key: 'c_device', name: '医疗器械', icon: '🩺', color: '#0e7490' },
    { key: 'c_consume', name: '消费白酒', icon: '🍶', color: '#c2410c' },
    { key: 'c_rare', name: '稀土小金属', icon: '🧲', color: '#a16207' },
    { key: 'c_metal', name: '有色金属', icon: '🪙', color: '#b45309' },
    { key: 'c_energy', name: '煤炭油气', icon: '🛢️', color: '#57534e' },
    { key: 'c_power', name: '电力电网', icon: '⚡', color: '#0284c7' },
    { key: 'c_re', name: '地产基建', icon: '🏗️', color: '#92400e' },
    { key: 'c_fintech', name: '数字货币', icon: '🪪', color: '#7e22ce' }
  ];

  const BRIEF_CONCEPT_KEYWORDS = {
    c_ai: ['人工智能', 'AI', 'AIGC', '大模型', '算力', 'GPU', '英伟达', 'OpenAI', 'ChatGPT', '深度学习', '机器学习',
      '智能体', 'Agent', '昇腾', '训练推理', '多模态', '文生视频', '算法', '智算', '数据中心算力'],
    c_chip: ['芯片', '半导体', '晶圆', '光刻', '封测', 'IC设计', 'EDA', '存储芯片', 'HBM', 'DRAM', 'NAND',
      '台积电', '中芯国际', '成熟制程', '先进制程', '第三代半导体', '碳化硅', '氮化镓', 'MCU', '模拟芯片'],
    c_robot: ['机器人', '人形机器人', '宇树', '减速器', '伺服电机', '机械臂', '具身智能', '灵巧手', '工业机器人'],
    c_ce: ['手机', '智能手机', 'iPhone', '折叠屏', '耳机', '可穿戴', 'VR', 'AR', 'AI眼镜', '智能眼镜', 'PC',
      '笔记本', '平板', '面板', '显示面板', '摄像头模组', '智能手表'],
    c_frontier: ['低空经济', 'eVTOL', '飞行汽车', '量子', '量子计算', '核聚变', '可控核聚变', '超导', '脑机接口',
      '合成生物', '6G', '基因编辑', '元宇宙', '脑科学'],
    c_data: ['数字经济', '数据要素', '数据中心', '东数西算', '信创', '国产替代', '操作系统', '数据库', '算力中心',
      '云计算', '网络安全', '数据交易', '公共数据'],
    c_nev: ['新能源车', '新能源汽车', '电动车', '电动汽车', '比亚迪', '特斯拉', '充电桩', '动力电池', '整车',
      '智能驾驶', '自动驾驶', '座舱', '车企', '乘用车', '换电', '汽车销量'],
    c_battery: ['电池', '锂电池', '固态电池', '储能', '钠离子', '电芯', '正极', '负极', '电解液', '隔膜',
      '麒麟电池', '4680', '电池回收', '钒电池', '抽水蓄能'],
    c_pv: ['光伏', '组件', '硅料', '硅片', '逆变器', '风电', '海上风电', '太阳能', 'TOPCON', 'HJT', '钙钛矿',
      '装机', '绿电', '新能源发电'],
    c_space: ['商业航天', '卫星', '火箭', '发射', '星链', '低轨', '遥感', '太空', '载人航天', '空间站', '千帆'],
    c_defense: ['军工', '国防', '军费', '导弹', '战机', '航母', '兵器', '北斗', '军贸', '装备采购', '军品', '舰艇'],
    c_pharma: ['创新药', '新药', '临床试验', '获批上市', 'FDA', '药审', '生物医药', 'ADC', 'GLP-1', '减肥药',
      'CAR-T', '疫苗', '原研药', '仿制药', '药企', 'CXO', '医药研发'],
    c_device: ['医疗器械', '医用', '高值耗材', 'IVD', '影像设备', '手术机器人', '基因测序', '体外诊断', '医疗设备'],
    c_consume: ['白酒', '茅台', '五粮液', '啤酒', '饮料', '食品', '调味品', '乳制品', '免税', '餐饮', '零食',
      '消费券', '白酒批价', '猪价'],
    c_rare: ['稀土', '永磁', '小金属', '钨', '钼', '锑', '钛材', '锆', '稀有金属', '磁材', '稀有资源'],
    c_metal: ['有色', '电解铝', '铜价', '铝价', '沪铜', '沪铝', '锌', '铅', '镍', '锡', '贵金属', '白银', '黄金',
      '锂矿', '钴'],
    c_energy: ['煤炭', '焦煤', '动力煤', '原油', '石油', '天然气', '油服', '油气', '页岩油', '煤矿', '油价'],
    c_power: ['电力', '电价', '发电', '火电', '水电', '核电', '电网', '特高压', '用电量', '电力体制', '售电', '机组'],
    c_re: ['房地产', '楼市', '房价', '房企', '保交楼', '基建', '专项债', '商品房', '土地出让', '物业', '购房', '建材'],
    c_fintech: ['数字货币', '数字人民币', '区块链', '稳定币', '跨境支付', 'Web3', '虚拟资产', '金融科技', '第三方支付']
  };

  /* ============================================================
   * 行业分类（batch15）：按「申万一级行业」口径把全部快讯归类。
   * 关键词刻意用行业用语（银行/信贷/券商/保费…）而不是公司名，
   * 这样同一条快讯讲的是哪家公司不重要，讲的是哪个行业才重要。
   * ============================================================ */
  const BRIEF_INDUSTRY_DIMS = [
    { key: 'i_bank', name: '银行', icon: '🏦', color: '#1e40af' },
    { key: 'i_broker', name: '非银金融', icon: '📈', color: '#b91c1c' },
    { key: 'i_re', name: '房地产', icon: '🏠', color: '#92400e' },
    { key: 'i_med', name: '医药生物', icon: '💉', color: '#be185d' },
    { key: 'i_elec', name: '电子', icon: '🔌', color: '#0f766e' },
    { key: 'i_comp', name: '计算机', icon: '💻', color: '#2563eb' },
    { key: 'i_tel', name: '通信', icon: '📡', color: '#0891b2' },
    { key: 'i_media', name: '传媒', icon: '🎬', color: '#db2777' },
    { key: 'i_power', name: '电力设备', icon: '🔋', color: '#65a30d' },
    { key: 'i_auto', name: '汽车', icon: '🚙', color: '#16a34a' },
    { key: 'i_mach', name: '机械设备', icon: '⚙️', color: '#475569' },
    { key: 'i_def', name: '国防军工', icon: '🛡️', color: '#334155' },
    { key: 'i_food', name: '食品饮料', icon: '🍶', color: '#c2410c' },
    { key: 'i_agri', name: '农林牧渔', icon: '🌾', color: '#4d7c0f' },
    { key: 'i_app', name: '家用电器', icon: '🧊', color: '#0369a1' },
    { key: 'i_text', name: '纺织服饰', icon: '👕', color: '#a21caf' },
    { key: 'i_light', name: '轻工制造', icon: '📦', color: '#a16207' },
    { key: 'i_retail', name: '商贸零售', icon: '🛒', color: '#ea580c' },
    { key: 'i_social', name: '社会服务', icon: '🎡', color: '#0d9488' },
    { key: 'i_bmat', name: '建筑材料', icon: '🧱', color: '#78716c' },
    { key: 'i_const', name: '建筑装饰', icon: '🏗️', color: '#92400e' },
    { key: 'i_steel', name: '钢铁', icon: '🔩', color: '#57534e' },
    { key: 'i_nonf', name: '有色金属', icon: '🪙', color: '#b45309' },
    { key: 'i_coal', name: '煤炭', icon: '⛏️', color: '#44403c' },
    { key: 'i_petro', name: '石油石化', icon: '🛢️', color: '#7c2d12' },
    { key: 'i_chem', name: '基础化工', icon: '🧪', color: '#3f6212' },
    { key: 'i_util', name: '公用事业', icon: '💡', color: '#0284c7' },
    { key: 'i_trans', name: '交通运输', icon: '🚢', color: '#1d4ed8' },
    { key: 'i_env', name: '环保', icon: '♻️', color: '#15803d' },
    { key: 'i_beauty', name: '美容护理', icon: '💄', color: '#db2777' }
  ];

  const BRIEF_INDUSTRY_KEYWORDS = {
    i_bank: ['银行', '信贷', '存款', '贷款', '净息差', '不良贷款', '不良率', '信用卡', '理财公司', 'LPR',
      '国有大行', '股份行', '城商行', '农商行', '存单', '再贷款'],
    i_broker: ['券商', '证券', '保险', '资管', '基金', '两融', 'IPO', '再融资', '保费', '投行', '营业部',
      '北交所', '公募', '私募', '信托', '期货公司', '金融监管总局'],
    i_re: ['房地产', '楼市', '房企', '楼盘', '土地出让', '保交楼', '物业', '租房', '购房', '商品房', '预售', '公积金'],
    i_med: ['医药', '生物医药', '药品', '疫苗', '医院', '医保', '临床试验', '原料药', '中药', 'CXO', '集采',
      '医疗服务', '药店', '创新药', 'CDE', '药审'],
    i_elec: ['电子', '半导体', '芯片', '面板', 'PCB', '被动元件', '消费电子', '元器件', '光刻', '封测', '晶圆', 'LED'],
    i_comp: ['软件', '信创', '操作系统', '数据库', '信息化', '云计算', 'SaaS', '国产软件', '网络安全',
      'IT服务', '人工智能应用', '算力租赁'],
    i_tel: ['通信', '5G', '6G', '运营商', '基站', '光缆', '光模块', '中国移动', '中国电信', '中国联通',
      '卫星通信', '宽带'],
    i_media: ['传媒', '影视', '游戏', '版号', '短剧', '广告', '出版', '直播', '短视频', '院线', '文化', 'IP'],
    i_power: ['光伏', '风电', '储能', '电池', '特高压', '电网设备', '逆变器', '新能源', '充电桩', '电力设备', '输变电'],
    i_auto: ['汽车', '整车', '车企', '乘用车', '商用车', '零部件', '轮胎', '经销商', '车市', '汽车销量',
      '重卡', '客车', '产销量'],
    i_mach: ['机械', '工程机械', '挖掘机', '机床', '自动化', '工控', '减速机', '重工', '装备制造', '机器人设备',
      '通用设备', '仪器仪表'],
    i_def: ['军工', '国防', '军品', '兵器', '航空装备', '船舶', '导弹', '军贸', '军费', '军工订单', '航天'],
    i_food: ['食品', '饮料', '白酒', '啤酒', '乳制品', '调味品', '零食', '餐饮', '酒类', '软饮', '白酒批价', '预制菜'],
    i_agri: ['农业', '种植', '养殖', '生猪', '种业', '饲料', '渔业', '粮食', '农产品', '猪价', '畜牧', '猪肉', '耕地'],
    i_app: ['家电', '空调', '冰箱', '洗衣机', '厨电', '小家电', '白电', '黑电', '家电下乡', '以旧换新'],
    i_text: ['纺织', '服装', '服饰', '鞋', '棉花', '化纤', '家纺', '品牌服装', '时尚', '面料'],
    i_light: ['轻工', '造纸', '包装', '家具', '家居', '文具', '玩具', '日用', '纸价', '浆价'],
    i_retail: ['零售', '商超', '电商', '免税', '百货', '便利店', '跨境电商', '消费', '购物', '社零', '线上销售'],
    i_social: ['旅游', '酒店', '景区', '教育', '培训', '人力资源', '会展', '餐饮住宿', '出行', '免税店'],
    i_bmat: ['建材', '水泥', '玻璃', '玻纤', '陶瓷', '防水', '管材', '装饰材料', '水泥价格'],
    i_const: ['建筑', '施工', '基建', '工程', '装饰', '园林', '建筑企业', '新签订单', '专项债', '市政'],
    i_steel: ['钢铁', '钢价', '钢材', '螺纹钢', '铁矿石', '钢厂', '特钢', '不锈钢', '高炉', '粗钢'],
    i_nonf: ['有色', '电解铝', '铜', '铝', '锌', '铅', '镍', '锡', '稀土', '黄金', '白银', '贵金属', '锂', '钴', '沪铜'],
    i_coal: ['煤炭', '焦煤', '动力煤', '焦炭', '煤矿', '煤价', '电煤', '原煤'],
    i_petro: ['石油', '原油', '石化', '炼化', '成品油', '油服', '天然气', '加油站', 'OPEC', '油气'],
    i_chem: ['化工', '化学品', '化肥', '农药', '化纤', '橡胶', '塑料', '纯碱', '氯碱', '氟化工', '磷化工', '钛白粉'],
    i_util: ['电力', '燃气', '水务', '供热', '电价', '自来水', '天然气供应', '发电', '用电', '供水'],
    i_trans: ['物流', '快递', '航运', '港口', '铁路', '公路', '航空', '机场', '运输', '运费', '集运', '油运', '航班'],
    i_env: ['环保', '污水处理', '固废', '垃圾', '大气治理', '节能', '碳中和', 'CCER', '碳排放', '环保督察'],
    i_beauty: ['化妆品', '医美', '美容', '护肤', '个护', '日化', '美妆']
  };

  /** 三套维度的注册表：题材归类 / 概念分类 / 行业分类 */
  const BRIEF_MODES = [
    { key: 'theme', name: '题材归类', dims: BRIEF_DIMENSIONS, dict: BRIEF_KEYWORDS },
    { key: 'concept', name: '概念分类', dims: BRIEF_CONCEPT_DIMS, dict: BRIEF_CONCEPT_KEYWORDS },
    { key: 'industry', name: '行业分类', dims: BRIEF_INDUSTRY_DIMS, dict: BRIEF_INDUSTRY_KEYWORDS }
  ];

  /**
   * 剥掉快讯统一前缀（"格隆汇9月16日｜"、"今日头条9月16日｜"…）与残留的 HTML 标签。
   * 来源名可由用户在界面上改，所以这里不再写死「格隆汇」，改成通用的「来源名+月日｜」前缀。
   */
  function cleanBriefText(text) {
    return decodeEntities(String(text || ''))
      .replace(/^[\u4e00-\u9fa5A-Za-z0-9]{0,10}\s*\d{1,2}月\d{1,2}日\s*[｜|丨]\s*/, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** 通用词典命中：返回命中的键数组 */
  function _hitDict(text, dict) {
    const hits = [];
    for (const name in dict) {
      const aliases = dict[name];
      for (let i = 0; i < aliases.length; i++) {
        if (text.indexOf(aliases[i]) >= 0) { hits.push(name); break; }
      }
    }
    return hits;
  }

  /**
   * 格隆汇每日快讯分类统计：一层 13 项，每项带该类全部快讯明细。
   * @param {Array<{text:string,time?:string,url?:string,date?:string,stocks?:string[],subjects?:string[]}>} items
   * @returns {Array<{key,name,icon,color,count,pct,width,news:Array}>} 按 BRIEF_DIMENSIONS 顺序返回
   */
  function briefStats(items, mode) {
    const m = (function () {
      for (const x of BRIEF_MODES) { if (x.key === mode) return x; }
      return BRIEF_MODES[0];
    })();
    const dims = m.dims;
    const dict = m.dict;
    const list = (items || []).filter(it => it && it.text);
    const base = list.length;
    const raw = dims.map(dim => {
      const kw = dict[dim.key] || [];
      const news = [];
      for (const it of list) {
        const t = cleanBriefText(it.text);
        if (!t) continue;
        if (kw.some(k => t.indexOf(k) >= 0)) news.push(it);
      }
      // 时间新的在前（快讯本身就是时间倒序，这里再兜一次底）
      news.sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));
      return { key: dim.key, name: dim.name, icon: dim.icon, color: dim.color, count: news.length, news };
    });
    // 自动按归类条数（比例）从大到小排序，便于一眼看到占比最高的分类
    raw.sort((a, b) => b.count - a.count);
    const max = raw.reduce((m, d) => Math.max(m, d.count), 1);
    raw.forEach(d => {
      d.pct = base ? Math.round((d.count / base) * 100) : 0;
      d.width = Math.max(4, Math.round((d.count / max) * 100));
    });
    return raw;
  }

  /* ================= 统计时间窗口（batch16） =================
   * 需求：跨站重合榜 / 主题分类统计 / 格隆汇每日快讯 三个板块的时间口径统一，
   * 并且「一天」的分界不是 24:00，而是每天 15:00（A股收盘后换日）。
   * 于是默认窗口 = 昨天 15:00 → 今天 15:00，用户可自行改成任意区间。
   */

  /** 一天的分界时点（小时）。15 表示「当天 15:00 之后算第二天」 */
  var WIN_CUTOFF_HOUR = 15;

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** Date → 'YYYY-MM-DDTHH:mm'，可直接喂给 <input type="datetime-local"> */
  function toLocalInputValue(d) {
    return fmtLocalDate(d) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /** 'YYYY-MM-DDTHH:mm' → Date（按本地时间解析；非法返回 null） */
  function fromLocalInputValue(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(s || '').trim());
    if (!m) return null;
    var d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0, 0);
    return isNaN(d.getTime()) ? null : d;
  }

  /** 默认结束时间：现在（用户要求「默认现在，可修改」） */
  function defaultWindowEnd(now) {
    var d = now ? new Date(now.getTime()) : new Date();
    d.setSeconds(0, 0);
    return d;
  }

  /** 默认开始时间：昨天 15:00（收盘换日口径） */
  function defaultWindowStart(now) {
    var d = now ? new Date(now.getTime()) : new Date();
    d.setDate(d.getDate() - 1);
    d.setHours(WIN_CUTOFF_HOUR, 0, 0, 0);
    return d;
  }

  /**
   * 快速跳到「上一个完整统计日」：以 15:00 为界。
   * 若现在还没到今天 15:00，上一个完整日 = [前天15:00, 昨天15:00)；
   * 若已过今天 15:00，则 = [昨天15:00, 今天15:00)。
   */
  function lastClosedWindow(now) {
    var n = now ? new Date(now.getTime()) : new Date();
    var end = new Date(n.getFullYear(), n.getMonth(), n.getDate(), WIN_CUTOFF_HOUR, 0, 0, 0);
    if (n.getTime() < end.getTime()) end.setDate(end.getDate() - 1);
    var start = new Date(end.getTime());
    start.setDate(start.getDate() - 1);
    return { start: start, end: end };
  }

  /** 时间戳 → 'YYYY年M月D日 HH:mm'（展示用，与需求里的格式一致） */
  function fmtWindowCN(ts) {
    var d = new Date(Number(ts));
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /** 闭开区间判断：[start, end) */
  function inWindow(ts, startMs, endMs) {
    var t = Number(ts);
    if (!isFinite(t)) return false;
    return t >= Number(startMs) && t < Number(endMs);
  }

  /**
   * 解析快讯的时间字段。briefs 里是 'YYYY-MM-DD HH:mm'（北京时间）。
   * 统一按「本地时间」解析 —— 与窗口输入的口径保持一致。
   */
  function parseBriefTime(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(s || '').trim());
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0, 0).getTime();
  }

  /**
   * 统计窗口覆盖到哪些快照日期（自然日）。
   * 快照每天一份、且历史快照没有逐条时间戳，只能按「日」粒度纳入，
   * 所以这里把与窗口有交集的自然日全部返回，由调用方再按条级时间戳精筛。
   */
  function windowSnapshotDates(startMs, endMs) {
    var out = [];
    var s = new Date(Number(startMs)), e = new Date(Number(endMs));
    if (isNaN(s.getTime()) || isNaN(e.getTime())) return out;
    var cur = new Date(s.getFullYear(), s.getMonth(), s.getDate());
    var last = new Date(e.getFullYear(), e.getMonth(), e.getDate());
    var guard = 0;
    while (cur.getTime() <= last.getTime() && guard++ < 400) {
      out.push(fmtLocalDate(cur));
      cur.setDate(cur.getDate() + 1);
    }
    return out;
  }

  global.HotTopics = {
    CATEGORIES, CATEGORY_COLORS, SOURCE_ORDER, SOURCE_BY_KEY,
    classify, normalizeTitle, bigrams, jaccard, signalTokens, isSameTopic,
    clusterItems, siteCategoryStats,
    THEME_DIMENSIONS, THEME_KEYWORDS, themeStats,
    BRIEF_DIMENSIONS, BRIEF_KEYWORDS, briefStats, cleanBriefText,
    BRIEF_CONCEPT_DIMS, BRIEF_CONCEPT_KEYWORDS,
    BRIEF_INDUSTRY_DIMS, BRIEF_INDUSTRY_KEYWORDS,
    BRIEF_MODES,
    decodeEntities, isJunkTitle, cleanTitle,
    fmtLocalDate, todayStr, snapshotCandidates,
    /* 统计时间窗口（15:00 换日口径） */
    WIN_CUTOFF_HOUR,
    toLocalInputValue, fromLocalInputValue,
    defaultWindowStart, defaultWindowEnd, lastClosedWindow,
    fmtWindowCN, inWindow, parseBriefTime, windowSnapshotDates
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.HotTopics;
})(typeof window !== 'undefined' ? window : globalThis);
