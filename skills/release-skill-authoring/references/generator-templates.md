# 生成物的模板与占位符

`scripts/release-scaffold.mjs` 读 `release.config.json` 与 `assets/templates/`，渲染出目标项目的发版技能。

## 占位符

**以 `scripts/release-scaffold.mjs` 的 `placeholders` 表为准**，本文件不再抄一份 ——
抄一份的下场已经见过了：表里的名字（`{{VERSION_COMMAND}}`、`{{COMPONENTS}}`、`{{AGENT_TARGETS}}`…）
早就不存在了，照着它写模板会在渲染时报「配置推不出来的占位符」。

从代码里读不出来的只有**一件事：这个值是探测得来还是必须由用户确认**。按这条分类：

| 类别 | 例子 | 规矩 |
|---|---|---|
| 探测可得 | `{{COMPOSE_FILE}}`、`{{COMPOSE_SERVICES}}`、`{{PROJECT_NAME}}` | 探到就填，不必问 |
| **必须用户确认** | `{{CLIENT_BUSINESS_GLOBS}}`、`{{CLIENT_RUNTIME_GLOBS}}`、`{{MANIFEST_BASE_URL}}`、`{{MANIFEST_CHANNEL}}`、`{{CLIENT_ARCHIVE}}`、`{{CLIENT_UPDATE_EXECUTOR}}`、`{{STOP_WINDOW}}`、`{{BACKWARD_COMPAT_VERSIONS}}`、`{{NOTES_SOURCE}}` | **不许由探测结果直接填**，也不许「按惯例」填 —— 问不到就进 `release.pendingConfirmations` |
| 脚手架自动填 | `{{REPO_REL}}`、`{{REPO_REL_FROM_SCRIPTS}}`、`{{ENGINE_VERSION}}`、`{{#if …}}` 开关 | 手写必错（层级要按实际落盘位置算），别碰 |

条件段有两个关键字：`{{#if NAME}}…{{/if}}` 与 `{{#unless NAME}}…{{/unless}}`。
开关名：`CLIENT_ENABLED` / `FRONTEND_ENABLED` / `DATABASE_ENABLED` / `PENDING_CONFIRMATIONS`。
用了没定义的开关，脚手架会直接拒绝渲染。

`unless` 不是装饰 —— 有些句子在「有客户端」和「没有客户端」下**措辞不同**，而不是多一句少一句
（清理时机：一个是「清单上传成功、线上体检通过之后」，另一个只是「本次发版确认成功之后」）。
只有 `if` 就只能两边都写，于是客户端项目会看到重复的两句。

**写条件段的两条硬规矩**（都踩过）：

1. **不要嵌套**。渲染用的正则非贪婪，一段里嵌另一段会在第一个 `{{/if}}` 处提前收尾，
   剩下的原样漏进产物。要么写单行，要么拆成两个并排的条件段。
2. **不要只包住表格行的一半**。`| {{#if X}}第一格 | 第二格 {{/if}} |` 在 X 为假时会留下
   `|  | 第二格 |` 这种空单元格坏行 —— 要包就整行整段地包。

## 必须逐字保留的段落

这些是**实测踩出来的**，改写会静默破坏功能：

| 段落 | 为什么 |
|---|---|
| Pascal 侧的 `JsonStr` / `JsonStrFrom` / `VersionPart` / `CompareVersions`（`assets/inno/pascal-fragment.iss`） | 已验证可用；改错会读不到清单或比反版本号 |
| 清单的六条硬约束 | 每一条都对应一个静默故障（见 `manifest-contract.md`） |
| `PrivilegesRequired=lowest` + `{autopf}` | 装到 `Program Files` 会让覆盖式更新写不进去 |
| `VersionInfoVersion` 纯数字四段、`AppId` 不可改 | inno-setup-installer 的硬约束 |
| 「先上传包、最后上传清单」的顺序 | 反过来客户端会拉到清单却下不到包 |
| 「版本号只进不退」「客户端回滚 = 前滚」 | 客户端不会理会更低版本 |
| 缓存头要求（清单 no-store、包 immutable） | 反了就是「新包永远命中旧缓存」 |
| 单文件挂载必须 `--force-recreate` | `up -d` 不会替你检查 |

