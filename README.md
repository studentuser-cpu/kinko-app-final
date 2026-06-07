# レジ締め金庫管理

棒金・バラの枚数を入力するだけで、金庫の残高と補充必要額を素早く計算・管理できるWebアプリケーションです。Firebaseを利用したクラウドデータ同期や、Stripeによるサブスクリプション機能を備えています。

## 主な機能
* **残高計算機能**: 棒金・バラの入力によるリアルタイムな合計金額、差額、補充必要額の計算。
* **ユーザー認証**: Firebase Authを利用したセキュアなログイン・新規登録（`@gmail.com` ドメインのみに制限）。
* **クラウド同期**: 設定や過去の履歴スナップショットをFirestoreに自動保存し、マルチデバイスで共有可能。
* **履歴管理**: 過去の集計履歴をリスト、カレンダー、テーブル形式で閲覧・管理・CSV出力。
* **サブスクリプション**: Stripe Checkoutを経由した課金ステータス管理。
* **セキュリティ対策**: HelmetによるHTTPヘッダー保護、CORS制限、管理者APIのレート制限・ロックアウト機能。

## 技術スタック
* **Frontend**: HTML5, CSS3, Vanilla JavaScript (Firebase SDK Compat)
* **Backend**: Node.js, Express
* **Database & Auth**: Firebase (Authentication, Firestore)
* **Payment**: Stripe API


