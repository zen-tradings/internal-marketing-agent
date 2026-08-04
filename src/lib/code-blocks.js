const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const LIST_ITEM_RE = /^\s{0,3}(?:[-+*]|\d+[.)])\s+/;

export function normalizeIndentedCodeBlocks(markdown) {
  const value = String(markdown || '');
  const lines = value.split(/\r?\n/);
  const output = [];
  let transformedBlocks = 0;
  let fence;
  let inPre = false;
  let inFrontmatter = lines[0] === '---';

  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (inFrontmatter) {
      output.push(line);
      if (index > 0 && line === '---') inFrontmatter = false;
      index += 1;
      continue;
    }
    const fenceMatch = line.match(FENCE_RE);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!fence) fence = marker;
      else if (fence === marker) fence = undefined;
      output.push(line);
      index += 1;
      continue;
    }
    if (fence) {
      output.push(line);
      index += 1;
      continue;
    }
    if (/<pre\b/i.test(line)) inPre = true;
    if (inPre) {
      output.push(line);
      if (/<\/pre>/i.test(line)) inPre = false;
      index += 1;
      continue;
    }
    if (!isIndentedCodeLine(line) || followsListItem(output)) {
      output.push(line);
      index += 1;
      continue;
    }

    const block = [];
    while (index < lines.length) {
      const candidate = lines[index];
      if (isIndentedCodeLine(candidate)) {
        block.push(stripCodeIndent(candidate));
        index += 1;
        continue;
      }
      if (candidate.trim() === '' && index + 1 < lines.length && isIndentedCodeLine(lines[index + 1])) {
        block.push('');
        index += 1;
        continue;
      }
      break;
    }
    output.push('```text', ...block, '```');
    transformedBlocks += 1;
  }

  return {
    markdown: output.join('\n'),
    changed: transformedBlocks > 0,
    transformedBlocks,
  };
}

export function inspectCodeBlocks(markdown) {
  const value = String(markdown || '');
  const outside = markdownOutsideProtectedCode(value);
  return {
    fenced: /^\s{0,3}(?:`{3,}|~{3,})/m.test(value),
    htmlPre: /<pre\b[^>]*>[\s\S]*?<\/pre>/i.test(value),
    indented: outside.split(/\r?\n/).some(isIndentedCodeLine),
  };
}

function markdownOutsideProtectedCode(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const output = [];
  let fence;
  let inPre = false;
  for (const line of lines) {
    const fenceMatch = line.match(FENCE_RE);
    if (fenceMatch && !inPre) {
      const marker = fenceMatch[1][0];
      if (!fence) fence = marker;
      else if (fence === marker) fence = undefined;
      output.push('');
      continue;
    }
    if (fence) {
      output.push('');
      continue;
    }
    if (/<pre\b/i.test(line)) inPre = true;
    if (inPre) {
      output.push('');
      if (/<\/pre>/i.test(line)) inPre = false;
      continue;
    }
    output.push(line);
  }
  return output.join('\n');
}

function isIndentedCodeLine(line) {
  return /^(?: {4,}|\t)\S/.test(String(line || ''));
}

function stripCodeIndent(line) {
  return String(line).startsWith('\t') ? String(line).slice(1) : String(line).slice(4);
}

function followsListItem(output) {
  for (let index = output.length - 1; index >= 0; index--) {
    if (!output[index].trim()) continue;
    return LIST_ITEM_RE.test(output[index]);
  }
  return false;
}
