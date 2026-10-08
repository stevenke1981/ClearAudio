//! Native DPI-aware recording workspace; custom GDI surfaces with real keyboard-accessible controls.
//! Visual language follows DESIGN-INTENT.md (Apple-style light tokens): grouped background, white
//! cards with a hairline separator, capsule buttons, and a light sidebar.
use crate::{capture, convert};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicU8, Ordering},
        mpsc, Arc,
    },
    time::Instant,
};
use windows::{
    core::*,
    Win32::{
        Foundation::*,
        Graphics::Gdi::*,
        System::{Diagnostics::ToolHelp::*, LibraryLoader::*},
        UI::{
            Controls::{Dialogs::*, *},
            HiDpi::*,
            Input::KeyboardAndMouse::*,
            WindowsAndMessaging::*,
        },
    },
};
const APP: usize = 10;
const IMPORT_MODE: usize = 11;
const SOURCES: usize = 12;
const REFRESH: usize = 13;
const DEST: usize = 14;
const START: usize = 15;
const STOP: usize = 16;
const CANCEL: usize = 17;
const FILES: usize = 18;
const INPUT: usize = 19;
const QUALITY: usize = 20;
const EXPORT: usize = 21;
const ENCODER: usize = 22;
const HELP: usize = 23;
const DETAILS: usize = 24;
// Light tokens (DESIGN-INTENT.md, light column).
const BG: u32 = 0xf2f2f7; // grouped background
const WHITE: u32 = 0xffffff; // card surface
const SEP: u32 = 0xe0e0e5; // 1px hairline card border
const WELL: u32 = 0xe9e9ee; // tracks, wells, secondary fill, sidebar
const INK: u32 = 0x1d1d1f; // primary text
const MUTED: u32 = 0x6e6e73; // secondary text
const SIDE_MUTED: u32 = 0x636366; // secondary text on the sidebar well (6E6E73 is 4.19:1 there)
const BRAND: u32 = 0x146e59; // brand, links, focus
const DANGER: u32 = 0xc4141c; // recording, errors, destructive
const DISABLED: u32 = 0x8e8e93; // disabled text (exempt from contrast rules)
const METER_OK: u32 = 0x248a3d;
const METER_WARN: u32 = 0xb25000;
const METER_CLIP: u32 = 0xc4141c;
const PEAK: u32 = 0x1d1d1f; // peak-hold marker
const RECORD_H: i32 = 336;
const HISTORY: usize = 120;
fn color(rgb: u32) -> COLORREF {
    COLORREF(((rgb & 255) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 255))
}
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}
unsafe fn set(h: HWND, s: &str) {
    let _ = SetWindowTextW(h, PCWSTR(wide(s).as_ptr()));
}
unsafe fn text(h: HWND) -> String {
    let mut b = vec![0; GetWindowTextLengthW(h) as usize + 1];
    let n = GetWindowTextW(h, &mut b);
    String::from_utf16_lossy(&b[..n as usize])
}
#[derive(Clone, Copy, Debug, PartialEq)]
enum Job {
    Idle,
    Recording,
    Converting,
    Stopping,
}
#[derive(Clone, Copy, Debug, Default)]
struct Area {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}
impl Area {
    fn new(x: i32, y: i32, w: i32, h: i32) -> Self {
        Self { x, y, w, h }
    }
}
#[derive(Clone, Copy)]
struct Layout {
    main: Area,
    source: Area,
    record: Area,
    files: Area,
    export: Area,
    height: i32,
    sidebar: bool,
}
fn layout(width: i32) -> Layout {
    let sidebar = width >= 1040;
    let x = if sidebar { 208 } else { 24 };
    let w = (width - x - 24).max(480);
    let split = w >= 840;
    let left = if split { w - 304 } else { w };
    let source = Area::new(x, 128, left, 200);
    let record = Area::new(x, 344, left, RECORD_H);
    let below = record.y + record.h + 16;
    let files = if split {
        Area::new(x + left + 16, 128, 288, 480)
    } else {
        Area::new(x, below, w, 224)
    };
    let export = Area::new(
        x,
        if split { below } else { files.y + files.h + 16 },
        w,
        280,
    );
    Layout {
        main: Area::new(x, 0, w, 0),
        source,
        record,
        files,
        export,
        height: export.y + export.h + 120,
        sidebar,
    }
}
enum Event {
    Capture(String),
    Done(std::result::Result<String, String>, PathBuf, bool),
}
struct Source {
    pid: u32,
    created: u64,
    name: String,
}
struct State {
    controls: BTreeMap<usize, HWND>,
    rects: BTreeMap<usize, Area>,
    sources: Vec<Source>,
    files: Vec<PathBuf>,
    dpi: u32,
    scroll: i32,
    width: i32,
    height: i32,
    fonts: [HFONT; 5],
    brush: HBRUSH,
    import: bool,
    job: Job,
    rx: Option<mpsc::Receiver<Event>>,
    stop: Arc<AtomicU8>,
    started: Instant,
    elapsed: f64,
    peak: f32,
    meter: Meter,
    bytes: u64,
    gaps: u32,
    status: String,
    error: bool,
    destination: Option<PathBuf>,
    input: Option<PathBuf>,
    ffmpeg: String,
    preview: bool,
}
impl Drop for State {
    fn drop(&mut self) {
        unsafe {
            for f in self.fonts {
                let _ = DeleteObject(f);
            }
            let _ = DeleteObject(self.brush);
        }
    }
}
impl State {
    fn px(&self, n: i32) -> i32 {
        ((n as i64 * self.dpi as i64 + 48) / 96) as i32
    }
    fn rect(&self, a: Area) -> RECT {
        RECT {
            left: self.px(a.x),
            top: self.px(a.y - self.scroll),
            right: self.px(a.x + a.w),
            bottom: self.px(a.y + a.h - self.scroll),
        }
    }
    fn h(&self, id: usize) -> HWND {
        self.controls[&id]
    }
    fn busy(&self) -> bool {
        self.job != Job::Idle
    }
}
unsafe fn fonts(dpi: u32) -> [HFONT; 5] {
    // (size at 96 DPI, weight, face): 0 body, 1 caption, 2 heading, 3 timer, 4 semibold label.
    [
        (15, 400, w!("Microsoft JhengHei UI")),
        (13, 400, w!("Microsoft JhengHei UI")),
        (24, 600, w!("Microsoft JhengHei UI")),
        (56, 300, w!("Segoe UI Light")),
        (16, 600, w!("Microsoft JhengHei UI")),
    ]
    .map(|(size, weight, face)| {
        CreateFontW(
            -(size * dpi as i32 / 96),
            0,
            0,
            0,
            weight,
            0,
            0,
            0,
            DEFAULT_CHARSET.0 as u32,
            0,
            0,
            CLEARTYPE_QUALITY.0 as u32,
            0,
            face,
        )
    })
}
unsafe fn label(dc: HDC, s: &State, a: Area, t: &str, f: usize, c: u32, wrap: bool) {
    let old = SelectObject(dc, s.fonts[f]);
    SetTextColor(dc, color(c));
    SetBkMode(dc, TRANSPARENT);
    let mut r = s.rect(a);
    let mut text: Vec<u16> = t.encode_utf16().collect();
    let flags = DT_NOPREFIX
        | if wrap {
            DT_WORDBREAK
        } else {
            DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS
        };
    DrawTextW(dc, &mut text, &mut r, flags);
    SelectObject(dc, old);
}
/// Single-line text in an absolute device-independent rect (not scrolled; used by the fixed sidebar).
unsafe fn text_box(dc: HDC, s: &State, r: RECT, t: &str, f: usize, c: u32) {
    let old = SelectObject(dc, s.fonts[f]);
    SetTextColor(dc, color(c));
    SetBkMode(dc, TRANSPARENT);
    let mut r = r;
    let mut text: Vec<u16> = t.encode_utf16().collect();
    DrawTextW(
        dc,
        &mut text,
        &mut r,
        DT_SINGLELINE | DT_VCENTER | DT_NOPREFIX | DT_END_ELLIPSIS,
    );
    SelectObject(dc, old);
}
unsafe fn fill(dc: HDC, r: RECT, c: u32) {
    let b = CreateSolidBrush(color(c));
    FillRect(dc, &r, b);
    let _ = DeleteObject(b);
}
/// Rounded fill with optional 1px border; `radius` is the corner ellipse diameter in device pixels.
unsafe fn round_rect(dc: HDC, r: RECT, bg: u32, border: Option<u32>, radius: i32) {
    let b = CreateSolidBrush(color(bg));
    let p = border.map(|c| CreatePen(PS_SOLID, 1, color(c)));
    let ob = SelectObject(dc, b);
    let op = match p {
        Some(p) => SelectObject(dc, p),
        None => SelectObject(dc, GetStockObject(NULL_PEN)),
    };
    let _ = RoundRect(dc, r.left, r.top, r.right, r.bottom, radius, radius);
    SelectObject(dc, ob);
    SelectObject(dc, op);
    let _ = DeleteObject(b);
    if let Some(p) = p {
        let _ = DeleteObject(p);
    }
}
/// Capsule: corner diameter equals the height, so both ends are full semicircles.
unsafe fn pill(dc: HDC, r: RECT, bg: u32) {
    round_rect(dc, r, bg, None, r.bottom - r.top);
}
/// White (or tinted) card with a 1px hairline border; corner diameter 32 px = 16 px radius.
unsafe fn card(dc: HDC, s: &State, a: Area, bg: u32, border: u32) {
    round_rect(dc, s.rect(a), bg, Some(border), s.px(32));
}
unsafe fn ellipse(dc: HDC, r: RECT, rgb: u32) {
    let b = CreateSolidBrush(color(rgb));
    let ob = SelectObject(dc, b);
    let op = SelectObject(dc, GetStockObject(NULL_PEN));
    let _ = Ellipse(dc, r.left, r.top, r.right, r.bottom);
    SelectObject(dc, ob);
    SelectObject(dc, op);
    let _ = DeleteObject(b);
}
/// Status capsule (`at` in logical px) with an optional leading dot; `tone` = (fill, text, dot).
unsafe fn capsule(dc: HDC, s: &State, at: (i32, i32), t: &str, tone: (u32, u32, Option<u32>)) {
    let (fill_rgb, ink, dot_rgb) = tone;
    let mut text: Vec<u16> = t.encode_utf16().collect();
    let old = SelectObject(dc, s.fonts[4]);
    let mut measure = RECT::default();
    DrawTextW(
        dc,
        &mut text,
        &mut measure,
        DT_SINGLELINE | DT_CALCRECT | DT_NOPREFIX,
    );
    SelectObject(dc, old);
    let pad = s.px(14);
    let dot_w = if dot_rgb.is_some() { s.px(20) } else { 0 };
    let left = s.px(at.0);
    let top = s.px(at.1);
    let r = RECT {
        left,
        top,
        right: left + pad * 2 + dot_w + (measure.right - measure.left),
        bottom: top + s.px(28),
    };
    pill(dc, r, fill_rgb);
    if let Some(c) = dot_rgb {
        let cy = (r.top + r.bottom) / 2;
        ellipse(
            dc,
            RECT {
                left: left + pad,
                top: cy - s.px(5),
                right: left + pad + s.px(10),
                bottom: cy + s.px(5),
            },
            c,
        );
    }
    let old = SelectObject(dc, s.fonts[4]);
    SetTextColor(dc, color(ink));
    SetBkMode(dc, TRANSPARENT);
    let mut tr = RECT {
        left: left + pad + dot_w,
        top,
        right: r.right - pad,
        bottom: r.bottom,
    };
    DrawTextW(
        dc,
        &mut text,
        &mut tr,
        DT_SINGLELINE | DT_VCENTER | DT_NOPREFIX,
    );
    SelectObject(dc, old);
}
/// Small dB scale label; `align` is DT_LEFT, DT_CENTER or DT_RIGHT.
unsafe fn tick(dc: HDC, s: &State, a: Area, t: &str, c: u32, align: DRAW_TEXT_FORMAT) {
    let old = SelectObject(dc, s.fonts[1]);
    SetTextColor(dc, color(c));
    SetBkMode(dc, TRANSPARENT);
    let mut r = s.rect(a);
    let mut text: Vec<u16> = t.encode_utf16().collect();
    DrawTextW(
        dc,
        &mut text,
        &mut r,
        align | DT_SINGLELINE | DT_VCENTER | DT_NOPREFIX,
    );
    SelectObject(dc, old);
}
fn clock(seconds: f64) -> String {
    let tenths = (seconds.max(0.) * 10.) as u64;
    format!(
        "{:02}:{:02}.{}",
        tenths / 600,
        (tenths / 10) % 60,
        tenths % 10
    )
}
fn db(peak: f32) -> f32 {
    if !peak.is_finite() || peak <= 0. {
        -60.
    } else {
        (20. * peak.log10()).clamp(-60., 0.)
    }
}
/// Horizontal or vertical position of a dBFS value within `span` pixels (-60 at 0, 0 dBFS at `span`).
fn db_pos(d: f32, span: i32) -> i32 {
    (((d.clamp(-60., 0.) + 60.) / 60.) * span as f32).round() as i32
}
fn level_color(d: f32) -> u32 {
    if d >= 0. {
        METER_CLIP
    } else if d >= -6. {
        METER_WARN
    } else {
        METER_OK
    }
}
/// Fixed ring of recent interval peaks (one per UI tick) plus the peak-hold value since start.
#[derive(Clone, Copy)]
struct Meter {
    hist: [f32; HISTORY],
    next: usize,
    len: usize,
    hold: f32,
}
impl Default for Meter {
    fn default() -> Self {
        Self {
            hist: [0.; HISTORY],
            next: 0,
            len: 0,
            hold: 0.,
        }
    }
}
impl Meter {
    fn push(&mut self, peak: f32) {
        let v = if peak.is_finite() { peak.max(0.) } else { 0. };
        self.hist[self.next] = v;
        self.next = (self.next + 1) % HISTORY;
        self.len = (self.len + 1).min(HISTORY);
        self.hold = self.hold.max(v);
    }
    /// Oldest to newest.
    fn ordered(&self) -> impl Iterator<Item = f32> + '_ {
        let start = (self.next + HISTORY - self.len) % HISTORY;
        (0..self.len).map(move |i| self.hist[(start + i) % HISTORY])
    }
}
unsafe fn paint(hwnd: HWND, dc: HDC, s: &State) {
    let mut client = RECT::default();
    let _ = GetClientRect(hwnd, &mut client);
    fill(dc, client, BG);
    let l = layout(s.width);
    let x = l.main.x;
    let w = l.main.w;
    if l.sidebar {
        // Light sidebar: sidebar well, hairline divider, selected nav item as a white capsule.
        let side = RECT {
            left: 0,
            top: 0,
            right: s.px(184),
            bottom: client.bottom,
        };
        fill(dc, side, WELL);
        fill(
            dc,
            RECT {
                left: side.right,
                top: 0,
                right: side.right + 1,
                bottom: client.bottom,
            },
            SEP,
        );
        text_box(
            dc,
            s,
            RECT {
                left: s.px(24),
                top: s.px(30),
                right: s.px(172),
                bottom: s.px(66),
            },
            "Clear Audio",
            4,
            INK,
        );
        pill(
            dc,
            RECT {
                left: s.px(12),
                top: s.px(104),
                right: s.px(172),
                bottom: s.px(146),
            },
            WHITE,
        );
        text_box(
            dc,
            s,
            RECT {
                left: s.px(28),
                top: s.px(104),
                right: s.px(172),
                bottom: s.px(146),
            },
            "錄音工作台",
            4,
            BRAND,
        );
        for (y, t) in [
            (158, "CAPTURE / CONVERT"),
            (224, "只留下你選的聲音"),
            (s.height - 76, "原生 Windows · v0.5"),
        ] {
            text_box(
                dc,
                s,
                RECT {
                    left: s.px(24),
                    top: s.px(y),
                    right: s.px(172),
                    bottom: s.px(y + 28),
                },
                t,
                1,
                SIDE_MUTED,
            );
        }
    }
    label(
        dc,
        s,
        Area::new(x, 24, w - 170, 40),
        "錄音工作台",
        2,
        INK,
        false,
    );
    label(
        dc,
        s,
        Area::new(x, 68, w, 24),
        "選好來源，保留原音訊。需要分享時，再另存 MP3。",
        0,
        MUTED,
        false,
    );
    pill(dc, s.rect(Area::new(x + w - 176, 30, 176, 32)), WELL);
    label(
        dc,
        s,
        Area::new(x + w - 162, 31, 152, 30),
        "WAV · 原始來源保留",
        1,
        BRAND,
        false,
    );
    let a = l.source;
    card(dc, s, a, WHITE, SEP);
    label(
        dc,
        s,
        Area::new(a.x + 24, a.y + 18, a.w - 48, 24),
        "01   錄音來源",
        4,
        INK,
        false,
    );
    // Segmented control track; the selected segment is a white capsule (see draw_button).
    pill(dc, s.rect(Area::new(a.x + 20, a.y + 52, 304, 44)), WELL);
    if s.import {
        label(
            dc,
            s,
            Area::new(a.x + 24, a.y + 108, a.w - 48, 24),
            "單分頁先由瀏覽器擴充錄成 WAV",
            0,
            INK,
            false,
        );
        label(
            dc,
            s,
            Area::new(a.x + 24, a.y + 140, a.w - 48, 42),
            "需手動安裝與點擊授權；本 App 匯入檔案後轉檔。",
            1,
            MUTED,
            true,
        );
    } else {
        label(
            dc,
            s,
            Area::new(a.x + 24, a.y + 156, a.w - 48, 28),
            "包含所選 PID 與子程序；瀏覽器 PID 可能包含多個分頁。",
            1,
            MUTED,
            true,
        );
    }
    let a = l.record;
    card(dc, s, a, WHITE, SEP);
    let recording = matches!(s.job, Job::Recording | Job::Stopping);
    let title = match s.job {
        Job::Recording => "正在錄音",
        Job::Stopping => "正在停止與保存…",
        _ => {
            if s.import {
                "分頁檔案匯入模式"
            } else {
                "準備錄音"
            }
        }
    };
    let title = if s.error {
        "需要處理 · 請查看詳細資訊"
    } else {
        title
    };
    // Status capsule: red with a white dot while recording, neutral otherwise, red text on error.
    let tone = if s.error {
        (WELL, DANGER, None)
    } else if s.job == Job::Recording {
        (DANGER, WHITE, Some(WHITE))
    } else {
        (WELL, INK, None)
    };
    capsule(dc, s, (a.x + 24, a.y + 20), title, tone);
    // Large light timer (Segoe UI Light, 56 px).
    label(
        dc,
        s,
        Area::new(a.x + 20, a.y + 52, a.w - 40, 68),
        &clock(s.elapsed),
        3,
        INK,
        false,
    );
    label(
        dc,
        s,
        Area::new(a.x + 24, a.y + 124, a.w - 48, 22),
        &format!(
            "48 kHz  /  32-bit float  /  Stereo     {:.1} MB",
            s.bytes as f64 / 1e6
        ),
        1,
        MUTED,
        false,
    );
    // Real level history on a rounded well: one bar per UI tick, newest at the right, dB scale.
    let well = Area::new(a.x + 24, a.y + 152, a.w - 48, 56);
    round_rect(dc, s.rect(well), WELL, None, s.px(24));
    let strip = Area::new(a.x + 36, a.y + 160, a.w - 72, 40);
    let sr = s.rect(strip);
    let (sw, sh) = (sr.right - sr.left, sr.bottom - sr.top);
    let brushes = [METER_OK, METER_WARN, METER_CLIP].map(|c| CreateSolidBrush(color(c)));
    let old_brush = SelectObject(dc, brushes[0]);
    let old_pen = SelectObject(dc, GetStockObject(NULL_PEN));
    let gap = s.px(2).max(1);
    let filled = s.meter.len;
    for (k, peak) in s.meter.ordered().enumerate() {
        let d = db(peak);
        let bh = db_pos(d, sh);
        if bh <= 0 {
            continue;
        }
        let slot = HISTORY - filled + k;
        let x0 = sr.left + slot as i32 * sw / HISTORY as i32;
        let x1 = (sr.left + (slot as i32 + 1) * sw / HISTORY as i32 - gap).max(x0 + 1);
        let brush = match level_color(d) {
            METER_CLIP => brushes[2],
            METER_WARN => brushes[1],
            _ => brushes[0],
        };
        SelectObject(dc, brush);
        let _ = Rectangle(dc, x0, sr.bottom - bh, x1, sr.bottom);
    }
    SelectObject(dc, old_brush);
    SelectObject(dc, old_pen);
    for b in brushes {
        let _ = DeleteObject(b);
    }
    // Level meter on a capsule well; fill and peak-hold marker are drawn over it.
    let meter = Area::new(a.x + 24, a.y + 216, a.w - 48, 10);
    pill(dc, s.rect(meter), WELL);
    let level = (db(s.peak) + 60.) / 60.;
    if recording && level > 0. {
        let mut on = meter;
        on.w = ((on.w as f32 * level) as i32).max(4);
        pill(dc, s.rect(on), level_color(db(s.peak)));
    }
    // Peak-hold marker: highest interval peak since this recording started.
    if s.meter.hold > 0. {
        let hx = meter.x + db_pos(db(s.meter.hold), meter.w);
        fill(
            dc,
            s.rect(Area::new(hx - 1, meter.y - 3, 2, meter.h + 6)),
            PEAK,
        );
    }
    let ty = a.y + 232;
    tick(dc, s, Area::new(meter.x, ty, 40, 18), "-60", MUTED, DT_LEFT);
    for (d, t) in [(-40., "-40"), (-24., "-24"), (-12., "-12"), (-6., "-6")] {
        let cx = meter.x + db_pos(d, meter.w);
        tick(dc, s, Area::new(cx - 20, ty, 40, 18), t, MUTED, DT_CENTER);
    }
    tick(
        dc,
        s,
        Area::new(meter.x + meter.w - 40, ty, 40, 18),
        "0",
        MUTED,
        DT_RIGHT,
    );
    let meter_text = if !recording {
        "音量計待命 · 不顯示模擬波形".into()
    } else if s.preview && s.meter.hold > 0. {
        "預覽合成值 · 非真實音訊".into()
    } else if s.peak <= 0. {
        "尚未偵測到音訊 · 請確認來源正在播放".into()
    } else {
        format!("實際峰值  {:.1} dBFS  ·  不連續封包 {}", db(s.peak), s.gaps)
    };
    label(
        dc,
        s,
        Area::new(a.x + 24, a.y + 252, a.w - 48, 20),
        &meter_text,
        1,
        MUTED,
        false,
    );
    let a = l.files;
    card(dc, s, a, WHITE, SEP);
    label(
        dc,
        s,
        Area::new(a.x + 24, a.y + 18, a.w - 48, 28),
        "本次檔案",
        4,
        INK,
        false,
    );
    label(
        dc,
        s,
        Area::new(a.x + 24, a.y + 51, a.w - 48, 22),
        "選取檔案即可另存轉檔",
        1,
        MUTED,
        false,
    );
    if s.files.is_empty() {
        label(
            dc,
            s,
            Area::new(a.x + 24, a.y + 96, a.w - 48, 28),
            "還沒有音訊檔案",
            0,
            INK,
            false,
        );
        label(
            dc,
            s,
            Area::new(a.x + 24, a.y + 132, a.w - 48, 48),
            "完成錄音，或匯入一個 WAV。\n原始檔案會一直保留。",
            1,
            MUTED,
            true,
        );
    }
    let a = l.export;
    card(dc, s, a, WHITE, SEP);
    label(
        dc,
        s,
        Area::new(a.x + 24, a.y + 18, a.w - 48, 28),
        "02   另存與轉檔",
        4,
        INK,
        false,
    );
    let name = s
        .input
        .as_ref()
        .and_then(|p| p.file_name())
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "尚未選擇來源檔案".into());
    label(
        dc,
        s,
        Area::new(a.x + 24, a.y + 60, a.w - 204, 26),
        &name,
        0,
        INK,
        false,
    );
    label(
        dc,
        s,
        Area::new(a.x + 24, a.y + 89, a.w - 48, 23),
        &s.input
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| "從本次檔案清單選取，或按「匯入音訊」。".into()),
        1,
        MUTED,
        false,
    );
    label(
        dc,
        s,
        Area::new(a.x + 24, a.y + 172, a.w - 48, 24),
        "MP3 為有損另存；FLAC 24-bit 會量化。WAV 原檔不變。",
        1,
        MUTED,
        false,
    );
    let (message, c) = if s.job == Job::Converting && s.stop.load(Ordering::Relaxed) != 0 {
        ("正在取消轉檔，原始來源保留…".into(), BRAND)
    } else if s.job == Job::Converting {
        (
            format!(
                "編碼中 · 已經過 {} · 可取消，來源保留",
                clock(s.started.elapsed().as_secs_f64())
            ),
            BRAND,
        )
    } else {
        (s.status.clone(), if s.error { DANGER } else { MUTED })
    };
    label(
        dc,
        s,
        Area::new(a.x + 24, a.y + 208, a.w - 164, 52),
        &message,
        1,
        c,
        true,
    );
    let bottom = a.y + a.h + 16;
    label(
        dc,
        s,
        Area::new(x, bottom, w - 164, 46),
        &s.destination
            .as_ref()
            .map(|p| format!("錄音另存位置：{}", p.display()))
            .unwrap_or_else(|| "錄音另存位置：開始前選擇；不覆寫既有檔案。".into()),
        1,
        MUTED,
        true,
    );
    label(
        dc,
        s,
        Area::new(x, bottom + 50, w, 40),
        if s.preview {
            "介面狀態預覽 · 沒有啟動錄音或轉檔"
        } else {
            "非 bit-perfect 承諾 · 單分頁需擴充授權 · 非靜音捕捉仍待互動桌面驗收"
        },
        1,
        if s.preview { DANGER } else { MUTED },
        true,
    );
}
unsafe fn child(hwnd: HWND, s: &mut State, id: usize, class: &str, t: &str, style: u32) {
    let h = CreateWindowExW(
        WINDOW_EX_STYLE(0),
        PCWSTR(wide(class).as_ptr()),
        PCWSTR(wide(t).as_ptr()),
        WINDOW_STYLE(WS_CHILD.0 | WS_VISIBLE.0 | WS_TABSTOP.0 | style),
        0,
        0,
        10,
        10,
        hwnd,
        HMENU(id as *mut _),
        None,
        None,
    )
    .expect("native control");
    SendMessageW(h, WM_SETFONT, WPARAM(s.fonts[0].0 as usize), LPARAM(0));
    s.controls.insert(id, h);
}
unsafe fn reposition(hwnd: HWND, s: &mut State) {
    set(
        s.h(EXPORT),
        if s.job == Job::Converting {
            if s.stop.load(Ordering::Relaxed) != 0 {
                "取消中…"
            } else {
                "取消轉檔"
            }
        } else {
            "另存轉檔"
        },
    );
    let mut r = RECT::default();
    let _ = GetClientRect(hwnd, &mut r);
    s.width = r.right * 96 / s.dpi as i32;
    s.height = r.bottom * 96 / s.dpi as i32;
    let l = layout(s.width);
    s.scroll = s.scroll.clamp(0, (l.height - s.height).max(0));
    s.rects.clear();
    let a = l.source;
    s.rects.insert(APP, Area::new(a.x + 24, a.y + 56, 136, 36));
    s.rects
        .insert(IMPORT_MODE, Area::new(a.x + 168, a.y + 56, 152, 36));
    s.rects
        .insert(SOURCES, Area::new(a.x + 24, a.y + 108, a.w - 144, 38));
    s.rects
        .insert(REFRESH, Area::new(a.x + a.w - 108, a.y + 108, 84, 38));
    let a = l.record;
    let bw = (a.w - 64) / 3;
    for (i, id) in [START, STOP, CANCEL].iter().enumerate() {
        s.rects.insert(
            *id,
            Area::new(a.x + 24 + (bw + 8) * i as i32, a.y + 288, bw, 36),
        );
    }
    let a = l.files;
    s.rects
        .insert(FILES, Area::new(a.x + 20, a.y + 84, a.w - 40, a.h - 104));
    let a = l.export;
    s.rects
        .insert(INPUT, Area::new(a.x + a.w - 164, a.y + 56, 140, 36));
    s.rects
        .insert(QUALITY, Area::new(a.x + 24, a.y + 124, a.w - 212, 38));
    s.rects
        .insert(EXPORT, Area::new(a.x + a.w - 172, a.y + 124, 148, 38));
    s.rects.insert(
        DEST,
        Area::new(l.main.x + l.main.w - 156, a.y + a.h + 16, 156, 36),
    );
    s.rects
        .insert(ENCODER, Area::new(l.main.x + l.main.w - 280, 96, 132, 24));
    s.rects
        .insert(HELP, Area::new(l.main.x + l.main.w - 140, 96, 140, 24));
    s.rects
        .insert(DETAILS, Area::new(a.x + a.w - 132, a.y + 212, 108, 32));
    for (&id, &h) in &s.controls {
        let a = s.rects[&id];
        let r = s.rect(a);
        let height = if id == SOURCES || id == QUALITY {
            s.px(280)
        } else {
            r.bottom - r.top
        };
        let _ = SetWindowPos(
            h,
            None,
            r.left,
            r.top,
            r.right - r.left,
            height,
            SWP_NOZORDER | SWP_NOACTIVATE,
        );
        let visible =
            !(id == FILES && s.files.is_empty() || (id == SOURCES || id == REFRESH) && s.import);
        let _ = ShowWindow(h, if visible { SW_SHOWNA } else { SW_HIDE });
        let enabled = match id {
            DETAILS => true,
            STOP => s.job == Job::Recording,
            CANCEL => s.busy(),
            START => !s.busy() && !s.import,
            EXPORT => {
                (!s.busy() && s.input.is_some())
                    || (s.job == Job::Converting && s.stop.load(Ordering::Relaxed) == 0)
            }
            _ => !s.busy(),
        };
        let _ = EnableWindow(h, enabled);
    }
    let si = SCROLLINFO {
        cbSize: std::mem::size_of::<SCROLLINFO>() as u32,
        fMask: SIF_RANGE | SIF_PAGE | SIF_POS,
        nMin: 0,
        nMax: l.height - 1,
        nPage: s.height.max(1) as u32,
        nPos: s.scroll,
        ..Default::default()
    };
    SetScrollInfo(hwnd, SB_VERT, &si, true);
    let _ = InvalidateRect(hwnd, None, false);
}
unsafe fn refresh(s: &mut State) {
    s.sources.clear();
    SendMessageW(s.h(SOURCES), CB_RESETCONTENT, WPARAM(0), LPARAM(0));
    if let Ok(h) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
        let mut p = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(h, &mut p).is_ok() {
            loop {
                if p.th32ProcessID > 4 {
                    if let Some(created) = capture::identity(p.th32ProcessID) {
                        let len = p.szExeFile.iter().position(|&x| x == 0).unwrap_or(260);
                        s.sources.push(Source {
                            pid: p.th32ProcessID,
                            created,
                            name: String::from_utf16_lossy(&p.szExeFile[..len]),
                        });
                    }
                }
                if Process32NextW(h, &mut p).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(h);
    }
    s.sources.sort_by_key(|a| a.name.to_lowercase());
    let placeholder = wide("選擇要錄音的應用程式…");
    SendMessageW(
        s.h(SOURCES),
        CB_ADDSTRING,
        WPARAM(0),
        LPARAM(placeholder.as_ptr() as isize),
    );
    for p in &s.sources {
        let t = wide(&format!("{}  ·  PID {}", p.name, p.pid));
        SendMessageW(
            s.h(SOURCES),
            CB_ADDSTRING,
            WPARAM(0),
            LPARAM(t.as_ptr() as isize),
        );
    }
    SendMessageW(s.h(SOURCES), CB_SETCURSEL, WPARAM(0), LPARAM(0));
}
unsafe fn choose(hwnd: HWND, save: bool, ext: &str) -> Option<PathBuf> {
    let mut file = [0u16; 32768];
    let filter = wide(if ext == "exe" {
        "FFmpeg 執行檔\0*.exe\0\0"
    } else {
        "音訊檔案\0*.wav;*.flac;*.mp3\0所有檔案\0*.*\0\0"
    });
    let ext = wide(ext);
    let mut o = OPENFILENAMEW {
        lStructSize: std::mem::size_of::<OPENFILENAMEW>() as u32,
        hwndOwner: hwnd,
        lpstrFilter: PCWSTR(filter.as_ptr()),
        lpstrFile: PWSTR(file.as_mut_ptr()),
        nMaxFile: file.len() as u32,
        lpstrDefExt: PCWSTR(ext.as_ptr()),
        Flags: OFN_EXPLORER
            | OFN_NOCHANGEDIR
            | OFN_PATHMUSTEXIST
            | if save {
                OFN_OVERWRITEPROMPT
            } else {
                OFN_FILEMUSTEXIST
            },
        ..Default::default()
    };
    let ok = if save {
        GetSaveFileNameW(&mut o)
    } else {
        GetOpenFileNameW(&mut o)
    };
    ok.as_bool().then(|| {
        PathBuf::from(String::from_utf16_lossy(
            &file[..file.iter().position(|&c| c == 0).unwrap()],
        ))
    })
}
unsafe fn add_file(s: &mut State, p: PathBuf) {
    s.input = Some(p.clone());
    if !s.files.contains(&p) {
        let name = p.file_name().unwrap_or_default().to_string_lossy();
        let t = wide(&name);
        SendMessageW(
            s.h(FILES),
            LB_ADDSTRING,
            WPARAM(0),
            LPARAM(t.as_ptr() as isize),
        );
        s.files.push(p);
    }
    if let Some(i) = s.files.iter().position(|p| Some(p) == s.input.as_ref()) {
        SendMessageW(s.h(FILES), LB_SETCURSEL, WPARAM(i), LPARAM(0));
    }
}
unsafe fn begin(s: &mut State, job: Job) -> (Arc<AtomicU8>, mpsc::Sender<Event>) {
    let (tx, rx) = mpsc::channel();
    s.rx = Some(rx);
    s.stop = Arc::new(AtomicU8::new(0));
    s.job = job;
    s.started = Instant::now();
    s.error = false;
    s.status = "正在準備…".into();
    (s.stop.clone(), tx)
}
unsafe fn command(hwnd: HWND, s: &mut State, id: usize, notify: u32) {
    if id == EXPORT && s.job == Job::Converting {
        s.stop.store(2, Ordering::Relaxed);
        s.status = "正在取消轉檔，原始來源保留…".into();
        return;
    }
    if id == DETAILS {
        MessageBoxW(
            hwnd,
            PCWSTR(
                wide(&format!(
                    "{}\n\nFFmpeg：{}\n\n來源：{}",
                    s.status,
                    s.ffmpeg,
                    s.input
                        .as_ref()
                        .map(|p| p.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "未選擇".into())
                ))
                .as_ptr(),
            ),
            w!("工作狀態與完整資訊"),
            MB_OK,
        );
        return;
    }
    if id == STOP || id == CANCEL {
        if s.busy() {
            s.stop
                .store(if id == CANCEL { 2 } else { 1 }, Ordering::Relaxed);
            if s.job != Job::Converting {
                s.job = Job::Stopping;
            }
            s.status = "正在結束工作，請稍候…".into();
        }
        return;
    }
    if s.busy() {
        return;
    }
    match id {
        APP => s.import = false,
        IMPORT_MODE => s.import = true,
        REFRESH => refresh(s),
        HELP => {
            MessageBoxW(hwnd,w!("單分頁：在 Chrome／Edge 手動載入 extension，於目標分頁點擊圖示授權，再錄成 WAV。回此 App 按「匯入音訊」轉 MP3。\n\n擴充未安裝／尚未真實授權驗收。沒有 native messaging 或常駐服務。\n\n程式錄音：只含所選 PID 與子程序。非靜音／跨程序隔離仍待有音訊端點的互動桌面驗收。\n\nWAV 無額外有損編碼，不承諾 bit-perfect。"),w!("錄音方式與驗收限制"),MB_OK);
        }
        ENCODER => {
            if let Some(p) = choose(hwnd, false, "exe") {
                s.ffmpeg = p.to_string_lossy().into_owned();
                s.status = format!("編碼器：{}", s.ffmpeg);
            }
        }
        DEST => {
            if let Some(p) = choose(hwnd, true, "wav") {
                s.destination = Some(p);
            }
        }
        INPUT => {
            if let Some(p) = choose(hwnd, false, "wav") {
                add_file(s, p);
                s.status = "已匯入，可以選擇格式並另存。".into();
                s.error = false;
            }
        }
        FILES if notify == LBN_SELCHANGE => {
            let i = SendMessageW(s.h(FILES), LB_GETCURSEL, WPARAM(0), LPARAM(0)).0;
            if i >= 0 {
                s.input = s.files.get(i as usize).cloned();
            }
        }
        START => {
            let i = SendMessageW(s.h(SOURCES), CB_GETCURSEL, WPARAM(0), LPARAM(0)).0;
            if i <= 0 {
                s.error = true;
                s.status = "請先選擇一個應用程式。".into();
                return;
            }
            let p = &s.sources[i as usize - 1];
            let (pid, created) = (p.pid, p.created);
            let path = s.destination.clone().or_else(|| choose(hwnd, true, "wav"));
            if let Some(path) = path {
                s.destination = Some(path.clone());
                s.elapsed = 0.;
                s.peak = 0.;
                s.meter = Meter::default();
                s.bytes = 0;
                s.gaps = 0;
                let (stop, tx) = begin(s, Job::Recording);
                set(hwnd, "● 錄音中 · Clear Audio");
                std::thread::spawn(move || {
                    let (progress, rx) = mpsc::channel();
                    let t = tx.clone();
                    let bridge = std::thread::spawn(move || {
                        for m in rx {
                            let _ = t.send(Event::Capture(m));
                        }
                    });
                    let result = capture::record(pid, created, &path, stop, progress, None);
                    let _ = bridge.join();
                    let _ = tx.send(Event::Done(result, path, false));
                });
            }
        }
        EXPORT => {
            if let Some(input) = s.input.clone() {
                let q = SendMessageW(s.h(QUALITY), CB_GETCURSEL, WPARAM(0), LPARAM(0)).0 as usize;
                if let Some(out) = choose(hwnd, true, if q == 3 { "flac" } else { "mp3" }) {
                    let ff = s.ffmpeg.clone();
                    let (stop, tx) = begin(s, Job::Converting);
                    set(hwnd, "轉檔中 · Clear Audio");
                    std::thread::spawn(move || {
                        let r = convert::convert(&ff, &input, &out, q, stop);
                        let _ = tx.send(Event::Done(r, out, true));
                    });
                }
            }
        }
        _ => {}
    }
}
/// Visual role of an owner-drawn button.
#[derive(Clone, Copy, PartialEq)]
enum Style {
    Primary,
    Danger,
    Secondary,
    Selected,
    Ghost,
    Disabled,
}
/// Surface the button sits on, so rounded corners blend into their card.
fn backdrop(id: usize) -> u32 {
    match id {
        APP | IMPORT_MODE => WELL,
        ENCODER | HELP | DEST => BG,
        _ => WHITE,
    }
}
/// (fill, text) colours for a style; `pressed` darkens the fill. Buttons are capsules without borders.
fn button_colors(style: Style, pressed: bool, backdrop: u32) -> (u32, u32) {
    match style {
        Style::Primary => (if pressed { 0x0f5a48 } else { BRAND }, WHITE),
        Style::Danger => (if pressed { 0x9e1016 } else { DANGER }, WHITE),
        Style::Secondary => (if pressed { 0xdadae0 } else { WELL }, INK),
        Style::Selected => (if pressed { BG } else { WHITE }, BRAND),
        Style::Ghost => (if pressed { WELL } else { backdrop }, BRAND),
        Style::Disabled => (WELL, DISABLED),
    }
}
/// Rounded focus outline inside `c`; `inset` is the outline's outer offset, `width` its pen width.
unsafe fn focus_ring(dc: HDC, c: RECT, inset: i32, rgb: u32, width: i32) {
    let pen = CreatePen(PS_SOLID, width, color(rgb));
    let ob = SelectObject(dc, GetStockObject(NULL_BRUSH));
    let op = SelectObject(dc, pen);
    let d = c.bottom - c.top - 2 * inset;
    let _ = RoundRect(
        dc,
        c.left + inset,
        c.top + inset,
        c.right - inset,
        c.bottom - inset,
        d,
        d,
    );
    SelectObject(dc, ob);
    SelectObject(dc, op);
    let _ = DeleteObject(pen);
}
unsafe fn draw_button(s: &State, d: &DRAWITEMSTRUCT) {
    let id = d.CtlID as usize;
    if d.CtlType != ODT_BUTTON {
        return;
    }
    let disabled = d.itemState.0 & ODS_DISABLED.0 != 0;
    let pressed = d.itemState.0 & ODS_SELECTED.0 != 0 && !disabled;
    let focus = d.itemState.0 & ODS_FOCUS.0 != 0;
    let selected = (id == APP && !s.import) || (id == IMPORT_MODE && s.import);
    let style = if disabled {
        Style::Disabled
    } else if id == STOP && s.job == Job::Recording {
        Style::Danger
    } else if id == START || id == EXPORT {
        Style::Primary
    } else if selected {
        Style::Selected
    } else if matches!(id, HELP | DETAILS | ENCODER | REFRESH | APP | IMPORT_MODE) {
        Style::Ghost
    } else {
        Style::Secondary
    };
    let back = backdrop(id);
    let (bg, fg) = button_colors(style, pressed, back);
    let c = d.rcItem;
    // Clear the square corners with the surface colour before drawing the capsule face.
    fill(d.hDC, c, back);
    round_rect(d.hDC, c, bg, None, c.bottom - c.top);
    let old = SelectObject(d.hDC, s.fonts[if style == Style::Primary { 4 } else { 0 }]);
    SetBkMode(d.hDC, TRANSPARENT);
    SetTextColor(d.hDC, color(fg));
    let mut r = c;
    let mut t = text(d.hwndItem).encode_utf16().collect::<Vec<_>>();
    DrawTextW(
        d.hDC,
        &mut t,
        &mut r,
        DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX,
    );
    SelectObject(d.hDC, old);
    if focus {
        // 2px brand focus ring on the edge. Brand/red faces cannot show a brand ring on themselves,
        // so they also get a 2px white inner ring.
        let width = s.px(2).max(1);
        focus_ring(d.hDC, c, s.px(1), BRAND, width);
        if matches!(style, Style::Primary | Style::Danger) {
            focus_ring(d.hDC, c, s.px(4), WHITE, width);
        }
    }
}
unsafe fn init(hwnd: HWND) -> State {
    let dpi = GetDpiForWindow(hwnd).max(96);
    let mut s = State {
        controls: BTreeMap::new(),
        rects: BTreeMap::new(),
        sources: vec![],
        files: vec![],
        dpi,
        scroll: 0,
        width: 1120,
        height: 900,
        fonts: fonts(dpi),
        brush: CreateSolidBrush(color(WHITE)),
        import: false,
        job: Job::Idle,
        rx: None,
        stop: Arc::new(AtomicU8::new(0)),
        started: Instant::now(),
        elapsed: 0.,
        peak: 0.,
        meter: Meter::default(),
        bytes: 0,
        gaps: 0,
        status: "選擇來源後，開始第一段錄音。".into(),
        error: false,
        destination: None,
        input: None,
        ffmpeg: "ffmpeg.exe".into(),
        preview: false,
    };
    for (id, t) in [(APP, "應用程式"), (IMPORT_MODE, "分頁 WAV 匯入")] {
        child(hwnd, &mut s, id, "BUTTON", t, BS_OWNERDRAW as u32);
    }
    child(
        hwnd,
        &mut s,
        SOURCES,
        "COMBOBOX",
        "",
        CBS_DROPDOWNLIST as u32 | WS_VSCROLL.0,
    );
    for (id, t) in [
        (REFRESH, "重新整理"),
        (START, "開始錄音"),
        (STOP, "停止保存"),
        (CANCEL, "取消工作"),
    ] {
        child(hwnd, &mut s, id, "BUTTON", t, BS_OWNERDRAW as u32);
    }
    child(
        hwnd,
        &mut s,
        FILES,
        "LISTBOX",
        "",
        LBS_NOTIFY as u32 | WS_VSCROLL.0,
    );
    child(
        hwnd,
        &mut s,
        INPUT,
        "BUTTON",
        "匯入音訊",
        BS_OWNERDRAW as u32,
    );
    child(
        hwnd,
        &mut s,
        QUALITY,
        "COMBOBOX",
        "",
        CBS_DROPDOWNLIST as u32,
    );
    for q in [
        "MP3 · VBR 高品質 (q2)",
        "MP3 · 192 kbps",
        "MP3 · 320 kbps",
        "FLAC · 24-bit",
    ] {
        let q = wide(q);
        SendMessageW(
            s.h(QUALITY),
            CB_ADDSTRING,
            WPARAM(0),
            LPARAM(q.as_ptr() as isize),
        );
    }
    SendMessageW(s.h(QUALITY), CB_SETCURSEL, WPARAM(0), LPARAM(0));
    for (id, t) in [
        (EXPORT, "另存轉檔"),
        (DEST, "錄音另存位置"),
        (ENCODER, "編碼器設定"),
        (HELP, "使用方式 / 限制"),
        (DETAILS, "詳細資訊"),
    ] {
        child(hwnd, &mut s, id, "BUTTON", t, BS_OWNERDRAW as u32);
    }
    refresh(&mut s);
    s
}
unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    if msg == WM_CREATE {
        let s = Box::new(init(hwnd));
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, Box::into_raw(s) as isize);
        SetTimer(hwnd, 1, 100, None);
        return LRESULT(0);
    }
    let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut State;
    if !ptr.is_null() {
        let s = &mut *ptr;
        match msg {
            WM_SIZE => {
                reposition(hwnd, s);
                return LRESULT(0);
            }
            WM_DPICHANGED => {
                s.dpi = (w.0 & 0xffff) as u32;
                let old = s.fonts;
                s.fonts = fonts(s.dpi);
                for h in s.controls.values() {
                    SendMessageW(*h, WM_SETFONT, WPARAM(s.fonts[0].0 as usize), LPARAM(0));
                }
                for f in old {
                    let _ = DeleteObject(f);
                }
                let r = &*(l.0 as *const RECT);
                let _ = SetWindowPos(
                    hwnd,
                    None,
                    r.left,
                    r.top,
                    r.right - r.left,
                    r.bottom - r.top,
                    SWP_NOZORDER | SWP_NOACTIVATE,
                );
                reposition(hwnd, s);
                return LRESULT(0);
            }
            WM_GETMINMAXINFO => {
                let info = &mut *(l.0 as *mut MINMAXINFO);
                info.ptMinTrackSize = POINT {
                    x: s.px(680),
                    y: s.px(400),
                };
                return LRESULT(0);
            }
            WM_PAINT => {
                let mut ps = PAINTSTRUCT::default();
                let dc = BeginPaint(hwnd, &mut ps);
                paint(hwnd, dc, s);
                let _ = EndPaint(hwnd, &ps);
                return LRESULT(0);
            }
            WM_PRINTCLIENT => {
                paint(hwnd, HDC(w.0 as *mut _), s);
                return LRESULT(0);
            }
            WM_ERASEBKGND => return LRESULT(1),
            WM_DRAWITEM => {
                draw_button(s, &*(l.0 as *const DRAWITEMSTRUCT));
                return LRESULT(1);
            }
            WM_CTLCOLORLISTBOX | WM_CTLCOLOREDIT => {
                let dc = HDC(w.0 as *mut _);
                SetTextColor(dc, color(INK));
                SetBkColor(dc, color(WHITE));
                return LRESULT(s.brush.0 as isize);
            }
            WM_COMMAND => {
                command(hwnd, s, w.0 & 0xffff, (w.0 >> 16) as u32);
                reposition(hwnd, s);
                return LRESULT(0);
            }
            WM_TIMER => {
                let events =
                    s.rx.as_ref()
                        .map(|rx| rx.try_iter().collect::<Vec<_>>())
                        .unwrap_or_default();
                for event in events {
                    match event {
                        Event::Capture(m) => {
                            if let Some(data) = m.strip_prefix("@meter|") {
                                let n = data.split('|').collect::<Vec<_>>();
                                if n.len() == 4 {
                                    s.elapsed = n[0].parse().unwrap_or(0.);
                                    s.bytes = n[1].parse().unwrap_or(0);
                                    s.peak = n[2].parse().unwrap_or(0.);
                                    s.gaps = n[3].parse().unwrap_or(0);
                                    // One history bar per real capture meter report.
                                    s.meter.push(s.peak);
                                }
                            } else {
                                s.status = m;
                            }
                        }
                        Event::Done(result, path, converted) => {
                            s.job = Job::Idle;
                            s.peak = 0.;
                            s.error = result.is_err();
                            s.status = result.unwrap_or_else(|e| format!("無法完成：{e}"));
                            if path.is_file() {
                                add_file(s, path);
                                if !converted {
                                    s.destination = None;
                                }
                            }
                            set(hwnd, "Clear Audio · 錄音工作台");
                            reposition(hwnd, s);
                        }
                    }
                }
                if s.busy() {
                    let _ = InvalidateRect(hwnd, None, false);
                }
                return LRESULT(0);
            }
            WM_MOUSEWHEEL => {
                let delta = (w.0 >> 16) as i16 as i32;
                s.scroll -= delta / 120 * 64;
                reposition(hwnd, s);
                return LRESULT(0);
            }
            WM_VSCROLL => {
                let mut si = SCROLLINFO {
                    cbSize: std::mem::size_of::<SCROLLINFO>() as u32,
                    fMask: SIF_ALL,
                    ..Default::default()
                };
                let _ = GetScrollInfo(hwnd, SB_VERT, &mut si);
                match (w.0 & 0xffff) as i32 {
                    0 => s.scroll -= 40,
                    1 => s.scroll += 40,
                    2 => s.scroll -= s.height - 48,
                    3 => s.scroll += s.height - 48,
                    4 | 5 => s.scroll = si.nTrackPos,
                    _ => {}
                }
                reposition(hwnd, s);
                return LRESULT(0);
            }
            WM_CLOSE if s.busy() && !s.preview => {
                s.stop.store(1, Ordering::Relaxed);
                s.status = "正在停止；保存完成後請再關閉。".into();
                s.job = Job::Stopping;
                return LRESULT(0);
            }
            WM_DESTROY => {
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                drop(Box::from_raw(ptr));
                PostQuitMessage(0);
                return LRESULT(0);
            }
            _ => {}
        }
    }
    DefWindowProcW(hwnd, msg, w, l)
}
unsafe fn audit_controls(hwnd: HWND, s: &State) -> String {
    let dc = GetDC(hwnd);
    let mut result = String::new();
    for (&id, &h) in &s.controls {
        let a = s.rects[&id];
        let visible = GetWindowLongW(h, GWL_STYLE) as u32 & WS_VISIBLE.0 != 0;
        if !visible {
            continue;
        }
        if a.x < 0 || a.x + a.w > s.width {
            result += &format!("FAIL horizontal bounds id={id}\n");
        }
        if id != SOURCES && id != QUALITY && id != FILES {
            let f = s.fonts[if id == START || id == EXPORT { 4 } else { 0 }];
            let old = SelectObject(dc, f);
            let t = text(h);
            let mut extent = SIZE::default();
            let _ = GetTextExtentPoint32W(dc, &t.encode_utf16().collect::<Vec<_>>(), &mut extent);
            SelectObject(dc, old);
            if extent.cx > s.px(a.w - 8) || extent.cy > s.px(a.h - 4) {
                result += &format!(
                    "FAIL label fit id={id} extent={}x{} rect={}x{}\n",
                    extent.cx,
                    extent.cy,
                    s.px(a.w),
                    s.px(a.h)
                );
            }
        }
    }
    ReleaseDC(hwnd, dc);
    let mut h = GetNextDlgTabItem(hwnd, None, false).unwrap_or_default();
    let first = h;
    let mut tabs = vec![];
    for _ in 0..s.controls.len() + 1 {
        if h.0.is_null() {
            break;
        }
        tabs.push(GetDlgCtrlID(h));
        h = GetNextDlgTabItem(hwnd, h, false).unwrap_or_default();
        if h == first {
            break;
        }
    }
    result += &format!("Tab traversal: {tabs:?}\n");
    if !result.contains("FAIL") {
        result = format!("PASS: visible control bounds and label metrics\n{result}");
    }
    result
}
pub fn run(args: &[String]) -> Result<()> {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let instance = GetModuleHandleW(None)?;
        let class = w!("ClearAudioV02");
        RegisterClassW(&WNDCLASSW {
            hInstance: instance.into(),
            lpszClassName: class,
            lpfnWndProc: Some(wndproc),
            hCursor: LoadCursorW(None, IDC_ARROW)?,
            ..Default::default()
        });
        let smoke = args.get(1).map(String::as_str) == Some("--gui-smoke");
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class,
            w!("Clear Audio · 錄音工作台"),
            WS_OVERLAPPEDWINDOW | WS_VSCROLL | WS_CLIPCHILDREN,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            1180,
            1040,
            None,
            None,
            instance,
            None,
        )?;
        let s = &mut *(GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut State);
        if smoke {
            let dpi = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(96);
            s.dpi = dpi;
            let old = s.fonts;
            s.fonts = fonts(dpi);
            for h in s.controls.values() {
                SendMessageW(*h, WM_SETFONT, WPARAM(s.fonts[0].0 as usize), LPARAM(0));
            }
            for f in old {
                let _ = DeleteObject(f);
            }
            let width = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(1180);
            let height = args.get(5).and_then(|s| s.parse().ok()).unwrap_or(1040);
            let _ = SetWindowPos(
                hwnd,
                None,
                0,
                0,
                s.px(width),
                s.px(height),
                SWP_NOZORDER | SWP_NOACTIVATE,
            );
            let fixture = args.get(6).map(String::as_str).unwrap_or("idle");
            if fixture != "idle" {
                s.preview = true;
                match fixture {
                    "recording" => {
                        s.job = Job::Recording;
                        s.status = "錄音中 · 無訊號（狀態預覽）".into();
                    }
                    "recording-signal" => {
                        // Synthetic preview values only; the UI labels them as non-real audio.
                        s.job = Job::Recording;
                        s.elapsed = 12.3;
                        s.bytes = 2_300_000;
                        s.status = "錄音中 · 合成預覽資料".into();
                        for i in 0..HISTORY {
                            let v = if (40..52).contains(&i) {
                                0.
                            } else if i == 100 {
                                1.
                            } else {
                                0.05 + 0.9 * (0.5 + 0.5 * (i as f32 * 0.21).sin()).powi(2)
                            };
                            s.meter.push(v);
                        }
                        s.peak = s.meter.ordered().last().unwrap_or(0.);
                    }
                    "converting" => {
                        s.job = Job::Converting;
                        s.input = Some(PathBuf::from("example-recording.wav"));
                        s.status = "編碼中（狀態預覽）".into();
                    }
                    "error" => {
                        s.error = true;
                        s.status = "找不到音訊端點 (0x80070490)，請確認播放裝置後重試。".into();
                    }
                    "import" => s.import = true,
                    _ => {}
                }
            }
            reposition(hwnd, s);
            if args.get(7).map(String::as_str) == Some("bottom") {
                s.scroll = layout(s.width).height;
                reposition(hwnd, s);
            }
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            let _ = UpdateWindow(hwnd);
            let path = PathBuf::from(args.get(2).expect("BMP output"));
            let result = crate::snapshot::save(hwnd, &path);
            let audit = audit_controls(hwnd, s);
            std::fs::write(
                path.with_extension("result.txt"),
                format!(
                    "{result:?}; renderer-dpi={dpi}; client={}x{}; scroll={}; fixture={fixture}\n{audit}",
                    s.width, s.height, s.scroll
                ),
            )
            .unwrap();
            let _ = DestroyWindow(hwnd);
            return Ok(());
        }
        let width = s.px(1180).min(GetSystemMetrics(SM_CXSCREEN) - 40);
        let height = s.px(1080).min(GetSystemMetrics(SM_CYSCREEN) - 64);
        let _ = SetWindowPos(
            hwnd,
            None,
            0,
            0,
            width,
            height,
            SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE,
        );
        reposition(hwnd, s);
        let _ = ShowWindow(hwnd, SW_SHOW);
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
            if !IsDialogMessageW(hwnd, &msg).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            } else {
                let focus = GetFocus();
                let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut State;
                if ptr.is_null() {
                    continue;
                }
                let s = &mut *ptr;
                if let Some((&id, _)) = s.controls.iter().find(|(_, h)| **h == focus) {
                    let a = s.rects[&id];
                    if a.y < s.scroll {
                        s.scroll = a.y - 16;
                        reposition(hwnd, s);
                    } else if a.y + a.h > s.scroll + s.height {
                        s.scroll = a.y + a.h - s.height + 16;
                        reposition(hwnd, s);
                    }
                }
            }
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn responsive_cards_do_not_overlap() {
        for width in [680, 800, 960, 1180, 1500] {
            let l = layout(width);
            assert!(l.source.w >= 480);
            assert!(l.record.y >= l.source.y + l.source.h);
            assert!(l.export.y >= l.files.y + l.files.h);
            assert!(l.main.x + l.main.w <= width);
        }
    }
    #[test]
    fn silence_is_zero_meter_and_time_is_real() {
        assert_eq!(db(0.), -60.);
        assert_eq!(db(f32::NAN), -60.);
        assert!((db(0.1) + 20.).abs() < 0.001);
        assert_eq!(clock(65.2), "01:05.2");
    }
    #[test]
    fn history_ring_keeps_newest_in_order() {
        let mut m = Meter::default();
        for v in [0.1, 0.2, 0.3] {
            m.push(v);
        }
        assert_eq!(m.ordered().collect::<Vec<_>>(), vec![0.1, 0.2, 0.3]);
        for i in 0..HISTORY + 5 {
            m.push(i as f32 / 1000.);
        }
        let got: Vec<f32> = m.ordered().collect();
        assert_eq!(got.len(), HISTORY);
        assert!((got[0] - 5. / 1000.).abs() < 1e-6);
        assert!((got[HISTORY - 1] - (HISTORY + 4) as f32 / 1000.).abs() < 1e-6);
        assert!(got.windows(2).all(|w| w[0] < w[1]));
    }
    #[test]
    fn peak_hold_keeps_max_and_ignores_nan() {
        let mut m = Meter::default();
        for v in [0.2, 0.5, 0.1, f32::NAN] {
            m.push(v);
        }
        assert_eq!(m.hold, 0.5);
        assert_eq!(m.ordered().last(), Some(0.));
    }
    #[test]
    fn db_scale_maps_to_span_and_colors() {
        assert_eq!(db_pos(-60., 100), 0);
        assert_eq!(db_pos(0., 100), 100);
        assert_eq!(db_pos(-30., 100), 50);
        assert_eq!(db_pos(-90., 100), 0);
        assert_eq!(db_pos(db(0.), 52), 0, "silence draws no bar");
        assert_eq!(level_color(-20.), METER_OK);
        assert_eq!(level_color(-6.), METER_WARN);
        assert_eq!(level_color(0.), METER_CLIP);
    }
    #[test]
    fn layout_keeps_record_card_and_export_apart() {
        for width in [680, 800, 960, 1180, 1500] {
            let l = layout(width);
            assert!(l.record.h >= 300);
            assert!(l.export.y >= l.record.y + l.record.h);
            assert!(l.export.y >= l.files.y + l.files.h);
        }
    }
}
