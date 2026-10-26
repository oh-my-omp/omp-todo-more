# omp-todo-more

[English](README.md) | 简体中文

OMP 的富信息 Todo 插件。替代原生 `todo`，保留标题寻址、阶段进度、提醒、planning 检查与 `task:*` 子会话行为；列表包含 goal，以及每项 explanation 和模型预估耗时。

## 安装与启用

```sh
omp install https://github.com/oh-my-omp/omp-todo-more
```

插件入口是包根 `index.ts`，由 `package.json` 的 `omp.extensions` 声明。使用插件前在 OMP 配置中关闭原生 Todo：

```yaml
todo:
  enabled: false
```

不要同时加载旧的本地 `extensions/todo-more/`。已在用 omp-config 的机器，旧模块在独立插件安装并通过运行验证后，由 omp-config 更新器执行受门禁保护的退休。

本地开发使用 `omp plugin link <package-directory>`。运行验证应使用 `/tmp` 下无开发 `node_modules` 的源码副本；类型检查不能证明 OMP 二进制能加载 host imports。

## 界面语言

Todo More 会本地化面向人的标签、卡片、提醒、编辑器和通知。设置
`OMOMP_LANG=en` 或 `OMOMP_LANG=zh`（不区分大小写）即可选择语言；未设置时，
插件从 OMP agent 目录中唯一的 `omomp.yml`、`omomp.yaml`、`omomp.json` 或
`omomp.toml` 读取 `omomp-lang.language`，再依次回退到 `LC_ALL`、
`LC_MESSAGES`、`LANG`，最后使用英语。配置修改在下次进程启动时生效。命令名、
配置键、协议值、面向模型的 prompt 和返回模型的 tool-result 内容保持不变。

## 工具与状态

模型每次调用发送一份 Todo 文档。支持 custom-tool 的 OMP provider 使用 edit 风格的 Lark grammar；普通 function-tool provider 发送 `{input: "<同一份文档>"}`，两者共用解析和执行路径。

一次初始化全部阶段和任务：

```text
*** Begin Todo
INIT "交付流式 Todo" "真实用户路径通过" "实现与运行验证完成"
PHASE "实现"
ADD "实现文档解析" "接受完整文档并保留任务标题的精确身份" 20
ADD "显示流式预览" "显示意图但不改变已保存状态" 10
PHASE "验证"
ADD "验证已安装工具" "检查真实工具与恢复结果" 15
*** End Todo
```

后续一次调用合并相关编辑：

```text
*** Begin Todo
DONE "实现文档解析"
START "显示流式预览"
EXPLAIN "显示流式预览" "检查 ANSI 与 native 调用预览"
ESTIMATE "显示流式预览" 12
PHASE "验证"
ADD "检查任务历史" "确认已接受操作的顺序" 5
*** End Todo
```

命令使用大写，每条占一个物理行。字符串按 JSON 规则加引号；`\"`、`\\`、`\n` 保留引号、反斜杠和多行正文，不 trim 完整 title。

|命令|语义|
|---|---|
|`INIT "objective" "measure" "doneWhen"`|替换列表与 goal，只能作为第一条且至多一次；紧随的 phase/add 合成一次初始化。|
|`PHASE "name"` 后跟 `ADD "title" "explanation" minutes`|追加一个或多个显式估时的任务，阶段不存在时创建；每个追加块必须有自己的 phase。|
|`ESTIMATE "title" minutes`|补齐或修订任务总预算，不重置已耗时间。|
|`GOAL "objective" "measure" "doneWhen"`|完整替换非空列表的 goal，不改变任务状态或时钟。|
|`START "title"`|选择当前 active 任务。|
|`EXPLAIN "title" "explanation"`|替换任务解释。|
|`DONE target`、`DROP target`、`RM target`|完成、放弃或删除带引号的 title、`PHASE "name"` 或 `ALL`。|
|`DONE target "message"`、`DONE target "paths" "message"`|完成并提交：全部改动，或仅列出的 pathspec。|
|`BLOCK target ["reason"]`、`UNBLOCK target`|阻塞或解除阻塞带引号的 title 或 `PHASE "name"`；均不接受 `ALL`。|
|`VIEW`|只读列表，必须是文档中唯一命令。|

