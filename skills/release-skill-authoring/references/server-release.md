# 服务端：数据库迁移 + docker compose + 前端

## 一、数据库迁移

### 形态

**up/down 双向脚本，可回滚**（用户在生成时确认的策略）。每个迁移文件声明是否可逆：

```sql
-- migrations/2026.10.14.1_add_export_flag.up.sql     -- reversible: true
ALTER TABLE orders ADD COLUMN export_flag TINYINT NOT NULL DEFAULT 0;
```
```sql
-- migrations/2026.10.14.1_add_export_flag.down.sql
ALTER TABLE orders DROP COLUMN export_flag;
```

### 窗口内的固定顺序

```
备份 → 迁移 → 后端镜像更新 → 健康检查
```

顺序不能调换：迁移在镜像之前，健康检查在最后。任何一步失败 → 回滚镜像 + 用 down 还原。

**发版前备份是硬门禁**：`migrate.ps1` 在跑 up 之前先做备份，并把备份文件名与哈希写进报告。
没有验证过备份产物就不许跑不可逆迁移。

### down 常常不可逆 —— expand/contract

`DROP COLUMN` 的 down 写得出来，但**数据已经丢了**。所以破坏性变更走两步发布：

| 发布 | 做什么 |
|---|---|
| N | 只做加法：加表、加列（可空）、加索引。**旧列保留**，新旧代码都能跑 |
| N+1 | 代码切到新列，旧列停止写入 |
| N+2 | 真正 `DROP` 旧列。此时 `minVersion` 已抬到不再依赖旧列的版本 |

不可逆迁移需要显式开关 + **已验证的备份产物**，并在报告里标注「不可逆」。

### 与客户端的关系

迁移必须对**上一版后端**向前兼容（回滚镜像时数据库已经不回去了）。
这就是 `backendApiMinClient` 与 `minVersion` 存在的意义 —— 见 `client-update-protocol.md`。

## 二、docker compose 部署

### 停机窗口更新（默认）

```bash
# 1 先备份线上源码（出问题靠它回滚）
ssh root@<host> 'TS=$(date +%Y%m%d-%H%M%S); tar czf /root/<app>-src-$TS.tgz -C /opt/<app> \
  --exclude=./db/backups --exclude=./service-config --exclude=./update-files .; ls -lh /root/<app>-src-$TS.tgz'

# 2 上传新版本，解包覆盖
scp release.tgz root@<host>:/root/ && ssh root@<host> 'tar xzf /root/release.tgz -C /opt/<app>'

# 3 起服务
ssh root@<host> 'cd /opt/<app> && docker compose up -d --build'
```

### 镜像必须按 digest 固定

**不要用 `latest`** —— 它回滚不了（下次 `up` 还是拉到同一个 `latest`）。
用 `image: <repo>@sha256:<digest>` 或在 compose 里钉明确 tag，并把 digest 记进
`release-state.json` 的 `backendImageDigests`。回滚 = 用旧 digest 重新 `up`。

### 单文件只读挂载的 inode 坑

`nginx.conf` 这类**单文件**只读挂载，解包覆盖后文件的 inode 变了，
**`docker compose up -d` 不会重建容器，于是容器一直用旧配置**。必须：

```bash
ssh root@<host> 'cd /opt/<app> && docker compose up -d --force-recreate web'
```

改过单文件挂载的配置，**先验配置再重建**（配错会让容器 restart loop、对外 502）：

```bash
ssh root@<host> 'NET=$(docker inspect <app>-api --format "{{range \$k,\$v := .NetworkSettings.Networks}}{{\$k}}{{end}}"); \
  docker run --rm --network "$NET" -v /opt/<app>/nginx.conf:/etc/nginx/conf.d/default.conf:ro nginx:alpine nginx -t'
```

### 持久化目录不要动

`update-files/`、`service-config/`、`db/backups/` 靠挂卷持久化 —— **不要删、不要清**。
打包时的 `--exclude` 就是为此。

### 回滚

```bash
ssh root@<host> 'tar xzf /root/<app>-src-<时间戳>.tgz -C /opt/<app> && cd /opt/<app> && docker compose up -d --build'
```

客户端**不能**这样回滚（见 `client-update-protocol.md`），服务端可以。

## 三、前端

### 缓存策略

| 资源 | Cache-Control |
|---|---|
| `index.html`、service worker | `no-cache, no-store, must-revalidate` |
| 带内容哈希的静态资源（`app.abc123.js`） | `public, max-age=31536000, immutable` |

反过来做（`index.html` 被缓存）的症状是：用户拿到旧壳配新资源，白屏或功能异常，
而且**刷新也没用**。

### 原子发布

```
1 上传到版本目录 /dist/<version>/
2 全部就位后，原子翻指针（或最后覆盖 index.html）
```

不要就地覆盖 `index.html` 再慢慢传资源 —— 中间那个窗口用户会拿到半新半旧的页面。

### 与后端的关系

- 前端由**独立静态站**托管 → 与后端各自发布；
- 前端由**后端托管**（打进 compose 或后端静态目录）→ 随后端一起发布，
  此时后端更新即前端更新，缓存头由后端控制。

生成时由用户拍板，写进 `frontend.mode`。

## 四、凭据与远程操作

- **SSH 私钥不入库、不写进技能、不写进任何产物**；由部署负责人单独交给需要它的人；
- **别借用别人的密钥**；认证失败先确认指向的私钥是否正确，不要绕过认证；
- 远程操作一律用系统自带的 OpenSSH（Windows 上是 `C:/Windows/System32/OpenSSH/{ssh,scp}.exe`）；
- 上传鉴权密钥走**环境变量**，不要写在命令行里（会留在历史与进程列表）。

## 五、并行点

上传（网络密集）与安装包构建（CPU 密集）**互不依赖**，可以同时进行：

- 上传读的是发版目录里的包；
- 安装包构建读的是已构建好的应用目录。

发版流程的机器时间通常只有几分钟，**大头在判断与往返**。真正省时间的是
「一条命令看清本次改了什么」和「把确认并成一次」，不是优化压缩算法。