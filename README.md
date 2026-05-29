# 社販表バーコード集計・アラジン照合ツール

PDFの社販タグ表からJANコードを読み取り、商品マスタと紐づけてExcel集計表を作成し、アラジンデータとの照合まで行うローカル用ツールです。

## フォルダ構成

```text
codex_test_space01/
  app.js
  backend.py
  compare_aladdin_data.py
  export_staff_sale_excel.py
  index.html
  requirements.txt
  styles.css
  assets/
  作成ログ/
  商品マスタ/              # Git管理外。商品マスタ.csvを配置
  社販表サンプル/          # Git管理外。読み取り対象PDFを配置
  OUTPUT/                  # Git管理外。Excel出力先
```

## 初期セットアップ

```powershell
cd "C:\Users\FUN-PC126\Desktop\テスト環境\codex_test_space01"
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

## 入力ファイル

- `商品マスタ\商品マスタ.csv`
- `社販表サンプル\*.pdf`

実データには個人名・商品情報が含まれるため、GitHubにはアップしない設定にしています。

## Excel集計表の作成

```powershell
python export_staff_sale_excel.py
```

`OUTPUT\社販集計表_YYYY_MM.xlsx`が作成されます。

## アラジン照合

1. 作成されたExcelの`アラジンデータ`シートへ、アラジンから出力したデータを貼り付けます。
2. 次のコマンドを実行します。

```powershell
python compare_aladdin_data.py OUTPUT\社販集計表_YYYY_MM.xlsx
```

`OUTPUT\社販集計表_YYYY_MM_照合完了.xlsx`が作成されます。

## ローカルWeb画面

```powershell
python backend.py
```

ブラウザで次を開きます。

```text
http://127.0.0.1:8000
```