每个 ADD 必须由模型提供正整数分钟估计，不默认、不取整；最大为 `Math.floor(Number.MAX_SAFE_INTEGER / 60_000)`。缺失或非法估计拒绝整份文档。PHASE 只作用于紧随的 ADD，不限定状态命令；空阶段块无效。INIT 的首个 ADD 没有 PHASE 时使用 `"Tasks"`。任务 title 和初始化中的 phase 名必须唯一。`"ALL"` 是标题，裸 `ALL` 才是 selector。

ANSI 与 native 调用卡片将完整命令行和未完成末行显示为未提交预览。卡片是这次调用的 pending 视图：执行结果返回后由结果视图替换它，因此一次调用只画一张卡片，预览不会叠在它所预览的列表之上。生成或取消前缀都不改变 Todo。执行读取当前分支，严格解析完整文档，在 working copy 按顺序应用逻辑操作，最后一次提交；语法、目标或规则错误拒绝整批。

任务操作保留 progress normalize 和 `transitionTime`。同一接受批次中的状态转换共享一个墙钟锚点，只在 working copy 短暂 active 的任务不累计虚假的命令处理耗时；GOAL 与 VIEW 不 normalize 或改变任务时钟。

空列表不携带 goal。导入列表缺 goal 时，必须先写 GOAL。RM ALL 或删除最后一项后，working copy 丢弃 goal，后续追加不能继承；创建下一份列表应使用 INIT。

当前会话分支是唯一权威。改变状态的成功批次只追加一条完整 `mouriya.omp.todo-more` snapshot，并更新一次宿主 TodoTracker 投影。结果保留 `todoMore: true`、`details.more`、原生兼容 phases、storage 和完成 transitions。`details.op` 为操作名或 `"batch"`，`details.operations` 列出操作名；仅成功 mutation 返回 `details.changes`，记录按顺序实际应用的结构化操作，包括 ADD 的预算、ESTIMATE 值以及每个 `DONE` 的提交子句。VIEW 和失败不产生 accepted changes。

reader 按标题联结宿主 `user_todo_edit` 与旧原生工具结果：已知标题保留 explanation 和计时元数据，新标题缺少两者；原生空 snapshot 中断此前 goal、explanation 和计时元数据的继承。自有 marked 工具结果不重复作为状态记录读取。现有 reader 忽略格式无效的记录；本次迁移不更改这项兼容语义。

同步追加确认的是当前分支接受记录，不是磁盘 durable-write 确认。文件写入、flush 和磁盘失败处理属于 OMP SessionManager 生命周期；退出后 resume 是正常持久化路径的验证方式。

### 估时与超时警告

`ESTIMATE "title" minutes` 用于补齐或修订任务总时间预算。旧 snapshot 和原生入口创建的项为 `time.kind: "missing"`；模型必须显式估时，系统不倒推未知历史耗时。首次补估计时，已经 active 的项从接受批次的锚点开始计时。

|任务变化|计时行为|
|---|---|
|进入 `in_progress`|开始一个墙钟区间。|
|离开 `in_progress`，变为 pending、blocked 或关闭状态|累计当前区间并暂停。|
|恢复或显式重新开始同一项|保留累计时间，开始下一个区间。|
|重复 `start`、执行 `view`、编辑 explanation/goal|保留原有计时。|
|修订估计|保留累计时间及正在运行的区间；数值变化会创建新的预算身份，同值是 no-op。|
|删除后重新创建|新预算不继承被删除项的耗时。|

只要持久状态仍为 `in_progress`，会话 idle 或进程停止期间也继续累计墙钟时间；这不是 CPU 时间统计。原生状态变化使用对应 session entry 的 timestamp 结算。

插件只保留距离最近的 active 预算 deadline 的一个单次 timeout；todo 相关 journal 写入或 session/branch 变化时重新调度，不进行周期轮询，也不在 end hook 检查 deadline。原生 `/todo`、延后持久化的 native 工具结果以及已接受的 rich commit 都在 journal 写入方法上被观察，即使宿主投影失败也不会漏掉变更。普通消息不触发分支读取，collaboration 所有的 append callback 保持不变。到点 callback 重新读取当前分支后请求注入；超长等待仅按平台 timeout 上限分段。

每个超时 active 预算在正常投递路径收到一次系统警告。修订后的新预算也有一次警告机会；如果保留的累计时间已经超过新预算，会再次告警。排队消息只是投递意图；实际 `mouriya.omp.todo-more.overtime` custom-message entry 才是通知事实，普通 compaction 保留分支 journal 中的这些记录。警告不复制进 item snapshot，重新加载时按分支重建 timeout。

