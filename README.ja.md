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

**[v0.22.0](https://chorus-ai.dev/blog/chorus-v0.22.0-release/)**：Hermes Agent に対応しました。Hermes 自身の gateway を通じて既存の Chorus ワークフローに参加でき、Chorus daemon を別途起動する必要はありません。Chorus で仕事を割り当て、Hermes が実行し、結果や承認リクエストをプロジェクトに返します。プラグインは Chorus CLI 経由でも、Hermes から直接でもインストールできます。

**[v0.21.0](https://chorus-ai.dev/blog/chorus-v0.21.0-release/)**：非公開プロジェクトとプロジェクトグループを追加し、Viewer、Editor、Admin のアクセス権とグループ権限の即時継承に対応しました。エージェントの起動・実行エラーの診断情報を会話に保存します。Linux デーモンの継続稼働を改善し、セキュリティ関連の依存関係も更新しました。

**[v0.20.0](https://chorus-ai.dev/blog/chorus-v0.20.0-release/)** — デーモンのバックエンドを Codex App Server、Claude Code の双方向 stream-json、Pi のネイティブ RPC に移行し、プロトコルを通じて中断と実行状態を扱うようになりました。新しい `chorus upgrade` は npm でグローバルインストールした CLI を更新し、`--plugins` を付けると設定済みの Claude Code、Codex、Kiro、Pi 連携も更新できます。

**[v0.19.1](https://chorus-ai.dev/blog/chorus-v0.19.1-release/)** — 軽量 Research を追加し、Idea の要件整理や Proposal の設計時に重要な事実を確認できるようになりました。インライン引用で根拠となる資料を示せるほか、開発開始前なら Tracker から追加調査を依頼できます。

**[v0.19.0](https://chorus-ai.dev/blog/chorus-v0.19.0-release/)** — Cloudflare を参考にレビューの範囲を明確化し、問題の根拠を省略せず、固定 ID で再レビュー時も追跡。タスクレビューでは受け入れ基準に加え、コード品質も標準で確認します。

**[v0.18.0](https://chorus-ai.dev/blog/chorus-v0.18.0-release/)** — OpenSpec を補う、軽量で Git ネイティブなローカル Spec 管理として `spec-lite` を内蔵しました。live session anchor により、デーモンエージェントからの返信が、起点となったエージェントの既存 Idea セッションへ戻ります。

**[v0.17.2](https://chorus-ai.dev/blog/chorus-v0.17.2-release/)** — Pi が正式配布とデーモンウェイクに対応し、`chorus agents run` でローカルのエージェントプロファイルをすぐ切り替えられます。

**[v0.17.0–0.17.1](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.17.1)** — 1 つの CLI で各コーディングエージェントに Chorus を導入・更新できるようになりました。Tracker、Graph、Idea 詳細ではデーモンの活動をリアルタイムに確認できます。

> 完全な変更履歴：[CHANGELOG.md](CHANGELOG.md)

---

## クイックスタート

2 つのコマンドだけです — データベースも Docker も設定ファイルも不要です。

```bash
npm install -g @chorus-aidlc/chorus@0.21.0
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

最も手早い方法は、アプリ内のセットアップウィザードです：**Settings → Setup Guide** を開いてください。ウィザードが API キーを作成し、お使いのクライアント（Claude Code、Codex、Kiro、dsh、OpenCode、OpenClaw、Pi、Hermes、その他 MCP 互換のエージェント）向けの正確なコマンドを表示します。

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
