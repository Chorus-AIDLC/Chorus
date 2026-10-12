# 在 Linux 上自托管 Chorus

[English](SELF_HOST.md) · [Docker 镜像说明](DOCKER.md) · [认证说明](AUTH.md) · [PG16 → PG17 迁移脚本](POSTGRES_UPGRADE.zh.md)

在自己的 Linux 主机上运行单个 Chorus 应用和 PostgreSQL 17。建议先用**本地 HTTP**：不需要域名、Cloudflare 账号或 Tunnel token。之后可以通过用户自行创建的 Cloudflare Named Tunnel 提供 HTTPS。本指南面向单实例，不承诺多副本支持或特定并发容量；用于验证的开发工作站只是测试环境，不是读者部署的前提。

## 1. 前提和边界

- 一台持续维护的 Linux 主机，已安装 Docker Engine、Docker Compose v2 插件（`docker compose`）、Bash、OpenSSL、curl，并预留数据库增长及备份空间。可选脚本登录检查需要 `jq`。用 `docker version`、`docker compose version` 检查环境；Compose 需支持 `up --wait`。
- 一份包含 `deploy/self-host/` 的仓库检出或发行源码，配置与所选应用版本相匹配。容器部署不要求服务端安装 Node.js 开发工具链；Agent CLI 检查在已安装 Chorus CLI 和对应 Agent 后端的客户端进行。
- Docker 操作权限基本等同于主机 root 权限。保护 Docker socket，不要将其挂载进 Chorus。应用镜像可能以 root 运行，不能假定它提供非 root 隔离。
- 能访问镜像仓库；Tunnel 模式还需要访问 Cloudflare 连接器网络。主机防火墙保持应用和数据库入站端口关闭。本地模式只绑定回环地址，Tunnel 模式不发布任何主机端口；数据库始终只在内部 `db:5432` 可用。
- 选择独一无二的 Compose 项目名，不连接已有数据库/卷，不设置固定 `container_name`，不运行全主机 prune/清理命令。

