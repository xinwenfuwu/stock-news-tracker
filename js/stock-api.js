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

// ============================================================
//  AI 语义选股：概念本体（自然语言 → 板块关键词映射）
//  纯前端、免费、无需后端 / API Key；通过「概念板块交叉匹配 + 总市值排序」
//  在浏览器侧实现"语义级"筛选。
//  - aliases：在用户输入的自然语言里被识别为该类概念的词（含英文缩写）
//  - hints  ：用于在东方财富板块名称里匹配该类概念的关键词（子串）
// ============================================================
//  segHints：命中概念后用于匹配「主营构成段名」的精确子串（相关度计算）。
//  注意：务必用「精确词组」而非过宽单字——如用「智能」会误命中蓝思科技
//  （其段名均为「智能手机/智能汽车/智能头显」）；故统一用「人工智能」「内容安全」等完整词组。
const SEMANTIC_CONCEPTS = [
  { canonical: '人工智能', aliases: ['人工智能', 'ai', 'a.i', 'aigc', '大模型', 'gpt', 'chatgpt', '生成式', '多模态', '智能体', 'agent', 'llm', '机器学习', '深度学习', '算力大模型'],
    hints: ['人工智能', 'ai', 'aigc', '智能体', '多模态', '大模型', 'chatgpt', '深度学习', '机器学习'],
    segHints: ['人工智能', '大模型', '机器学习', '深度学习', '算法', '多模态', '自然语言', '语义理解', '智能体', '生成式', 'ai'] },
  { canonical: '安全', aliases: ['安全', '网络安全', '信息安全', '数据安全', '网安', '信安', '安防', '安保'],
    hints: ['安全', '安防'],
    segHints: ['安全', '安防', '网络安全', '信息安全', '内容安全', '数据安全', '保密', '加密', '防火墙'] },
  { canonical: '信创', aliases: ['信创', '国产软件', '国产操作系统', '软件', '操作系统', '数据库', '工业软件'],
    hints: ['信创', '国产软件', '软件', '操作系统', '数据库'],
    segHints: ['信创', '国产软件', '操作系统', '数据库', '工业软件', '办公软件'] },
  { canonical: '芯片半导体', aliases: ['芯片', '半导体', '集成电路', '晶圆', '光刻', '国产芯片', '半导体设备', 'soc', 'mcu'],
    hints: ['芯片', '半导体', '集成电路', '光刻', '晶圆'],
    segHints: ['芯片', '半导体', '集成电路', '晶圆', '光刻', '碳化硅', '功率半导体', '封测', '存储芯片', 'mcu', 'soc'] },
  { canonical: '机器人', aliases: ['机器人', '人形机器人', '工业机器人', '服务机器人', '减速器', '机械臂', '具身智能'],
    hints: ['机器人', '减速器', '具身'],
    segHints: ['机器人', '减速器', '伺服', '电机', '丝杠', '传感器', '具身'] },
  { canonical: '算力', aliases: ['算力', '东数西算', '智算', '算力租赁', '数据中心', 'idc', '液冷', '算力中心'],
    hints: ['算力', '东数西算', '数据中心', 'idc', '液冷'],
    segHints: ['算力', '数据中心', 'idc', '液冷', '智算', '东数西算', '云计算'] },
  { canonical: '智能驾驶', aliases: ['自动驾驶', '无人驾驶', '智能驾驶', '辅助驾驶', '车联网', '智能座舱'],
    hints: ['自动驾驶', '无人驾驶', '智能驾驶', '车联网', '智能座舱'],
    segHints: ['自动驾驶', '无人驾驶', '智能驾驶', '车联网', '智能座舱', '智能汽车'] },
  { canonical: '新能源', aliases: ['新能源', '光伏', '风电', '氢能', '储能', '充电桩', '特高压', '绿电'],
    hints: ['光伏', '风电', '储能', '氢能', '充电桩', '特高压', '新能源', '绿电'],
    segHints: ['光伏', '风电', '储能', '氢能', '充电桩', '特高压', '绿电', '电池'] },
  { canonical: '锂电池新能源车', aliases: ['锂电池', '锂电', '新能源车', '电动汽车', '动力电池', '固态电池', '新能源整车'],
    hints: ['锂电池', '锂电', '新能源车', '动力电池', '固态电池', '整车'],
    segHints: ['锂电池', '锂电', '新能源车', '动力电池', '固态电池', '整车'] },
  { canonical: '医药', aliases: ['医药', '创新药', '生物制药', '医疗器械', '中药', 'cxo', '疫苗', '医疗服务'],
    hints: ['医药', '创新药', '医疗器械', '中药', '生物制药', 'cxo', '疫苗'],
    segHints: ['创新药', '医疗器械', '中药', '生物制药', 'cxo', '疫苗', '医疗服务', '医药'] },
  { canonical: '军工', aliases: ['军工', '国防', '航空装备', '卫星导航', '船舶', '兵器', '军民融合'],
    hints: ['军工', '国防', '卫星', '航空装备', '船舶', '兵器'],
    segHints: ['军工', '国防', '卫星', '航空装备', '船舶', '兵器', '军民融合'] },
  { canonical: '低空经济', aliases: ['低空经济', '飞行汽车', 'evtol', '通航', '无人机'],
    hints: ['低空经济', '飞行汽车', '通航', '无人机'],
    segHints: ['低空', '飞行汽车', 'evtol', '无人机', '通航'] },
  { canonical: '商业航天', aliases: ['商业航天', '卫星互联网', '火箭', '航天'],
    hints: ['商业航天', '卫星互联网', '航天'],
    segHints: ['商业航天', '卫星互联网', '火箭', '航天'] },
  { canonical: '消费白酒', aliases: ['白酒', '食品饮料', '消费', '啤酒', '免税', '新零售'],
    hints: ['白酒', '食品饮料', '啤酒', '免税', '新零售'],
    segHints: ['白酒', '食品饮料', '啤酒', '免税', '新零售', '消费'] },
  { canonical: '金融', aliases: ['银行', '保险', '券商', '金融', '信托', '期货', '财富管理'],
    hints: ['银行', '保险', '券商', '期货', '信托'],
    segHints: ['银行', '保险', '券商', '期货', '信托', '财富管理'] },
  { canonical: '房地产', aliases: ['房地产', '地产', '物业服务', '园区开发'],
    hints: ['房地产', '物业'],
    segHints: ['房地产', '地产', '物业服务', '园区'] },
  { canonical: '化工', aliases: ['化工', '化学', '化肥', '农药', '塑料', '橡胶', '钛白粉'],
    hints: ['化工', '化肥', '农药'],
    segHints: ['化工', '化肥', '农药', '钛白粉', '化学'] },
  { canonical: '有色金属', aliases: ['有色', '黄金', '稀土', '铜', '铝', '锂矿', '小金属'],
    hints: ['有色', '黄金', '稀土', '小金属'],
    segHints: ['有色', '黄金', '稀土', '铜', '铝', '锂矿', '小金属'] },
  { canonical: '钢铁煤炭', aliases: ['钢铁', '煤炭', '焦炭'],
    hints: ['钢铁', '煤炭'],
    segHints: ['钢铁', '煤炭', '焦炭'] },
  { canonical: '农业', aliases: ['农业', '猪肉', '养殖', '种业', '粮食'],
    hints: ['农业', '猪肉', '养殖', '种业'],
    segHints: ['农业', '猪肉', '养殖', '种业', '粮食'] },
  { canonical: '数字经济', aliases: ['数字经济', '数据要素', '数据确权', '数字中国', '大数据', '云计算', '边缘计算'],
    hints: ['数字经济', '数据要素', '数据确权', '大数据', '云计算', '边缘计算'],
    segHints: ['数字经济', '数据要素', '数据确权', '大数据', '云计算', '边缘计算', '数据交易'] },
  { canonical: '通信5g', aliases: ['5g', '通信', '光模块', 'cpo', '算力网络', '6g'],
    hints: ['5g', '通信', '光模块', 'cpo', '6g'],
    segHints: ['5g', '通信', '光模块', 'cpo', '6g', '光通信'] },
  { canonical: '传媒游戏', aliases: ['传媒', '游戏', '元宇宙', 'vr', 'ar', '影视', '出版'],
    hints: ['传媒', '游戏', '元宇宙', '影视', '出版'],
    segHints: ['传媒', '影视', '游戏', '出版', '元宇宙', '直播', '短视频', '版权', '动漫', '网剧'] },
  { canonical: '教育', aliases: ['教育', '培训', '职业教育'],
    hints: ['教育', '培训'],
    segHints: ['教育', '培训', '职业教育'] },
  { canonical: '养老', aliases: ['养老', '银发', '医养'],
    hints: ['养老', '医养'],
    segHints: ['养老', '医养', '银发'] },
  { canonical: '国企改革', aliases: ['国企改革', '中字头', '央企', '国资', '央企改革'],
    hints: ['国企改革', '中字头', '央企改革', '国资'],
    segHints: ['国企改革', '中字头', '央企', '国资'] },
  { canonical: '环保', aliases: ['环保', '碳中和', '污水处理', '固废', '绿化'],
    hints: ['环保', '碳中和', '污水处理'],
    segHints: ['环保', '碳中和', '污水处理', '固废'] },
  { canonical: '电商互联网', aliases: ['电商', '互联网', '平台经济', '直播', '跨境电商'],
    hints: ['电商', '互联网', '平台经济', '直播'],
    segHints: ['电商', '互联网', '平台', '直播', '跨境电商'] },
  { canonical: '氢能源', aliases: ['氢能源', '氢燃料电池', '加氢'],
    hints: ['氢能源', '氢燃料', '加氢'],
    segHints: ['氢能源', '氢燃料', '加氢'] },
  { canonical: '医疗健康', aliases: ['医疗', '健康', '养老医疗', '连锁医疗'],
    hints: ['医疗', '健康'],
    segHints: ['医疗', '健康', '医养'] },
  { canonical: '短剧', aliases: ['短剧', '微短剧', '互动剧', '小程序剧', '短剧游戏'],
    hints: ['短剧', '微短剧', '互动剧'],
    segHints: ['短剧', '微短剧', '互动剧', '网剧', '小程序剧'] },
  { canonical: '内容审核', aliases: ['审核', '内容审核', '内容审查', '审查', '合规审核', '风控审核', '安全审核', '内容安全审核', '舆情审核'],
    hints: ['审核', '内容安全', '内容审核', '数据安全', '网络安全', '网络安', '信安', '数字水印'],
    segHints: ['审核', '内容审核', '内容安全', '审查', '版权', '舆情', '风控', '合规', '视听内容', '传媒安全', '网络内容', '数字水印', '安全审核', '内容风控', '数据安全'] },
  { canonical: '版权', aliases: ['版权', 'ip版权', '知识产权', '著作权'],
    hints: ['版权', '知识产权'],
    segHints: ['版权', '知识产权', 'ip'] },
  { canonical: '舆情', aliases: ['舆情', '舆论', '口碑监测', '舆论监测'],
    hints: ['舆情'],
    segHints: ['舆情', '舆论'] }
];

