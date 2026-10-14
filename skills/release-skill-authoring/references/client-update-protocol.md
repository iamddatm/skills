# 客户端更新协议

## 本地状态：记两个版本号

客户端本地必须记**两个**值，缺一不可：

| 值 | 含义 |
|---|---|
| `version` | 更新包版本 = 客户端对外版本号 |
| `fullBaseline` | 当前运行时基线对应的版本（最近一次全量/安装带来的版本） |

只记 `version` 是不够的：判断「要不要更新全量包」必须知道本地**运行时**是哪一版的基线，
而运行时更新走的是全量包、不体现在 `version` 上。

存放位置（推荐双写）：

- `%LOCALAPPDATA%\<App>\update-state.json` —— 客户端侧的状态（含 `seq`、上次失败记录）；
- 程序目录 `version.json` —— **事实源**，安装包播种、客户端维护。

两者都缺失 → `UNKNOWN` → **强制走全量**（保守但安全）。

## 判据

```
fullNeeded    = (fullRequired && cmpSegInt(full.version, local.fullBaseline) > 0)
             || cmpSegInt(minVersion, local.version) > 0
             || local.version == UNKNOWN

payloadNeeded = cmpSegInt(version, local.version) > 0
             && seq > local.seq
             && cmpSegInt(local.version, minVersion) >= 0
```

三条要点：

- `cmpSegInt` **按段比整数**（`26.10.1.1 > 26.9.1.1`，按字符串比会判反）；
- **相等或更低一律跳过** —— 否则就是降级；
- `seq` 必须**严格大于**本地值，防静态站被回滚后把客户端「更新」回旧版。

## 状态机

| # | 状态 | 关键行为 | 失败处理 |
|---|---|---|---|
| S0 | BOOT | 单实例互斥锁 | 已有实例则退出 |
| S1 | LOAD_LOCAL_STATE | 读 `update-state.json` → 缺则读程序目录 `version.json` → 都无 → UNKNOWN | 视为 UNKNOWN（强制全量） |
| S2 | FETCH_MANIFEST | `GET manifest.json?t=<unix>`，超时 3s、重试 2 次 | **脱机启动**：提示「暂时无法检查更新」，按本地版本启动，4h 后重试 |
| S3 | COMPARE | 用上面判据 | 清单解析失败 → 走脱机分支 |
| S4 | FULL_FLOW | 下载全量包（断点续传）→ 校验 sha256 → 解到 `app.staging/` → 交 updater **目录交换** → **重启自身** | 保留旧目录原样，提示「更新失败，保持当前版本」 |
| S5 | PAYLOAD_FLOW | 下载更新包 → sha256 → 解到 staging → 逐文件清单校验 → 备份受影响文件 → 覆盖 → 执行删除清单 | 从 `backup/<ts>/` 还原，提示「已还原到 vX」 |
| S6 | WRITE_LOG | 追加用户可感知日志 | 失败不阻塞 |
| S7 | UPDATE_STATE | 原子写（临时文件 + rename） | 下次从 `version.json` 重建 |
| S8 | LAUNCH_APP | 启动主程序 | 连续 3 次崩溃 → 还原 backup 并提示「已回退到 vX」 |

### 为什么先全量后更新包，且要重启

更新包只覆盖**业务文件**。若运行时已换代而先应用基于旧基线的更新包，会得到
「新业务文件 + 旧运行时」的组合 —— 直接崩，而且是启动即崩、连自愈路径都走不到。

实现上，S4 完成后**重启再从头走一遍状态机**，而不是在同一进程里接着走 S5。
代价是一次重启，换来的是**天然幂等**：任何一次中断，下次启动都能从 S1 重新推导出正确的下一步。

### 为什么更新包是「业务文件全集」而不是差分包

客户端可能落后很多个版本（长期离线、用户不常开）。差分包链条一断就得逐级补，
而「全集」意味着任何 ≥ `minVersion` 的客户端都能**一步到位**。

代价是包大一些（只含业务文件，通常远小于全量包）。这个交换是划算的。

## 独立 updater（Windows 硬约束）

**运行中的 exe/dll 被 Windows 占用，就地覆盖必然失败。** 所以：

- `updater.exe` 放在 `%LOCALAPPDATA%\<App>\updater\` —— **在被替换目录之外**；
- 主程序下载并校验完成后退出，由 updater 执行替换，再拉起主程序；
- **updater 替换自身**：不能自我覆盖，走「改名为 `.old` → 新 updater 下次启动时删除」；
- **主程序 exe/dll 被占用**：目录改名交换，或 `MoveFileEx(MOVEFILE_DELAY_UNTIL_REBOOT)` 延迟替换。

### 交接协议（必须定死）

| 环节 | 约定 |
|---|---|
| 主程序 → updater | 命令行传：模式（full/update）、安装目录、清单/包路径、`--restart` |
| updater → 主程序 | 退出码：0 成功、非 0 失败；并写 `update-state.json` 的 `lastResult` |
| 主程序重启后 | 读 `lastResult`，成功则展示更新说明，失败则展示还原提示 |

## 更新成功后的提示（用户唯一看到的东西）

主程序展示 `manifest.notes`。它的生成规则见 `release-runbook.md` 的「更新说明」一节 —— 核心是
**只写用户能感知的变化**，不写提交号、文件名、类名、`refactor` / `chore` 这类内部改动。

## 服务端兼容窗口（客户端不可回滚的补偿）

客户端装出去就收不回来，所以**服务端必须向后兼容 N 个客户端版本**。这不是客户端代码问题，
是**发版门禁**：

1. 清单携带 `backendApiMinClient`（后端能接受的最老客户端版本）与 `minVersion`；
2. 检测到后端有「移除 API / 改签名」或不可逆迁移时，**必须**上抬 `minVersion`，
   且被丢下的客户端要么已超兼容窗口（默认 3 个版本 / 90 天取大），要么此前已被强制走过全量；
3. **数据库侧**：expand/contract —— 发布 N 只做加法（加表/加列/加索引，旧列保留可空），
   真正删除放到 N+2，此时 `minVersion` 已抬到不再依赖旧列的版本；
4. **客户端侧**：永不自我降级，只在 `local.version < minVersion` 时停止走更新包路径，转向全量/重装提示；
5. **回滚侧**：服务端只能回到「仍满足当前 `minVersion` 的那个后端版本」。
   超出范围就走 forward-fix（前滚修复），不假装能回。

`minVersion` 上抬是 🔴 门禁动作，必须附「哪些客户端会受影响」的量化说明。

## 首次安装用户

Inno 安装包在 `ssPostInstall` 落 `version.json` + `update-state.json`
（`version` = `fullBaseline` = 安装包版本）。否则新用户不知道自己是什么版本，
下次启动会当成 UNKNOWN 而强制全量。

**单一写入者**：安装包只「播种」状态文件，此后由客户端独占写入 ——
两个写入者会造成状态漂移。