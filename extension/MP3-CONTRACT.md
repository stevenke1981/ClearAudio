# 一鍵錄成 MP3：模組介面契約（v0.4）

使用者流程：在播放中的分頁點擴充圖示 → 彈出面板按「● 錄成 MP3」（或快捷鍵 Alt+Shift+R 直接開始／停止）→ 錄音在 offscreen document 進行，關閉面板不影響 → 再按「■ 停止並存 MP3」→ 檔案自動存到「下載/ClearAudio/<歌名 - 演出者（取自頁面 Media Session，無則為分頁標題）>-<時間>.mp3」。若整段錄音全程無聲（`last.silent`），面板的已存檔卡片會顯示警告，檔案仍保留。

原則：只錄使用者明示授權的單一分頁；不抓網站串流原檔、不繞過 DRM／下載限制；不連網；計量全為真實 PCM peak。

## 檔案歸屬

| 檔案 | 負責 |
|---|---|
| `offscreen.html`, `offscreen.js`, `mp3.js`, `mp3.test.js`, `offscreen.test.js` | 代理 A（擷取＋編碼） |
| `background.js`, `background.test.js`, `manifest.json` | 代理 B（協調） |
| `popup.html`, `popup.css`, `popup.js`, `popup.test.js` | 代理 C（面板 UI） |
| `vendor/lame.min.js` | 已內附 lamejs 1.2.1（LGPL-3.0），勿修改。classic script，載入後提供全域 `lamejs`，`new lamejs.Mp3Encoder(channels, sampleRate, kbps)`，`.encodeBuffer(Int16Array left, Int16Array right)` 回傳 Int8Array，`.flush()` 回傳 Int8Array。 |
| 既有 `recorder.html/js`, `pcm-worklet.js`, `helpers.js`, `wav.js` | 保留（進階 WAV 流程），可 import 其 helpers，勿改 |

## manifest（代理 B）

- permissions: `activeTab`, `tabCapture`, `offscreen`, `downloads`, `scripting`（僅供 `readMediaInfo` 於使用者授權的分頁執行讀取 Media Session 的函式；仍不設 host permissions，不連網）
- `action.default_popup`: `popup.html`（因此 `chrome.action.onClicked` 不再觸發；WAV 控制台改由面板連結開啟）
- `commands`: `"toggle-mp3": {"suggested_key": {"default": "Alt+Shift+R"}, "description": "開始／停止將目前分頁錄成 MP3"}`
- version `0.4.0`

## 訊息協定

所有 runtime 訊息為物件，以 `type` 區分。offscreen 收發的訊息另帶 `target: 'offscreen'`（送往 offscreen）或 `from: 'offscreen'`（offscreen 送出）。

### 面板 → 背景（代理 C 呼叫、代理 B 實作），皆以 `chrome.runtime.sendMessage` 回應物件

- `{type:'mp3-status'}` → `Status`
- `{type:'mp3-start', tabId:number, title:string, origin:string, kbps:128|192|320}` → `Status` 或 `{error}`
- `{type:'mp3-stop'}` → `{ok:true}` 或 `{error}`（真正完成以 `mp3-state` 廣播通知）
- `{type:'mp3-cancel'}` → `{ok:true}`（丟棄，不下載）
- `{type:'mp3-show', downloadId:number}` → 呼叫 `chrome.downloads.show(downloadId)`
- `{type:'open-wav', tabId:number, title:string, origin:string}` → 開啟舊的 `recorder.html?target=..&title=..&origin=..` 分頁（取代舊 onClicked 行為）

`Status` = `{state:'idle'|'starting'|'recording'|'saving'|'error', tabId?, title?, origin?, kbps?, songTitle?, artist?, seconds?, bytes?, peak?, peakHold?, clips?, last?:{filename, downloadId, seconds, bytes, silent}, error?:string}`

- `title`：面板與檔名使用的顯示名稱（見「檔名」）。`songTitle` / `artist`：來自頁面 Media Session 的歌名與演出者；找不到時為空字串（或未設定）。
- `last.silent`：`true` 表示整段錄音的 `peakHold < 1e-4`（約 -80 dBFS，全程無聲）。檔案仍會存檔；面板於「已存檔」卡片顯示警告。

### 背景 → 面板廣播

- `{type:'mp3-state', status: Status}`：狀態改變及錄音中每 250 ms 一次（面板未開時 sendMessage 會失敗，背景須 `.catch(()=>{})`）。

### 背景 → offscreen

