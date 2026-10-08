// Pure helper for MP3 download names. No DOM or chrome access, so it runs under node --test.
const STEM_MAX = 70;
const SUFFIX_MAX = 20;

// Drops a trailing site suffix such as " | Suno" when it is short and the title has other content.
function stripSiteSuffix(title) {
  const i = title.lastIndexOf(' | ');
  if (i < 0) return title;
  const head = title.slice(0, i).trim();
  const tail = title.slice(i + 3).trim();
  return head && tail.length <= SUFFIX_MAX ? head : title;
}

// Same sanitising rules as helpers.js suggestedName: invalid filename chars become '_', no trailing dots or spaces.
function cleanTitle(raw) {
  return String(raw ?? '').normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .trim().replace(/[. ]+$/g, '')
    .slice(0, STEM_MAX).replace(/[. ]+$/g, '').trim();
}

function localStamp(date) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

// Returns '<title>-<YYYYMMDD-HHMMSS>' (local time), without extension; saved under Downloads/ClearAudio/.
export function mp3FileStem(title, date = new Date()) {
  const stem = cleanTitle(stripSiteSuffix(String(title ?? '').normalize('NFC').trim())) || 'tab-audio';
  return `${stem}-${localStamp(date)}`;
}