/**
 * 产品级语义知识库（语义筛选的核心新增能力）
 * 与 SEMANTIC_CONCEPTS（概念/行业板块名映射）不同，这里直接把
 * 「具体产品 / 技术 / 材料 / 设备」映射到【真实上市公司 + 业务环节】，
 * 由产业链研究整理，因此不是去匹配板块名，而是直接给出做这件事的公司。
 * 例：薄膜铌酸锂 → 光库科技、天通股份、中际旭创……（上游晶体→中游调制器→下游光模块）
 *
 * 每条 stocks 中的 code 形如 sh600330 / sz300620（与 getQuotes 一致），
 * role 为该公司在产业链中的定位，用于结果透明展示。
 */
const SEMANTIC_PRODUCTS = [
  {
    key: '薄膜铌酸锂',
    desc: '薄膜铌酸锂(TFLN)调制器/光芯片及上游晶体材料，用于 1.6T/3.2T 高速光模块、CPO 共封装；是 AI 光互联的核心增量环节。',
    aliases: ['薄膜铌酸锂', '薄膜磷酸锂', 'tfiln', 'tfin', 'lnoi', '铌酸锂调制器', '铌酸锂光模块', '铌酸锂晶圆', '铌酸锂芯片', '铌酸锂晶体', '铌酸锂'],
    stocks: [
      { code: 'sz300620', name: '光库科技', role: '中游核心·国内唯一 8 英寸 TFLN 调制器 IDM 量产龙头，英伟达供应链' },
      { code: 'sz002281', name: '光迅科技', role: '中游·自研 TFLN 调制芯片批量出货' },
      { code: 'sz000988', name: '华工科技', role: '中游·TFLN 调制器自研送样验证' },
      { code: 'sh600330', name: '天通股份', role: '上游·8 英寸光学级铌酸锂晶圆量产绝对龙头（市占约 40%）' },
      { code: 'sz002222', name: '福晶科技', role: '上游·高纯光学晶体/铌酸锂单晶全球龙头' },
      { code: 'sh688126', name: '沪硅产业', role: '上游·薄膜铌酸锂衬底量产、8 英寸送样' },
      { code: 'sz000962', name: '东方钽业', role: '上游·光学级高纯五氧化二铌主力供货商' },
      { code: 'sh601061', name: '中信金属', role: '上游·高纯铌原料（巴西 CBMM）国内独家代理' },
      { code: 'sz300308', name: '中际旭创', role: '下游·全球光模块龙头，1.6T 主力采用 TFLN 方案' },
      { code: 'sz300502', name: '新易盛', role: '下游·800G/1.6T 光模块含 TFLN 技术路线' },
      { code: 'sz301205', name: '联特科技', role: '下游·光模块厂商，布局 TFLN 方案' },
      { code: 'sh688205', name: '德科立', role: '下游·推出基于 TFLN 的低功耗光模块' },
      { code: 'sh603083', name: '剑桥科技', role: '下游·基于铌酸锂技术研发高端产品' },
      { code: 'sz300747', name: '锐科激光', role: '特种薄膜铌酸锂器件小产线' }
    ]
  },
  {
    key: 'HBM',
    desc: 'HBM（高带宽存储）是 AI 训练最核心的存储品种，国产替代与先进封装主线；覆盖上游材料/设备、封测、存储及接口芯片。',
    aliases: ['hbm', '高带宽存储', '高带宽内存', 'hbm3', 'hbm4', 'hbm存储', '存储芯片'],
    stocks: [
      { code: 'sh600584', name: '长电科技', role: '封测·全球第三封测龙头，XDFOI 支持 HBM 封装' },
      { code: 'sz002156', name: '通富微电', role: '封测·CXMT 最大封测客户，HBM 国产化封测核心' },
      { code: 'sz000021', name: '深科技', role: '封测·国内高端存储封测龙头' },
      { code: 'sz002185', name: '华天科技', role: '封测·存储封装国内第一' },
      { code: 'sz002409', name: '雅克科技', role: '材料·国内唯一进入 SK海力士/三星/美光 HBM 前驱体供应链' },
      { code: 'sh688535', name: '华海诚科', role: '材料·国内唯一量产 HBM 环氧塑封料(GMC)' },
      { code: 'sh688300', name: '联瑞新材', role: '材料·Low-α 球形硅微粉（HBM 封装基板）' },
      { code: 'sz300398', name: '飞凯材料', role: '材料·先进封装湿电子化学品/锡球/EMC' },
      { code: 'sz301319', name: '唯特偶', role: '材料·低温无铅锡膏用于 HBM 堆叠' },
      { code: 'sh688012', name: '中微公司', role: '设备·TSV 深孔刻蚀龙头' },
      { code: 'sz002371', name: '北方华创', role: '设备·CXMT 第一大设备供应商' },
      { code: 'sh603283', name: '赛腾股份', role: '设备·HBM 检测设备龙头，供货三星/海力士' },
      { code: 'sz300567', name: '精测电子', role: '设备·HBM 老化/FT 测试' },
      { code: 'sh688627', name: '精智达', role: '设备·HBM 存储测试方案' },
      { code: 'sh688361', name: '中科飞测', role: '设备·3D AOI/HBM 先进封装量测' },
      { code: 'sh688037', name: '芯源微', role: '设备·临时键合/解键合机（HBM/CoWoS）' },
      { code: 'sh688008', name: '澜起科技', role: '芯片·内存接口芯片龙头，HBM 配套' },
      { code: 'sh603986', name: '兆易创新', role: '存储·利基 DRAM+MCU，直接持股 CXMT' },
      { code: 'sh688525', name: '佰维存储', role: '存储·模组/封测一体化' },
      { code: 'sz301308', name: '江波龙', role: '存储·企业级存储龙头' },
      { code: 'sz300475', name: '香农芯创', role: '分销·SK海力士 HBM 核心代理商' }
    ]
  },
  {
    key: '复合集流体',
    desc: '复合集流体（以复合铜箔为代表）是新一代锂电集流体材料，更轻更安全；产业链分设备、基膜、成品制造三环节。',
    aliases: ['复合集流体', '复合铜箔', '复合铝箔', 'pet铜箔', '复合铜', '集流体'],
    stocks: [
      { code: 'sh688700', name: '东威科技', role: '设备·复合铜箔水电镀设备绝对龙头（市占超 80%）' },
      { code: 'sh688392', name: '骄成超声', role: '设备·超声波焊接/检测设备' },
      { code: 'sz301392', name: '汇成真空', role: '设备·磁控溅射设备核心供应商' },
      { code: 'sh688359', name: '三孚新科', role: '设备·水电镀药水/专用化工材料' },
      { code: 'sh603800', name: '洪田股份', role: '设备·磁控溅射设备' },
      { code: 'sz002585', name: '双星新材', role: '基膜·PET 复合铜箔基膜龙头' },
      { code: 'sh601208', name: '东材科技', role: '基膜·电工级聚酯薄膜龙头' },
      { code: 'sh600237', name: '铜峰电子', role: '基膜·PET/PP 两种基膜' },
      { code: 'sz002992', name: '宝明科技', role: '制造·复合铜箔量产龙头（收入+509%）' },
      { code: 'sz300057', name: '万顺新材', role: '制造·复合铜箔/铝箔' },
      { code: 'sz002846', name: '英联股份', role: '制造·复合铜箔布局' },
      { code: 'sh600110', name: '诺德股份', role: '制造·铜箔/复合铜箔' }
    ]
  },
  {
    key: '人形机器人减速器',
    desc: '人形机器人机械核心：谐波/RV 减速器（关节骨骼）与行星滚柱丝杠（线性关节），国产替代空间大。',
    aliases: ['人形机器人减速器', '机器人减速器', '谐波减速器', 'rv减速器', '行星滚柱丝杠', '机器人丝杠', '滚柱丝杠', '机器人关节'],
    stocks: [
      { code: 'sh688017', name: '绿的谐波', role: '谐波减速器龙头，国产市占 60%+' },
      { code: 'sz300503', name: '昊志机电', role: '谐波+RV 减速器双线布局' },
      { code: 'sz002472', name: '双环传动', role: 'RV 重载减速器龙头' },
      { code: 'sz000837', name: '秦川机床', role: 'RV 减速器' },
      { code: 'sz002896', name: '中大力德', role: '谐波/RV/行星减速器一体化' },
      { code: 'sh600835', name: '上海机电', role: '与纳博特斯克合资 RV 减速机' },
      { code: 'sh601100', name: '恒立液压', role: '行星滚柱丝杠/线性执行器' },
      { code: 'sh603667', name: '五洲新春', role: '行星滚柱丝杠量产，切入特斯拉链' },
      { code: 'sz300580', name: '贝斯特', role: '高精度丝杠磨削' },
      { code: 'sz300100', name: '双林股份', role: '反向式行星滚柱丝杠突破' },
      { code: 'sh603009', name: '北特科技', role: '机器人丝杠子公司' },
      { code: 'sz002050', name: '三花智控', role: '旋转执行器/热管理（Tesla Tier1）' },
      { code: 'sh601689', name: '拓普集团', role: '线性关节总成（Tesla Optimus）' },
      { code: 'sz300124', name: '汇川技术', role: '伺服+控制器全栈龙头' },
      { code: 'sh603728', name: '鸣志电器', role: '空心杯电机' },
      { code: 'sh603662', name: '柯力传感', role: '六维力传感器龙头' },
      { code: 'sh688322', name: '奥比中光', role: '3D 视觉感知' }
    ]
  }
];

