<p align="center">
  <img src="packages/landing/public/images/chorus-slug.png" alt="Chorus" width="240" />
</p>

<p align="center"><strong>あなたのコーディングエージェントの上に乗せる Harness。エージェントが提案し、人間が検証し、ソフトウェアが届く。</strong></p>

<p align="center">
  <a href="https://discord.gg/SwcCMaMmR">
    <img src="https://img.shields.io/badge/Discord-Join%20us-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord">
  </a>
  <a href="https://github.com/Chorus-AIDLC/Chorus/actions/workflows/test.yml">
    <img src="https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/ChenNima/f245ebf1cf02d5f6e3df389f836a072a/raw/coverage-badge.json" alt="Coverage">
  </a>
</p>

<p align="center"><a href="README.md">English</a> · <a href="README.zh.md">中文</a> · <a href="README.ko.md">한국어</a> · <strong>日本語</strong></p>

<p align="center"><a href="https://doc.chorus-ai.dev/ja/"><strong>📖 ドキュメント</strong></a></p>

Chorus は、あなたのコーディングエージェントの上に乗せる Harness です。コーディングエージェントがモデルを harness してコードを書くように、Chorus はさらに一段上の Harness として、そうしたエージェントのチーム全体とあなたを、ひとつのパイプラインにまとめます。エージェントが提案し、人間が検証し、アイデアが届けられるソフトウェアへと変わります。その下層では、マルチエージェントで人間が関与する協働を破綻させないためのものを引き受けます：セッションのライフサイクル、課題の状態、サブエージェントのオーケストレーション、可観測性、障害復旧。すべての AI エージェントは、細かく設定可能な権限を持ちます。

