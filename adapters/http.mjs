#!/usr/bin/env node
/**
 * 参考适配器 · HTTP（OpenAI 兼容端点）
 *
 * 它只做一件事：把契约 JSON 从 stdin 读进来，拼成人话，POST 到
 * `{baseURL}/chat/completions`，把回复打到 stdout。
 *
 * 刻意**不绑定任何厂商**：端点、模型、密钥环境变量全部由命令行参数给，
 * 代码里没有任何默认值，也没有任何厂商名字。密钥只从环境变量读，不落配置、不进 argv。
 *
 * 用法：
 *   '<契约 JSON>' | node adapters/http.mjs --base <url> --model <m> --key-env <ENV> [--timeout 180]
 *
 * 想接的不是 OpenAI 兼容形态？照 docs/reviewer-contract.md 自己写一个——这就是这个文件存在的意义。
 */
import { pathToFileURL } from 'node:url';

/** 本适配器认识的契约版本；载荷里带了别的版本会提醒一句（但照样发）。 */
const EXPECTED_CONTRACT = 'second-opinion/review@1';

const USAGE = `用法: <契约 JSON> | node adapters/http.mjs --base <url> --model <m> --key-env <ENV> [--timeout 秒数]

  --base      端点根地址，会拼上 /chat/completions。例：https://api.example.com/v1
  --model     模型名
  --key-env   存放密钥的**环境变量名**（不要把密钥本身写在命令行里）
  --timeout   秒，默认 180
  --help      显示这段说明`;

function parseArgs(argv) {
  const out = { timeout: 180 };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--help' || key === '-h') return { help: true };
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`参数 ${key} 后面缺值`);
    if (key === '--base') out.base = value;
    else if (key === '--model') out.model = value;
    else if (key === '--key-env') out.keyEnv = value;
    else if (key === '--timeout') out.timeout = Number.parseInt(value, 10);
    else throw new Error(`不认识的参数 ${key}`);
    i += 1;
  }
  return out;
}

async function readStdin() {
  // 交互式终端里跑却没有管道喂数据时会**静默挂住**——宁可直接报用法。
  if (process.stdin.isTTY === true) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

/**
 * 把契约渲染成一段提示词。
 * 契约字段见 docs/reviewer-contract.md；缺字段就跳过，不报错。
 */
export function renderPrompt(payload) {
  const stageHint = {
    requirement: '你正在对下属的任务分析做二次评审。你的职责是阻止无意义的改动，不是鼓励多干活。',
    code: '你正在评审刚写完的代码改动。只关注真实缺陷，不要评论代码风格。',
    test: '你正在评审一次验证/测试过程。要回答的是：这次的验证真能证明要求被满足吗？',
    crosscheck: '你正在核对一个模块与冻结契约是否一致。只关注偏离。',
  }[payload.stage];

  const sections = [];
  if (typeof stageHint === 'string') sections.push(stageHint);
  if (payload.request) sections.push(`## 用户的要求\n${payload.request}`);
  if (payload.analysis) sections.push(`## 我方的分析\n${payload.analysis}`);
  if (payload.artifact) sections.push(`## 要评的东西\n\`\`\`\n${payload.artifact}\n\`\`\``);
  if (payload.notes) sections.push(`## 额外约束\n${payload.notes}`);
  sections.push(
    '请严格按下面的格式回复，不要加任何前后缀：\n' +
      '[第二意见 · <一句话总体判断>]\n发现：\n  - <具体问题>\n待澄清：\n  - <需要向用户澄清的问题>',
  );
  return sections.join('\n\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  for (const required of ['base', 'model', 'keyEnv']) {
    if (typeof args[required] !== 'string' || args[required].length === 0) {
      process.stderr.write(`缺少必需参数 --${required === 'keyEnv' ? 'key-env' : required}\n${USAGE}\n`);
      return 2;
    }
  }

  const raw = await readStdin();
  if (raw.length === 0) {
    process.stderr.write(`stdin 是空的，没有契约可送。\n${USAGE}\n`);
    return 2;
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    // 不是 JSON 就当纯文本处理：给想把任意问题丢过来的人留条路。
    payload = { request: raw };
  }

  // 协议版本：认不出来也照发，但要留个痕——静默按老版本解释载荷是最难查的一类问题。
  if (typeof payload.contract === 'string' && payload.contract !== EXPECTED_CONTRACT) {
    process.stderr.write(
      `提醒：载荷声明的契约是 "${payload.contract}"，本适配器认的是 "${EXPECTED_CONTRACT}"——照发，但结果可能不合预期。\n`,
    );
  }

  // 契约里说 artifact 只放关键片段。这里不替调用方截断（截断会毁掉评审），
  // 但要提醒一声——载荷大 = 慢 + 贵 + 评审质量下降，这是最常见的自伤方式。
  if (Buffer.byteLength(raw, 'utf8') > 100_000) {
    process.stderr.write(
      `提醒：载荷 ${Math.round(Buffer.byteLength(raw, 'utf8') / 1024)} KB，偏大。` +
        '按契约 artifact 只该放关键片段（diff 的 hunk、改动的函数），不然又慢又贵、评审还更糊。\n',
    );
  }

  const key = process.env[args.keyEnv];
  if (typeof key !== 'string' || key.trim().length === 0) {
    process.stderr.write(`环境变量 ${args.keyEnv} 是空的（密钥只从环境变量读）。\n`);
    return 1;
  }

  const url = `${String(args.base).replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, args.timeout) * 1000);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: args.model,
        messages: [{ role: 'user', content: renderPrompt(payload) }],
      }),
      signal: controller.signal,
    });
  } catch (error) {
    process.stderr.write(
      `请求失败：${error?.name === 'AbortError' ? `超过 ${args.timeout} 秒` : error?.message ?? error}\n`,
    );
    return 1;
  } finally {
    clearTimeout(timer);
  }

  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    process.stderr.write(`HTTP ${response.status}：${JSON.stringify(body ?? {}).slice(0, 300)}\n`);
    return 1;
  }

  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    process.stderr.write(`返回结构里没有找到 choices[0].message.content：${JSON.stringify(body ?? {}).slice(0, 300)}\n`);
    return 1;
  }

  process.stdout.write(`${content.trim()}\n`);
  return 0;
}

// 只在直接运行时执行；被 import 时只暴露 renderPrompt 供测试。
const isMain = (() => {
  try {
    // 用 pathToFileURL 而不是手拼 file:// —— 路径里有空格、#、% 或 UNC 时手拼会不等价。
    return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const code = await main().catch((error) => {
    process.stderr.write(`适配器出错：${error?.message ?? error}\n`);
    return 1;
  });
  process.exit(code);
}
