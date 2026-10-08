# Clear Audio 設計規格 v0.5（依 ui-visual-design skill）

設計前先讀 `~/.claude/skills/ui-visual-design/SKILL.md`、`references/styles.md`（Apple 一節）、`references/web.md` 或 `references/native.md`、`references/review.md`。

## 意圖
- 誰：想把自己有權保存的音訊（如自己在 Suno 生成的歌）存下來的人，不熟音訊技術。
- 情境：音樂正在播放，想「現在就存」。
- 最重要的一個動作：開始錄（popup「● 錄成 MP3」、控制台「選擇 WAV 並開始」、原生「開始錄音」）；錄音中則是「停止並保存」。畫面上它必須最突出，其他讓位。

## 風格：Apple 語彙＋Clear Audio 深綠品牌
- 群組背景（淺 #F2F2F7／深 #000000）上放白色／深灰圓角卡片，不用深綠大色塊當面板；深綠只給主要動作、選取與焦點。
- 同心圓角：卡片 16px、卡內元素 = 16 − 內距；按鈕用膠囊（radius 999px）；分段選擇器為灰軌道＋白滑塊。
- 大計時數字輕而大：`font-weight: 300–400`、tabular-nums、字距 −0.02em。
- 列表採 inset grouped：列高 ≥ 44px、列間細分隔線（左側縮排對齊文字）。
- 玻璃材質只用在浮於內容上方的頂欄（sticky header），需有 `prefers-reduced-transparency` 退回不透明；內容卡片不透明。
- 錄音狀態：紅色膠囊「● 錄音中」＋紅點脈動（尊重 reduced-motion）。不要整片變紅。
- 動畫 200–300ms、`cubic-bezier(.32,.72,0,1)`。

## Token（已用 contrast.py 驗證）

| token | 淺色 | 深色 | 用途 |
|---|---|---|---|
| `--bg` | #F2F2F7 | #000000 | 群組背景 |
| `--surface` | #FFFFFF | #1C1C1E | 卡片 |
| `--surface-2` | #E9E9EE | #2C2C2E | 軌道、次要按鈕底、磁貼 |
| `--text` | #1D1D1F | #F5F5F7 | 主文字（15.1 / 19.3:1） |
| `--muted` | #6E6E73 | #98989D | 次要文字（4.54 / 5.93:1） |
| `--muted-2` | #66666B | #98989D | `--surface-2` 上的次要文字（`--muted` 在其上僅 4.19:1） |
| `--separator` | rgb(60 60 67 / .18) | rgb(84 84 88 / .6) | 分隔線（裝飾） |
| `--input-border` | #8E8E93 | #8E8E93 | 有意義的邊框（3.26:1 以上） |
| `--brand` | #146E59 | #5FCCA6 | 主要動作底、連結、選取（6.17 / 8.65:1） |
| `--brand-ink` | #FFFFFF | #062019 | 主要按鈕文字（6.17 / 8.69:1） |
| `--danger` | #C4141C | #FF6961 | 停止錄音、錯誤（6.06 / 6.03:1） |
| `--danger-ink` | #FFFFFF | #2A0503 | 危險按鈕文字 |
| `--warn` | #B25000 | #FFB340 | 警示文字（5.20 / 9.54:1） |
| `--meter-ok` | #248A3D | #30D158 | 電平圖形（非文字 3:1） |
| `--meter-warn` | #B25000 | #FFB340 | ≥ −6 dBFS |
| `--meter-clip` | #C4141C | #FF6961 | 削波 |
| `--focus` | #146E59 | #5FCCA6 | 焦點框 2px、offset 2px（同強調色，如 Apple） |

字體：`-apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI", "Microsoft JhengHei UI", "PingFang TC", system-ui, sans-serif`；數字 `"SF Pro Display", "Segoe UI Variable Display", "Segoe UI", system-ui`。間距 4/8 刻度。

## 不變的約束
- 不新增權限、外部字型或 CDN；所有既有 id、`body[data-state]`／`data-mode` 值、JS 契約不變；測試必須全過。
- 所有計量來自真實資料；預覽值明示。
- 長檔名換行，不水平溢出（360px 驗證）。
- 原生程式：GDI 無真實模糊，用不透明表面；所有尺寸經 `px()`。