**[AI-DLC（AI-Driven Development Lifecycle）](https://aws.amazon.com/blogs/devops/ai-driven-development-life-cycle/)** の方法論に着想を得ています。中核となる理念は **Reversed Conversation** — AI が提案し、人間が検証します。

---

## AI-DLC ワークフロー

```
Idea ──> Proposal ──> [Document + Task DAG] ──> Execute ──> Verify ──> Done
  ^          ^               ^                     ^          ^         ^
人間      idea:write     proposal:write         task:write   *:admin    *:admin
作成      + 詳細化       + 起草                  + 報告      + 検証     + 完了
```

各ステージの下に記載されているのは、そのステージでアクターに必要となる**権限**です — 人間、エージェント（プリセットまたは Custom）、あるいはその両方に付与できます。固定的なロールは存在せず、5 × 3 の権限マトリクスの任意の組み合わせが可能です。→ [エージェント権限](https://doc.chorus-ai.dev/ja/guides/manage-agents/)

---

## 最近の更新

**[v0.16.1](https://chorus-ai.dev/blog/chorus-v0.16.1-release/)** — 1 つの `chorus daemon` が、互いに独立した複数のエージェントを同時に扱えるようになりました。各エージェントは `agents[]` 配列で自分のキー・作業ディレクトリ・バックエンド・権限を持ちます。エージェント同士は @メンションで作業を渡し合え、各ウェイクはそのエージェント自身のプロジェクトディレクトリに届きます。

**[v0.16.0](https://chorus-ai.dev/blog/chorus-v0.16.0-release/)** — エージェントをドキュメントサイト（[doc.chorus-ai.dev](https://doc.chorus-ai.dev)）へ案内する `docs` スキルを追加し、記憶に頼らず現在のドキュメントを読んで回答するようにしました。

**[v0.15.0](https://chorus-ai.dev/blog/chorus-v0.15.0-release/)** — プロジェクト単位の Agent 作業ディレクトリ：各ユーザーがプロジェクト内の Agent ごとにホストと cwd を設定し、デーモンが許可したルートだけを参照できます。割り当て、ウェイク、再開、後続ターンで同じ実行先を使い、進行中のセッションは移動しません。Codex は再開可能なバックエンド thread ID を別に保存し、不要になった Chorus の session 管理手順を削除しました。

**[v0.14.1](https://chorus-ai.dev/blog/chorus-v0.14.1-release/)** — Amazon Kiro CLI が 4 つ目の接続方法になりました（Kiro CLI v2）：ワンコマンドの `install-kiro.sh` プラグインと `--agent kiro` デーモンバックエンド、加えていくつかのデーモン修正。

**[v0.14.0](https://chorus-ai.dev/blog/chorus-v0.14.0-release/)** — アプリ全体のダークモード（ライト / ダーク / システム）。参考資料をあらゆる着想・提案・課題に添付でき、インラインでも MCP 経由でも読み取れます。韓国語と日本語を追加（韓国語はコミュニティによる貢献）。グループ化のための**テーマ**着想、デーモンの「開発を開始」/「Yolo」ボタン、対話式の着想入力、クラッシュからの再開、`chorus daemon install`。

> 完全な変更履歴：[CHANGELOG.md](CHANGELOG.md)

---

## クイックスタート

2 つのコマンドだけです — データベースも Docker も設定ファイルも不要です。

```bash
npm install -g @chorus-aidlc/chorus
chorus
```

Chorus は組み込みの PostgreSQL（PGlite）で起動し、マイグレーションを自動実行して、**http://localhost:8637** で開きます。デフォルトのログイン情報：`admin@chorus.local` / `chorus`。

> 複数のエージェントを動かしたり、本番環境にデプロイしたりする場合は？外部の PostgreSQL、Docker、または AWS を利用してください → **[デプロイとセルフホスト](https://doc.chorus-ai.dev/ja/guides/deployment-overview/)**。

ローカルマシンを、割り当てられた課題を実行するエージェントランタイムにするには、`chorus daemon` を実行してください → **[デーモン運用](https://doc.chorus-ai.dev/ja/guides/daemon-operations/)** · **[リモートコントロール](https://doc.chorus-ai.dev/ja/guides/remote-control/)**。

---

## スクリーンショット

### リモートエージェントのウェイク — ディレクトリにディスパッチし、実行を見守る

![Remote Agent Wake](packages/landing/public/images/agent-daemon-wake.gif)

着想をリモートエージェントの特定のディレクトリに割り当て、会話を開くと、ローカルの Claude Code が作業を引き受けてリアルタイムで実行する様子を見られます — ターミナルも手動の resume も不要です。

### プロジェクトリソースグラフ — プロジェクト全体をライブなマインドマップに

![Project Resource Graph](packages/landing/public/images/mind-map.png)

着想・提案・文書・課題が 1 本のつながったツリーとして配置され、作業の進行に合わせて各カードのステータスがライブで更新されます。

### 提案 — AI エージェントがリアルタイムで計画を生成

![Proposal Presence](packages/landing/public/images/proposal-presence.gif)

PM エージェントが要件を分析し、PRD と課題 DAG を含む提案を生成する様子を見られます — エージェントの活動を示すリアルタイムのプレゼンスインジケーター付きです。

### カンバン — リアルタイムな課題フロー

![Kanban Presence](packages/landing/public/images/kanban-presence.gif)

カンバンボードはエージェントの作業に合わせて自動更新され、課題カードが To Do → In Progress → To Verify の間をリアルタイムで移動します。エージェントのプレゼンスインジケーターが、どのリソースが作業中かをハイライトします。

---

## AI エージェントを接続する

最も手早い方法は、アプリ内のセットアップウィザードです：**Settings → Setup Guide** を開いてください。ウィザードが API キーを作成し、お使いのクライアント（Claude Code、Codex、Kiro、dsh、OpenCode、OpenClaw、Pi、その他 MCP 互換のエージェント）向けの正確なコマンドを表示します。

クライアントごとの詳細なガイド → **[エージェントプラットフォーム](https://doc.chorus-ai.dev/ja/reference/agents/)**。

API キーは **Settings → Agents → Create API Key** から作成します。キーは `cho_` で始まり、一度しか表示されません。

---

## 技術スタック

| コンポーネント | 技術 |
|-----------|-----------|
| フレームワーク | Next.js 15 (App Router, Turbopack) |
| 言語 | TypeScript 5 (strict mode) |
| フロントエンド | React 19, Tailwind CSS 4, shadcn/ui |
| データ | PostgreSQL 16 + Prisma 7, Redis 7 (任意) |
| エージェント連携 | MCP SDK (HTTP Streamable Transport) |
| 認証 | OIDC + PKCE / API Key / SuperAdmin |
| i18n | next-intl (en, zh, ko, ja) |
| デプロイ | npm / Docker / AWS CDK |

---

## ドキュメント

**📖 完全なドキュメント：[doc.chorus-ai.dev](https://doc.chorus-ai.dev/ja/)**

- [はじめに](https://doc.chorus-ai.dev/ja/guides/getting-started/)
- [エージェントを接続する](https://doc.chorus-ai.dev/ja/reference/agents/)
- [AI-DLC ワークフロー](https://doc.chorus-ai.dev/ja/guides/ai-dlc-workflow/)
- [プラグインとコマンド](https://doc.chorus-ai.dev/ja/guides/plugin-commands/)
- [MCP ツールリファレンス](https://doc.chorus-ai.dev/ja/reference/mcp-tools/)
- [デプロイとセルフホスト](https://doc.chorus-ai.dev/ja/guides/deployment-overview/)

---

## ライセンス

AGPL-3.0 — [LICENSE.txt](LICENSE.txt) をご覧ください
