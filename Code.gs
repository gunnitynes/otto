/**
 * otto — the backend.
 * Every photo or music file sent from the page is saved into one Google Drive folder ("otto").
 * Folders that people upload are recreated inside it, so their structure is kept.
 *
 * Setup (once): paste this into a new Apps Script project, run `setup` and allow access,
 * then Deploy ▸ New deployment ▸ Web app, Execute as: Me, Who has access: Anyone.
 *
 * Viewing: GET ?list=1 returns every file (newest last) so the gallery page can show them.
 * Each file is shared "anyone with the link can view" so the browser can load the picture
 * or the song straight from Drive; files can't be found without the list.
 * To hide something from the gallery, move it to the trash in Drive.
 *
 * Most files arrive in pieces: op 'start' opens a Drive resumable upload. The page sends the
 * pieces straight to Drive (fast); if that is refused it falls back to op 'piece', which
 * forwards each piece from here (slow: this service takes data in at ~0.3 MB/s).
 * op 'status' asks Drive how much it has, and when it has everything it shares the file.
 */

const FOLDER_NAME = 'otto';
const MAX_BYTES = 35 * 1024 * 1024;              // one-request uploads (photos, most music)
const BIG_MAX = 5 * 1024 * 1024 * 1024;            // pieced uploads (videos, big files)
const PIECE = 16 * 1024 * 1024;                    // a multiple of 256 KB, as Drive requires
const MAX_DEPTH = 6;
const ORIGINS = /^(https:\/\/gunnartynes\.com|https:\/\/gunnitynes\.github\.io|http:\/\/127\.0\.0\.1:\d+|http:\/\/localhost:\d+)$/;

function setup() {
  const folder = root_();
  Logger.log('Photos will be saved in: ' + folder.getUrl());
}

// Run once after adding the gallery: shares the files that were uploaded before it existed.
function shareAll() {
  let n = 0;
  walk_(root_(), '', (file) => { share_(file); n++; });
  CacheService.getScriptCache().remove('list');
  Logger.log('Shared ' + n + ' files for viewing.');
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.list) return json_({ ok: true, files: list_() });
  if (p.file) return serve_(p.file);
  return json_({ ok: true, app: 'otto' });
}

// Music is played through here: Drive refuses direct audio requests from other websites.
// Only files inside the otto folder are handed out.
function serve_(id) {
  try {
    const f = DriveApp.getFileById(id);
    if (f.isTrashed() || !inside_(f)) return json_({ ok: false, error: 'not found' });
    const b = f.getBlob();
    return json_({ ok: true, type: b.getContentType(), data: Utilities.base64Encode(b.getBytes()) });
  } catch (err) {
    return json_({ ok: false, error: 'not found' });
  }
}

function inside_(file) {
  const rootId = root_().getId();
  let level = [file.getParents()];
  for (let depth = 0; depth <= MAX_DEPTH + 1 && level.length; depth++) {
    const next = [];
    for (const it of level) {
      while (it.hasNext()) {
        const d = it.next();
        if (d.getId() === rootId) return true;
        next.push(d.getParents());
      }
    }
    level = next;
  }
  return false;
}

function list_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('list');
  if (hit) return JSON.parse(hit);
  const out = [];
  walk_(root_(), '', (file, path) => out.push({
    id: file.getId(),
    name: file.getName(),
    type: file.getMimeType(),
    path: path,
    size: file.getSize(),
    t: file.getDateCreated().getTime()
  }));
  out.sort((a, b) => a.t - b.t);
  const text = JSON.stringify(out);
  if (text.length < 95000) cache.put('list', text, 60);
  return out;
}

function walk_(folder, path, fn) {
  const files = folder.getFiles();
  while (files.hasNext()) {
    const f = files.next();
    if (!f.isTrashed()) fn(f, path);
  }
  const subs = folder.getFolders();
  while (subs.hasNext()) {
    const d = subs.next();
    if (!d.isTrashed()) walk_(d, path ? path + '/' + d.getName() : d.getName(), fn);
  }
}

