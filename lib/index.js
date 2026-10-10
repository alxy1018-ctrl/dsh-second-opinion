/**
 * dsh-second-opinion —— 先分析、再动手、最后交叉检查。
 *
 * 它只做一件事：在你动手写代码之前，让另一个脑子看一眼你的分析；
 * 代码写完、验证做完，再各看一次；多模块任务时，你俩分头写、互相查。
 *
 * 设计上刻意**不做**的事（都是踩过坑的结论，别改回去）：
 *   1. **插件进程内不发起任何调用**。它只往上下文里写纪律和调用约定，
 *      真正的评审由 agent 用宿主已有的能力发出（子代理 / HTTP / 本地命令）。
 *      在插件进程里发 HTTP 还要顺带管凭据，会带来超时、沙箱 ACL、凭据解析脆弱一堆问题。
 *   2. **零外部依赖**，只用 node: 内置模块——插件装在 profile 里，
 *      Node 从插件目录向上找 node_modules 穿不进 app.asar。
 *   3. **不绑定任何厂商**。默认配置里没有 provider、没有端点、没有模型名；
 *      评审方是谁完全由使用者的配置决定。
 *   4. **策略段只注入根会话**。子代理拿到这段会自己再派一个评审，变成"评审的评审"；
 *      而且子代理本来也派不出下一层（宿主默认 depth 1）。
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const name = 'second-opinion';

const MODES = ['always', 'code', 'off'];
const DEFAULT_MODE = 'code';
const SECTION_NAME = 'second-opinion:policy';
/** 工具引导带是 100–199；紧跟 tool:bash(105) 之后。 */
const SECTION_ORDER = 108;
const SKILL_NAME = 'second-opinion';
const COMMAND_NAME = 'second-opinion';

/** 评审方的四种接入方式。 */
const KINDS = ['subagent', 'http', 'command', 'none'];
const DEFAULT_KIND = 'subagent';

/** 本包安装位置：用来在技能正文里给出参考适配器的绝对路径。 */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ADAPTERS_DIR = join(PACKAGE_ROOT, 'adapters');

/**
 * 配置值会被插进技能正文（有些还会被插进一条命令行里），
 * 含反引号或换行的值会把生成结果弄坏——而且**不报错**，很难查。
 * 所以这类值一律拒绝、退回默认并告警。
 *
 * `quoted: true` 用于**会被单引号包起来**的值（端点、模型、密钥变量名）：
 * 单引号会把那条命令截断，所以单独拦掉。双引号不拦——它在命令行里是合法的
 * （`cmd /c "run this"` 这种写法很常见），一刀切会把好配置也拒了。
 */
function pickText(value, fallback, label, logger, options = {}) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  const forbidden = options.quoted === true ? /['`\r\n]/ : /[`\r\n]/;
  if (forbidden.test(trimmed)) {
    logger?.warn?.(
      'second-opinion: 配置项 %s 含%s反引号或换行，已忽略并退回默认值 %s',
      label,
      options.quoted === true ? '单引号、' : '',
      fallback,
    );
    return fallback;
  }
  return trimmed;
}

/** 取一个正整数配置，非法就退回默认。 */
function pickPositiveInt(value, fallback, label, logger) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) {
    if (value !== undefined && value !== null && value !== '') {
      logger?.warn?.('second-opinion: 配置项 %s 不是正整数，已退回默认值 %s', label, fallback);
    }
    return fallback;
  }
  return Math.floor(n);
}

/**
 * 归一化评审方配置。
 *
 * 所有字段都可缺省——`kind` 决定的只是**怎么把这个评审方叫起来**，
 * 与"评审要问什么"无关。参数缺失不报错，只在 `/second-opinion check` 里提示。
 */