到点时，运行中的会话立即收到 aside 注入请求；宿主在下一个安全 step boundary 将警告提供给模型，不取消工具批次。检测和排队不等待 step 结束。idle 时警告立即追加到 transcript 和 context，但不启动模型 turn，因此不会撤销人工停止。shutdown 取消 timeout 并恢复被观察的 journal 方法；重新打开已超时的 active 项时重新检查。

警告指出任务、预计时间与已耗时间，并要求 agent 保持预期结果、验收标准和质量，核实超时原因、判断是否改变方针、继续推进完整任务。警告推荐与 subagent 讨论原因和方针；子会话可与 parent 沟通。插件不自动创建 agent、不改变任务 status、不降低 goal。估计是预测而非硬 deadline，agent 不得仅为掩盖超时而重建列表或抬高预算。


### 完成与 git 关联

`DONE` 可以携带这次完成所欠的提交。提交由 todo 工具自己经宿主 git 绑定完成（`@oh-my-pi/pi-natives/vcs`，按整文件从会话目录暂存），因此列表里不会出现 git 并未产生的提交：

```text
DONE "实现文档解析" "接受完整文档"                                  # 全部改动
DONE "显示流式预览" "src/render.ts" "显示流式意图"                 # 仅该 pathspec
```

一个字符串是提交信息，提交全部未提交改动；空 scope 字符串 `DONE "title" "" "message"` 含义相同。两个字符串依次是空白分隔的 scope 与其提交信息；pathspec 相对会话目录解析，与模型自己的 shell 一致。该 `DONE` 完成的每个任务都会记录被 git 接受的提交（sha、message、解析后的 scope），summary、native 卡片、snapshot 与 ctx task log 都会显示。

git 记录的提交信息在 message 之后，为提交方会话自上一次 todo 提交以来运行过的每个模型写一行 `Model: <provider>/<model-id>` trailer：范围是分支上最后一个带来新提交的 snapshot 之后的 assistant 轮次（失败的请求除外），再加上会话当前模型，按首次出现顺序去重。只记录提交方会话自己的模型：`task:*` worker 自己提交自己的改动并记录自己的模型。任务上保留的 message 不含 trailer；用 `git log --format='%(trailers:key=Model,valueonly)'` 读回模型。没有任何模型记录时只提交 message。

不在 checkout 内，或工作区没有未提交改动时，该子句是惰性的：不产生提交，参数无论是否给出都被忽略。在存在未提交改动的 checkout 内，不带子句的 `DONE` 会被拒绝并要求补上子句——被拒绝的是这次完成，不是检查本身。scope 按原样提交，工具不会校验它是否覆盖了全部未提交改动；暂存不到任何内容的 scope 会带着 git 自己的回答被拒绝。同一批次中的每个 `DONE` 提交该时刻仍存在的未提交改动，因此同批次后续子句面对干净工作区时会保持惰性。

## 子会话与提醒

每个会话独立持有列表。插件在 `before_agent_start` 恢复 `task:high/mid/low/free` 被宿主剥离的 todo；tool-restricted 会话通过宿主工具槽安装。保留 stop reminder、mid-run nudge、eager prelude、goal-mode context 与 request-only 用户提醒。人工中断不自动恢复。

主会话在没有文本答复时中途停下（provider 错误、仍有未完成的 tool call、非人为的 abort），提醒在 10 秒宽限后发送；期间出现新一轮、排队消息或输入框草稿则不发。账户额度用尽的 429 改为等到额度重置后一分钟：错误带有重试提示时取 provider 给出的时间，否则取 omp 对该限额的估计（额度用尽为 30 分钟，并标明为估计）。等待期间输入框上方显示一行不抢焦点的提示，写明发送时间与原因；到点时输入框仍有草稿则等草稿清空后再发。`Ctrl+N` 或 `/todo-more-cancel` 取消待发提醒；提交消息、切换会话或分支、退出也会取消。待发提醒不跨进程保留。

planning guard 在真正执行 edit 时读取当前分支，不在工具批次预检时判断；Todo INIT/edit 或 RM/edit 序列因此按 edit 执行时已接受文档的列表检查。

## 只读 review 协议

