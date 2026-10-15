# Workspace 本地账号运维

Chorus 支持显式启用的本地用户名/密码 Workspace，同时保留现有 OIDC Workspace。账号和凭据属于单一 Workspace；不同 Workspace 可使用相同用户名或邮箱。已有非 OIDC Workspace 和部署级开发 fallback `DEFAULT_USER` **不会自动转换**为本地账号体系。

## 初始化与管理

1. 在 Superadmin 控制台创建 Workspace，选择「本地用户名和密码」。
2. 输入 Workspace 名称及首位管理员的用户名、邮箱及显示名称。
3. **离开页面前复制邀请链接**，通过可信渠道仅发送给指定接收者。系统不会自动发送邮件，本流程不依赖 SMTP。
4. 接收者打开一次性链接，设置并确认密码，然后返回普通登录页；接受邀请不会自动登录。
5. 所有普通登录均先输入用户名或邮箱，即使部署启用了 `DEFAULT_USER`。匹配多个 Workspace/身份时先选择，单命中自动跳过选择；确定后才输入密码或进入所选 Workspace 的 SSO。没有独立 SSO 入口或密码优先 fallback。SSO 仍使用配置的工作邮箱后缀发现组织，IdP 继续管理身份和凭据。修改账号需返回识别步骤，返回时清空密码。
6. 活跃本地 Workspace Admin 可通过「设置 → 工作区用户」邀请、编辑、启用/停用、重置密码、授予/撤销管理员、移除用户。

首版仅增加固定的 Workspace Admin 管理能力，不提供可配置 RBAC。普通用户保留现有项目/业务访问模型，Workspace Admin 不绕过私有项目或项目组边界。Superadmin 负责创建 Workspace 和初始化管理员，不增加跨 Workspace 的日常用户管理能力。

## 密码与恢复

密码使用 bcrypt（成本因子 12），至少 12 个 Unicode 字符，UTF-8 编码不超过 72 字节。公共用户 DTO 不包含密码哈希。邀请与重置链接均在 24 小时后到期；服务端仅存储随机不透明凭据的 SHA-256 哈希。重新签发会使旧链接失效。链接绑定账号、Workspace 和凭据版本；过期、已使用或已替换链接返回统一失败，不泄露用户信息。

管理员在用户列表签发重置链接并自行通过可信渠道发送。签发及接受重置均撤销旧本地会话。单纯重置密码不会永久销毁 Agent API Key，密钥仍受到 owner 当前资格及项目访问限制。首版不增加自助注册或忘记密码邮件流程。

停用待接受邀请的账号会撤销其链接。重新启用尚未设置密码的账号时，状态恢复为「已邀请」并签发新链接，只有接受后才成为活跃账号。已设置密码的账号重新启用后可以重新登录，但旧会话不会恢复。停用账号不能靠接受重置链接自行恢复。请保留另一位活跃管理员用于恢复；本功能没有新增未认证恢复通道或 Superadmin 绕过最后管理员密码的机制。

将 `APP_URL` 配置为可信且外部可达的应用 origin。未配置时开发默认使用 `http://localhost:8637`；不使用请求 Host 决定凭据链接 origin。接受页面使用 no-referrer 元数据，并在加载后移除地址栏中的 token 查询参数。不要将凭据链接放进公开工单、截图、日志或工作报告。Next 开发请求日志排除接受页面 URL；生产反向代理/访问日志也应省略或脱敏其 `token` 查询参数，前端 no-referrer 不会替基础设施日志脱敏。

## 撤权、历史归属与安全

