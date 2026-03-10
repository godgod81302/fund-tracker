# GitHub Actions 定時任務設置說明

## 📋 功能

此 GitHub Actions workflow 會：
- 每 10 分鐘自動觸發基金數據抓取
- 調用 Cloudflare Worker 的 `/api/scrape` 端點
- 檢查並顯示抓取進度
- 比 Cloudflare Cron 更穩定可靠

## 🚀 設置步驟

### 1. 推送到 GitHub

```bash
# 在專案根目錄執行
git add .github/workflows/scheduled-scrape.yml
git commit -m "Add GitHub Actions scheduled scraping"
git push
```

### 2. 啟用 GitHub Actions

1. 前往你的 GitHub 倉庫
2. 點擊 **Actions** 標籤
3. 如果是第一次使用，點擊 **I understand my workflows, go ahead and enable them**
4. 找到 **Scheduled Fund Scraping** workflow
5. 點擊 **Enable workflow**

### 3. 手動測試

1. 在 Actions 頁面，選擇 **Scheduled Fund Scraping**
2. 點擊右側 **Run workflow** 按鈕
3. 點擊 **Run workflow** 確認
4. 等待執行完成，檢查日誌

### 4. 停用 Cloudflare Cron（可選）

由於 GitHub Actions 已經接管定時任務，可以停用 Cloudflare Cron：

```toml
# wrangler.toml
# [triggers]
# crons = ["*/10 * * * *"]  # 註解掉
```

然後重新部署：
```bash
npx wrangler deploy
```

## ⚙️ 配置選項

### 修改執行頻率

編輯 `.github/workflows/scheduled-scrape.yml`：

```yaml
schedule:
  - cron: '*/10 * * * *'  # 每10分鐘
  # - cron: '*/15 * * * *'  # 每15分鐘
  # - cron: '0 * * * *'     # 每小時
```

**注意：** GitHub Actions 的最小間隔是 5 分鐘，且在高峰時段可能會有 3-10 分鐘的延遲。

### 超時設置

```yaml
timeout-minutes: 5  # 單次執行最長時間
```

## 📊 監控

### 查看執行歷史

1. 前往 **Actions** 標籤
2. 選擇 **Scheduled Fund Scraping**
3. 查看最近的執行記錄

### 查看日誌

1. 點擊任一執行記錄
2. 點擊 **scrape** job
3. 展開各個步驟查看詳細日誌

### 接收通知

GitHub 會在 workflow 失敗時發送郵件通知（預設啟用）。

## 🔧 故障排除

### Workflow 沒有執行

1. **檢查是否啟用：** Actions 頁面確認 workflow 已啟用
2. **檢查倉庫活躍度：** GitHub 會暫停超過 60 天無活動的倉庫的 scheduled workflows
3. **檢查語法：** 確保 YAML 文件格式正確

### API 調用失敗

1. 查看 workflow 日誌的錯誤訊息
2. 確認 Worker API 端點可正常訪問
3. 檢查是否有速率限制

### 執行時間不準確

GitHub Actions 的 cron 在高峰時段可能延遲 3-10 分鐘，這是正常現象。

## 🆚 對比 Cloudflare Cron

| 特性 | GitHub Actions | Cloudflare Cron |
|------|----------------|-----------------|
| 穩定性 | ⭐⭐⭐⭐⭐ 非常穩定 | ⭐⭐⭐ 偶爾停止 |
| 最小間隔 | 5 分鐘 | 1 分鐘 |
| 延遲 | 3-10 分鐘可能 | 秒級 |
| 日誌 | 詳細且易查看 | 需要額外設置 |
| 免費額度 | 2000 分鐘/月 | 無限制 |
| 監控 | 內建通知 | 需要手動檢查 |

## 💡 建議

1. **雙重保障：** 可以同時保留 Cloudflare Cron 作為備份
2. **錯峰執行：** 設置不同的執行時間（如 GitHub Actions 在整點，Cloudflare Cron 在半點）
3. **監控告警：** 設置額外的監控服務（如 UptimeRobot）定期檢查數據更新狀態