function normalizeReviewer(raw, logger) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const kind = KINDS.includes(source.kind) ? source.kind : DEFAULT_KIND;
  if (source.kind !== undefined && !KINDS.includes(source.kind)) {
    logger?.warn?.(
      'second-opinion: 未知的 reviewer.kind "%s"，已按 %s 处理（可选：%s）',
      source.kind,
      DEFAULT_KIND,
      KINDS.join(' / '),
    );
  }
  return {
    kind,
    label: pickText(source.label, '', 'reviewer.label', logger),
    provider: pickText(source.provider, '', 'reviewer.provider', logger),
    // 下面三个在 http 形态里会被单引号包进命令行，所以对单引号也更严格。
    model: pickText(source.model, '', 'reviewer.model', logger, { quoted: true }),
    baseURL: pickText(source.baseURL, '', 'reviewer.baseURL', logger, { quoted: true }),
    apiKeyEnv: pickText(source.apiKeyEnv, '', 'reviewer.apiKeyEnv', logger, { quoted: true }),
    command: pickText(source.command, '', 'reviewer.command', logger),
    timeoutSeconds: pickPositiveInt(source.timeoutSeconds, 180, 'reviewer.timeoutSeconds', logger),
  };
}

/** 评审方在命令行里的显示名。 */
function reviewerTitle(reviewer) {
  const kindName = {
    subagent: '子代理',
    http: 'HTTP 端点',
    command: '本地命令',
    none: '不设评审方',
  }[reviewer.kind];
  return reviewer.label.length > 0 ? `${reviewer.label}（${kindName}）` : kindName;
}

/** 把评审方配置渲染成"怎么叫它起来"的说明；`none` 之外都会给出可直接跑的命令行。 */
function reviewerHowTo(reviewer) {
  const lines = [];
  const label = reviewerTitle(reviewer);
  if (reviewer.kind === 'subagent') {
    const route = [
      reviewer.provider.length > 0 ? `provider=${reviewer.provider}` : 'provider=<你自己的路由>',
      reviewer.model.length > 0 ? `model=${reviewer.model}` : 'model=<你自己的模型>',
    ].join(' ');
    lines.push(`- 评审方：**${label}**`);
    lines.push(`- 怎么叫它：用 \`subagent\` 工具，**同时**给 \`provider\` 与 \`model\` —— \`${route}\`；`);
    lines.push('  提示词用 §3.4 的模板。子代理拿到的是一个全新上下文，看不到你的对话。');
    lines.push('- 它自己有文件读写能力，所以"给路径 + 要它判断什么"通常比"贴一大段代码"更好用。');
  } else if (reviewer.kind === 'http') {
    const base = reviewer.baseURL.length > 0 ? reviewer.baseURL : '<你的端点>';
    const model = reviewer.model.length > 0 ? reviewer.model : '<你的模型>';
    const keyEnv = reviewer.apiKeyEnv.length > 0 ? reviewer.apiKeyEnv : '<你的密钥环境变量名>';
    lines.push(`- 评审方：**${label}** —— OpenAI 兼容的 \`POST {baseURL}/chat/completions\`。`);
    lines.push(`- 端点 \`${base}\`，模型 \`${model}\`，密钥从环境变量 \`${keyEnv}\` 读（**不要**写进配置或命令行）。`);
    lines.push('- 参考实现（本包自带，可当模板抄）：');
    lines.push('');
    lines.push('```powershell');
    lines.push(`'<契约 JSON>' | & node '${join(ADAPTERS_DIR, 'http.mjs')}' \` `);
    lines.push(`    --base '${base}' --model '${model}' --key-env '${keyEnv}'`);
    lines.push('```');
  } else if (reviewer.kind === 'command') {
    const cmd = reviewer.command.length > 0 ? reviewer.command : '<你的命令>';
    lines.push(`- 评审方：**${label}** —— 把契约 JSON 从 **stdin** 喂给它，读它的 **stdout**。`);
    lines.push(`- 命令：\`${cmd}\``);
    lines.push('- 参考实现（本包自带，用来把任意命令接到契约上）：');
    lines.push('');
    lines.push('```powershell');
    lines.push(`'<契约 JSON>' | & node '${join(ADAPTERS_DIR, 'exec.mjs')}' -- ${cmd}`);
    lines.push('```');
  } else {
    lines.push(`- 评审方：**${label}** —— 这个仓库没配评审方。`);
    lines.push('- 纪律照旧：**分析与交叉检查都保留**，只是不要第二意见。§3.4 的模板留着，将来配了就能用。');
  }
  return lines.join('\n');
}

