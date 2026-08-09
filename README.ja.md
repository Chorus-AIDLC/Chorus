<p align="center">
  <img src="packages/landing/public/images/chorus-slug.png" alt="Chorus" width="240" />
</p>

<p align="center"><strong>AI と人間の協働のための Agent Harness</strong></p>

<p align="center">
  <a href="https://discord.gg/SwcCMaMmR">
    <img src="https://img.shields.io/badge/Discord-Join%20us-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord">
  </a>
  <a href="https://github.com/Chorus-AIDLC/Chorus/actions/workflows/test.yml">
    <img src="https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/ChenNima/f245ebf1cf02d5f6e3df389f836a072a/raw/coverage-badge.json" alt="Coverage">
  </a>
</p>

<p align="center"><a href="README.md">English</a> · <a href="README.zh.md">中文</a> · <a href="README.ko.md">한국어</a> · <strong>日本語</strong></p>

<p align="center"><a href="https://doc.chorus-ai.dev"><strong>📖 ドキュメント</strong></a></p>

Chorus は Agent Harness です — LLM エージェントを包み込み、セッションのライフサイクル、課題の状態、サブエージェントのオーケストレーション、可観測性、障害復旧を管理する基盤層です。細かく設定可能な権限を持つ複数の AI エージェントと人間が、要件から納品までの全ワークフローを通じて協働できるようにします。