每次本地会话认证重新查询用户/Workspace，检查活跃状态和凭据版本，读取当前管理员身份。已建立的事件/通知 SSE 连接采用事务提交后的 `account_access_changed` 广播与30秒单调时钟授权租约。普通投递只检查内存有效性、已知凭据到期时间和租约截止时间，不重复完整认证、不写 API Key `lastUsed`。相关用户/owner/Agent/key 变化触发权威状态轻查，而非无条件断开（重置后新会话及活跃 owner 的密钥不会被密码重置误杀）。连接先登记监听再初次校验，校验中暂停排队投递；失败或取消时清理监听和计时器。走索引的轻查通常在25秒启动，早于既有30秒心跳；租约从查询开始而非完成时计时。定时器延迟、查询挂起或 best-effort Redis 漏信不能使投递越过30秒截止时间。这里有意接受有界的跨实例撤权窗口，不宣称等同逐消息权威撤权；既有项目/组资源授权仍独立保留。停用、移除、重置和管理员权限变更使旧会话失效。移除采用 tombstone：保留 UUID 用于历史任务及活动归属，清除凭据并拒绝登录。移除时在同一事务内释放规范化用户名和登录邮箱，允许在该 Workspace 内复用。再次邀请相同标识会创建新 UUID 和新凭据链接，不继承旧管理员身份、项目/组成员资格、Agent ownership、密钥或历史。旧 UUID 保留历史归属及展示邮箱，其登录标识设为 null；公共删除响应的用户名为空字符串，邮箱为保留的展示邮箱。即使新账号已激活，旧会话、链接和所属 Agent 密钥仍然无效。活跃、已邀请和停用账号仍占用自己的标识。

所属 Agent/API Key 的中央认证路径在 REST 与 MCP 中检查 owner 是否存在、是否同租户且活跃。停用或移除 owner 后密钥不能继续访问；密钥不会获得人类 Workspace Admin 能力。普通活跃 owner 的 Agent 保留已有 preset/custom 业务权限，私有项目/组访问仍受到现有 owner 授权上限约束。无 owner Agent 不变。停用 owner 是基于状态的撤权，因此重新启用已设置密码的 owner 可以恢复仍有效密钥的认证资格，但旧用户会话仍无效。

生命周期事务锁定 Workspace 行并重新读取 actor/target，保护最后一位有效管理员；尚无活跃管理员时也保护 bootstrap 邀请账号。审计只记录 actor、action、target UUID，不记录凭据。服务端为最终授权依据，隐藏导航不是授权措施。

账号发现仅显示适用的 Workspace 名称/UUID 和既有 OIDC 配置，不公开成员资料或管理员状态。发现、登录和接受链接使用有界进程内限流。没有可信客户端地址时，只按规范化发现标识、租户+登录标识或接受链接 token 的哈希限流；不会使用共用 unknown-address 桶阻塞无关用户。

只有应用**只能通过强制的可信代理链访问、无法绕过代理直连**时，才启用 `AUTH_TRUST_PROXY=true`，否则保持未设置。单个 ALB 的默认 XFF append 模式（或单个覆盖 XFF 的代理）使用默认 `AUTH_TRUST_PROXY_HOPS=1`，选取经过验证的**最右侧**地址，不信任客户端可伪造的前缀。如果还有其他可信追加代理，应按真实右侧链长度显式设置 hop 数（1–16 的整数）；错误数量可能选到伪造值或所有用户共用的代理地址。无效/缺失地址或 hop 配置退回仅按身份限流。支持规范化 IPv4/IPv6，包括 ALB 可选的客户端端口格式。ALB preserve 模式或不能可靠追加/覆盖 XFF 的代理链不能启用此信任模式。

CloudFront → ALB 的 append 链中，XFF `client, cloudfront` 需要 `AUTH_TRUST_PROXY_HOPS=2`，选取 `client`；伪造前缀必须位于它的左侧。`.env.example` 默认不启用信任。CDK 的纯 ALB 模式配置一跳信任，ECS 入站仅允许 ALB；CloudFront 模式配置两跳但保持信任关闭，因为私有 ALB listener 还接受 VPC 流量，运维必须先关闭绕过 CloudFront 的路径才能启用信任。格式错误的本地登录请求直接拒绝，不检查凭据、不使用共享 `invalid` 桶。

