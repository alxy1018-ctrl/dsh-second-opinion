#!/usr/bin/env node
/**
 * 自检：不需要网络、不需要装进 DSH、不需要任何依赖。
 *
 *   node test/run.mjs        （或 npm test）
 *
 * 分两部分：
 *   A. 插件层——用假的 Cordis 上下文调 apply()，检查注册了什么、正文生成了什么；
 *   B. 适配器层——起一个本地假端点 / 跑一个真实子命令，检查契约的两端对得上。
 *
 * 它**不能**证明线上注入行为（那要装进 DSH、重启、真跑一次），只能证明这段代码本身对不对。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const NODE = process.execPath;

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, extra = '') {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  FAIL ${name}${extra ? ` | ${extra}` : ''}`);
  }
}

function makeCtx() {
  const captured = { section: null, skill: null, command: null, warns: [] };
  const ctx = {
    logger: {
      info() {},
      warn(...args) { captured.warns.push(args.map(String).join(' ')); },
      error() {},
    },
    agents: { get: () => undefined },
    systemPrompt: { section(def) { captured.section = def; } },
    inject(names, cb) {
      const sub = {};
      if (names.includes('commands')) sub.commands = { register(def) { captured.command = def; } };
      if (names.includes('skills')) sub.skills = { register(def) { captured.skill = def; } };
      cb(sub);
    },
  };
  return { ctx, captured };
}

const root = (id) => ({ session: { id, header: {} } });
const child = (id, parentId) => ({ session: { id, header: { parentSession: parentId } } });
const originChild = (id) => ({ session: { id, header: { origin: 'subagent' } } });
const headless = (id) => ({ session: { id, header: undefined } });

const MOD = await import(new URL('../lib/index.js', import.meta.url).href);

console.log('== A. 插件层 ==');
{
  check('导出 name 与 apply', MOD.name === 'second-opinion' && typeof MOD.apply === 'function');
  check('inject 声明挂在导出对象上',
    Array.isArray(MOD.default?.inject) && MOD.default.inject.includes('systemPrompt') && MOD.default.inject.includes('agents'));
}

console.log('-- A1. 策略段与模式 --');
{
  const { ctx, captured } = makeCtx();
  MOD.apply(ctx, {});
  const sec = captured.section;
  check('注册了 systemPrompt 段', sec !== null);
  check('段名与顺序正确（second-opinion:policy / 108）', sec?.name === 'second-opinion:policy' && sec?.order === 108);
  check('根会话拿得到策略段', sec.text({ agent: root('r1') }).includes('先分析，再动手，最后交叉检查'));
  check('无 agent 上下文时为空', sec.text({}) === '' && sec.text(undefined) === '');
  check('策略段写明交叉检查要求不变', sec.text({ agent: root('r1') }).includes('你写的它查，它写的你查'));

  const res = captured.command.handler({ agent: root('r1'), rawInput: 'off' });
  check('off 返回 success', res.kind === 'success');
  check('off 之后根会话策略段为空', sec.text({ agent: root('r1') }) === '');
  const back = captured.command.handler({ agent: root('r1'), rawInput: 'always' });
  check('切回 always', back.kind === 'success' && sec.text({ agent: root('r1') }).length > 0);
  check('未知模式报错', captured.command.handler({ agent: root('r1'), rawInput: 'nope' }).kind === 'error');

  const { ctx: c2, captured: cap2 } = makeCtx();
  MOD.apply(c2, { defaultMode: 'off' });
  check('defaultMode=off 时为空', cap2.section.text({ agent: root('r2') }) === '');

  const { ctx: c2b, captured: cap2b } = makeCtx();
  MOD.apply(c2b, {});
  check('默认 code 模式下根会话照样有策略段', cap2b.section.text({ agent: root('rc') }).includes('先分析，再动手'));
  check('默认模式报告为 code',
    cap2b.command.handler({ agent: root('rc'), rawInput: 'status' }).text.includes('当前 code'));

  const { ctx: c3, captured: cap3 } = makeCtx();
  process.env.SECOND_OPINION_MODE = 'off';
  MOD.apply(c3, {});
  check('SECOND_OPINION_MODE=off 覆盖默认', cap3.section.text({ agent: root('r3') }) === '');
  delete process.env.SECOND_OPINION_MODE;
}

console.log('-- A2. 只对根会话注入 --');
{
  const { ctx, captured } = makeCtx();
  MOD.apply(ctx, { defaultMode: 'always' });
  const sec = captured.section;
  check('always 下根会话有策略段', sec.text({ agent: root('r') }).includes('先分析，再动手'));
  check('子会话为空（always 下也是）', sec.text({ agent: child('c', 'r') }) === '');
  check('孙会话为空', sec.text({ agent: child('g', 'c') }) === '');
  check('origin=subagent 且无父会话也为空', sec.text({ agent: originChild('o') }) === '');
  check('读不到 header 时按根会话处理', sec.text({ agent: headless('n') }).includes('先分析，再动手'));

  const { ctx: c2, captured: cap2 } = makeCtx();
  MOD.apply(c2, {});
  const parent = root('p');
  c2.agents.get = (id) => (id === 'p' ? parent : undefined);
  cap2.command.handler({ agent: parent, rawInput: 'off' });
  check('子会话继承父会话的 off', cap2.section.text({ agent: child('cc', 'p') }) === '');

  check('子会话的命令回执会说明不生效',
    cap2.command.handler({ agent: child('cc', 'p'), rawInput: 'status' }).text.includes('策略段不注入'));
}

console.log('-- A3. 评审方配置渲染进技能正文 --');
{
  const { ctx, captured } = makeCtx();
  MOD.apply(ctx, { reviewer: { kind: 'subagent', provider: 'my-provider', model: 'my-model', label: '老王的模型' } });
  const body = captured.skill.content;
  check('技能已注册', captured.skill?.name === 'second-opinion');
  check('subagent：带上 provider 与 model', body.includes('my-provider') && body.includes('my-model'));
  check('subagent：说明用 subagent 工具且两个参数必须同时给', body.includes('subagent') && body.includes('同时'));
  check('正文含四个阶段', ['requirement', 'code', 'test', 'crosscheck'].every((s) => body.includes(s)));
  check('正文指向契约文档', body.includes('reviewer-contract.md'));
}
{
  const { ctx, captured } = makeCtx();
  MOD.apply(ctx, { reviewer: { kind: 'http', baseURL: 'https://api.example.com/v1', model: 'm1', apiKeyEnv: 'MY_KEY' } });
  const body = captured.skill.content;
  check('http：端点/模型/密钥变量名都渲染出来',
    body.includes('https://api.example.com/v1') && body.includes('m1') && body.includes('MY_KEY'));
  check('http：给出参考适配器命令', body.includes('adapters') && body.includes('http.mjs'));
  check('http：提醒密钥不要写进配置', body.includes('不要') && body.includes('密钥'));
}
{
  const { ctx, captured } = makeCtx();
  MOD.apply(ctx, { reviewer: { kind: 'command', command: 'my-reviewer --json' } });
  const body = captured.skill.content;
  check('command：命令渲染出来', body.includes('my-reviewer --json'));
  check('command：给出 exec 参考适配器', body.includes('exec.mjs'));
}
{
  const { ctx, captured } = makeCtx();
  MOD.apply(ctx, { reviewer: { kind: 'none' } });
  const body = captured.skill.content;
  check('none：明说没配评审方，但纪律保留',
    body.includes('没配评审方') && body.includes('交叉检查都保留'));
}
{
  const { ctx, captured } = makeCtx();
  MOD.apply(ctx, { reviewer: { kind: 'telepathy' } });
  check('非法 kind 退回 subagent 并告警',
    captured.warns.some((w) => w.includes('reviewer.kind')) && captured.skill.content.includes('subagent'));
}
{
  const { ctx, captured } = makeCtx();
  MOD.apply(ctx, { reviewer: { kind: 'command', command: 'bad`cmd\nnewline' } });
  check('含反引号/换行的值被拒绝并告警',
    captured.warns.some((w) => w.includes('reviewer.command')) && !captured.skill.content.includes('newline'));
}
{
  const { ctx, captured } = makeCtx();
  MOD.apply(ctx, { reviewer: { kind: 'command', command: 'cmd /c "我的评审器"' } });
  check('命令里的双引号是合法的，不该被一刀切拒掉',
    captured.skill.content.includes('cmd /c "我的评审器"') && captured.warns.length === 0,
    JSON.stringify(captured.warns));
}
{
  const { ctx, captured } = makeCtx();
  MOD.apply(ctx, { reviewer: { kind: 'http', baseURL: "https://x'y.example.com/v1" } });
  check('端点里的单引号被拒（它会被单引号包进命令行）',
    captured.warns.some((w) => w.includes('reviewer.baseURL')) && !captured.skill.content.includes("x'y.example.com"));
}

console.log('-- A4. 不绑定厂商 --');
{
  const { ctx, captured } = makeCtx();
  MOD.apply(ctx, {});
  const r = MOD.__internals.normalizeReviewer({}, undefined);
  check('默认评审方没有任何路由/端点/模型',
    r.provider === '' && r.model === '' && r.baseURL === '' && r.command === '' && r.apiKeyEnv === '');
  const source = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8');
  const vendors = ['qwen', 'dashscope', 'anthropic', 'gemini', 'gpt-', 'claude', 'ollama'];
  const found = vendors.filter((v) => source.toLowerCase().includes(v));
  check('插件源码里没有具体厂商名', found.length === 0, found.join(', '));
  check('默认配置下 check 会提示缺项',
    captured.command.handler({ agent: root('r'), rawInput: 'check' }).text.includes('自检发现'));
}

console.log('-- A5. 模式关闭时仍注册技能 --');
{
  const { ctx, captured } = makeCtx();
  MOD.apply(ctx, { defaultMode: 'off', registerCommand: false });
  check('registerCommand=false 时不注册命令', captured.command === null);
  check('off 模式下技能仍然注册', captured.skill?.name === 'second-opinion');
}

console.log('== B. 适配器层 ==');
const httpAdapter = await import(new URL('../adapters/http.mjs', import.meta.url).href);
{
  const requirement = httpAdapter.renderPrompt({ stage: 'requirement', request: 'R', analysis: 'A' });
  check('requirement 提示词带上"阻止无意义的改动"', requirement.includes('阻止无意义的改动'));
  check('requirement 提示词带上要求原文与分析', requirement.includes('R') && requirement.includes('A'));
  const code = httpAdapter.renderPrompt({ stage: 'code', request: 'R', artifact: 'diff --git a/x b/x' });
  check('code 提示词把 artifact 包进代码块', code.includes('```') && code.includes('diff --git'));
  check('每个阶段都要求三段式输出', ['requirement', 'code', 'test', 'crosscheck']
    .every((stage) => httpAdapter.renderPrompt({ stage }).includes('[第二意见')));
}

console.log('-- B1. http 适配器打本地假端点 --');
{
  let seen = null;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen = { url: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: '[第二意见 · 假的]\n发现：\n  - 举例' } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const run = (env, payload) => new Promise((resolve) => {
    const p = spawn(NODE, [join(ROOT, 'adapters', 'http.mjs'),
      '--base', `http://127.0.0.1:${port}/v1`, '--model', 'fake-model', '--key-env', 'TEST_KEY_XYZ'],
    { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    p.on('close', (code) => resolve({ code, out, err }));
    p.stdin.end(JSON.stringify(payload));
  });

  const ok = await run({ TEST_KEY_XYZ: 'secret-value' }, { stage: 'code', request: 'R', artifact: 'A' });
  check('成功路径退出码 0', ok.code === 0, ok.err);
  check('评审文本透传到 stdout', ok.out.includes('[第二意见 · 假的]'));
  check('请求打到了 /chat/completions', seen?.url === '/v1/chat/completions', String(seen?.url));
  check('密钥走 Authorization 头', seen?.auth === 'Bearer secret-value');
  check('请求体带上模型名与提示词', seen?.body?.model === 'fake-model' && typeof seen?.body?.messages?.[0]?.content === 'string');
  check('密钥没有出现在输出里', !ok.out.includes('secret-value') && !ok.err.includes('secret-value'));

  const noKey = await run({ TEST_KEY_XYZ: '' }, { stage: 'code' });
  check('密钥为空时退出码非 0 且说明原因', noKey.code !== 0 && noKey.err.includes('TEST_KEY_XYZ'), noKey.err);

  const big = await run({ TEST_KEY_XYZ: 'secret-value' }, { stage: 'code', request: 'R', artifact: 'x'.repeat(120000) });
  check('载荷过大时提醒但不阻断', big.code === 0 && big.err.includes('偏大'), big.err.slice(0, 150));

  const wrongContract = await run({ TEST_KEY_XYZ: 'secret-value' }, { contract: 'other/review@9', stage: 'code' });
  check('契约版本对不上时提醒，但仍然照发',
    wrongContract.code === 0 && wrongContract.err.includes('契约'), wrongContract.err.slice(0, 150));

  server.close();
}

console.log('-- B2. http 适配器对坏端点的处理 --');
{
  const p = spawn(NODE, [join(ROOT, 'adapters', 'http.mjs'),
    '--base', 'http://127.0.0.1:9/v1', '--model', 'm', '--key-env', 'TEST_KEY_XYZ', '--timeout', '5'],
  { env: { ...process.env, TEST_KEY_XYZ: 'x' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let err = '';
  p.stderr.on('data', (c) => { err += c; });
  p.stdin.end('{"stage":"code"}');
  const code = await new Promise((resolve) => p.on('close', resolve));
  check('连不上时退出码非 0 且有可读原因', code !== 0 && err.trim().length > 0, err);
}
{
  const p = spawn(NODE, [join(ROOT, 'adapters', 'http.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
  let err = '';
  p.stderr.on('data', (c) => { err += c; });
  p.stdin.end('{}');
  const code = await new Promise((resolve) => p.on('close', resolve));
  check('缺 --base/--model/--key-env 时退出码 2 并给用法', code === 2 && err.includes('用法'), err);
}

console.log('-- B3. exec 适配器 --');
{
  const runExec = (args, payload) => new Promise((resolve) => {
    const p = spawn(NODE, [join(ROOT, 'adapters', 'exec.mjs'), ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    p.on('close', (code) => resolve({ code, out, err }));
    p.stdin.end(payload);
  });

  const echo = await runExec(['--', NODE, '-e', 'process.stdin.pipe(process.stdout)'], '{"stage":"code"}');
  check('exec：stdin 原样转给子命令、stdout 原样回来', echo.code === 0 && echo.out.includes('"stage":"code"'), echo.err);

  const failCmd = await runExec(['--', NODE, '-e', 'process.stderr.write("评审方炸了\\n"); process.exit(3)'], '{}');
  check('exec：子命令退出码原样传递', failCmd.code === 3, String(failCmd.code));
  check('exec：子命令的 stderr 透传', failCmd.err.includes('评审方炸了'));

  const noSep = await runExec([], '{}');
  check('exec：没给 `--` 与命令时退出码 2 并给用法', noSep.code === 2 && noSep.err.includes('用法'), noSep.err);

  const missing = await runExec(['--', 'definitely-not-a-real-command-xyz'], '{}');
  check('exec：命令不存在时退出码非 0 且说得出是哪个命令',
    missing.code !== 0 && missing.err.includes('definitely-not-a-real-command-xyz'), `${missing.code} ${missing.err}`);

  const silent = await runExec(['--', NODE, '-e', 'process.exit(0)'], '{}');
  check('exec：退出码 0 但没输出时判失败（不能读成"没问题"）',
    silent.code === 1 && silent.err.includes('什么都没输出'), `${silent.code} ${silent.err}`);

  if (process.platform === 'win32') {
    const cmdPath = join(tmpdir(), 'second-opinion-adapter-probe.cmd');
    writeFileSync(cmdPath, '@echo off\r\necho REVIEW-FROM-CMD\r\n');
    const viaCmd = await runExec(['--', cmdPath], '{}');
    check('exec：Windows 上 .cmd 能跑起来（自动换 shell）',
      viaCmd.code === 0 && viaCmd.out.includes('REVIEW-FROM-CMD'), `${viaCmd.code} ${viaCmd.err}`);
    rmSync(cmdPath, { force: true });
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
