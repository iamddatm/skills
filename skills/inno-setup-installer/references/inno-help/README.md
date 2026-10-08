# Inno Setup 帮助的签名索引

`api-index.txt` —— 官方帮助里**支撑函数 / 类与方法 / 事件**的签名行（约一千行），按名字 `grep` 最快。写 `[Code]` 时参数个数与类型不确定，先查这里、别凭记忆写（`Invalid number of parameters` 这类报错全是记忆造成的）。

**只留索引，不留官方页面原文**：原文是第三方内容，仓库里没必要背。语义、参数说明与示例看技能自己写的两篇 —— `../scripting-api.md`（函数用法、事件触发时机、Pascal 坑）与 `../inno-script-cookbook.md`（段与 flag 怎么写）；冷门细节按 `api-index.txt` 末尾列的主题名去官网查。

| 要查的东西 | 看哪儿 |
| --- | --- |
| 函数 / 类 / 事件签名 | `api-index.txt` |
| 某个函数的用法、参数含义、示例 | `../scripting-api.md`，不够再上官网 |
| `[Files]` / `[Setup]` 段的 flag 语义 | `../inno-script-cookbook.md` §1、§6、§7 |
| 官网某个主题页 | `https://jrsoftware.org/ishelp/topic_<主题名>.htm`（常用主题名见索引末尾） |

## 来源、版权与更新

- **来源**：Inno Setup 官方帮助 <https://jrsoftware.org/ishelp/>，抓取日期见 `api-index.txt` 抬头；签名行版权归 Inno Setup 作者（Jordan Russell）。
- **更新**（想同步官网最新版时才跑，平时不用）：

  ```bash
  pwsh -NoProfile -File <skill>/scripts/refresh-help-docs.ps1
  ```

  脚本只抓三页到 `%TEMP%`、重写索引、清掉临时文件 —— **不会把页面原文落进仓库**。
- 官网帮助是 **frameset**：`curl index.php?topic=x` 只拿到框架页，正文在 `topic_x.htm`，直接抓后者。