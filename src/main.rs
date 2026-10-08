#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod capture;
mod convert;
mod snapshot;
mod test_tone;
mod ui;
mod verify;
mod wav;
use std::{
    path::PathBuf,
    sync::{atomic::AtomicU8, mpsc, Arc},
    time::Duration,
};
fn main() -> windows::core::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("--verify") => verify::run(
            &PathBuf::from(args.get(2).expect("output directory")),
            args.get(3).expect("FFmpeg path"),
        ),
        Some("--synthetic") => {
            let mut out =
                wav::Wav::create(&PathBuf::from(args.get(2).expect("output WAV"))).unwrap();
            for i in 0..48000 {
                let v = (i as f32 * 440. * std::f32::consts::TAU / 48000.).sin() * 0.1;
                out.write(&[v.to_le_bytes(), v.to_le_bytes()].concat())
                    .unwrap();
            }
            out.finish().unwrap();
        }
        Some("--self-capture") => {
            let path = PathBuf::from(args.get(2).expect("output WAV"));
            let (tx, _) = mpsc::channel();
            let result = capture::record(
                std::process::id(),
                capture::identity(std::process::id()).unwrap(),
                &path,
                Arc::new(AtomicU8::new(0)),
                tx,
                Some(Duration::from_secs(2)),
            );
            std::fs::write(path.with_extension("result.txt"), format!("{result:?}")).unwrap();
        }
        _ => ui::run(&args)?,
    }
    Ok(())
}