/** 技能正文 —— 只在模型主动加载技能时进入上下文；评审方的路径与参数按实际配置生成。 */
function skillContent(reviewer, adapterContractPath) {
  return `# 第二意见 · 操作细则

这个技能配合每轮注入的「先分析，再动手，最后交叉检查」策略使用。策略给纪律，这里给做法。

## 一、什么时候用

**用**：会导致代码产出的要求——写新代码、加功能、改行为、重构、拆模块、改接口、写脚本或配置、排查 bug 给修复方案。
**不用**：纯问答、查资料、看代码结构、改错别字或格式、只跑命令看输出。

判不准时按**用**处理，并在分析里用一句话说明你为什么差点不用。

## 二、第一步：分析（不写代码）

在动任何文件之前，写出一段分析：

1. **真正的问题**：用户要解决什么，而不是他字面说了什么。
2. **验收标准**：怎么算做完了、怎么验证。
3. **改动面**：预计动哪几个文件、哪些函数；能不能更小。
4. **既有约定**：这个仓库里已有的模式、命名、依赖，必须沿用而不是另起一套。
5. **不确定项**：哪里有歧义、需要用户澄清。

分析要短。五行能说清就不要写二十行。

## 三、第二步：拿第二意见

${reviewerHowTo(reviewer)}

### 3.1 契约

不管用哪种接入方式，**送出去的东西和要回来的东西是同一套**（完整定义见
\`${adapterContractPath}\`）：

送出去：\`stage\`（\`requirement\` / \`code\` / \`test\` / \`crosscheck\`）、
\`request\`（用户要求**原文**，不要转述）、\`analysis\`（你的分析）、
\`artifact\`（要评的东西：diff、验证记录、或契约 + 文件路径）。

要回来：三段式，你才好合并——

\`\`\`
[第二意见 · <一句话总体判断>]
发现：
  - <具体问题>
待澄清：
  - <需要向用户澄清的问题>
\`\`\`

**长度控制**：\`artifact\` 只放**关键片段**——改动的函数、diff 的 hunk、要评审的那段逻辑。
不要贴整个文件或整份对话，那既慢又稀释重点。

### 3.2 四个阶段

| stage | 什么时候 | 送什么 |
|---|---|---|
| \`requirement\` | 动手前 | 要求原文 + 你的分析 |
| \`code\` | 代码写完、自测过 | diff 或关键 hunk（+ 要它重点看什么） |
| \`test\` | 验证做完 | 你做了什么、结果如何 |
| \`crosscheck\` | 并行开发时互查 | 冻结的契约 + 对方要核的文件路径 |

前三个阶段是**必做**的；\`crosscheck\` 只在第 §8 节那种并行任务里用。

### 3.3 拿不到评审怎么办

**不卡住、不重试整段、不硬凑。** 照自己的分析继续干，最后用一句话告诉用户
"本次没拿到第二意见，原因是 X"——把原因说具体（超时 / 没授权 / 命令不存在 / 返回看不懂）。

**不要**为了拿到评审而把同一份载荷原样重发，那正是最费时间和 token 的做法。
要么把载荷缩到最小再试一次，要么放弃这一阶段。

### 3.4 提示词模板

四个阶段的问法不同，其余相同。模板后面附上 §3.1 要送出去的那几项。

**requirement（动手前）**

\`\`\`
你是资深工程师，正在对下属的任务分析做二次评审。你的职责是阻止无意义的改动，不是鼓励多干活。
针对下面的「用户要求 + 我的分析」回答：
1. 这个需求真正要解决的问题是什么？有没有被误读？
2. 分析里有没有把简单问题复杂化（过度设计、无谓重构、引入新依赖）？
3. 有没有遗漏的约束（既有代码习惯、最小改动面、可逆性）？
4. 这活该不该拆成多个模块并行写？该拆就说清模块边界与接口契约；只是一两个文件的改动，直说"不必拆"。
最多列 3 个最关键、需要向用户澄清的问题；没有就留空。
只指出真正值得改的地方，没问题的方面不要凑数。
\`\`\`

**code（代码写完后）**

\`\`\`
你是资深工程师，正在评审刚写完的代码改动。只关注真实缺陷：
- 逻辑错误、边界条件、资源泄漏、错误处理缺失
- 明显偏离用户要求的地方
- 过度设计：为了"更优雅"而增加抽象、参数、依赖
不要评论代码风格偏好，不要要求补测试以外的额外工程设施。
\`\`\`

**test（验证完成后）**

\`\`\`
你是资深工程师，正在评审一次验证/测试过程。请回答：
- 这次的验证是否真的能证明用户要求被满足？有没有自证式的假验证？
- 有没有更省事但同样有效的验证方式？
- 有没有被忽略的回归风险点？
\`\`\`

**crosscheck（互查对方写的模块）**

\`\`\`
你是资深工程师，正在核对一个模块与冻结契约是否一致。只关注偏离：
- 文件路径与所有权清单是否一致，有没有越界改了别人的文件
- 接口实现与契约是否严格一致（签名、参数顺序、返回结构、错误约定）
- 边界条件与错误处理是实现了，还是只写了 happy path
- 有没有契约外的依赖或隐藏的全局状态
不要评论代码风格，不要提"可以更优雅"的建议。
\`\`\`

## 四、合并意见，然后决定要不要打扰用户

第二意见是**参考**，不是命令。逐条判断：

- **采纳**：指出了真实缺陷、误读、过度设计 → 改方案。
- **驳回**：不了解本仓库约定、纯风格偏好、要求增加用不上的工程设施 → 心里记一句理由，不改。
- **冲突**：它的判断和你的相反、且**会改变最终结果** → 这时才值得问用户。

评审结论**留在内部，不要贴给用户看**。用户要的是结果，不是我们内部的讨论记录。

### 4.1 只有这几种情况才停下来问

- 需求本身有歧义，不同理解会做出不同的东西
- 验收标准无法确定（不知道什么算"做对了"）
- 评审方与我方判断冲突，且这个分歧**会改变最终结果**
- 需要用户拍板取舍：要不要动对外接口、能不能加依赖、要不要牺牲兼容性
- 分析后发现用户的要求本身可能是多余的改动

问的时候**一句话说清问题和选项**，不要展开成问卷，也不要顺带汇报进度。

### 4.2 这些**不要**问，直接继续

- 方案已经清晰，只是想再确认一遍理解对不对
- 想征求命名、目录结构、代码风格之类的主观偏好
- 想汇报"我已经分析完了，准备开始"——没人要求这个
- 想问"需要我继续吗"——需要，继续就是默认答案

判据一句话：**问，是因为答案会改变你接下来做的事；不是因为你想让别人放心。**

这条规则的默认结局是**把东西做完**。停下来问是例外，不是流程的一部分。

## 五、第三步：执行

方案定了就动手。执行期间不需要反复评审——只有**方案发生实质变化**时才回去再拿一次第二意见
（例如实现中发现要动接口、要加依赖、要改超出原计划的数据结构）。

## 六、第四步：代码完成后复审

代码写完、自测通过后走一次 \`code\` 阶段。重点看：
逻辑错误、边界条件、错误处理、资源释放、是否偏离用户要求、是否引入了不必要的抽象。

有真实缺陷就修；修完不必再走一轮完整评审，除非修的是结构性问题。

## 七、第五步：验证后复审

跑完测试或验证后走一次 \`test\` 阶段。要回答的是：
**这次的验证真的能证明要求被满足吗？** 常见的假验证：

- 只跑了编译没跑行为
- 用自己写的桩验证自己写的逻辑
- 覆盖的是 happy path，而用户的场景在边界上

验证结论也留在内部，只把「做了什么、结果如何」告诉用户。

## 八、多模块任务：并行开发 + 交叉检查

只有**过得了成本阈值**、而且**双方一致认为该拆**时，才走这一节。否则一路串行写完。

### 8.1 两道闸门，缺一不可

1. **值不值得**（成本由我方把关）：模块之间接口明确、各自可独立验证、合起来的工作量
   明显大于沟通成本。不值得：改动集中在一两个文件、耦合紧密、拆完还要来回对齐接口——
   **能不拆就不拆**，拆错了比不拆糟。
2. **双方一致**：\`requirement\` 阶段的模板里已经问过"该不该拆、边界怎么切"（§3.4 第 4 问）。
   它给出切法、**我方也认可** → 才拆。

**评审方说要拆、我方判断过不了成本阈值 → 不拆**，并在分析里写明理由。
评审方天然倾向于展示分析深度，成本这一关必须由我方守住。

### 8.2 拆分与分工

1. 把任务切成 \`M1 / M2 / …\`，每个模块写清：
   - 边界：负责什么、**不负责什么**
   - 对外接口：函数签名、文件、数据格式（这是双方唯一的契约）
   - 验收：怎么单独验证这个模块
2. **契约在开工前冻结**：写进契约文件，或原样写进两边的任务提示词。
   契约没冻结就同时开工，等于制造两份不兼容的实现。
3. 我方认领**难度高或风险大**的那个（接口定义方、核心算法），评审方认领**边界清晰、模式化**的那个。
4. 契约冻结之后**两边同时开工**，不要再等谁先落地。

### 8.3 文件所有权（两个写手同时干活时的硬纪律）

**一个文件在同一时间只能有一个写手。** 这是并行最容易翻车的地方——
两个写手改同一个文件，后写的覆盖先写的，而且往往到集成时才发现。

开工前列出清单：

\`\`\`
文件                 写手
m1/xxx.c             我方
m2/yyy.c             评审方
include/contract.h   我方（接口定义方独占）
tests/               集成阶段由我方统一生成
\`\`\`

**共享的接口文件由接口定义方独占。** 评审方需要新接口时，让它提出来、由你改契约——
不要让它自己动契约文件，否则两边对契约的理解会悄悄分叉。

### 8.4 交叉检查（要求不变）

两边都写完后，互相检查对方的模块。

**我查它写的**：不能只看它说"做完了"，必须**读它实际写出的文件**，逐条核对：
文件路径有没有越界、接口与契约是否严格一致、边界与错误处理是否实现、有没有契约外的依赖。

**它查我写的**：走一次 \`crosscheck\` 阶段，把契约与文件路径给它。

发现问题就改，改完再对一次契约。**不要跳过契约核对直接测**——
接口不一致时，测试失败的原因会被误判成逻辑错误，白折腾。

### 8.5 合并与验证

1. 先做**接口级验证**：两边都编译/加载通过，签名对得上。
2. 再做**集成验证**：跑真实用例。这时候才走一次 \`test\` 阶段。
3. 集成失败，**先分清是谁的模块的问题**再动手改，不要两边一起乱改。

### 8.6 别把并行用成负担

- 模块数**两个够了**，三个以上沟通成本会吃掉收益。
- 派出去的评审方按多轮计费时，比一次单向调用贵得多：只在该用时用。
- 评审方的产出要**当成外部代码审**，不要因为"是它写的"就放松检查。
- 任务小就老老实实自己写完——并行是给大活儿用的。

## 九、明显的小错误

**可以直接改、不用评审**：拼写错误、语法错误、明显的笔误（变量名/函数名拼错、少个分号）。

**不属于小错误**（必须走评审）：命名风格调整、"顺手"重构、抽取公共函数、补类型标注、
调整文件结构、引入格式化工具。

判据：**改完之后功能与结构不变**的，是小错误；**会改变结构或影响面**的，不是。
`;
}

