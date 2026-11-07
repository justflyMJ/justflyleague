/**
 * 飛行日常無人機足球聯賽 - 後台寫入服務 (Google Apps Script)
 *
 * 帳號密碼存放方式:
 *   存在 Apps Script 的「指令碼屬性」,只有專案擁有者能看到,
 *   而且存的是加鹽雜湊值,不是明碼,也不在 Google Sheet 裡,
 *   所以不會被「知道連結的人可檢視」的試算表讀到。
 *
 * 資料來源 Google Sheet 的 ID 也存在同一個地方(指令碼屬性 SHEET_ID),
 *   由後台「系統設定」頁面修改。沒有設定時,使用「綁定這個 Apps Script 的那份試算表」。
 *   首頁不會拿到試算表 ID:它向本服務要資料(?action=publicData),
 *   由本服務替它讀取試算表,所以 ID 不會出現在網頁原始碼或網路請求裡。
 *   本檔案請不要把 ID 寫死在程式碼裡。
 *
 * 預設帳號 admin / 密碼 1234(尚未修改過密碼時有效)。
 * 第一次登入後請立刻到「帳號設定」修改。
 *
 * 忘記密碼:在 Apps Script 編輯器選擇函式 resetAdmin 並執行,
 *   就會恢復成預設帳號 admin / 1234。
 *
 * 部署:部署 → 新增部署作業 → 網頁應用程式
 *   執行身分:我;誰可以存取:所有人 → 複製 /exec 網址貼到 admin.html。
 *   之後修改本檔,需「管理部署作業 → 編輯 → 新版本」才會生效。
 */

// ===== 設定區 =====
const TEAMS_SHEET = 'Teams';
const DEFAULT_USER = 'admin';
const DEFAULT_PASS = '1234';
const MAX_FAILS = 5;          // 連續錯誤幾次後鎖定
const LOCK_SECONDS = 300;     // 鎖定秒數

// 賽事分頁欄位位置(從 1 開始,A=1)。
// 需與首頁 index.html 讀取位置一致:
// 日期=A、場次=B、主隊名稱=D、客隊名稱=F、主隊得分=H、客隊得分=I
// C、E、G 沒用到可設為 0。
const COL = {
  date: 1,
  matchNo: 2,
  homeId: 3,
  homeName: 4,
  vs: 5,
  awayName: 6,
  awayId: 7,
  homeScore: 8,
  awayScore: 9
};
// ==================

function doGet(e) {
  const action = e && e.parameter && e.parameter.action;
  if (action === 'publicData') {
    return json_(publicData_());
  }
  return json_({ ok: true, message: '飛行日常聯賽後台服務運作中' });
}

// 提供首頁顯示用的公開資料:排行榜、隊伍(只有編號與名稱)、各日期的對戰紀錄。
// 不包含試算表 ID,也不包含隊員姓名等其他欄位。
function publicData_() {
  try {
    const book = ss_();

    const lb = book.getSheetByName('Leaderboard');
    let leaderboard = [];
    if (lb && lb.getLastRow() >= 1) {
      leaderboard = lb.getRange(1, 1, lb.getLastRow(), Math.min(Math.max(lb.getLastColumn(), 1), 11)).getDisplayValues();
    }

    const teams = [];
    const ts = book.getSheetByName(TEAMS_SHEET);
    if (ts) {
      const last = lastTeamRow_(ts);
      if (last >= 2) {
        ts.getRange(2, 1, last - 1, 2).getDisplayValues().forEach(function (r) {
          if (String(r[1]).trim() !== '') teams.push({ id: r[0], name: r[1] });
        });
      }
    }

    const sheets = [];
    const matches = {};
    book.getSheets().forEach(function (sh) {
      const name = sh.getName();
      if (!/^\d{3,4}$/.test(name)) return;
      sheets.push(name);
      const lastRow = sh.getLastRow();
      matches[name] = lastRow >= 1
        ? sh.getRange(1, 1, lastRow, 9).getDisplayValues()
        : [];
    });

    return { ok: true, leaderboard: leaderboard, teams: teams, sheets: sheets, matches: matches };
  } catch (err) {
    return { ok: false, error: '後台無法讀取試算表' };
  }
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: '請求格式錯誤' });
  }

  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('fails') || 0);
  if (fails >= MAX_FAILS) {
    return json_({ ok: false, error: '嘗試次數過多,請 5 分鐘後再試' });
  }

  const auth = verify_(req.user, req.password);
  if (!auth.ok) {
    cache.put('fails', String(fails + 1), LOCK_SECONDS);
    Utilities.sleep(1000);
    return json_({ ok: false, error: '帳號或密碼錯誤' });
  }
  cache.remove('fails');

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    switch (req.action) {
      case 'login':
        return json_({ ok: true, mustChange: auth.mustChange });
      case 'changeCredentials':
        return json_(changeCredentials_(req));
      case 'addMatch':
        return json_(addMatch_(req));
      case 'addTeam':
        return json_(addTeam_(req));
      case 'listTeams':
        return json_(listTeams_());
      case 'getSettings':
        return json_(getSettings_());
      case 'saveSettings':
        return json_(saveSettings_(req));
      default:
        return json_({ ok: false, error: '未知的操作' });
    }
  } catch (err) {
    return json_({ ok: false, error: '伺服器錯誤:' + err.message });
  } finally {
    try { lock.releaseLock(); } catch (x) {}
  }
}

