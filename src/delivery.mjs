import { createHash } from 'node:crypto';
import { readAllowedFile, MAX_FILE } from './files.mjs';

export function splitText(text, limit = 1900) {
  const parts = [];
  let rest = String(text);
  while (rest.length > limit) {
    let end = rest.lastIndexOf('\n\n', limit);
    if (end < limit / 2) end = rest.lastIndexOf('\n', limit);
    if (end < limit / 2) end = limit;
    if (/[\uD800-\uDBFF]/.test(rest[end - 1])) end--;
    parts.push(rest.slice(0, end));
    rest = rest.slice(end);
    if (rest.startsWith('\n\n')) rest = rest.slice(2);
    else if (rest.startsWith('\n')) rest = rest.slice(1);
  }
  if (rest) parts.push(rest);
  return parts;
}

export async function prepareReply(body, roots) {
  const paths = [];
  const text = String(body).split(/\r?\n/).filter(line => {
    const match = line.match(/^FILE:\s*(.*)$/);
    if (!match) return true;
    paths.push(match[1]);
    return false;
  }).join('\n');
  const files = [];
  let refused = false;
  for (const path of paths.slice(0, 10)) {
    try { files.push(await readAllowedFile(path, roots)); }
    catch { refused = true; }
  }
  if (paths.length > 10) refused = true;
  const parts = splitText(text + (refused ? '\n[One or more attachments were refused. Check the allowed roots and size limits.]' : '')).filter(part => part.trim());
  const messages = parts.map(content => ({ text: content, files: [] }));
  let group = [];
  let bytes = 0;
  for (const file of files) {
    if (bytes + file.data.length > MAX_FILE && group.length) {
      messages.push({ text: '', files: group });
      group = [];
      bytes = 0;
    }
    group.push(file);
    bytes += file.data.length;
  }
  if (group.length) messages.push({ text: '', files: group });
  if (!messages.length) messages.push({ text: '[Empty reply]', files: [] });
  return messages;
}

export async function preparePlan(body, roots) {
  const messages = await prepareReply(body, roots);
  return messages.map(message => ({ text: message.text, files: message.files.map(file => ({
    path: file.path, hash: createHash('sha256').update(file.data).digest('hex'),
  })) }));
}

export async function loadPlannedFiles(plan, roots) {
  const files = [];
  for (const item of plan.files) {
    const file = await readAllowedFile(item.path, roots);
    if (createHash('sha256').update(file.data).digest('hex') !== item.hash) throw new Error('A queued attachment changed. Restore the original file before retry.');
    files.push(file);
  }
  return files;
}

export async function reconcileDelivery(rest, channel, record) {
  let before = '';
  for (let page = 0; page < 100; page++) {
    const messages = await rest.request('GET', `/channels/${channel}/messages?limit=100${before ? `&before=${before}` : ''}`);
    const found = messages.find(message => String(message.nonce) === record.nonce);
    if (found) return found.id;
    if (messages.length < 100 || messages.some(message => record.anchor && BigInt(message.id) <= BigInt(record.anchor))) break;
    before = messages.at(-1).id;
  }
  throw new Error('Uncertain Discord delivery. The bridge will not send it again. Check state.json and Discord history before manual repair.');
}

export async function deliverOnce(rest, state, save, key, channel, text, files = []) {
  let record = state.deliveries[key];
  if (record?.id) return record.id;
  if (record) {
    record.id = await reconcileDelivery(rest, channel, record);
    await save();
    return record.id;
  }
  const latest = await rest.request('GET', `/channels/${channel}/messages?limit=1`);
  const nonce = createHash('sha256').update(key).digest('hex').slice(0, 24);
  record = { channel, nonce, anchor: latest[0]?.id || '', started: new Date().toISOString() };
  state.deliveries[key] = record;
  await save();
  const message = await rest.message(channel, text, files, nonce);
  if (!/^\d{1,20}$/.test(message.id)) throw new Error('Discord returned an invalid message id.');
  record.id = message.id;
  await save();
  return message.id;
}