/** 限制并发的 map（批量拉取板块成分股时避免触发限流） */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  const n = Math.min(limit, items.length);
  const workers = [];
  for (let k = 0; k < n; k++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

/** 板块名称与概念本体的相关度评分（用于排序：越相关越优先被纳入交叉匹配） */
function semanticNameScore(name, canon) {
  const n = String(name).toLowerCase();
  const c = String(canon).toLowerCase();
  if (n === c) return 100;
  if (n.startsWith(c)) return 80;
  if (n.includes(c)) return 60;
  return 10;
}

/** 解析修饰词（核心/龙头、小市值） */
function parseSemanticModifiers(query) {
  const m = [];
  if (/(核心|龙头|主营|主营业务|业务|代表性|核心标的|正宗|纯正|核心公司)/.test(query)) m.push('核心');
  if (/(小市值|小盘|微小盘|次新)/.test(query)) m.push('小市值');
  return m;
}

// ============ 语义 → 主营构成匹配（营收占比相关度） ============
// 从自然语言查询抽取「业务/产品」匹配词，并聚合命中概念的主营段名匹配词，
// 用于把候选公司的「主营构成」段名与语义描述做子串匹配，命中段营收占比之和即相关度。

/** 停用词：从查询里剔除，避免「的/为/企业」等噪声成为段名匹配词 */
const SEMANTIC_STOPWORDS = new Set([
  '的', '为', '是', '了', '和', '与', '及', '或', '在', '有', '做', '找', '整理', '生产', '企业', '上市', '公司',
  '主营', '核心', '龙头', '我们', '请', '帮', '我', '等', '哪些', '什么', '列出', '给出', '筛选', '选出', '符合',
  '业务', '产品', '占', '营收', '比例', '收入', '主要', '从事', '关于', '相关', '一个', '一种', '进行', '提供',
  '服务', '技术', '方案', '系统', '平台', '分析', '研究', '推荐', '希望', '想', '需要', '如何', '怎么', '哪家',
  '正宗', '纯正', '标的', '概念', '板块', '股票', '股', '梳理', '罗列', '一共', '全部', '所有', '分别', '各自',
  '以及', '并且', '同时', '既', '又', '该', '这个', '这些', '那些', '一家', '一些'
]);

/**
 * 从自然语言查询抽取业务/产品匹配词（作为主营构成段名的子串）。
 * 中文按 2~3 字滑动窗口切分（剔除停用词），英文/数字按整词提取。
 * 例：「ai短剧审核」→ ['短剧','剧审','审核','ai']（'剧审'为无害噪声）
 */
function extractQueryTerms(query) {
  const q = String(query || '').toLowerCase();
  const terms = new Set();
  const latin = q.match(/[a-z0-9]{2,}/g) || [];
  latin.forEach(t => terms.add(t));
  const cn = q.match(/[一-龥]+/g) || [];
  cn.forEach(run => {
    if (run.length <= 4) terms.add(run);
    for (let n = 2; n <= 3; n++) {
      for (let i = 0; i + n <= run.length; i++) {
        const g = run.slice(i, i + n);
        if (!SEMANTIC_STOPWORDS.has(g)) terms.add(g);
      }
    }
  });
  return [...terms];
}

/**
 * 把自然语言解析为语义匹配要素。
 *  - concepts：命中的概念本体（用于概念板块检索候选池 + 标签展示）
 *  - boardHints：从命中概念聚合的「板块名」匹配词（候选池发现）
 *  - segHints：从命中概念聚合的「主营构成段名」匹配词（相关度计算）
 *  - generic：从查询直接抽取的通用匹配词（同时用于板块名与段名）
 */
function buildMatchers(query) {
  const ql = String(query || '').toLowerCase();
  const concepts = [];
  const boardHints = new Set();
  const segHints = new Set();
  for (const c of SEMANTIC_CONCEPTS) {
    if (c.aliases.some(a => ql.includes(a.toLowerCase()))) {
      concepts.push(c.canonical);
      (c.hints || []).forEach(h => boardHints.add(h.toLowerCase()));
      (c.segHints || []).forEach(h => segHints.add(h.toLowerCase()));
    }
  }
  const generic = extractQueryTerms(query);
  generic.forEach(t => { boardHints.add(t); segHints.add(t); });
  return { concepts, boardHints: [...boardHints], segHints: [...segHints], generic };
}

/** 主营构成段名是否命中任一匹配词（子串，忽略大小写） */
function segMatches(segName, matchersArr) {
  if (!segName) return false;
  const s = String(segName).toLowerCase();
  for (const m of matchersArr) if (s.includes(m)) return true;
  return false;
}

/**
 * 根据主营构成计算「营收占比相关度」。
 * 相关度 = 命中语义描述的主营业务/产品段之营收占比之和（%，0~100）。
 * @returns {{relevance:number, matched:Array<{name:string,ratio:number}>}}
 */
function revenueRelevance(mainBiz, matchersArr) {
  if (!mainBiz || !mainBiz.length) return { relevance: 0, matched: [] };
  let rel = 0;
  const matched = [];
  for (const seg of mainBiz) {
    if (segMatches(seg.name, matchersArr)) {
      const r = (seg.ratio || 0);
      rel += r;
      matched.push({ name: seg.name, ratio: Math.round(r * 1000) / 10 });
    }
  }
  if (rel > 1) rel = 1; // ratio 以小数计，封顶 100%
  return { relevance: Math.round(rel * 1000) / 10, matched };
}

/** 产品级语义「相关度」评分（产品库兜底：东财未列明细分业务时按产业链角色保底） */
function scoreRoleRelevance(role) {
  const r = String(role || '');
  let s = 68;
  if (/代理|分销/.test(r)) s = 58; // 代理/分销环节：非主业自产，相关度最低
  else if (/绝对龙头|市占/.test(r)) s = 96;
  else if (/龙头/.test(r)) s = 92;
  else if (/唯一|IDM/.test(r)) s = 89;
  else if (/核心/.test(r)) s = 87;
  else if (/自研|量产|突破|送样/.test(r)) s = 78;
  else if (/验证|布局|小产线|切入|配套/.test(r)) s = 66;
  return s;
}

/**
 * 产品级语义匹配：把自然语言与 SEMANTIC_PRODUCTS 的产品/技术别名比对。
 * 命中后作为候选种子 + 段名匹配补充，最终仍由主营构成营收占比计算相关度。
 * @param {string} ql 已转小写的查询串
 * @returns {object|null}
 */
function matchProduct(ql) {
  for (const p of SEMANTIC_PRODUCTS) {
    for (const a of p.aliases) {
      if (ql.includes(a.toLowerCase())) return p;
    }
  }
  return null;
}

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
    // 【关键修复】腾讯历史K线接口 param=...,day,,,n, 返回的是「最近 n 个交易日」，
    // 并非按 start/end 日期区间截取。旧实现只用「目标日前10天~后5天」窄窗口，经 _barCount
    // 地板值后只取回最近的 ~320 根（约到 2025 年中），远够不到 2024-09-24，导致 get924Price
    // 永远取不到价、924涨跌字段长期空白。现按「目标日 → 今天」真实跨度申请足够根数
    // （腾讯优先，东财兜底），确保覆盖目标日；根数上限 800（腾讯对过大根数会返回空）。
    const spanDays = Math.ceil((Date.now() - d.getTime()) / 86400000) + 30; // 留 30 天冗余
    const count = Math.min(800, Math.max(320, Math.ceil(spanDays * 7 / 5) + 20));
    const start = this.fmtDate(this._addDays(d, -20));
    const end = this.fmtDate(new Date());
    let data = await this.getKline(code, start, end, count);
    // 根数不足未覆盖到目标日时，加大根数重试一次（沿用能覆盖更早日期的结果）
    if (data && data.length && data[0].date > date) {
      try {
        const more = await this.getKline(code, start, end, 1600);
        if (more && more.length && more[0].date < data[0].date) data = more;
      } catch (e) { /* 重试失败则沿用原数据 */ }
    }
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

  // 腾讯历史日K线（免费、无需鉴权；响应带 Access-Control-Allow-Origin:*，
  // 浏览器简单 fetch 即可直连，无需 JSONP）。返回 data[code].day = [日期,开,收,高,低,量]。
  //
  // 【重要】实测：该接口在「带复权参数(qfq/bfq)」或「带显式日期区间」时常返回空数据，
  // 只有形如  param={code},day,,,{根数},   （日期区间留空、复权留空）才稳定返回，
  // 语义为「最近 N 个交易日」，不复权真实价 —— 正合计算今年高低价/年初价/924价之需。
  // 多节点轮换，任一成功即用。
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
    const sym = market + pure;
    // 根数需覆盖区间交易日数：两年约 480 根，320 会截断导致算不出年初价/924价
    const n = count || this._barCount(startDate, endDate);
    const nodes = [
      'https://web.ifzq.gtimg.cn/appstock/app/kline/kline',
      'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/kline/kline'
    ];
    for (const base of nodes) {
      try {
        const url = `${base}?param=${sym},day,,,${n},`;
        const resp = await fetch(url, { cache: 'no-store' });
        if (!resp.ok) continue;
        const j = await resp.json();
        const node = j && j.data && j.data[sym];
        const arr = node && (node.day || node.bfqday || node.qfqday);
        if (!arr || !arr.length) continue;
        const out = [];
        for (const r of arr) {
          const date = r[0];
          const close = parseFloat(r[2]);
          if (!date || isNaN(close)) continue;
          out.push({ date, open: parseFloat(r[1]), close, high: parseFloat(r[3]), low: parseFloat(r[4]), volume: parseFloat(r[5]) });
        }
        if (out.length) return out;
      } catch (e) {
        console.debug('腾讯K线节点失败', base, code, e && e.message);
      }
    }
    return [];
  },

  /**
   * 获取日K线（不复权）。
   * 【数据源顺序】用户反馈东财在其网络下不可用（「东财失败」），而腾讯行情
   * （qt.gtimg.cn，本文件实时行情所用）可正常访问，且腾讯历史K线免费、CORS 开放。
   * 故改为：**腾讯优先**，东财仅作兜底。
   * @returns {Array<{date,open,close,high,low,volume}>}
   */
  async getKline(code, startDate, endDate, count) {
    // 1) 腾讯历史日K线（免费、CORS 开放、浏览器直连）
    try {
      const bars = await this._tencentKline(code, startDate, endDate, count);
      if (bars && bars.length) return bars;
    } catch (e) {
      console.debug('腾讯K线失败，尝试东财兜底', code, e);
    }
    // 2) 兜底：东财日K线（klt=101 日线，fqt=0 不复权真实价；必须带 ut 否则返回空）
    const secid = this.toEastSecid(code);
    const beg = String(startDate || '').replace(/-/g, '');
    const end = String(endDate || '').replace(/-/g, '');
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
      console.debug('东财K线亦失败', code, e);
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
   * 获取某板块的成分股数量（单请求取 total，用于「热度」统计，避免逐页拉取）。
   * @param {string} bk 板块代码 BKxxxx
   * @returns {Promise<number>}
   */
  async getSectorStockCount(bk) {
    try {
      const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=1&po=1&np=1&fltt=2&invt=2&fid=f20&fs=b%3A${bk}&fields=f12`;
      const json = await this._eastFetch(url);
      const total = json && json.data && json.data.total;
      return total != null ? total : 0;
    } catch (e) {
      return 0;
    }
  },

  /**
   * 反推业务：输入一只股票（代码或名称），反推出它的主营构成中各个业务/产品的
   * 营收占比（相关度），并对每个业务映射其所属东财板块、统计该板块成分股数量作为「热度」。
   *
   * 「热度」定义（按用户要求：业务在本业务名称股票中的热度）
   *   = 该业务对应东财板块的成分股数量（股票数越多 → 同业公司越多 / 竞争越充分）。
   *
   * @param {string} input 股票代码或名称，如 掌阅科技 / 603533 / sh603533
   * @returns {Promise<{ok,name,code,segments:[{name,ratio,relevance,heat,boardNames}],error}>}
   */
  async reverseBusiness(input) {
    const kw = String(input || '').trim();
    if (!kw) return { ok: false, error: '请输入股票代码或名称，如：掌阅科技 / 603533' };

    // 1) 解析股票代码（纯代码直用；名称走腾讯联想接口解析）
    let code = '', name = '';
    if (/^\d{4,8}$/.test(kw) || /^(sh|sz|bj)\d{4,8}$/i.test(kw)) {
      code = this.inferPrefix(kw);
    } else {
      try {
        const hints = await this.searchStocks(kw);
        const hit = hints.find(h => h.name === kw) || (hints.length ? hints[0] : null);
        if (hit) { code = hit.code; name = hit.name; }
      } catch (e) { /* ignore */ }
    }
    if (!code) return { ok: false, error: `未找到股票「${kw}」，请确认代码或名称（如 603533 / 掌阅科技）` };

    // 2) 拉取主营构成
    let mb = null;
    try { mb = await this.getMainBusiness(code); } catch (e) { mb = null; }
    if (!mb || !mb.length) {
      return { ok: false, error: `未能获取「${name || code}」的主营构成（东财 F10 暂无可用的主营构成数据）` };
    }

    // 3) 全量板块（用于业务→板块映射），并逐业务统计热度
    const allBoards = await this.getAllSectors();
    const topSegs = mb.slice(0, 8); // 仅前 8 项业务计算热度，控制请求数
    const heatArr = await mapLimit(topSegs, 3, async (seg) => {
      const boards = this._matchSegmentBoards(seg.name, allBoards);
      let heat = 0; const boardNames = [];
      if (boards.length) {
        try { heat = await this.getSectorStockCount(boards[0].bk); } catch (e) { heat = 0; }
        boards.slice(0, 3).forEach(b => boardNames.push(b.name));
      }
      return { heat, boardNames };
    });

    // 4) 组装结果：相关度 = 该业务占营收比例（%）。注意 MBI_RATIO 为小数(0.x)，需 ×100 转为百分比，
    //    与 revenueRelevance 的口径一致（如 0.387 → 38.7%）。
    const segments = mb.map((seg, i) => {
      const h = i < heatArr.length ? heatArr[i] : { heat: 0, boardNames: [] };
      const ratio = Math.round(seg.ratio * 1000) / 10;
      return { name: seg.name, ratio, relevance: ratio, heat: h.heat, boardNames: h.boardNames };
    });
    segments.sort((a, b) => (b.relevance - a.relevance) || (b.heat - a.heat));

    return { ok: true, name: name || code, code, segments };
  },

  /**
   * 业务段名 → 板块映射的常见同义词扩展（段名抽词后，再补充这些同义词作为候选匹配词，
   * 提升「版权→知识产权」「数字阅读→出版」等不易直接字面值匹配的命中率）。
   */
  _SEG_SYNONYMS: {
    '版权': ['知识产权', '版权'],
    '数字阅读': ['在线阅读', '数字出版', '出版'],
    '短剧': ['短剧', '互动游戏', '影视'],
    '网络文学': ['网文', '文学', '出版'],
    '内容': ['内容', '传媒'],
    'AI': ['人工智能', 'AI'],
    '大模型': ['大模型', '人工智能'],
    '安全': ['安全', '网络安全']
  },

  /**
   * 把主营构成段名映射到东财板块（取名称最相关的前几个）。
   * 做法：从段名抽取关键词（清洗通用后缀 + 中文 2~3 字 n-gram + 英文整词），
   * 在所有板块名中做子串匹配，按 semanticNameScore 取最相关者。
   * @param {string} segName 主营构成段名
   * @param {Array} allBoards 全量板块
   * @returns {Array<{bk,name,type}>}
   */
  _matchSegmentBoards(segName, allBoards) {
    let clean = String(segName || '')
      .replace(/[（(].*?[)）]/g, '')
      .replace(/(业务|产品|收入|及其他|其他|分部|板块|类|系列|相关|服务|销售|生产|制造|经营|业务群|业务线|产品类|合计|小计|业务板块)\s*$/g, '')
      .replace(/(及|与|和|与及).*$/, '')
      .trim();
    const cands = new Set([clean, String(segName || '')]);
    const cn = clean.match(/[一-龥]+/g) || [];
    cn.forEach(run => {
      if (run.length <= 4) cands.add(run);
      for (let n = 2; n <= 3; n++) {
        for (let i = 0; i + n <= run.length; i++) cands.add(run.slice(i, i + n));
      }
      // 同义词扩展
      for (const k of Object.keys(this._SEG_SYNONYMS)) {
        if (run.includes(k)) (this._SEG_SYNONYMS[k] || []).forEach(s => cands.add(s));
      }
    });
    (clean.toLowerCase().match(/[a-z0-9]{2,}/g) || []).forEach(t => cands.add(t));

    const hits = [];
    for (const b of allBoards) {
      const bn = b.name.toLowerCase();
      let best = 0;
      for (const c of cands) {
        if (!c || c.length < 2) continue;
        const cl = c.toLowerCase();
        if (bn.includes(cl)) {
          const s = semanticNameScore(b.name, c);
          if (s > best) best = s;
        }
      }
      if (best > 0) hits.push({ b, score: best });
    }
    hits.sort((x, y) => y.score - x.score);
    return hits.slice(0, 3).map(x => x.b);
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
    const out = {
      yearStartPrice: null, price924: null, yearHighPrice: null, yearLowPrice: null,
      weekAgoClose: null, monthAgoClose: null
    };
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
    // 腾讯接口语义为「最近 N 个交易日」，若根数不足导致未覆盖到 924，则加大根数重试一次
    if (data.length && data[0].date > start) {
      try {
        const more = await this.getKline(code, start, end, 1600);
        if (more && more.length && more[0].date < data[0].date) data = more;
      } catch (e) { /* 重试失败则沿用原数据 */ }
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
    // 一周前 / 一月前收盘价（用于「一周涨跌 / 一月涨跌」）：按交易日回溯 5 / 20 根
    const back = (n) => {
      const i = data.length - 1 - n;
      if (i < 0) return null;
      const c = data[i].close;
      return (c != null && !isNaN(c) && c) ? c : null;
    };
    out.weekAgoClose = back(5);
    out.monthAgoClose = back(20);
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

  /**
   * 获取某板块成分股（含总市值，用于语义搜索的"核心/龙头"排序）
   * @param {string} bk 板块代码，如 BK0896
   * @param {number} maxPages 最多翻几页（默认 15，单页 100 条）
   * @returns {Promise<Array<{code,name,price,changePercent,marketCap}>>}
   */
  async getSectorStocksMeta(bk, maxPages = 15) {
    const all = [];
    for (let pn = 1; pn <= maxPages; pn++) {
      const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=${pn}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f20&fs=b%3A${bk}&fields=f12,f14,f3,f2,f20`;
      const json = await this._eastFetch(url);
      const diff = this._diffArray(json);
      for (const it of diff) {
        const pure = String(it.f12);
        const prefix = /^(6|9|4|8)/.test(pure) ? 'sh' : 'sz';
        all.push({
          code: prefix + pure,
          name: it.f14 || '',
          price: it.f2 != null ? parseFloat(it.f2) : null,
          changePercent: it.f3 != null ? parseFloat(it.f3) : null,
          marketCap: it.f20 != null ? parseFloat(it.f20) : null  // 总市值（元）
        });
      }
      const total = json && json.data && json.data.total;
      if (!diff.length || all.length >= total) break;
      await new Promise(r => setTimeout(r, 300));
    }
    return all;
  },

  /**
   * AI 语义选股：把自然语言描述解析为"概念 + 修饰"，交叉匹配板块成分股，
   * 返回可直接展示的股票列表。纯前端、免费、无需后端 / API Key。
   *
   * 示例：「主营为ai安全的核心上市公司」
   *   → 识别概念 [人工智能, 安全]
   *   → 取「同时属于 AI 板块 与 安全板块」的公司（概念交集）
   *   → 修饰"核心" → 按总市值降序取前 20 家（代表性核心标的）
   *
   * @param {string} rawQuery 用户自然语言
   * @returns {Promise<{ok,query,concepts,modifiers,method,boards,stocks,error}>}
   */
  /**
   * 营收占比相关度 语义选股引擎（统一入口）。
   * 核心算法：相关度 = 命中语义描述的主营业务/产品段之「营收占比」之和（%）。
   *  - 候选池：命中概念的板块成分股（交集优先，否则按覆盖度截断的并集）；或外部显式板块。
   *  - 逐候选拉取东财 F10 主营构成，命中段营收占比求和即得相关度；相关度=0 的剔除。
   *  - 按相关度降序排序；修饰词「核心」取前 20，「小市值」取市值最小 20 家。
   * @param {object} p
   *  - query, matchers{buildMatchers 结果}, modifiers, seedCodes, productKey, productDesc, productStocks, explicitBoards
   */
  async _revenueSearch({ query, matchers, modifiers, seedCodes = [], productKey = '', productDesc = '', productStocks = [], explicitBoards = null }) {
    const allBoards = await this.getAllSectors();
    let conceptBoardLists;
    if (explicitBoards && explicitBoards.length) {
      conceptBoardLists = [{ canon: '自定义', boards: explicitBoards.map(b => ({ bk: b.bk, name: b.name })) }];
    } else {
      const CAP_PER = 6; // 每概念取名称最相关的前 6 个板块，控制候选规模
      conceptBoardLists = (matchers.concepts || []).map(canon => {
        const c = SEMANTIC_CONCEPTS.find(x => x.canonical === canon);
        const hints = (c && c.hints) || [];
        let boards = allBoards.filter(b => hints.some(h => b.name.toLowerCase().includes(h.toLowerCase())));
        boards.sort((a, b) => semanticNameScore(b.name, canon) - semanticNameScore(a.name, canon));
        return { canon, boards: boards.slice(0, CAP_PER) };
      }).filter(x => x.boards.length);
      // 通用词兜底：没有任何概念命中时，用查询抽取词直接匹配板块名
      if (!conceptBoardLists.length && (matchers.generic || []).length) {
        const boards = allBoards.filter(b => matchers.generic.some(g => b.name.toLowerCase().includes(g)));
        boards.sort((a, b) => b.name.length - a.name.length);
        conceptBoardLists.push({ canon: '通用', boards: boards.slice(0, CAP_PER) });
      }
    }
    const allBoardLists = conceptBoardLists.flatMap(x => x.boards);

    // 1) 拉取成分股，构建候选集合
    const stockInfo = new Map();
    const conceptSets = [];
    for (const { canon, boards } of conceptBoardLists) {
      const set = new Set();
      const lists = await mapLimit(boards, 4, b => this.getSectorStocksMeta(b.bk));
      for (const list of lists) for (const s of list) { set.add(s.code); if (!stockInfo.has(s.code)) stockInfo.set(s.code, s); }
      conceptSets.push(set);
    }
    let resultCodes;
    const coverage = new Map();
    if (conceptSets.length === 1) {
      resultCodes = [...conceptSets[0]];
    } else {
      // 交集优先（同时具备多主题），规模合理时使用；否则按覆盖度截断并集
      let inter = conceptSets[0];
      for (let i = 1; i < conceptSets.length; i++) inter = new Set([...inter].filter(c => conceptSets[i].has(c)));
      conceptSets.forEach(set => set.forEach(c => coverage.set(c, (coverage.get(c) || 0) + 1)));
      if (inter.size >= 5 && inter.size <= 400) {
        resultCodes = [...inter];
      } else {
        resultCodes = [...coverage.keys()].sort((a, b) => (coverage.get(b) || 0) - (coverage.get(a) || 0));
      }
    }
    // 产品库种子直接纳入候选
    seedCodes.forEach(c => { if (!stockInfo.has(c)) stockInfo.set(c, { code: c, name: c }); resultCodes.push(c); });
    // 候选截断上限（控制主营构成请求数量）
    const CAND_CAP = explicitBoards && explicitBoards.length ? 250 : 160;
    if (resultCodes.length > CAND_CAP) {
      if (coverage.size) resultCodes.sort((a, b) => (coverage.get(b) || 0) - (coverage.get(a) || 0));
      resultCodes = resultCodes.slice(0, CAND_CAP);
    }
    resultCodes = [...new Set(resultCodes)];

    // 2) 逐候选拉取主营构成，计算营收占比相关度
    const matchersArr = (matchers.segHints || []).map(s => String(s).toLowerCase());
    const roleMap = {};
    productStocks.forEach(s => { roleMap[s.code] = s.role || ''; });
    const raw = await mapLimit(resultCodes, 6, async (code) => {
      const info = stockInfo.get(code) || { code, name: code };
      let mb = null;
      try { mb = await this.getMainBusiness(code); } catch (e) { mb = null; }
      const { relevance, matched } = revenueRelevance(mb, matchersArr);
      return { info, relevance, matched };
    });

    // 3) 过滤相关度>0，补齐行情，组装结果
    const codes2 = raw.filter(x => x.relevance > 0).map(x => x.info.code);
    let quotes = {};
    try { quotes = await this.getQuotes(codes2); } catch (e) { quotes = {}; }
    const buildStock = (x) => {
      const q = quotes[x.info.code] || {};
      const mkt = q.totalMarketCap != null ? q.totalMarketCap * 1e8 : (x.info.marketCap || null);
      return {
        code: x.info.code,
        name: q.name || x.info.name || x.info.code,
        price: q.price != null ? q.price : null,
        changePercent: q.changePercent != null ? q.changePercent : null,
        marketCap: mkt,
        role: '',
        concepts: (matchers.concepts || []).slice(),
        matchedSegments: x.matched,
        relevance: x.relevance
      };
    };
    let stocks = raw.filter(x => x.relevance > 0).map(buildStock);
    // 产品库兜底：主营构成未匹配出细分业务（东财未列明）时，用产业链角色评分保底展示种子公司
    if (productKey && stocks.length === 0) {
      for (const x of raw) {
        if (seedCodes.includes(x.info.code) && x.relevance === 0) {
          const st = buildStock(x);
          st.relevance = scoreRoleRelevance(roleMap[x.info.code] || '');
          st.matchedSegments = [];
          stocks.push(st);
        }
      }
      stocks.sort((a, b) => (b.relevance - a.relevance) || ((b.marketCap || 0) - (a.marketCap || 0)));
    } else {
      stocks.sort((a, b) => (b.relevance - a.relevance) || ((b.marketCap || 0) - (a.marketCap || 0)));
    }
    const TOPN = 20;
    if (modifiers.includes('核心')) stocks = stocks.slice(0, TOPN);
    else if (modifiers.includes('小市值')) {
      stocks = [...stocks].sort((a, b) => (a.marketCap || 0) - (b.marketCap || 0)).slice(0, TOPN)
        .sort((a, b) => (b.relevance - a.relevance) || ((b.marketCap || 0) - (a.marketCap || 0)));
    }
    return {
      ok: true, query,
      concepts: matchers.concepts || [],
      modifiers,
      method: productKey ? 'product' : (explicitBoards && explicitBoards.length ? 'boards' : 'revenue'),
      productKey, productDesc,
      matchers: matchers.segHints || [],
      boards: allBoardLists,
      stocks
    };
  },

  async semanticSearch(rawQuery) {
    const query = String(rawQuery || '').trim();
    if (!query) return { ok: false, error: '请输入描述，如：生产薄膜铌酸锂的企业 / 主营为ai安全的核心上市公司 / ai短剧审核' };
    const ql = query.toLowerCase();
    const modifiers = parseSemanticModifiers(query);
    const matchers = buildMatchers(query);

    // 命中已知产品库：作为候选种子 + 段名匹配补充，最终仍由主营构成营收占比计算相关度
    let seedCodes = [], productKey = '', productDesc = '', productStocks = [];
    const product = matchProduct(ql);
    if (product) {
      seedCodes = product.stocks.map(s => s.code);
      productStocks = product.stocks;
      productKey = product.key;
      productDesc = product.desc;
      const pterms = extractQueryTerms(product.key + ' ' + product.desc);
      pterms.forEach(t => { if (!matchers.segHints.includes(t)) matchers.segHints.push(t); });
      if (!matchers.concepts.length) matchers.concepts.push(product.key);
    }

    if (!matchers.concepts.length && !matchers.generic.length) {
      return {
        ok: false, query, concepts: [], modifiers,
        error: '未识别到已知概念，请尝试：人工智能、ai、安全、芯片、机器人、新能源、医药、军工、短剧、审核、内容安全 等关键词'
      };
    }
    try {
      return await this._revenueSearch({
        query, matchers, modifiers, seedCodes, productKey, productDesc, productStocks
      });
    } catch (e) {
      return { ok: false, query, concepts: matchers.concepts, modifiers, error: 'AI语义筛选失败：' + (e && e.message ? e.message : e) };
    }
  },

  /**
   * 把一个"概念"自然语言解析为其对应的东方财富板块列表。
   * 用于「语义结果编辑」后，根据用户修改后的概念重建命中板块。
   *   - 命中已知概念本体（SEMANTIC_CONCEPTS）：按其 hints 匹配板块并按相关度排序取前 12；
   *   - 未命中本体：按板块名模糊匹配取前 12。
   * @param {string} concept
   * @returns {Promise<Array<{bk,name}>>}
   */
  async resolveConceptToBoards(concept) {
    const c = String(concept || '').trim();
    if (!c) return [];
    const cl = c.toLowerCase();
    const found = SEMANTIC_CONCEPTS.find(x =>
      x.canonical.toLowerCase() === cl ||
      x.aliases.some(a => a.toLowerCase() === cl) ||
      x.aliases.some(a => cl.includes(a.toLowerCase())) ||
      x.hints.some(h => cl.includes(h.toLowerCase()))
    );
    const all = await this.getAllSectors();
    if (found) {
      return all
        .filter(b => found.hints.some(h => b.name.toLowerCase().includes(h.toLowerCase())))
        .sort((a, b) => semanticNameScore(b.name, found.canonical) - semanticNameScore(a.name, found.canonical))
        .slice(0, 12)
        .map(b => ({ bk: b.bk, name: b.name }));
    }
    return all
      .filter(b => b.name.toLowerCase().includes(cl))
      .slice(0, 12)
      .map(b => ({ bk: b.bk, name: b.name }));
  },

  /**
   * 语义结果「重算引擎」：根据当前板块列表 + 修饰词，重新计算符合语义的上市公司。
   * 这是概念/板块增删改之后的核心逻辑：
   *   - 多板块取成分股「交集」= 同时归属这些板块的公司（主业同时符合多个主题）；
   *   - 单板块直接取该板块全部成分股；
   *   - 修饰词：核心/龙头 → 按总市值降序取前 20；小市值 → 升序取前 20；
   *   - 最后补齐腾讯实时行情（现价/涨跌幅/总市值）。
   * @param {{boards:Array<{bk,name}>, modifiers?:string[], concepts?:string[]}} params
   * @returns {Promise<{ok,stocks,method,boards}>}
   */
  async recomputeSemanticStocks({ boards, modifiers = [], concepts = [], matchers = [], productKey = '', productDesc = '' }) {
    if (!boards || !boards.length) return { ok: true, stocks: [], method: 'empty', boards: [] };
    // 优先使用上一次搜索的业务意图(matchers，即营收占比相关度的匹配词)；
    // 否则由 concepts 重建 matchers，保证「编辑概念/板块后重算」仍按主营构成营收占比计算相关度。
    let m;
    if (matchers && matchers.length) {
      m = { concepts: (concepts || []).slice(), segHints: matchers.slice(), generic: [], boardHints: [] };
    } else {
      m = buildMatchers((concepts || []).join(' '));
    }
    try {
      return await this._revenueSearch({
        query: (concepts || []).join('+'),
        matchers: m,
        modifiers,
        seedCodes: [],
        productKey,
        productDesc,
        productStocks: [],
        explicitBoards: boards.map(b => ({ bk: b.bk, name: b.name }))
      });
    } catch (e) {
      return { ok: false, stocks: [], method: 'error', boards: boards.slice(), error: '重算失败：' + (e && e.message ? e.message : e) };
    }
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
