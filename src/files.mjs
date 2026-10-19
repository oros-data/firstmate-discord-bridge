import { mkdir, realpath, open, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, relative, join, sep } from 'node:path';

export const MAX_FILE = 25_000_000;

export function inside(root, path) {
  const part = relative(root, path);
  return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

export async function readAllowedFile(path, roots) {
  if (!isAbsolute(path)) throw new Error('Attachment path must be absolute.');
  const canonical = await realpath(path);
  let allowed = false;
  for (const root of roots) {
    try { if (inside(await realpath(root), canonical)) allowed = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!allowed) throw new Error('Attachment path is outside the allowed roots.');
  const handle = await open(canonical, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE) throw new Error('Attachment is not a file or exceeds 25 MB.');
    const data = await handle.readFile();
    if (data.length > MAX_FILE) throw new Error('Attachment exceeds 25 MB.');
    return { name: basename(canonical), path: canonical, data };
  } finally { await handle.close(); }
}

export async function downloadAttachment(attachment, messageId, media, fetcher = fetch) {
  if (!/^\d{1,20}$/.test(messageId)) throw new Error('Invalid message id.');
  if (attachment.size > MAX_FILE) throw new Error('Attachment exceeds 25 MB.');
  const url = new URL(attachment.url);
  if (url.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)
      || !url.pathname.startsWith('/attachments/')) throw new Error('Invalid Discord attachment URL.');
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Attachment download failed (${response.status}).`);
  if (Number(response.headers.get('content-length')) > MAX_FILE) {
    await response.body?.cancel();
    throw new Error('Attachment exceeds 25 MB.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_FILE) throw new Error('Attachment exceeds 25 MB.');
    chunks.push(chunk);
  }
  const name = String(attachment.filename || 'attachment').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'attachment';
  const id = String(attachment.id);
  if (!/^\d{1,20}$/.test(id)) throw new Error('Invalid attachment id.');
  const directory = join(media, messageId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${id}-${name}`);
  await writeFile(path, Buffer.concat(chunks), { mode: 0o600 });
  return path;
}
