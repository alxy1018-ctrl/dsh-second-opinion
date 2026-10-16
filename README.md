# dsh-second-opinion

中文 | [English](README.en.md)

> **A second opinion for coding work (DeepSeek Harness plugin).** Analyze before acting, have the analysis reviewed by a second brain, then cross-check after the code is written and again after verification. The reviewer is yours to choose — a host subagent, any OpenAI-compatible endpoint, or a command you write; the plugin binds no vendor. Full English documentation: **[README.en.md](README.en.md)**.
> The discipline text the plugin injects is in Chinese; the reviewer slot and all configuration are language-neutral.

给编码工作加一道**第二意见**：动手前先分析、把分析交给另一个脑子看一眼，代码写完和验证做完再各看一次，
多模块任务时两边分头写、互相查。

DeepSeek Harness 插件。**评审方是谁由你定**——子代理、任意 OpenAI 兼容端点、你自己写的命令都行，
插件本身不绑定也没有任何厂商默认值。

- 纪律（每轮注入）：`lib/index.js`
- 做法（按需加载的技能）：同一文件里的技能正文
- 接口（怎么接自己的评审方）：[`docs/reviewer-contract.md`](docs/reviewer-contract.md)
- 参考适配器：[`adapters/http.mjs`](adapters/http.mjs)、[`adapters/exec.mjs`](adapters/exec.mjs)

---

## 它解决什么

Agent 收到"改个东西"的要求时，最容易出的事不是写不出来，而是**动手太快**：
需求读错一半、顺手重构、加了个用不上的依赖、边界条件只写了 happy path。
这些毛病自己看不出来——写的时候你觉得都对。

所以这里只做三件事：

1. **先分析，不动手**：真正要解决的问题、验收标准、改动面、必须沿用的既有约定、不确定项。
2. **要第二意见**：把《要求原文 + 分析》交给另一个评审方，让它专门挑毛病。
3. **最后交叉检查**：代码写完复审一次、验证做完再复审一次；多模块时你写它查、它写你查。

## 一次真实流程长什么样

```
你：把 X 模块改成支持批量导入

agent：先给分析（真正的问题 / 验收标准 / 改动面 / 既有约定 / 不确定项）
       → 送 requirement 评审 → 合并意见 → 动手
       → 送 code 评审（diff 的关键 hunk）→ 修真实缺陷
       → 跑验证 → 送 test 评审 → 报告结果
```

评审结论留在内部，**不会把内部讨论记录贴给你看**——你拿到的是结果和它为什么这么做。

## 安装

```powershell
dsh plugin --profile desktop add github:alxy1018-ctrl/dsh-second-opinion
```

> ⚠️ 从 GitHub 安装要 `git` 已装好，**而且 DSH 是在装完 git 之后启动的**。
> 装 git 后不重启 DSH，会报 `'git' 不是内部或外部命令`——DSH 那句"去看 allowBuilds"的提示是误导，**重启就好**。

## 配置

写在 profile patch 里，只有 `reviewer` 是必须想的，其余都有默认值：

```yaml
- id: second-opinion
  name: 'dsh-second-opinion'
  config:
    defaultMode: code          # code | always | off
    reviewer:
      kind: subagent           # subagent | http | command | none
      provider: <你的路由>
      model: <你的模型>
      label: 我的评审方          # 可选，只影响显示
```

模式还能用环境变量覆盖（优先级：环境变量 > 配置里的 `defaultMode`）：`SECOND_OPINION_MODE=off`。
⚠️ 环境变量是**进程级**的，在长驻的 DSH 里会影响之后所有会话（命令切换则是每会话的）——
日常用 `/second-opinion` 切，别用环境变量。

### 四种评审方

| kind | 一句话 | 适合谁 |
|---|---|---|
| `subagent`（默认） | 复用宿主已有的子代理路由 | 已经有别的模型路由，想直接拿它当评审方 |
| `http` | 任意 OpenAI 兼容端点 | 有自建网关 / 本地推理 / 云 API |
| `command` | 你自己的命令，stdin 进 stdout 出 | 想把规则库、脚本、别的 CLI 当评审方 |
| `none` | 不设评审方 | 只要纪律，不要第二意见 |

**`subagent`（默认）** —— 不绑厂商，路由你自己给：

```yaml
    reviewer:
      kind: subagent
      provider: 你的-provider-id
      model: 你的-model-id
```

**`http`** —— 端点、模型、密钥变量名全都由你给：

```yaml
    reviewer:
      kind: http
      baseURL: https://api.example.com/v1
      model: your-model
      apiKeyEnv: YOUR_API_KEY     # **变量名**，不是密钥本身
      timeoutSeconds: 180
```

**`command`** —— 把契约 JSON 从 stdin 喂进去，读它的 stdout：

```yaml
    reviewer:
      kind: command
      command: node D:/tools/my-reviewer.mjs --json
```

**`none`** —— 分析与交叉检查照旧，只是不送评审。

**换成什么都行**：契约（送什么、要什么、失败怎么表达）写在
[`docs/reviewer-contract.md`](docs/reviewer-contract.md)，照着实现一个适配器即可，语言不限。
本包自带的两个参考实现可以直接抄（`adapters/http.mjs`、`adapters/exec.mjs`）。

## 命令