同一会话的 `ExtensionAPI.events` 提供同步 channel `omp-todo-more:read`。请求为 `{agentId, reply(value)}`，owner 从该 agent 当前分支读取并在 emit 返回前回复：

```ts
type TodoMoreReadResponse =
  | {
      kind: "ok";
      goal: { objective: string; measure: string; doneWhen: string } | null;
      openItems: readonly { phase: string; title: string; explanation: string | null }[];
    }
  | { kind: "unavailable" };
```

只返回 pending/in_progress 项；missing goal/explanation 为 null。无会话或读取异常是 unavailable，不是空 Todo。通道不写状态、不提供 watch，不安装 Tern、不导出内部 reader。监听器在实例 session_shutdown 取消，子会话使用自己的 bus。

completion judge 应在构造模型 prompt 前请求一次，并在模型返回后、检查 openItems 前再次请求；不可用时沿用 warning + fail-open。ctx 历史消费者从成功的 `details.changes` 记录每个已接受逻辑操作及其显式 goal 替换，不把历史当作当前 Todo 状态。

## 编辑与提交

GUI 编辑意图只有 `set_goal` 和按完整 title 的 `explain`，编辑本身不生成模型工具调用。保存重新读取对应 session 的当前分支：只覆盖目标字段，任务的最新 phase/status/blocker/order、时间预算、计时和其他字段全部保留。空列表拒绝编辑，missing goal 必须先设置；删除或改名的任务不因旧草稿恢复。

工具 mutation 与 GUI 保存共同调用 `commitTodoState`。同步追加后重读同一分支确认接受，再更新宿主投影。失败区分 branch acceptance 与 projection：后者不回滚已接受记录，工具返回 error 与最新权威 details，GUI 保留草稿和错误。相同值不追加 snapshot；重投影允许修复此前的部分 projection failure。`view` 保持纯读。

## 原生展示与编辑

Todo More 在 Tern 保留真正的原生 `checklist` HUD 作为药丸、进度环、标题、计数、字体和 skin 外观的视觉来源。替代实现占据原生 activity track，沿用 `omp.hud.todo` 的尺寸和对齐规则。Objective、Measure、Done when、全部 phase/task、五种 status、预估耗时、explanation 和 blocker 仍作为完整富内容展示；goal 不伪装成任务，不影响进度。

原生 bare card 的 disclosure head 是唯一交互入口，其原生 toggle 事件和受控 `collapsed` 属性驱动一份绑定 session 的展开状态。只用于视觉的 checklist 按钮保持隐藏、不可聚焦，仅显示其非交互的进度环、标题和计数；其本地 HUD popover 从不激活。Escape、进入编辑器、列表变空、查看会话变化或 widget dispose 都会关闭富内容并移除输入监听。

沿用原生尺寸的 Todo wrapper 包含 disclosure 及其同级富内容 popover，因此悬停富内容不会高亮药丸。popover 直接沿用原生 `.sf-ck-pop` 的定位：右对齐、在药丸上方保留 8px 间距、360px 宽度、420px 最大高度及 12px/14px padding，同时保留前置 HUD 行的原生条件间距、玻璃、阴影和动画。popover 自身是唯一滚动区，内层 details 保留自然内容高度；超过原生上限时，可以从 goal 滚动到最后任务和编辑按钮，再滚回顶部。该路径不使用 generic portal、方向翻转、下方托盘或独立的 viewport/composer 高度计算。

appearance、命名主题与对应 program palette 的切换通过原生 renderer 和继承变量即时生效，包括富内容已经展开时。插件不保存主题副本，保留原生药丸尺寸和字体，不冻结主题颜色或字体度量。

`INIT` 与 `VIEW` 工具卡片展示完整列表；日常增删改工具卡片折叠时只展示当次变更的任务或 goal，展开时恢复当次完整 `details.more` 快照。主动提醒只显示提醒事件头部，不列出任何任务。历史工具卡片使用当次 `details.more`；工具卡片与提醒都不成为编辑源，也不随当前列表编辑而改变。

Tern 的主会话输入区中，`/todo` 与 `/todo edit` 打开富信息 `/todo-more` 编辑器。聚焦子会话时保留宿主的 slash-command 限制，可使用该子会话 popover 的 Edit 按钮进入其富编辑器。其余 `/todo` 子命令（包括 expand/collapse）保留宿主行为；Todo More 的原生 disclosure head 控制富信息展开。任务变更按前述规则按标题联结。普通 ANSI OMP 保留宿主命令和 HUD，替代 widget 不输出 ANSI 行。