function share_(file) {
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
}

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    if (req.op === 'start') return json_(start_(req));
    if (req.op === 'piece') return json_(piece_(req));
    if (req.op === 'status') return json_(status_(req));
    if (!req.name || !req.data) return json_({ ok: false, error: 'missing file' });

    const bytes = Utilities.base64Decode(req.data);
    if (bytes.length > MAX_BYTES) return json_({ ok: false, error: 'too large' });
    if (!isImage_(bytes)) return json_({ ok: false, error: 'not a photo' });

    const folder = folderFor_(req.path || '');
    const blob = Utilities.newBlob(bytes, req.type || 'application/octet-stream', clean_(req.name));
    const file = folder.createFile(blob);
    share_(file);
    CacheService.getScriptCache().remove('list');
    return json_({ ok: true, id: file.getId() });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

// ---- big files, in pieces ----------------------------------------------------
function start_(req) {
  const size = Number(req.size);
  if (!req.name || !(size > 0) || size > BIG_MAX) return { ok: false, error: 'bad size' };
  if (!isImage_(Utilities.base64Decode(req.head || ''))) return { ok: false, error: 'not a photo' };
  const folder = folderFor_(req.path || '');
  const type = req.type || 'application/octet-stream';
  // When the page says where it runs, Drive lets that page send the pieces itself (much faster
  // than through here). The upload address only allows filling this one new file.
  const origin = ORIGINS.test(req.origin || '') ? req.origin : '';
  const r = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    headers: Object.assign({
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      'X-Upload-Content-Type': type,
      'X-Upload-Content-Length': String(size)
    }, origin ? { Origin: origin } : {}),
    payload: JSON.stringify({ name: clean_(req.name), parents: [folder.getId()] }),
    muteHttpExceptions: true
  });
  if (r.getResponseCode() !== 200) return { ok: false, error: 'start ' + r.getResponseCode() };
  const h = r.getHeaders();
  const loc = h.Location || h.location;
  if (!loc) return { ok: false, error: 'no session' };
  const key = Utilities.getUuid();
  CacheService.getScriptCache().put('up_' + key, JSON.stringify({ loc: loc, size: size }), 21600);
  return origin ? { ok: true, key: key, piece: PIECE, url: loc } : { ok: true, key: key, piece: PIECE };
}

function piece_(req) {
  const s = session_(req.key);
  if (!s) return { ok: false, error: 'expired' };
  const bytes = Utilities.base64Decode(req.data || '');
  const from = Number(req.offset);
  if (!bytes.length || from < 0 || from + bytes.length > s.size) return { ok: false, error: 'bad piece' };
  const r = UrlFetchApp.fetch(s.loc, {
    method: 'put',
    contentType: 'application/octet-stream',
    headers: { 'Content-Range': 'bytes ' + from + '-' + (from + bytes.length - 1) + '/' + s.size },
    payload: bytes,
    muteHttpExceptions: true
  });
  return answer_(r, req.key);
}

function status_(req) {
  const s = session_(req.key);
  if (!s) return { ok: false, error: 'expired' };
  const r = UrlFetchApp.fetch(s.loc, {
    method: 'put',
    headers: { 'Content-Range': 'bytes */' + s.size },
    payload: '',
    muteHttpExceptions: true
  });
  return answer_(r, req.key);
}

function session_(key) {
  const v = key && CacheService.getScriptCache().get('up_' + key);
  return v ? JSON.parse(v) : null;
}

function answer_(r, key) {
  const code = r.getResponseCode();
  if (code === 200 || code === 201) {
    const id = JSON.parse(r.getContentText()).id;
    share_(DriveApp.getFileById(id));
    const cache = CacheService.getScriptCache();
    cache.remove('list');
    cache.remove('up_' + key);
    return { ok: true, done: true, id: id };
  }
  if (code === 308) {
    const h = r.getHeaders();
    const range = h.Range || h.range;            // e.g. "bytes=0-16777215"
    return { ok: true, next: range ? Number(String(range).split('-')[1]) + 1 : 0 };
  }
  return { ok: false, error: 'upload ' + code };
}

