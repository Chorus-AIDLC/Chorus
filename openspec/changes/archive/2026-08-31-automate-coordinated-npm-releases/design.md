## Context

仓库包含三个独立 npm 发布单元：

- 根目录 `@chorus-aidlc/chorus`，提供 `chorus` CLI；
- `packages/openclaw-plugin` 中的 `@chorus-aidlc/chorus-openclaw-plugin`；
- `packages/chorus-dsh` 中的 `@chorus-aidlc/chorus-dsh`。

三者源码版本当前同步，但安装和校验方式不同。根包和两个插件各自带有构建或发布前钩子，现有根包与 OpenClaw 发布脚本还包含 `npm whoami` 和交互确认，不适合作为无 token、无交互的 CI 入口。现有 release 流程在 `main` 合并后创建 `vX.Y.Z` GitHub Release，因此 Release `published` 是最贴近当前人工批准边界的自动发布触发点。

npm Trusted Publishing 已分别为三个包绑定同一个 GitHub Actions workflow。该机制要求 GitHub 托管 runner、`id-token: write`、Node 22.14.0+ 和 npm 11.5.1+；npm CLI 在 `npm publish` 时自动使用 OIDC，不需要 `NODE_AUTH_TOKEN` 或 `NPM_TOKEN`。

## Goals / Non-Goals

**Goals:**

- 由一个 workflow 协同发布三个 npm 包，并保持版本与 GitHub Release tag 一致。
- 在任何 registry 写入前完成所有可前置的质量和包内容校验。
- 不在 GitHub Secrets、环境变量或仓库文件中存储 npm 发布 token。
- 在部分包已成功发布后允许安全重跑，并清楚报告发布或跳过结果。
- 保留明确的发布顺序和失败即停止语义，便于诊断和审计。

**Non-Goals:**

- 提供 npm registry 的跨包原子事务；npm 本身不支持多包原子发布。
- 自动生成版本号、CHANGELOG、tag 或 GitHub Release；这些仍由现有 release 流程和人工批准负责。
- 自动回滚或 unpublish 已公开的版本。
- 更改三个包的运行时功能、npm 名称或安装方式。
- 在本次变更中自动修改 npm 网站上的 Trusted Publisher 配置。

## Decisions

### 由 GitHub Release `published` 触发

workflow 监听：

```yaml
on:
  release:
    types: [published]
```

运行必须检出 `github.event.release.tag_name` 对应的不可变 tag，而不是可移动分支。脚本去掉前导 `v` 得到预期版本，并要求三个 `package.json` 的 `name` 与 `version` 精确匹配受支持清单和该版本。

选择 GitHub Release 而不是每次推 tag，是因为现有 release 流程把 Release 创建放在 CHANGELOG 审核、PR 合并和 tag 确认之后；它提供了更清晰的人工批准边界。可保留 `workflow_dispatch` 作为同一 Release/tag 的重跑入口，但不得允许任意未发布分支绕过版本和 tag 校验。

### 一个 workflow、一个 OIDC 权限边界

三个 npm package 的 Trusted Publisher 均绑定 `.github/workflows/publish-npm.yml`。workflow 使用：

```yaml
permissions:
  contents: read
  id-token: write
```

并运行在 `ubuntu-latest`。Node 使用受支持的 24.x，随后显式校验 npm CLI 至少为 11.5.1。`actions/setup-node` 配置 npm registry，但 workflow、脚本和环境不得引用 `NPM_TOKEN` 或 `NODE_AUTH_TOKEN`。

如果 npm Trusted Publisher 配置指定了 Environment，job 的 `environment` 必须与之精确匹配；如果 npm 侧留空，则 workflow 也不强制 Environment。本实现不得假定或创建 GitHub secret。

### 先全量验证和打包，再上传

流程分为两个阶段：

1. **Prepare**：安装根 workspace 与独立 OpenClaw 包依赖；对三个发布单元执行各自适用的 lint/typecheck/test/build/package checks；生成 tarball；检查 tarball 元数据、必需入口和禁止文件；保存确定的 tarball 路径与摘要。
2. **Publish**：只有三个 prepare 全部成功后，才按固定清单顺序上传已经验证的 tarball。

这避免根包成功发布后才发现插件无法构建。上传 tarball 而不是重新从工作目录打包，保证发布的是 prepare 阶段验收过的字节。实现必须验证 `npm publish <tarball>` 在 Trusted Publishing 下产生正常 provenance；不得通过关闭 provenance 来规避配置错误。

