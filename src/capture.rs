use crate::wav::Wav;
use std::{
    path::Path,
    sync::{
        atomic::{AtomicU8, Ordering},
        mpsc, Arc,
    },
    time::{Duration, Instant},
};
use windows::{
    core::{implement, Interface, HRESULT, PCWSTR, PROPVARIANT},
    Win32::{
        Foundation::*,
        Media::Audio::*,
        System::{Com::*, Threading::*},
    },
};

#[implement(IActivateAudioInterfaceCompletionHandler)]
struct Completion(mpsc::Sender<()>);
impl IActivateAudioInterfaceCompletionHandler_Impl for Completion_Impl {
    fn ActivateCompleted(
        &self,
        _: Option<&IActivateAudioInterfaceAsyncOperation>,
    ) -> windows::core::Result<()> {
        let _ = self.0.send(());
        Ok(())
    }
}
struct Com;
impl Drop for Com {
    fn drop(&mut self) {
        unsafe { CoUninitialize() }
    }
}
struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}
struct Running(IAudioClient);
impl Drop for Running {
    fn drop(&mut self) {
        unsafe {
            let _ = self.0.Stop();
        }
    }
}

pub fn identity(pid: u32) -> Option<u64> {
    unsafe {
        let h = Handle(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?);
        process_time(h.0).ok()
    }
}
unsafe fn process_time(h: HANDLE) -> windows::core::Result<u64> {
    let (mut created, mut exited, mut kernel, mut user) = (
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
    );
    GetProcessTimes(h, &mut created, &mut exited, &mut kernel, &mut user)?;
    Ok(((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64)
}

pub fn record(
    pid: u32,
    expected: u64,
    path: &Path,
    stop: Arc<AtomicU8>,
    tx: mpsc::Sender<String>,
    limit: Option<Duration>,
) -> Result<String, String> {
    unsafe { record_inner(pid, expected, path, stop, tx, limit) }.map_err(|e| e.to_string())
}
unsafe fn record_inner(
    pid: u32,
    expected: u64,
    path: &Path,
    stop: Arc<AtomicU8>,
    tx: mpsc::Sender<String>,
    limit: Option<Duration>,
) -> Result<String, Box<dyn std::error::Error>> {
    CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
    let _com = Com;
    let process = Handle(OpenProcess(
        PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
        false,
        pid,
    )?);
    if process_time(process.0)? != expected || WaitForSingleObject(process.0, 0) == WAIT_OBJECT_0 {
        return Err("來源已結束或 PID 已重用；請重新整理並選擇來源".into());
    }
    let params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: pid,
                ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
            },
        },
    };
    // ABI of VT_BLOB PROPVARIANT. Borrowed stack blob; never PropVariantClear it.
    #[repr(C)]
    struct BlobVariant {
        vt: u16,
        reserved: [u16; 3],
        size: u32,
        data: *const AUDIOCLIENT_ACTIVATION_PARAMS,
    }
    let variant = BlobVariant {
        vt: 65,
        reserved: [0; 3],
        size: std::mem::size_of_val(&params) as u32,
        data: &params,
    };
    assert_eq!(
        std::mem::size_of::<BlobVariant>(),
        std::mem::size_of::<PROPVARIANT>()
    );
    let (done, rx) = mpsc::channel();
    let callback: IActivateAudioInterfaceCompletionHandler = Completion(done).into();
    let device: Vec<u16> = "VAD\\Process_Loopback\0".encode_utf16().collect();
    let operation = ActivateAudioInterfaceAsync(
        PCWSTR(device.as_ptr()),
        &IAudioClient::IID,
        Some((&variant as *const BlobVariant).cast()),
        &callback,
    )?;
    rx.recv_timeout(Duration::from_secs(10))?;
    let mut hr = HRESULT(0);
    let mut unknown = None;
    operation.GetActivateResult(&mut hr, &mut unknown)?;
    hr.ok()?;
    let client: IAudioClient = unknown.ok_or("沒有音訊介面")?.cast()?;
    let format = WAVEFORMATEX {
        wFormatTag: 3,
        nChannels: 2,
        nSamplesPerSec: 48000,
        nAvgBytesPerSec: 384000,
        nBlockAlign: 8,
        wBitsPerSample: 32,
        cbSize: 0,
    };
    client.Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
        200000,
        0,
        &format,
        None,
    )?;
    let capture: IAudioCaptureClient = client.GetService()?;
    let mut wav = Wav::create(path)?;
    if stop.load(Ordering::Relaxed) == 0 {
        client.Start()?;
    }
    let _running = Running(client);
    let _ = tx.send(format!(
        "● 錄音中 — PID {pid} 與子程序；48 kHz / float32 / stereo"
    ));
    let start = Instant::now();
    let mut last = Instant::now();
    let mut frames = 0u64;
    let mut gaps = 0;
    let mut peak = 0f32;
    let mut interval_peak = 0f32;
    let mut meter_at = Instant::now();
    let mut reason = "已停止";
    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        while stop.load(Ordering::Relaxed) == 0
            && limit.map(|d| start.elapsed() < d).unwrap_or(true)
        {
            if WaitForSingleObject(process.0, 0) == WAIT_OBJECT_0 {
                reason = "來源已關閉";
                break;
            }
            while stop.load(Ordering::Relaxed) == 0 && capture.GetNextPacketSize()? > 0 {
                let mut data = std::ptr::null_mut();
                let mut n = 0;
                let mut flags = 0;
                capture.GetBuffer(&mut data, &mut n, &mut flags, None, None)?;
                if n == 0 {
                    capture.ReleaseBuffer(0)?;
                    break;
                }
                if data.is_null() && flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 == 0 {
                    let _ = capture.ReleaseBuffer(n);
                    return Err("音訊 API 傳回空資料指標".into());
                }
                let write = if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 {
                    wav.write(&vec![0; n as usize * 8])
                } else {
                    let bytes = std::slice::from_raw_parts(data, n as usize * 8);
                    for sample in bytes.as_chunks::<4>().0 {
                        let sample_peak = f32::from_le_bytes(*sample).abs();
                        peak = peak.max(sample_peak);
                        interval_peak = interval_peak.max(sample_peak);
                    }
                    wav.write(bytes)
                };
                let release = capture.ReleaseBuffer(n);
                write?;
                release?;
                frames += n as u64;
                if flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32 != 0 {
                    gaps += 1;
                }
            }
            if meter_at.elapsed() >= Duration::from_millis(100) {
                let _ = tx.send(format!(
                    "@meter|{}|{}|{}|{}",
                    start.elapsed().as_secs_f64(),
                    frames * 8,
                    interval_peak,
                    gaps
                ));
                interval_peak = 0.;
                meter_at = Instant::now();
            }
            if last.elapsed() >= Duration::from_millis(500) {
                let _ = tx.send(format!(
                    "● 錄音中 PID {pid} | {:.1} 秒 | {:.1} MB | 不連續封包 {gaps}",
                    start.elapsed().as_secs_f64(),
                    frames as f64 * 8. / 1e6
                ));
                last = Instant::now();
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        Ok(())
    })();
    let finalized = wav.finish();
    drop(wav);
    if stop.load(Ordering::Relaxed) == 2 {
        std::fs::remove_file(path)?;
        return Ok("已取消，錄音檔已刪除".into());
    }
    finalized?;
    result.map_err(|e| {
        format!("錄音中止，已保留可讀的部分 WAV：{e}。請重新選擇來源／裝置後開始。")
    })?;
    let note = if peak <= 0.0000001 {
        "；未偵測到非靜音訊號，請確認來源正在播放且有可用音訊端點"
    } else {
        ""
    };
    Ok(format!(
        "{reason}：{}（{} frames，不連續封包 {gaps}，峰值 {peak:.4}）{note}",
        path.display(),
        frames
    ))
}
