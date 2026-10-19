// 20261019c 回归测试：
// ① 「授权免费试用（非支付会员用户）」改名为「试用非会员」（index.html 用户可见标签 + app.js 分类 label）；
// ② 管理员「普通用户注册」入口（addUser）建出的账号默认带 1 天试用（trialUntil），归入试用非会员；
// ③ recoverFromRegistry 合并云端时用权威 trialUntil/payMembershipUntil 刷新本机同名账号（不覆盖密码/角色/状态）；
// ④ refreshUserManagement（🔄 刷新）在拉取云端后，把本机独有/不一致账号推上云端（saveUsersToRegistry）。
// 采用静态源码检查（与项目其余测试风格一致），无需浏览器。
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

const html = read('index.html');
const app = read('js/app.js');
const auth = read('js/auth.js');

// ① 改名：旧名应完全消失于用户可见标签；新名应出现
check('index.html 不再含旧名「授权免费试用（非支付会员用户）」',
  !html.includes('授权免费试用（非支付会员用户）'));
check('index.html 含新名「试用非会员」', html.includes('试用非会员'));
check('app.js adminClassify 分类 label 改为「试用非会员」',
  /label:\s*'试用非会员'/.test(app));

// ② addUser 默认赠送 1 天试用（trialUntil + trialDays:1）
const addUserMatch = auth.match(/addUser:\s*function\s*\([^)]*\)\s*\{([\s\S]*?)\n    \},/);
const addUserBody = addUserMatch ? addUserMatch[1] : '';
check('addUser 含 trialUntil: now + 24h（默认 1 天试用）',
  /trialUntil:\s*now\s*\+\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(addUserBody));
check('addUser 含 trialDays:\s*1', /trialDays:\s*1/.test(addUserBody));

// ③ recoverFromRegistry 用云端 trialUntil 刷新本机（取较大值）
check('recoverFromRegistry 含 cloudTrial 刷新逻辑',
  auth.includes('cloudTrial > (Number(lu.trialUntil)') && auth.includes('lu.trialUntil = cloudTrial'));
check('recoverFromRegistry 含 payMembershipUntil 刷新逻辑',
  auth.includes('cloudPmu > (Number(lu.payMembershipUntil)') && auth.includes('lu.payMembershipUntil = cloudPmu'));
check('recoverFromRegistry 不覆盖密码/角色/状态（仅刷新试用与会员字段）',
  !/lu\.hash\s*=/.test(auth.split('self.users.forEach(function (lu) {')[1].split('});')[0]));

// ④ 刷新按钮补传本机账号到云端
check('refreshUserManagement 调用 saveUsersToRegistry 推本机账号上云',
  app.includes('A.saveUsersToRegistry(dirtyNow'));

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
