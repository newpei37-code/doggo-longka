import * as fs from 'fs';
import * as path from 'path';

type GroupKind = 'that' | 'ao';

type DayProfitRow = {
  that: Record<string, number>;
  ao: Record<string, number>;
};

type ProfitStore = Record<string, DayProfitRow>;

function getProjectRoot(): string {
  const norm = __dirname.replace(/\\/g, '/');
  if (norm.includes('/dist/src')) {
    return path.resolve(__dirname, '..', '..');
  }
  return path.resolve(__dirname, '..');
}

const FILE = path.join(getProjectRoot(), 'data', 'ca-profit.json');

function dateKeyVN(): string {
  return new Date().toLocaleString('sv-SE', {
    timeZone: 'Asia/Ho_Chi_Minh',
  }).slice(0, 10);
}

function ensureDir(): void {
  const dir = path.dirname(FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadStore(): ProfitStore {
  ensureDir();
  if (!fs.existsSync(FILE)) return {};
  try {
    const raw = fs.readFileSync(FILE, 'utf8').trim();
    if (!raw) return {};
    return JSON.parse(raw) as ProfitStore;
  } catch {
    return {};
  }
}

function saveStore(data: ProfitStore): void {
  ensureDir();
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8');
}

function getMonthKey(dateStr: string): string {
  // dateStr dạng YYYY-MM-DD
  return dateStr.slice(0, 7); // YYYY-MM
}

export function upsertCaProfitToday(
  group: GroupKind,
  caIndex: number,
  amount: number,
): void {
  const ca = Math.floor(Number(caIndex));
  if (!Number.isFinite(ca) || ca < 1) return;
  const value = Math.round(Number(amount));
  if (!Number.isFinite(value)) return;

  const data = loadStore();
  const key = dateKeyVN();
  if (!data[key]) data[key] = { that: {}, ao: {} };
  data[key][group][String(ca)] = value;
  saveStore(data);
}

export function getCaProfitsToday(group: GroupKind): Record<number, number> {
  const data = loadStore();
  const key = dateKeyVN();
  const row = data[key];
  if (!row) return {};
  const src = row[group];
  const out: Record<number, number> = {};
  for (const [k, v] of Object.entries(src)) {
    const ca = Number.parseInt(k, 10);
    if (Number.isFinite(ca) && ca >= 1 && Number.isFinite(v)) {
      out[ca] = Math.round(v);
    }
  }
  return out;
}

export function getTotalsForMonth(
  group: GroupKind,
): { today: number; month: number } {
  const data = loadStore();
  const todayKey = dateKeyVN();
  const todayMonth = getMonthKey(todayKey);

  let today = 0;
  let month = 0;

  for (const [dayKey, row] of Object.entries(data)) {
    const profits = row[group];
    const sum = Object.values(profits).reduce(
      (acc, v) => (Number.isFinite(v) ? acc + v : acc),
      0,
    );
    if (dayKey === todayKey) {
      today = sum;
    }
    if (getMonthKey(dayKey) === todayMonth) {
      month += sum;
    }
  }

  return { today, month };
}
