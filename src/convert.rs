use std::{
    os::windows::process::CommandExt,
    path::Path,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicU8, Ordering},
        Arc,
    },
    time::Duration,
};
struct Encoder(std::process::Child);
impl Drop for Encoder {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
pub fn convert(
    ffmpeg: &str,
    input: &Path,
    output: &Path,
    quality: usize,
    stop: Arc<AtomicU8>,
) -> Result<String, String> {
    if !input.is_file() {
        return Err("找不到來源檔案".into());
    }
    if output.exists() {
        return Err("輸出檔已存在，請另取檔名（不覆寫）".into());
    }
    // Reserve output atomically. Encode into a sibling temporary file; preserve source on all paths.
    let reservation = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output)
        .map_err(|e| e.to_string())?;
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp = output.with_extension(format!("{}-{unique}.partial", std::process::id()));
    let log = output.with_extension(format!("{}-{unique}.log", std::process::id()));
    let mut own_temp = false;
    let mut own_log = false;
    let result = (|| -> Result<String, String> {
        let logfile = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&log)
            .map_err(|e| e.to_string())?;
        own_log = true;
        drop(
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)
                .map_err(|e| e.to_string())?,
        );
        own_temp = true;
        let mut cmd = Command::new(ffmpeg);
        cmd.args([
            "-hide_banner",
            "-nostdin",
            "-y",
            "-v",
            "error",
            "-threads",
            "1",
            "-protocol_whitelist",
            "file,pipe",
            "-i",
        ])
        .arg(input)
        .args(["-map", "0:a:0", "-vn", "-threads", "1"]);
        match quality {
            0 => {
                cmd.args(["-c:a", "libmp3lame", "-q:a", "2", "-f", "mp3"]);
            }
            1 => {
                cmd.args(["-c:a", "libmp3lame", "-b:a", "192k", "-f", "mp3"]);
            }
            2 => {
                cmd.args(["-c:a", "libmp3lame", "-b:a", "320k", "-f", "mp3"]);
            }
            _ => {
                cmd.args([
                    "-c:a",
                    "flac",
                    "-sample_fmt",
                    "s32",
                    "-bits_per_raw_sample",
                    "24",
                    "-compression_level",
                    "5",
                    "-f",
                    "flac",
                ]);
            }
        }
        let mut child = Encoder(
            cmd.arg(&temp)
                .stdout(Stdio::null())
                .stderr(Stdio::from(logfile))
                .creation_flags(0x08000000)
                .spawn()
                .map_err(|e| format!("FFmpeg 啟動失敗：{e}；請指定已安裝的 ffmpeg.exe"))?,
        );
        loop {
            if stop.load(Ordering::Relaxed) != 0 {
                let _ = child.0.kill();
                let _ = child.0.wait();
                return Err("已取消轉檔；來源保留".into());
            }
            match child.0.try_wait().map_err(|e| e.to_string())? {
                Some(s) if s.success() => break,
                Some(_) => {
                    return Err(format!(
                        "FFmpeg 失敗：{}",
                        std::fs::read_to_string(&log)
                            .unwrap_or_default()
                            .chars()
                            .take(1500)
                            .collect::<String>()
                    ))
                }
                None => std::thread::sleep(Duration::from_millis(80)),
            }
        }
        drop(reservation);
        // Windows rename does not overwrite the reserved destination. Remove only our empty reservation.
        std::fs::remove_file(output).map_err(|e| e.to_string())?;
        std::fs::rename(&temp, output).map_err(|e| e.to_string())?;
        Ok(format!("轉檔完成：{}；原始來源保留", output.display()))
    })();
    if result.is_err() {
        if own_temp {
            let _ = std::fs::remove_file(&temp);
        }
        if output.metadata().map(|m| m.len() == 0).unwrap_or(false) {
            let _ = std::fs::remove_file(output);
        }
    }
    if own_log {
        let _ = std::fs::remove_file(log);
    }
    result
}
