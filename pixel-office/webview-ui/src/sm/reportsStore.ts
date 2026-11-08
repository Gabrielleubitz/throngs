/** Which reports on your desk you've already opened (per browser). */
const READ_KEY = 'sm.readReports';

export function readReports(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(READ_KEY) || '[]') as string[]); } catch { return new Set(); }
}

export function markReportRead(id: string): void {
  const s = readReports();
  if (s.has(id)) return;
  s.add(id);
  try { localStorage.setItem(READ_KEY, JSON.stringify([...s])); } catch { /* private mode */ }
}
