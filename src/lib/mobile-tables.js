// WeChat body tables have no reliable horizontal scrolling. Determine mobile readability first, then split
// unreadable wide tables by columns while retaining the first column as the record key and grouping three metrics.

const DEFAULT_MAX_COLUMNS = 4;

export function normalizeWideTables(markdown, { maxColumns = DEFAULT_MAX_COLUMNS } = {}) {
  const source = String(markdown || '');
  const lines = source.split(/\r?\n/);
  const tables = parseMarkdownTables(lines);
  let transformedTables = 0;
  let outputTables = 0;

  for (const table of [...tables].reverse()) {
    if (isMobileReadableTable(table, { maxColumns })) continue;
    if (!table.valid) continue;
    const replacement = splitTableForMobile(table, { maxColumns });
    if (!replacement) continue;
    lines.splice(table.start, table.end - table.start, ...replacement.split('\n'));
    transformedTables += 1;
    outputTables += Math.ceil((table.columnCount - 1) / (maxColumns - 1));
  }

  const normalized = lines.join('\n');
  return {
    markdown: normalized,
    changed: normalized !== source,
    transformedTables,
    outputTables,
    remainingUnreadableTables: findUnreadableTables(normalized, { maxColumns }).length,
  };
}

export function findUnreadableTables(markdown, { maxColumns = DEFAULT_MAX_COLUMNS } = {}) {
  const lines = String(markdown || '').split(/\r?\n/);
  const tables = parseMarkdownTables(lines);
  const unreadable = tables.filter((table) => !table.valid || !isMobileReadableTable(table, { maxColumns }));

  // parseMarkdownTables rejects a table when header and separator column counts differ; mark it separately.
  for (let i = 0; i < lines.length - 1; i += 1) {
    const header = parseTableRow(lines[i]);
    const divider = parseTableRow(lines[i + 1]);
    if (!header || !divider || !divider.every(isDividerCell)) continue;
    if (header.length !== divider.length && Math.max(header.length, divider.length) > maxColumns) {
      unreadable.push({ start: i, end: i + 2, columnCount: header.length, valid: false });
    }
  }
  return unreadable;
}

export function isMobileReadableTable(table, { maxColumns = DEFAULT_MAX_COLUMNS } = {}) {
  if (!table?.valid) return false;
  if (table.columnCount <= maxColumns) return true;
  if (table.columnCount !== maxColumns + 1) return false;

  // Allow very compact five-column tables such as Quarter/Rev/GM/OM/EPS. Count Han characters as double width and
  // cap individual and total content widths so long headers cannot collapse into vertical characters.
  const widths = table.headers.map((_, index) => Math.max(
    ...[table.headers, ...table.rows].map((row) => visualWidth(row[index] || '')),
  ));
  return widths.every((width) => width <= 10) && widths.reduce((sum, width) => sum + width, 0) <= 32;
}

function parseMarkdownTables(lines) {
  const tables = [];
  for (let i = 0; i < lines.length - 1; i += 1) {
    const headers = parseTableRow(lines[i]);
    const divider = parseTableRow(lines[i + 1]);
    if (!headers || !divider || headers.length < 2 || !divider.every(isDividerCell)) continue;

    const validDivider = headers.length === divider.length;
    const rows = [];
    let end = i + 2;
    while (end < lines.length) {
      const row = parseTableRow(lines[end]);
      if (!row) break;
      rows.push(row);
      end += 1;
    }
    const validRows = rows.every((row) => row.length === headers.length);
    tables.push({
      start: i,
      end,
      headers,
      divider,
      rows,
      columnCount: headers.length,
      valid: validDivider && validRows,
    });
    i = end - 1;
  }
  return tables;
}

function splitTableForMobile(table, { maxColumns }) {
  if (maxColumns < 2 || table.columnCount <= maxColumns) return '';
  const groups = [];
  for (let start = 1; start < table.columnCount; start += maxColumns - 1) {
    groups.push([0, ...range(start, Math.min(start + maxColumns - 1, table.columnCount))]);
  }
  return groups.map((indices) => [
    formatTableRow(select(table.headers, indices)),
    formatTableRow(select(table.divider, indices)),
    ...table.rows.map((row) => formatTableRow(select(row, indices))),
  ].join('\n')).join('\n\n');
}

function parseTableRow(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  const inner = trimmed.slice(1, -1);
  const cells = [];
  let current = '';
  let inCode = false;
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i];
    if (char === '`' && !isEscaped(inner, i)) inCode = !inCode;
    if (char === '|' && !inCode && !isEscaped(inner, i)) {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function isEscaped(text, index) {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function isDividerCell(cell) { return /^:?-{1,}:?$/.test(String(cell || '').replace(/\s+/g, '')); }

function formatTableRow(cells) { return `| ${cells.join(' | ')} |`; }

function select(row, indices) { return indices.map((index) => row[index]); }

function range(start, end) { return Array.from({ length: end - start }, (_, index) => start + index); }

function visualWidth(value) {
  const plain = String(value || '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_~`]/g, '')
    .trim();
  return [...plain].reduce((width, char) => width + (/[^\u0000-\u00ff]/.test(char) ? 2 : 1), 0);
}
