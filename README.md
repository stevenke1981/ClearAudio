# ClearAudio

輕量 Windows Rust / Win32 音訊工作台，以及需使用者明示授權的 Chrome / Edge 分頁錄音擴充。沒有麥克風錄音、畫面錄影、整機音訊 fallback、帳號登入或背景常駐服務。

## 功能與目前狀態

| 模式 | 實作 | 驗證程度 |
|---|---|---|
| 指定應用程式 | Windows process-loopback，包含指定 PID 與子程序，保存 float PCM WAV | API 生命週期測過；非靜音與跨程序隔離尚待有播放端點的互動桌面驗收 |
| 分頁一鍵 MP3 | 點擴充圖示 →「● 錄成 MP3」，offscreen 擷取＋lamejs 編碼，停止後自動存到「下載/ClearAudio/」 | 真實 lamejs 編碼測試＋mock 生命週期；未完成真實瀏覽器授權驗收 |
| 分頁無損 WAV | 面板「進階：錄成無損 WAV」開控制台，float PCM WAV | 自產 PCM／mock 生命週期測試通過；未完成真實授權驗收 |
| MP3 / FLAC 另存 | 外部 FFmpeg，VBR q2／CBR192／CBR320／FLAC 24-bit | 自產音訊轉檔、解碼、取消與來源保留已驗證 |

