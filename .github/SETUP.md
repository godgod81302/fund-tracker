# 🚀 快速設置指南

## 第一步：推送到 GitHub

如果還沒有推送專案到 GitHub：

```bash
# 初始化 git（如果還沒有）
git init

# 添加所有文件
git add .

# 提交
git commit -m "Initial commit with GitHub Actions"

# 連接到 GitHub 倉庫（替換成你的倉庫 URL）
git remote add origin https://github.com/你的用戶名/fund-tracker.git

# 推送
git push -u origin main
```

如果已經有 GitHub 倉庫：

```bash
# 添加 workflow 文件
git add .github/

# 提交
git commit -m "Add GitHub Actions for scheduled scraping"

# 推送
git push
```

## 第二步：啟用 Actions

1. 打開瀏覽器，前往你的 GitHub 倉庫
2. 點擊頂部的 **Actions** 標籤
3. 如果看到提示，點擊 **I understand my workflows, go ahead and enable them**
4. 完成！

## 第三步：手動測試（可選）

1. 在 Actions 頁面，點擊左側的 **Scheduled Fund Scraping**
2. 點擊右上角的 **Run workflow** 按鈕
3. 點擊綠色的 **Run workflow** 確認
4. 刷新頁面，應該會看到一個執行中的 workflow
5. 點擊進入查看執行日誌

## 第四步：停用 Cloudflare Cron（建議）

編輯 `wrangler.toml`，註解掉 cron 配置：

```toml
# [triggers]
# crons = ["*/10 * * * *"]
```

重新部署：

```bash
npx wrangler deploy
```

## 完成！

現在 GitHub Actions 會每 10 分鐘自動觸發基金抓取。

你可以在 Actions 頁面隨時查看執行狀態和日誌。
