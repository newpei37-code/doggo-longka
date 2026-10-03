import * as path from 'path';
import { google, sheets_v4 } from 'googleapis';
import { telegramConfig } from '../config/telegram.config';

export type GroupKind = 'that' | 'ao';

const DEFAULT_CA_COUNT = 17;
const DAY_FIRST_COL = 1; // B (A=0)
const DAY_LAST_COL = 31; // AF

function getMonthVN(): number {
  const s = new Date().toLocaleString('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    month: 'numeric',
  });
  const m = Number.parseInt(s, 10);
  if (!Number.isFinite(m) || m < 1 || m > 12) return 1;
  return m;
}

function getSheetName(group: GroupKind): string {
  const cfg = telegramConfig as Record<string, unknown>;
  const month = getMonthVN();
  const base =
    group === 'that'
      ? String(cfg.google_sheet_tab_that ?? 'Thật')
      : String(cfg.google_sheet_tab_ao ?? 'Ảo');
  return `${base}-${month}`;
}

function toSheetRangePrefix(sheetName: string): string {
  // A1 notation: tên sheet có dấu/khoảng trắng phải bọc bằng '
  const escaped = sheetName.replace(/'/g, "''");
  return `'${escaped}'`;
}

function getFirstDataRow(): number {
  const n = (telegramConfig as any).google_sheet_first_data_row;
  return typeof n === 'number' && n >= 1 ? n : 3;
}

function getConfiguredCaCount(): number {
  const v = Number((telegramConfig as any).so_ca ?? DEFAULT_CA_COUNT);
  if (!Number.isFinite(v) || v < 1) return DEFAULT_CA_COUNT;
  return Math.floor(v);
}

function getDayOfMonthVN(): number {
  const s = new Date().toLocaleString('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: 'numeric',
  });
  const d = Number.parseInt(s, 10);
  if (!Number.isFinite(d) || d < 1 || d > 31) return 1;
  return d;
}

function toA1Column(colIndex0Based: number): string {
  let n = colIndex0Based + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

async function getSheetsClient(): Promise<{
  sheets: sheets_v4.Sheets;
  spreadsheetId: string;
}> {
  const cfg = telegramConfig as Record<string, unknown>;
  const spreadsheetId = String(cfg.google_sheet_id ?? '').trim();
  if (!spreadsheetId) {
    throw new Error('Thiếu google_sheet_id trong config.json');
  }

  const pathRaw =
    String(cfg.google_service_account_path ?? 'google-service-account.json') ||
    'google-service-account.json';
  const credentialPath = path.isAbsolute(pathRaw)
    ? pathRaw
    : path.join(process.cwd(), pathRaw);

  const auth = new google.auth.GoogleAuth({
    keyFile: credentialPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const sheets = google.sheets({ version: 'v4', auth });
  return { sheets, spreadsheetId };
}

async function ensureSheetExists(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName: string,
): Promise<void> {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = (meta.data.sheets ?? []).some(
    (s) => s.properties?.title === sheetName,
  );
  if (exists) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: { title: sheetName },
          },
        },
      ],
    },
  });
}

async function ensureCaLayout(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName: string,
): Promise<void> {
  const sheetPrefix = toSheetRangePrefix(sheetName);
  const caCount = getConfiguredCaCount();
  const caStartRow = 2; // A2 = Ca 1
  const caEndRow = caStartRow + caCount - 1;
  const totalDayRow = caEndRow + 1;
  const totalMonthRow = caEndRow + 2;

  // A1 để trống, A2..A(1+so_ca) = Ca 1..Ca N
  const colAValues: string[][] = [['']];
  for (let i = 1; i <= caCount; i++) {
    colAValues.push([`Ca ${i}`]);
  }
  colAValues.push(['Tổng ngày']);
  colAValues.push(['Tổng tháng']);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetPrefix}!A1:A${totalMonthRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: colAValues },
  });

  // Hàng 1 từ cột B là ngày trong tháng: 1..31
  const dayHeaders = Array.from({ length: 31 }, (_, i) => i + 1);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetPrefix}!B1:AF1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [dayHeaders] },
  });

  // Tổng ngày: mỗi cột ngày = SUM các Ca của cột đó
  const totalDayFormulas: string[] = [];
  for (let c = DAY_FIRST_COL; c <= DAY_LAST_COL; c++) {
    const col = toA1Column(c);
    totalDayFormulas.push(`=SUM(${col}${caStartRow}:${col}${caEndRow})`);
  }
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetPrefix}!B${totalDayRow}:AF${totalDayRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [totalDayFormulas] },
  });

  // Tổng tháng: đặt ở B(row), cộng toàn bộ Tổng ngày trong tháng
  const totalMonthFormula = `=SUM(B${totalDayRow}:AF${totalDayRow})`;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetPrefix}!B${totalMonthRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[totalMonthFormula]] },
  });
}

export function isGoogleSheetConfigured(): boolean {
  const id = String((telegramConfig as any).google_sheet_id ?? '').trim();
  return id.length > 0;
}

/**
 * Layout:
 * - A1 trống
 * - A2..A(1+so_ca): Ca 1..Ca N
 * - Hàng 1 từ B..AF: ngày trong tháng 1..31
 * - Ô giao nhau (Ca, ngày) lưu lời/lỗ ca đó
 * - Có dòng tổng ngày và tổng tháng bằng công thức
 */
export async function appendCaProfitToGoogleSheet(
  group: GroupKind,
  amount: number,
  caIndex?: number,
): Promise<void> {
  if (!isGoogleSheetConfigured()) return;

  const { sheets, spreadsheetId } = await getSheetsClient();
  const sheetName = getSheetName(group);
  const sheetPrefix = toSheetRangePrefix(sheetName);
  await ensureSheetExists(sheets, spreadsheetId, sheetName);
  await ensureCaLayout(sheets, spreadsheetId, sheetName);
  const caCount = getConfiguredCaCount();
  const day = getDayOfMonthVN();

  const resolvedCa =
    typeof caIndex === 'number' && Number.isFinite(caIndex)
      ? Math.floor(caIndex)
      : 1;
  const clampedCa = Math.min(Math.max(resolvedCa, 1), caCount);

  const targetRow = 1 + clampedCa; // A2 = Ca 1
  const targetCol = DAY_FIRST_COL + (day - 1); // B + (day-1)
  const colLetter = toA1Column(targetCol);
  const rounded = Math.round(amount);

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetPrefix}!${colLetter}${targetRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[rounded]],
    },
  });
}
