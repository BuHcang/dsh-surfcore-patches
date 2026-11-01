# dsh-surfcore-patches

给 **「独立进程型」DSH 伴侣程序**（SurfCore、dsh-bili-scroll 之类）打本地补丁的管家。

> 这类程序不是 DSH 插件，而是自己跑的 node 进程；DSH 插件碰不到它的内存和提示词，而它自己的升级方式又是**整目录换 zip** —— 手改的代码一升级就没了。
> 本工具把「手改」整理成可复现的**锚点补丁**：升级后一条命令贴回去、贴完体检、贴坏了回滚。

## 它解决什么

| 问题 | 以前 | 现在 |
|---|---|---|
| 升级冲掉改动 | 靠记忆一处处重贴 | manifest 里记着锚点，`apply` 一次贴完 |
| 不知道贴没贴 | 翻源码 | `check` 列每一条：已贴 / 待贴 / 锚点失效 |
| 贴错地方 | 静默贴到第二处 | 锚点必须**恰好命中一次**，0 次或 2 次都拒绝写入 |
| 贴完炸了 | 手动找备份 | 每次改前自动备份整文件，`revert` 一键还原 |
| 版本对不上 | 直接贴、结果错位 | `knownVersions` 矩阵，未适配版本默认只体检 |

## 快速开始（命令行，不需要 DSH）

```bash
# 体检：当前版本、每条补丁的状态
node bin/cli.mjs check --target surfcore --root /path/to/surfcore

# 演练：只报告会改什么，不写文件
node bin/cli.mjs apply --target surfcore --root /path/to/surfcore --dry-run

# 真贴（改前自动备份到 ~/.dsh/surfcore-patches/backups/）
node bin/cli.mjs apply --target surfcore --root /path/to/surfcore

# 体检（含语法检查）
node bin/cli.mjs doctor --target surfcore --root /path/to/surfcore

# 回滚到上一次 apply 之前
node bin/cli.mjs revert --target surfcore --root /path/to/surfcore
```

装进 DSH（可选，带设置页）：

```bash
dsh plugin --profile desktop add link:/path/to/dsh-surfcore-patches
# 或在 profile 的 dsh.profile.bundles 里加 "dsh-surfcore-patches"
```

设置页出现「补丁管家」：每个目标显示版本 / 已贴数 / 待贴数，三个按钮 **体检 / 应用补丁 / 回滚**。

## 安全三条（默认值就按这个来）

1. **默认只体检**（`autoApply: false`）：动的是别人的源码，必须人点一下。
2. **锚点唯一性**：每条补丁的锚点必须恰好命中 1 次；命中 0 次（上游改了）= 报 `missing`，命中 2 次（锚点太泛）= 报 `ambiguous`，两种情况**一个字节都不写**。
3. **贴前备份、贴后验语法**：改前把整个文件复制到 `backups/<target>-<version>-<时间>/`；贴完对每个改过的 `.js` 跑 `node --check`，不通过就报错让你回滚。

## 补丁怎么描述（manifest）

```jsonc
{
  "schema": 2,
  "id": "surfcore",
  "title": "SurfCore",
  "detect": { "file": "package.json", "nameField": "name", "versionField": "version", "equals": "surfcore" },
  "knownVersions": ["0.8.6"],
  "copy": [
    { "from": "payload/surfcore/custom/index.js", "to": "src/custom/index.js" }
  ],
  "patches": [
    {
      "id": "turn-guard/state",
      "file": "src/bridge.js",
      "kind": "insertAfter",         // 或 replaceRange
      "anchor": "  const v2TurnStartAt = new Map();",
      "insert": "\n  const v2TurnLastEventAt = new Map();",
      "marker": "[LOCAL-HOOK turn-guard/state]"   // 源码里出现它就算已贴
    },
    {
      "id": "settings/send-zero",
      "file": "plugins/surfcore/lib/client.js",
      "kind": "replaceRange",
      "start": "        F(\"socialV2.send.maxSendPerMinute\", …",
      "end":   "        F(\"socialV2.send.maxSendPerHour\", …",
      "replacement": "…",
      "marker": "[LOCAL-HOOK settings/send-zero]"
    }
  ]
}
```

- `copy`：把 payload 文件整份放进目标目录（新增模块用这个；已有的会先备份再覆盖）。
- `kind: insertAfter`：在锚点那一行的行尾后插入，**本身要带换行**。
- `kind: replaceRange`：把 `start` 到 `end`（含）整体换成 `replacement`。
- `marker`：幂等标记，写进替换文本里。**同一文件里多条补丁按顺序叠加**。 已贴的补丁永远跳过。

## 它装了哪些补丁（SurfCore 0.8.6）

补丁分两类：**改源码的锚点补丁**（`manifests/surfcore-0.8.6.json`）和**整份放进目标目录的新模块**（`payload/`）。下表就是它们合起来做的事。