主机/VPS、电力、网络、磁盘以及可选域名都可能产生费用。Cloudflare 套餐资格和限制会变化，Tunnel 并不让主机或域名免费。R2 仅作为可选的**加密异地备份存储**，不能作为数据库运行磁盘。[R2 官方价格](https://developers.cloudflare.com/r2/pricing/)（2026 年 10 月查阅）列出的 Standard 每月免费额度为 10 GB-month 存储、100 万次 Class A 操作、1,000 万次 Class B 操作。出口流量免费不等于全部免费：存储/操作超额仍收费，其他存储类型和产品的计费也不同。使用前重新确认价格并设置账单告警。

## 安装脚本入口：选择拉取或本地编译

在仓库检出目录运行 `bash install.sh`，会先选择 **AWS** 或 **local**，
再进入对应流程；选择本地时不会检查 AWS 依赖或复用 `default_deploy.sh`。
默认仍为 AWS。`bash install.sh --target local` 可直接选择本地；有终端时会询问
`pull` / `build`、拉取所需镜像、普通登录邮箱/密码及独立的超级管理员邮箱/密码。
密码输入及二次确认均隐藏显示。本地只需要 Docker/Compose 和
OpenSSL，不需要主机安装 AWS CLI、Node.js 或 pnpm。脚本仅启动 loopback HTTP
配置，可选 Cloudflare 仍按后文章节由用户配置。

安装器会在读取前拒绝符号链接密码文件和检出目录内的密码文件，避免它们进入镜像构建上下文。

以下非交互示例**二选一**，把版本占位符替换成真实存在的镜像，密码文件路径替换为
仓库外受保护的本地文件（目录权限 0700、文件权限 0600），每个文件只含一行密码。
不要把实际密码放入命令行参数，也不要在同一端口同时运行两套：

```bash
bash install.sh --target local --image-source pull \
  --image chorusaidlc/chorus-app:vX.Y.Z --project chorus-local \
  --email owner@example.com --admin-email admin@example.com \
  --password-file /absolute/private/path/login-password \
  --admin-password-file /absolute/private/path/admin-password \
  --port 18637 --non-interactive
```

或者从当前检出源码编译，默认本地标签为 `chorus-local:chorus-local`：

```bash
bash install.sh --target local --image-source build \
  --project chorus-local --email owner@example.com --admin-email admin@example.com \
  --password-file /absolute/private/path/login-password \
  --admin-password-file /absolute/private/path/admin-password \
  --port 18637 --non-interactive
```

安装脚本默认监听 `127.0.0.1:18637`，与测试用的 `8637` 区分；可用 `--port` 或
`CHORUS_PORT` 覆盖。容器内部端口及 Tunnel 源站 `http://app:8637` 不变。
后文手工部署/健康检查示例使用 `8637`，脚本安装的实例请相应改为 `18637`。
恢复演练须选未占用的独立端口，不能复用正在运行的正式实例端口。

可用 `--image` 指定其他编译标签。编译使用当前仓库的 `Dockerfile`、**production**
阶段和仓库构建上下文，不拉取应用镜像；仍需要访问基础镜像及构建依赖仓库、足够的
构建内存和磁盘，并拉取 `postgres:17-alpine`。拉取模式下载指定的应用标签/digest
和 PostgreSQL。两种全新安装模式还会拉取官方的**第三个辅助镜像 `httpd:2.4-alpine`**，
通过 `htpasswd` 生成管理员 bcrypt 哈希（cost 12）。密码经 stdin 传入临时的
`docker run --rm -i --network none` 容器，不进入参数；哈希过程不需要主机 Node.js
或 pnpm。两种模式均不接受省略标签或 `latest`，失败时不会悄悄切换镜像来源。
镜像准备后均通过现有本地 Compose 执行 `up --pull never --wait`。不创建云资源，
不更改全局 Daemon 配置。

预览全新安装时，加上 `--dry-run` 并省略两个密码文件参数：仍需提供两个邮箱和镜像选择
（pull 需显式镜像，build 可用默认标签），但**不需要密码**。仅显示计划，不计算哈希、
不调用 Docker、不写文件。这与原有 AWS dry-run（会写 AWS 重运行配置）的含义不同。
无 TTY/headless 时不等待回答，缺少必填值直接失败。对应环境变量为 `CHORUS_INSTALL_TARGET=local`、
`CHORUS_IMAGE_SOURCE=pull|build`、`CHORUS_IMAGE`、`CHORUS_LOCAL_PROJECT`、
`CHORUS_PORT`、`DEFAULT_USER`、`SUPER_ADMIN_EMAIL`、`CHORUS_INSTALL_NONINTERACTIVE=1`、
`CHORUS_INSTALL_DRY_RUN=1`；命令行参数优先。
真正执行非交互安装时，须提供密码文件，或通过环境安全注入 `DEFAULT_PASSWORD` 和
`SUPER_ADMIN_PASSWORD`；密码文件参数优先。不支持明文密码 argv 参数。两个密码均须
为单行且至少 **8 字节**；管理员密码受 bcrypt 限制，最多 **72 字节**（不是字符数）。

脚本会**新建**权限 0700 的 `$HOME/.config/chorus-self-host/<project>/` 和权限 0600
的 `env` 文件，数据库密码随机生成。所选普通登录 `DEFAULT_PASSWORD` 以**明文**保存，
编码为双引号包裹的 Compose env 值，转义反斜杠和双引号，并用 `$$` 表示字面的 `$`。
这样也能保留末尾反斜杠，避免单引号 dotenv 值无法安全处理该情况的问题。
因此必须将此文件作为机密保护。管理员只保存
单引号包裹的 bcrypt `SUPER_ADMIN_PASSWORD_HASH`，不保存明文 `SUPER_ADMIN_PASSWORD`。
签名行为不变：空 `NEXTAUTH_SECRET` 继续使用应用自动生成并持久化的签名密钥。
密码不打印、不进入命令行参数。继承的 Compose 凭据/镜像环境变量不会覆盖生成配置。
若私有目录、已保存的部署脚本/配置已存在，或该项目名
已有容器、卷、网络，则拒绝安装，而非换密码、覆盖文件或复用数据库。
还会独立检查将使用的卷、网络和容器的精确名称，不因缺失或不同标签而复用手工创建的资源；
资源清单查询失败也会在准备镜像前终止。启动失败时
可能保留本次新项目的容器和配置供排查，不会自动删除。
全新安装还会在仓库根目录生成**不含密钥、权限 0700 的 `default_deploy.sh`**，也可通过
`CHORUS_DEPLOY_CONFIG` 指定路径（父目录须已存在）。仅保存项目、私有目录和镜像来源等
元数据，不含密码。本地安装既不覆盖已有脚本，也不复用 AWS 脚本。默认 wrapper 已从
本地镜像构建上下文排除；旧 AWS wrapper 可能包含凭据。
两种部署保留同一默认文件名。AWS 安装在复用或覆盖前会拒绝 local 或无类型标记的旧
wrapper；请通过 `CHORUS_DEPLOY_CONFIG` 选择另一路径，避免误执行。新 wrapper 记录目标类型。
编译前仍应检查检出目录和 `.dockerignore`，其他无关私密文件也应放在构建上下文之外。

脚本成功后，**跳过第 2 节手工生成配置**：将 `REPO` 设为仓库目录，`PROJECT` 设为
已选项目名，`ENV_FILE` 指向生成的私有 `env`，再使用第 3A 节的 `dc` 函数管理。
脚本会打印仅停止该项目的命令。**已有安装应使用已保存的 wrapper，不要再次执行安装**
（如自定义了 `CHORUS_DEPLOY_CONFIG`，请替换路径）：

```bash
bash ./default_deploy.sh --dry-run
bash ./default_deploy.sh
```

wrapper 调用 `deploy/self-host/deploy-local.sh`。build 模式重新编译当前检出源码；pull
模式拉取已有私有 env 中 `CHORUS_IMAGE` 指定的应用镜像。从同一文件读取 `POSTGRES_IMAGE`，
**仅在本地缺少该镜像时拉取**，不会借此升级数据库。私有目录中若存在 `https.yml` 和
`pg17.yml`，会在**每次运行时**自动追加，保留现有 HTTPS 和 PostgreSQL 覆盖配置。
镜像选择仅读取已保存的显式、**不加引号**的 `CHORUS_IMAGE` 和 `POSTGRES_IMAGE`
标签/digest，绝不将 env 文件作为 shell 代码 source（Compose 仍用私有 env 配置服务）。通过
`up --pull never --wait` 幂等应用 Compose，不轮换凭据、不执行 `down`、不删除卷。
这里的**幂等**指复用同一项目、资源和凭据，不代表迁移回滚或数据库零写入：应用启动时
可能执行 Prisma 迁移。**部署新代码前先备份数据库和签名状态**（第 6 节），回滚须遵循
第 7 节的 schema 兼容性说明。
wrapper 的 `--dry-run` 读取并校验已有元数据/镜像引用，列出所选 Compose 文件，不调用
Docker，也不创建或修改文件。其他自定义覆盖（如 `oidc-only.yml`）不会自动发现；每次
重新部署都须在自行维护的 Compose 命令中显式保留。旧实例若尚无本地 wrapper，应保留
原私有路径与覆盖配置，并准备指向该路径的 wrapper，不要重新安装或复用 AWS 脚本。
创建 wrapper 并仅检查 `--dry-run` 不会重新编译或部署当前运行实例。
端口冲突、健康检查失败返回非零，排查时保留已有数据卷。

## 2. 准备私有配置

这是替代安装脚本的手工方案，不是安装后的后续步骤：会生成随机普通登录密码，管理员留到第 4 节配置。下列命令使用 **Bash**，在同一 shell 中执行。替换路径、项目名、邮箱和镜像。不要开启 shell tracing（`set -x`），不要把密钥贴到聊天中，也不要提交私有文件。私有目录放在仓库外，备份采用同等保护。

```bash
bash
set -euo pipefail
set +x
umask 077
REPO=/absolute/path/to/Chorus
PROJECT=chorus-personal
PRIVATE_DIR="$HOME/.config/chorus-self-host/$PROJECT"
mkdir -p "$PRIVATE_DIR"
chmod 700 "$PRIVATE_DIR"
ENV_FILE="$PRIVATE_DIR/env"
test ! -e "$ENV_FILE"
cp "$REPO/deploy/self-host/.env.example" "$ENV_FILE"
chmod 600 "$ENV_FILE"
read -r -p 'Existing Chorus release image or digest: ' CHORUS_IMAGE
read -r -p 'Bootstrap owner email: ' DEFAULT_USER
POSTGRES_PASSWORD="$(openssl rand -hex 32)"
DEFAULT_PASSWORD="$(openssl rand -hex 32)"
{
  printf 'CHORUS_IMAGE=%s\n' "$CHORUS_IMAGE"
  printf 'POSTGRES_IMAGE=postgres:17-alpine\n'
  printf 'POSTGRES_PASSWORD=%s\n' "$POSTGRES_PASSWORD"
  printf 'DEFAULT_USER=%s\n' "$DEFAULT_USER"
  printf 'DEFAULT_PASSWORD=%s\n' "$DEFAULT_PASSWORD"
  printf 'CHORUS_PORT=8637\nNEXTAUTH_SECRET=\n'
  printf 'SUPER_ADMIN_EMAIL=\nSUPER_ADMIN_PASSWORD_HASH=\n'
  printf 'CHORUS_PUBLIC_URL=\nCLOUDFLARED_IMAGE=\nCLOUDFLARED_TOKEN_FILE=\n'
} > "$ENV_FILE"
unset POSTGRES_PASSWORD DEFAULT_PASSWORD
```

选择**确实存在的明确发行标签**，例如 `chorusaidlc/chorus-app:vX.Y.Z`（必须替换 `X.Y.Z`，不是可直接执行的值），或仓库提供的不可变 `chorusaidlc/chorus-app@sha256:…` digest。不要假定源码当前版本已经发布，也不要把 `latest` 当作可复现保证。明确标识的本地构建镜像也可以使用，但不能据此宣称已测试某个公开发行版本。连接镜像仓库失败也不能证明标签不存在。

登录时通过受保护的编辑器/密码管理器取用自动生成的密码，不要将 env 文件打印到终端或日志。受版本控制的 `.env.example` 只是模板；真实 env 和 token 必须在 Git 外。使用 Compose 前清除与下表同名且冲突的已导出变量：shell 环境优先于 `--env-file`。不要 `source` 不可信 env 文件。用 `config --quiet` 检查，不要输出未经脱敏的 `docker compose config` 或容器环境，它们可能包含密码。

| 配置 | 约定 |
| --- | --- |
| `CHORUS_IMAGE` | 必填，明确的应用发行版本/digest；记录实际解析到的镜像身份。 |
| `POSTGRES_IMAGE` | 默认 `postgres:17-alpine`；可进一步固定已验证 digest。更改大版本前需要数据库升级计划。 |
| `POSTGRES_PASSWORD` | 必填，URL-safe 随机十六进制字符串；应用与数据库共享。用户名和库名均为 `chorus`。修改 env 不会改变已有数据库角色密码。 |
| `DEFAULT_USER`、`DEFAULT_PASSWORD` | Compose 渲染时必填的普通初始化邮箱/密码。安装脚本以双引号包裹的明文保存密码，转义反斜杠/双引号，并用 `$$` 表示字面的 `$`；手工示例生成随机十六进制密码。用于开发/demo，不是团队 SSO。 |
| `NEXTAUTH_SECRET` | 可选强随机覆盖值。为空时自动生成 `/app/data/.secret`，持久化于 `app-data`；常规升级不要删除它。 |
| `SUPER_ADMIN_EMAIL`、`SUPER_ADMIN_PASSWORD_HASH` | 独立的 `/admin` 账号，全新本地安装脚本必填，手工 Compose 可选。只保存 bcrypt hash，在 env 中加单引号以保留字面的 `$`。 |
| `CHORUS_PORT` | 仅本地模式使用；安装脚本默认 `18637`，手工 Compose 默认 `8637`，绑定 `127.0.0.1`。 |
| `CHORUS_PUBLIC_URL` | 仅 Tunnel 模式必填，实际外部 `https://` origin，不带末尾斜杠/路径；用于设置 `NEXTAUTH_URL`。 |
| `CLOUDFLARED_IMAGE` | 仅 Tunnel 模式必填，支持 token-file 的固定版本/digest，版本须为 **2025.4.0 或更新**。 |
| `CLOUDFLARED_TOKEN_FILE` | 仅 Tunnel 模式必填，主机私有文件的绝对路径，不是 token 内容。 |

服务名为 `app`、`db`，以及可选的 `cloudflared`；卷名为 `app-data`、`db-data`，由项目名隔离。所有服务使用 `restart: unless-stopped`。`REDIS_URL` 特意留空，内存实时事件分发仅支持单实例。

示例通过 `DATABASE_URL` 设置 `sslmode=disable`，仅用于同机私有 Compose 网络内的 PostgreSQL。特意不设置 `DB_HOST`：Chorus 会据此启用数据库 TLS，而默认本地 PostgreSQL 容器未启用 TLS。不要把此无 TLS 配置直接用于远程或不可信网络上的数据库；那种场景需单独配置并验证数据库 TLS。

## 3. 仅选择一种暴露模式

基础 `compose.yml` **不发布端口**，始终只搭配一个模式覆盖文件，不要同时合并 local 和 tunnel。后续保留所选 `dc` 函数，确保每次使用一致的项目名、私有 env 和模式。

### A. 本地 HTTP（推荐先验证）

```bash
dc() {
  docker compose --project-name "$PROJECT" --env-file "$ENV_FILE" \
    -f "$REPO/deploy/self-host/compose.yml" \
    -f "$REPO/deploy/self-host/compose.local.yml" "$@"
}
dc config --quiet
dc pull
dc up -d --wait
dc ps
```

在主机上打开 `http://localhost:8637`（如修改 `CHORUS_PORT`，相应调整）。该模式设置 `NEXTAUTH_URL=http://localhost:${CHORUS_PORT:-8637}`、`COOKIE_SECURE=false`。不要把 HTTP 端口直接公开。远程 Linux 主机可以使用 SSH 转发，例如 `ssh -N -L 8637:127.0.0.1:8637 user@your-host`，再在工作站打开 localhost；限制 SSH 访问即可，本地测试不需要 Cloudflare Tunnel。

若离线测试明确使用已有本地镜像，不要声称 `dc pull` 成功：记录拉取失败和本地镜像身份，按需单独获取数据库镜像。

### B. 可选 Named Tunnel HTTPS

Cloudflare 账号、受控域名/DNS 和远程管理的 Named Tunnel 由你提供，本指南不代为创建。按照[官方控制台步骤](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/)创建 Tunnel 和公开应用 hostname（例如 `chorus.your-domain.example`）。源站服务选择 **HTTP `http://app:8637`**，不是 `localhost`（在连接器容器里它指向连接器自身）。按 Cloudflare 流程将 hostname/DNS 关联到该 Tunnel。

将控制台提供的连接器 token 保存为私有文件，不要放到命令参数/历史里。同一 Bash shell 中可以这样做：

```bash
TOKEN_FILE="$PRIVATE_DIR/tunnel-token"
test ! -e "$TOKEN_FILE"
read -r -s -p 'Tunnel token (hidden): ' TUNNEL_TOKEN
printf '\n'
printf '%s' "$TUNNEL_TOKEN" > "$TOKEN_FILE"
unset TUNNEL_TOKEN
chmod 444 "$TOKEN_FILE"
```

父目录必须保持 `0700`。Compose 文件型 secret 实际是**主机文件绑定挂载**，不是加密密钥库。所选镜像的 UID 必须能读取文件；在上述私有目录内使用 `0444` 是兼容非 root 连接器的实用方案。不要使用公共可访问的父目录，不要假定 Compose 的 `uid`/`mode` 会重映射绑定文件权限。rootless Docker/user namespace 情况应核对实际 UID 和可读性，不要全局放宽目录权限。参见 [Docker secrets 文档](https://docs.docker.com/compose/how-tos/use-secrets/)。

在私有 env 中设置 `CHORUS_PUBLIC_URL=https://chorus.your-domain.example`、确实存在的固定 `CLOUDFLARED_IMAGE=cloudflare/cloudflared:<version>`，以及指向 `TOKEN_FILE` 绝对路径的 `CLOUDFLARED_TOKEN_FILE`。连接器使用 `tunnel --no-autoupdate run --token-file /run/secrets/tunnel_token`；[官方说明 `--token-file` 要求 2025.4.0 或更新](https://developers.cloudflare.com/tunnel/reference/run-parameters/#token-file)。不要换成携带明文 token 的 `--token` 参数。

从已有本地模式切换时，先用**旧的 local 函数**运行 `dc down`，保留卷并移除绑定回环端口的容器，再选择 Tunnel 模式：

```bash
dc() {
  docker compose --project-name "$PROJECT" --env-file "$ENV_FILE" \
    -f "$REPO/deploy/self-host/compose.yml" \
    -f "$REPO/deploy/self-host/compose.tunnel.yml" "$@"
}
dc config --quiet
dc pull
dc up -d --wait
dc ps
```

TLS 在 Cloudflare 终止，Compose 私有网络源站仍使用 HTTP。该模式设置 `COOKIE_SECURE=true` 和真实外部 URL 的 `NEXTAUTH_URL`。必须用真实浏览器确认 HTTPS 和 Secure cookie，不能仅看连接器健康。切回本地时也先用旧 Tunnel 配置 `down`，再 local `up`；绝不使用 `down -v`。token 按密码保护；泄露后在 Cloudflare 吊销/轮换，替换私有文件并重建连接器。

### 缓存、流式传输和 Access 策略

- 建议整个 Chorus hostname 绕过缓存。至少**绝不缓存已认证页面、登录/认证路由、`/api/*`、`/api/mcp`、`/api/events` 和 `/api/events/notifications`**。不要对这些路径套用 Cache Everything 或缓存响应的 Worker。配置并检查 [Cloudflare Cache Rules](https://developers.cloudflare.com/cache/how-to/cache-rules/)，确认不同用户不会收到缓存 HIT 的私有响应。
- 当前 Chorus SSE 返回 `Content-Type: text/event-stream`、`Cache-Control: no-cache`。确认事件/心跳逐步抵达，而不是断开后才成批出现。若额外加反向代理，应关闭流式响应缓冲；NGINX 对 [`proxy_buffering` 和 `X-Accel-Buffering`](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering)有说明。对使用该头的代理检查 `X-Accel-Buffering: no`；当前 Chorus 不主动返回这个头，它也**不是** Cloudflare 的 SSE 保证。本指南未找到针对该链路的官方 SSE 缓冲保证，必须端到端实测。
- [Cloudflare 支持 WebSocket](https://developers.cloudflare.com/network/websockets/)，但网络/服务器重启可能中断连接，客户端必须支持重连。本指南的 Chorus 浏览器/daemon 检查实际使用 SSE，不虚构 WebSocket 端点；如果添加 WebSocket 消费者，应另测 upgrade 和重连。
- Cloudflare Access 交互式登录/challenge 会把 API/MCP/daemon 请求变成 HTML/重定向，破坏非浏览器客户端。Chorus API key 不会自动通过 Access。应让这些路由使用 Chorus 本身认证而不触发交互式 Access，或显式完成机器客户端集成；[Access service token](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)需要额外请求头和客户端支持，不能声称现有 CLI 会自动发送。不要以关闭 Chorus 认证作为解决办法。

## 4. 登录与团队身份

首次本地验证使用安装时所选的普通邮箱/密码（`DEFAULT_USER`、`DEFAULT_PASSWORD`），或手工方案生成的密码。`/api/auth/default-login` 接收 `{email, password}`，设置 HttpOnly `user_session` cookie。当前默认登录会话有效期为 **365 天**。原有开发/demo 路径会自动创建用户/公司；安装时询问凭据并不使其成为完整团队 SSO 或团队账号系统。不要共享初始化账号，也不要让所有团队成员共用它。

**`/admin` 账号独立于普通登录**。本地安装脚本已配置管理员邮箱和 bcrypt 哈希，用所选管理员密码登录 `/admin` 即可。手工部署请参考[认证说明](AUTH.md)，配置 `SUPER_ADMIN_EMAIL` 和 bcrypt `SUPER_ADMIN_PASSWORD_HASH` 后重建 app。团队使用时，在管理界面设置公司的 OIDC issuer、client ID 和启用状态。**OIDC 配置按公司保存在数据库中，不是 `OIDC_*` 环境变量。** 使用 Authorization Code + PKCE client；在身份提供方注册 `${CHORUS_PUBLIC_URL}/login/callback` 回调、`${CHORUS_PUBLIC_URL}/login` 登出跳转（本地测试改成真实本地 origin）。用不同用户验证允许的 origin、token/refresh 策略及公司成员身份；不要假定初始化身份与 OIDC 身份自动合并。

验证 OIDC 期间可以暂留强随机、私有的初始化账号，但把它当作高权限后备入口，绝不作为团队共享密码。**确认管理员和 OIDC 均可登录之后**，若需要 OIDC-only，增加一个小型私有覆盖文件：

```yaml
services:
  app:
    environment:
      DEFAULT_USER: ""
      DEFAULT_PASSWORD: ""
```

保存为 `$PRIVATE_DIR/oidc-only.yml`，在 `dc` 的所选模式文件**之后**、`"$@"` 之前追加 `-f "$PRIVATE_DIR/oidc-only.yml"`。私有 env 仍需保留非空初始化值：Compose 会先展开基础文件的 `${DEFAULT_USER:?...}`、`${DEFAULT_PASSWORD:?...}` 再合并，因此直接清空 env 会导致渲染失败。执行 `dc config --quiet`、`dc up -d --wait --force-recreate app`。禁用密码登录不会自动吊销已签发的长期会话；必要时制定会话吊销/签名密钥轮换计划，轮换会导致所有用户重新登录。后续备份、升级始终保留该覆盖文件。

## 5. 验收检查（在自己的部署上执行）

以下是操作说明，**不是已通过声明**。每项记录准确镜像 tag/digest/ID、日期、模式和结果。仓库测试环境的实际结果与限制单独记录在[验证证据](acceptance/self-host-guide.md)；本地镜像测试不等于公开发行版本测试。没有提供域名/token 时，公共 DNS/TLS、Tunnel、外部 cookie、经 Cloudflare 的流式传输以及 Access 兼容性都保持**待验证**。R2 上传/恢复同样需要实际执行后才能声称通过。

### 健康、登录和 REST

设置 `BASE_URL=http://localhost:8637` 或真实 HTTPS origin。`curl --fail --silent --show-error "$BASE_URL/api/health"` 应返回 `status: ok`、`database: connected`。容器健康不代表浏览器登录或公网链路正常。

浏览器登录并检查 cookie（HTTPS 下 Secure、HttpOnly、SameSite=Lax），创建临时项目/idea，刷新确认持久化。可选的 Bash 检查避免把密码放进 curl 参数或输出 cookie：

```bash
BASE_URL=http://localhost:8637
COOKIE_JAR="$PRIVATE_DIR/check.cookies"
read -r -p 'Bootstrap email: ' CHECK_EMAIL
read -r -s -p 'Bootstrap password (hidden): ' CHECK_PASSWORD
printf '\n'
export CHECK_EMAIL CHECK_PASSWORD
jq -n '{email: env.CHECK_EMAIL, password: env.CHECK_PASSWORD}' |
  curl --fail --silent --show-error -c "$COOKIE_JAR" \
    -H 'Content-Type: application/json' --data-binary @- \
    "$BASE_URL/api/auth/default-login" -o /dev/null
unset CHECK_EMAIL CHECK_PASSWORD
chmod 600 "$COOKIE_JAR"
curl --fail --silent --show-error -b "$COOKIE_JAR" \
  "$BASE_URL/api/auth/me" -o /dev/null
curl --fail --silent --show-error -b "$COOKIE_JAR" \
  "$BASE_URL/api/projects" -o /dev/null
```

如已禁用初始化认证，改用浏览器验证 OIDC。不要发布 cookie 文件、请求头、API key、env 文件或未脱敏日志。

### MCP、实时更新和 daemon

在 UI 创建专用测试 Agent/API key，仅授予所需权限。在客户端使用已有的兼容 Chorus CLI，无需安装 daemon 系统服务或重写全局配置。在私有 Bash 子 shell 中执行：

```bash
(
  set +x
  umask 077
  export CHORUS_URL="$BASE_URL"
  read -r -s -p 'Test agent API key (hidden): ' CHORUS_API_KEY
  printf '\n'
  export CHORUS_API_KEY
  unset CHORUS_AGENT_PROFILE
  export CHORUS_DAEMON_CONFIG_PATH="$PRIVATE_DIR/check-daemon.json"
  export CHORUS_CLAUDE_SETTINGS_PATH="$PRIVATE_DIR/check-claude-settings.json"
  chorus mcp whoami
  chorus mcp call chorus_get_my_assignments '{}'
)
```

MCP 端点为 `/api/mcp`，需检查实际工具响应，而不是仅看 HTTP 200 或 Cloudflare HTML 页面。密钥不出现在参数/历史中，但拥有主机高权限的用户仍能读取进程环境。

两个浏览器标签页打开同一临时项目，在一个页面创建/修改 idea，确认另一个页面增量更新。也可用受保护的 cookie 文件做有时间上限的 SSE 观察：

```bash
curl --fail --silent --show-error --no-buffer --max-time 35 \
  -b "$COOKIE_JAR" "$BASE_URL/api/events" || test "$?" -eq 28
```

应在超时前看到事件/心跳，而不是关闭时一次性出现。对有意限时的长连接，退出码 28 是预期现象，但**不能证明**事件已经到达。结束后 `rm -f "$COOKIE_JAR"` 删除 cookie 文件。

daemon 验证复用上述私有子 shell/key 配置，前台运行 `chorus daemon --chorus-only --cwd /absolute/path/to/disposable-repo --browse-root /absolute/path/to/disposable-repo`。不存在 `--foreground` 参数。需要完全隔离时使用专用客户端账号/HOME，不影响已有全局 daemon/profile。实际 wake 执行要求可用的本地 Agent 后端；`--chorus-only` 将默认 Claude 后端限制为 Chorus 工具，但它不是操作系统沙箱。普通 daemon 默认有更广自主权限，不要随意省略防护。

在 UI 确认 Agent 在线，或调用认证后的 `GET /api/agent-connections`（响应 `data.connections`）。只派发临时任务；后端凭据可用时确认 wake/工作汇报。Ctrl-C 停止，再启动确认重连和在线状态恢复；daemon SSE 使用 `/api/events/notifications`。没有后端时，将 wake 执行标为待验证并说明原因。Tunnel 模式受控重启连接器后重复检查，不承诺零事件丢失或连接永不中断。

最后执行 `dc restart app`，等待健康，确认临时数据和原有登录仍可用。`dc up -d --force-recreate app` 比单纯重启更能验证卷持久化的签名密钥。预期会有短暂中断，不是高可用方案。公网验收还需验证 DNS 归属/路由、有效 HTTPS、主机无应用/数据库端口暴露、缓存绕过、OIDC 跳转、浏览器及 CLI 认证、SSE 增量到达和连接器中断后的重连。

## 6. 安全备份与恢复

数据库存于 `db-data`，`/app/data`（包括自动生成的签名密钥）存于 `app-data`。`dc down` 保留卷，**`dc down -v` 会删除数据**。重启策略不能修复磁盘丢失；应定期备份、监控失败/空间，并演练恢复。同一磁盘上的本地副本不等于灾备。

### 受保护的逻辑备份

沿用原 `dc` 函数（包含任何私有覆盖文件）。安排维护窗口，停止 app 暂停写入；不要复制运行中的 PostgreSQL 数据目录。选择仓库外的新备份目录：

```bash
BACKUP_DIR="$HOME/chorus-backups/$PROJECT/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
dc stop app
dc exec -T db pg_dump -U chorus -d chorus -Fc > "$BACKUP_DIR/database.dump"
dc run --rm --no-deps -T --entrypoint tar app \
  -C /app/data -czf - . > "$BACKUP_DIR/app-data.tar.gz"
cp "$ENV_FILE" "$BACKUP_DIR/env"
cp "$REPO/deploy/self-host/compose.yml" "$BACKUP_DIR/compose.yml"
dc images > "$BACKUP_DIR/images.txt"
chmod 600 "$BACKUP_DIR"/*
dc start app
```

`set -e` 下任一步失败都可能让 app 保持停止：先排查备份错误，再明确执行 `dc start app`，不要把不完整 dump 当成功。另行保存所选模式文件、私有 OIDC 覆盖、确切源码 revision/release 和不可变镜像 digest。Tunnel token 可单独安全备份，或记录重新签发流程。显式 `NEXTAUTH_SECRET` 必须随私有 env 备份，自动生成值则在 app-data 归档中。不要打印 `.secret`。恢复时缺少对应密钥会使会话失效。保留/恢复归档属主；任意切换为其他非 root UID 可能使数据不可读。

使用既有备份工具加密完整备份集后，再传到异地主机或可选 R2。解密密钥独立保存，限制 bucket 凭据权限，定义保留周期，并验证下载/解密及数据库恢复。本指南不执行或认证 R2 备份流程。

### 在另一个项目中演练恢复

绝不覆盖原项目。选择**全新未使用**项目名及空闲回环端口，确认该项目名下不存在旧容器或卷。使用备份时匹配的应用镜像和 PostgreSQL 大版本，在导入数据库/签名密钥前不要启动应用。以下假设使用相同配置源码和上述完整备份：

```bash
RESTORE_PROJECT=chorus-restore-rehearsal
RESTORE_ENV="$PRIVATE_DIR/restore.env"
test ! -e "$RESTORE_ENV"
cp "$BACKUP_DIR/env" "$RESTORE_ENV"
chmod 600 "$RESTORE_ENV"
sed -i 's/^CHORUS_PORT=.*/CHORUS_PORT=18637/' "$RESTORE_ENV"
restore_dc() {
  docker compose --project-name "$RESTORE_PROJECT" --env-file "$RESTORE_ENV" \
    -f "$REPO/deploy/self-host/compose.yml" \
    -f "$REPO/deploy/self-host/compose.local.yml" "$@"
}
restore_dc config --quiet
restore_dc up -d --wait db
restore_dc exec -T db pg_restore -U chorus -d chorus --exit-on-error \
  < "$BACKUP_DIR/database.dump"
restore_dc run --rm --no-deps -T --entrypoint tar app \
  -C /app/data -xzf - < "$BACKUP_DIR/app-data.tar.gz"
restore_dc up -d --wait app
```

保持恢复实例隔离：不启动 cloudflared，不连接正式 daemon，不切换公网 DNS。如果正式实例使用 OIDC-only 覆盖，也要追加到 `restore_dc`；恢复后的 IdP 跳转可能需要另行批准本地 callback。否则可以用复制的强随机初始化凭据做本地检查。每次演练换用新的 env 文件路径/项目名，不要在已有恢复库上重复运行导入命令。

检查 `http://localhost:18637/api/health`、登录、已知临时记录/数量和签名密钥校验和（**不暴露内容**），对照原备份确认一致性。保留签名密钥可用于恢复会话，但身份提供方过期/吊销规则仍生效。使用独立浏览器 profile 或清除 localhost cookie，因为 cookie 不按端口隔离。用 `restore_dc down` 停止演练实例；保留或在确认准确项目后仅删除自己的临时卷，绝不删除正式卷。

## 7. 升级、回滚与排障

**PostgreSQL 16 → 17 必须通过逻辑备份/恢复迁移，不能只改镜像。** PostgreSQL 17 无法打开已有的 PostgreSQL 16 数据卷。保留源实例运行 PostgreSQL 16，按前文使用 `pg_dump` 进行逻辑备份。仅在此次大版本迁移时，将隔离恢复演练中新项目的私有 env 文件设为 `POSTGRES_IMAGE=postgres:17-alpine`，使用 `pg_restore` 恢复到全新卷。保留原卷、应用签名材料和私有配置，验证恢复的数据与应用后再受控切换，最终备份前停止源实例写入。切勿将 `docker compose down -v` 作为升级步骤。普通故障恢复演练仍使用与备份匹配的 PostgreSQL 大版本。

1. 阅读 release notes 和迁移说明，记录原镜像 digest、配置 revision、备份位置；完成包含签名密钥的升级前备份和恢复演练。
2. 私有 env 中仅将 `CHORUS_IMAGE` 改为所选版本/digest，执行 `dc config --quiet`、`dc pull app`、`dc up -d --wait app`。启动会运行数据库迁移，预留维护时间；可用 `dc logs --tail 100 app db` 查看受限日志，分享前必须脱敏。
3. 重复健康、登录、REST/MCP、实时/重连及持久化检查，监控磁盘和日志。PostgreSQL、cloudflared 分别升级，不混入无关变更。
4. 旧镜像**不会逆转 schema 迁移**。仅在确认兼容时直接回退镜像；否则先在隔离的其他项目中恢复匹配的升级前 dump、应用密钥/配置及旧镜像，验证后制定受控切换方案。备份之后的新写入需要明确恢复/对账决策，不能静默丢弃，也不能盲目让旧程序连接迁移后的数据库。

| 现象 | 检查方向 |
| --- | --- |
| Compose 报变量缺失 | 私有绝对路径 `--env-file`、初始化值非空（即使 OIDC-only）、只选一个模式。 |
| 修改 env 后数据库认证失败 | 已有卷保留旧角色密码；协调数据库角色与 app 配置的正规改密流程，不要删卷。 |
| Tunnel 健康但 hostname 报错 | hostname/DNS、`http://app:8637` 源站、应用健康、连接器日志/token 可读性、出站防火墙。 |
| HTTP 登录立即失败 | 本地覆盖应为 `COOKIE_SECURE=false`；HTTPS 应使用 Tunnel 覆盖及真实外部 URL。 |
| 重建容器导致所有用户退出 | app-data 密钥缺失/不匹配或显式 `NEXTAUTH_SECRET` 改变；私下检查挂载，不贴密钥。 |
| 浏览器正常，CLI 收到 HTML | Access 交互式 challenge、重定向、缓存/Worker 规则、错误的 `/api/mcp` 地址。 |
| 实时事件成批到达或停滞 | content type/no-cache、中间代理缓冲、逐步心跳测试、连接器/客户端重连及后端可用性。 |

排障时不要泄露密钥，不做全局 Docker 清理，不修改其他实例，不把 PostgreSQL 暴露到互联网。只有实际使用自己的云资源完成检查之后，公网验收才能从待验证改为通过。
