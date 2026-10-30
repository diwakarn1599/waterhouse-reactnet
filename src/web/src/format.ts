/** Indian digit grouping: 12,25,831.35 rather than 1,225,831.35. */
const rupeeFormat = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const intFormat = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

export const money = (value: number): string => rupeeFormat.format(value ?? 0);
export const rupees = (value: number): string => `₹${rupeeFormat.format(value ?? 0)}`;
export const count = (value: number): string => intFormat.format(value ?? 0);

/** 'yyyy-MM-dd' -> 'dd-MM-yyyy' for display. Dates stay ISO everywhere else. */
export function displayDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const [year, month, day] = iso.slice(0, 10).split('-');
  return year && month && day ? `${day}-${month}-${year}` : iso;
}

export function displayDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString('en-IN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Today in the browser's timezone as 'yyyy-MM-dd'. */
export function todayIso(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00`);
  date.setDate(date.getDate() + days);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

export function startOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

export function endOfMonth(iso: string): string {
  const [year, month] = iso.slice(0, 7).split('-').map(Number);
  if (!year || !month) return iso;
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

/**
 * Round to whole paise. Guards against float drift creeping into a displayed
 * total; the server is authoritative and stores integer paise regardless.
 */
export const toPaiseSafe = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;
