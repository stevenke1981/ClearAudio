//! Internal GUI smoke test. Renders only this app's own HWND; no desktop capture or input injection.
use std::{io::Write, path::Path};
use windows::Win32::{Foundation::*, Graphics::Gdi::*, UI::WindowsAndMessaging::*};
#[link(name = "user32")]
extern "system" {
    fn PrintWindow(hwnd: HWND, dc: HDC, flags: u32) -> BOOL;
}
pub unsafe fn save(hwnd: HWND, path: &Path) -> std::io::Result<()> {
    let mut rect = RECT::default();
    GetWindowRect(hwnd, &mut rect).map_err(std::io::Error::other)?;
    let (w, h) = (rect.right - rect.left, rect.bottom - rect.top);
    let dc = GetDC(hwnd);
    let mem = CreateCompatibleDC(dc);
    let bmp = CreateCompatibleBitmap(dc, w, h);
    let old = SelectObject(mem, bmp);
    let printed = PrintWindow(hwnd, mem, 0);
    // WM_PRINT renders this window and its child controls, even without an active DWM surface.
    SendMessageW(
        hwnd,
        WM_PRINT,
        WPARAM(mem.0 as usize),
        LPARAM((PRF_CLIENT | PRF_NONCLIENT | PRF_CHILDREN | PRF_ERASEBKGND) as isize),
    );
    SelectObject(mem, old);
    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: 40,
            biWidth: w,
            biHeight: -h,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut pixels = vec![0u8; (w * h * 4) as usize];
    let lines = GetDIBits(
        dc,
        bmp,
        0,
        h as u32,
        Some(pixels.as_mut_ptr().cast()),
        &mut info,
        DIB_RGB_COLORS,
    );
    let _ = DeleteObject(bmp);
    let _ = DeleteDC(mem);
    ReleaseDC(hwnd, dc);
    if !printed.as_bool() || lines != h {
        return Err(std::io::Error::other("Own-window render failed"));
    }
    let mut out = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    out.write_all(b"BM")?;
    out.write_all(&(54 + pixels.len() as u32).to_le_bytes())?;
    out.write_all(&[0; 4])?;
    out.write_all(&54u32.to_le_bytes())?;
    let raw = std::slice::from_raw_parts(
        (&info.bmiHeader as *const BITMAPINFOHEADER).cast::<u8>(),
        40,
    );
    out.write_all(raw)?;
    out.write_all(&pixels)?;
    Ok(())
}
