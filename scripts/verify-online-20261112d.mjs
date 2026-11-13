/* ============================================================
 * verify-online-20261112d.mjs
 * 部署后线上复核：GitHub Contents API 读 main 的 5 个文件 + 远端 tip，
 * 再读 GitHub Pages 实际 HTML / app.js / hot-topics.js / auth-boot.js。
 * 用法：node scripts/verify-online-20261112d.mjs
 * ============================================================ */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const token = fs.readFileSync(path.join(ROOT, '_gh_token.txt'), 'utf8').trim();
const OWNER = 'xinwenfuwu', REPO = 'stock-news-tracker';
const API = 'https://api.github.com/repos/' + OWNER + '/' + REPO;
const PAGES = 'https://xinwenfuwu.github.io/stock-news-tracker/';

let pass = 0, fail = 0;
function check(n, c, e) {
  if (c) { pass++; console.log('  \u2713 ' + n); }
  else { fail++; console.log('  \u2717 ' + n + (e !== undefined ? '  \u2192 ' + JSON.stringify(e) : '')); }
}
async function raw(p) {
  const r = await fetch(API + '/contents/' + p + '?ref=main&_=' + Date.now(), {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github.raw', 'User-Agent': 'verify-script', 'Cache-Control': 'no-cache' }
  });
  if (!r.ok) throw new Error(p + ' HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return await r.text();
}
async function pages(p) {
  const r = await fetch(PAGES + p + '?_=' + Date.now(), { headers: { 'Cache-Control': 'no-cache' } });
  return { status: r.status, text: await r.text() };
}

(async () => {
  const [html, app, ht, boot, css] = await Promise.all([
    raw('index.html'), raw('js/app.js'), raw('js/hot-topics.js'), raw('js/auth-boot.js'), raw('css/style.css')
  ]);

  console.log('1) 线上 js/hot-topics.js：同名统一 + 概念级 AI');
  check('unifiedConceptSentiments 已上线并导出',
    /function unifiedConceptSentiments\(rowsByMode, win\)/.test(ht) && /\bunifiedConceptSentiments,/.test(ht));
  check('合并桶去重 + 时间窗硬约束',
    /const k = aiSentiKey\(String\(it\.text \|\| ''\)\) \+ '\|' \+ String\(it\.time \|\| ''\)/.test(ht) &&
    /if \(itemInWin\(it, win\)\) news\.push\(it\)/.test(ht));
  check('概念级标签缓存已上线',
    /const AI_CONCEPT = Object\.create\(null\)/.test(ht) &&
    /function setAiConceptBatch\(entries, winKey\)/.test(ht) &&
    /function getEffectiveAiConceptSenti\(name, winKey\)/.test(ht));
  check('按 概念名 + 时间窗口 建键', /String\(name \|\| ''\) \+ '\\u0001' \+ String\(winKey/.test(ht));
  check('conceptSentiment 优先概念级标签（在战争特例之前）',
    /const aiConcept = getEffectiveAiConceptSenti\(nm\);\s*if \(aiConcept\) return aiConcept;/.test(ht) &&
    ht.indexOf('const aiConcept = getEffectiveAiConceptSenti(nm)') < ht.indexOf('if (isWarTheme(nm))'));
  check('local 模式忽略概念级标签', /if \(SENTIMENT_MODE !== 'ai'\) return null;/.test(ht));
  check('20261112b/c 的油价视角与窗口保险未被破坏',
    /const OIL_BULL = \[/.test(ht) && /function briefStats\(items, mode, win\)/.test(ht) &&
    /function clusterItems\(items, win\)/.test(ht));

  console.log('2) 线上 js/app.js：三栏统一 + 大模型真正生效');
  check('briefWinKey / briefUnified 已上线',
    /const briefWinKey = computed\(/.test(app) && /const briefUnified = computed\(/.test(app));
  check('三栏统一从 briefUnified 取情绪',
    /const base = u\.rowsByMode\[mode\] \|\| \[\]/.test(app) &&
    /sentiment: unified \? unified\.sentiment : c\.sentiment/.test(app));
  check('buildBriefStats(mode) 三处调用',
    (app.match(/buildBriefStats\('(?:theme|concept|industry)'\)/g) || []).length === 3);
  check('runAiConceptSentiment 已上线',
    /async function runAiConceptSentiment\(\)/.test(app) && /function buildAiConceptMessages\(group, uni\)/.test(app));
  check('prompt 要求站在子版块立场、允许方向相反',
    /必须站在【该子版块】立场判断/.test(app) && /同一条新闻对不同板块方向可以相反/.test(app));
  check('setSentimentMode 同模式点击不再直接 return',
    !/if \(mode === sentimentMode\.value\) return;/.test(app) &&
    /const same = mode === sentimentMode\.value;/.test(app) &&
    /if \(same\) clearAiConceptCache\(\);/.test(app));
  check('未配置 AI 明确提示 + 两级缓存重判',
    /尚未配置 AI 接口（偏好设置/.test(app) &&
    /Promise\.all\(\[runAiSentimentBatch\(\), runAiConceptSentiment\(\)\]\)/.test(app));
  check('概念级状态已暴露给模板',
    /aiConceptVersion, aiConceptBusy, aiConceptDone, aiConceptTotal, aiConceptDiff, aiConceptError/.test(app));
  check('20261112c 的最终严格过滤未被破坏',
    /const finalFlat = \(_win && HT\.itemInWin\)/.test(app) && /dayFullyInside/.test(app));

  console.log('3) 线上 index.html / css / auth-boot');
  check('8 处 ?v=20261112d', (html.match(/\?v=20261112d/g) || []).length === 8, (html.match(/\?v=20261112d/g) || []).length);
  check('无 ?v=20261112c 残留', !html.includes('?v=20261112c'));
  check('大模型状态胶囊：未配置 / 失败 / 已判 N 个 / 差异数',
    /未配置 AI · 暂用本地口径/.test(html) && /AI 调用失败 · 暂用本地口径/.test(html) &&
    /已判 \{\{ aiConceptDone \}\} 个子概念/.test(html) && /与本地不同 \{\{ aiConceptDiff \}\}/.test(html));
  check('口径说明已移除（同名子概念统一说明不再显示）', !/同名子概念只有一种市场情绪/.test(html));
  check('入口 HTML 禁缓存仍在', /no-cache, no-store, must-revalidate/.test(html));
  check('跨站重合榜逐条时间仍在', /class="ov-detail-time"/.test(html));
  check('.ai-senti-warn 警示样式已上线', /\.ai-senti-chip\.ai-senti-warn\s*\{/.test(css));
  check('ASSET_V = 20261112d', /var ASSET_V = '20261112d';/.test(boot));
  check('运行时版本自检仍在', /function checkAssetVersion\(\)/.test(boot) && /checkAssetVersion\(\);/.test(boot));

  console.log('4) 远端 main tip');
  const ref = await (await fetch(API + '/git/refs/heads/main', { headers: { Authorization: 'Bearer ' + token, 'User-Agent': 'verify-script' } })).json();
  const cm = await (await fetch(API + '/git/commits/' + ref.object.sha, { headers: { Authorization: 'Bearer ' + token, 'User-Agent': 'verify-script' } })).json();
  check('main tip 是 20261112d 提交', /20261112d/.test(cm.message || ''), [ref.object.sha.slice(0, 12), (cm.message || '').slice(0, 60)]);
  check('main tip = a1fe755808fb', String(ref.object.sha).startsWith('a1fe755808fb'), ref.object.sha);

  console.log('5) GitHub Pages 实际资源（构建轮询，最多 8 次）');
  let live = null, appLive = null, htLive = null, bootLive = null;
  for (let i = 0; i < 8; i++) {
    const r = await pages('');
    if (r.status === 200 && r.text.includes('?v=20261112d')) { live = r.text; break; }
    await new Promise(res => setTimeout(res, 5000));
  }
  check('Pages 返回 200', !!live, live ? live.length : 'no fresh html');
  if (live) {
    check('Pages HTML 已是 20261112d 缓存戳', live.includes('?v=20261112d'), (live.match(/\?v=\d{8}[a-z]/g) || []).slice(0, 3));
    check('Pages 已移除同名子概念统一口径说明', !live.includes('同名子概念只有一种市场情绪'));
    check('Pages 含大模型状态胶囊', live.includes('ai-senti-warn') && live.includes('aiConceptDiff'));
  }
  try {
    appLive = (await pages('js/app.js')).text;
    htLive = (await pages('js/hot-topics.js')).text;
    bootLive = (await pages('js/auth-boot.js')).text;
  } catch (e) { /* 下面断言会失败 */ }
  check('Pages app.js 含 runAiConceptSentiment', !!appLive && appLive.includes('runAiConceptSentiment'), !!appLive);
  check('Pages hot-topics.js 含 unifiedConceptSentiments', !!htLive && htLive.includes('unifiedConceptSentiments'), !!htLive);
  check('Pages auth-boot.js 已是 20261112d', !!bootLive && /ASSET_V = '20261112d'/.test(bootLive), !!bootLive);

  console.log(`\n\u7ed3\u679c\uff1a${pass} \u901a\u8fc7 / ${fail} \u5931\u8d25`);
  if (fail) process.exit(1);
})().catch(e => { console.error('VERIFY ERROR', e); process.exit(1); });