- `{target:'offscreen', type:'start', streamId:string, kbps:number, title:string, artist?:string}` → 回應 `{ok:true, sampleRate}` 或 `{error}`；`title` 為歌名（無則分頁標題），`artist` 為演出者（可為空字串）
- `{target:'offscreen', type:'stop', title?:string, artist?:string}` → 回應 `{ok:true}`；之後 offscreen 送 `finished`。若帶 `title`／`artist`，覆蓋 start 時的值（ID3 於 offscreen 編碼時寫入，故停止時才得知的歌名仍會進入標籤）
- `{target:'offscreen', type:'cancel'}` → 回應 `{ok:true}`，丟棄
- `{target:'offscreen', type:'revoke', url:string}` → `URL.revokeObjectURL(url)`

### offscreen → 背景

- `{from:'offscreen', type:'level', seconds, bytes, peak, peakHold, clips}`：每 250 ms；`peak` 為此區間最大絕對樣本值（0..1+），`bytes` 為目前 MP3 位元組數。
- `{from:'offscreen', type:'finished', url:string /* blob: URL, audio/mpeg */, seconds, bytes, peakHold, reason:'stop'|'source-ended'|'limit'}`：`peakHold` 為整段錄音的最大絕對樣本值（真實 PCM，0..1+）；`0` 即全程無聲。
- `{from:'offscreen', type:'error', message:string}`（已自行釋放資源、丟棄）

背景收到 `finished` → `chrome.downloads.download({url, filename:'ClearAudio/'+safe+'.mp3', conflictAction:'uniquify', saveAs:false})` → 下載狀態完成（`chrome.downloads.onChanged` state complete/interrupted）或 60 秒後送 `revoke` 並 `chrome.offscreen.closeDocument()`。

## 檔名

背景先以 Media Session 決定名稱（`recordingName`）：有歌名時為 `<歌名> - <演出者>`（無演出者則僅歌名），否則為分頁標題。

### Media Session 讀取（`readMediaInfo(tabId)`，盡力而為）

- 以 `chrome.scripting.executeScript({target:{tabId}, func})` 讀取 `navigator.mediaSession.metadata` 的 `title`／`artist`／`album`，回傳 `{title, artist, album}` 或 `null`。
- 字串去頭尾空白並截為 200 字元；任何失敗（無權限、分頁已關閉、無 metadata）皆回傳 `null`，不影響錄音。
- 開始錄音（面板與 Alt+Shift+R）時讀一次；若開始時沒有歌名，停止錄音時（以及音軌結束時）再讀一次，取得即採用（`adoptMedia`）。

背景以 `mp3FileStem(title, date)` 產生：沿用 helpers.js `suggestedName` 的清理規則，去掉常見網站後綴（` | Suno` 等以 ` | ` 或 ` - ` 分隔的最後一段若為網站名可不處理，簡單即可），格式 `ClearAudio-<title>-<YYYYMMDD-HHMMSS>`（本地時間），不含副檔名。

## 編碼（代理 A，mp3.js，ES module，純函式可在 Node 測試）

- `floatToInt16(Float32Array) → Int16Array`（clamp -1..1，NaN→0）
- `deinterleave(Float32Array interleavedStereo) → [Float32Array L, Float32Array R]`
- `class Mp3Stream { constructor(lame /* lamejs 物件 */, sampleRate, kbps, {maxBytes = 200*1024*1024}={}); push(interleavedFloat32): void; get bytes; finish(): Uint8Array[] /* 含 flush */ }`，以 1152 frame 為單位餵入
- `id3v2Tags({title, artist}) → Uint8Array`：ID3v2.3 標籤，含 TIT2（歌名）與 TPE1（演出者），各為 UTF-16 with BOM；空白欄位省略，皆空則回傳空陣列。放在 MP3 最前面。
- `id3v2Title(title) → Uint8Array`：等同 `id3v2Tags({title})`，保留相容
- offscreen 以 `new Blob([id3v2Tags({title, artist}), ...chunks], {type:'audio/mpeg'})` 產生 URL

offscreen 擷取：`getUserMedia({audio:{mandatory:{chromeMediaSource:'tab', chromeMediaSourceId:streamId}}, video:false})`；`AudioContext`；source 同時接 `destination`（讓使用者仍聽得到）與 `AudioWorkletNode(ctx,'pcm')`（重用 `pcm-worklet.js`，輸出交錯 stereo Float32 `{pcm: ArrayBuffer}`，`'stop'` 後回 `{done:true}`）。音軌 `ended` → 自動以 reason `source-ended` 完成。
