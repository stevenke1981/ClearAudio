//! Explicit self-test only: captures this executable's own generated tone, never a user process.
use std::{
    io::Write,
    path::Path,
    sync::{atomic::AtomicU8, mpsc, Arc},
    time::Duration,
};
pub fn run(dir: &Path, ffmpeg: &str) {
    std::fs::create_dir_all(dir).unwrap();
    let mut report = String::new();
    let tone = dir.join("own-tone.wav");
    let mut b = Vec::new();
    b.extend(b"RIFF");
    b.extend((36 + 96000u32).to_le_bytes());
    b.extend(b"WAVEfmt ");
    b.extend(16u32.to_le_bytes());
    b.extend(1u16.to_le_bytes());
    b.extend(1u16.to_le_bytes());
    b.extend(48000u32.to_le_bytes());
    b.extend(96000u32.to_le_bytes());
    b.extend(2u16.to_le_bytes());
    b.extend(16u16.to_le_bytes());
    b.extend(b"data");
    b.extend(96000u32.to_le_bytes());
    for i in 0..48000 {
        b.extend(
            (((i as f32 * 440. * std::f32::consts::TAU / 48000.).sin() * 3276.) as i16)
                .to_le_bytes(),
        );
    }
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tone)
        .and_then(|mut f| f.write_all(&b))
    {
        Ok(_) => {}
        Err(e) => {
            std::fs::write(
                dir.join("report.txt"),
                format!("Fresh output directory required: {e}"),
            )
            .unwrap();
            return;
        }
    }
    let (tone_stop, tone_thread, ready) = crate::test_tone::start();
    let played = ready.recv_timeout(Duration::from_secs(5));
    report += &format!("Own WASAPI synthetic 440 Hz renderer: {played:?}\n");
    let captured = dir.join("own-capture.wav");
    let (tx, _rx) = mpsc::channel();
    let result = crate::capture::record(
        std::process::id(),
        crate::capture::identity(std::process::id()).unwrap(),
        &captured,
        Arc::new(AtomicU8::new(0)),
        tx,
        Some(Duration::from_secs(2)),
    );
    let meters: Vec<String> = _rx
        .try_iter()
        .filter(|m| m.starts_with("@meter|"))
        .collect();
    report += &format!(
        "Actual capture meter events: {}; last={:?}\n",
        meters.len(),
        meters.last()
    );
    tone_stop.store(true, std::sync::atomic::Ordering::Relaxed);
    report += &format!("Renderer stopped: {:?}\n", tone_thread.join());
    report += &format!("Process-loopback self capture: {result:?}\n");
    if let Ok(data) = std::fs::read(&captured) {
        let samples: Vec<f32> = data[56..]
            .as_chunks::<4>()
            .0
            .iter()
            .map(|b| f32::from_le_bytes(*b))
            .collect();
        let peak = samples.iter().copied().map(f32::abs).fold(0f32, f32::max);
        let rms = (samples.iter().map(|&s| (s as f64).powi(2)).sum::<f64>()
            / samples.len().max(1) as f64)
            .sqrt();
        report += &format!(
            "Captured float samples={}, peak={peak:.6}, rms={rms:.6}, nonzero={}\n",
            samples.len(),
            peak > 0.001
        );
    }
    for (q, name) in [
        (0, "vbr.mp3"),
        (1, "192.mp3"),
        (2, "320.mp3"),
        (3, "test.flac"),
    ] {
        let result = crate::convert::convert(
            ffmpeg,
            &tone,
            &dir.join(name),
            q,
            Arc::new(AtomicU8::new(0)),
        );
        report += &format!("Convert {name}: {result:?}\n");
    }
    let result = crate::convert::convert(
        ffmpeg,
        &tone,
        &dir.join("cancelled.mp3"),
        0,
        Arc::new(AtomicU8::new(2)),
    );
    report += &format!(
        "Cancel conversion: {result:?}; removed={}\n",
        !dir.join("cancelled.mp3").exists()
    );
    let result = crate::convert::convert(
        "missing-clear-audio-ffmpeg.exe",
        &tone,
        &dir.join("failure.mp3"),
        0,
        Arc::new(AtomicU8::new(0)),
    );
    report += &format!(
        "Missing encoder: {result:?}; removed={}\n",
        !dir.join("failure.mp3").exists()
    );
    let before = std::fs::read(dir.join("192.mp3")).ok();
    let result = crate::convert::convert(
        ffmpeg,
        &tone,
        &dir.join("192.mp3"),
        1,
        Arc::new(AtomicU8::new(0)),
    );
    report += &format!(
        "Reject overwrite: {result:?}; unchanged={}\n",
        before == std::fs::read(dir.join("192.mp3")).ok()
    );
    let cancelled = dir.join("cancel-capture.wav");
    let (tx, _rx) = mpsc::channel();
    let result = crate::capture::record(
        std::process::id(),
        crate::capture::identity(std::process::id()).unwrap(),
        &cancelled,
        Arc::new(AtomicU8::new(2)),
        tx,
        Some(Duration::from_millis(50)),
    );
    report += &format!(
        "Cancel capture: {result:?}; removed={}\n",
        !cancelled.exists()
    );
    report += &format!(
        "Source preserved: {}\n",
        std::fs::read(tone).map(|x| x == b).unwrap_or(false)
    );
    std::fs::write(dir.join("report.txt"), report).unwrap();
}
