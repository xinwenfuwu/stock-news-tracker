// 20261019b：明文密码云端可见（用户已两次明确接受「注册表为公开文件，sealed 密码等同明文暴露」）。
// 验证全部「云端写路径」都把可还原密码 seal（pwSeal）透传，且 recoverFromRegistry 合并回本机，
// 使管理员点「🔄 刷新」后可在用户管理面板查看/复制任意注册用户（及管理员重置）的明文密码。
// 采用与项目其它测试一致的「源码字面接线」断言风格。
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const auth = fs.readFileSync(path.join(ROOT, 'js/auth.js'), 'utf8');
const sync = fs.readFileSync(path.join(ROOT, 'js/auth-sync.js'), 'utf8');
const worker = fs.readFileSync(path.join(ROOT, 'cloudflare-worker-prod/worker.js'), 'utf8');

// 提取函数体（兼容 `function NAME(` 声明 与 `NAME: function (` 方法两种写法），
// 从 `{` 起按花括号配对到配平。
function fnBody(src, name) {
  let start = src.indexOf('function ' + name + '(');
  if (start < 0) start = src.indexOf(name + ': function (');
  if (start < 0) start = src.indexOf(name + ' = function (');
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(open + 1, i); }
  }
  return null;
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  => ' + extra : '')); }
}

const buildRegistryRecord = fnBody(auth, 'buildRegistryRecord');
const recoverFromRegistry = fnBody(auth, 'recoverFromRegistry');
const writeUser = fnBody(sync, 'writeUser');
const registerRemoteViaWorker = fnBody(sync, 'registerRemoteViaWorker');
const adminResetRemoteViaWorker = fnBody(sync, 'adminResetRemoteViaWorker');
const authRegister = fnBody(worker, 'authRegister');
const authAdminReset = fnBody(worker, 'authAdminReset');

console.log('=== test-pwseal-cloud (20261019b) ===');

// ① 前端 buildRegistryRecord（令牌直写路径）携带 pwSeal
check('auth.js buildRegistryRecord 透传 pwSeal（令牌直写路径）',
  !!buildRegistryRecord && /pwSeal:\s*u\.pwSeal\s*\|\|\s*''/.test(buildRegistryRecord));

// ② auth-sync writeUser（令牌路径 registerRemote/approveRemote/disableRemote 共用）携带 pwSeal，且不覆盖云端已有值
check('auth-sync.js writeUser 透传 pwSeal（保留云端已有值）',
  !!writeUser && /pwSeal:\s*\(record\.pwSeal\s*\|\|\s*\(reg\.accounts\[uname\][\s\S]{0,90}pwSeal\)/.test(writeUser));

// ③ auth-sync registerRemoteViaWorker（无令牌设备 → Worker /auth/register 代写）payload 携带 pwSeal
check('auth-sync.js registerRemoteViaWorker payload 透传 pwSeal（无令牌代写路径）',
  !!registerRemoteViaWorker && /pwSeal:\s*\(typeof acct\.pwSeal === 'string' && acct\.pwSeal\) \? acct\.pwSeal : ''/.test(registerRemoteViaWorker));

// ④ Worker authRegister 主记录携带 pwSeal（保留已有值）
check('worker.js authRegister 主记录透传 pwSeal（保留云端已有值）',
  !!authRegister && /pwSeal:\s*\(typeof body\.pwSeal === 'string' && body\.pwSeal\) \? body\.pwSeal : \(\(exist && exist\.pwSeal\) \|\| ''\)/.test(authRegister));

// ⑤ auth.js recoverFromRegistry 合并云端账号时把 pwSeal 合回本机（管理员刷新后 hasPassword=true → 面板可显示/复制）
check('auth.js recoverFromRegistry 合并 pwSeal 回本机账号',
  !!recoverFromRegistry && /pwSeal:\s*\(typeof a\.pwSeal === 'string' && a\.pwSeal\) \? a\.pwSeal : ''/.test(recoverFromRegistry));

// ⑥ auth-sync adminResetRemoteViaWorker（管理员重置密码 → Worker /auth/admin-reset）payload 携带 pwSeal
check('auth-sync.js adminResetRemoteViaWorker payload 透传 pwSeal（管理员重置路径）',
  !!adminResetRemoteViaWorker && /pwSeal:\s*\(typeof acct\.pwSeal === 'string' && acct\.pwSeal\) \? acct\.pwSeal : ''/.test(adminResetRemoteViaWorker));

// ⑦ Worker authAdminReset 在携带 pwSeal 时落云端（用户已接受公开暴露）
check('worker.js authAdminReset 存储携带的 pwSeal',
  !!authAdminReset && /if \(typeof body\.pwSeal === 'string' && body\.pwSeal\) exist\.pwSeal = body\.pwSeal/.test(authAdminReset));

// ⑧ 版本号已升 20261019e（index.html 与 auth-boot.js）
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const boot = fs.readFileSync(path.join(ROOT, 'js/auth-boot.js'), 'utf8');
check('index.html 版本号升 20261019e', (html.match(/v=20261019e/g) || []).length >= 6);
check('auth-boot.js ASSET_V 升 20261019e', /var ASSET_V = '20261019e'/.test(boot));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
