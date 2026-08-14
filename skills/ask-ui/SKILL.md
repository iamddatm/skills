---
name: ask-ui
description: '将 Agent 工作流中的两个及以上独立问题渲染为本地交互式表单，预选推荐答案，将回答保存为可移植 JSON，并将提交结果直接返回给等待中的 Agent 命令。适用于 grilling、brainstorming、需求澄清、配置、规划或任何需要一次性提出多个问题的场景。也可在活跃 Ask UI 轮次中用户说"已提交"、"提交好了"或"答完了"时使用手动恢复路径。'
---

# Ask UI

将 Ask UI 作为展示与持久化适配器使用。问题的生成和推理保留在调用方工作流中。

## 判断是否使用 UI

当前轮次包含至少两个用户现在可以回答的独立问题时，使用 UI。有依赖关系的问题留到后续轮次。只有一个问题时直接在对话中提问。

如果本地服务器或浏览器无法启动，回退到调用方工作流的普通文本格式。

## 提问并等待回答

1. 将本 `SKILL.md` 所在目录解析为 `ASK_UI_SKILL_DIR`。
2. 创建 JSON 前先阅读 [references/schema.md](references/schema.md)。
3. 创建 QuestionSet JSON 文件。新任务省略 `sessionId`；后续轮次复用已有的 `sessionId` 并设置 `basedOnRound`。
4. 运行前台命令，保持工具调用处于活跃状态直到退出：

   ```text
   node <ASK_UI_SKILL_DIR>/scripts/ask-ui.mjs ask --input <questions.json>
   ```

5. 该命令将就绪信息和本地 URL 写入 stderr，打开表单并等待。不要结束 Agent 回合，也不要让用户回复"已提交"。
6. 用户提交后，解析写入 stdout 的单条 JSON 结果，立即继续原来的工作流。
7. 如果还需要更多独立问题，用相同的 `sessionId` 再次调用 `ask`，并将 `basedOnRound` 设为返回的轮次号。不再需要更多问题时，结束会话。

仅在浏览器打开已由外部管理时使用 `--no-open`。仅在需要固定本地端口时使用 `--port <number>`。

## 手动回退与恢复

当前台工具调用无法保持活跃、本地浏览器无法连接临时服务器、或需要恢复被中断的直连轮次时，使用分离式工作流：

```text
node <ASK_UI_SKILL_DIR>/scripts/ask-ui.mjs create --input <questions.json>
```

解析返回的 JSON。在对话中包含其 URL 和可见标记：

```text
ask-ui-session: <sessionId>
```

告诉用户提交表单后仅回复"已提交"。`create` 命令启动或复用分离式本地服务器后立即返回。

当用户说"已提交"、"提交好了"或"答完了"时：

1. 从对话中最新的 `ask-ui-session` 标记恢复 `sessionId`。
2. 运行：

   ```text
   node <ASK_UI_SKILL_DIR>/scripts/ask-ui.mjs resume --session <sessionId>
   ```

3. 如果结果为 `submitted`，用其问题和答案继续原来的工作流。
4. 如果还需要更多独立问题，优先回到前台 `ask` 命令，使用相同的 `sessionId` 并将 `basedOnRound` 设为已处理的轮次。仅在直连等待仍不可用时再次使用 `create`。
5. 不再需要更多问题时，运行：

   ```text
   node <ASK_UI_SKILL_DIR>/scripts/ask-ui.mjs complete --session <sessionId>
   ```

如果对话标记不可用，不带 `--session` 运行 `resume`。返回多个候选时，根据当前主题、工作区、标题和提交时间推断最佳匹配。仅在确实无法判断时才询问用户。

重复的"已提交"消息不得创建重复轮次。只有在成功读取一个 `submitted` 状态的轮次后，才能创建新一轮。

## 保持会话连续性

- 一个任务对应一个 Session。
- 每批问题对应一个 Round。
- 同一任务的所有轮次复用同一个 `sessionId`。
- 不得覆盖已提交的问题或答案。
- 修正和补充确认放在新的 Round 中。
- 仅在新任务、已完成的任务或用户明确要求重新开始时才创建新 Session。

## 可选的主动唤醒

Ask UI 支持 Claude Code 和 Codex App Server 的可选唤醒元数据。将其视为增强功能而非必需。

- 仅在用户同意的前提下启用自动唤醒。
- Claude Code 需要已记录的会话 ID。
- Codex 需要宿主提供的 thread id。不得猜测 Codex 的 thread id。
- 适配器失败时，保存答案并回到手动"已提交"工作流。
- 直连 `ask` 模式不会触发唤醒适配器，因为等待进程本身就是返回通道。

## 常用命令

```text
node <ASK_UI_SKILL_DIR>/scripts/ask-ui.mjs ask --input <questions.json>
node <ASK_UI_SKILL_DIR>/scripts/ask-ui.mjs create --input <questions.json>
node <ASK_UI_SKILL_DIR>/scripts/ask-ui.mjs status --session <sessionId>
node <ASK_UI_SKILL_DIR>/scripts/ask-ui.mjs serve
node <ASK_UI_SKILL_DIR>/scripts/ask-ui.mjs complete --session <sessionId>
node <ASK_UI_SKILL_DIR>/scripts/self-test.mjs
```
