import fs from 'node:fs/promises';
import path from 'node:path';

export async function getInputContent(inputContent, file) {
  if (!inputContent && file) {
    const content = await fs.readFile(file, 'utf-8');
    return { content, absoluteDirPath: path.dirname(file) };
  }
  if (!inputContent) throw new Error('missing input-content');
  return { content: inputContent, absoluteDirPath: undefined };
}
