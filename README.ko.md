<p align="center">
  <img src="packages/landing/public/images/chorus-slug.png" alt="Chorus" width="240" />
</p>

<p align="center"><strong>AI-인간 협업을 위한 Agent Harness</strong></p>

<p align="center">
  <a href="https://discord.gg/SwcCMaMmR">
    <img src="https://img.shields.io/badge/Discord-Join%20us-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord">
  </a>
  <a href="https://github.com/Chorus-AIDLC/Chorus/actions/workflows/test.yml">
    <img src="https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/ChenNima/f245ebf1cf02d5f6e3df389f836a072a/raw/coverage-badge.json" alt="Coverage">
  </a>
</p>

<p align="center"><a href="README.md">English</a> · <a href="README.zh.md">中文</a> · <strong>한국어</strong> · <a href="README.ja.md">日本語</a></p>

<p align="center"><a href="https://doc.chorus-ai.dev"><strong>📖 문서</strong></a></p>

Chorus는 Agent Harness입니다 — LLM 에이전트를 감싸 세션 라이프사이클, 작업 상태, 하위 에이전트 오케스트레이션, 관측 가능성, 장애 복구를 관리하는 인프라 계층입니다. 세밀하게 설정 가능한 권한을 가진 여러 AI 에이전트와 사람이 요구사항부터 배포까지 전체 워크플로를 통해 협업할 수 있게 해줍니다.

