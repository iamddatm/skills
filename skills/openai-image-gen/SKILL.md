---
name: openai-image-gen
description: '通过 OpenAI 兼容图像端点(/v1/images)文生图与图生图:支持 new-api(百炼 qwen-image、wan、z-image 等渠道)、sub2api(gpt-image-*/grok-imagine)及 OpenAI 官方等网关,本地生成 PNG/JPG,支持参考图、mask 局部重绘、多尺寸与质量。用户说「画一张」「文生图」「生成图片」「用这张图改/重绘」「图生图」「new-api 生图」,或要求配图/壁纸/概念图且由自建图像网关供数时使用本技能。'
---

# openai-image-gen

调用 new-api / sub2api 等网关的 OpenAI 兼容 `/v1/images` 端点生图。自带 Node.js / Python / PowerShell 三份等价脚本,参数语义完全一致;环境只探测一次,跑通后记录到 `.env` 长期复用。

## 接口与模型(以网关为准)

- 文生图:`POST {BASE_URL}/v1/images/generations`(JSON:`model`/`prompt`/`size`/`quality`/`n` 等)
- 图生图:`POST {BASE_URL}/v1/images/edits`(JSON `images:[{image_url}]` + 可选 `mask.image_url`;脚本自动把本地文件编成 data URL,不支持 `file_id`)
- **new-api**:按渠道配置放行任意图像模型(百炼 `qwen-image-3.0-pro`、`wan*`、`z-image`、OpenAI `gpt-image-*` 等,上游协议由渠道适配器转换);自带令牌/配额体系,适合对外共享(上游密钥不下发客户端)
- **sub2api 官方版**:白名单硬编码,只放行 `gpt-image-*` / `grok-imagine*`(Grok 编辑用 `grok-imagine-edit`),且账号级模型映射换算后的名字再过一次同一白名单——百炼 qwen-image 等无法经 sub2api 调通
- 鉴权 `Authorization: Bearer <API_KEY>`;响应为 OpenAI 风格 `data[].b64_json` 或 `data[].url`,脚本一律解码/下载后落盘
- 同步调用普遍 1–3 分钟;网关挂在 nginx 反代后面时 `proxy_read_timeout` 需 ≥300s,否则约 60s 必 504

## 首次使用:配置与环境(一次性,之后跳过)

1. 读 `<技能目录>/.env`。存在且含 `IMGAPI_BASE_URL`、`IMGAPI_API_KEY`、`IMGAPI_RUNTIME` → **不要做任何环境检查**,按 `IMGAPI_RUNTIME` 直接执行。
2. 缺配置 → 向用户索要网关 Base URL、令牌、默认图像模型(以网关实际支持的为准)。
3. 选运行时(按序探测,命中即止):`node --version` ≥ 18 → `.mjs`;否则 `python --version` ≥ 3.9 → `.py`;否则 `pwsh -NoProfile -File`(或 `powershell`)→ `.ps1`。
4. 用用户本次的绘图请求直接跑(凭据先经命令行参数或临时环境变量传入,不落盘):
   - 成功 → 按 [.env.example](.env.example) 写 `.env`(含本次验证过的 `IMGAPI_RUNTIME` 与模型),此后复用。
   - 401/403 或连接失败 → 与用户核对后重问重跑,信息确认无误前不写 `.env`。
5. `.env` 已有但生图报鉴权/模型错误 → 更新对应行,不要整份重建。

## 怎么跑

在技能目录下执行(三组命令等价,按 `IMGAPI_RUNTIME` 选一组;PowerShell 参数名首字母大写):

```bash
# node:   node   scripts/openai-image-gen.mjs <gen|edit> ...
# python: python scripts/openai-image-gen.py  <gen|edit> ...
# pwsh:   pwsh -NoProfile -File scripts/OpenAI-Image-Gen.ps1 <gen|edit> ...

# 文生图
node scripts/openai-image-gen.mjs gen --prompt "详细描述" [--model qwen-image-3.0-pro] [--size 1024x1024] [--quality auto|low|medium|high] [--n 1] [--out out.png | --out-dir DIR]

# 图生图(--image 可重复;--mask 局部重绘)
node scripts/openai-image-gen.mjs edit --prompt "修改指令" --image 参考图.png [--image 更多图.png] [--mask mask.png] [同上其余参数]
```

