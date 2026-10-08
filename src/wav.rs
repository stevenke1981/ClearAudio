use std::{
    fs::{File, OpenOptions},
    io::{self, Seek, SeekFrom, Write},
    path::Path,
};

// IEEE float WAV: preserve the exact float samples delivered by WASAPI/Web Audio.
pub struct Wav {
    file: File,
    bytes: u32,
}
pub fn header(bytes: u32) -> Vec<u8> {
    let mut h = Vec::new();
    h.extend(b"RIFF");
    h.extend((bytes + 48).to_le_bytes());
    h.extend(b"WAVEfmt ");
    h.extend(16u32.to_le_bytes());
    h.extend(3u16.to_le_bytes());
    h.extend(2u16.to_le_bytes());
    h.extend(48000u32.to_le_bytes());
    h.extend(384000u32.to_le_bytes());
    h.extend(8u16.to_le_bytes());
    h.extend(32u16.to_le_bytes());
    h.extend(b"fact");
    h.extend(4u32.to_le_bytes());
    h.extend((bytes / 8).to_le_bytes());
    h.extend(b"data");
    h.extend(bytes.to_le_bytes());
    h
}
impl Wav {
    pub fn create(path: &Path) -> io::Result<Self> {
        let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
        file.write_all(&header(0))?;
        Ok(Self { file, bytes: 0 })
    }
    pub fn write(&mut self, bytes: &[u8]) -> io::Result<()> {
        if !bytes.len().is_multiple_of(8) || self.bytes as u64 + bytes.len() as u64 > 0xffff0000 {
            return Err(io::Error::other("WAV 已達 4 GB 限制，請另開新錄音"));
        }
        self.file.write_all(bytes)?;
        self.bytes += bytes.len() as u32;
        Ok(())
    }
    pub fn finish(&mut self) -> io::Result<()> {
        self.file.seek(SeekFrom::Start(0))?;
        self.file.write_all(&header(self.bytes))?;
        self.file.sync_all()
    }
}
impl Drop for Wav {
    fn drop(&mut self) {
        let _ = self.finish();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn riff_sizes_and_float_format() {
        let h = header(384000);
        assert_eq!(h.len(), 56);
        assert_eq!(u32::from_le_bytes(h[4..8].try_into().unwrap()), 384048);
        assert_eq!(&h[20..24], &[3, 0, 2, 0]);
        assert_eq!(u32::from_le_bytes(h[44..48].try_into().unwrap()), 48000);
    }
    #[test]
    fn never_overwrite_and_preserve_samples() {
        let p = std::env::temp_dir().join(format!("clear-audio-test-{}.wav", std::process::id()));
        let mut w = Wav::create(&p).unwrap();
        assert!(Wav::create(&p).is_err());
        let b = [0.125f32.to_le_bytes(), (-0.25f32).to_le_bytes()].concat();
        w.write(&b).unwrap();
        w.finish().unwrap();
        drop(w);
        assert_eq!(&std::fs::read(&p).unwrap()[56..], b);
        std::fs::remove_file(p).unwrap();
    }
    #[test]
    fn reject_incomplete_frames_and_riff_overflow() {
        let p = std::env::temp_dir().join(format!("clear-audio-bounds-{}.wav", std::process::id()));
        let mut w = Wav::create(&p).unwrap();
        assert!(w.write(&[0; 7]).is_err());
        w.bytes = 0xffff0000;
        assert!(w.write(&[0; 8]).is_err());
        w.bytes = 0;
        drop(w);
        std::fs::remove_file(p).unwrap();
    }
}
