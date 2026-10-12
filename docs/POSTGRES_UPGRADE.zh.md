# 已有 PostgreSQL 16 数据库迁移到 17

[English](POSTGRES_UPGRADE.md)

新部署默认使用 PostgreSQL **17**。即使应用只用普通 SQL，PG17 **也不能直接打开
PG16 的数据目录**。`prisma migrate deploy` 只升级应用表结构，不升级数据库引擎。
已有 PG16 卷时，不要直接运行新版根目录 `pnpm docker:db`。启动失败也不要删除旧卷，
更不要用 `docker compose down -v` 解决。

下面的显式脚本执行**离线逻辑迁移**，不自动部署或切换。原卷始终只读挂载：先复制
已停止的 PG16 集群到工作卷，再通过隔离的 PG16 容器备份数据库和全局对象，恢复到
**全新 PG17 卷**，对比 public 表的行数以及序列值和 `is_called` 状态。退出时停止自己
创建的辅助容器；成功或失败都保留所有卷与私有备份。行数只是完整性初检，不代替内容
及应用功能验证。

## 支持范围与前提

- Linux、Bash、Docker 和标准核心工具；提前运行 `docker pull postgres:16-alpine`
  与 `docker pull postgres:17-alpine`。脚本只使用已缓存镜像，不自动拉取。
- 可信的官方 PG16 Alpine 默认布局**命名卷**，数据在 `/var/lib/postgresql/data`，
  使用默认本地 socket 认证，数据库超级用户可用。不支持 PGlite、远程/托管数据库、
  bind mount、自定义 tablespace，也不是通用的整个集群迁移工具。
- 只迁移一个应用库，默认 `chorus`，其他数据库**不会迁移**。仅支持 public schema；
  额外 schema/扩展、外部表、RLS 会被拒绝。**不恢复自定义角色、授权或原所有权**，
  对象归属于 `--db-user`（默认 `chorus`）。`globals.sql` 仅供 DBA 审阅，不自动执行。
  需要这些能力时请走 DBA 辅助迁移流程。
- 预留足够磁盘容纳完整工作副本、逻辑备份和全新 PG17 集群。dry-run 不检查容量或
  数据库兼容性。
- 单独备份原部署配置与应用签名材料。停止所有应用、CLI、开发服务器及外部写入方，
  再停止原数据库，防止其他管理程序在维护期间自动重启它们。脚本检查运行中容器的
  卷挂载，但无法代替操作者维护停写窗口。

## 显式执行迁移

先从**正确项目**的数据库容器确认源卷名称：

```bash
docker inspect YOUR_DB_CONTAINER --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}'
```

根目录开发环境：停止 dev server 后运行 `docker compose stop app db`。
安装器管理的本地实例：使用原有 Compose 命令并带齐**全部私有覆盖文件**停止 app/db。
不要停止其他实例，也不要重跑安装器。若旧库已因选 PG17 启动失败，保持其停止即可，
脚本会用 PG16 打开副本。

在**仓库外**的 0700 私有目录创建 0600 密码文件，仅包含原数据库角色密码的一行。
这是数据库密码，不是 Chorus 用户或超级管理员登录密码。应与应用连接配置一致；
根目录开发示例使用 `chorus`。不要把密码放进命令参数。

替换以下卷名和路径。备份目录必须**尚不存在**，父目录须存在；新卷 `TARGET`、
`TARGET-source16` 和辅助容器 `TARGET-source16`、`TARGET-target17` 名称必须未被占用。

```bash
bash deploy/self-host/migrate-pg16-to-17.sh \
  --source-volume YOUR_OLD_PG16_VOLUME --target-volume chorus-pg17-migrated \
  --backup-dir /absolute/private/path/pg17-backup \
  --password-file /absolute/private/path/db-password --writers-stopped --dry-run
```

确认预览后仅移除 `--dry-run` 执行。脚本不等待终端交互；`--database` 和 `--db-user`
可覆盖 `chorus`，仅支持小写 SQL 标识符。用同样的备份目录/目标重复运行会**明确拒绝**，
不会覆盖或自动续跑。失败后先检查受保护的日志，再选新名称重试。备份包含密码、
全局对象/密码哈希与业务数据，必须私有保存，异地副本加密；不得提交 Git 或公开上传。

## 验证与切换 Compose

保持停写。检查退出码、`SHA256SUMS`、两份 `*-counts-sequences.txt`，并在放流量前
验证代表性数据、迁移记录、登录及应用行为。脚本**不会启动 Chorus 或验证身份提供方**。
建议先验证同版本应用；直接启动新版代码可能另外执行应用 schema migration。

脚本成功退出后，仅删除它创建的已停止辅助容器，防止以后误启动并与目标库争用卷：

```bash
docker rm chorus-pg17-migrated-source16 chorus-pg17-migrated-target17
```

所有卷仍保留。

### 根目录开发 Compose

在 Git 外创建私有覆盖文件，例如 `/absolute/private/path/pg17.yml`：

```yaml
volumes:
  chorus-data:
    external: true
    name: chorus-pg17-migrated
```

```bash
docker compose -f docker-compose.yml -f /absolute/private/path/pg17.yml up -d db redis
```

后续始终使用此文件组合，**不要再裸跑 `pnpm docker:db`**，那个快捷命令不加载私有覆盖。
app-data 和 Redis 卷不变，验证数据库后再启动 dev server。

### 安装器管理的本地部署

先备份，再创建/更新私有目录中已有的 `pg17.yml`：

```yaml
volumes:
  db-data:
    external: true
    name: chorus-pg17-migrated
```

私有 `env` 改为 `POSTGRES_IMAGE=postgres:17-alpine`；数据库密码、应用/登录凭据、
app-data 卷、签名密钥及 HTTPS 覆盖文件全部保留。用带 base/local、已有 HTTPS 和
本 PG17 覆盖的原 Compose 命令启动 db，再启动**相同应用镜像**进行验证。
之后 `bash default_deploy.sh` 会每次自动加载私有 `pg17.yml`；它可能构建/拉取新版
代码，所以不要用它替代同版本的纯数据库升级验证。

## 失败处理与回滚

脚本不会修改原卷。旧卷和备份至少保留到验收及保留期结束。PG17 **尚未接受新写入**
时，可停止目标 app/db，通过私有 Compose 覆盖同时选择原卷和 **PG16 镜像**，并恢复
旧应用镜像、配置与签名材料。只移除新卷覆盖不够，因为根 YAML 已默认 PG17。
PG17 接受新写入后再切回会丢掉这些写入，需另行协调数据同步/恢复，脚本不会静默回切。

其他升级方式见 [PostgreSQL 17 官方升级文档](https://www.postgresql.org/docs/17/upgrading.html)。