/* ---------- 帳號密碼 ---------- */

function hashPw_(password, salt) {
  let h = salt + '|' + password;
  for (let i = 0; i < 100; i++) {
    const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + h + password, Utilities.Charset.UTF_8);
    h = bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
  }
  return h;
}

function safeEqual_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function verify_(user, password) {
  const props = PropertiesService.getScriptProperties();
  const hash = props.getProperty('ADMIN_HASH');
  user = String(user || '').trim();
  password = String(password || '');

  if (!hash) {
    // 尚未修改過:使用預設帳密
    const ok = safeEqual_(user, DEFAULT_USER) && safeEqual_(password, DEFAULT_PASS);
    return { ok: ok, mustChange: true };
  }
  const storedUser = props.getProperty('ADMIN_USER') || DEFAULT_USER;
  const salt = props.getProperty('ADMIN_SALT') || '';
  const ok = safeEqual_(user, storedUser) && safeEqual_(hashPw_(password, salt), hash);
  return { ok: ok, mustChange: false };
}

function changeCredentials_(req) {
  const newUser = String(req.newUser || '').trim();
  const newPass = String(req.newPassword || '');
  if (!newUser) return { ok: false, error: '請輸入帳號' };
  if (newPass.length < 6) return { ok: false, error: '新密碼至少 6 個字元' };
  if (newPass === DEFAULT_PASS) return { ok: false, error: '新密碼不可使用預設密碼' };

  const salt = Utilities.getUuid();
  const props = PropertiesService.getScriptProperties();
  props.setProperties({
    ADMIN_USER: newUser,
    ADMIN_SALT: salt,
    ADMIN_HASH: hashPw_(newPass, salt)
  });
  return { ok: true };
}

/** 忘記密碼時,在 Apps Script 編輯器手動執行這個函式,恢復成 admin / 1234 */
function resetAdmin() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty('ADMIN_USER');
  props.deleteProperty('ADMIN_SALT');
  props.deleteProperty('ADMIN_HASH');
  CacheService.getScriptCache().remove('fails');
}

/* ---------- 資料寫入 ---------- */

// Teams 分頁:A=隊伍編號、B=隊伍名稱(與首頁讀取位置一致),
// 其他欄位依「標題列文字」尋找;找不到就自動在最右邊新增該欄標題。
const TEAM_FIELDS = [
  { key: 'school',      header: '代表學校或單位' },
  { key: 'captain',     header: '隊長/聯絡人' },
  { key: 'captainUnit', header: '隊長代表單位' },
  { key: 'member1',     header: '隊員1' },
  { key: 'member1Unit', header: '隊員1代表單位' },
  { key: 'member2',     header: '隊員2' },
  { key: 'member2Unit', header: '隊員2代表單位' }
];

// 目前使用的試算表:優先用「系統設定」存的 ID,沒有設定就用綁定的那一份
function ss_() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  const active = SpreadsheetApp.getActive();
  if (!active) throw new Error('找不到試算表,請在後台「系統設定」設定 Google Sheet ID');
  return active;
}

/* ---------- 系統設定 ---------- */

// 從網址或純 ID 取出試算表 ID;空字串代表清除設定
function parseSheetId_(input) {
  const text = String(input || '').trim();
  if (!text) return '';
  const m = text.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(text)) return text;
  return null;
}

function getSettings_() {
  const stored = PropertiesService.getScriptProperties().getProperty('SHEET_ID') || '';
  try {
    const book = ss_();
    return {
      ok: true,
      sheetId: book.getId(),
      custom: stored !== '',
      title: book.getName(),
      sheets: book.getSheets().map(function (sh) { return sh.getName(); })
    };
  } catch (err) {
    return { ok: true, sheetId: stored, custom: true, title: '', sheets: [],
             warning: '目前設定的試算表無法開啟:' + err.message };
  }
}

