"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.isGoogleSheetConfigured = isGoogleSheetConfigured;
exports.appendCaProfitToGoogleSheet = appendCaProfitToGoogleSheet;
const path = __importStar(require("path"));
const googleapis_1 = require("googleapis");
const telegram_config_1 = require("../config/telegram.config");
const DEFAULT_CA_COUNT = 17;
const DAY_FIRST_COL = 1;
const DAY_LAST_COL = 31;
function getMonthVN() {
    const s = new Date().toLocaleString('en-GB', {
        timeZone: 'Asia/Ho_Chi_Minh',
        month: 'numeric',
    });
    const m = Number.parseInt(s, 10);
    if (!Number.isFinite(m) || m < 1 || m > 12)
        return 1;
    return m;
}
function getSheetName(group) {
    const cfg = telegram_config_1.telegramConfig;
    const month = getMonthVN();
    const base = group === 'that'
        ? String(cfg.google_sheet_tab_that ?? 'Thật')
        : String(cfg.google_sheet_tab_ao ?? 'Ảo');
    return `${base}-${month}`;
}
function toSheetRangePrefix(sheetName) {
    const escaped = sheetName.replace(/'/g, "''");
    return `'${escaped}'`;
}
function getFirstDataRow() {
    const n = telegram_config_1.telegramConfig.google_sheet_first_data_row;
    return typeof n === 'number' && n >= 1 ? n : 3;
}
function getConfiguredCaCount() {
    const v = Number(telegram_config_1.telegramConfig.so_ca ?? DEFAULT_CA_COUNT);
    if (!Number.isFinite(v) || v < 1)
        return DEFAULT_CA_COUNT;
    return Math.floor(v);
}
function getDayOfMonthVN() {
    const s = new Date().toLocaleString('en-GB', {
        timeZone: 'Asia/Ho_Chi_Minh',
        day: 'numeric',
    });
    const d = Number.parseInt(s, 10);
    if (!Number.isFinite(d) || d < 1 || d > 31)
        return 1;
    return d;
}
function toA1Column(colIndex0Based) {
    let n = colIndex0Based + 1;
    let out = '';
    while (n > 0) {
        const rem = (n - 1) % 26;
        out = String.fromCharCode(65 + rem) + out;
        n = Math.floor((n - 1) / 26);
    }
    return out;
}
async function getSheetsClient() {
    const cfg = telegram_config_1.telegramConfig;
    const spreadsheetId = String(cfg.google_sheet_id ?? '').trim();
    if (!spreadsheetId) {
        throw new Error('Thiếu google_sheet_id trong config.json');
    }
    const pathRaw = String(cfg.google_service_account_path ?? 'google-service-account.json') ||
        'google-service-account.json';
    const credentialPath = path.isAbsolute(pathRaw)
        ? pathRaw
        : path.join(process.cwd(), pathRaw);
    const auth = new googleapis_1.google.auth.GoogleAuth({
        keyFile: credentialPath,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = googleapis_1.google.sheets({ version: 'v4', auth });
    return { sheets, spreadsheetId };
}
async function ensureSheetExists(sheets, spreadsheetId, sheetName) {
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const exists = (meta.data.sheets ?? []).some((s) => s.properties?.title === sheetName);
    if (exists)
        return;
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
async function ensureCaLayout(sheets, spreadsheetId, sheetName) {
    const sheetPrefix = toSheetRangePrefix(sheetName);
    const caCount = getConfiguredCaCount();
    const caStartRow = 2;
    const caEndRow = caStartRow + caCount - 1;
    const totalDayRow = caEndRow + 1;
    const totalMonthRow = caEndRow + 2;
    const colAValues = [['']];
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
    const dayHeaders = Array.from({ length: 31 }, (_, i) => i + 1);
    await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetPrefix}!B1:AF1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [dayHeaders] },
    });
    const totalDayFormulas = [];
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
    const totalMonthFormula = `=SUM(B${totalDayRow}:AF${totalDayRow})`;
    await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetPrefix}!B${totalMonthRow}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[totalMonthFormula]] },
    });
}
function isGoogleSheetConfigured() {
    const id = String(telegram_config_1.telegramConfig.google_sheet_id ?? '').trim();
    return id.length > 0;
}
async function appendCaProfitToGoogleSheet(group, amount, caIndex) {
    if (!isGoogleSheetConfigured())
        return;
    const { sheets, spreadsheetId } = await getSheetsClient();
    const sheetName = getSheetName(group);
    const sheetPrefix = toSheetRangePrefix(sheetName);
    await ensureSheetExists(sheets, spreadsheetId, sheetName);
    await ensureCaLayout(sheets, spreadsheetId, sheetName);
    const caCount = getConfiguredCaCount();
    const day = getDayOfMonthVN();
    const resolvedCa = typeof caIndex === 'number' && Number.isFinite(caIndex)
        ? Math.floor(caIndex)
        : 1;
    const clampedCa = Math.min(Math.max(resolvedCa, 1), caCount);
    const targetRow = 1 + clampedCa;
    const targetCol = DAY_FIRST_COL + (day - 1);
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