现有交互式 `scripts/npm-publish.sh` 和 `packages/openclaw-plugin/bin/publish.sh` 不作为 CI 入口，因为 `npm whoami`、本地登录检查和提示与 OIDC 无交互执行冲突。

### 固定顺序、幂等恢复

发布顺序固定为：

1. `@chorus-aidlc/chorus`
2. `@chorus-aidlc/chorus-openclaw-plugin`
3. `@chorus-aidlc/chorus-dsh`

上传每个包前，脚本查询精确的 `<name>@<version>`。若 registry 已存在该版本，则记录为 `skipped-already-published` 并继续；若不存在，则执行 `npm publish <tarball> --access public`。除“明确不存在”外的 registry 查询错误必须失败，不能被误判为未发布。

任何 publish 失败立即终止后续上传。维护者修复外部问题后，可从 GitHub Actions 重跑同一 Release；已成功的包被跳过，其余包继续。npm 不支持多包事务，因此不尝试自动 unpublish。

### 脚本承载可测试逻辑，YAML 只负责编排

版本解析、包清单、registry 状态分类、tarball 映射和发布循环放入仓库脚本，workflow 仅负责事件、权限、工具链和调用。脚本提供 dry-run 或可注入的 npm 命令边界，以便测试以下行为：

- tag 与三个版本不一致时在发布前失败；
- 包名或目录漂移时失败；
- 三个 tarball 全部准备成功后才进入 publish；
- 已发布版本被跳过；
- registry 网络/权限错误和 publish 错误立即停止；
- 日志不包含认证凭证。

## Module Contracts

- **Release manifest**：唯一清单按顺序映射 `directory -> expected package name -> tarball path`；校验、测试和 publish 共用该清单，避免三个阶段各自维护包列表。
- **Version input**：规范版本来自 Release tag `vX.Y.Z`；内部脚本只接收去除 `v` 后的精确 semver，并与每个 manifest 条目比较。
- **Prepare result**：每个包返回 package name、version、绝对 tarball path 和 SHA-256；任何条目失败则没有 publish 阶段。
- **Registry lookup**：仅“目标版本不存在”映射为 `missing`；存在映射为 `published`；其他错误映射为 `error` 并终止。
- **Publish result**：每个条目仅有 `published` 或 `skipped-already-published`；失败通过非零退出码表示，不伪造成功摘要。

## Risks / Trade-offs

- [npm 不支持三个包原子发布] → 在上传前完成全量 prepare，并用幂等重跑缩小和恢复部分发布窗口。
- [Trusted Publisher 的 workflow 文件名或 Environment 与 npm 配置不匹配] → 固定 workflow 文件名，在文档中记录精确配置，并让 OIDC 失败直接阻断发布。
- [GitHub Release 被创建时源码版本未同步] → 发布前比较 tag、三个包名和版本，任何不一致都在 registry 写入前失败。
- [registry 查询暂时失败被错误当作“未发布”] → 明确区分 404/不存在与网络、认证、限流错误，后者直接终止。
- [prepare 后 publish 又触发 lifecycle 脚本造成字节变化] → 发布 prepare 阶段生成的 tarball，并用测试确认 publish tarball 不重新生成内容。
- [第三方 GitHub Action 或缓存污染发布输入] → 使用官方 checkout/setup-node action，发布构建禁用 package-manager cache，并固定 lockfile 安装。
- [源码仓库为私有时自动 provenance 不可用] → OIDC 发布仍可工作；测试和文档不把 provenance badge 作为私有仓库发布成功的必要条件。

## Migration Plan

1. 新增可测试的协同发布脚本和 package manifest，完成三个包的 prepare、版本校验和幂等 publish。
2. 新增 `.github/workflows/publish-npm.yml`，配置 GitHub Release 触发、OIDC 权限和受支持工具链。
3. 增加脚本/静态 workflow 测试，并执行三包 dry-run/pack 验收。
4. 更新 release 与插件维护文档，要求发布准备同步三个版本并说明 Actions 重跑恢复流程。
5. 在非生产版本或受控 Release 上验证 Trusted Publishing；确认三个 npm package 设置绑定精确 workflow 文件名后启用正式发布。

回滚时删除或禁用 workflow 即可停止后续自动发布，不影响已发布包。已经写入 npm registry 的版本不可由自动化回滚；如出现部分发布，修复后重跑同一 Release 完成剩余包。

## Open Questions

无。npm Trusted Publisher 已配置；触发方式、版本同步、固定顺序、完整门禁和失败恢复策略已在 elaboration 中确定。