## 渲染纪律

1. **渲染前必须有 CHECKPOINT**（`SKILL.md` 第三步）；
2. 生成物**必须由脚手架产出**。手工替换占位符出来的东西不在自检覆盖范围内，而且下次
   `--force` 重渲染全部丢失 —— 实测里手抄的产物统一犯了「路径少一层」的错；
3. 渲染后按 `SKILL.md`「生成后必须自检」跑完 6 项，含**可执行性冒烟**（照抄一条命令真的跑一遍）；
4. `release-scaffold.mjs --dry-run` 先看一遍将写入哪些文件、拷哪些通用契约，确认无误再落盘；
5. **改模板，不改生成物**。发现生成物哪里不对，改 `assets/templates/` 再重渲染；
6. `--update-engine` 只刷新 `scripts/engine/` 并更新引擎版本戳，不动项目专属的包装脚本 ——
   引擎升级走这个，别整体重渲染（会覆盖掉项目定制）。

## 已有的技能：`--diff` 与 `--adopt`

目标目录已存在时，裸跑会被拒绝，要在四种意图里挑一个：

| 开关 | 做什么 | 什么时候用 |
|---|---|---|
| `--dry-run` | 只列将写入哪些文件，不写盘 | 首次生成前 |
| `--diff` | 渲染到临时目录，与现有技能**逐文件**比对（新增 / 更新 / 仅现有 / 一致 + 引擎指纹），不写盘；有差异退出码 2 | 优化前先看清楚 |
| `--adopt` | **先整体备份**现有目录到 `release/.skill-backups/`，再重渲染 | 优化已有技能的默认路径 |
| `--update-engine` | 只换 `scripts/engine/` 与版本戳 | 引擎升级 |
| `--force` | 同 `--adopt` 但**不备份**，且会删 `references/`、`assets/` | 确定不要备份时 |

分类里 **`仅现有` 要特别看**：它多半是项目自己加的脚本，重渲染不会再产出它，
但 `--adopt` 也不会删它 —— 会被删的只有 `--force`。

## 生成物结构

```
<项目>/.claude/skills/<slug>-release/
  SKILL.md                     每次发版的入口（本项目命令已实例化）
  release.config.json          全部实例化参数（副本；真源在 <项目>/release/）
  PENDING-CONFIRMATIONS.md     仅当有未确认参数时生成
  references/
    versions.md                本项目版本号从哪读
    runbook.md                 九阶段的期望输出与门禁
    rollback.md                回滚剧本
    database.md / backend.md / frontend.md / client.md    按启用的组件生成
    manifest-contract.md  payload-rules.md  client-update-protocol.md   客户端项目才有
    multi-agent-layout.md  retention.md                               与组件无关
  scripts/
    engine/                    vendored 引擎（技术栈无关、零依赖、可独立运行）
    migrate.ps1                ┐
    deploy-backend.ps1         │ 项目专属包装，由模板渲染
    build-installer.ps1        │ （后两个仅客户端项目）
    verify-installer.ps1       ┘
  assets/
    inno/pascal-fragment.iss   客户端项目才有
    multi-agent-paths.md  manifest.schema.json

<项目>/release/
  release.config.json          真源（脚手架同时写技能目录一份，避免路径引用满天飞）
  release-state.json           发布流程的唯一记忆（提交入库）
  plan.json                    最近一次的发版计划
  history/                     清单归档与发布计划
  dist/                        构建产物（清理见 retention.md）
  .payload-filelists/          业务文件清单，**至少保留 2 份**
```

没有客户端的项目不生成 `client.md`、两个客户端脚本、Inno 片段与清单契约 ——
声明「自动省略」就得真的省略，留下一份用不上的文档只会让人以为这个项目有客户端。