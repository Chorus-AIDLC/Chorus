<p align="center">
  <img src="packages/landing/public/images/chorus-slug.png" alt="Chorus" width="240" />
</p>

<p align="center"><strong>당신의 코딩 에이전트 위에 얹는 Harness. 에이전트가 제안하고, 사람이 검증하고, 소프트웨어가 배포됩니다.</strong></p>

<p align="center">
  <a href="https://discord.gg/SwcCMaMmR">
    <img src="https://img.shields.io/badge/Discord-Join%20us-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord">
  </a>
  <a href="https://github.com/Chorus-AIDLC/Chorus/actions/workflows/test.yml">
    <img src="https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/ChenNima/f245ebf1cf02d5f6e3df389f836a072a/raw/coverage-badge.json" alt="Coverage">
  </a>
</p>

<p align="center"><a href="README.md">English</a> · <a href="README.zh.md">中文</a> · <strong>한국어</strong> · <a href="README.ja.md">日本語</a></p>

<p align="center"><a href="https://doc.chorus-ai.dev/ko/"><strong>📖 문서</strong></a></p>

Chorus는 당신의 코딩 에이전트 위에 얹는 Harness입니다. 코딩 에이전트가 모델을 harness하여 코드를 작성한다면, Chorus는 그보다 한 단계 위의 Harness로서, 그런 에이전트 한 팀 전체와 당신을 하나의 파이프라인으로 묶습니다. 에이전트가 제안하고, 사람이 검증하고, 아이디어가 배포된 소프트웨어로 바뀝니다. 그 아래에서는 멀티 에이전트와 사람이 함께하는 협업이 흔들리지 않도록 하는 것들을 처리합니다: 세션 라이프사이클, 작업 상태, 하위 에이전트 오케스트레이션, 관측 가능성, 장애 복구. 모든 AI 에이전트는 세밀하게 설정 가능한 권한을 갖습니다.

