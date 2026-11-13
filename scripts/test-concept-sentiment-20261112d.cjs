/* ============================================================
 * test-concept-sentiment-20261112d.cjs
 * 确定性测试：
 *  ① 同名子概念（半导体）在题材/概念/行业三栏统一为一种市场情绪
 *  ② 概念级 AI 标签按「概念名 + 时间窗口」缓存、覆盖硬编码特例、local 模式忽略
 *  ③ 「🤖 大模型」按钮同模式点击也会真正发起判定（修掉点了没反应）
 *  ④ 设定时间窗外的 / 无精确时间的新闻仍被排除
 * 用法：node scripts/test-concept-sentiment-20261112d.cjs
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const HT = require(path.join(ROOT, 'js/hot-topics.js'));
const app = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
const htSrc = fs.readFileSync(path.join(ROOT, 'js/hot-topics.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const boot = fs.readFileSync(path.join(ROOT, 'js/auth-boot.js'), 'utf8');

let pass = 0, fail = 0;
function check(n, c, extra) {
  if (c) { pass++; console.log('  OK  ' + n); }
  else { fail++; console.log('  FAIL ' + n + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}
const WS = HT.parseBriefTime('2026-11-12 15:00');
const WE = HT.parseBriefTime('2026-11-13 15:00');
const WIN = { startMs: WS, endMs: WE };
const T = (time, text) => ({ time: time, text: text });
const BEAR = [
  T('2026-11-12 16:00', '半导体板块大跌，需求下滑，芯片公司业绩亏损，机构下调评级'),
  T('2026-11-12 16:10', '存储芯片价格下跌，晶圆厂订单萎缩，半导体设备需求走弱'),
  T('2026-11-12 16:20', '美股半导体股集体下跌，英伟达暴跌，产业链承压')
];
const BULL = [
  T('2026-11-12 16:30', '中芯国际营收增长，净利润大增，业绩超预期，机构上调目标价'),
  T('2026-11-12 16:40', '台积电扩产，半导体设备订单饱满，晶圆供不应求，量价齐升'),
  T('2026-11-12 16:50', '科创半导体ETF资金大幅流入，板块上涨，创历史新高')
];
const BULL2 = [
  T('2026-11-12 17:00', '半导体设备中标，产能扩张，盈利预喜'),
  T('2026-11-12 17:10', '芯片供不应求，订单饱满，营收增长')
];

console.log('1) 源码结构：同名子概念统一裁决');
check('hot-topics 定义并导出 unifiedConceptSentiments',
  /function unifiedConceptSentiments\(rowsByMode, win\)/.test(htSrc) && /\bunifiedConceptSentiments,/.test(htSrc));
check('合并按名字 + 正文/时间去重', /const k = aiSentiKey\(String\(it\.text \|\| ''\)\) \+ '\|' \+ String\(it\.time \|\| ''\)/.test(htSrc));
check('合并后只裁决一次', /sentiment: conceptSentiment\(name, news\)/.test(htSrc));
check('合并桶受时间窗硬约束', /if \(itemInWin\(it, win\)\) news\.push\(it\)/.test(htSrc));
check('app.js 定义 briefUnified / briefWinKey',
  /const briefWinKey = computed\(/.test(app) && /const briefUnified = computed\(/.test(app));
check('briefUnified 一次算完三套维度', /for \(const mode of \['theme', 'concept', 'industry'\]\)/.test(app));
check('buildBriefStats 改为按 mode 取统一结果',
  /function buildBriefStats\(mode\)/.test(app) && /const base = u\.rowsByMode\[mode\] \|\| \[\]/.test(app));
check('三栏 computed 都走统一情绪',
  /const briefThemeStats = computed\(\(\) => buildBriefStats\('theme'\)\)/.test(app) &&
  /const briefConceptStats = computed\(\(\) => buildBriefStats\('concept'\)\)/.test(app) &&
  /const briefIndustryStats = computed\(\(\) => buildBriefStats\('industry'\)\)/.test(app));
check('enrich 时用统一 sentiment 覆盖', /sentiment: unified \? unified\.sentiment : c\.sentiment/.test(app));

console.log('2) 源码结构：概念级 AI 判定');
check('新增概念级标签缓存与读写',
  /const AI_CONCEPT = Object\.create\(null\)/.test(htSrc) &&
  /function setAiConceptBatch\(entries, winKey\)/.test(htSrc) &&
  /function getEffectiveAiConceptSenti\(name, winKey\)/.test(htSrc));
check('按 概念名 + 窗口 建键', /String\(name \|\| ''\) \+ '\\u0001' \+ String\(winKey/.test(htSrc));
check('local 模式忽略概念级标签', /if \(SENTIMENT_MODE !== 'ai'\) return null;/.test(htSrc));
check('conceptSentiment 优先概念级标签（在特例之前）',
  /const aiConcept = getEffectiveAiConceptSenti\(nm\);\s*if \(aiConcept\) return aiConcept;/.test(htSrc) &&
  htSrc.indexOf('const aiConcept = getEffectiveAiConceptSenti(nm)') < htSrc.indexOf('if (isWarTheme(nm))'));
check('app.js 定义 runAiConceptSentiment 与 prompt',
  /async function runAiConceptSentiment\(\)/.test(app) && /function buildAiConceptMessages\(group, uni\)/.test(app));
check('prompt 明确要求站在子版块立场、允许方向相反',
  /必须站在【该子版块】立场判断/.test(app) && /同一条新闻对不同板块方向可以相反/.test(app));
check('setSentimentMode 同模式点击不再直接 return',
  !/if \(mode === sentimentMode\.value\) return;/.test(app) &&
  /const same = mode === sentimentMode\.value;/.test(app) &&
  /runAiConceptSentiment\(\)\.catch/.test(app));
check('未配置 AI 时给出明确提示', /尚未配置 AI 接口（偏好设置/.test(app));
check('状态胶囊可见（含差异数 / 未配置 / 失败）',
  /ai-senti-warn/.test(html) && /未配置 AI · 暂用本地口径/.test(html) &&
  /与本地不同 \{\{ aiConceptDiff \}\}/.test(html) && /AI 调用失败 · 暂用本地口径/.test(html));
check('rerunAiSentiment 同时清两级缓存并重跑',
  /clearAiSentimentCache\(\);\s*clearAiConceptCache\(\);/.test(app) &&
  /Promise\.all\(\[runAiSentimentBatch\(\), runAiConceptSentiment\(\)\]\)/.test(app));

console.log('3) 行为：三栏同名概念统一为一种情绪');
HT.setSentimentMode('local');
HT.clearAiConcept();
const rowsByMode = {
  theme: [{ key: 't_半导体', name: '半导体', news: BEAR.slice() }],
  concept: [{ key: 'c_011', name: '半导体', news: BULL.slice() }],
  industry: [{ key: 'i_053', name: '半导体', news: BULL2.slice() }]
};
check('旧口径下题材桶 = bear（绿）', HT.computeCategorySentiment(BEAR) === 'bear', HT.computeCategorySentiment(BEAR));
check('旧口径下概念桶 = bull（红）→ 复现「两种市场情绪」',
  HT.computeCategorySentiment(BULL) === 'bull', HT.computeCategorySentiment(BULL));
const uni = HT.unifiedConceptSentiments(rowsByMode, WIN);
check('统一后只有一个 半导体 裁决', Object.keys(uni).length === 1 && !!uni['半导体'], Object.keys(uni));
check('合并新闻 = 8 条（3+3+2）', uni['半导体'].count === 8, uni['半导体'].count);
check('统一裁决 bull = 5 / bear = 3 → bull（红）', uni['半导体'].sentiment === 'bull', uni['半导体'].sentiment);
const dup = HT.unifiedConceptSentiments({
  theme: [{ name: '半导体', news: [BEAR[0]] }],
  concept: [{ name: '半导体', news: [BEAR[0]] }]
}, WIN);
check('同一条新闻跨维度只算一次', dup['半导体'].count === 1, dup['半导体'].count);
const outside = HT.unifiedConceptSentiments({
  theme: [{ name: '半导体', news: [BEAR[0], T('2026-11-11 09:00', '半导体板块大跌，需求下滑，业绩亏损'), T('', '半导体板块大跌')] }]
}, WIN);
check('窗口外 / 无精确时间的新闻不进合并桶', outside['半导体'].count === 1, outside['半导体'].count);

console.log('4) 行为：概念级 AI 标签');
HT.setSentimentMode('ai');
HT.setAiConceptWindow('W1');
HT.setAiConceptBatch([
  { name: '半导体', sentiment: 'bear' },
  { name: '军事战争', sentiment: 'bear' },
  { name: '石油', sentiment: 'bull' }
], 'W1');
check('AI 概念标签覆盖本地多数裁决', HT.conceptSentiment('半导体', BULL) === 'bear', HT.conceptSentiment('半导体', BULL));
check('AI 概念标签覆盖战争视角硬编码特例',
  HT.conceptSentiment('军事战争', [T('2026-11-12 16:00', '冲突升级，双方增兵，局势紧张')]) === 'bear');
check('AI 概念标签覆盖油价视角硬编码特例',
  HT.conceptSentiment('石油', [T('2026-11-12 16:00', '油价下跌，需求下调，预计降价')]) === 'bull');
check('aiConceptCount = 3（含导出/导入键）', HT.aiConceptCount() === 3, HT.aiConceptCount());
const exported = HT.exportAiConcept();
HT.clearAiConcept();
HT.importAiConcept(exported);
check('导出 / 导入往返后标签仍生效',
  HT.getEffectiveAiConceptSenti('半导体', 'W1') === 'bear' && HT.aiConceptCount() === 3);
HT.setSentimentMode('local');
check('切「纯本地」后概念级标签被忽略',
  HT.getEffectiveAiConceptSenti('半导体', 'W1') === null &&
  HT.conceptSentiment('半导体', BULL) === 'bull', HT.conceptSentiment('半导体', BULL));
HT.setSentimentMode('ai');
check('切回「大模型」复用缓存', HT.conceptSentiment('半导体', BULL) === 'bear');
HT.setAiConceptWindow('W2');
check('换时间窗口后旧标签不串用（自动回退本地裁决）',
  HT.getEffectiveAiConceptSenti('半导体') === null && HT.conceptSentiment('半导体', BULL) === 'bull',
  HT.conceptSentiment('半导体', BULL));
HT.setAiConceptWindow('W1');
HT.clearAiConcept();

console.log('5) 版本戳（统一与 auth-boot.js 的 ASSET_V 对齐，不写死具体版本，后续发版不再误报）');
const curV = (/var ASSET_V = '([^']+)'/.exec(boot) || [])[1] || '';
check('auth-boot ASSET_V 可解析', /^\d{8}[a-z]$/.test(curV), curV);
const allV = html.match(/\?v=\d{8}[a-z]/g) || [];
check('index.html 8 处 ?v= 全部与 ASSET_V 一致',
  allV.length === 8 && allV.every(v => v === '?v=' + curV), { curV, allV });
check('口径说明已移除（子类统计口径 block 不再显示）',
  !/(?:只统计上方时间段内|石油 \/ 原油类按「油价方向|同名子概念只有一种市场情绪|选「大模型」时按<b>概念名)/.test(html));

console.log('\n结果：' + pass + '/' + (pass + fail) + ' 通过');
if (fail) process.exitCode = 1;