```
/second-opinion status     看当前模式与评审方
/second-opinion check      自检：把生效的评审方和"到底会怎么调它"打出来，顺便指出缺项
/second-opinion code       只对代码产出类要求生效（默认）
/second-opinion always     一律先分析再动手
/second-opinion off        本会话关掉
```

模式切换是**每会话**的进程内状态，不写会话日志，重启回默认。

## 边界（先说清楚，省得你踩）

- **评审方只是参考，不是关卡。** 它可能误读、可能提纯风格偏好、可能要求加你用不上的东西——
  该驳回就驳回，并在心里记一句理由。
- **拿不到评审不卡住。** 评审方超时、报错、没配、没授权，agent 照自己的分析继续干，
  最后用一句话告诉你原因。**它不会为了拿评审把同一段载荷反复重发**——那是最费时间和 token 的做法。
- **策略段只注入根会话。** 子代理收不到。原因：子代理拿到这段会白跑一遍自己做不到的评审
  （宿主默认限制子代理不能再派子代理），而且每轮多背一段上下文。
- **插件进程内不发起任何调用。** 它只往上下文里写纪律和调用约定，真正的评审由 agent 用宿主已有的
  能力发出（子代理 / HTTP / 本地命令）。在插件进程里发 HTTP 还要顺带管凭据，
  会带来超时、沙箱 ACL、凭据解析脆弱一堆问题——这里不干那件事。
- **零外部依赖。** 只用 `node:` 内置模块：插件装在 profile 里，向上找不到 `node_modules`。
- **密钥只从环境变量读。** 配置里写的是**变量名**。命令行参数会被打印进错误信息和会话日志，
  这是有过真实事故的。

## 生效方式

| 改了什么 | 怎么生效 |
|---|---|
| `lib/index.js` 里的策略段 | **重启客户端**（插件本体不重载） |
| 技能正文（评审方配置渲染在里面） | 同上——它在插件加载时一次性生成 |
| profile 里的配置 | 随上面两条 |

实测过：改完文件后新开的会话，拿到的仍是**旧**文本。改完一律重启，再用新会话确认。

## 自检

不需要网络、不需要装进 DSH、不需要任何依赖：

```powershell
node test/run.mjs      # 或 npm test
```

它覆盖两件事：**插件层**（用假的 Cordis 上下文调 `apply()`，检查注册了什么、四种评审方的正文各生成成什么样、
非法配置会不会被挡下）和**适配器层**（起一个本地假端点验 HTTP 适配器、跑真实子进程验 exec 适配器）。
它证明的是这段代码本身对不对；**不能**证明线上注入行为——那要装进 DSH、重启、真跑一次。

## 它是怎么和宿主对齐的

"插件代码对不对"和"插件在 DSH 里对不对"是两件事。这里把对齐到什么程度说清楚：

- **策略段注入**走 `ctx.systemPrompt.section({ text })`。`text` 回调收到的 `context.agent`
  是**正在装配的那个 agent**——宿主里是 `systemPrompt.assemble(assembleContextFor(agent, signal))`，
  而 `assembleContextFor` 的实现就是 `return { agent, scope: agent, ... }`。
- **"是不是根会话"**判的是 `agent.session.header` 上的 `parentSession` / `origin`；
  这两个字段在宿主的 `SessionHeader` 接口里有定义。本机 60+ 个会话的落盘记录也印证了：
  子代理一律 `origin="subagent"` + 有 `parentSession`，用户直接开的会话两者都没有。
- **子代理不能再派子代理**（宿主默认 `maxDepth = 1`），所以"策略段不给子代理"省下的是
  子代理白跑一遍和每轮一段上下文，而不是防住一个无限递归。

以上是对着 **DSH 0.2.0-rc.2** 的实现核出来的，不是猜的。宿主改字段名的话，
`lib/index.js` 里那条一次性告警会指向具体位置。

**但这些对齐不等于装上去就能跑**——见下一节。

## 与 dsh-code-review-gate 的关系

同一作者的另一个插件 [dsh-code-review-gate](https://github.com/alxy1018-ctrl/dsh-code-review-gate)
把"先评审再动手"钉进了每轮上下文，但评审方是写死的一种。这个仓库是那个思路的再创作：

- 保留：先分析 → 再动手 → 最后交叉检查；拿不到评审不卡住；只对根会话注入；并行时文件所有权独占。
- 改掉：**评审方从"写死"变成"由你接"**——契约 + 参考适配器，插件不 bind 任何厂商。
- 顺带：把"某阶段拿不到评审"从"整体降级"改成"**按阶段降级**"，纪律照旧生效。

## 已知未完成

- **没有在真实 DSH 实例里跑过端到端。** 本仓库的验证是进程内桩测试 + 本地适配器测试；
  "装进 profile、重启、真拿到第二意见"这条路还没走通过一次。第一次装的时候留意
  `/second-opinion check` 的输出。
- **`subagent` 形态依赖宿主提供子代理工具**，并且要在设置里授权那些模型路由。
  没授权时它不会退回别的形态，只会告诉你"这次没拿到评审"。
- **只有两个参考适配器**（HTTP / 本地命令）。其它形态（gRPC、消息队列、别的 agent 框架）
  得自己写——契约在 `docs/reviewer-contract.md`。

## License

MIT
