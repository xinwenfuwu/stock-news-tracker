// 20261019a：用户管理顶部「🔄 刷新」按钮（位于「从云端恢复」左侧）回归测试。
// 验证：① 按钮绑定 refreshUserManagement；② 该函数从云端注册表只读合并（recoverFromRegistry）；
// ③ 刷新账号表分类（审核通过区 / 授权免费试用）；④ refreshingUm 状态位存在。
// 采用与项目其它 app.js 测试一致的「源码字面接线」断言风格。
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const app = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  => ' + extra : '')); }
}

console.log('=== test-um-refresh (20261019a) ===');

check('app.js 定义 refreshUserManagement 函数', /async function refreshUserManagement\(\)/.test(app));
check('app.js refreshUserManagement 调用 recoverFromRegistry（只读合并云端注册账号）',
  /async function refreshUserManagement\(\)[\s\S]{0,1200}A\.recoverFromRegistry/.test(app));
check('app.js refreshUserManagement 刷新账号表（重算审核通过区/免费试用分类）',
  /async function refreshUserManagement\(\)[\s\S]{0,1400}refreshUserList\(\)/.test(app));
check('app.js refreshUserManagement 含明确回执（新并入 N 个云端注册账号）',
  /已刷新：新并入 '\s*\+\s*merged\s*\+\s*' 个云端注册账号/.test(app) ||
  /已刷新：新并入/.test(app));
check('app.js 定义 refreshingUm 状态位', /const refreshingUm = ref\(false\)/.test(app));

check('index.html 在「从云端恢复」左侧放置「🔄 刷新」按钮', (() => {
  const i1 = html.indexOf('@click="refreshUserManagement"');
  const i2 = html.indexOf('@click="recoverUsersByAdmin"');
  return i1 >= 0 && i2 >= 0 && i1 < i2;
})());
check('index.html 刷新按钮绑定 refreshingUm（刷新中状态切换）',
  /@click="refreshUserManagement"[^>]*:disabled="refreshingUm"/.test(html) ||
  /:disabled="refreshingUm"[^>]*@click="refreshUserManagement"/.test(html));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