- 终端调用超时设 ≥ 300 秒(大图生成慢),不要按普通命令 30 秒掐断。
- 脚本每成功一张就在 stdout 打印 `SAVED <绝对路径> (<字节数>, model=...)`——**把路径原样报告给用户**,并用 Read 工具查看该图确认效果;非零退出时 stderr 是 HTTP 状态与服务端错误体,照读定位。
- `--size` 常用:`1024x1024`、`1536x1024`(横)、`1024x1536`(竖)、`auto`;取值合法性以网关/上游模型为准(如百炼 qwen-image 系要求总像素在 512×512–2048×2048 间),未知取值原样透传。
- `--out` 仅单图精确命名;多图用 `--out-dir`,文件名自动 `t2i-/i2i-` + 时间戳。默认输出到当前工作目录,优先按用户指定位置传 `--out`。
- 用户给的是简短想法时,先扩写为含主体/风格/构图/光线的详细提示词再调用;改动较大时先把提示词念给用户确认。
- 图生图的 `--image` 支持本地路径或 http(s) URL;mask 约定与 OpenAI 一致(不透明区域保留、透明区域重绘)。

## 红线

- 任何输出与报告不回显 `IMGAPI_API_KEY`。
- `.env` 已进 `.gitignore`,任何情况下不提交。
- 默认一次 1 张:不要自行调大 `--n`、`--quality` 或尺寸(消耗上游配额);需要变体时先问用户。
- 生成失败不改用其他绘图 API、不拿占位图顶替——按故障表处理并如实报告。

## 跑失败时

| 症状 | 一线修复 | 仍失败兜底 |
|---|---|---|
| 401 `authentication_error` | 向用户重核对令牌,更新 `.env` | 确认令牌属于该网关实例且未过期/未超配额 |
| 403 `permission_error` | sub2api:分组未开放图像生成;new-api:令牌分组不含该渠道 | 让管理员开通,别反复重试 |
| 400 `requires an image model` | sub2api 官方版白名单只认 `gpt-image-*` / `grok-imagine*`;其他模型(qwen-image 等)须走 new-api 类网关 | 与用户确认其网关类型与已配置模型 |
| 400 `url error, please check url`(new-api 透传上游) | new-api 渠道「接口地址」只填域名根(如 `https://ws-xxx.maas.aliyuncs.com`),不能带 `/compatible-mode/v1`、`/api/v1` 尾巴 | 检查令牌分组是否路由到了别的坏渠道 |
| 渠道后台「测试」成功但 API 调用仍报上游错 | 同模型被多条渠道声明、按权重选中了坏渠道:渠道管理按模型筛选,禁用多余渠道或移除该模型 | — |
| 504 `nginx Gateway Time-out` | 反代 `proxy_read_timeout` 调到 300s 后 reload;或改走网关直连端口 | 生图本就 1–3 分钟,别按 60s 判死 |
| 400 `image file is required` / 文件未找到 | 检查 `--image` 路径拼写与存在性 | 改传 http(s) 图片 URL |
| 502 / `No available compatible accounts` | sub2api 分组下没有支持该图像模型的上游账号 | 让用户到后台检查账号与分组绑定 |
| 长时间无返回 / 终端超时 | 终端超时调到 ≥ 600s 重跑一次 | 仍超时则降 `--quality` 重试一次,再失败如实报告 |
| `failed to download result image` | 结果 URL 过期,原参数重跑一次 | 照读报错报告,不伪造图片 |
| 记录的运行时找不到(如 `node: not found`) | 按链路降级到 python/pwsh 跑通 | 把 `.env` 的 `IMGAPI_RUNTIME` 更新为新运行时 |
| 其他 HTTP 错误 | stderr 错误体原样展示给用户 | 不猜测语义,建议到网关后台看请求日志 |