在 OMP/Tern 的主会话输入 `/todo-more` 打开其编辑 overlay。Tab/Shift+Tab 或上下方向键选择动作，当前动作以 accent 标记，Enter 打开它；任务删除后选择位置按当前列表收敛。进度 popover 的编辑按钮进入同一个编辑器，不另建编辑实现。

`Edit goal` 使用三个有标签的宿主 Editor 草稿，Tab/Shift+Tab 切换当前字段。Tern 同时只把当前字段描述为 live editor，其余字段仍可见且可点击激活；编辑与 undo 由原有 Editor/FormField 处理。`Edit explanation` 打开目标标题的 multiline Editor。普通 Enter 保留换行，Ctrl+Enter 或 Save 保存，Escape/Cancel 丢弃草稿；关闭面板不提交。保存错误保留草稿并显示原因，成功重新读当前分支。编辑本身不启动模型 turn。

进度 widget 每次原生渲染读取当前查看会话（含聚焦的 task 子会话及嵌套子会话）的当前分支，在 switch/branch/tree 后重新安装；空列表不显示进度卡片。编辑 overlay 绑定打开时的 session，查看目标改变或 switch/branch/tree/shutdown 会取消旧 UI 与草稿。Save 再次核对目标，将记录追加到该 session 自己的分支，再更新其宿主投影。没有交互 UI 时编辑命令报告不可用，不改变 Todo。

## Tern 资产生命周期

包附带 `tern/plugin.toml`、`todo-more.css`、`window.luau`。药丸视觉、展开控件、完整 checklist 和编辑由 OMP native components 提供；window entry 满足 stylesheet manifest 契约，不建立领域状态存储或编辑器。样式仅作用于 `omp.session` surface，将原生 Todo 设为不可见但保留其真实布局占位和宿主任务投影。

当前 OMP native dock 有十三个源插槽。CSS grid 适配保留各插槽，将 Todo More 放入原有 activity track，其他 below-editor widget 仍按正常顺序显示。popover 在沿用原生尺寸的 Todo wrapper 内绝对定位，与 disclosure 同级，不建立单独 layer、anchor 或 allocation canvas。适配同时保留原生条件 HUD clearance、skin 变量以及 Spine 的 widget 间距、padding 和背景带。该实现依赖 OMP dock 拓扑、Tern checklist 视觉及 card head/body 结构，升级后须重验几何、焦点、多 widget 与实时主题切换；不修改宿主源码或二进制。

Tern 样式插件必须与 OMP 扩展成套启用。Tern 插件启用期间，样式会隐藏原生 HUD，包括没有加载本 OMP 扩展的会话；禁用或移除 Tern 插件会恢复原生 HUD。Tern CSS 不支持 `:has()` 条件，不承诺 OMP 扩展缺失时自动回退原生 HUD。

async 工厂先 await `initializeTernPlugin`，然后注册工具和 UI。资产目录从模块相对路径定位；通过真正的 `tern plugin dir/list/install --json` 请求 owner，校验 catalog 与三文件 normal copy。相同 ready/disabled 副本不重新安装；需要更新时使用 `install --force`，等待后复查身份、版本、destination、catalog 和文件内容。保留用户 disabled 设置，不执行 unlink 或自动 enable。

本加载图只有一个初始化 Promise，prepared 子工厂复用它，但每个 session 仍独立注册工具、hooks 与 read listener。Tern 不在 PATH 时允许 ANSI OMP 使用，不代表 GUI 验收完成。Tern 存在时的 CLI、解析、安装、linked 冲突或复查失败会拒绝工厂初始化；原生 todo 已关闭的机器此时不会得到本插件工具，不能把 warning 当成成功。磁盘安装验收也不替代真实窗口的 CSS 和编辑路径验证。

Tern 的 headless `serve` 不自动加载已安装插件。原生 UI 验证需要通过隔离测试文档的 control endpoint 加载随包 stylesheet，或使用真实 Tern 窗口；必须核对实际进度卡片、popover 和编辑器，不能只检查 catalog。

## 开发

```sh
bun install
bun run format
bunx tsc --noEmit
bun test
```

host peer dependencies 使用 `*`，开发依赖使用 `latest`；无需 bundler 或编译产物。运行状态、凭据、开发依赖和 lock 文件不属于交付包。