**生产及多实例部署必须配置共享上游限流**以应对身份轮换（包括 password spraying）、代理绕过和持续攻击。仅身份限流无法阻止单一客户端轮流尝试不同账号，bcrypt 成本不能替代边缘限流。每个通过请求格式校验的登录尝试都进行 bcrypt 比较，包括未知或不合资格账号，因此边缘限流必须先于应用凭据计算。部署初始基线可考虑每客户端 IP 每分钟最多60个凭据请求、突发10个，再按 CPU 容量和共享 NAT 流量调优；这是运维配置示例，不是已实现的共享限额。接受链接先在 Workspace 锁内检查 token 有效性与账号资格，再计算密码哈希；随机、过期、已使用或版本过时的 token 不触发 bcrypt。进程内计数不跨实例共享，重启后不持久。fallback 最多保留10,000个桶，容量满时按最近使用情况淘汰，而不是拒绝所有新的无关身份；持续高基数压力可能重置被淘汰的限额。这仅是 best-effort 防御，不能替代可信边缘的强制限流。

新的人工指派候选仅包含 Workspace 内活跃且未删除的用户。服务端对新的 task/Idea 指派、项目/组新增成员及角色提权执行同样的资格检查，直接提交旧 UUID 也无法绕过。已有无效成员仍可降权或移除，但继续受原有自动/最后管理员保护；历史归属和原成员关系不会转移到重建账号。

**定向锁出的取舍：**没有可信地址时，同一 Workspace+登录标识的所有请求共享登录桶。默认每分钟10次尝试可能被针对已知标识连续提交错误密码耗尽，从而暂时挡住该用户的正常登录；持续请求可在每个窗口重复造成拒绝。这不会停用或删除账号。必须在应用之前使用有可信客户端归属的共享边缘限流和滥用控制应对；一般的单 IP 限额本身不能保证挡住分布式定向请求。不要通过信任可伪造的 forwarding headers 或恢复全局 fallback 桶来绕过该取舍。

## 可重跑的隔离验收

仅使用一次性数据库和独立应用进程，不操作真实 `.env`、`.pglite`、生产数据库或正常端口 8637。验收脚本要求显式隔离标记、loopback 地址及测试数据库端口 5435：

```sh
LOCAL_USERS_TEST_ISOLATED=1 \
LOCAL_USERS_TEST_URL=http://localhost:8640 \
LOCAL_USERS_TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5435/postgres?sslmode=disable' \
LOCAL_USERS_TEST_ADMIN_EMAIL='<测试管理员邮箱>' \
LOCAL_USERS_TEST_ADMIN_PASSWORD='<测试管理员密码>' \
node scripts/verify-local-users.mjs
```

先在一次性数据库应用迁移，再使用相同数据库、测试 Superadmin 配置、`APP_URL` 和 `NEXTAUTH_SECRET` 启动 Next。PGlite 设置 `CHORUS_USE_PGLITE=1`，连接池有意只使用单连接。脚本创建带有明确测试前缀的 fixture 并保留供检查，不打印原始邀请凭据或密钥。断言真实 HTTP 响应及持久化状态，包括并发请求；PGlite 单连接执行**不是** PostgreSQL 多连接锁竞争的证据，部署锁行为需要另外在 PostgreSQL 上做并发验证。

使用相同的隔离标记、应用 URL 和测试管理员配置执行 `node scripts/verify-local-users-browser.mjs`。若 Playwright 由外部提供，设置 `LOCAL_USERS_PLAYWRIGHT_MODULE=/path/to/playwright`。脚本同时设置语言 cookie 和 localStorage（客户端偏好为最终依据），覆盖中英文及明暗主题，截图仅保存到被忽略的 `.playwright-mcp/` 并遮蔽凭据字段。报告应记录真实执行结果。加密的 `docs/design.pen` 只能通过 Pencil MCP 更新；工具不可用时必须明确记录，不能直接编辑文件。