/** 策略正文：每轮注入，必须短且可执行。 */
const POLICY_TEXT = `## 先分析，再动手，最后交叉检查（second opinion）

**触发**：要求会导致**代码产出或工程结论**——写/改代码、加功能、重构、设计接口、
写脚本或配置、排查 bug 并给出修复方案。
**不触发**（直接执行）：回答问题、查资料、看文件、改错别字/格式/文档措辞、只跑命令看输出。

**触发后**：
1. **先分析，不动手**：真正要解决的问题、验收标准、改动面、必须沿用的既有约定、不确定项。
2. 把《要求原文 + 你的分析》交给**你配置的评审方**要第二意见（怎么调、模板在哪，见技能
   \`${SKILL_NAME}\` 第三节）。
3. **合并**：采纳合理的、驳回不适用的。**评审结论留在内部，不要贴给用户。**
4. **只有这几种情况才停下来问用户**：需求本身有歧义、验收标准无法确定、
   评审方与你判断冲突且会改变结果、需要用户拍板取舍、发现这个要求本身可能是多余的改动。
   其余一律直接干到底——**问，是因为答案会改变你接下来做的事；不是因为你想让别人放心。**
5. 代码写完复审一次，验证做完再复审一次。有真实缺陷就改，纯风格偏好不改。
6. **多模块任务**：评审方也认为该拆时，**先冻结接口契约，再同时开工**。
   **交叉检查要求不变：你写的它查，它写的你查**；一个文件同时只能有一个写手。
7. 评审完**自动接着干**，不要停下来等用户确认。默认结局是"东西做完了"。

**拿不到评审就继续干**：评审方超时、报错、没配、没授权——照自己的分析往下做，
最后用一句话说明原因，不要卡住，也不要为拿评审把整段载荷反复重发。

**这段只注入根会话**：子代理收不到，也不要让子代理再去派评审——它的产出由你交叉检查。

**小错误豁免**：拼写、语法、明显笔误直接改；"顺手重构""补类型标注""调整结构"不算小错误。`;