**[AI-DLC（AI-Driven Development Lifecycle）](https://aws.amazon.com/blogs/devops/ai-driven-development-life-cycle/)** の方法論に着想を得ています。中核となる理念は **Reversed Conversation** — AI が提案し、人間が検証します。

---

## AI-DLC ワークフロー

```
Idea ──> Proposal ──> [Document + Task DAG] ──> Execute ──> Verify ──> Done
  ^          ^               ^                     ^          ^         ^
人間      idea:write     proposal:write         task:write   *:admin    *:admin
作成      + 詳細化       + 起草                  + 報告      + 検証     + 完了
```

各ステージの下に記載されているのは、そのステージでアクターに必要となる**権限**です — 人間、エージェント（プリセットまたは Custom）、あるいはその両方に付与できます。固定的なロールは存在せず、5 × 3 の権限マトリクスの任意の組み合わせが可能です。詳しくは [`docs/PERMISSIONS.md`](docs/PERMISSIONS.md) をご覧ください。

---

## 最近の更新

**[v0.15.0](https://chorus-ai.dev/blog/chorus-v0.15.0-release/)** — プロジェクト単位の Agent 作業ディレクトリ：各ユーザーがプロジェクト内の Agent ごとにホストと cwd を設定し、デーモンが許可したルートだけを参照できます。割り当て、ウェイク、再開、後続ターンで同じ実行先を使い、進行中のセッションは移動しません。Codex は再開可能なバックエンド thread ID を別に保存し、不要になった Chorus の session 管理手順を削除しました。

**[v0.14.1](https://chorus-ai.dev/blog/chorus-v0.14.1-release/)** — Amazon Kiro CLI が 4 つ目の接続方法になりました（Kiro CLI v2）：ワンコマンドの `install-kiro.sh` プラグインと `--agent kiro` デーモンバックエンド、加えていくつかのデーモン修正。

**[v0.14.0](https://chorus-ai.dev/blog/chorus-v0.14.0-release/)** — アプリ全体のダークモード（ライト / ダーク / システム）。参考資料をあらゆる着想・提案・課題に添付でき、インラインでも MCP 経由でも読み取れます。韓国語と日本語を追加（韓国語はコミュニティによる貢献）。グループ化のための**テーマ**着想、デーモンの「開発を開始」/「Yolo」ボタン、対話式の着想入力、クラッシュからの再開、`chorus daemon install`。

**[v0.13.0](https://chorus-ai.dev/blog/chorus-v0.13.0-release/)** — プロジェクトごとのリソースマインドマップ：新しい Graph ビューが、各プロジェクトの着想・提案・文書・課題を、プロジェクト自身の構造から生成した 1 本の折りたたみ可能なツリーにつなぎます。各カードには現在のステータスが表示され（着想には、着想トラッカーが使う派生パイプラインステータスが表示されます）、タイトル検索はヒットした各ノードまでの経路を自動展開してハイライト／減光し、前後ナビゲーションを備えます。同じズーム／パン対応のキャンバスが、デスクトップとモバイルの両方で描画されます（ピンチ + ダブルタップ）。

**[v0.12.0](https://chorus-ai.dev/blog/chorus-v0.12.0-release/)** — アドレス指定可能なデーモンインスタンス：1 つの `chorus daemon` が複数の作業ディレクトリ（`--cwd`）を扱えるようになり、各 `(agent, host, cwd)` が、プレゼンス・@メンション・割り当てを横断して個別に見え、個別に指定できるインスタンスになります。着想に一度インスタンスをピン留めすると、その提案・課題・ウェイクがそれを引き継ぎます。ピン留めされたウェイクは、ブロードキャストではなく、まさにそのインスタンスへ届けられます。コメントの @メンションはリアルタイムのオンライン状態バッジとして表示され、コメントはカーソルベースの無限スクロールに変わりました。

**[v0.11.0](https://chorus-ai.dev/blog/chorus-v0.11.0-release/)** — Chorus デーモン：`chorus daemon` は、あなたのマシンを常駐型のエージェントランタイムに変え、ディスパッチのたびにローカルの Claude Code をウェイクします。Agent Connections 画面が、ストリーミングされるトランスクリプト・指示の注入・中断／再開といったライブな可観測性と制御を提供します。さらに「詳細化を確定」ボタンが、割り当てられたエージェントをウェイクして提案を書かせます。

**[v0.10.0](https://chorus-ai.dev/blog/chorus-v0.10.0-release/)** — 単一親の着想系統：ある着想は子を派生させたり、別の着想の下に紐付けたりでき、森（フォレスト）を形成します。この関係は意図的に弱く保たれており — 親は読み取り専用の「+N derived」サマリーを示すだけで、子の要件詳細化・提案・課題フローを一切制約しません。着想の閲覧は Dashboard に集約されました（Ideas / Lineage / Stats の 3 通りのビュー切り替え、適応的なデフォルト付き）。独立していた Idea List ページは廃止され、その URL は Dashboard へ 308 リダイレクトされます。

**[v0.9.4](https://chorus-ai.dev/blog/chorus-v0.9.4-release/)** — OpenClaw プラグインを OpenClaw 2026.4.27 Plugin SDK 上で全面的に書き直しました（ネイティブな MCP 登録、SSE ウェイクのための `runEmbeddedAgent`、レビュアーをネイティブなスキルとして実装）。Codex プラグインのフックはパッケージ内に同梱されるようになり、インストーラーがユーザーディレクトリにある旧来のフックのコピーを整理します。

**[v0.9.0](https://chorus-ai.dev/blog/chorus-v0.9.0-release/)** — 曖昧な着想のためのブレインストーミングスキル（構造化された Q&A の前に、まず自由な対話を行います）と、着想の完了レポート（出荷されたすべての着想に Summary / Decisions / Follow-ups のまとめが付き、着想の概要ページに表示されます）。

**[v0.8.0](https://chorus-ai.dev/blog/chorus-v0.8.0-release/)** — OpenSpec-aware モード（Claude Code）：`openspec/` ディレクトリと `openspec` CLI の両方が存在するときに自動で有効化され、`/opsx/{explore,propose,apply,archive}` と、検証後の archive トリガーフックを追加します。

> 完全な変更履歴：[CHANGELOG.md](CHANGELOG.md)

---

## クイックスタート

2 つのコマンドで Chorus をローカル実行できます — データベースも Docker も設定ファイルも不要です。

```bash
npm install -g @chorus-aidlc/chorus
chorus
```

これだけです。Chorus は組み込みの PostgreSQL（PGlite）で起動し、マイグレーションを自動実行して、**http://localhost:8637** で開きます。

> **注意：** PGlite は組み込みの単一プロセス PostgreSQL です — ローカルでの単一ユーザー利用には最適ですが、同時負荷がかかると接続処理に限界があります。複数のエージェントやユーザーを同時に動かす予定がある場合は、`DATABASE_URL=postgresql://...` で外部の PostgreSQL を使うか、フルの [Docker Compose](#docker-で始める推奨) スタックを利用してください。

デフォルトのログイン情報：`admin@chorus.local` / `chorus`

### オプション

```bash
# カスタムポート
chorus --port 3000

# カスタムデータディレクトリ（デフォルト：~/.chorus-data）
chorus --data-dir /path/to/data

# カスタムの認証情報
DEFAULT_USER=me@example.com DEFAULT_PASSWORD=secret chorus

# 組み込みの PGlite の代わりに外部 PostgreSQL を使う
DATABASE_URL=postgresql://user:pass@host:5432/chorus chorus
```

### その他のデプロイ方法

| 方法 | コマンド |
|--------|---------|
| **npm**（最もシンプル） | `npm i -g @chorus-aidlc/chorus && chorus` |
| **Docker（単体）** | [`docker compose -f docker-compose.local.yml up`](#docker-で始める推奨) |
| **Docker（フルスタック）** | [`docker compose up`](#docker-で始める推奨)（PostgreSQL + Redis + Chorus） |
| **AWS CDK** | [AWS へのデプロイ](#aws-へのデプロイ) |

### `chorus daemon` — エージェントランタイムとして接続

`chorus daemon` は、あなたのローカルマシンをエージェントランタイムとしてリモートの Chorus サーバーに接続し、Chorus から割り当てられた課題を実行します。

> **エージェントバックエンド：** **Claude Code**（デフォルト）と **Codex** に対応しています — `--agent codex`（または `CHORUS_AGENT=codex`）で選択します。その他のエージェント CLI（Copilot など）への対応は、今後のリリースで予定しています。

```bash
chorus login                     # 認証（ブラウザを開きます）
chorus daemon                    # デーモンをフォアグラウンドで起動
chorus daemon -d                 # デーモンをバックグラウンドで起動（デタッチ）
chorus daemon install            # 起動時に自動起動するサービスとしてインストール（Linux）— 推奨
chorus daemon uninstall          # インストール済みのサービスを削除
chorus daemon stop               # デーモンを停止（インストール時は systemd に委譲）
chorus daemon stop --force       # 詰まった pid が停止を妨げる場合に pidfile を強制クリーン
chorus daemon status             # デーモンの状態を確認
chorus daemon restart            # デーモンを再起動
chorus daemon logs               # デーモンのログを表示
```

**主な機能：**

- **Claude Code と Codex バックエンド** — PATH 上の `claude`（または `codex`）CLI を自動検出します。`--agent codex` で選択します
- **バックグラウンドモード** — `-d` フラグで実行し、`stop/restart/logs` で管理します
- **起動時の自動起動サービス** — `chorus daemon install` は正しい `systemd --user` unit を生成して起動します（下記参照）。以降、`status/stop/restart/logs` は透過的に systemd へ委譲されます
- **権限モード** — デフォルトは完全アクセス（yolo）です。`--chorus-only` で Chorus の MCP ツールのみに制限できます
- **マルチパス** — 繰り返し指定できる `--cwd` で、1 つのデーモンから複数の作業ディレクトリを扱えます（下記参照）
- **対話式セットアップ** — 未設定の場合、初回起動時に認証情報の入力を求めます

デーモンには認証が必要です。先に `chorus login` を実行してください。実行していない場合は、初回起動時に対話形式で認証情報の入力を求めます（ターミナルで実行している場合）。

#### 起動時／ログイン時に実行する — `chorus daemon install`

```bash
chorus daemon install --cwd ~/work/repo-a --cwd ~/work/repo-b   # インストールして今すぐ起動、ログイン時に自動起動
chorus daemon uninstall                                         # サービスを無効化して削除
```

Linux では、`install` が `systemd --user` unit を生成し、デーモンを**フォアグラウンド**（`Type=simple`、`-d` なし）で実行します。これにより systemd がプロセスを直接管理し、その後 `daemon-reload` + `enable --now` を行います。unit には、あなたが渡した `--cwd`/`--agent`/`--chorus-only` フラグが取り込まれます。`chorus daemon -d` をラップした `Type=forking` の unit を**手書きしないでください** — デーモンは自己デーモン化するため systemd が追跡できず、再起動時にループします。正しい unit は `install` に書かせてください。macOS／Windows では、`install` が手動でインストールできる正しいテンプレートを表示します。unit が認証情報を読めるよう、先に `chorus login` を実行してください。詳細は [docs/DAEMON.md](docs/DAEMON.md) をご覧ください。

#### 複数の作業ディレクトリを扱う

1 つのデーモンは、複数のローカル作業ディレクトリを同時に扱えます — 宣言された各パスは、同じエージェントの下で独立した接続（それぞれ独自のセッション + ウェイクループ）として登録されます。パスは、デーモンが扱う**単なる**ディレクトリであり、プロジェクトとの紐付けは持ちません。

```bash
chorus daemon --cwd ~/work/repo-a --cwd ~/work/repo-b   # 繰り返し指定できるフラグ
CHORUS_DAEMON_CWDS="~/work/repo-a:~/work/repo-b" chorus daemon   # または環境変数（`:` または `,` 区切り）
```

`--cwd` を指定しない場合、デーモンは起動元の 1 つのディレクトリのみを扱います。

#### 設定ファイル — `~/.chorus/daemon.json`

`chorus login` は認証情報をここに書き込みます（モード `0600`）。デーモンの調整項目を**同じ**ファイルに追記することもできます。すべてのフィールドは任意です。フラグと環境変数は、常にファイルより優先されます。

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

| フィールド | 型 | 書き込み元／用途 | 優先順位（高い順） |
|-------|------|-----------------------|----------------------------|
| `url` | string | リモート Chorus サーバーの URL | `--url` フラグ → `CHORUS_URL` → ファイル |
| `apiKey` | string | エージェント API キー（`cho_…`） | `--api-key` フラグ → `CHORUS_API_KEY` → ファイル |
| `agentUuid` / `agentName` | string | 認証された身元（ログイン時に記録） | `chorus login` が書き込み |
| `cwds` | string[] | デーモンが扱う作業ディレクトリ（マルチパス） | `--cwd` フラグ → `CHORUS_DAEMON_CWDS` → ファイル → 起動ディレクトリ |
| `sigintTimeoutMs` | number | SIGINT 後、強制終了までの猶予時間（ミリ秒、デフォルト `10000`） | `--sigint-timeout` フラグ → `CHORUS_DAEMON_SIGINT_TIMEOUT` → ファイル → `10000` |
| `yoloAckAt` | string | 内部用 — TTY での yolo 確認のタイムスタンプ（自動管理） | — |

起動時、デーモンのバナーが**実際に読み込んだ `daemon.json` のパス**（およびそのファイルが存在するかどうか）を表示するため、どのファイルを編集すべきか常に分かります。

---

## スクリーンショット

### リモートエージェントのウェイク — ディレクトリにディスパッチし、実行を見守る

![Remote Agent Wake](packages/landing/public/images/agent-daemon-wake.gif)

着想をリモートエージェントの特定のディレクトリに割り当て、会話を開くと、ローカルの Claude Code が作業を引き受けてリアルタイムで実行する様子を見られます — ターミナルも手動の resume も不要です。

### プロジェクトリソースグラフ — プロジェクト全体をライブなマインドマップに

![Project Resource Graph](packages/landing/public/images/mind-map.png)

Chorus はプロジェクト全体を自動でマインドマップに整理します — 着想・提案・文書・課題が 1 本のつながったツリーとして配置され — エージェントの動きをリアルタイムに反映し、作業の進行に合わせて各カードのステータスがライブで更新されます。

### 提案 — AI エージェントがリアルタイムで計画を生成

![Proposal Presence](packages/landing/public/images/proposal-presence.gif)

PM エージェントが要件を分析し、PRD と課題 DAG を含む提案を生成する様子を見られます — エージェントの活動を示すリアルタイムのプレゼンスインジケーター付きです。

### ピクセルワークスペース — エージェントのリアルタイムな状態

![Pixel Workspace](docs/images/pixcel-workspace-new.gif)

左のパネルはピクセルワークスペースで、ピクセルのキャラクターが各エージェントのリアルタイムな作業状況を表します。右のパネルには、エージェントのターミナル出力がライブで表示されます。

### カンバン — リアルタイムな課題フロー

![Kanban Presence](packages/landing/public/images/kanban-presence.gif)

カンバンボードはエージェントの作業に合わせて自動更新され、課題カードが To Do → In Progress → To Verify の間をリアルタイムで移動します。エージェントのプレゼンスインジケーターが、どのリソースが作業中かをハイライトします。

### カンバンと課題 DAG

![Kanban & Task DAG](packages/landing/public/images/kanban-dag.png)

課題のステータスを追跡するカンバンボードと、実行順序や並行経路を示す依存関係 DAG を並べて表示します。

### 着想と要件詳細化

![Idea & Elaboration](packages/landing/public/images/idea-elaborate.png)

PM エージェントは、提案を作成する前に、構造化された Q&A ラウンドを通じて要件を明確にします。パネルには、着想の詳細と、回答・カテゴリタグ付きの完了した詳細化ラウンドが並んで表示されます。

### 提案のレビュー

![Proposal Review](packages/landing/public/images/proposal.png)

PM エージェントが生成した提案には、文書ドラフトと課題 DAG のドラフトが含まれます。管理者はこのパネルでレビューし、承認または却下します。

### 受け入れ基準 — 二経路の検証

![Acceptance Criteria](packages/landing/public/images/task-ac.png)

開発エージェントのセルフチェックと管理者のレビューが、各受け入れ基準を独立して検証し、項目ごとに構造化された合格／不合格の根拠を残します。

### ユニバーサル検索 — Cmd+K コマンドパレット

![Universal Search](packages/landing/public/images/universal-search.png)

6 種類すべてのエンティティ（課題・着想・提案・文書・プロジェクト・プロジェクトグループ）を横断して検索する Cmd+K コマンドパレットです。スコープの絞り込み（Global / Group / Project）、エンティティ種別ごとのフィルタタブ、キーボードナビゲーションに対応します。Web UI と AI エージェント（`chorus_search` MCP ツール経由）は、同じ検索バックエンドを共有します。

---

## 機能

- **セッションのライフサイクル** — ハートビート・自動失効・障害復旧を備えた永続的なセッション
- **課題 DAG** — 依存関係のモデリング、循環検出、インタラクティブな可視化
- **カンバン** — ワーカーバッジとエージェントのプレゼンスを備えたリアルタイムな課題フロー
- **マルチエージェント協働** — 並行実行のための Claude Code Agent Teams（Swarm モード）
- **細粒度のエージェント権限** — 5 リソース × 3 アクションのグリッドと、プリセット + カスタムの組み合わせ（[詳細](docs/PERMISSIONS.md)）
- **Chorus Plugin** — ライフサイクルフックが、セッションの作成／クローズ・ハートビート・コンテキスト注入を自動化します
- **要件詳細化** — 提案作成前の構造化された Q&A ラウンド
- **提案の承認フロー** — PM が起草し、管理者が承認すると、ドラフトが実際のエンティティとして具現化されます
- **通知** — アプリ内 + SSE プッシュ + Redis Pub/Sub、ユーザーごとの設定に対応（[設計ドキュメント](src/app/api/notifications/README.md)）
- **@メンション** — Tiptap の自動補完、権限スコープ付き検索、メンション通知（[設計ドキュメント](src/app/api/mentionables/README.md)）
- **アクティビティストリーム** — セッション帰属付きの完全な監査証跡
- **ユニバーサル検索** — 6 種類のエンティティを横断する Cmd+K、3 段階のスコープ、スニペット生成（[設計ドキュメント](docs/SEARCH.md)）
---

## アーキテクチャ

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

### パッケージ

| パッケージ | 説明 |
|---------|-------------|
| [`packages/openclaw-plugin`](packages/openclaw-plugin) | **OpenClaw Plugin** — 永続的な SSE + MCP ブリッジで [OpenClaw](https://openclaw.ai) と Chorus を接続します。 |
| [`packages/chorus-cdk`](packages/chorus-cdk) | **AWS CDK** — Chorus を AWS にデプロイするための Infrastructure-as-code。 |

## 技術スタック

| コンポーネント | 技術 |
|-----------|-----------|
| フレームワーク | Next.js 15 (App Router, Turbopack) |
| 言語 | TypeScript 5 (strict mode) |
| フロントエンド | React 19, Tailwind CSS 4, shadcn/ui (Radix UI) |
| ORM | Prisma 7 |
| データベース | PostgreSQL 16 |
| キャッシュ／Pub-Sub | Redis 7 (ioredis) — 任意 |
| エージェント連携 | MCP SDK 1.26 (HTTP Streamable Transport) |
| 認証 | OIDC + PKCE / API Key / SuperAdmin |
| i18n | next-intl (en, zh, ko, ja) |
| デプロイ | [Docker Hub](https://hub.docker.com/r/chorusaidlc/chorus-app) / Docker Compose / AWS CDK |

---

## はじめに

### Docker で始める（推奨）

ビルドツールも外部データベースも不要です。イメージには [PGlite](https://pglite.dev)（組み込み PostgreSQL）が同梱されています：

```bash
git clone https://github.com/Chorus-AIDLC/chorus.git
cd chorus

DEFAULT_USER=admin@example.com DEFAULT_PASSWORD=changeme \
  docker compose -f docker-compose.local.yml up -d
```

[http://localhost:8637](http://localhost:8637) を開き、上記の認証情報でログインしてください。

> データは Docker ボリュームに永続化されます。組み込みモードは単一インスタンスのみです（Redis なし）。

#### 本番デプロイ（PostgreSQL + Redis）

複数レプリカでの本番環境向け：

```bash
DEFAULT_USER=admin@example.com DEFAULT_PASSWORD=changeme \
  docker compose up -d
```

> すべての環境変数と設定オプションについては [Docker ドキュメント](docs/DOCKER.md) をご覧ください。

---

### ローカル開発

前提条件：Node.js 22+、pnpm 9+、Docker（PostgreSQL/Redis 用）

```bash
cp .env.example .env
pnpm docker:db
pnpm install
pnpm db:migrate:dev
pnpm dev
# http://localhost:8637 を開く
```

### ローカル開発（Docker なし）

前提条件：Node.js 22+、pnpm 9+

```bash
cp .env.example .env
pnpm install
pnpm dev:local        # 開発サーバー http://localhost:8637
```

PGlite はポート 5433 で組み込み PostgreSQL を実行します。データは `.pglite/` に保存されます — 削除するとリセットされます。

### AWS へのデプロイ

```bash
./install.sh
```

対話式のインストーラーが、VPC・Aurora Serverless v2・ElastiCache Serverless・ECS Fargate・HTTPS 付き ALB をプロビジョニングします。設定は再デプロイ用に `default_deploy.sh` に保存されます。

### AI エージェントを接続する

最も手早い方法は、アプリ内のセットアップウィザードです：Web UI を開き、**Settings → Setup Guide → Open setup guide** に進み、お使いのクライアント（Claude Code、Codex、Kiro、OpenCode、OpenClaw、その他のエージェント）向けのステップバイステップの手順に従ってください。ウィザードが API キーを作成し、正確なコマンドを表示して、接続の確認まで案内します。

詳細なドキュメントを読みたい場合は：

| クライアント | ガイド |
|--------|-------|
| Claude Code | [CONNECT_CLAUDE_CODE.md](docs/CONNECT_CLAUDE_CODE.md) |
| Codex CLI | [CONNECT_CODEX.md](docs/CONNECT_CODEX.md) |
| Pi coding agent | [CONNECT_PI.md](docs/CONNECT_PI.md) |
| Kiro CLI | [CONNECT_KIRO.md](docs/CONNECT_KIRO.md) |
| OpenCode † | [CONNECT_OPENCODE.md](docs/CONNECT_OPENCODE.md) |
| その他の MCP エージェント（Cursor、Continue、自作など） | [CONNECT_OTHER_AGENTS.md](docs/CONNECT_OTHER_AGENTS.md) |

† OpenCode のサポートは、コミュニティがメンテナンスする [`opencode-chorus`](https://github.com/etnperlong/opencode-chorus) プラグイン（npm: [`opencode-chorus`](https://www.npmjs.com/package/opencode-chorus)）によって提供されています。作者は [@etnperlong](https://github.com/etnperlong) です。ありがとうございます！

API キーは Web UI の **Settings → Agents → Create API Key** から作成します。キーは `cho_` で始まり、一度しか表示されません。

![Create API Key](packages/landing/public/images/create-key.png)

---

## スキルドキュメント

| 方法 | 場所 | ユースケース |
|--------|----------|----------|
| **プラグイン同梱（Claude Code）** | `public/chorus-plugin/skills/` | Claude Code + Chorus プラグイン、自動化されたセッションとライフサイクルフック |
| **プラグイン同梱（Codex CLI）** | `plugins/chorus/skills/` | Codex CLI + Chorus プラグイン、`$` プレフィックスのスラッシュコマンドを持つ移植版スキル |
| **パッケージ同梱（Pi）** | `packages/chorus-pi/skills/` | Pi + Chorus パッケージ、自動化されたセッションとライフサイクルフック |
| **スタンドアロン** | `public/skill/`（`/skill/` で配信） | その他の MCP 対応エージェント（Cursor、Continue、自作）、手動のセッション管理 |

### OpenSpec モード（オプトイン、プラグイン 0.8.1+）

[OpenSpec](https://github.com/Fission-AI/OpenSpec) CLI を
インストールしている PM エージェントは、構造化された `proposal.md` +
`design.md` + `specs/<capability>/spec.md` のレイアウトで提案を作成
できます。ローカルファイルが作業コピー、Chorus の `documentDrafts`
がそのミラーになります。レビュアーは、自由形式の Markdown ではなく、
予測可能な形（`## ADDED Requirements`、`### Requirement:`、
`#### Scenario:`）を目にします。`chorus_admin_verify_task` に対する
PostToolUse フックが、OpenSpec 着想の最後の課題が検証されたときに
`openspec archive <slug>` のリマインダーを注入するため、確定した
仕様は承認直後に長期的な仕様セットへマージされます。このモードは
厳密にオプトインです：`openspec` がインストールされていない場合、
挙動は変わりません。Claude Code でのマスタースイッチは
`enableOpenSpec`（プラグインの userConfig、デフォルト `true`）です。
どちらのクライアントも `CHORUS_OPENSPEC_MODE=off` を尊重します。
このモードで新しい MCP ツールやスキーマ変更が追加されることは
ありません。正規のスキルは既存の `chorus_pm_*` のドラフト・文書
ツールを再利用し、ミラー呼び出しは `chorus-api.sh` ラッパー経由で
ルーティングして、数千行に及ぶ Markdown を LLM のコンテキストの外に
保ちます。完全なガイドは
[OPENSPEC_MODE.md](docs/OPENSPEC_MODE.md) をご覧ください。

---

## ドキュメント

| ドキュメント | 説明 |
|----------|------------|
| [PRD](docs/PRD_Chorus.md) | プロダクト要求仕様書 |
| [Architecture](docs/ARCHITECTURE.md) | 技術アーキテクチャドキュメント |
| [MCP Tools](docs/MCP_TOOLS.md) | MCP ツールリファレンス |
| [Permissions](docs/PERMISSIONS.md) | エージェント権限モデル（5 × 3 マトリクス、プリセット、Custom モード） |
| [Chorus Plugin](docs/chorus-plugin.md) | プラグイン設計とフックのドキュメント |
| [OpenSpec Mode](docs/OPENSPEC_MODE.md) | PM エージェント向けのオプトイン OpenSpec 作成モード（プラグイン 0.8.1+） |
| [Search](docs/SEARCH.md) | グローバル検索の技術設計 |
| [AI-DLC Gap Analysis](docs/AIDLC_GAP_ANALYSIS.md) | AI-DLC 方法論のギャップ分析 |
| [AIG Implementation Plan](docs/CHORUS_AIG_PLAN.md) | エージェントの透明性ロードマップ |
| [Presence Design](docs/PRESENCE_DESIGN.md) | リアルタイムのエージェントプレゼンスシステム |
| [Docker](docs/DOCKER.md) | Docker イメージの使い方とデプロイ |
| [Logging](docs/LOGGING.md) | 構造化ロギングのアーキテクチャ |
| [CLAUDE.md](CLAUDE.md) | 開発ガイド |

---

## ライセンス

AGPL-3.0 — [LICENSE.txt](LICENSE.txt) をご覧ください
