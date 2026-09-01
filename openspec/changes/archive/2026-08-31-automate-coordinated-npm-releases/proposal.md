## Why

Chorus CLI、OpenClaw 插件和 dsh 插件目前需要维护者分别执行 npm 发布，认证依赖本地登录且三个发布单元容易出现版本或发布状态不一致。npm Trusted Publishing 已为三个包配置完成，因此现在可以把 GitHub Release 之后的校验、打包和发布收敛为一个无长期 npm token 的自动化流程。

## What Changes

- 新增一个由 GitHub Release `published` 事件触发的 GitHub Actions workflow，在同一次运行中处理 `@chorus-aidlc/chorus`、`@chorus-aidlc/chorus-openclaw-plugin` 和 `@chorus-aidlc/chorus-dsh`。
- 使用 GitHub Actions OIDC 和 npm Trusted Publishing 获取短期发布身份；workflow 不读取或保存 `NPM_TOKEN`。
- 在任何上传发生前校验 release tag、三个 `package.json` 的统一版本、工具链版本，并完成三个包的测试、构建、pack 和包内容检查。
- 将已验证的 tarball 按固定顺序发布；发布前查询 npm registry，安全跳过已存在的同名同版本包，使部分成功的运行可以重跑。
- 更新 Chorus release 流程和维护文档，使三包版本同步、GitHub Release 创建和自动 npm 发布成为同一发布契约。
- 增加静态和 dry-run 测试，验证 workflow 权限、无 token 配置、包清单、版本门禁、失败停止及幂等恢复行为。

## Capabilities

### New Capabilities

- `coordinated-npm-release`: 定义三个 Chorus npm 包通过 GitHub Release、OIDC Trusted Publishing、全量预检和幂等串行上传完成协同发布的行为。

### Modified Capabilities

无。

## Impact

- GitHub Actions：新增 `.github/workflows/publish-npm.yml`，需要 `contents: read` 与 `id-token: write`，并使用 GitHub 托管 runner。
- 发布脚本：新增适合无交互 CI 的三包预检、打包、版本探测和上传编排；现有本地交互式脚本可继续作为维护者工具，但不作为 CI 入口。
- npm 包：仓库根目录、`packages/openclaw-plugin`、`packages/chorus-dsh` 的版本和发布校验被纳入统一契约。
- 文档与测试：release skill、维护说明及 workflow/脚本测试需要反映自动发布和安全重跑流程。
- 外部系统：依赖 npm Trusted Publishing 配置、GitHub OIDC、npm registry 和 GitHub Release 事件；不新增长期凭证。
