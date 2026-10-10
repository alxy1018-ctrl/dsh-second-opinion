#!/usr/bin/env node
/**
 * 参考适配器 · 本地命令
 *
 * 把契约 JSON 原样喂给你自己的命令，把它打印出来的东西原样交回去。
 * 你的评审方是一个本地脚本、一个别的 CLI、一个跑在容器里的东西——都行。
 *
 * 用法：
 *   '<契约 JSON>' | node adapters/exec.mjs -- <命令> [参数...]
 *
 * 约定（也是 docs/reviewer-contract.md 里那份契约的最低要求）：
 *   stdin  ← 契约 JSON
 *   stdout → 评审文本
 *   退出码 0 = 拿到了评审；非 0 = 没拿到，调用方按"拿不到评审"处理（继续干 + 如实告知）。
 *
 * 用 `--` 分隔是有意的：`--` 之后的参数不会再被本脚本解释，
 * 所以你的命令长什么样都不会被这里吃掉一个参数。
 *
 * Windows 上 .cmd / .bat 不能直接 exec：第一次 ENOENT 时会自动换 shell 再试一次。
 */
import { spawn } from 'node:child_process';

const USAGE = `用法: <契约 JSON> | node adapters/exec.mjs -- <命令> [参数...]

  -- 之后的全部内容都是要执行的命令；stdin 给它，它的 stdout/stderr 直通。
     例：node adapters/exec.mjs -- my-reviewer --json
     例：node adapters/exec.mjs -- node ./my-review.mjs
  --help  显示这段说明`;

function splitCommand(argv) {
  const sep = argv.indexOf('--');
  if (sep < 0) return { command: [], extra: argv };
  return { command: argv.slice(sep + 1), extra: argv.slice(0, sep) };
}

async function readStdin() {
  // 交互式终端里跑却没有管道喂数据时会**静默挂住**——宁可直接报用法。
  if (process.stdin.isTTY === true) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const { command, extra } = splitCommand(argv);
  if (extra.length > 0) {
    process.stderr.write(`\`--\` 之前不该有参数：${extra.join(' ')}\n${USAGE}\n`);
    return 2;
  }
  if (command.length === 0) {
    process.stderr.write(`\`--\` 后面没给命令。\n${USAGE}\n`);
    return 2;
  }

  const payload = await readStdin();
  if (payload.trim().length === 0) {
    process.stderr.write(`stdin 是空的，没有契约可送。\n${USAGE}\n`);
    return 2;
  }

  const [cmd, ...args] = command;
  const first = await runOnce(cmd, args, payload, false);
  if (!first.retry) return first.exit;

  // Windows 上 .cmd / .bat 不能被直接 exec（Node 打过补丁之后直接抛 EINVAL），
  // 扩展名不带 .cmd 的命令也可能靠 PATHEXT 才找得到。别让使用者在错误码上卡住——换个 shell 再试一次。
  if (process.platform === 'win32') {
    process.stderr.write(`直接执行 "${cmd}" 没成功；Windows 上 .cmd/.bat 要走 shell，改用 shell 再试一次。\n`);
    const second = await runOnce(cmd, args, payload, true);
    return second.exit;
  }

  process.stderr.write(`找不到命令 "${cmd}"。检查路径写对没有、有没有执行权限。\n`);
  return first.exit;
}

/** 跑一次子命令；把"可能换个 shell 就行"单独标出来，好决定要不要重试。 */
function runOnce(cmd, args, payload, useShell) {
  return new Promise((resolve) => {
    let child;
    try {
      // stdout 走管道而不是 inherit：契约里最要紧的一条是"别把失败包装成空评审"，
      // 要拦"退出码 0 但什么都没输出"，就得不放过输出——inherit 是拦不住的。
      // stderr 仍然直通，报错不必经我们的手。
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'], shell: useShell });
    } catch (error) {
      const retryable = !useShell && process.platform === 'win32' &&
        (error?.code === 'EINVAL' || error?.code === 'ENOENT');
      if (retryable) {
        resolve({ exit: 127, retry: true });
        return;
      }
      process.stderr.write(`起不了这个命令：${error?.message ?? error}\n`);
      resolve({ exit: 127, retry: false });
      return;
    }
    let bytes = 0;
    child.stdout.on('data', (chunk) => { bytes += chunk.length; });
    child.stdout.pipe(process.stdout, { end: false });
    child.on('error', (error) => {
      const retryable = !useShell && process.platform === 'win32' &&
        (error?.code === 'EINVAL' || error?.code === 'ENOENT');
      if (retryable) {
        resolve({ exit: 127, retry: true });
        return;
      }
      process.stderr.write(
        error?.code === 'ENOENT'
          ? `找不到命令 "${cmd}"。\n`
          : `执行失败：${error?.message ?? error}\n`,
      );
      resolve({ exit: 127, retry: false });
    });
    child.on('close', (code, signal) => {
      if (signal !== null && signal !== undefined) {
        process.stderr.write(`子命令被信号 ${signal} 结束。\n`);
        resolve({ exit: 1, retry: false });
        return;
      }
      const exit = code ?? 1;
      if (exit === 0 && bytes === 0) {
        process.stderr.write(
          '子命令退出码是 0，但什么都没输出——按契约这算「没拿到评审」，' +
            '不能当成「评审方认为没问题」。\n',
        );
        resolve({ exit: 1, retry: false });
        return;
      }
      resolve({ exit, retry: false });
    });
    child.stdin.on('error', () => {
      // 子命令不读 stdin 就退出时会触发 EPIPE——那不是错误，忽略。
    });
    child.stdin.end(payload.endsWith('\n') ? payload : `${payload}\n`);
  });
}

const code = await main().catch((error) => {
  process.stderr.write(`适配器出错：${error?.message ?? error}\n`);
  return 1;
});
process.exit(code);