function saveSettings_(req) {
  const id = parseSheetId_(req.sheetId);
  const props = PropertiesService.getScriptProperties();

  if (id === null) {
    return { ok: false, error: '格式不正確,請貼上試算表網址,或網址中 /d/ 後面那一長串 ID' };
  }
  if (id === '') {
    props.deleteProperty('SHEET_ID');   // 恢復預設:使用綁定的試算表
    const res = getSettings_();
    res.message = '已恢復為預設試算表';
    return res;
  }

  let book;
  try {
    book = SpreadsheetApp.openById(id);
  } catch (err) {
    return { ok: false, error: '無法開啟這份試算表,請確認 ID 正確,且執行這個 Apps Script 的 Google 帳號有權限(要能編輯才能寫入資料)' };
  }

  const names = book.getSheets().map(function (sh) { return sh.getName(); });
  const warnings = [];
  ['Leaderboard', 'Teams'].forEach(function (n) {
    if (names.indexOf(n) === -1) warnings.push('找不到分頁「' + n + '」,首頁會讀不到資料');
  });

  props.setProperty('SHEET_ID', id);
  return { ok: true, sheetId: id, custom: true, title: book.getName(), sheets: names, warnings: warnings,
           message: '已儲存' };
}

function teamsSheet_() {
  const sheet = ss_().getSheetByName(TEAMS_SHEET);
  if (!sheet) throw new Error('找不到 Teams 分頁');
  return sheet;
}

// 回傳各欄位所在的欄號(從 1 開始;0 代表試算表沒有該欄)
function teamsLayout_(sheet, createMissing) {
  const lastCol = Math.max(sheet.getLastColumn(), 2);
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  if (createMissing) {
    if (headers[0] === '') { headers[0] = '隊伍編號'; sheet.getRange(1, 1).setValue('隊伍編號'); }
    if (headers[1] === '') { headers[1] = '隊伍名稱'; sheet.getRange(1, 2).setValue('隊伍名稱'); }
  }
  const map = {};
  TEAM_FIELDS.forEach(function (f) {
    let idx = headers.indexOf(f.header);
    if (idx === -1 && createMissing) {
      headers.push(f.header);
      idx = headers.length - 1;
      sheet.getRange(1, idx + 1).setValue(f.header);
    }
    map[f.key] = idx === -1 ? 0 : idx + 1;
  });
  return map;
}

// 最後一筆有資料的列(以 A、B 欄判斷),新資料接在它的下一列
function lastTeamRow_(sheet) {
  const n = sheet.getLastRow();
  if (n < 2) return 1;
  const v = sheet.getRange(1, 1, n, 2).getValues();
  for (let i = n - 1; i >= 1; i--) {
    if (String(v[i][0]).trim() !== '' || String(v[i][1]).trim() !== '') return i + 1;
  }
  return 1;
}

function addTeam_(req) {
  const clean = function (v) { return String(v || '').trim().slice(0, 100); };
  const data = {
    name: clean(req.name),
    school: clean(req.school),
    captain: clean(req.captain),
    captainUnit: clean(req.captainUnit),
    member1: clean(req.member1),
    member1Unit: clean(req.member1Unit),
    member2: clean(req.member2),
    member2Unit: clean(req.member2Unit)
  };
  if (!data.name) return { ok: false, error: '請輸入隊伍名稱' };
  if (!data.school) return { ok: false, error: '請輸入代表學校或單位' };
  if (!data.captain) return { ok: false, error: '請輸入隊長/聯絡人' };

  const sheet = teamsSheet_();
  const last = lastTeamRow_(sheet);

  let maxId = 0;
  if (last >= 2) {
    const rows = sheet.getRange(2, 1, last - 1, 2).getValues();
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][1]).trim() === data.name) {
        return { ok: false, error: '隊伍「' + data.name + '」已存在' };
      }
      const n = Number(rows[i][0]);
      if (!isNaN(n) && rows[i][0] !== '' && n > maxId) maxId = n;
    }
  }

  const map = teamsLayout_(sheet, true);
  const row = last + 1;
  const id = maxId + 1;

  sheet.getRange(row, 1).setNumberFormat('General').setValue(id);
  sheet.getRange(row, 2).setNumberFormat('@').setValue(data.name);   // 文字格式,避免被當成公式
  TEAM_FIELDS.forEach(function (f) {
    sheet.getRange(row, map[f.key]).setNumberFormat('@').setValue(data[f.key]);
  });

  return { ok: true, id: id, name: data.name };
}

