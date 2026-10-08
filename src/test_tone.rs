//! WASAPI renderer used only by the explicitly requested local self-test.
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::Duration,
};
use windows::Win32::{Media::Audio::*, System::Com::*};
type ToneSession = (
    Arc<AtomicBool>,
    std::thread::JoinHandle<Result<(), String>>,
    mpsc::Receiver<Result<(), String>>,
);
pub fn start() -> ToneSession {
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    let (tx, rx) = mpsc::channel();
    let handle = std::thread::spawn(move || unsafe {
        let mut stage = "CoInitializeEx";
        let result = (|| -> windows::core::Result<()> {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
            stage = "CoCreateInstance(MMDeviceEnumerator)";
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            stage = "GetDefaultAudioEndpoint(eRender, eConsole)";
            let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
            stage = "Activate/Initialize renderer";
            let client: IAudioClient = device.Activate(CLSCTX_ALL, None)?;
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
                AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
                1000000,
                0,
                &format,
                None,
            )?;
            stage = "GetService/Start renderer";
            let render: IAudioRenderClient = client.GetService()?;
            let size = client.GetBufferSize()?;
            let mut index = 0u64;
            client.Start()?;
            let _ = tx.send(Ok(()));
            stage = "Render loop";
            while !flag.load(Ordering::Relaxed) {
                let available = size - client.GetCurrentPadding()?;
                if available > 0 {
                    let buffer = render.GetBuffer(available)?;
                    let samples = std::slice::from_raw_parts_mut(
                        buffer.cast::<f32>(),
                        available as usize * 2,
                    );
                    for frame in samples.as_chunks_mut::<2>().0 {
                        let v = (index as f64 * 440. * std::f64::consts::TAU / 48000.).sin() as f32
                            * 0.1;
                        frame[0] = v;
                        frame[1] = v;
                        index += 1;
                    }
                    render.ReleaseBuffer(available, 0)?;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            client.Stop()?;
            Ok(())
        })()
        .map_err(|e| format!("{stage}: {e}"));
        if let Err(e) = &result {
            let _ = tx.send(Err(e.clone()));
        }
        CoUninitialize();
        result
    });
    (stop, handle, rx)
}
