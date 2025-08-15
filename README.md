# asana-slack-script

asana上の複数のプロジェクトを横断して開始日と期日を取得するスクリプト。  

## セットアップ

```bash

cd asana-slack-script
npm i
cp .env.example .env

```

### 必要なもの
- **ASANA_TOKEN**: Personal Access Token(Asanaの「開発者アプリ」から発行)
- **ASANA_WORKSPACE_GID**: 対象ワークスペースのGID
- **ASANA_PROJECT_GIDS**: 対象プロジェクトのGIDをカンマ区切りで
- **Slack**: **SLACK_WEBHOOK_URL**


## 出力例（Slack）

```
【2025-08-15 が期日のタスク】
・筋トレアプリ　UI構想 open
・スッキリわかる英単語 Section4 open

【2025-08-15 に開始するタスク】
・筋トレアプリ　ログイン画面実装 open
・ネットワークスペシャリスト　午後II open
```
