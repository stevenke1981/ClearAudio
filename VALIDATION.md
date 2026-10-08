# 驗證記錄

## 2026-10-08 v0.4 / 擴充 v0.3：介面美化與功能補強

- 分頁控制台重新設計：淺色／深色主題（prefers-color-scheme）、狀態膠囊、數值磁貼（峰值保持、削波次數、檔案大小、取樣率）、近 30 秒真實峰值歷史 canvas、dB 刻度電平、本次已保存清單、Alt+R/S/X 快捷鍵、錄音中 REC 徽章（控制台關閉時自動清除）。未新增任何權限。
- Node tests 38 通過（原 17）。新增 helpers（dB 映射、格式化、歷史環形緩衝）、徽章授權與清除、狀態轉換、保存清單、鍵盤、徽章失敗不影響保存等。
- 原生 GUI：圓角按鈕（主要／危險／次要／幽靈／停用／焦點框）、側欄導覽膠囊、紅點錄音指示、dB 刻度與峰值保持、真實峰值歷史（每個擷取 meter 回報推入一格）。Rust tests 9 通過；fmt、clippy -D warnings 無警告；release build 成功。
- --gui-smoke：idle／recording／converting／error／import／recording-signal（合成值，畫面明示「預覽合成值 · 非真實音訊」）／720px@144dpi 皆 PASS 控件邊界審計並人工檢視 PNG。
- 控制台頁在 Chrome 以本機靜態伺服預覽（非擴充環境、未捕捉）：桌面與 360px 寬無水平溢出。注入的錄音狀態值僅供檢視樣式。

# 驗證記錄

2026-10-08，一般授權音訊工作流程改善。未接觸任何網站播放、登入、下載或私人音訊。

- 17 個 Node tests 通過（含生命週期父測試）：來源綁定、拒重複 capture、非控制台 sender 拒絕、檔名清理、真實 PCM peak、非空目的檔拒絕，以及 mock 選檔取消、停止提交、取消 abort、磁碟失敗、來源結束與可再次錄音。另含原有 WAV／worklet tests。
- 5 個 Rust tests 通過；fmt、clippy 無警告。Rust 捕捉與轉檔邏輯沿用既有版本，此輪只移除特定第三方 App 的 FFmpeg 路徑自動探測，使用 PATH／手動選取。
- 既有自產音訊 MP3 VBR q2／CBR192／CBR320／FLAC 轉檔與解碼成功；取消、拒覆寫、來源逐 byte 保留成功。
- 唯讀 Core Audio 枚舉：render endpoints=0，console／multimedia／communications 預設端點均 `0x80070490`。沒有啟動音訊 client、播放或捕捉。
- Browser API mock 不代表真實權限、音訊裝置、File System Access 原子性或 Chrome/Edge 整合驗收。擴充未安裝、未以真實分頁授權捕捉。
- 原生 v0.2 曾完成 13 組 GUI renderer DPI／窄視窗／狀態渲染檢查；非真實跨螢幕 DPI 測試。
- 新分頁控制台在獨立暫存 Edge headless profile 檢查桌面與窄視窗靜態 HTML/CSS。未載入擴充、未捕捉，也未把靜態畫面當成分頁授權測試。

待驗收：真實非靜音與跨程序隔離、擴充權限與來源音訊、真實磁碟故障、裝置切換、跨螢幕 DPI、長時間錄音。不得把 mock 或畫面預覽當成上述驗證。