/**
 * 插件入口。
 *
 * @param {object} ctx - Cordis 上下文
 * @param {object} config - 来自 profile patch 的配置
 */
export function apply(ctx, config = {}) {
  const cfg = config !== null && typeof config === 'object' ? config : {};
  const defaultMode = MODES.includes(cfg.defaultMode) ? cfg.defaultMode : DEFAULT_MODE;
  const wantSkill = cfg.registerSkill !== false;
  const wantCommand = cfg.registerCommand !== false;
  const reviewer = normalizeReviewer(cfg.reviewer, ctx.logger);
  const contractPath = join(PACKAGE_ROOT, 'docs', 'reviewer-contract.md');

  /** 每个会话的运行时模式覆盖（进程内，不写会话日志）。 */
  const sessionModes = new Map();

  const effectiveDefault = () => {
    const fromEnv = process.env.SECOND_OPINION_MODE;
    if (typeof fromEnv === 'string' && MODES.includes(fromEnv.trim().toLowerCase())) {
      return fromEnv.trim().toLowerCase();
    }
    return defaultMode;
  };

  /** 某 agent 的模式：自身覆盖 → 最近祖先覆盖 → 默认。 */
  const modeFor = (agent) => {
    const seen = new Set();
    let current = agent;
    while (current !== undefined && current !== null) {
      const id = current.session?.id;
      if (id === undefined || seen.has(id)) break;
      seen.add(id);
      const stored = sessionModes.get(id);
      if (stored !== undefined) return stored;
      const parentId = current.session?.header?.parentSession;
      if (parentId === undefined) break;
      current = ctx.agents?.get?.(parentId);
    }
    return effectiveDefault();
  };

  let warnedMissingHeader = false;
  /**
   * 是不是"根会话"（用户直接开的那个）。
   *
   * 闸门只对根会话注入：子代理拿到这段会白跑一遍它做不到的评审（宿主默认限制子代理
   * 不能再派子代理），而且每轮多背一段上下文。
   * 读不到 header 时按**根会话**处理并告警一次——宁可多注入，也不要因为宿主改了字段路径
   * 就把所有会话的闸门静默关掉。
   */
  const isRootSession = (agent) => {
    const header = agent?.session?.header;
    if (header === undefined) {
      if (!warnedMissingHeader) {
        warnedMissingHeader = true;
        ctx.logger?.warn?.(
          'second-opinion: 读不到 session.header，本轮按"根会话"处理。' +
            '若宿主改了字段路径，子代理会重新收到策略段，请核对 lib/index.js 的 isRootSession。',
        );
      }
      return true;
    }
    return header.parentSession === undefined && header.origin !== 'subagent';
  };

  /** 命令回执里补一句"这个会话到底生不生效"。 */
  const childNote = (agent) => (agent !== undefined && !isRootSession(agent))
    ? '（本会话是子会话，策略段不注入——避免"评审的评审"）'
    : '';

  /** 配置自检：把生效的评审方与"到底会怎么调它"打出来，顺便指出明显缺项。 */
  const checkReport = () => {
    const lines = [`评审方：${reviewerTitle(reviewer)}`, '', reviewerHowTo(reviewer), ''];
    const problems = [];
    if (reviewer.kind === 'subagent') {
      if (reviewer.provider === '') problems.push('reviewer.provider 没配');
      if (reviewer.model === '') problems.push('reviewer.model 没配');
    } else if (reviewer.kind === 'http') {
      if (reviewer.baseURL === '') problems.push('reviewer.baseURL 没配');
      if (reviewer.model === '') problems.push('reviewer.model 没配');
      if (reviewer.apiKeyEnv === '') problems.push('reviewer.apiKeyEnv 没配（密钥不能写进配置）');
    } else if (reviewer.kind === 'command') {
      if (reviewer.command === '') problems.push('reviewer.command 没配');
    }
    lines.push(problems.length === 0
      ? '自检：配置看起来是完整的。（这只是静态检查——能不能真拿到评审，要跑一次才知道。）'
      : `自检发现：${problems.map((p) => `\n  - ${p}`).join('')}`);
    return lines.join('\n');
  };

  // 1) 全局层策略注入：只对根会话。
  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: (context) => {
      const agent = context?.agent;
      if (agent === undefined) return '';
      if (!isRootSession(agent)) return '';
      return modeFor(agent) === 'off' ? '' : POLICY_TEXT;
    },
  });

  // 2) 命令（宿主提供服务时才注册）。
  if (wantCommand) {
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        name: COMMAND_NAME,
        description: '切换第二意见强度（code/always/off）、查看状态或自检评审方配置',
        input: { hint: '[code|always|off|status|check]' },
        handler: ({ agent, rawInput }) => {
          const arg = String(rawInput ?? '').trim().toLowerCase();
          if (arg === '' || arg === 'status') {
            return {
              kind: 'success',
              text: `第二意见：当前 ${agent === undefined ? effectiveDefault() : modeFor(agent)}` +
                `　默认 ${effectiveDefault()}　评审方 ${reviewerTitle(reviewer)}${childNote(agent)}`,
            };
          }
          if (arg === 'check') {
            return { kind: 'success', text: checkReport() + (childNote(agent) ? `\n${childNote(agent)}` : '') };
          }
          if (!MODES.includes(arg)) {
            return { kind: 'error', text: `未知模式 "${arg}"，可用 code / always / off / status / check` };
          }
          if (agent === undefined) return { kind: 'error', text: '当前没有可绑定模式的会话' };
          sessionModes.set(agent.session.id, arg);
          return {
            kind: 'success',
            text: (arg === 'off'
              ? '第二意见已关闭：本会话后续要求直接执行。'
              : `第二意见已设为 ${arg}（${arg === 'always' ? '一律先分析再动手' : '仅代码产出类要求'}）。`) + childNote(agent),
          };
        },
      });
    });
  }

  // 3) 技能注册：细则按需加载，不占用每轮上下文。
  if (wantSkill) {
    ctx.inject(['skills'], (skillsCtx) => {
      try {
        skillsCtx.skills.register({
          name: SKILL_NAME,
          description:
            '先分析、再动手、最后交叉检查的操作细则：怎么写分析、怎么把分析交给配置好的评审方、' +
            '代码与验证完成后怎么复审、多模块任务怎么并行与互查。',
          source: 'runtime',
          content: skillContent(reviewer, contractPath),
        });
      } catch (error) {
        ctx.logger?.warn?.('second-opinion: 技能注册失败 %o', error);
      }
    });
  }

  ctx.logger?.info?.(
    'second-opinion: 已挂载（默认模式 %s，评审方 %s）',
    effectiveDefault(),
    reviewerTitle(reviewer),
  );
}

export default {
  name,
  /** Cordis 要先看到这个声明才允许访问对应服务。 */
  inject: ['systemPrompt', 'agents'],
  apply,
};

/** 给测试用：把内部渲染函数暴露出来，不必通过 apply()。 */
export const __internals = { normalizeReviewer, reviewerHowTo, skillContent, POLICY_TEXT };
