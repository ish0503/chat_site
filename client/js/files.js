// 첨부파일: 유효기간 안에서만 서버에서 받을 수 있고, 기기에 저장된 사본은 만료 후에도 볼 수 있지만 다시 내려받을 수는 없습니다.
import * as idb from './db.js';
import { h } from './util.js';

const urls = new Map();

export const isExpired = (att) => !!att.expiresAt && att.expiresAt <= Date.now();

export async function localUrl(att) {
  if (urls.has(att.id)) return urls.get(att.id);
  const rec = await idb.get('blobs', att.id);
  if (!rec?.blob) return null;
  const u = URL.createObjectURL(rec.blob);
  urls.set(att.id, u);
  return u;
}

export async function hasLocal(att) {
  return urls.has(att.id) || !!(await idb.get('blobs', att.id));
}

export async function storeBlob(att, blob) {
  await idb.put('blobs', { id: att.id, blob, name: att.name, mime: att.mime, savedAt: Date.now() });
}

export function forget(ids) {
  for (const id of ids) {
    const u = urls.get(id);
    if (u) URL.revokeObjectURL(u);
    urls.delete(id);
  }
}

/** 서버에서 받아 기기에 저장 (유효기간 내에서만) */
export async function fetchToDevice(att, data) {
  if (isExpired(att)) throw Object.assign(new Error('expired'), { code: 'expired' });
  const blob = await data.fetchFile(att.id);
  await storeBlob(att, blob);
  return localUrl(att);
}

/** 기기로 파일 저장 (다운로드). 만료되면 불가 */
export async function saveToDevice(att, data) {
  if (isExpired(att)) throw Object.assign(new Error('expired'), { code: 'expired' });
  const url = (await localUrl(att)) || (await fetchToDevice(att, data));
  const a = h('a', { href: url, download: att.name || 'file' });
  document.body.append(a);
  a.click();
  a.remove();
}

export async function clearAll() {
  forget([...urls.keys()]);
  await idb.clear('blobs');
}