Rust GUI 版本 0.5.0；分頁擴充版本 0.5.0。介面設計規格見 [DESIGN-INTENT.md](DESIGN-INTENT.md)（依 [ui-visual-design](https://github.com/stevenke1981/ui-visual-design) skill）。此 repository 先提供來源，不發布未驗收錄音能力的 binary Release。只用於你有權保存、且來源服務允許錄製的音訊，不提供繞過 DRM、付費或下載限制的功能。

## 原生程式

Windows x64 build 20348+，建議 Windows 11。建置後執行 `clear-audio.exe`：

1. 選應用程式及 PID，選擇新的 WAV 儲存位置，按「開始錄音」。
2. 錄音卡顯示 dB 刻度電平、峰值保持標記與近 12 秒實際峰值歷史（每個擷取回報一格，靜音不畫）。「停止保存」保留 WAV；「取消工作」丟棄本次錄音。錄音在 worker 執行。
3. 從「本次檔案」選檔或匯入音訊，選 MP3 品質／FLAC，按「另存轉檔」。轉檔中可取消；既有目的檔拒絕覆寫，來源保留。
4. FFmpeg 不綑綁、不自動安裝；使用 PATH 中的 `ffmpeg.exe`，或在「編碼器設定」選取你已有的 executable。

Chrome / Edge PID **不是單一分頁**，程序樹可能包含其他分頁。需要單分頁請用下列擴充流程。

## 分頁錄音：一鍵 MP3

需使用者同意後自行安裝：在 Chrome / Edge 擴充管理頁開啟開發人員模式，載入 `extension`。權限 `activeTab`、`tabCapture`、`offscreen`、`downloads`、`scripting`（只在你點擊後讀取該分頁的媒體資訊 navigator.mediaSession，以取得歌名／演出者）；無網站存取權、native messaging、登錄檔修改、localhost 服務或音訊上傳。Chrome 116+／相容 Edge。

1. 在正在播放的分頁點擴充圖示，面板顯示來源標題與 origin；選 MP3 128／192／320 kbps（記住上次選擇）。
2. 按「● 錄成 MP3」（或 Alt+Shift+R 直接開始／停止）。可關閉面板，錄音在背景 offscreen 頁持續；圖示顯示 REC；你仍聽得到分頁聲音。
3. 再開面板按「■ 停止並存 MP3」，檔案自動存到「下載/ClearAudio/<歌名> - <演出者>.mp3」，歌名取自網頁提供給系統媒體控制的資訊（navigator.mediaSession；同名時 Chrome 自動加 (1)），並寫入 ID3 標題／演出者；網站未提供時改用「<分頁標題>-<時間>.mp3」。全程無聲的錄音仍會保存，但面板會提醒，可「在資料夾中顯示」。來源分頁關閉會自動停止並保存；「取消（不保存）」丟棄。
4. MP3 為錄下的聲音再編碼（有損），非網站原檔。自己在 Suno 等服務生成的歌，優先用該服務的官方下載取得原檔。本擴充不抓網站串流檔、不繞過下載限制。

## 分頁錄音：無損 WAV（進階）

1. 在來源分頁點擴充圖示，按面板底部「進階：錄成無損 WAV」開啟控制台，顯示選定分頁名稱及網站 origin。
2. 確認來源，按「選擇 WAV 並開始」。建議檔名含分頁名稱與 UTC 時間。已有內容的檔案會拒絕寫入；選檔器可能建立空檔，取消後該空檔可能保留。
3. 保持控制台開啟。音量計（dB 刻度，−6 dBFS 以上轉琥珀、滿刻度轉紅）、近 30 秒峰值歷史、峰值保持、削波次數皆來自真實 PCM peak，不是假波形；錄音中來源分頁的擴充圖示顯示 REC 徽章。快捷鍵 Alt+R 開始、Alt+S 停止保存、Alt+X 取消。本次已保存的檔案列於「本次已保存」（只存記憶體）。停止會補標頭並提交；取消會 abort。來源結束會嘗試保存；裝置中斷或寫入失敗會停止、丟棄未提交資料並顯示錯誤。
4. Rust GUI 切「分頁 WAV 匯入」，選剛才的 WAV，另存 MP3。沒有自動瀏覽器→原生 App 交接。

檔名與來源名稱可能是私人資訊，請自行決定儲存位置。擴充僅傳遞來源 origin，不把原頁完整 URL query 複製到控制台。不得在其他程式同時編輯所選目的檔；File System Access 選檔流程沒有跨外部程式的原子 create-new 保證。

## 音質與限制

WAV 是「無額外有損編碼」，不代表網站原始音源無損或 bit-perfect。網站可能已使用 AAC／MP3，Windows／Web Audio 可能混音與重採樣。程序 WAV 為 48 kHz、stereo、float32；分頁 WAV 保留 AudioContext 的實際取樣率。

FLAC 轉檔會把 float 量化至 24-bit 整數，不與 float 原樣本完全等價；WAV 原檔保留。MP3 為有損副本。無 RF64 或自動分段；WAV 接近 4 GB 會停止。磁碟故障、程序崩潰、強制關閉或斷電可能造成資料損失。

目前測試工作階段沒有播放端點，預設端點 API 回傳 `0x80070490`，因此不宣稱非靜音錄音通過。來源關閉、裝置切換、長時間與磁碟故障的真實驗收見 [MANUAL-TESTS.md](MANUAL-TESTS.md)。

## 建置與測試

Rust 1.88+、Windows linker；已使用 Rust 1.99.0 GNU x64 測試。windows/windows-core 0.58；沒有 WebView / Electron。JavaScript 測試使用 Node.js，不安裝 npm dependencies。

```powershell
cargo fmt --check
cargo test --offline -j 1
cargo clippy --offline -j 1 --all-targets -- -D warnings
cargo build --release --offline -j 1
node --test extension/*.test.js
```

`--offline` 需要既有 Cargo cache；初次建置需自行取得相依套件。`--verify <新輸出資料夾> <FFmpeg 路徑>` 會嘗試本 App 自產測試音與自己的 PID capture，只能在明確同意測試播放後執行。一般 JS tests 不啟動真實捕捉。

## 官方參考

- [Microsoft process-loopback sample](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/)
- [Chrome tabCapture：明示授權、targetTabId、consumerTabId](https://developer.chrome.com/docs/extensions/reference/api/tabCapture)
- [File System Access 寫入提交機制](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createWritable)

本專案程式碼以 [MIT](LICENSE) 授權。內附的 `extension/vendor/lame.min.js`（lamejs）維持其 LGPL-3.0 授權，其他第三方授權見 [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt)。不包含 FFmpeg、瀏覽器、音訊成品或私人 credentials。
