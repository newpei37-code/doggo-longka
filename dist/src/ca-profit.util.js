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
exports.upsertCaProfitToday = upsertCaProfitToday;
exports.getCaProfitsToday = getCaProfitsToday;
exports.getTotalsForMonth = getTotalsForMonth;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
function getProjectRoot() {
    const norm = __dirname.replace(/\\/g, '/');
    if (norm.includes('/dist/src')) {
        return path.resolve(__dirname, '..', '..');
    }
    return path.resolve(__dirname, '..');
}
const FILE = path.join(getProjectRoot(), 'data', 'ca-profit.json');
function dateKeyVN() {
    return new Date().toLocaleString('sv-SE', {
        timeZone: 'Asia/Ho_Chi_Minh',
    }).slice(0, 10);
}
function ensureDir() {
    const dir = path.dirname(FILE);
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
}
function loadStore() {
    ensureDir();
    if (!fs.existsSync(FILE))
        return {};
    try {
        const raw = fs.readFileSync(FILE, 'utf8').trim();
        if (!raw)
            return {};
        return JSON.parse(raw);
    }
    catch {
        return {};
    }
}
function saveStore(data) {
    ensureDir();
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8');
}
function getMonthKey(dateStr) {
    return dateStr.slice(0, 7);
}
function upsertCaProfitToday(group, caIndex, amount) {
    const ca = Math.floor(Number(caIndex));
    if (!Number.isFinite(ca) || ca < 1)
        return;
    const value = Math.round(Number(amount));
    if (!Number.isFinite(value))
        return;
    const data = loadStore();
    const key = dateKeyVN();
    if (!data[key])
        data[key] = { that: {}, ao: {} };
    data[key][group][String(ca)] = value;
    saveStore(data);
}
function getCaProfitsToday(group) {
    const data = loadStore();
    const key = dateKeyVN();
    const row = data[key];
    if (!row)
        return {};
    const src = row[group];
    const out = {};
    for (const [k, v] of Object.entries(src)) {
        const ca = Number.parseInt(k, 10);
        if (Number.isFinite(ca) && ca >= 1 && Number.isFinite(v)) {
            out[ca] = Math.round(v);
        }
    }
    return out;
}
function getTotalsForMonth(group) {
    const data = loadStore();
    const todayKey = dateKeyVN();
    const todayMonth = getMonthKey(todayKey);
    let today = 0;
    let month = 0;
    for (const [dayKey, row] of Object.entries(data)) {
        const profits = row[group];
        const sum = Object.values(profits).reduce((acc, v) => (Number.isFinite(v) ? acc + v : acc), 0);
        if (dayKey === todayKey) {
            today = sum;
        }
        if (getMonthKey(dayKey) === todayMonth) {
            month += sum;
        }
    }
    return { today, month };
}
