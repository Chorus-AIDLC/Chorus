---
title: "Chorus v0.22.2: 在本地托管 Chorus 服务"
description: "不依赖云服务器，如何在自己的主机上长期运行 Chorus，并支持局域网与外网访问？"
date: 2026-10-15
lang: zh
postSlug: chorus-v0.22.2-release
---

# Chorus v0.22.2: 在本地托管 Chorus 服务

从本机试用转向长期使用，需要考虑的不只是应用启动。数据库的持久化、跨设备访问、账号配置的保留，以及后续升级，都需要明确的部署和运维方式。对于希望将服务保留在自有设备上的个人或团队，这些需求并不一定需要通过云服务器实现。

Chorus v0.22.2 新增面向 Linux 和 macOS 的本地自托管安装流程，支持可选的局域网 HTTPS 和 Cloudflare Tunnel 接入，并增加 TRAE CLI 后端。

## 本地安装与重复部署

快速试用仍可使用 npm 包和内嵌 PGlite，无需 Docker。新增的自托管方案则通过 Docker Compose，在同一台主机上运行 Chorus 应用和 PostgreSQL 17，适合需要独立数据库的单主机部署。

安装 Docker 和支持 `up --wait` 的 Compose v2 后，在包含本版代码的 Chorus 仓库目录中运行：

```bash
bash install.sh --target local
```

安装器支持拉取发布镜像或从当前源码构建，并引导配置普通登录账号和独立的超级管理员账号。密码输入隐藏，配置保存在仓库之外的私有目录中。数据库不发布主机端口，仅通过容器内部网络访问。

安装完成后会生成重新部署脚本，后续部署复用已保存的配置，无需重新设置账号或重置凭据：

```bash
bash ./default_deploy_local.sh --dry-run
bash ./default_deploy_local.sh
```

构建模式会重新编译当前源码；拉取模式使用已保存配置中的镜像版本，不会自动追随 `latest`。升级前仍需备份数据库和签名状态。重新部署脚本不能替代备份，也不保证数据库迁移可回滚。

该方案为不带 Redis 的单实例部署。多实例场景仍应采用外部 PostgreSQL 和 Redis 的生产部署方案。

## 局域网 HTTPS 与外网访问

本地安装默认提供局域网 HTTP 访问，也可在安装时选择启用自签名 HTTPS。这种方式适用于可信局域网；自签名证书需要单独处理客户端信任，访问端口仍应通过防火墙限制。

需要外网访问时，可按指南切换到 **Cloudflare Named Tunnel** 模式。Chorus 仍运行在本地主机上，通过连接器对外提供 HTTPS，无需开放主机入站端口。

Cloudflare 账号、域名和 Named Tunnel 由部署者自行准备。源站地址应设为容器网络中的 `http://app:8637`，而非 `localhost`。切换后应使用指南中的 Tunnel Compose 命令管理服务，不再使用本地部署脚本。

Cloudflare 配置还需注意缓存和认证：已认证页面、API 和事件流应绕过缓存；交互式 Cloudflare Access 验证会阻断 API、MCP 和后台 Agent 请求，Chorus API Key 本身无法通过该验证。

完整的安装、局域网 HTTPS、Tunnel 切换和备份步骤见[本机自托管指南](https://doc.chorus-ai.dev/zh/guides/deploy-local/)。已有 PostgreSQL 16 数据卷的实例，应先按迁移说明处理，不可直接使用 PostgreSQL 17 镜像启动旧卷。

## TRAE CLI 接入

完成服务部署后，可按实际使用的编码工具接入 Agent。v0.22.2 新增 TRAE CLI 后端，既支持交互式使用 Chorus 工作流，也支持通过 daemon 接收分配的工作。

安装并登录 `traecli`，准备 Chorus 实例地址和 Agent API Key 后，运行：

```bash
npm install -g @chorus-aidlc/chorus
chorus agents add --agents trae
```

安装器会配置插件、MCP 和连接凭证。首次使用时需在 TRAE 中信任 Chorus hooks。启用后台执行时，运行：

```bash
chorus daemon --agent trae
```

TRAE 与 Codex 共用插件包及 App Server 协议实现，同时保留各自的配置目录、线程记录和身份。若同一台主机配置多个 TRAE Agent，需为每个 Agent 设置独立的 `TRAE_HOME`，避免共享 `.env` 导致身份被覆盖。

本次验证基于 `traecli 0.209.1`，更早版本未经验证。完整步骤见 [TRAE CLI 接入指南](https://doc.chorus-ai.dev/zh/reference/agents/trae/)。

## 运行可靠性与安全修复

长期运行的实例需要处理 Agent 删除、项目调整等操作留下的状态。本版修复了失效指派关系和 Idea 层级关系对后续操作的影响。

删除 Agent 时会释放其尚未完成的工作，移动 Idea 时不再被已不存在的负责人阻塞。负责人缺少目标项目权限时，系统会说明阻止移动的原因。删除公司、项目或项目组前，会先解除相关 Idea 层级关系，避免数据库关系约束导致删除失败。

后台执行方面，显式传入的 `--daemon-wake` 会应用到已配置 Agent；`--chorus-only` 通过工具白名单检查执行限制，并在违规时终止运行；错误输出截断后的已知凭证片段也会被完整脱敏。

七套插件和四个 npm 发布包统一升级到 **0.22.2**，TRAE 与 Codex 共用同一插件版本。

通过本地安装、可重复部署和可选的外网访问，个人与团队可以在自有主机上托管 Chorus 服务，并接入日常使用的 Agent，在同一项目中完成工作分配、方案审查和结果验收，无需以迁移到云服务器作为前提。
