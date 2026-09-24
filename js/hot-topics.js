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
  const CATEGORIES = ['军事', '科技', '政治政策', '财经', '经济', '百强企业', '社会热点'];

  /* batch32：分类改名兼容表。
   * 「世界500强领导者动态」改名为「百强企业」，但历史快照（data/hot-topics/*.json）里
   * 已经落库的条目仍带着旧分类名。若不兼容，这些条目会：① 取不到颜色变灰；② 被分类筛选漏掉；
   * ③ 在分类分布统计里凭空消失。所以读历史数据时统一过一遍 normalizeCategory。 */
  const CATEGORY_ALIASES = {
    '世界500强领导者动态': '百强企业'
  };
  /** 旧分类名 → 新分类名；不在表里的原样返回 */
  function normalizeCategory(c) {
    const s = String(c == null ? '' : c);
    return CATEGORY_ALIASES[s] || s;
  }

  const CATEGORY_COLORS = {
    '军事': '#8b5a2b',
    '科技': '#2563eb',
    '政治政策': '#9b2fb5',
    '经济': '#0a7d3e',
    '百强企业': '#b45309',
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
    // batch32：分类显示名改为「百强企业」，关键词一条未动——判定逻辑仍是「世界500强企业领导者动态」
    '百强企业': ['世界500强', '500强', '总裁', '董事长', '创始人', 'CEO', '高管', '换帅', '辞职', '任命', '退休', '离任', '接任', '掌门人', '接班人', '苹果', '微软', '特斯拉', '亚马逊', '谷歌', '英伟达', '伯克希尔', '马斯克', '库克', '黄仁勋', '贝索斯', '扎克伯格', '丰田', '三星', '壳牌', '沃尔玛', '华为', '腾讯', '阿里', '阿里巴巴', '字节', '百度', '京东', '小米', '比亚迪', '宁德时代', '美团', '网易', '快手', '蔚来', '理想', '小鹏', '滴滴'],
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
    // 请求R：财联社 → 新浪财经 7x24 实时新闻（zhibo feed 接口，字段 create_time / rich_text）
    { rank: 5, key: 'sina', name: '新浪财经', color: '#e60012', parse: 'json_sina', endpoint: 'https://zhibo.sina.com.cn/api/zhibo/feed?page=1&page_size=50&zhibo_id=152&tag_id=0&dire=f&dpc=1', base: 'https://finance.sina.com.cn' },
    { rank: 6, key: 'kaipanla', name: '开盘啦', color: '#f59e0b', parse: 'html_kaipanla', endpoint: 'https://www.kaipanla.com/', base: 'https://www.kaipanla.com' },
    /* 请求T：投实官网**没有任何公开新闻流**——整站只有一个 App 产品落地页，
     * m. / api. 子域泛解析回同一页，/news 与 /api/telegraph 均 404，HTML 抽取只能抓到页脚备案号。
     * 故换成证券时报（stcn.com）：UTF-8 无编码问题，实测首页可抽到 195 条真实标题，A股/上市公司导向。 */
    { rank: 7, key: 'stcn', name: '证券时报', color: '#c8102e', parse: 'html_stcn', endpoint: 'https://www.stcn.com/', base: 'https://www.stcn.com' },
    /* 请求T：原 endpoint 用的旧 api-prod 域名 **已彻底下线**（连接超时），这是该源长期 0 条的根因。
     * 换成实测可用的 api-one.wallstcn.com + channel=global-channel，一次返回 50 条。 */
    { rank: 8, key: 'wscn', name: '华尔街见闻', color: '#222222', parse: 'json_wscn', endpoint: 'https://api-one.wallstcn.com/apiv1/content/lives?channel=global-channel&client=pc&limit=50' },
    // 请求R：万得 → 金十数据实时快讯（字段 time / data.content）
    { rank: 9, key: 'jin10', name: '金十数据', color: '#1267c7', parse: 'json_jin10', endpoint: 'https://flash-api.jin10.com/get_flash_list?channel=-8200&vip=1', base: 'https://flash.jin10.com' },
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
    /^[>\u00bb\u203a<\u00ab\u2039\u300a\u300b|\uFF5C\u00b7\u3001,\uFF0C.\u3002:\uFF1A;\uFF1B!！?？\-—_~…\s]+$/,
    /* ↓↓↓ 请求T：网页页脚残留。HTML 抽取源（如证券时报/开盘啦/中国证券）会把页脚的备案号、
     * 版权声明、邮箱电话一起抽进来，之前没有对应规则，导致「京ICP备20001999号-1」被当成新闻。
     * 以下都做了防误伤处理：正常新闻标题不会有「备+5位数字+号」、邮箱或 11 位手机号。 */
    /ICP\s*备?\s*\d|备\s*\d{5,}\s*号|公安?备\s*\d/i,      // 京ICP备20001999号-1 / 京公网安备11010602007270号
    /beian|miit/i,                                        // 备案查询站（beian.miit.gov.cn）
    /版权所有|Copyright|©/i,                              // Copyright ©2014- 投实内容科技…
    /[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/,                      // 邮箱：xxx@example.com / hr@xxx
    /(?:^|[^\d])1[3-9]\d{9}(?:$|[^\d])/,                  // 手机号（前后不能是数字，避免误伤长数字串）
    /(电话|手机|热线|客服|传真)[:：]\s*\d/,                  // 联系电话：18701603…
    /网站地图|站点地图|网站声明|免责声明|隐私(政策|声明)/,     // 页脚导航
    /(关于我们|关于本站|加入我们|商务合作|友情链接|意见反馈|用户反馈|招聘|诚聘)/
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

  /* ============================================================
   * batch56：严格分类引擎（主题判定）
   * ------------------------------------------------------------
   * 背景（用户实测反馈）：旧逻辑「命中任一关键词即归入」误伤严重 ——
   *   例：中信证券研报《AI算力迈入全液冷时代》被归到「互联网电商」，
   *       只因正文出现「主流平台」的“平台”二字；「出海→跨境电商」「中信/证券→银行券商」
   *       「直播→数字媒体」「关税→自贸港」同属这一类误伤。
   * 新逻辑（四道闸门）：
   *   ① 词权（特异度）：词越长越专 → 权重越高；1~2 字泛词权重很低。
   *   ② 歧义折价：同一个词在本层词典里被 ≥2 个类别共用 → 打折；≥3 个 → 重罚（视为泛词）。
   *   ③ 位置加权：命中落在开头 SUBJ_HEAD 字（事件主体区）→ ×1.35。
   *   ④ 主体判定（用户要求「对内容和主要发文主体进行判断」）：
   *       - 券商研报 / 媒体刊文（研报、刊文、记者、分析师…）只是**转述方**，
   *         它名字里的词（中信、证券、日报…）一律不计分 —— 避免把研报来源当成新闻主题；
   *       - 公司/机构是**事件主角**时（Meta宣布、高通宣布…），按 ENTITY_MAP 给对应类别加分。
   * 最后裁决：总分 < MIN_SCORE 淘汰；只保留 ≥ max(MIN_SCORE, REL_CUT×最高分) 的类别（最多 MAX_KEEP 个），
   *          「顺带提到」的类别被相对分挤掉，主线类别留下来。
   * ============================================================ */
  const STRICT_CFG = {
    MIN_SCORE: 1.0,      // 归入某类的最低分（低于此值视为顺带提到）
    REL_CUT: 0.35,       // 相对截断：只保留 ≥ 最高分 × 该系数的类别（保留多标签：0.35 只砍「顺带提到」）
    MAX_KEEP: 6,         // 一条新闻最多归入几个类别
    HEAD: 40,            // 「开头主体区」长度
    HEAD_BOOST: 1.35,    // 主体区内命中的加权
    ENTITY_BONUS: 1.8,   // 事件主角（公司/机构）命中时的加分
    COMBO_SCORE: 2.4,    // must/any 组合规则整体命中的基础分
    AMB2: 0.8,           // 被 2 个类别共用的词的折价
    AMB3: 0.4,           // 被 ≥3 个类别共用的词的折价
    GENERIC: 0.45        // 通用泛词（平台/出海/订单…）的折价
  };

  /** 主体（公司/机构/国家）→ 该主体真正对应的类别名。命中时给该类别加分。 */
  const ENTITY_MAP = {
    // 科技 / 半导体 / 算力
    '英伟达': ['算力', '半导体', '人工智能'], 'NVIDIA': ['算力', '半导体'], 'AMD': ['半导体', '算力'],
    '高通': ['半导体', '通信'], '英特尔': ['半导体', '芯片'], '台积电': ['半导体', '芯片'],
    '三星电子': ['半导体', '存储芯片'], 'SK海力士': ['半导体', '存储芯片'], '美光': ['半导体', '存储芯片'],
    '阿斯麦': ['半导体设备'], '寒武纪': ['国产芯片', '算力', '半导体'], '海光': ['国产芯片', '半导体'],
    '中芯国际': ['半导体', '芯片'], '华为': ['通信', '国产替代', '消费电子'], '苹果': ['消费电子', '手机'],
    '微软': ['计算机', '人工智能'], '谷歌': ['人工智能', '互联网'], 'OpenAI': ['人工智能', '大模型'],
    'DeepSeek': ['人工智能', '大模型'], '字节': ['互联网', '人工智能'], '腾讯': ['互联网', '传媒'],
    '阿里': ['互联网', '电商', '人工智能'], '百度': ['互联网', '人工智能', '自动驾驶'],
    '京东': ['互联网', '电商'], '美团': ['互联网', '本地生活'], '拼多多': ['互联网', '电商'],
    '亚马逊': ['互联网', '跨境电商'], 'Meta': ['互联网', '元宇宙'], '小米': ['消费电子', '手机', '汽车'],
    'SpaceX': ['商业航天'], '星链': ['商业航天'],
    // 新能源 / 汽车
    '特斯拉': ['汽车', '电动车', '自动驾驶'], '比亚迪': ['汽车', '电动车', '锂电池'],
    '宁德时代': ['锂电池', '储能', '电力设备'], '蔚来': ['汽车', '电动车'], '小鹏': ['汽车', '电动车'],
    '理想': ['汽车', '电动车'], '丰田': ['汽车'], '大众汽车': ['汽车'], '宝马': ['汽车'], '奔驰': ['汽车'],
    '隆基': ['光伏', '电力设备'], '通威': ['光伏'], '阳光电源': ['光伏', '储能'],
    '宇树': ['人形机器人', '机器人'], '优必选': ['人形机器人', '机器人'],
    // 金融
    '中信证券': ['非银金融', '券商'], '中金公司': ['非银金融'], '国泰海通': ['非银金融'],
    '高盛': ['非银金融'], '摩根士丹利': ['非银金融'], '摩根大通': ['非银金融'], '伯克希尔': ['非银金融'],
    '美联储': ['银行'], '中国人民银行': ['银行'], '欧洲央行': ['银行'], '日本央行': ['银行'],
    // 资源 / 能源
    '中石油': ['石油石化'], '中石化': ['石油石化'], '中海油': ['石油石化'], '沙特阿美': ['石油石化'],
    '埃克森美孚': ['石油石化'], '壳牌': ['石油石化'], 'OPEC': ['石油石化'],
    '紫金矿业': ['有色金属', '贵金属'], '必和必拓': ['有色金属'], '淡水河谷': ['钢铁', '有色金属'],
    '中国神华': ['煤炭'],
    // 医药 / 消费 / 其它
    '辉瑞': ['医药生物', '创新药'], '默沙东': ['医药生物', '创新药'], '诺华': ['医药生物'],
    '恒瑞医药': ['医药生物', '创新药'], '药明康德': ['医药生物'],
    '茅台': ['食品饮料', '白酒'], '五粮液': ['食品饮料', '白酒'], '伊利': ['食品饮料'],
    '美的': ['家用电器', '家电'], '格力': ['家用电器', '家电'], '海尔': ['家用电器', '家电'],
    '沃尔玛': ['商贸零售'], '百思买': ['商贸零售'], '麦当劳': ['社会服务']
  };

  /** 主体抽取：句首「谁 + 谓词」。例：中信证券研报称 / Meta宣布 / 高通宣布 */
  const SUBJECT_RE = /^([^，,。；;！!？?（(、\s]{2,12}?)(?=宣布|表示|称|研报|公告|刊文|报道|透露|预计|计划|拟|指出|强调|发布|推出|签署|达成|启动|获批|拟收购)/;
  /** 转述方 hint：研报 / 媒体刊文 —— 这类主体只是转述，不代表新闻主题 */
  const RELAY_HINT = /(研报|刊文|评论员|分析师|记者|据报道|文章指出|文章称|社论|媒体|据.{0,6}日报)/;
  const RELAY_ENTITY = /(证券|基金|资管|研究所|研究院|日报|时报|周刊|商报|网|电视台|通讯社|新闻社|财联社|路透|彭博|华尔街见闻|经济观察)/;

  function extractSubject(text) {
    const t = String(text || '');
    const m = SUBJECT_RE.exec(t);
    const name = m ? m[1] : '';
    const len = name ? name.length : 0;
    const relay = !name || RELAY_HINT.test(t.slice(0, STRICT_CFG.HEAD)) || RELAY_ENTITY.test(name);
    return { name: name, len: len, relay: relay };
  }

  /**
   * 通用泛词表：这些词在任何主题里都可能出现（「平台」「出海」「订单」「项目」…），
   * 单独出现**不足以判定主题** —— 只在本类另有强词命中时作为佐证（×0.45）。
   * 典型误伤：中信证券《AI算力迈入全液冷时代》里的「主流平台」→ 旧逻辑直接归到「互联网电商」。
   */
  const GENERIC_WORDS = {
    // 业务/经营泛词
    '平台': 1, '出海': 1, '服务': 1, '系统': 1, '产业': 1, '领域': 1, '市场': 1, '业务': 1, '产品': 1,
    '客户': 1, '用户': 1, '数据': 1, '网络': 1, '信息': 1, '资源': 1, '设备': 1, '材料': 1, '制造': 1,
    '工业': 1, '企业': 1, '公司': 1, '集团': 1, '行业': 1, '板块': 1, '概念': 1, '龙头': 1, '产能': 1,
    '厂商': 1, '标准': 1, '落地': 1, '项目': 1, '合作': 1, '增长': 1, '需求': 1, '供给': 1, '订单': 1,
    '业绩': 1, '转型': 1, '升级': 1, '应用': 1, '布局': 1, '推进': 1, '加速': 1, '支持': 1, '技术': 1,
    '创新': 1, '研发': 1, '投资': 1, '融资': 1, '资金': 1, '资本': 1, '生态': 1, '方案': 1, '场景': 1,
    '模式': 1, '渠道': 1, '品牌': 1, '门店': 1, '物流': 1, '仓储': 1, '管理': 1, '运营': 1, '销售': 1,
    '营销': 1, '广告': 1, '内容': 1, '版权': 1, '监管': 1, '合规': 1, '库存': 1, '招标': 1, '中标': 1,
    '签约': 1, '开工': 1, '投产': 1, '竣工': 1, '扩产': 1, '减产': 1, '停产': 1, '出口': 1, '进口': 1,
    '贸易': 1, '消费': 1, '价格': 1, '规模': 1, '预期': 1, '计划': 1, '战略': 1, '协议': 1, '签署': 1,
    '收购': 1, '并购': 1, '重组': 1, '上市': 1, '发行': 1, '股份': 1, '股东': 1, '回购': 1, '增持': 1,
    '分红': 1, '基金': 1, '机构': 1, '评级': 1, '涨价': 1, '降价': 1, '提价': 1, '缺口': 1, '紧张': 1,
    '刺激': 1, '补贴': 1, '退税': 1, '关税': 1, '制裁': 1, '谈判': 1, '会晤': 1, '声明': 1, '讲话': 1,
    '选举': 1, '法案': 1, '批复': 1, '新规': 1, '出台': 1, '试点': 1, '示范': 1, '规划': 1, '公告': 1,
    '报告': 1, '直播': 1, '基建': 1, '供应': 1, '全球': 1, '国际': 1, '国内': 1, '海外': 1, '本土': 1,
    // 实测误伤补齐：「射电信号」→轨交设备、「智能眼镜」→饰品、「商业船只」→零售、
    // 「股指期货」→多元金融、「可用金属库存」→贵金属
    '信号': 1, '眼镜': 1, '商业': 1, '期货': 1, '金属': 1, '资金': 1, '车辆': 1,
    // 机构名碎片（会命中券商/银行的简称，靠主体判定之外再兜一层）
    '中信': 1, '中金': 1, '国泰': 1, '华泰': 1, '招商': 1, '证券': 1
  };

  /** 词的基础特异度权重：越长越专，越短越泛 */
  function kwSpecificity(kw) {
    const n = kw.length;
    if (/^[A-Za-z0-9]/.test(kw)) {          // ASCII 术语（GPU / HBM / eVTOL…）
      if (n >= 6) return 2.0;
      if (n === 5) return 1.8;
      if (n === 4) return 1.6;
      if (n === 3) return 1.3;
      return 1.0;                            // AI / IP / 5G 这类 2 字符：靠歧义折价兜底
    }
    if (n >= 5) return 2.2;
    if (n === 4) return 1.8;
    if (n === 3) return 1.4;
    if (n === 2) return 1.0;
    return 0.35;                             // 单字：几乎不具判定力
  }

  /** 词典索引：统计每个词被多少个类别共用（歧义度），按词典缓存 */
  const DICT_INDEX = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;
  function dictIndex(dict) {
    if (DICT_INDEX && DICT_INDEX.has(dict)) return DICT_INDEX.get(dict);
    const cnt = Object.create(null);
    for (const name in dict) {
      const rule = dict[name];
      let kws = [];
      if (Array.isArray(rule)) kws = rule;
      else if (rule) {
        kws = (rule.any || []).slice();
        (rule.must || []).forEach(g => { if (Array.isArray(g)) kws = kws.concat(g); });
      }
      const seen = Object.create(null);
      for (let i = 0; i < kws.length; i++) {
        const kw = kws[i];
        if (typeof kw !== 'string' || !kw || seen[kw]) continue;
        seen[kw] = 1;
        cnt[kw] = (cnt[kw] || 0) + 1;
      }
    }
    if (DICT_INDEX) DICT_INDEX.set(dict, cnt);
    return cnt;
  }

  function kwWeight(kw, cnt) {
    let w = kwSpecificity(kw);
    const n = cnt[kw] || 1;
    if (n >= 3) w *= STRICT_CFG.AMB3;
    else if (n === 2) w *= STRICT_CFG.AMB2;
    if (GENERIC_WORDS[kw]) w *= STRICT_CFG.GENERIC;   // 泛词：只作佐证，不能单独定性
    return w;
  }

  /**
   * 对一条文本，在给定词典上给每个候选类别打分（核心函数，三处分类入口共用）。
   * @param {string} text 已清洗的文本
   * @param {Object} dict 词典：类别键 → 关键词数组 或 {must,any}
   * @param {string[]} keys 候选键（决定遍历顺序与返回范围）
   * @param {(k:string)=>string} nameOf 键 → 类别显示名（主体加分按显示名匹配 ENTITY_MAP）
   * @returns {Array<{key:string,name:string,score:number}>} 已裁决、按分降序
   */
  function scoreEntries(text, dict, keys, nameOf) {
    const t = String(text || '');
    if (!t || !dict) return [];
    const cnt = dictIndex(dict);
    const sub = extractSubject(t);
    const head = STRICT_CFG.HEAD;
    const scored = [];
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const rule = dict[k];
      if (!rule) continue;
      let s = 0;
      if (Array.isArray(rule)) {
        for (let j = 0; j < rule.length; j++) {
          const kw = rule[j];
          if (typeof kw !== 'string' || !kw) continue;
          const p = t.indexOf(kw);
          if (p < 0) continue;
          // 转述方屏蔽：券商/媒体研报的主体名里的词不计分（中信、证券、日报…）
          if (sub.relay && sub.len && p < sub.len) continue;
          s += kwWeight(kw, cnt) * (p < head ? STRICT_CFG.HEAD_BOOST : 1);
        }
      } else {
        // {must,any} 组合规则：整体命中本身就是强信号；any 里的词另计词权
        if (_hitRule(t, rule)) s += STRICT_CFG.COMBO_SCORE;
        const anyKw = rule.any || [];
        for (let j = 0; j < anyKw.length; j++) {
          const kw = anyKw[j];
          const p = t.indexOf(kw);
          if (p < 0) continue;
          if (sub.relay && sub.len && p < sub.len) continue;
          s += kwWeight(kw, cnt) * (p < head ? STRICT_CFG.HEAD_BOOST : 1);
        }
      }
      // 事件主角加分（转述方不加）
      if (!sub.relay && sub.name) {
        const nm = nameOf ? nameOf(k) : k;
        for (const ent in ENTITY_MAP) {
          if (sub.name.indexOf(ent) < 0) continue;
          const cats = ENTITY_MAP[ent];
          for (let c = 0; c < cats.length; c++) {
            if (cats[c] === nm || String(k) === cats[c]) { s += STRICT_CFG.ENTITY_BONUS; break; }
          }
        }
      }
      if (s > 0) scored.push({ key: k, name: nameOf ? nameOf(k) : k, score: s });
    }
    if (!scored.length) return [];
    scored.sort((a, b) => b.score - a.score);
    const max = scored[0].score;
    if (max < STRICT_CFG.MIN_SCORE) return [];
    const cut = Math.max(STRICT_CFG.MIN_SCORE, max * STRICT_CFG.REL_CUT);
    return scored.filter(x => x.score >= cut).slice(0, STRICT_CFG.MAX_KEEP);
  }

  /* ---------- 分类（7 大类，互斥：取最高分） ---------- */
  function classify(text) {
    const t = (text || '').toString();
    if (!t) return '财经';
    const rows = scoreEntries(t, CATEGORY_KEYWORDS, CATEGORIES, k => k);
    return rows.length ? rows[0].key : '财经';   // 投资工具语境下，未达门槛归为财经
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
    SOURCE_ORDER.forEach(s => { bySource[s.key] = { rank: s.rank, key: s.key, name: s.name, color: s.color, byCat: {}, news: {}, total: 0 }; });
    for (const it of (items || [])) {
      const st = bySource[it.sourceKey];
      if (!st) continue;
      // batch32：历史快照里的旧分类名先归一化，否则改名后这些条目会从分布统计里消失
      const cat = normalizeCategory(it.cat || '财经');
      st.byCat[cat] = (st.byCat[cat] || 0) + 1;
      // 请求S：dist 每项带上该站该分类的新闻，供点分类弹窗查看
      if (!st.news[cat]) st.news[cat] = [];
      st.news[cat].push(it);
      st.total++;
    }
    return SOURCE_ORDER.map(s => {
      const st = bySource[s.key];
      const dist = CATEGORIES.map(cat => ({ cat, name: cat, count: st.byCat[cat] || 0, news: st.news[cat] || [] }))
        .filter(d => d.count > 0)
        .sort((a, b) => b.count - a.count);
      const max = dist.length ? dist[0].count : 1;
      dist.forEach(d => {
        d.pct = Math.round((d.count / (st.total || 1)) * 100);
        d.width = Math.max(6, (d.count / max) * 100);
        d.news.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.time || '').localeCompare(String(a.time || '')));
      });
      return { rank: st.rank, key: st.key, name: st.name, color: st.color, total: st.total, hitTotal: st.total, byCat: st.byCat, dist };
    });
  }

  /**
   * 请求S：各站「主题维度」统计（默认概念，也可传 industry/product/chain/tech）。
   * 与 siteCategoryStats（7 大类，互斥、每条只归 1 类）不同：
   * 这里是**多标签命中**——一条新闻可同时命中多个概念，回答的是「这个站的新闻涉及哪些概念板块」。
   * @param {Array} items 扁平新闻（含 sourceKey / text）
   * @param {string} dimKey THEME_KEYWORDS 的维度键
   * @returns 与 siteCategoryStats 同构：dist[].news 为该站该主题命中的全部新闻，供点开弹窗
   */
  function siteThemeStats(items, dimKey) {
    const dict = THEME_KEYWORDS[dimKey];
    const bySource = {};
    SOURCE_ORDER.forEach(s => {
      bySource[s.key] = { rank: s.rank, key: s.key, name: s.name, color: s.color, counter: {}, bucket: {}, total: 0, hitTotal: 0 };
    });
    for (const it of (items || [])) {
      const st = bySource[it.sourceKey];
      if (!st) continue;
      st.total++;
      if (!it || !it.text || !dict) continue;
      const hits = _hitTopics(it.text, dimKey);
      if (!hits.length) continue;
      st.hitTotal++;
      for (const name of hits) {
        st.counter[name] = (st.counter[name] || 0) + 1;
        if (!st.bucket[name]) st.bucket[name] = [];
        st.bucket[name].push(it);
      }
    }
    return SOURCE_ORDER.map(s => {
      const st = bySource[s.key];
      const dist = Object.keys(st.counter)
        .map(name => ({ name: name, cat: name, count: st.counter[name], news: st.bucket[name] || [] }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
      const max = dist.length ? dist[0].count : 1;
      dist.forEach(d => {
        d.pct = st.total ? Math.round((d.count / st.total) * 100) : 0;
        d.width = Math.max(6, Math.round((d.count / max) * 100));
        d.news.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.time || '').localeCompare(String(a.time || '')));
      });
      return { rank: st.rank, key: st.key, name: st.name, color: st.color, total: st.total, hitTotal: st.hitTotal, dist: dist };
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

  /** 取某条文本命中的主题（该维度内的主题名数组）—— batch56 起走严格打分，不再「命中即算」 */
  function _hitTopics(text, dimKey) {
    const dict = THEME_KEYWORDS[dimKey];
    if (!dict) return [];
    const keys = Object.keys(dict);
    return scoreEntries(text, dict, keys, k => k).map(r => r.key);
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
    // batch31：原名「国家政策类」改为「各省项目」，口径从「国家部委政策」改为「各省市本年度重大项目」，
    // 并额外产出可展开的项目清单（projectList: true → briefStats 会附 d.projects）。
    { key: 'policy', name: '各省项目', icon: '🗺️', color: '#9b2fb5', projectList: true },
    // batch31：原名「世界500强」改为「世界百强」。计算逻辑不变——仍按世界 500 强企业相关新闻归纳统计。
    { key: 'fortune500', name: '世界百强', icon: '🌍', color: '#b45309' },
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

  /* ============================================================
   * batch31：「各省项目」用的省级行政区词表。
   * 只列省/自治区/直辖市/特别行政区本体（不含地级市），
   * 因为「本年度重大项目」的发布主体基本都是省级政府/省发改委。
   * 顺序按「简称短的在后」无关，匹配时取全表命中。
   * ============================================================ */
  const PROVINCES = [
    '北京', '上海', '天津', '重庆',
    '河北', '山西', '辽宁', '吉林', '黑龙江', '江苏', '浙江', '安徽',
    '福建', '江西', '山东', '河南', '湖北', '湖南', '广东', '海南',
    '四川', '贵州', '云南', '陕西', '甘肃', '青海', '台湾',
    '内蒙古', '广西', '西藏', '宁夏', '新疆',
    '香港', '澳门'
  ];

  /* 「重大项目」特征词：与省市名同时出现才算数。
   * 选词原则——只留「项目 / 投资」语义强的词；并且刻意排除两类：
   *   ① 裸金额单位（亿元 / 万元 / 万亿）：只是单位，会把「浙江某企业营收突破 100 亿元」误判成重大项目；
   *   ② 弱动词（投产 / 竣工 / 奠基 / 动工 / 战略合作 / 基础设施 …）：
   *      配上一个高频城市名就会误伤，例如「特斯拉上海储能工厂正式投产」里的「上海 + 投产」。
   * 金额只在生成清单时抽取，不参与归类判定。 */
  const PROJECT_WORDS = [
    '重大项目', '重点项目', '重大工程', '重点工程', '一号工程',
    '项目开工', '开工建设', '集中开工', '集中签约', '项目集中开工',
    '省重点项目', '省级重点项目', '年度重点项目', '重点项目名单', '重大项目清单', '项目清单',
    '签约仪式', '项目签约', '招商引资', '项目落地', '落地开工',
    '总投资', '投资额', '投资规模', '项目投资', '拟投资', '计划投资', '年度投资',
    '百亿级', '十亿级', '亿元级'
  ];

  /* 分类 → 关键词。命中任一即归入该类。
   * 刻意避开「社会」「规划」「监管」「台风」这类过于宽泛或歧义的词：
   * 实测过宽会误伤（如「台风」会命中 F-15「台风」战斗机、「规划」会命中投资者提问）。 */
  const BRIEF_KEYWORDS = {
    // batch31：口径改为「各省市本年度重大项目」。这里用组合规则而不是纯「命中任一」：
    //   ① must：必须同时出现「省市名」+「项目/投资特征词」才归入（避免「营收超亿元」这类误伤）；
    //   ② any ：出现强特征词（集中开工 / 重大项目 / 省重点项目…）直接归入，不要求省市名同时出现。
    // 二者满足其一即命中。原来的国家级部委词（国务院/央行/财政部…）已移除——那不属于「各省项目」。
    policy: {
      must: [PROVINCES, PROJECT_WORDS],
      any: [
        '重大项目', '重点项目', '重大工程', '重点工程',
        '集中开工', '集中签约', '项目集中开工', '开工仪式',
        '一批重大项目', '重大项目清单', '项目清单',
        '年度重点项目', '省重点项目', '省级重点项目', '重点项目名单',
        '省发改委', '省人民政府', '省工信厅', '省政府印发'
      ]
    },
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
  /* ===== 概念分类（batch48 扩展：≥150 个，覆盖科技/新能源/汽车/医药/军工/消费/农业/资源/金融/传媒/环保/机械/通信/主题）===== */
  /* ===== 概念分类（batch48 扩展：≥150 个，覆盖科技/新能源/汽车/医药/军工/消费/农业/资源/金融/传媒/环保/机械/通信/主题）===== */
  const BRIEF_CONCEPT_DIMS = [{"key":"c_001","name":"人工智能","icon":"🤖","color":"#4f46e5","group":"科技"},{"key":"c_002","name":"算力","icon":"🤖","color":"#4338ca","group":"科技"},{"key":"c_003","name":"云计算","icon":"🤖","color":"#6366f1","group":"科技"},{"key":"c_004","name":"数据中心","icon":"🤖","color":"#3730a3","group":"科技"},{"key":"c_005","name":"东数西算","icon":"🤖","color":"#7c3aed","group":"科技"},{"key":"c_006","name":"信创","icon":"🤖","color":"#4f46e5","group":"科技"},{"key":"c_007","name":"网络安全","icon":"🤖","color":"#4338ca","group":"科技"},{"key":"c_008","name":"数据要素","icon":"🤖","color":"#6366f1","group":"科技"},{"key":"c_009","name":"数字经济","icon":"🤖","color":"#3730a3","group":"科技"},{"key":"c_010","name":"量子科技","icon":"🤖","color":"#7c3aed","group":"科技"},{"key":"c_011","name":"半导体","icon":"🤖","color":"#4f46e5","group":"科技"},{"key":"c_012","name":"半导体设备","icon":"🤖","color":"#4338ca","group":"科技"},{"key":"c_013","name":"半导体材料","icon":"🤖","color":"#6366f1","group":"科技"},{"key":"c_014","name":"第三代半导体","icon":"🤖","color":"#3730a3","group":"科技"},{"key":"c_015","name":"先进封装","icon":"🤖","color":"#7c3aed","group":"科技"},{"key":"c_016","name":"存储芯片","icon":"🤖","color":"#4f46e5","group":"科技"},{"key":"c_017","name":"国产芯片","icon":"🤖","color":"#4338ca","group":"科技"},{"key":"c_018","name":"英伟达概念","icon":"🤖","color":"#6366f1","group":"科技"},{"key":"c_019","name":"鸿蒙","icon":"🤖","color":"#3730a3","group":"科技"},{"key":"c_020","name":"机器人","icon":"🤖","color":"#7c3aed","group":"科技"},{"key":"c_021","name":"人形机器人","icon":"🤖","color":"#4f46e5","group":"科技"},{"key":"c_022","name":"机器视觉","icon":"🤖","color":"#4338ca","group":"科技"},{"key":"c_023","name":"减速器","icon":"🤖","color":"#6366f1","group":"科技"},{"key":"c_024","name":"工业母机","icon":"🤖","color":"#3730a3","group":"科技"},{"key":"c_025","name":"传感器","icon":"🤖","color":"#7c3aed","group":"科技"},{"key":"c_026","name":"物联网","icon":"🤖","color":"#4f46e5","group":"科技"},{"key":"c_027","name":"智能驾驶","icon":"🤖","color":"#4338ca","group":"科技"},{"key":"c_028","name":"智能座舱","icon":"🤖","color":"#6366f1","group":"科技"},{"key":"c_029","name":"车联网","icon":"🤖","color":"#3730a3","group":"科技"},{"key":"c_030","name":"卫星导航","icon":"🤖","color":"#7c3aed","group":"科技"},{"key":"c_031","name":"时空大数据","icon":"🤖","color":"#4f46e5","group":"科技"},{"key":"c_032","name":"区块链","icon":"🤖","color":"#4338ca","group":"科技"},{"key":"c_033","name":"数字货币","icon":"🤖","color":"#6366f1","group":"科技"},{"key":"c_034","name":"Web3","icon":"🤖","color":"#3730a3","group":"科技"},{"key":"c_035","name":"元宇宙","icon":"🤖","color":"#7c3aed","group":"科技"},{"key":"c_036","name":"XR设备","icon":"🤖","color":"#4f46e5","group":"科技"},{"key":"c_037","name":"消费电子","icon":"🤖","color":"#4338ca","group":"科技"},{"key":"c_038","name":"折叠屏","icon":"🤖","color":"#6366f1","group":"科技"},{"key":"c_039","name":"苹果概念","icon":"🤖","color":"#3730a3","group":"科技"},{"key":"c_040","name":"华为概念","icon":"🤖","color":"#7c3aed","group":"科技"},{"key":"c_041","name":"小米概念","icon":"🤖","color":"#4f46e5","group":"科技"},{"key":"c_042","name":"无线充电","icon":"🤖","color":"#4338ca","group":"科技"},{"key":"c_043","name":"OLED","icon":"🤖","color":"#6366f1","group":"科技"},{"key":"c_044","name":"MiniLED","icon":"🤖","color":"#3730a3","group":"科技"},{"key":"c_045","name":"电子纸","icon":"🤖","color":"#7c3aed","group":"科技"},{"key":"c_046","name":"边缘计算","icon":"🤖","color":"#4f46e5","group":"科技"},{"key":"c_047","name":"数字孪生","icon":"🤖","color":"#4338ca","group":"科技"},{"key":"c_048","name":"多模态AI","icon":"🤖","color":"#6366f1","group":"科技"},{"key":"c_049","name":"锂电池","icon":"🔋","color":"#047857","group":"新能源"},{"key":"c_050","name":"固态电池","icon":"🔋","color":"#0d9488","group":"新能源"},{"key":"c_051","name":"钠离子电池","icon":"🔋","color":"#16a34a","group":"新能源"},{"key":"c_052","name":"电池回收","icon":"🔋","color":"#15803d","group":"新能源"},{"key":"c_053","name":"储能","icon":"🔋","color":"#059669","group":"新能源"},{"key":"c_054","name":"抽水蓄能","icon":"🔋","color":"#047857","group":"新能源"},{"key":"c_055","name":"钒电池","icon":"🔋","color":"#0d9488","group":"新能源"},{"key":"c_056","name":"光伏","icon":"🔋","color":"#16a34a","group":"新能源"},{"key":"c_057","name":"光伏设备","icon":"🔋","color":"#15803d","group":"新能源"},{"key":"c_058","name":"风电","icon":"🔋","color":"#059669","group":"新能源"},{"key":"c_059","name":"核电","icon":"🔋","color":"#047857","group":"新能源"},{"key":"c_060","name":"氢能","icon":"🔋","color":"#0d9488","group":"新能源"},{"key":"c_061","name":"充电桩","icon":"🔋","color":"#16a34a","group":"新能源"},{"key":"c_062","name":"特高压","icon":"🔋","color":"#15803d","group":"新能源"},{"key":"c_063","name":"智能电网","icon":"🔋","color":"#059669","group":"新能源"},{"key":"c_064","name":"绿电","icon":"🔋","color":"#047857","group":"新能源"},{"key":"c_065","name":"虚拟电厂","icon":"🔋","color":"#0d9488","group":"新能源"},{"key":"c_066","name":"电网设备","icon":"🔋","color":"#16a34a","group":"新能源"},{"key":"c_067","name":"综合能源","icon":"🔋","color":"#15803d","group":"新能源"},{"key":"c_068","name":"碳中和","icon":"🔋","color":"#059669","group":"新能源"},{"key":"c_069","name":"天然气","icon":"🔋","color":"#047857","group":"新能源"},{"key":"c_070","name":"新能源车","icon":"🚗","color":"#075985","group":"汽车"},{"key":"c_071","name":"汽车整车","icon":"🚗","color":"#0891b2","group":"汽车"},{"key":"c_072","name":"汽车零部件","icon":"🚗","color":"#0e7490","group":"汽车"},{"key":"c_073","name":"汽车芯片","icon":"🚗","color":"#0284c7","group":"汽车"},{"key":"c_074","name":"一体化压铸","icon":"🚗","color":"#0369a1","group":"汽车"},{"key":"c_075","name":"汽车热管理","icon":"🚗","color":"#075985","group":"汽车"},{"key":"c_076","name":"轮胎","icon":"🚗","color":"#0891b2","group":"汽车"},{"key":"c_077","name":"商用车","icon":"🚗","color":"#0e7490","group":"汽车"},{"key":"c_078","name":"两轮车","icon":"🚗","color":"#0284c7","group":"汽车"},{"key":"c_079","name":"创新药","icon":"💊","color":"#9d174d","group":"医药"},{"key":"c_080","name":"生物医药","icon":"💊","color":"#c026d3","group":"医药"},{"key":"c_081","name":"化学制药","icon":"💊","color":"#be185d","group":"医药"},{"key":"c_082","name":"中药","icon":"💊","color":"#db2777","group":"医药"},{"key":"c_083","name":"医疗服务","icon":"💊","color":"#e11d48","group":"医药"},{"key":"c_084","name":"医疗器械","icon":"💊","color":"#9d174d","group":"医药"},{"key":"c_085","name":"CXO","icon":"💊","color":"#c026d3","group":"医药"},{"key":"c_086","name":"疫苗","icon":"💊","color":"#be185d","group":"医药"},{"key":"c_087","name":"ADC药物","icon":"💊","color":"#db2777","group":"医药"},{"key":"c_088","name":"GLP1","icon":"💊","color":"#e11d48","group":"医药"},{"key":"c_089","name":"血制品","icon":"💊","color":"#9d174d","group":"医药"},{"key":"c_090","name":"体外诊断","icon":"💊","color":"#c026d3","group":"医药"},{"key":"c_091","name":"医疗信息化","icon":"💊","color":"#be185d","group":"医药"},{"key":"c_092","name":"医美","icon":"💊","color":"#db2777","group":"医药"},{"key":"c_093","name":"药店","icon":"💊","color":"#e11d48","group":"医药"},{"key":"c_094","name":"基因检测","icon":"💊","color":"#9d174d","group":"医药"},{"key":"c_095","name":"细胞治疗","icon":"💊","color":"#c026d3","group":"医药"},{"key":"c_096","name":"原料药","icon":"💊","color":"#be185d","group":"医药"},{"key":"c_097","name":"军工","icon":"🛡️","color":"#475569","group":"军工"},{"key":"c_098","name":"航空装备","icon":"🛡️","color":"#1e293b","group":"军工"},{"key":"c_099","name":"航天装备","icon":"🛡️","color":"#0f172a","group":"军工"},{"key":"c_100","name":"导弹","icon":"🛡️","color":"#3f3f46","group":"军工"},{"key":"c_101","name":"军工电子","icon":"🛡️","color":"#334155","group":"军工"},{"key":"c_102","name":"船舶制造","icon":"🛡️","color":"#475569","group":"军工"},{"key":"c_103","name":"商业航天","icon":"🛡️","color":"#1e293b","group":"军工"},{"key":"c_104","name":"低空经济","icon":"🛡️","color":"#0f172a","group":"军工"},{"key":"c_105","name":"卫星互联网","icon":"🛡️","color":"#3f3f46","group":"军工"},{"key":"c_106","name":"军民融合","icon":"🛡️","color":"#334155","group":"军工"},{"key":"c_107","name":"核军工","icon":"🛡️","color":"#475569","group":"军工"},{"key":"c_108","name":"白酒","icon":"🛒","color":"#d97706","group":"消费"},{"key":"c_109","name":"啤酒","icon":"🛒","color":"#b45309","group":"消费"},{"key":"c_110","name":"乳制品","icon":"🛒","color":"#dc2626","group":"消费"},{"key":"c_111","name":"调味品","icon":"🛒","color":"#c2410c","group":"消费"},{"key":"c_112","name":"休闲食品","icon":"🛒","color":"#ea580c","group":"消费"},{"key":"c_113","name":"软饮料","icon":"🛒","color":"#d97706","group":"消费"},{"key":"c_114","name":"预制菜","icon":"🛒","color":"#b45309","group":"消费"},{"key":"c_115","name":"食品加工","icon":"🛒","color":"#dc2626","group":"消费"},{"key":"c_116","name":"餐饮","icon":"🛒","color":"#c2410c","group":"消费"},{"key":"c_117","name":"免税","icon":"🛒","color":"#ea580c","group":"消费"},{"key":"c_118","name":"化妆品","icon":"🛒","color":"#d97706","group":"消费"},{"key":"c_119","name":"服装家纺","icon":"🛒","color":"#b45309","group":"消费"},{"key":"c_120","name":"家居","icon":"🛒","color":"#dc2626","group":"消费"},{"key":"c_121","name":"新零售","icon":"🛒","color":"#c2410c","group":"消费"},{"key":"c_122","name":"跨境电商","icon":"🛒","color":"#ea580c","group":"消费"},{"key":"c_123","name":"电商","icon":"🛒","color":"#d97706","group":"消费"},{"key":"c_124","name":"旅游","icon":"🛒","color":"#b45309","group":"消费"},{"key":"c_125","name":"酒店","icon":"🛒","color":"#dc2626","group":"消费"},{"key":"c_126","name":"珠宝","icon":"🛒","color":"#c2410c","group":"消费"},{"key":"c_127","name":"培育钻石","icon":"🛒","color":"#ea580c","group":"消费"},{"key":"c_128","name":"农业种植","icon":"🌾","color":"#3f6212","group":"农业"},{"key":"c_129","name":"粮食安全","icon":"🌾","color":"#ca8a04","group":"农业"},{"key":"c_130","name":"种业","icon":"🌾","color":"#a16207","group":"农业"},{"key":"c_131","name":"生猪养殖","icon":"🌾","color":"#4d7c0f","group":"农业"},{"key":"c_132","name":"禽养殖","icon":"🌾","color":"#65a30d","group":"农业"},{"key":"c_133","name":"饲料","icon":"🌾","color":"#3f6212","group":"农业"},{"key":"c_134","name":"农药","icon":"🌾","color":"#ca8a04","group":"农业"},{"key":"c_135","name":"化肥","icon":"🌾","color":"#a16207","group":"农业"},{"key":"c_136","name":"农产品加工","icon":"🌾","color":"#4d7c0f","group":"农业"},{"key":"c_137","name":"基础化工","icon":"🧪","color":"#854d0e","group":"资源"},{"key":"c_138","name":"磷化工","icon":"🧪","color":"#713f12","group":"资源"},{"key":"c_139","name":"氟化工","icon":"🧪","color":"#57534e","group":"资源"},{"key":"c_140","name":"钛白粉","icon":"🧪","color":"#78350f","group":"资源"},{"key":"c_141","name":"纯碱","icon":"🧪","color":"#3f6212","group":"资源"},{"key":"c_142","name":"氯碱","icon":"🧪","color":"#854d0e","group":"资源"},{"key":"c_143","name":"有机硅","icon":"🧪","color":"#713f12","group":"资源"},{"key":"c_144","name":"聚氨酯","icon":"🧪","color":"#57534e","group":"资源"},{"key":"c_145","name":"碳纤维","icon":"🧪","color":"#78350f","group":"资源"},{"key":"c_146","name":"民爆","icon":"🧪","color":"#3f6212","group":"资源"},{"key":"c_147","name":"可降解塑料","icon":"🧪","color":"#854d0e","group":"资源"},{"key":"c_148","name":"橡胶","icon":"🧪","color":"#713f12","group":"资源"},{"key":"c_149","name":"塑料制品","icon":"🧪","color":"#57534e","group":"资源"},{"key":"c_150","name":"玻璃玻纤","icon":"🧪","color":"#78350f","group":"资源"},{"key":"c_151","name":"水泥","icon":"🧪","color":"#3f6212","group":"资源"},{"key":"c_152","name":"钢铁","icon":"🧪","color":"#854d0e","group":"资源"},{"key":"c_153","name":"小金属","icon":"🧪","color":"#713f12","group":"资源"},{"key":"c_154","name":"稀土永磁","icon":"🧪","color":"#57534e","group":"资源"},{"key":"c_155","name":"有色金属","icon":"🧪","color":"#78350f","group":"资源"},{"key":"c_156","name":"工业金属","icon":"🧪","color":"#3f6212","group":"资源"},{"key":"c_157","name":"贵金属","icon":"🧪","color":"#854d0e","group":"资源"},{"key":"c_158","name":"锂","icon":"🧪","color":"#713f12","group":"资源"},{"key":"c_159","name":"钴镍","icon":"🧪","color":"#57534e","group":"资源"},{"key":"c_160","name":"钨钼","icon":"🧪","color":"#78350f","group":"资源"},{"key":"c_161","name":"石墨电极","icon":"🧪","color":"#3f6212","group":"资源"},{"key":"c_162","name":"非金属材料","icon":"🧪","color":"#854d0e","group":"资源"},{"key":"c_163","name":"化纤","icon":"🧪","color":"#713f12","group":"资源"},{"key":"c_164","name":"银行","icon":"🏦","color":"#b45309","group":"金融"},{"key":"c_165","name":"券商","icon":"🏦","color":"#9a3412","group":"金融"},{"key":"c_166","name":"保险","icon":"🏦","color":"#b91c1c","group":"金融"},{"key":"c_167","name":"多元金融","icon":"🏦","color":"#991b1b","group":"金融"},{"key":"c_168","name":"房地产","icon":"🏦","color":"#7f1d1d","group":"金融"},{"key":"c_169","name":"物业管理","icon":"🏦","color":"#b45309","group":"金融"},{"key":"c_170","name":"基建","icon":"🏦","color":"#9a3412","group":"金融"},{"key":"c_171","name":"建筑装饰","icon":"🏦","color":"#b91c1c","group":"金融"},{"key":"c_172","name":"装配式建筑","icon":"🏦","color":"#991b1b","group":"金融"},{"key":"c_173","name":"游戏","icon":"🎬","color":"#7e22ce","group":"传媒"},{"key":"c_174","name":"影视","icon":"🎬","color":"#9333ea","group":"传媒"},{"key":"c_175","name":"出版","icon":"🎬","color":"#6d28d9","group":"传媒"},{"key":"c_176","name":"广告营销","icon":"🎬","color":"#a21caf","group":"传媒"},{"key":"c_177","name":"数字媒体","icon":"🎬","color":"#86198f","group":"传媒"},{"key":"c_178","name":"教育","icon":"🎬","color":"#7e22ce","group":"传媒"},{"key":"c_179","name":"体育","icon":"🎬","color":"#9333ea","group":"传媒"},{"key":"c_180","name":"广电","icon":"🎬","color":"#6d28d9","group":"传媒"},{"key":"c_181","name":"环保","icon":"♻️","color":"#15803d","group":"环保"},{"key":"c_182","name":"水务","icon":"♻️","color":"#0f766e","group":"环保"},{"key":"c_183","name":"垃圾焚烧","icon":"♻️","color":"#047857","group":"环保"},{"key":"c_184","name":"大气治理","icon":"♻️","color":"#1d4ed8","group":"环保"},{"key":"c_185","name":"节能","icon":"♻️","color":"#0e7490","group":"环保"},{"key":"c_186","name":"再生资源","icon":"♻️","color":"#15803d","group":"环保"},{"key":"c_187","name":"环卫装备","icon":"♻️","color":"#0f766e","group":"环保"},{"key":"c_188","name":"工程机械","icon":"⚙️","color":"#44403c","group":"机械"},{"key":"c_189","name":"轨交设备","icon":"⚙️","color":"#57534e","group":"机械"},{"key":"c_190","name":"电梯","icon":"⚙️","color":"#6b7280","group":"机械"},{"key":"c_191","name":"专精特新","icon":"⚙️","color":"#52525b","group":"机械"},{"key":"c_192","name":"通用设备","icon":"⚙️","color":"#3f3f46","group":"机械"},{"key":"c_193","name":"专用设备","icon":"⚙️","color":"#44403c","group":"机械"},{"key":"c_194","name":"仪器仪表","icon":"⚙️","color":"#57534e","group":"机械"},{"key":"c_195","name":"自动化设备","icon":"⚙️","color":"#6b7280","group":"机械"},{"key":"c_196","name":"5G","icon":"📡","color":"#0891b2","group":"通信"},{"key":"c_197","name":"6G","icon":"📡","color":"#0d9488","group":"通信"},{"key":"c_198","name":"通信设备","icon":"📡","color":"#0284c7","group":"通信"},{"key":"c_199","name":"光通信","icon":"📡","color":"#0e7490","group":"通信"},{"key":"c_200","name":"运营商","icon":"📡","color":"#7c3aed","group":"通信"},{"key":"c_201","name":"卫星通信","icon":"📡","color":"#0891b2","group":"通信"},{"key":"c_202","name":"国企改革","icon":"🧭","color":"#4338ca","group":"主题"},{"key":"c_203","name":"中字头","icon":"🧭","color":"#6d28d9","group":"主题"},{"key":"c_204","name":"一带一路","icon":"🧭","color":"#7c3aed","group":"主题"},{"key":"c_205","name":"乡村振兴","icon":"🧭","color":"#0f766e","group":"主题"},{"key":"c_206","name":"统一大市场","icon":"🧭","color":"#1d4ed8","group":"主题"},{"key":"c_207","name":"雄安新区","icon":"🧭","color":"#4338ca","group":"主题"},{"key":"c_208","name":"成渝经济","icon":"🧭","color":"#6d28d9","group":"主题"},{"key":"c_209","name":"长三角","icon":"🧭","color":"#7c3aed","group":"主题"},{"key":"c_210","name":"自贸港","icon":"🧭","color":"#0f766e","group":"主题"},{"key":"c_211","name":"北交所","icon":"🧭","color":"#1d4ed8","group":"主题"},{"key":"c_212","name":"科创板","icon":"🧭","color":"#4338ca","group":"主题"},{"key":"c_213","name":"注册制","icon":"🧭","color":"#6d28d9","group":"主题"},{"key":"c_214","name":"高股息","icon":"🧭","color":"#7c3aed","group":"主题"},{"key":"c_215","name":"破净","icon":"🧭","color":"#0f766e","group":"主题"},{"key":"c_216","name":"回购增持","icon":"🧭","color":"#1d4ed8","group":"主题"},{"key":"c_217","name":"并购重组","icon":"🧭","color":"#4338ca","group":"主题"},{"key":"c_218","name":"新型工业化","icon":"🧭","color":"#6d28d9","group":"主题"},{"key":"c_219","name":"工业互联网","icon":"🧭","color":"#7c3aed","group":"主题"},{"key":"c_220","name":"数据确权","icon":"🧭","color":"#0f766e","group":"主题"},{"key":"c_221","name":"智慧城市","icon":"🧭","color":"#1d4ed8","group":"主题"}];
  const BRIEF_CONCEPT_KEYWORDS = {"c_001":["人工智能","AI","AIGC","大模型","生成式AI","智能体","多模态","机器学习"],"c_002":["算力","智算","算力租赁","算力中心","AI芯片","训练芯片","智能算力"],"c_003":["云计算","云算力","云服务","公有云","私有云","混合云","云原生"],"c_004":["数据中心","IDC","机房","算力基础设施","液冷数据中心","智算中心"],"c_005":["东数西算","算力网络","西部算力","枢纽节点","算力枢纽"],"c_006":["信创","国产软件","国产替代","自主可控","党政信创","行业信创"],"c_007":["网络安全","数据安全","信息安全","防火墙","态势感知","勒索病毒","护网"],"c_008":["数据要素","数据资产","数据确权","数据交易","公共数据","数据入表","数据资源"],"c_009":["数字经济","数字化转型","产业数字化","数字中国","数字政府","数字化"],"c_010":["量子","量子计算","量子通信","量子保密","量子科技","量子芯片"],"c_011":["半导体","芯片","集成电路","晶圆","封测","IC设计","半导体产业"],"c_012":["半导体设备","光刻机","刻蚀机","薄膜沉积","晶圆厂设备","国产设备","涂胶显影"],"c_013":["半导体材料","光刻胶","电子特气","硅片","CMP抛光","靶材","湿电子化学品"],"c_014":["第三代半导体","碳化硅","氮化镓","SiC","GaN","宽禁带","功率半导体"],"c_015":["先进封装","Chiplet","CoWoS","2.5D封装","3D封装","扇出封装","封装测试"],"c_016":["存储芯片","DRAM","NAND","HBM","内存","闪存","长鑫","长存"],"c_017":["国产芯片","寒武纪","海光","龙芯","兆易创新","韦尔","国产GPU"],"c_018":["英伟达","NVIDIA","NVLink","Blackwell","算力供应","GPU供应"],"c_019":["鸿蒙","HarmonyOS","OpenHarmony","鸿蒙生态","鸿蒙智行"],"c_020":["机器人","工业机器人","服务机器人","具身智能","机械臂","协作机器人"],"c_021":["人形机器人","特斯拉机器人","Optimus","宇树","优必选","通用人形","仿生机器人"],"c_022":["机器视觉","工业视觉","视觉检测","3D视觉","智能视觉"],"c_023":["减速器","谐波减速器","RV减速器","伺服","行星减速器","精密减速器"],"c_024":["工业母机","数控机床","五轴联动","高端机床","数控系统","机床"],"c_025":["传感器","MEMS","压力传感器","图像传感器","激光雷达","敏感元件"],"c_026":["物联网","IoT","传感网","工业互联网","设备联网","泛在物联"],"c_027":["智能驾驶","自动驾驶","L3","L4","智驾","NOA","城市领航","辅助驾驶"],"c_028":["智能座舱","座舱","车机","HUD","车载屏","座舱域控"],"c_029":["车联网","V2X","车路云","车路协同","路侧","智能网联"],"c_030":["卫星导航","北斗","GPS","高精度定位","授时","星基增强","北斗导航"],"c_031":["时空大数据","地理信息","遥感数据","数字孪生城市","CIM","实景三维"],"c_032":["区块链","分布式账本","联盟链","智能合约","联盟链"],"c_033":["数字货币","数字人民币","CBDC","央行数字货币","e-CNY","数字法币"],"c_034":["Web3","去中心化","DApp","去中心化应用","链上"],"c_035":["元宇宙","虚拟现实","数字人","虚拟世界","数字孪生","虚实融合"],"c_036":["VR","AR","MR","XR","虚拟现实","增强现实","智能眼镜","AI眼镜"],"c_037":["消费电子","手机","PC","平板","可穿戴","TWS","智能硬件","消费电子回暖"],"c_038":["折叠屏","柔性屏","UTG","铰链","折叠手机","柔性显示"],"c_039":["苹果","iPhone","Apple","果链","供应链","苹果产业链"],"c_040":["华为","华为产业链","华为汽车","华为昇腾","华为盘古","华为云"],"c_041":["小米","小米汽车","雷军","米链","小米产业链"],"c_042":["无线充电","磁吸","Qi","隔空充电","无线供电"],"c_043":["OLED","AMOLED","柔性显示","有机发光","OLED面板"],"c_044":["MiniLED","MicroLED","直显","背光","Mini LED"],"c_045":["电子纸","电子墨水","E Ink","电子标签"],"c_046":["边缘计算","边缘节点","MEC","端侧算力","端侧AI","边缘AI"],"c_047":["数字孪生","仿真","虚拟映射","工业仿真","孪生"],"c_048":["多模态","文生视频","文生图","Sora","语音大模型","视觉大模型","多模态大模型"],"c_049":["锂电池","锂离子","动力电池","电芯","电池包","动力电芯"],"c_050":["固态电池","半固态","硫化物","固态电解质","凝聚态"],"c_051":["钠离子","钠电池","钠电","钠离"],"c_052":["电池回收","梯次利用","废旧电池","动力电池回收","回收再生"],"c_053":["储能","储能系统","工商业储能","大储","储能电站","储能项目"],"c_054":["抽水蓄能","抽蓄","水储能","抽水"],"c_055":["钒电池","液流电池","全钒","钒液流"],"c_056":["光伏","组件","硅片","硅料","电池片","逆变器","光伏装机"],"c_057":["光伏设备","拉晶","切片","PECVD","光伏制造","光伏产线"],"c_058":["风电","风机","风电场","海上风电","陆上风电","塔筒","风电装机"],"c_059":["核电","核电站","核电机组","华龙一号","四代核电","核电审批"],"c_060":["氢能","氢燃料","氢能源","燃料电池","绿氢","制氢","储氢","氢储"],"c_061":["充电桩","充电站","换电","超充","快充","充电基础设施"],"c_062":["特高压","直流输电","换流站","输电通道","特高压建设"],"c_063":["智能电网","电网自动化","调度","虚拟电厂","微电网","电网升级"],"c_064":["绿电","绿色电力","绿证","可再生能源","清洁电力","绿电交易"],"c_065":["虚拟电厂","需求响应","聚合商","负荷管理","电力调度"],"c_066":["电网设备","变压器","开关柜","电缆","输电设备","电力设备"],"c_067":["综合能源","能源管理","节能","能源互联网","多能互补"],"c_068":["碳中和","碳达峰","碳交易","CCER","碳市场","碳减排","碳配额"],"c_069":["天然气","LNG","管道气","燃气","页岩气","液化天然气"],"c_070":["新能源车","电动汽车","新能源汽车","电动车","乘用车电动化"],"c_071":["整车","车企","汽车销量","乘用车","商用车","重卡","汽车产销"],"c_072":["零部件","轮胎","内外饰","冲压","汽车电子","汽车配件"],"c_073":["汽车芯片","车规级","IGBT","SiC模组","MCU车规","功率器件"],"c_074":["一体化压铸","压铸","免热处理","车身一体化","压铸件"],"c_075":["热管理","热泵","电子膨胀阀","液冷板","汽车热管理"],"c_076":["轮胎","半钢胎","全钢胎","玲珑","赛轮","轮胎涨价"],"c_077":["商用车","客车","货车","重卡","轻卡","皮卡"],"c_078":["摩托车","电动两轮","雅迪","爱玛","电动自行车","燃油摩托"],"c_079":["创新药","新药","原研药","me-better","FIC","在研管线","创新药企"],"c_080":["生物医药","生物药","重组蛋白","抗体","双抗","生物制品"],"c_081":["化学制药","仿制药","原料药","制剂","一致性评价","化药"],"c_082":["中药","中成药","配方颗粒","中药材","老字号","中药创新"],"c_083":["医疗服务","民营医院","眼科","牙科","体检","IVD","专科医疗"],"c_084":["医疗器械","医疗设备","高值耗材","影像","手术机器人","医用设备"],"c_085":["CXO","CRO","CDMO","CMO","医药研发外包","临床前","外包研发"],"c_086":["疫苗","mRNA","灭活","重组","接种","流感苗","肺炎疫苗"],"c_087":["ADC","抗体偶联","偶联药物","ADC药物"],"c_088":["GLP-1","减肥药","司美格鲁肽","替尔泊肽","减重","GLP"],"c_089":["血制品","白蛋白","静丙","血液制品","血浆"],"c_090":["体外诊断","IVD","POCT","分子诊断","生化诊断","诊断试剂"],"c_091":["医疗信息化","智慧医院","HIS","医保信息化","DRG","医疗IT"],"c_092":["医美","玻尿酸","胶原蛋白","肉毒素","光电医美","注射美容"],"c_093":["药店","连锁药房","处方外流","零售药店","药房"],"c_094":["基因检测","测序","NGS","伴随诊断","早筛","基因测序"],"c_095":["细胞治疗","CAR-T","干细胞","免疫细胞","细胞免疫"],"c_096":["原料药","API","特色原料药","CDMO原料","医药中间体"],"c_097":["军工","国防","军品","装备","强军","军民","军工板块"],"c_098":["航空装备","战机","直升机","运输机","发动机","军机"],"c_099":["航天装备","火箭","卫星","飞船","探月","航天"],"c_100":["导弹","火箭弹","制导","巡飞弹","导弹武器"],"c_101":["军工电子","雷达","红外","电子对抗","军工芯片","军工信息化"],"c_102":["船舶","军舰","航母","驱逐舰","民船","造船","船厂"],"c_103":["商业航天","民营火箭","星河动力","星链","低轨卫星","卫星公司"],"c_104":["低空经济","eVTOL","飞行汽车","无人机物流","通航","起降点","低空"],"c_105":["卫星互联网","星网","低轨星座","宽带卫星","卫星通信"],"c_106":["军民融合","军转民","民参军","军工混改"],"c_107":["核工业","核燃料","核动力","核技术应用"],"c_108":["白酒","茅台","五粮液","次高端","批价","动销","名酒"],"c_109":["啤酒","青啤","华润","燕京","高端化","啤酒涨价"],"c_110":["乳制品","奶粉","液态奶","伊利","蒙牛","原奶","鲜奶"],"c_111":["调味品","酱油","醋","榨菜","复合调味","海天","调味"],"c_112":["休闲食品","零食","坚果","饼干","辣条","休闲零"],"c_113":["软饮料","饮料","功能饮料","饮用水","东鹏","饮品"],"c_114":["预制菜","料理包","半成品","中央厨房","预制"],"c_115":["食品加工","肉制品","速冻","烘焙","食品制造","食品加"],"c_116":["餐饮","连锁餐饮","火锅","茶饮","咖啡","餐饮连锁"],"c_117":["免税","离岛免税","中免","免税店","口岸免税","免税品"],"c_118":["化妆品","护肤","美妆","彩妆","珀莱雅","美妆"],"c_119":["服装","家纺","纺织","品牌服饰","运动服饰","服饰"],"c_120":["家居","家具","定制家居","软体","建材家居","家居用品"],"c_121":["新零售","智慧零售","即时零售","O2O","会员店","零售创新"],"c_122":["跨境电商","出海","独立站","亚马逊","SHEIN","跨境"],"c_123":["电商","直播电商","内容电商","平台经济","电商平"],"c_124":["旅游","景区","旅行社","出境游","周边游","旅游复苏"],"c_125":["酒店","连锁酒店","RevPAR","入住率","酒店经营"],"c_126":["黄金珠宝","钻戒","饰品","老凤祥","周大福","珠宝"],"c_127":["培育钻石","人造钻石","钻石","培育钻"],"c_128":["农业种植","粮食","主粮","经济作物","土地承包","种植"],"c_129":["粮食安全","谷物","口粮","大豆","玉米","小麦","稻谷","粮食安"],"c_130":["种业","种子","转基因","杂交","玉米种","水稻种","种企"],"c_131":["生猪","猪肉","养殖","猪价","能繁","牧原","猪周期"],"c_132":["禽","鸡","白羽鸡","黄羽鸡","鸡苗","禽链","肉鸡"],"c_133":["饲料","猪料","水产料","豆粕","粮价","饲料涨价"],"c_134":["农药","杀虫剂","除草剂","杀菌剂","草甘膦","农药制剂","农化"],"c_135":["化肥","钾肥","磷肥","氮肥","复合肥","尿素","肥料"],"c_136":["农产品加工","粮油","制糖","屠宰","棉花","粮油加工"],"c_137":["基础化工","化工","化学原料","化工品","化工园区","化工行"],"c_138":["磷化工","磷酸","磷矿石","磷酸一铵","磷肥","黄磷"],"c_139":["氟化工","萤石","氢氟酸","制冷剂","R32","PVDF","含氟"],"c_140":["钛白粉","钛矿","氯化法","硫酸法","钛白"],"c_141":["纯碱","碱业","轻碱","重碱","纯碱价格"],"c_142":["氯碱","烧碱","PVC","电石","氯碱化"],"c_143":["有机硅","硅油","硅橡胶","单体","有机硅DMC"],"c_144":["聚氨酯","MDI","TDI","万华","聚醚"],"c_145":["碳纤维","碳梁","原丝","复材","碳纤维复"],"c_146":["民爆","炸药","电子雷管","爆破","民爆器材"],"c_147":["可降解","PBAT","PLA","生物降解","降解塑料"],"c_148":["橡胶","轮胎橡胶","合成橡胶","天然橡胶","橡塑"],"c_149":["塑料","改性塑料","塑料包装","工程塑料","塑料制"],"c_150":["玻璃","玻纤","光伏玻璃","电子玻璃","风电纱","玻璃纤"],"c_151":["水泥","熟料","水泥价格","错峰","水泥熟"],"c_152":["钢铁","钢材","螺纹钢","特钢","钢厂","钢价"],"c_153":["小金属","钨","钼","锑","钒","钛","镁","锆","稀散金属"],"c_154":["稀土","永磁","钕铁硼","磁材","镨钕","稀土永磁","稀土价格"],"c_155":["有色","金属","工业金属","基本金属","有色板块"],"c_156":["铜","铝","电解铝","锌","铅","镍","锡","工业金属"],"c_157":["黄金","白银","贵金属","金价","避险","金银"],"c_158":["锂","碳酸锂","锂矿","锂盐","盐湖","锂辉石","锂价"],"c_159":["钴","镍","三元","前驱体","钴盐","镍盐"],"c_160":["钨","钼","硬质合金","钼精矿","钨钼"],"c_161":["石墨","负极","石墨电极","人造石墨","针状焦","石墨材"],"c_162":["非金属材料","石英","坩埚","高纯石英","陶瓷材料","非金属"],"c_163":["化纤","涤纶","氨纶","粘胶","锦纶","聚酯","化学纤维"],"c_164":["银行","信贷","存款","净息差","不良","国有大行","股份行","银行板块"],"c_165":["券商","证券","投行","经纪","两融","财富管理","券商板"],"c_166":["保险","保费","新单","寿险","财险","NBV","保险股"],"c_167":["多元金融","信托","期货","租赁","AMC","金控","金租"],"c_168":["房地产","楼市","房企","房价","保交楼","土拍","地产"],"c_169":["物业","物管","社区","增值服务","物业服务"],"c_170":["基建","专项债","重大项目","铁公基","水利","基建投资"],"c_171":["建筑","施工","装饰","园林","幕墙","建筑装饰"],"c_172":["装配式","PC构件","钢结构","装配建筑","装配式建筑"],"c_173":["游戏","版号","手游","端游","电竞","出海游戏","游戏版"],"c_174":["影视","电影","票房","剧集","院线","综艺","影视院"],"c_175":["出版","教材","教辅","少儿","数字出版","出版传"],"c_176":["广告","营销","梯媒","品牌","投放","广告营"],"c_177":["数字媒体","短视频","长视频","直播","IP","内容"],"c_178":["教育","培训","职业教育","K12","课后","公考","教育股"],"c_179":["体育","赛事","健身","运动","冬奥","体育产"],"c_180":["广电","有线电视","IPTV","融媒体","广播电视"],"c_181":["环保","污染治理","污水处理","固废","环卫","节能环保"],"c_182":["水务","供水","自来水","排水","水利","水治理"],"c_183":["垃圾","焚烧","生物质","危废","垃圾发"],"c_184":["大气","烟气","脱硫","脱硝","除尘","大气治"],"c_185":["节能","合同能源","能效","余热","节能服"],"c_186":["再生资源","废钢","废塑料","废纸","回收","资源回收"],"c_187":["环卫","清洁","新能源环卫","环卫装"],"c_188":["工程机械","挖掘机","装载机","起重机","液压","工程机械"],"c_189":["轨交","高铁","地铁","城轨","机车","轨道交通"],"c_190":["电梯","扶梯","加装","电梯更"],"c_191":["专精特新","小巨人","单项冠军","隐形冠军","专新特"],"c_192":["通用设备","泵阀","压缩机","轴承","密封","通用设"],"c_193":["专用设备","自动化产线","检测设备","专机","专用设"],"c_194":["仪器","仪表","科学仪器","计量","仪器仪"],"c_195":["自动化","工控","PLC","运动控制","自动化设"],"c_196":["5G","基站","Massive MIMO","小基站","5G建设"],"c_197":["6G","太赫兹","卫星通信","6G技术"],"c_198":["通信设备","光模块","交换机","路由器","天线","通信设"],"c_199":["光通信","光模块","CPO","硅光","光器件","光通"],"c_200":["运营商","中国移动","中国电信","中国联通","广电","运营商"],"c_201":["卫星通信","卫星电话","天通","海事卫星","卫星通"],"c_202":["国企改革","央企改革","混改","资产证券化","国企改"],"c_203":["中字头","央企","国家队","核心资产","中字"],"c_204":["一带一路","出海","基建出海","中亚","东南亚","带一路"],"c_205":["乡村振兴","三农","惠农","县域","乡村振"],"c_206":["统一大市场","内循环","流通","供应链","大市场"],"c_207":["雄安","新区","京津冀","雄安新"],"c_208":["成渝","西部","双城","成渝经"],"c_209":["长三角","一体化","示范区","长三"],"c_210":["自贸港","自贸区","海南","关税","自贸"],"c_211":["北交所","新三板","精选层","小市值","北交"],"c_212":["科创板","硬科技","未盈利","第五套标准","科创"],"c_213":["注册制","IPO","发行","注册"],"c_214":["高股息","红利","分红","现金牛","股息率","高股"],"c_215":["破净","低估值","价值股","PB修复","破净股"],"c_216":["回购","增持","股权激励","注销式回购","回购增"],"c_217":["并购","重组","借壳","资产注入","整合","并购重"],"c_218":["新型工业化","工业软件","智能制造","数控","新型工"],"c_219":["工业互联网","标识解析","平台","设备上云","工业互"],"c_220":["数据确权","数据产权","持有权","使用权","数据权"],"c_221":["智慧城市","城市大脑","智慧政务","数字政务","智慧城"]};

  /* ===== 行业归类（batch48 扩展：申万一级 31 + 二级全量 ~134） ===== */
  const BRIEF_INDUSTRY_DIMS = [{"key":"i_001","name":"农林牧渔","icon":"🌾","color":"#4d7c0f","parent":"农林牧渔","level":"L1"},{"key":"i_002","name":"基础化工","icon":"🧪","color":"#3f6212","parent":"基础化工","level":"L1"},{"key":"i_003","name":"钢铁","icon":"⚙️","color":"#57534e","parent":"钢铁","level":"L1"},{"key":"i_004","name":"有色金属","icon":"🪙","color":"#b45309","parent":"有色金属","level":"L1"},{"key":"i_005","name":"电子","icon":"🔌","color":"#0f766e","parent":"电子","level":"L1"},{"key":"i_006","name":"家用电器","icon":"🧊","color":"#0369a1","parent":"家用电器","level":"L1"},{"key":"i_007","name":"食品饮料","icon":"🍶","color":"#c2410c","parent":"食品饮料","level":"L1"},{"key":"i_008","name":"纺织服饰","icon":"👕","color":"#a21caf","parent":"纺织服饰","level":"L1"},{"key":"i_009","name":"轻工制造","icon":"📦","color":"#a16207","parent":"轻工制造","level":"L1"},{"key":"i_010","name":"医药生物","icon":"💊","color":"#be185d","parent":"医药生物","level":"L1"},{"key":"i_011","name":"公用事业","icon":"💡","color":"#0284c7","parent":"公用事业","level":"L1"},{"key":"i_012","name":"交通运输","icon":"🚢","color":"#1d4ed8","parent":"交通运输","level":"L1"},{"key":"i_013","name":"房地产","icon":"🏠","color":"#92400e","parent":"房地产","level":"L1"},{"key":"i_014","name":"商贸零售","icon":"🛒","color":"#ea580c","parent":"商贸零售","level":"L1"},{"key":"i_015","name":"社会服务","icon":"🎡","color":"#0d9488","parent":"社会服务","level":"L1"},{"key":"i_016","name":"建筑材料","icon":"🧱","color":"#78716c","parent":"建筑材料","level":"L1"},{"key":"i_017","name":"建筑装饰","icon":"🏗️","color":"#92400e","parent":"建筑装饰","level":"L1"},{"key":"i_018","name":"电力设备","icon":"🔋","color":"#16a34a","parent":"电力设备","level":"L1"},{"key":"i_019","name":"国防军工","icon":"🛡️","color":"#334155","parent":"国防军工","level":"L1"},{"key":"i_020","name":"计算机","icon":"💻","color":"#2563eb","parent":"计算机","level":"L1"},{"key":"i_021","name":"传媒","icon":"🎬","color":"#db2777","parent":"传媒","level":"L1"},{"key":"i_022","name":"通信","icon":"📡","color":"#0891b2","parent":"通信","level":"L1"},{"key":"i_023","name":"银行","icon":"🏦","color":"#1e40af","parent":"银行","level":"L1"},{"key":"i_024","name":"非银金融","icon":"📈","color":"#b91c1c","parent":"非银金融","level":"L1"},{"key":"i_025","name":"汽车","icon":"🚗","color":"#0891b2","parent":"汽车","level":"L1"},{"key":"i_026","name":"机械设备","icon":"⚙️","color":"#475569","parent":"机械设备","level":"L1"},{"key":"i_027","name":"煤炭","icon":"⛏️","color":"#44403c","parent":"煤炭","level":"L1"},{"key":"i_028","name":"石油石化","icon":"🛢️","color":"#7c2d12","parent":"石油石化","level":"L1"},{"key":"i_029","name":"环保","icon":"♻️","color":"#15803d","parent":"环保","level":"L1"},{"key":"i_030","name":"美容护理","icon":"💄","color":"#db2777","parent":"美容护理","level":"L1"},{"key":"i_031","name":"种植业","icon":"🌾","color":"#4d7c0f","parent":"农林牧渔","level":"L2"},{"key":"i_032","name":"养殖业","icon":"🌾","color":"#4d7c0f","parent":"农林牧渔","level":"L2"},{"key":"i_033","name":"林业Ⅱ","icon":"🌾","color":"#4d7c0f","parent":"农林牧渔","level":"L2"},{"key":"i_034","name":"饲料","icon":"🌾","color":"#4d7c0f","parent":"农林牧渔","level":"L2"},{"key":"i_035","name":"农产品加工","icon":"🌾","color":"#4d7c0f","parent":"农林牧渔","level":"L2"},{"key":"i_036","name":"农业综合Ⅱ","icon":"🌾","color":"#4d7c0f","parent":"农林牧渔","level":"L2"},{"key":"i_037","name":"渔业","icon":"🌾","color":"#4d7c0f","parent":"农林牧渔","level":"L2"},{"key":"i_038","name":"化学原料","icon":"🧪","color":"#3f6212","parent":"基础化工","level":"L2"},{"key":"i_039","name":"化学制品","icon":"🧪","color":"#3f6212","parent":"基础化工","level":"L2"},{"key":"i_040","name":"化学纤维","icon":"🧪","color":"#3f6212","parent":"基础化工","level":"L2"},{"key":"i_041","name":"塑料","icon":"🧪","color":"#3f6212","parent":"基础化工","level":"L2"},{"key":"i_042","name":"橡胶","icon":"🧪","color":"#3f6212","parent":"基础化工","level":"L2"},{"key":"i_043","name":"农化制品","icon":"🧪","color":"#3f6212","parent":"基础化工","level":"L2"},{"key":"i_044","name":"非金属材料Ⅱ","icon":"🧪","color":"#3f6212","parent":"基础化工","level":"L2"},{"key":"i_045","name":"普钢","icon":"⚙️","color":"#57534e","parent":"钢铁","level":"L2"},{"key":"i_046","name":"特钢Ⅱ","icon":"⚙️","color":"#57534e","parent":"钢铁","level":"L2"},{"key":"i_047","name":"冶钢原料","icon":"⚙️","color":"#57534e","parent":"钢铁","level":"L2"},{"key":"i_048","name":"工业金属","icon":"🪙","color":"#b45309","parent":"有色金属","level":"L2"},{"key":"i_049","name":"贵金属","icon":"🪙","color":"#b45309","parent":"有色金属","level":"L2"},{"key":"i_050","name":"小金属","icon":"🪙","color":"#b45309","parent":"有色金属","level":"L2"},{"key":"i_051","name":"金属新材料","icon":"🪙","color":"#b45309","parent":"有色金属","level":"L2"},{"key":"i_052","name":"能源金属","icon":"🪙","color":"#b45309","parent":"有色金属","level":"L2"},{"key":"i_053","name":"半导体","icon":"🔌","color":"#0f766e","parent":"电子","level":"L2"},{"key":"i_054","name":"消费电子","icon":"🔌","color":"#0f766e","parent":"电子","level":"L2"},{"key":"i_055","name":"元件","icon":"🔌","color":"#0f766e","parent":"电子","level":"L2"},{"key":"i_056","name":"光学光电子","icon":"🔌","color":"#0f766e","parent":"电子","level":"L2"},{"key":"i_057","name":"其他电子Ⅱ","icon":"🔌","color":"#0f766e","parent":"电子","level":"L2"},{"key":"i_058","name":"电子化学品Ⅱ","icon":"🔌","color":"#0f766e","parent":"电子","level":"L2"},{"key":"i_059","name":"白色家电","icon":"🧊","color":"#0369a1","parent":"家用电器","level":"L2"},{"key":"i_060","name":"黑色家电","icon":"🧊","color":"#0369a1","parent":"家用电器","level":"L2"},{"key":"i_061","name":"小家电","icon":"🧊","color":"#0369a1","parent":"家用电器","level":"L2"},{"key":"i_062","name":"厨卫电器","icon":"🧊","color":"#0369a1","parent":"家用电器","level":"L2"},{"key":"i_063","name":"照明设备Ⅱ","icon":"🧊","color":"#0369a1","parent":"家用电器","level":"L2"},{"key":"i_064","name":"家电零部件Ⅱ","icon":"🧊","color":"#0369a1","parent":"家用电器","level":"L2"},{"key":"i_065","name":"白酒Ⅱ","icon":"🍶","color":"#c2410c","parent":"食品饮料","level":"L2"},{"key":"i_066","name":"非白酒","icon":"🍶","color":"#c2410c","parent":"食品饮料","level":"L2"},{"key":"i_067","name":"饮料乳品","icon":"🍶","color":"#c2410c","parent":"食品饮料","level":"L2"},{"key":"i_068","name":"休闲食品","icon":"🍶","color":"#c2410c","parent":"食品饮料","level":"L2"},{"key":"i_069","name":"调味发酵品Ⅱ","icon":"🍶","color":"#c2410c","parent":"食品饮料","level":"L2"},{"key":"i_070","name":"食品加工","icon":"🍶","color":"#c2410c","parent":"食品饮料","level":"L2"},{"key":"i_071","name":"纺织制造","icon":"👕","color":"#a21caf","parent":"纺织服饰","level":"L2"},{"key":"i_072","name":"服装家纺","icon":"👕","color":"#a21caf","parent":"纺织服饰","level":"L2"},{"key":"i_073","name":"饰品","icon":"👕","color":"#a21caf","parent":"纺织服饰","level":"L2"},{"key":"i_074","name":"造纸","icon":"📦","color":"#a16207","parent":"轻工制造","level":"L2"},{"key":"i_075","name":"包装印刷","icon":"📦","color":"#a16207","parent":"轻工制造","level":"L2"},{"key":"i_076","name":"家居用品","icon":"📦","color":"#a16207","parent":"轻工制造","level":"L2"},{"key":"i_077","name":"化学制药","icon":"💊","color":"#be185d","parent":"医药生物","level":"L2"},{"key":"i_078","name":"中药Ⅱ","icon":"💊","color":"#be185d","parent":"医药生物","level":"L2"},{"key":"i_079","name":"生物制品","icon":"💊","color":"#be185d","parent":"医药生物","level":"L2"},{"key":"i_080","name":"医药商业","icon":"💊","color":"#be185d","parent":"医药生物","level":"L2"},{"key":"i_081","name":"医疗器械","icon":"💊","color":"#be185d","parent":"医药生物","level":"L2"},{"key":"i_082","name":"医疗服务","icon":"💊","color":"#be185d","parent":"医药生物","level":"L2"},{"key":"i_083","name":"电力","icon":"💡","color":"#0284c7","parent":"公用事业","level":"L2"},{"key":"i_084","name":"燃气Ⅱ","icon":"💡","color":"#0284c7","parent":"公用事业","level":"L2"},{"key":"i_085","name":"热力服务","icon":"💡","color":"#0284c7","parent":"公用事业","level":"L2"},{"key":"i_086","name":"航运港口","icon":"🚢","color":"#1d4ed8","parent":"交通运输","level":"L2"},{"key":"i_087","name":"铁路公路","icon":"🚢","color":"#1d4ed8","parent":"交通运输","level":"L2"},{"key":"i_088","name":"航空机场","icon":"🚢","color":"#1d4ed8","parent":"交通运输","level":"L2"},{"key":"i_089","name":"物流","icon":"🚢","color":"#1d4ed8","parent":"交通运输","level":"L2"},{"key":"i_090","name":"房地产开发","icon":"🏠","color":"#92400e","parent":"房地产","level":"L2"},{"key":"i_091","name":"房地产服务","icon":"🏠","color":"#92400e","parent":"房地产","level":"L2"},{"key":"i_092","name":"一般零售","icon":"🛒","color":"#ea580c","parent":"商贸零售","level":"L2"},{"key":"i_093","name":"多业态零售","icon":"🛒","color":"#ea580c","parent":"商贸零售","level":"L2"},{"key":"i_094","name":"珠宝首饰","icon":"🛒","color":"#ea580c","parent":"商贸零售","level":"L2"},{"key":"i_095","name":"贸易Ⅱ","icon":"🛒","color":"#ea580c","parent":"商贸零售","level":"L2"},{"key":"i_096","name":"专业连锁Ⅱ","icon":"🛒","color":"#ea580c","parent":"商贸零售","level":"L2"},{"key":"i_097","name":"互联网电商","icon":"🛒","color":"#ea580c","parent":"商贸零售","level":"L2"},{"key":"i_098","name":"旅游及景区","icon":"🎡","color":"#0d9488","parent":"社会服务","level":"L2"},{"key":"i_099","name":"酒店餐饮","icon":"🎡","color":"#0d9488","parent":"社会服务","level":"L2"},{"key":"i_100","name":"教育","icon":"🎡","color":"#0d9488","parent":"社会服务","level":"L2"},{"key":"i_101","name":"专业服务","icon":"🎡","color":"#0d9488","parent":"社会服务","level":"L2"},{"key":"i_102","name":"体育Ⅱ","icon":"🎡","color":"#0d9488","parent":"社会服务","level":"L2"},{"key":"i_103","name":"本地生活服务Ⅱ","icon":"🎡","color":"#0d9488","parent":"社会服务","level":"L2"},{"key":"i_104","name":"综合Ⅱ","icon":"🔗","color":"#52525b","parent":"综合","level":"L2"},{"key":"i_105","name":"水泥","icon":"🧱","color":"#78716c","parent":"建筑材料","level":"L2"},{"key":"i_106","name":"玻璃玻纤","icon":"🧱","color":"#78716c","parent":"建筑材料","level":"L2"},{"key":"i_107","name":"装修建材","icon":"🧱","color":"#78716c","parent":"建筑材料","level":"L2"},{"key":"i_108","name":"房屋建设Ⅱ","icon":"🏗️","color":"#92400e","parent":"建筑装饰","level":"L2"},{"key":"i_109","name":"装修装饰Ⅱ","icon":"🏗️","color":"#92400e","parent":"建筑装饰","level":"L2"},{"key":"i_110","name":"基础建设","icon":"🏗️","color":"#92400e","parent":"建筑装饰","level":"L2"},{"key":"i_111","name":"专业工程","icon":"🏗️","color":"#92400e","parent":"建筑装饰","level":"L2"},{"key":"i_112","name":"电机Ⅱ","icon":"🔋","color":"#16a34a","parent":"电力设备","level":"L2"},{"key":"i_113","name":"其他电源设备Ⅱ","icon":"🔋","color":"#16a34a","parent":"电力设备","level":"L2"},{"key":"i_114","name":"光伏设备","icon":"🔋","color":"#16a34a","parent":"电力设备","level":"L2"},{"key":"i_115","name":"风电设备","icon":"🔋","color":"#16a34a","parent":"电力设备","level":"L2"},{"key":"i_116","name":"电池","icon":"🔋","color":"#16a34a","parent":"电力设备","level":"L2"},{"key":"i_117","name":"电网设备","icon":"🔋","color":"#16a34a","parent":"电力设备","level":"L2"},{"key":"i_118","name":"航天装备Ⅱ","icon":"🛡️","color":"#334155","parent":"国防军工","level":"L2"},{"key":"i_119","name":"航空装备Ⅱ","icon":"🛡️","color":"#334155","parent":"国防军工","level":"L2"},{"key":"i_120","name":"地面兵装Ⅱ","icon":"🛡️","color":"#334155","parent":"国防军工","level":"L2"},{"key":"i_121","name":"航海装备Ⅱ","icon":"🛡️","color":"#334155","parent":"国防军工","level":"L2"},{"key":"i_122","name":"军工电子Ⅱ","icon":"🛡️","color":"#334155","parent":"国防军工","level":"L2"},{"key":"i_123","name":"计算机设备","icon":"💻","color":"#2563eb","parent":"计算机","level":"L2"},{"key":"i_124","name":"软件开发","icon":"💻","color":"#2563eb","parent":"计算机","level":"L2"},{"key":"i_125","name":"IT服务Ⅱ","icon":"💻","color":"#2563eb","parent":"计算机","level":"L2"},{"key":"i_126","name":"出版","icon":"🎬","color":"#db2777","parent":"传媒","level":"L2"},{"key":"i_127","name":"影视院线","icon":"🎬","color":"#db2777","parent":"传媒","level":"L2"},{"key":"i_128","name":"广告营销","icon":"🎬","color":"#db2777","parent":"传媒","level":"L2"},{"key":"i_129","name":"游戏Ⅱ","icon":"🎬","color":"#db2777","parent":"传媒","level":"L2"},{"key":"i_130","name":"数字媒体","icon":"🎬","color":"#db2777","parent":"传媒","level":"L2"},{"key":"i_131","name":"电视广播Ⅱ","icon":"🎬","color":"#db2777","parent":"传媒","level":"L2"},{"key":"i_132","name":"通信服务","icon":"📡","color":"#0891b2","parent":"通信","level":"L2"},{"key":"i_133","name":"通信设备","icon":"📡","color":"#0891b2","parent":"通信","level":"L2"},{"key":"i_134","name":"国有大型银行Ⅱ","icon":"🏦","color":"#1e40af","parent":"银行","level":"L2"},{"key":"i_135","name":"股份制银行Ⅱ","icon":"🏦","color":"#1e40af","parent":"银行","level":"L2"},{"key":"i_136","name":"城商行Ⅱ","icon":"🏦","color":"#1e40af","parent":"银行","level":"L2"},{"key":"i_137","name":"农商行Ⅱ","icon":"🏦","color":"#1e40af","parent":"银行","level":"L2"},{"key":"i_138","name":"其他银行Ⅱ","icon":"🏦","color":"#1e40af","parent":"银行","level":"L2"},{"key":"i_139","name":"证券Ⅱ","icon":"📈","color":"#b91c1c","parent":"非银金融","level":"L2"},{"key":"i_140","name":"保险Ⅱ","icon":"📈","color":"#b91c1c","parent":"非银金融","level":"L2"},{"key":"i_141","name":"多元金融","icon":"📈","color":"#b91c1c","parent":"非银金融","level":"L2"},{"key":"i_142","name":"乘用车","icon":"🚗","color":"#0891b2","parent":"汽车","level":"L2"},{"key":"i_143","name":"商用车","icon":"🚗","color":"#0891b2","parent":"汽车","level":"L2"},{"key":"i_144","name":"汽车零部件","icon":"🚗","color":"#0891b2","parent":"汽车","level":"L2"},{"key":"i_145","name":"汽车服务","icon":"🚗","color":"#0891b2","parent":"汽车","level":"L2"},{"key":"i_146","name":"其他交运设备Ⅱ","icon":"🚗","color":"#0891b2","parent":"汽车","level":"L2"},{"key":"i_147","name":"通用设备","icon":"⚙️","color":"#475569","parent":"机械设备","level":"L2"},{"key":"i_148","name":"专用设备","icon":"⚙️","color":"#475569","parent":"机械设备","level":"L2"},{"key":"i_149","name":"轨交设备Ⅱ","icon":"⚙️","color":"#475569","parent":"机械设备","level":"L2"},{"key":"i_150","name":"工程机械","icon":"⚙️","color":"#475569","parent":"机械设备","level":"L2"},{"key":"i_151","name":"自动化设备","icon":"⚙️","color":"#475569","parent":"机械设备","level":"L2"},{"key":"i_152","name":"煤炭开采","icon":"⛏️","color":"#44403c","parent":"煤炭","level":"L2"},{"key":"i_153","name":"焦炭Ⅱ","icon":"⛏️","color":"#44403c","parent":"煤炭","level":"L2"},{"key":"i_154","name":"炼油化工","icon":"🛢️","color":"#7c2d12","parent":"石油石化","level":"L2"},{"key":"i_155","name":"油服工程","icon":"🛢️","color":"#7c2d12","parent":"石油石化","level":"L2"},{"key":"i_156","name":"油气开采Ⅱ","icon":"🛢️","color":"#7c2d12","parent":"石油石化","level":"L2"},{"key":"i_157","name":"环境治理","icon":"♻️","color":"#15803d","parent":"环保","level":"L2"},{"key":"i_158","name":"环保设备Ⅱ","icon":"♻️","color":"#15803d","parent":"环保","level":"L2"},{"key":"i_159","name":"化妆品","icon":"💄","color":"#db2777","parent":"美容护理","level":"L2"},{"key":"i_160","name":"个护用品","icon":"💄","color":"#db2777","parent":"美容护理","level":"L2"},{"key":"i_161","name":"医疗美容","icon":"💄","color":"#db2777","parent":"美容护理","level":"L2"}];
  const BRIEF_INDUSTRY_KEYWORDS = {"i_001":["农林牧渔行业","农业板块","农渔"],"i_002":["基础化工行业","化工板块","化工行业"],"i_003":["钢铁行业","钢铁板块","黑色金属"],"i_004":["有色金属行业","有色板块","有色金属板"],"i_005":["电子行业","电子板块","电子信息"],"i_006":["家电行业","家电板块","家用电器"],"i_007":["食品饮料行业","食饮板块","食品饮料"],"i_008":["纺织服饰行业","纺服板块","纺织服装"],"i_009":["轻工行业","轻工板块","轻工制造"],"i_010":["医药行业","医药板块","医药生物"],"i_011":["公用事业行业","公用板块","公用事业"],"i_012":["交通运输行业","交运板块","交通运输"],"i_013":["房地产行业","地产板块","房地产"],"i_014":["商贸零售行业","零售板块","商贸零售"],"i_015":["社会服务行业","社服板块","社会服务"],"i_016":["建材行业","建材板块","建筑材料"],"i_017":["建筑装饰行业","建筑板块","建筑装饰"],"i_018":["电力设备行业","电新板块","电力设备"],"i_019":["军工行业","军工板块","国防军工"],"i_020":["计算机行业","计算机板块","计算机软件"],"i_021":["传媒行业","传媒板块","传媒"],"i_022":["通信行业","通信板块","通信"],"i_023":["银行业","银行板块","银行"],"i_024":["非银金融行业","非银板块","非银金融"],"i_025":["汽车行业","汽车板块","汽车"],"i_026":["机械行业","机械板块","机械设备"],"i_027":["煤炭行业","煤炭板块","煤炭"],"i_028":["石油石化行业","石化板块","石油石化"],"i_029":["环保行业","环保板块","环保"],"i_030":["美容护理行业","美护板块","美容护理"],"i_031":["种植业","粮食","粮食种植","经济作物","土地承包","土地流转"],"i_032":["养殖业","生猪","禽","牧原","温氏","产能去化"],"i_033":["林业","林木","林地","碳汇林"],"i_034":["饲料","猪料","水产料","预混料","豆粕"],"i_035":["农产品加工","粮油加工","制糖","屠宰","棉花加工"],"i_036":["农业综合","农垦","农场"],"i_037":["渔业","水产","捕捞","养殖海"],"i_038":["化学原料","纯碱","氯碱","烧碱","钛白粉","无机盐"],"i_039":["化学制品","精细化工","涂料","颜料","胶粘剂","日化原料"],"i_040":["化学纤维","化纤","涤纶","氨纶","粘胶","锦纶"],"i_041":["塑料","改性塑料","塑料制品","可降解","膜材料"],"i_042":["橡胶","轮胎橡胶","合成橡胶","天然橡胶"],"i_043":["农化","化肥","农药","草甘膦","钾肥","磷肥","磷化工","磷酸一铵"],"i_044":["非金属材料","石英","高纯石英","陶瓷","石墨"],"i_045":["普钢","螺纹钢","热卷","板材","长材","钢厂"],"i_046":["特钢","特钢企业","合金钢","高温合金"],"i_047":["冶钢原料","铁矿石","焦炭","废钢","球团"],"i_048":["工业金属","铜","铝","锌","铅","电解铝"],"i_049":["贵金属","黄金","白银","金价","避险资产"],"i_050":["小金属","钨","钼","锑","钒","钛","镁","锆"],"i_051":["金属新材料","靶材","电子材料","合金材料"],"i_052":["能源金属","锂","钴","镍","稀土","碳酸锂"],"i_053":["半导体","芯片","集成电路","晶圆","封测","EDA"],"i_054":["消费电子","手机","PC","可穿戴","TWS","智能硬件"],"i_055":["元件","PCB","被动元件","MLCC","电感","电容"],"i_056":["光学光电子","面板","LED","光学元件","摄像头"],"i_057":["其他电子","电子制造","电子代工","电子分销"],"i_058":["电子化学品","光刻胶","电子特气","湿电子化学品"],"i_059":["白电","空调","冰箱","洗衣机","冰洗"],"i_060":["黑电","电视","彩电","激光电视"],"i_061":["小家电","个护","清洁电器","厨房小电","按摩"],"i_062":["厨卫","油烟机","热水器","集成灶"],"i_063":["照明","LED照明","灯具","车灯"],"i_064":["家电零部件","压缩机","电机","阀件"],"i_065":["白酒","茅台","五粮液","次高端","批价"],"i_066":["非白酒","啤酒","黄酒","葡萄酒","其他酒"],"i_067":["饮料","乳品","奶粉","功能饮料","软饮"],"i_068":["休闲食品","零食","坚果","烘焙","糖果"],"i_069":["调味品","酱油","醋","榨菜","复合调味"],"i_070":["食品加工","肉制品","速冻","预制菜","中央厨房"],"i_071":["纺织","纱线","面料","印染","棉纺"],"i_072":["服装","家纺","品牌服饰","运动服","羽绒"],"i_073":["饰品","珠宝","黄金珠宝","手表","眼镜"],"i_074":["造纸","纸浆","文化纸","特种纸","生活用纸"],"i_075":["包装","印刷","纸包装","塑料包装","金属包装"],"i_076":["家居","家具","定制家居","软体家具","卫浴"],"i_077":["化学制药","仿制药","原料药","制剂","创新药化药"],"i_078":["中药","中成药","配方颗粒","中药材","老字号"],"i_079":["生物制品","疫苗","血制品","重组蛋白","单抗"],"i_080":["医药商业","药店","流通","分销","集采配送"],"i_081":["医疗器械","医疗设备","高值耗材","IVD","影像"],"i_082":["医疗服务","医院","眼科","牙科","体检","CXO"],"i_083":["电力","发电","火电","水电","核电","绿电"],"i_084":["燃气","天然气","城市燃气","LNG","管道"],"i_085":["热力","供热","供暖","蒸汽"],"i_086":["航运","港口","集运","油运","干散","码头"],"i_087":["铁路","公路","高铁","高速","客货运"],"i_088":["航空","机场","航班","机票","空运"],"i_089":["物流","快递","仓储","供应链","冷链","即时配送"],"i_090":["房地产开发","房企","住宅","楼盘","土拍"],"i_091":["房地产服务","中介","物业","经纪","代建"],"i_092":["零售","百货","超市","便利店","折扣"],"i_093":["多业态","购物","商业","奥莱"],"i_094":["珠宝","黄金珠宝","钻戒","玉石"],"i_095":["贸易","进出口","外贸","供应链贸易"],"i_096":["专业连锁","家电连锁","药房连锁","母婴"],"i_097":["电商平台","直播电商","电商平","社交电商","网络零售","线上零售","电商直播","电商业务"],"i_098":["旅游","景区","旅行社","乐园","出境"],"i_099":["酒店","餐饮","连锁","火锅","茶饮"],"i_100":["教育","培训","职教","公考","早教"],"i_101":["专业服务","人资","会展","检测","咨询"],"i_102":["体育","赛事","健身","运动"],"i_103":["本地生活","到家","到店","家政"],"i_104":["综合","多元化","投资平台","集团"],"i_105":["水泥","熟料","水泥价格","错峰","骨料"],"i_106":["玻璃","玻纤","光伏玻璃","电子玻璃","风电纱"],"i_107":["装修建材","管材","防水","涂料","五金","卫浴"],"i_108":["房建","施工总承包","保障房"],"i_109":["装修","装饰","幕墙","精装"],"i_110":["基建","路桥","水利工程","市政","轨交建设"],"i_111":["专业工程","钢结构","园林","化学工程","国际工程"],"i_112":["电机","微特电机","工业电机","伺服电机"],"i_113":["电源设备","UPS","储能PCS","应急电源"],"i_114":["光伏设备","硅片设备","电池片设备","组件设备","逆变器"],"i_115":["风电设备","风机","塔筒","叶片","海缆"],"i_116":["电池","锂电池","动力电池","储能电池","电池材料"],"i_117":["电网设备","变压器","开关","电缆","特高压设备"],"i_118":["航天装备","火箭","卫星","飞船","导弹"],"i_119":["航空装备","战机","发动机","直升机"],"i_120":["地面兵装","装甲","火炮","车辆"],"i_121":["航海装备","军舰","航母","驱逐舰","民船"],"i_122":["军工电子","雷达","红外","电子对抗","军工芯片"],"i_123":["计算机设备","服务器","PC","打印机","信创硬件"],"i_124":["软件开发","操作系统","数据库","中间件","行业软件"],"i_125":["IT服务","系统集成","运维","SaaS","云计算服务"],"i_126":["出版","教材","教辅","少儿","数字出版"],"i_127":["影视","电影","票房","院线","剧集"],"i_128":["广告","营销","梯媒","品牌","投放"],"i_129":["游戏","版号","手游","电竞","出海"],"i_130":["数字媒体","短视频","长视频","直播","IP"],"i_131":["广电","电视","有线电视","IPTV","融媒"],"i_132":["通信服务","运营商","增值服务","短信","呼叫中心"],"i_133":["通信设备","光模块","交换机","天线","基站"],"i_134":["国有大行","工行","建行","农行","中行","交行","邮储"],"i_135":["股份行","招行","兴业","浦发","中信","民生"],"i_136":["城商行","北京银行","宁波银行","南京银行","区域银行"],"i_137":["农商行","农村商业银行","农信","村镇银行"],"i_138":["其他银行","政策性银行","外资行"],"i_139":["证券","券商","投行","经纪","两融"],"i_140":["保险","寿险","财险","保费","NBV"],"i_141":["多元金融","信托","期货","租赁","AMC","金控"],"i_142":["乘用车","轿车","SUV","新能源乘用车","车企"],"i_143":["商用车","客车","货车","重卡","轻卡"],"i_144":["零部件","轮胎","内外饰","冲压","汽车电子","热管理"],"i_145":["汽车服务","经销","维修","二手车","后市场"],"i_146":["其他交运","摩托车","自行车","通航设备"],"i_147":["通用设备","泵","阀","压缩机","轴承","机床"],"i_148":["专用设备","锂电设备","包装设备","检测设备"],"i_149":["轨交设备","高铁","地铁","机车","信号"],"i_150":["工程机械","挖掘机","装载机","起重机","液压"],"i_151":["自动化","机器人","工控","PLC","运动控制"],"i_152":["煤炭开采","动力煤","焦煤","无烟煤","煤矿"],"i_153":["焦炭","焦化","冶金焦","煤化工"],"i_154":["炼油","石化","炼化","乙烯","PX","聚酯"],"i_155":["油服","油田服务","钻井","压裂","海油工程"],"i_156":["油气开采","原油","天然气开采","页岩气","煤层气"],"i_157":["环境治理","污水","固废","大气","土壤修复"],"i_158":["环保设备","环卫","监测","水处理设备","除尘"],"i_159":["化妆品","护肤","美妆","彩妆"],"i_160":["个护","洗护","卫生用品","纸尿裤"],"i_161":["医美","玻尿酸","胶原蛋白","光电医美","注射"]};
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
   * batch31：单条规则命中判断。规则有两种形态，向后兼容：
   *   ① 数组        —— 旧逻辑：命中任一关键词即算命中；
   *   ② {must, any} —— 组合逻辑：any 命中任一 → true；否则 must 的每一组都要各命中至少一个 → true。
   *                    用于「各省项目」这类需要「省市名 + 项目特征词」同时出现的口径。
   */
  function _hitRule(text, rule) {
    if (!rule) return false;
    if (Array.isArray(rule)) {
      for (let i = 0; i < rule.length; i++) { if (text.indexOf(rule[i]) >= 0) return true; }
      return false;
    }
    if (rule.any && rule.any.length) {
      for (let i = 0; i < rule.any.length; i++) { if (text.indexOf(rule.any[i]) >= 0) return true; }
    }
    if (rule.must && rule.must.length) {
      for (let g = 0; g < rule.must.length; g++) {
        const group = rule.must[g] || [];
        let ok = false;
        for (let i = 0; i < group.length; i++) { if (text.indexOf(group[i]) >= 0) { ok = true; break; } }
        if (!ok) return false;
      }
      return true;
    }
    return false;
  }

  /**
   * batch31：「各省项目」清单抽取。
   * 从已命中的快讯里归纳出「省份 / 项目事项 / 投资额 / 时间」，供界面上附带展示。
   * 不新增任何数据源——完全基于当日已抓取的快讯文本做本地归纳，因此不会有额外的网络请求。
   * @param {Array<{text:string,time?:string,url?:string}>} news
   * @returns {Array<{province:string,amount:string,title:string,time:string,url:string}>}
   */
  function briefProjectList(news) {
    const out = [];
    const list = news || [];
    for (const it of list) {
      const t = cleanBriefText(it && it.text);
      if (!t) continue;
      // 1) 省份：取文本里出现的第一个省级行政区名（能覆盖「广东省」「广东」「粤」之外的常见写法）
      let province = '';
      for (const p of PROVINCES) {
        if (t.indexOf(p) >= 0) { province = p; break; }
      }
      // 2) 投资额：优先取带「总投资/投资额/投资」前缀的金额，其次取文中最大的一笔金额
      let amount = '';
      const m1 = /(?:总投资|投资额|投资规模|计划投资|拟投资|年度投资)[^0-9]{0,8}(\d+(?:\.\d+)?)\s*(万亿|亿元|万元|亿|万)/.exec(t);
      if (m1) amount = m1[1] + m1[2];
      if (!amount) {
        const all = t.match(/(\d+(?:\.\d+)?)\s*(万亿|亿元|万元)/g) || [];
        if (all.length) {
          // 取数值最大的一笔，作为该条快讯的代表投资额
          let best = '', bestV = -1;
          for (const s of all) {
            const mm = /(\d+(?:\.\d+)?)\s*(万亿|亿元|万元)/.exec(s);
            if (!mm) continue;
            let v = parseFloat(mm[1]);
            if (mm[2] === '万亿') v *= 10000; else if (mm[2] === '万元') v /= 10000;
            if (v > bestV) { bestV = v; best = mm[1] + mm[2]; }
          }
          amount = best;
        }
      }
      // 3) 标题：剥掉来源前缀后截取前 46 字作为事项摘要
      const title = t.length > 46 ? t.slice(0, 46) + '…' : t;
      out.push({
        province: province || '未标注省份',
        amount: amount || '',
        title,
        time: String((it && it.time) || ''),
        url: String((it && it.url) || '')
      });
    }
    // 排序：先按省份（同一省聚在一起），再按投资额从大到小，最后是时间新的在前
    const unitVal = (s) => {
      const mm = /(\d+(?:\.\d+)?)\s*(万亿|亿元|万元)/.exec(s || '');
      if (!mm) return -1;
      let v = parseFloat(mm[1]);
      if (mm[2] === '万亿') v *= 10000; else if (mm[2] === '万元') v /= 10000;
      return v;
    };
    out.sort((a, b) => {
      const pa = a.province === '未标注省份' ? 1 : 0, pb = b.province === '未标注省份' ? 1 : 0;
      if (pa !== pb) return pa - pb;
      if (a.province !== b.province) return a.province.localeCompare(b.province, 'zh-Hans-CN');
      const d = unitVal(b.amount) - unitVal(a.amount);
      if (d !== 0) return d;
      return String(b.time).localeCompare(String(a.time));
    });
    return out;
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
    // batch56：一次打分、统一裁决（旧逻辑是「命中任一关键词即归入」，会把「主流平台」这类
    // 顺带出现的泛词当成主题，导致算力研报被归到「互联网电商」）。
    const dimKeys = dims.map(d => d.key);
    const nameOfKey = Object.create(null);
    dims.forEach(d => { nameOfKey[d.key] = d.name; });
    const bucket = Object.create(null);
    dimKeys.forEach(k => { bucket[k] = []; });
    for (const it of list) {
      const t = cleanBriefText(it.text);
      if (!t) continue;
      const rows = scoreEntries(t, dict, dimKeys, k => nameOfKey[k]);
      for (const r of rows) { if (bucket[r.key]) bucket[r.key].push(it); }
    }
    const raw = dims.map(dim => {
      const news = bucket[dim.key] || [];
      // 时间新的在前（快讯本身就是时间倒序，这里再兜一次底）
      news.sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));
      const row = { key: dim.key, name: dim.name, icon: dim.icon, color: dim.color, count: news.length, news };
      // batch31：标了 projectList 的维度（各省项目）额外产出可展开的项目清单
      if (dim.projectList) row.projects = briefProjectList(news);
      return row;
    });
    // 自动按归类条数（比例）从大到小排序，便于一眼看到占比最高的分类
    // batch48：过滤掉「该时间窗口内 0 条命中」的分类，避免 150+ 维度铺满空行。
    // 主题/概念/行业三套维度统一只展示有新闻命中的类别，便于一眼看到重点。
    const nonEmpty = raw.filter(d => d.count > 0);
    nonEmpty.sort((a, b) => b.count - a.count);
    const max = nonEmpty.reduce((m, d) => Math.max(m, d.count), 1);
    nonEmpty.forEach(d => {
      d.pct = base ? Math.round((d.count / base) * 100) : 0;
      d.width = Math.max(4, Math.round((d.count / max) * 100));
    });
    return nonEmpty;
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
    CATEGORIES, CATEGORY_COLORS, CATEGORY_KEYWORDS,
    CATEGORY_ALIASES, normalizeCategory,
    SOURCE_ORDER, SOURCE_BY_KEY,
    classify, normalizeTitle, bigrams, jaccard, signalTokens, isSameTopic,
    clusterItems, siteCategoryStats, siteThemeStats,
    THEME_DIMENSIONS, THEME_KEYWORDS, themeStats,
    BRIEF_DIMENSIONS, BRIEF_KEYWORDS, briefStats, cleanBriefText,
    BRIEF_CONCEPT_DIMS, BRIEF_CONCEPT_KEYWORDS,
    BRIEF_INDUSTRY_DIMS, BRIEF_INDUSTRY_KEYWORDS,
    BRIEF_MODES,
    // batch31：各省项目（省市词表 / 项目特征词 / 组合命中规则 / 项目清单抽取）
    PROVINCES, PROJECT_WORDS, _hitRule, briefProjectList,
    // batch56：严格分类引擎（供单测直接断言打分/主体判定）
    STRICT_CFG, ENTITY_MAP, extractSubject, kwSpecificity, dictIndex, kwWeight, scoreEntries,
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