**[AI-DLC(AI-Driven Development Lifecycle)](https://aws.amazon.com/blogs/devops/ai-driven-development-life-cycle/)** 방법론에서 영감을 받았습니다. 핵심 철학은 **Reversed Conversation** — AI가 제안하고, 사람이 검증합니다.

---

## AI-DLC 워크플로

```
Idea ──> Proposal ──> [Document + Task DAG] ──> Execute ──> Verify ──> Done
  ^          ^               ^                     ^          ^         ^
사람      idea:write     proposal:write         task:write   *:admin    *:admin
생성      + 구체화       + 초안                  + 보고      + 검증     + 종료
```

각 단계 아래에 적힌 것은 해당 단계에서 액터에게 필요한 **권한**입니다 — 사람, 에이전트, 또는 둘 다에게 부여할 수 있습니다. 고정된 역할은 없으며, 5 × 3 권한 매트릭스의 어떤 조합도 가능합니다. → [에이전트 권한](https://doc.chorus-ai.dev/ko/guides/manage-agents/)

---

## 최근 업데이트

**[v0.17.2](https://chorus-ai.dev/blog/chorus-v0.17.2-release/)** — Pi를 정식 패키지와 데몬 웨이크로 사용할 수 있으며, `chorus agents run`으로 로컬 에이전트 프로파일을 빠르게 전환할 수 있습니다.

**[v0.17.0–0.17.1](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.17.1)** — 하나의 CLI로 여러 코딩 에이전트에 Chorus를 설치하고 업데이트할 수 있습니다. 이제 Tracker, Graph, Idea 상세 화면에서 데몬 활동도 실시간으로 확인할 수 있습니다.

**[v0.16.4](https://chorus-ai.dev/blog/chorus-v0.16.4-release/)** — DeepSeek Harness(dsh)가 여섯 번째 연결 방식으로 추가됩니다: `@chorus-aidlc/chorus-dsh` 번들이 Chorus의 스킬·페르소나·MCP 설정을 임의의 dsh 프로파일에 추가합니다. 현재는 대화식 사용만, 데몬 웨이크는 추후 지원.

**[v0.16.1](https://chorus-ai.dev/blog/chorus-v0.16.1-release/)** — 이제 하나의 `chorus daemon`이 서로 독립적인 여러 에이전트를 동시에 서비스합니다. 각 에이전트는 `agents[]` 배열로 자신의 키·작업 디렉터리·백엔드·권한을 가집니다. 에이전트끼리 @멘션으로 작업을 넘길 수 있고, 각 웨이크는 해당 에이전트 자신의 프로젝트 디렉터리에 도착합니다.

**[v0.16.0](https://chorus-ai.dev/blog/chorus-v0.16.0-release/)** — 에이전트를 문서 사이트([doc.chorus-ai.dev](https://doc.chorus-ai.dev))로 안내하는 `docs` 스킬을 추가해, 기억에 의존하지 않고 현재 문서를 읽고 답하도록 했습니다.

**[v0.15.0](https://chorus-ai.dev/blog/chorus-v0.15.0-release/)** — 프로젝트별 Agent 작업 디렉터리: 각 사용자가 프로젝트의 Agent마다 호스트와 cwd를 지정하고, 데몬이 허용한 루트만 탐색할 수 있습니다. 배정, 웨이크, 재개, 후속 턴에서 같은 실행 위치를 사용하며 진행 중인 세션은 이동하지 않습니다. Codex는 재개 가능한 백엔드 thread ID를 별도로 저장하고, 더 이상 필요하지 않은 Chorus session 관리 단계를 제거했습니다.

**[v0.14.1](https://chorus-ai.dev/blog/chorus-v0.14.1-release/)** — Amazon Kiro CLI가 네 번째 연결 방식이 되었습니다(Kiro CLI v2): `chorus agents add` 명령 한 줄로 설치하는 Kiro 플러그인과 `--agent kiro` 데몬 백엔드, 여기에 몇 가지 데몬 수정.

**[v0.14.0](https://chorus-ai.dev/blog/chorus-v0.14.0-release/)** — 앱 전체 다크 모드(라이트 / 다크 / 시스템). 참고 자료를 어떤 아이디어·제안·작업에도 첨부할 수 있고, 인라인으로도 MCP를 통해서도 읽을 수 있습니다. 한국어와 일본어 추가(한국어는 커뮤니티 기여). 그룹화를 위한 **테마** 아이디어, 그리고 데몬의 개발 시작 / Yolo 버튼, 대화식 아이디어 입력, 크래시 복구, `chorus daemon install`.

> 전체 변경 이력: [CHANGELOG.md](CHANGELOG.md)

---

## 빠른 시작

두 개의 명령이면 됩니다. 데이터베이스도, Docker도, 설정 파일도 필요 없습니다.

```bash
npm install -g @chorus-aidlc/chorus@0.17.1
chorus
```

Chorus는 내장 PostgreSQL(PGlite)로 시작해 마이그레이션을 실행하고 **http://localhost:8637** 에서 열립니다. 기본 로그인: `admin@chorus.local` / `chorus`.

> 여러 에이전트를 실행하거나 프로덕션에 배포하시나요? 외부 PostgreSQL, Docker, 또는 AWS를 사용하세요 → **[배포 및 셀프 호스팅](https://doc.chorus-ai.dev/ko/guides/deployment-overview/)**.

로컬 머신을 배정된 작업을 이어받는 에이전트 런타임으로 만들려면 `chorus daemon`을 실행하세요 → **[데몬 운영](https://doc.chorus-ai.dev/ko/guides/daemon-operations/)** · **[원격 제어](https://doc.chorus-ai.dev/ko/guides/remote-control/)**.

---

## 스크린샷

### 원격 에이전트 웨이크 — 디렉터리로 디스패치하고 실행을 지켜보기

![Remote Agent Wake](packages/landing/public/images/agent-daemon-wake.gif)

아이디어를 원격 에이전트의 특정 디렉터리에 배정한 다음 대화를 열면, 로컬 Claude Code가 작업을 이어받아 실시간으로 실행하는 모습을 볼 수 있습니다 — 터미널도, 수동 재개도 필요 없습니다.

### 프로젝트 리소스 그래프 — 프로젝트 전체를 살아있는 마인드맵으로

![Project Resource Graph](packages/landing/public/images/mind-map.png)

아이디어·제안·문서·작업이 하나로 연결된 트리로 배치되며, 에이전트가 작업하는 동안 각 카드의 상태가 실시간으로 업데이트됩니다.

### 제안 — AI 에이전트가 실시간으로 계획을 생성

![Proposal Presence](packages/landing/public/images/proposal-presence.gif)

PM 에이전트가 요구사항을 분석해 PRD와 작업 DAG를 생성하며, 실시간 프레즌스 인디케이터가 에이전트 활동을 보여줍니다.

### 칸반 — 실시간 작업 흐름

![Kanban Presence](packages/landing/public/images/kanban-presence.gif)

에이전트가 작업하는 동안 작업 카드가 To Do → In Progress → To Verify 사이를 이동하며, 지금 다뤄지는 항목에 프레즌스 인디케이터가 표시됩니다.

---

## 에이전트 연결하기

가장 빠른 방법은 앱 내 마법사입니다: **Settings → Setup Guide**를 여세요. 마법사가 API 키를 만들고, 사용하는 클라이언트(Claude Code, Codex, Kiro, dsh, OpenCode, OpenClaw, Pi, 또는 그 밖의 MCP 호환 에이전트)에 맞는 정확한 명령을 보여줍니다.

클라이언트별 전체 가이드 → **[에이전트 플랫폼](https://doc.chorus-ai.dev/ko/reference/agents/)**.

API 키는 **Settings → Agents → Create API Key**에서 만듭니다. 키는 `cho_`로 시작하며 한 번만 표시됩니다.

---

## 기술 스택

| 구성 요소 | 기술 |
|-----------|-----------|
| 프레임워크 | Next.js 15 (App Router, Turbopack) |
| 언어 | TypeScript 5 (strict mode) |
| 프론트엔드 | React 19, Tailwind CSS 4, shadcn/ui |
| 데이터 | PostgreSQL 16 + Prisma 7, Redis 7 (optional) |
| 에이전트 연동 | MCP SDK (HTTP Streamable Transport) |
| 인증 | OIDC + PKCE / API Key / SuperAdmin |
| i18n | next-intl (en, zh, ko, ja) |
| 배포 | npm / Docker / AWS CDK |

---

## 문서

**📖 전체 문서: [doc.chorus-ai.dev](https://doc.chorus-ai.dev/ko/)**

- [시작하기](https://doc.chorus-ai.dev/ko/guides/getting-started/)
- [에이전트 연결](https://doc.chorus-ai.dev/ko/reference/agents/)
- [AI-DLC 워크플로](https://doc.chorus-ai.dev/ko/guides/ai-dlc-workflow/)
- [플러그인 및 명령](https://doc.chorus-ai.dev/ko/guides/plugin-commands/)
- [MCP 도구 레퍼런스](https://doc.chorus-ai.dev/ko/reference/mcp-tools/)
- [배포 및 셀프 호스팅](https://doc.chorus-ai.dev/ko/guides/deployment-overview/)

---

## 라이선스

AGPL-3.0 — [LICENSE.txt](LICENSE.txt)를 참고하세요