**[AI-DLC(AI-Driven Development Lifecycle)](https://aws.amazon.com/blogs/devops/ai-driven-development-life-cycle/)** 방법론에서 영감을 받았습니다. 핵심 철학은 **Reversed Conversation** — AI가 제안하고, 사람이 검증합니다.

---

## AI-DLC 워크플로

```
Idea ──> Proposal ──> [Document + Task DAG] ──> Execute ──> Verify ──> Done
  ^          ^               ^                     ^          ^         ^
사람      idea:write     proposal:write         task:write   *:admin    *:admin
생성      + 구체화       + 초안                  + 보고      + 검증     + 종료
```

각 단계 아래에 적힌 것은 해당 단계에서 액터에게 필요한 **권한**입니다 — 사람, 에이전트(프리셋 또는 Custom), 또는 둘 다에게 부여할 수 있습니다. 고정된 역할은 없으며, 5 × 3 권한 매트릭스의 어떤 조합도 가능합니다. 자세한 내용은 [`docs/PERMISSIONS.md`](docs/PERMISSIONS.md)를 참고하세요.

---

## 최근 업데이트

**[v0.15.0](https://chorus-ai.dev/blog/chorus-v0.15.0-release/)** — 프로젝트별 Agent 작업 디렉터리: 각 사용자가 프로젝트의 Agent마다 호스트와 cwd를 지정하고, 데몬이 허용한 루트만 탐색할 수 있습니다. 배정, 웨이크, 재개, 후속 턴에서 같은 실행 위치를 사용하며 진행 중인 세션은 이동하지 않습니다. Codex는 재개 가능한 백엔드 thread ID를 별도로 저장하고, 더 이상 필요하지 않은 Chorus session 관리 단계를 제거했습니다.

**[v0.14.1](https://chorus-ai.dev/blog/chorus-v0.14.1-release/)** — Amazon Kiro CLI가 네 번째 연결 방식이 되었습니다(Kiro CLI v2): 명령 한 줄로 설치하는 `install-kiro.sh` 플러그인과 `--agent kiro` 데몬 백엔드, 여기에 몇 가지 데몬 수정.

**[v0.14.0](https://chorus-ai.dev/blog/chorus-v0.14.0-release/)** — 앱 전체 다크 모드(라이트 / 다크 / 시스템). 참고 자료를 어떤 아이디어·제안·작업에도 첨부할 수 있고, 인라인으로도 MCP를 통해서도 읽을 수 있습니다. 한국어와 일본어 추가(한국어는 커뮤니티 기여). 그룹화를 위한 **테마** 아이디어, 그리고 데몬의 개발 시작 / Yolo 버튼, 대화식 아이디어 입력, 크래시 복구, `chorus daemon install`.

**[v0.13.0](https://chorus-ai.dev/blog/chorus-v0.13.0-release/)** — 프로젝트별 리소스 마인드맵: 새로운 Graph 뷰가 각 프로젝트의 아이디어·제안·문서·작업을 프로젝트 자체 구조에서 생성한 하나의 접을 수 있는 트리로 엮습니다. 모든 카드에 현재 상태가 표시되며(아이디어는 아이디어 트래커가 사용하는 파생 파이프라인 상태를 보여줍니다), 제목 검색은 모든 일치 항목까지의 경로를 자동으로 펼쳐 하이라이트/디밍하고 이전/다음 탐색을 제공합니다. 동일한 줌/팬 캔버스가 데스크톱과 모바일 모두에서 렌더링됩니다(핀치 + 더블탭).

**[v0.12.0](https://chorus-ai.dev/blog/chorus-v0.12.0-release/)** — 주소 지정 가능한 데몬 인스턴스: 하나의 `chorus daemon`이 여러 작업 디렉터리(`--cwd`)를 서비스할 수 있으며, 각 `(agent, host, cwd)`가 프레즌스·@멘션·배정 전반에 걸쳐 개별적으로 보이고 개별적으로 지정할 수 있는 인스턴스가 됩니다. 아이디어에 인스턴스를 한 번 고정하면 그 아래의 제안·작업·웨이크가 이를 상속합니다. 고정된 웨이크는 브로드캐스트가 아니라 바로 그 인스턴스로 정확히 전달됩니다. 댓글의 @멘션은 실시간 온라인 상태 배지로 렌더링되고, 댓글은 커서 기반 무한 스크롤로 전환되었습니다.

**[v0.11.0](https://chorus-ai.dev/blog/chorus-v0.11.0-release/)** — Chorus 데몬: `chorus daemon`은 여러분의 머신을 상주형 에이전트 런타임으로 만들어, 디스패치가 있을 때마다 로컬 Claude Code를 깨웁니다. Agent Connections 화면이 스트리밍 트랜스크립트, 지시 주입, 중단 / 재개 같은 실시간 관측 가능성과 제어를 제공합니다. 또한 "구체화 검증" 버튼이 배정된 에이전트를 깨워 제안을 작성하게 합니다.

**[v0.10.0](https://chorus-ai.dev/blog/chorus-v0.10.0-release/)** — 단일 부모 아이디어 계보: 하나의 아이디어는 자식을 파생시키거나 다른 아이디어 아래에 붙어 숲(forest)을 이룰 수 있습니다. 이 관계는 의도적으로 약하게 유지됩니다 — 부모는 읽기 전용 "+N derived" 요약만 보여줄 뿐, 자식의 요구사항 구체화·제안·작업 흐름을 전혀 제약하지 않습니다. 아이디어 탐색은 Dashboard로 통합되었습니다(Ideas / Lineage / Stats 세 가지 뷰 전환, 적응형 기본값 포함). 독립적이던 Idea List 페이지는 폐지되었고, 그 URL은 Dashboard로 308 리디렉션됩니다.

**[v0.9.4](https://chorus-ai.dev/blog/chorus-v0.9.4-release/)** — OpenClaw 플러그인을 OpenClaw 2026.4.27 Plugin SDK 위에서 전면 재작성했습니다(네이티브 MCP 등록, SSE 웨이크를 위한 `runEmbeddedAgent`, 리뷰어를 네이티브 스킬로 구현). Codex 플러그인 훅은 이제 패키지 안에 함께 제공되며, 인스톨러가 사용자 디렉터리에 있는 예전 훅 사본을 정리합니다.

**[v0.9.0](https://chorus-ai.dev/blog/chorus-v0.9.0-release/)** — 모호한 아이디어를 위한 브레인스토밍 스킬(구조화된 Q&A 이전에 먼저 자유로운 대화를 진행)과 아이디어 완료 리포트(출시된 모든 아이디어에 Summary / Decisions / Follow-ups 정리가 붙어 아이디어 개요에 표시됩니다).

**[v0.8.0](https://chorus-ai.dev/blog/chorus-v0.8.0-release/)** — OpenSpec-aware 모드(Claude Code): `openspec/` 디렉터리와 `openspec` CLI가 모두 존재할 때 자동으로 활성화되며, `/opsx/{explore,propose,apply,archive}`와 검증 후 archive 트리거 훅을 추가합니다.

> 전체 변경 이력: [CHANGELOG.md](CHANGELOG.md)

---

## 빠른 시작

두 개의 명령으로 Chorus를 로컬에서 실행할 수 있습니다 — 데이터베이스도, Docker도, 설정 파일도 필요 없습니다.

```bash
npm install -g @chorus-aidlc/chorus
chorus
```

이게 전부입니다. Chorus는 내장 PostgreSQL(PGlite)로 시작해 마이그레이션을 자동으로 실행하고 **http://localhost:8637** 에서 열립니다.

> **참고:** PGlite는 내장형 단일 프로세스 PostgreSQL입니다 — 로컬 단일 사용자 용도에는 훌륭하지만, 동시 부하가 걸리면 커넥션 처리에 한계가 있습니다. 여러 에이전트나 사용자를 동시에 실행할 계획이라면 `DATABASE_URL=postgresql://...`로 외부 PostgreSQL을 사용하거나 전체 [Docker Compose](#docker로-시작하기-권장) 스택을 이용하세요.

기본 로그인 정보: `admin@chorus.local` / `chorus`

### 옵션

```bash
# 커스텀 포트
chorus --port 3000

# 커스텀 데이터 디렉터리(기본값: ~/.chorus-data)
chorus --data-dir /path/to/data

# 커스텀 인증 정보
DEFAULT_USER=me@example.com DEFAULT_PASSWORD=secret chorus

# 내장 PGlite 대신 외부 PostgreSQL 사용
DATABASE_URL=postgresql://user:pass@host:5432/chorus chorus
```

### 그 밖의 배포 방법

| 방법 | 명령 |
|--------|---------|
| **npm**(가장 간단) | `npm i -g @chorus-aidlc/chorus && chorus` |
| **Docker(단독)** | [`docker compose -f docker-compose.local.yml up`](#docker로-시작하기-권장) |
| **Docker(풀 스택)** | [`docker compose up`](#docker로-시작하기-권장)(PostgreSQL + Redis + Chorus) |
| **AWS CDK** | [AWS에 배포](#aws에-배포) |

### `chorus daemon` — 에이전트 런타임으로 연결

`chorus daemon`은 여러분의 로컬 머신을 에이전트 런타임으로서 원격 Chorus 서버에 연결하고, Chorus가 배정한 작업을 실행합니다.

> **에이전트 백엔드:** **Claude Code**(기본)와 **Codex**를 지원합니다 — `--agent codex`(또는 `CHORUS_AGENT=codex`)로 선택합니다. 다른 에이전트 CLI(Copilot 등)에 대한 지원은 향후 릴리스에서 예정되어 있습니다.

```bash
chorus login                     # 인증(브라우저를 엽니다)
chorus daemon                    # 데몬을 포그라운드로 시작
chorus daemon -d                 # 데몬을 백그라운드로 시작(디태치)
chorus daemon install            # 부팅 시 자동 시작하는 서비스로 설치(Linux) — 권장
chorus daemon uninstall          # 설치된 서비스를 제거
chorus daemon stop               # 데몬을 중지(설치되어 있으면 systemd에 위임)
chorus daemon stop --force       # 멈춘 pid가 중지를 막을 때 pidfile을 강제로 정리
chorus daemon status             # 데몬 상태 확인
chorus daemon restart            # 데몬 재시작
chorus daemon logs               # 데몬 로그 보기
```

**주요 기능:**

- **Claude Code & Codex 백엔드** — PATH에 있는 `claude`(또는 `codex`) CLI를 자동 감지합니다. `--agent codex`로 선택합니다
- **백그라운드 모드** — `-d` 플래그로 실행하고, `stop/restart/logs`로 관리합니다
- **부팅 자동 시작 서비스** — `chorus daemon install`이 올바른 `systemd --user` unit을 생성하고 시작합니다(아래 참고). 이후 `status/stop/restart/logs`는 투명하게 systemd에 위임됩니다
- **권한 모드** — 기본값은 완전 접근(yolo)입니다. `--chorus-only`로 Chorus MCP 도구로만 제한할 수 있습니다
- **멀티 패스** — 반복 지정 가능한 `--cwd`로 하나의 데몬에서 여러 작업 디렉터리를 서비스할 수 있습니다(아래 참고)
- **대화식 설정** — 아직 구성되지 않은 경우, 최초 시작 시 인증 정보를 입력하도록 안내합니다

데몬에는 인증이 필요합니다. 먼저 `chorus login`을 실행하세요. 실행하지 않았다면 최초 시작 시(터미널에서 실행 중인 경우) 대화식으로 인증 정보를 입력하도록 안내합니다.

#### 부팅 / 로그인 시 실행 — `chorus daemon install`

```bash
chorus daemon install --cwd ~/work/repo-a --cwd ~/work/repo-b   # 설치하고 지금 시작, 로그인 시 자동 시작
chorus daemon uninstall                                         # 서비스 비활성화 및 제거
```

Linux에서는 `install`이 `systemd --user` unit을 생성하여 데몬을 **포그라운드**(`Type=simple`, `-d` 없음)로 실행합니다. 이렇게 하면 systemd가 프로세스를 직접 소유하며, 이어서 `daemon-reload` + `enable --now`를 수행합니다. unit에는 여러분이 전달한 `--cwd`/`--agent`/`--chorus-only` 플래그가 담깁니다. `chorus daemon -d`를 감싼 `Type=forking` unit을 **직접 작성하지 마세요** — 데몬은 스스로 데몬화하기 때문에 systemd가 추적할 수 없고 재시작 시 루프에 빠집니다. 올바른 unit은 `install`이 작성하도록 맡기세요. macOS/Windows에서는 `install`이 직접 설치할 수 있는 올바른 템플릿을 출력합니다. unit이 인증 정보를 읽을 수 있도록 먼저 `chorus login`을 실행하세요. 자세한 내용은 [docs/DAEMON.md](docs/DAEMON.md)를 참고하세요.

#### 여러 작업 디렉터리 서비스하기

하나의 데몬은 여러 로컬 작업 디렉터리를 동시에 서비스할 수 있습니다 — 선언된 각 경로는 동일한 에이전트 아래에서 독립적인 연결(자체 세션 + 웨이크 루프)로 등록됩니다. 경로는 데몬이 서비스하는 **단지** 디렉터리일 뿐이며, 프로젝트와의 결합은 갖지 않습니다.

```bash
chorus daemon --cwd ~/work/repo-a --cwd ~/work/repo-b   # 반복 지정 가능한 플래그
CHORUS_DAEMON_CWDS="~/work/repo-a:~/work/repo-b" chorus daemon   # 또는 환경 변수(`:` 또는 `,` 구분)
```

`--cwd`를 지정하지 않으면 데몬은 실행된 위치의 단일 디렉터리만 서비스합니다.

#### 설정 파일 — `~/.chorus/daemon.json`

`chorus login`은 인증 정보를 여기에 기록합니다(모드 `0600`). 데몬 조정 항목을 **같은** 파일에 추가할 수도 있습니다. 모든 필드는 선택 사항이며, 플래그와 환경 변수는 항상 파일보다 우선합니다.

```json
{
  "url": "https://chorus.example.com",
  "apiKey": "cho_xxxxxxxxxxxxxxxxxxxxxxxx",
  "agentUuid": "00000000-0000-0000-0000-000000000000",
  "agentName": "My Daemon Agent",
  "cwds": ["~/work/repo-a", "~/work/repo-b"],
  "sigintTimeoutMs": 10000
}
```

| 필드 | 타입 | 기록 주체 / 용도 | 우선순위(높은 순) |
|-------|------|-----------------------|----------------------------|
| `url` | string | 원격 Chorus 서버 URL | `--url` 플래그 → `CHORUS_URL` → 파일 |
| `apiKey` | string | 에이전트 API 키(`cho_…`) | `--api-key` 플래그 → `CHORUS_API_KEY` → 파일 |
| `agentUuid` / `agentName` | string | 인증된 신원(로그인 시 기록) | `chorus login`이 기록 |
| `cwds` | string[] | 데몬이 서비스하는 작업 디렉터리(멀티 패스) | `--cwd` 플래그 → `CHORUS_DAEMON_CWDS` → 파일 → 실행 디렉터리 |
| `sigintTimeoutMs` | number | SIGINT 이후 강제 종료까지의 유예 시간(ms, 기본값 `10000`) | `--sigint-timeout` 플래그 → `CHORUS_DAEMON_SIGINT_TIMEOUT` → 파일 → `10000` |
| `yoloAckAt` | string | 내부용 — TTY yolo 확인의 타임스탬프(자동 관리) | — |

시작 시 데몬 배너가 **실제로 읽은 `daemon.json` 경로**(그리고 그 파일의 존재 여부)를 출력하므로, 어떤 파일을 편집해야 하는지 항상 알 수 있습니다.

---

## 스크린샷

### 원격 에이전트 웨이크 — 디렉터리로 디스패치하고 실행을 지켜보기

![Remote Agent Wake](packages/landing/public/images/agent-daemon-wake.gif)

아이디어를 원격 에이전트의 특정 디렉터리에 배정한 다음 대화를 열면, 로컬 Claude Code가 작업을 이어받아 실시간으로 실행하는 모습을 볼 수 있습니다 — 터미널도, 수동 재개도 필요 없습니다.

### 프로젝트 리소스 그래프 — 프로젝트 전체를 살아있는 마인드맵으로

![Project Resource Graph](packages/landing/public/images/mind-map.png)

Chorus는 프로젝트 전체를 마인드맵으로 자동 정리합니다 — 아이디어·제안·문서·작업이 하나로 연결된 트리로 배치되며 — 에이전트가 하는 일을 실시간으로 반영하고, 작업이 진행됨에 따라 각 카드의 상태가 실시간으로 업데이트됩니다.

### 제안 — AI 에이전트가 실시간으로 계획을 생성

![Proposal Presence](packages/landing/public/images/proposal-presence.gif)

PM 에이전트가 요구사항을 분석하고 PRD와 작업 DAG를 포함한 제안을 생성하는 모습을 볼 수 있습니다 — 에이전트 활동을 보여주는 실시간 프레즌스 인디케이터와 함께 말이죠.

### 픽셀 워크스페이스 — 에이전트의 실시간 상태

![Pixel Workspace](docs/images/pixcel-workspace-new.gif)

왼쪽 패널은 픽셀 워크스페이스로, 픽셀 캐릭터가 각 에이전트의 실시간 작업 상태를 나타냅니다. 오른쪽 패널에는 에이전트의 터미널 출력이 실시간으로 표시됩니다.

### 칸반 — 실시간 작업 흐름

![Kanban Presence](packages/landing/public/images/kanban-presence.gif)

칸반 보드는 에이전트의 작업에 맞춰 자동으로 업데이트되며, 작업 카드가 To Do → In Progress → To Verify 사이를 실시간으로 이동합니다. 에이전트 프레즌스 인디케이터가 어떤 리소스가 작업 중인지 하이라이트합니다.

### 칸반 & 작업 DAG

![Kanban & Task DAG](packages/landing/public/images/kanban-dag.png)

작업 상태를 추적하는 칸반 보드와, 실행 순서 및 병렬 경로를 보여주는 의존성 DAG를 나란히 표시합니다.

### 아이디어 & 요구사항 구체화

![Idea & Elaboration](packages/landing/public/images/idea-elaborate.png)

PM 에이전트는 제안을 만들기 전에 구조화된 Q&A 라운드를 통해 요구사항을 명확히 합니다. 패널에는 아이디어 상세 정보와 함께, 답변 및 카테고리 태그가 달린 완료된 구체화 라운드가 나란히 표시됩니다.

### 제안 검토

![Proposal Review](packages/landing/public/images/proposal.png)

PM 에이전트가 생성한 제안에는 문서 초안과 작업 DAG 초안이 담깁니다. 관리자는 이 패널에서 검토하여 승인하거나 거부합니다.

### 수락 기준 — 이중 경로 검증

![Acceptance Criteria](packages/landing/public/images/task-ac.png)

개발자 에이전트의 자체 점검과 관리자의 검토가 각 수락 기준을 독립적으로 검증하며, 모든 항목마다 구조화된 통과/실패 증빙을 남깁니다.

### 유니버설 검색 — Cmd+K 커맨드 팔레트

![Universal Search](packages/landing/public/images/universal-search.png)

6가지 엔티티 유형(작업·아이디어·제안·문서·프로젝트·프로젝트 그룹)을 아우르는 검색을 위한 Cmd+K 커맨드 팔레트입니다. 범위 필터링(Global / Group / Project), 엔티티 유형별 필터 탭, 키보드 내비게이션을 지원합니다. Web UI와 AI 에이전트(`chorus_search` MCP 도구를 통해)는 동일한 검색 백엔드를 공유합니다.

---

## 기능

- **세션 라이프사이클** — 하트비트, 자동 만료, 장애 복구를 갖춘 영속적 세션
- **작업 DAG** — 의존성 모델링, 순환 감지, 인터랙티브 시각화
- **칸반** — 워커 배지와 에이전트 프레즌스를 갖춘 실시간 작업 흐름
- **멀티 에이전트 협업** — 병렬 실행을 위한 Claude Code Agent Teams(Swarm 모드)
- **세밀한 에이전트 권한** — 5 리소스 × 3 액션 그리드와 프리셋 + 커스텀 조합([상세](docs/PERMISSIONS.md))
- **Chorus Plugin** — 라이프사이클 훅이 세션 생성/종료, 하트비트, 컨텍스트 주입을 자동화합니다
- **요구사항 구체화** — 제안 생성 전의 구조화된 Q&A 라운드
- **제안 승인 흐름** — PM이 초안을 작성하고 관리자가 승인하면, 초안이 실제 엔티티로 구체화됩니다
- **알림** — 앱 내 + SSE 푸시 + Redis Pub/Sub, 사용자별 설정 지원([설계 문서](src/app/api/notifications/README.md))
- **@멘션** — Tiptap 자동 완성, 권한 범위 검색, 멘션 알림([설계 문서](src/app/api/mentionables/README.md))
- **액티비티 스트림** — 세션 귀속 정보가 포함된 완전한 감사 추적
- **유니버설 검색** — 6가지 엔티티 유형을 아우르는 Cmd+K, 3단계 범위, 스니펫 생성([설계 문서](docs/SEARCH.md))
---

## 아키텍처

```
┌──────────────────────────────────────────────────────────────────┐
│                 Chorus — Agent Harness (:8637)                    │
│                                                                  │
│  ┌── Harness Capabilities ───────────────────────────────────┐   │
│  │  Session Lifecycle │ Task State Machine │ Context Inject   │   │
│  │  Sub-Agent Orchestration │ Observability │ Failure Recovery│   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌── Chorus Plugin (lifecycle hooks) ────────────────────────┐   │
│  │  SubagentStart/Stop │ Heartbeat │ Skill & Context Inject  │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌── API Layer ──────────────────────────────────────────────┐   │
│  │  /api/mcp  — MCP Streaming (50+ tools, permission-gated)  │   │
│  │  /api/*    — REST API (Web UI + SSE push)                 │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌── Service Layer ──────────────────────────────────────────┐   │
│  │  AI-DLC Workflow │ UUID-first │ Multi-tenant              │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌── Web UI (React 19 + Tailwind + shadcn/ui) ──────────────┐   │
│  │  Kanban │ Task DAG │ Proposals │ Activity │ Sessions      │   │
│  └───────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
     ↑              ↑              ↑              ↑
  Agent w/      Agent w/       Agent w/         Human
  idea+proposal  task:write    *:admin perms   (Browser)
   :write perms    perms      (proxy approval)
   (LLM)          (LLM)         (LLM)
                     │
          ┌──────────▼──────────┐   ┌─────────────────────┐
          │  PostgreSQL + Prisma │   │  Redis (optional)   │
          └─────────────────────┘   │  Pub/Sub for SSE    │
                                    └─────────────────────┘
```

### 패키지

| 패키지 | 설명 |
|---------|-------------|
| [`packages/openclaw-plugin`](packages/openclaw-plugin) | **OpenClaw Plugin** — 영속적인 SSE + MCP 브리지로 [OpenClaw](https://openclaw.ai)와 Chorus를 연결합니다. |
| [`packages/chorus-cdk`](packages/chorus-cdk) | **AWS CDK** — Chorus를 AWS에 배포하기 위한 Infrastructure-as-code. |

## 기술 스택

| 구성 요소 | 기술 |
|-----------|-----------|
| 프레임워크 | Next.js 15 (App Router, Turbopack) |
| 언어 | TypeScript 5 (strict mode) |
| 프론트엔드 | React 19, Tailwind CSS 4, shadcn/ui (Radix UI) |
| ORM | Prisma 7 |
| 데이터베이스 | PostgreSQL 16 |
| 캐시/Pub-Sub | Redis 7 (ioredis) — 선택 사항 |
| 에이전트 연동 | MCP SDK 1.26 (HTTP Streamable Transport) |
| 인증 | OIDC + PKCE / API Key / SuperAdmin |
| i18n | next-intl (en, zh, ko, ja) |
| 배포 | [Docker Hub](https://hub.docker.com/r/chorusaidlc/chorus-app) / Docker Compose / AWS CDK |

---

## 시작하기

### Docker로 시작하기 (권장)

빌드 도구나 외부 데이터베이스가 필요 없습니다. 이미지에는 [PGlite](https://pglite.dev)(내장 PostgreSQL)가 함께 들어 있습니다:

```bash
git clone https://github.com/Chorus-AIDLC/chorus.git
cd chorus

DEFAULT_USER=admin@example.com DEFAULT_PASSWORD=changeme \
  docker compose -f docker-compose.local.yml up -d
```

[http://localhost:8637](http://localhost:8637)을 열고 위의 인증 정보로 로그인하세요.

> 데이터는 Docker 볼륨에 영속화됩니다. 내장 모드는 단일 인스턴스 전용입니다(Redis 없음).

#### 프로덕션 배포 (PostgreSQL + Redis)

여러 레플리카를 사용하는 프로덕션 환경용:

```bash
DEFAULT_USER=admin@example.com DEFAULT_PASSWORD=changeme \
  docker compose up -d
```

> 모든 환경 변수와 설정 옵션은 [Docker 문서](docs/DOCKER.md)를 참고하세요.

---

### 로컬 개발

전제 조건: Node.js 22+, pnpm 9+, Docker(PostgreSQL/Redis용)

```bash
cp .env.example .env
pnpm docker:db
pnpm install
pnpm db:migrate:dev
pnpm dev
# http://localhost:8637 을 여세요
```

### 로컬 개발 (Docker 없이)

전제 조건: Node.js 22+, pnpm 9+

```bash
cp .env.example .env
pnpm install
pnpm dev:local        # 개발 서버 http://localhost:8637
```

PGlite는 포트 5433에서 내장 PostgreSQL을 실행합니다. 데이터는 `.pglite/`에 저장됩니다 — 삭제하면 초기화됩니다.

### AWS에 배포

```bash
./install.sh
```

대화식 인스톨러가 VPC, Aurora Serverless v2, ElastiCache Serverless, ECS Fargate, HTTPS를 갖춘 ALB를 프로비저닝합니다. 설정은 재배포를 위해 `default_deploy.sh`에 저장됩니다.

### AI 에이전트 연결하기

가장 빠른 방법은 앱 내 설정 마법사입니다: Web UI를 열고 **Settings → Setup Guide → Open setup guide**로 이동한 뒤, 사용하는 클라이언트(Claude Code, Codex, Kiro, OpenCode, OpenClaw, 또는 그 밖의 에이전트)에 맞는 단계별 안내를 따르세요. 마법사가 API 키를 만들어 주고, 정확한 명령을 보여주며, 연결 확인까지 안내합니다.

전체 문서를 읽고 싶다면:

| 클라이언트 | 가이드 |
|--------|-------|
| Claude Code | [CONNECT_CLAUDE_CODE.md](docs/CONNECT_CLAUDE_CODE.md) |
| Codex CLI | [CONNECT_CODEX.md](docs/CONNECT_CODEX.md) |
| Pi coding agent | [CONNECT_PI.md](docs/CONNECT_PI.md) |
| Kiro CLI | [CONNECT_KIRO.md](docs/CONNECT_KIRO.md) |
| OpenCode † | [CONNECT_OPENCODE.md](docs/CONNECT_OPENCODE.md) |
| 그 밖의 MCP 에이전트(Cursor, Continue, 커스텀 등) | [CONNECT_OTHER_AGENTS.md](docs/CONNECT_OTHER_AGENTS.md) |

† OpenCode 지원은 커뮤니티가 유지 관리하는 [`opencode-chorus`](https://github.com/etnperlong/opencode-chorus) 플러그인(npm: [`opencode-chorus`](https://www.npmjs.com/package/opencode-chorus))으로 제공되며, 작성자는 [@etnperlong](https://github.com/etnperlong)입니다. 감사합니다!

API 키는 Web UI의 **Settings → Agents → Create API Key**에서 만듭니다. 키는 `cho_`로 시작하며 한 번만 표시됩니다.

![Create API Key](packages/landing/public/images/create-key.png)

---

## 스킬 문서

| 방법 | 위치 | 사용 사례 |
|--------|----------|----------|
| **플러그인 내장(Claude Code)** | `public/chorus-plugin/skills/` | Claude Code + Chorus 플러그인, 자동화된 세션과 라이프사이클 훅 |
| **플러그인 내장(Codex CLI)** | `plugins/chorus/skills/` | Codex CLI + Chorus 플러그인, `$` 접두사 슬래시 명령을 갖춘 이식판 스킬 |
| **패키지 내장(Pi)** | `packages/chorus-pi/skills/` | Pi + Chorus 패키지, 자동화된 세션과 라이프사이클 훅 |
| **스탠드얼론** | `public/skill/`(`/skill/`에서 제공) | 그 밖의 MCP 지원 에이전트(Cursor, Continue, 커스텀), 수동 세션 관리 |

### OpenSpec 모드 (옵트인, 플러그인 0.8.1+)

[OpenSpec](https://github.com/Fission-AI/OpenSpec) CLI를 설치한 PM
에이전트는 구조화된 `proposal.md` + `design.md` +
`specs/<capability>/spec.md` 레이아웃으로 제안을 작성할 수
있습니다. 로컬 파일이 작업 사본이고 Chorus의 `documentDrafts`가
그 미러입니다. 리뷰어는 자유 형식의 Markdown이 아니라 예측
가능한 형태(`## ADDED Requirements`, `### Requirement:`,
`#### Scenario:`)를 보게 됩니다. `chorus_admin_verify_task`에 대한
PostToolUse 훅이, OpenSpec 아이디어의 마지막 작업이 검증될 때
`openspec archive <slug>` 리마인더를 주입하므로, 확정된 스펙은
승인 직후 장기 스펙 세트에 병합됩니다. 이 모드는 엄격하게
옵트인입니다: `openspec`이 설치되어 있지 않으면 동작은
바뀌지 않습니다. Claude Code에서의 마스터 스위치는
`enableOpenSpec`(플러그인 userConfig, 기본값 `true`)이며, 두
클라이언트 모두 `CHORUS_OPENSPEC_MODE=off`를 존중합니다. 이
모드에서 새로운 MCP 도구나 스키마 변경이 추가되는 일은
없습니다. 정규 스킬은 기존의 `chorus_pm_*` 초안·문서 도구를
재사용하며, 미러 호출은 `chorus-api.sh` 래퍼를 통해 라우팅하여
수천 줄에 달하는 Markdown을 LLM 컨텍스트 밖에 둡니다. 전체
가이드는 [OPENSPEC_MODE.md](docs/OPENSPEC_MODE.md)를 참고하세요.

---

## 문서

| 문서 | 설명 |
|----------|------------|
| [PRD](docs/PRD_Chorus.md) | 제품 요구사항 문서 |
| [Architecture](docs/ARCHITECTURE.md) | 기술 아키텍처 문서 |
| [MCP Tools](docs/MCP_TOOLS.md) | MCP 도구 레퍼런스 |
| [Permissions](docs/PERMISSIONS.md) | 에이전트 권한 모델(5 × 3 매트릭스, 프리셋, Custom 모드) |
| [Chorus Plugin](docs/chorus-plugin.md) | 플러그인 설계 및 훅 문서 |
| [OpenSpec Mode](docs/OPENSPEC_MODE.md) | PM 에이전트를 위한 옵트인 OpenSpec 작성 모드(플러그인 0.8.1+) |
| [Search](docs/SEARCH.md) | 글로벌 검색 기술 설계 |
| [AI-DLC Gap Analysis](docs/AIDLC_GAP_ANALYSIS.md) | AI-DLC 방법론 갭 분석 |
| [AIG Implementation Plan](docs/CHORUS_AIG_PLAN.md) | 에이전트 투명성 로드맵 |
| [Presence Design](docs/PRESENCE_DESIGN.md) | 실시간 에이전트 프레즌스 시스템 |
| [Docker](docs/DOCKER.md) | Docker 이미지 사용법 및 배포 |
| [Logging](docs/LOGGING.md) | 구조화 로깅 아키텍처 |
| [CLAUDE.md](CLAUDE.md) | 개발 가이드 |

---

## 라이선스

AGPL-3.0 — [LICENSE.txt](LICENSE.txt)를 참고하세요
