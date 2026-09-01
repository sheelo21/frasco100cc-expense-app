# 経費精算アプリ

ブラウザだけで完結する経費精算メモアプリです。サーバー・バックエンドは一切不要で、静的ファイルをホスティングするだけで動作します。

- データはすべてブラウザの `localStorage` / `IndexedDB` に保存されます（サーバーには送信されません）
- 領収書の写真・PDFはブラウザ内でOCR処理し、日付・金額を自動入力します（外部APIには送信されません）

## フォルダ構成

```
expense-app/
├── index.html          アプリ本体（HTML/CSS）
├── app.js               アプリのロジック
└── assets/
    ├── tesseract.min.js  OCRライブラリ本体
    ├── ocr-assets.js      OCR用データ（日本語モデル等、Base64埋め込み）
    └── pdfjs-assets.js    PDF読み込み用データ（Base64埋め込み）
```

## GitHubへの登録

このフォルダの中身をそのままリポジトリのルートに置いてください。

```bash
git init
git add .
git commit -m "Initial commit: 経費精算アプリ"
git branch -M main
git remote add origin https://github.com/<あなたのユーザー名>/<リポジトリ名>.git
git push -u origin main
```

## Vercelへのデプロイ

1. [Vercel](https://vercel.com/) にログインし、「Add New… → Project」を選択
2. 上記でGitHubに登録したリポジトリを選択してインポート
3. Framework Preset は **Other**（もしくは未検出のままでOK）を選択
4. Build Command / Output Directory は空欄のままで問題ありません（静的ファイルをそのまま配信するだけのため）
5. 「Deploy」をクリック

環境変数の設定は不要です。数十秒でデプロイが完了し、`https://<プロジェクト名>.vercel.app` のようなURLでアクセスできるようになります。

## 補足

- 独自ドメインを使いたい場合は、Vercelのプロジェクト設定の「Domains」から追加できます。
- アプリを更新したいときは、このフォルダの中身を書き換えて再度GitHubにpushすれば、Vercelが自動的に再デプロイします。
- フォントはGoogle Fontsから読み込むため、閲覧環境にインターネット接続が必要です（OCR機能自体はオフラインで動作します）。