function listTeams_() {
  const sheet = teamsSheet_();
  const map = teamsLayout_(sheet, false);
  const last = lastTeamRow_(sheet);
  const lastCol = Math.max(sheet.getLastColumn(), 2);
  const rows = last >= 2 ? sheet.getRange(2, 1, last - 1, lastCol).getDisplayValues() : [];
  const teams = [];
  rows.forEach(function (r) {
    if (String(r[1]).trim() === '') return;
    const t = { id: r[0], name: r[1] };
    TEAM_FIELDS.forEach(function (f) { t[f.key] = map[f.key] ? r[map[f.key] - 1] : ''; });
    teams.push(t);
  });
  return { ok: true, teams: teams };
}

function addMatch_(req) {
  const ss = ss_();
  const sheetName = String(req.sheetName || '').trim(); // 例如 "1025"
  const home = String(req.home || '').trim();
  const away = String(req.away || '').trim();
  const hs = Number(req.homeScore);
  const as = Number(req.awayScore);

  if (!/^\d{3,4}$/.test(sheetName)) return { ok: false, error: '日期分頁名稱格式錯誤' };
  if (!home || !away || home === away) return { ok: false, error: '請選擇兩支不同的隊伍' };
  if (!Number.isInteger(hs) || !Number.isInteger(as) || hs < 0 || as < 0) {
    return { ok: false, error: '比分必須是 0 以上的整數' };
  }

  const teamIds = {};
  const teamsSheet = ss.getSheetByName(TEAMS_SHEET);
  if (teamsSheet) {
    const t = teamsSheet.getDataRange().getValues();
    for (let i = 1; i < t.length; i++) teamIds[String(t[i][1]).trim()] = t[i][0];
  }
  if (!(home in teamIds) || !(away in teamIds)) {
    return { ok: false, error: '隊伍不在 Teams 名單內' };
  }

  let sheet = ss.getSheetByName(sheetName);
  let created = false;
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    const header = [];
    header[COL.date - 1] = '日期';
    header[COL.matchNo - 1] = '場次';
    if (COL.homeId) header[COL.homeId - 1] = '主隊編號';
    header[COL.homeName - 1] = '主隊名稱';
    header[COL.awayName - 1] = '客隊名稱';
    if (COL.awayId) header[COL.awayId - 1] = '客隊編號';
    header[COL.homeScore - 1] = '主隊得分';
    header[COL.awayScore - 1] = '客隊得分';
    sheet.getRange(1, 1, 1, header.length).setValues([Array.from(header, function (v) { return v || ''; })]);
    created = true;
  }

  const lastRow = sheet.getLastRow();
  let lastNo = 0;
  if (lastRow >= 2) {
    const nos = sheet.getRange(2, COL.matchNo, lastRow - 1, 1).getValues();
    for (let i = 0; i < nos.length; i++) {
      const n = Number(nos[i][0]);
      if (!isNaN(n) && nos[i][0] !== '' && n > lastNo) lastNo = n;
    }
  }
  const matchNo = req.matchNo ? Number(req.matchNo) : lastNo + 1;
  const row = lastRow + 1;

  const maxCol = Math.max(COL.date, COL.matchNo, COL.homeId, COL.homeName, COL.vs,
                          COL.awayName, COL.awayId, COL.homeScore, COL.awayScore);
  const values = new Array(maxCol).fill('');
  values[COL.date - 1] = String(req.dateText || '');
  values[COL.matchNo - 1] = matchNo;
  if (COL.homeId) values[COL.homeId - 1] = teamIds[home];
  values[COL.homeName - 1] = home;
  if (COL.vs) values[COL.vs - 1] = 'VS';
  values[COL.awayName - 1] = away;
  if (COL.awayId) values[COL.awayId - 1] = teamIds[away];
  values[COL.homeScore - 1] = hs;
  values[COL.awayScore - 1] = as;

  const range = sheet.getRange(row, 1, 1, maxCol);
  range.setNumberFormat('@');
  range.setValues([values]);
  sheet.getRange(row, COL.matchNo).setNumberFormat('General').setValue(matchNo);
  sheet.getRange(row, COL.homeScore).setNumberFormat('General').setValue(hs);
  sheet.getRange(row, COL.awayScore).setNumberFormat('General').setValue(as);

  return { ok: true, sheetName: sheetName, matchNo: matchNo, createdSheet: created };
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