| 组 | 补丁 id | 做了什么 | 为什么 |
|---|---|---|---|
| 生命周期 | `turn-guard/state` `turn-guard/heartbeat` `turn-guard/dead-turn` | 记录每个回合最后一次收到事件的时刻；超过 `socialV2.turnIdleMs`（默认 180s）没有任何事件就判定这个回合已死，解除忙碌并重放积压消息 | DSH 侧回合卡死时 `turn/end` 永远不来，桥会一直当它「在忙」，表现是「发消息不回」 |
| 生命周期 | `turn-guard/approval-silent` | 审批请求直接静默放行（`allowed-once`），不再往 QQ 发「🔐 agent 请求审批」 | 它没有终端可以点同意；把审批问句发到群里也毁人设 |
| 人物 | `custom/note-incoming` `custom/auto-at` | 每条来信按 QQ 记名字/外号/所在群/熟悉度；群里提到某人时自动带上 `at` 段 | 上游没有「按人」的记忆，只有按会话 |
| 人物 | `custom/prompt` | 私聊注入【你认识的人】、群聊注入【这个群里的人】+【对群友的印象】 | 让她知道谁是谁、跟谁熟到什么程度 |
| 表达 | `custom/split` | 发送前把「一句话里塞了两截意思」按空格/句末标点拆成多条（≤3 条，URL 不拆） | 一条一句才像人在打字 |
| 作息 | `custom/wake-gate` `custom/timer-reasons` `custom/nap-wake` | 按 `socialV2.rhythm` 算「清醒 / 短醒 / 深睡」；深睡只放行主人私聊；短醒只处理 @ 她的群消息并按 90 分钟一次自己醒 | 省 token，同时保留「偶尔醒一下」的活人气 |
| 旁听 | `custom/group-listen` | 清醒时段每 25–50 分钟自己翻一眼群（每次 ≥3 条未读才翻，日上限 8 次） | 没人叫她也知道群里在聊什么 |
| 跨会话 | `custom/cross-context` | 私聊里注入【你刚在别处】：其它窗口最近说过的话（3 小时窗口、≤4 行、跳过已进记忆卡的句子） | 各窗口共享一段历史，人设才不会断片 |
| 额度 | `custom/budget` `custom/farewell-var` | 用量到 `budgetOfflineRatio`（默认 95%）时，先在当前会话把话说完、道别、然后这一天不再回这里；主人私聊始终开放 | 到顶了要有个交代，而不是突然消失 |
| 传话 | `custom/relay-token` | 主人私聊的令牌可以往白名单群里发（其余组合一律不放） | 「帮我去群里叫个人」要能真的发出去 |
| 时间 | `custom/time-line` | 把【当前时间】放到提示词末尾 | 放在最前面会让每轮前缀都变，毁缓存 |
| B站 | `bili/char-dir` `bili/dual-dir` `bili/diary-read` `bili/ledger-read` `bili/memory-link` `bili/brief-link` | 账本/日记优先读角色包 `characters/<id>/bili/`、回退全局目录；B站记忆条目缺 url 时用 BV 号拼链接；简报也带链接 | 上游只读全局目录，而写入方写的是角色包目录，导致「记忆只有两条旧动态」 |

`payload/surfcore/custom/index.js`（约 19KB）与 `people.js`（约 7KB）就是上面这些人设之外的**全部逻辑**——它们是被 `custom/import` 一条补丁挂进 `src/bridge.js` 的，升级不会碰 payload，只要 harness 里有这条 import 就一直在。

刷B站那边一处：`payload/dsh-bili-scroll/bili-duty.cordis.patch.yml` 整份覆盖 `profile-template/bili-duty/cordis.patch.yml`，补上 `llm-pi-ai` 适配器——否则值班轮报 `NO_ADAPTER`。

## 加一个新目标

1. 在 `manifests/` 放 `<id>-<version>.json`（可参考已有的两份）。
2. 跑 `node bin/cli.mjs check --target <id> --root <目录>` 确认锚点全中。
3. 设置页或 `--root` 指过去即可；不给 `--root` 时用 manifest 的 `defaultRoots`。

## 已知限制

- 只管**文本文件**（源码、yaml、json）；二进制不支持。
- 上游大改结构 → 锚点失效，需要人更新 manifest（这是设计上的「宁可不贴」）。
- 不打包、不分发上游源码；manifest 里只有几十字节的定位片段，见 [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md)。
- 补丁只在你本机生效；上游若把同一功能做进正式版，应该删掉对应补丁而不是继续叠。

## 许可

MIT。见 [LICENSE](LICENSE)。

`SurfCore` 与 `dsh-bili-scroll` 各自遵循其原仓库许可（前者 MIT、private 未发布，后者 MIT）。本项目**不包含**它们的源码，只在 manifest 里引用其文件位置与定位片段。