// The "otto" folder in My Drive, created on first use.
function root_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('ROOT_ID');
  if (id) {
    try {
      const f = DriveApp.getFolderById(id);
      if (!f.isTrashed()) return f;
    } catch (e) {}
  }
  const f = DriveApp.createFolder(FOLDER_NAME);
  props.setProperty('ROOT_ID', f.getId());
  return f;
}

// "Holiday/Day 1" -> otto/Holiday/Day 1. A lock stops two parallel uploads
// from creating the same subfolder twice.
function folderFor_(path) {
  const parts = String(path).split('/').map(clean_).filter(p => p && p !== '.' && p !== '..').slice(0, MAX_DEPTH);
  if (!parts.length) return root_();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    let folder = root_();
    for (const name of parts) {
      const it = folder.getFoldersByName(name);
      folder = it.hasNext() ? it.next() : folder.createFolder(name);
    }
    return folder;
  } finally {
    lock.releaseLock();
  }
}

// Checks the file's first bytes, not its name (photos, music and video): JPEG, PNG, GIF, WebP, BMP,
// HEIC/HEIF/AVIF/CR3 (ISO "ftyp"), TIFF and the TIFF-based raws (DNG, CR2, NEF, ARW), ORF, RW2, RAF.
function isImage_(b) {
  const h = (i) => (b[i] + 256) % 256;
  const s = (i, n) => String.fromCharCode.apply(null, Array.from({ length: n }, (_, k) => h(i + k)));
  if (b.length < 12) return false;
  if (h(0) === 0xFF && h(1) === 0xD8 && h(2) === 0xFF) return true;
  if (h(0) === 0x89 && s(1, 3) === 'PNG') return true;
  if (s(0, 4) === 'GIF8') return true;
  if (s(0, 4) === 'RIFF' && s(8, 4) === 'WEBP') return true;
  if (s(0, 2) === 'BM') return true;
  if (s(4, 4) === 'ftyp') return true;
  if (s(0, 4) === 'II*\u0000' || s(0, 4) === 'MM\u0000*') return true;
  if (s(0, 4) === 'IIRO' || s(0, 4) === 'IIRS' || s(0, 4) === 'IIU\u0000') return true;
  if (s(0, 8) === 'FUJIFILM') return true;
  // Music: MP3 (ID3 tag or frame sync, also AAC/ADTS), WAV, AIFF, FLAC, Ogg. M4A is caught by "ftyp" above.
  if (s(0, 3) === 'ID3') return true;
  if (h(0) === 0xFF && (h(1) & 0xE0) === 0xE0) return true;
  if (s(0, 4) === 'RIFF' && s(8, 4) === 'WAVE') return true;
  if (s(0, 4) === 'FORM' && (s(8, 4) === 'AIFF' || s(8, 4) === 'AIFC')) return true;
  if (s(0, 4) === 'fLaC' || s(0, 4) === 'OggS') return true;
  // Video: MP4/MOV/M4V/3GP are caught by "ftyp" above; older QuickTime, AVI, MKV/WebM, MPEG.
  if (['moov', 'mdat', 'wide', 'free', 'skip', 'pnot'].indexOf(s(4, 4)) >= 0) return true;
  if (s(0, 4) === 'RIFF' && s(8, 3) === 'AVI') return true;
  if (h(0) === 0x1A && h(1) === 0x45 && h(2) === 0xDF && h(3) === 0xA3) return true;
  if (h(0) === 0x00 && h(1) === 0x00 && h(2) === 0x01 && (h(3) === 0xBA || h(3) === 0xB3)) return true;
  // MPEG transport stream: a sync byte every 188 bytes (.ts), or every 192 after a 4-byte stamp (.mts/.m2ts).
  if (b.length > 380 && h(0) === 0x47 && h(188) === 0x47 && h(376) === 0x47) return true;
  if (b.length > 390 && h(4) === 0x47 && h(196) === 0x47 && h(388) === 0x47) return true;
  return false;
}

function clean_(s) {
  return String(s).replace(/[\\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 200);
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
