const UNTITLED = 'Untitled query';

const collapse = (text: string): string => text.replace(/\s+/gu, ' ').trim();

const truncate = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

export function normalizeQueryName(name: string): string {
  return collapse(name) || UNTITLED;
}

export function defaultQueryName(sql: string): string {
  for (const line of sql.split(/\r?\n/u)) {
    const text = collapse(line);
    if (text && !text.startsWith('--')) return truncate(text, 60);
  }
  return UNTITLED;
}

export function sqlPreview(sql: string): string {
  const lines = sql.split(/\r?\n/u).map(collapse);
  const index = lines.findIndex((line) => line && !line.startsWith('--'));
  const at = index === -1 ? lines.findIndex((line) => line !== '') : index;
  if (at === -1) return '';
  const text = truncate(lines[at]!, 80);
  const more = lines.slice(at + 1).some((line) => line !== '');
  return more && !text.endsWith('…') ? `${text} …` : text;
}

export function relativeTime(then: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(then).toLocaleDateString();
}

export function fileStem(name: string): string {
  return name.replace(/(?<=.)\.[^.]*$/u, '');
}
