// 메모리 DB: MONGODB_URI=memory 로 실행하면 MongoDB 없이 서버를 띄웁니다 (개발 · 자동화 테스트용).
// 서버가 사용하는 MongoDB 기능만 흉내 냅니다. 서버를 재시작하면 데이터가 사라집니다.
import { Readable, Writable } from 'node:stream';
import { Query } from 'mingo';

const clone = (v) => structuredClone(v);

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    if (o[k] == null || typeof o[k] !== 'object') o[k] = {};
    o = o[k];
  }
  o[keys.at(-1)] = value;
}

function unsetPath(obj, path) {
  const keys = path.split('.');
  const parent = keys.length > 1 ? getPath(obj, keys.slice(0, -1).join('.')) : obj;
  if (parent && typeof parent === 'object') delete parent[keys.at(-1)];
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function applyUpdate(doc, update) {
  for (const [op, fields] of Object.entries(update)) {
    for (const [path, v] of Object.entries(fields)) {
      const cur = getPath(doc, path);
      switch (op) {
        case '$set': setPath(doc, path, clone(v)); break;
        case '$unset': unsetPath(doc, path); break;
        case '$inc': setPath(doc, path, (cur || 0) + v); break;
        case '$addToSet': {
          const arr = Array.isArray(cur) ? cur : [];
          const items = v && typeof v === 'object' && '$each' in v ? v.$each : [v];
          for (const it of items) if (!arr.some((x) => same(x, it))) arr.push(clone(it));
          setPath(doc, path, arr);
          break;
        }
        case '$push': setPath(doc, path, [...(Array.isArray(cur) ? cur : []), clone(v)]); break;
        case '$pull': if (Array.isArray(cur)) setPath(doc, path, cur.filter((x) => !same(x, v))); break;
        default: throw new Error(`memdb: 지원하지 않는 연산자 ${op}`);
      }
    }
  }
  return doc;
}

function project(doc, projection) {
  if (!projection || !Object.keys(projection).length) return clone(doc);
  const entries = Object.entries(projection);
  const include = entries.some(([k, v]) => k !== '_id' && v);
  if (include) {
    const out = projection._id === 0 ? {} : { _id: doc._id };
    for (const [k, v] of entries) if (v && k !== '_id' && getPath(doc, k) !== undefined) setPath(out, k, clone(getPath(doc, k)));
    return out;
  }
  const out = clone(doc);
  for (const [k, v] of entries) if (!v) unsetPath(out, k);
  return out;
}

function compare(a, b) {
  if (a === b) return 0;
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  return a < b ? -1 : 1;
}

class Cursor {
  constructor(docs, projection) {
    this.docs = docs;
    this.projection = projection;
    this.sortSpec = null;
    this.n = 0;
  }
  sort(spec) { this.sortSpec = spec; return this; }
  limit(n) { this.n = n; return this; }
  #result() {
    let list = [...this.docs];
    if (this.sortSpec) {
      const keys = Object.entries(this.sortSpec);
      list.sort((x, y) => {
        for (const [k, dir] of keys) {
          const c = compare(getPath(x, k), getPath(y, k));
          if (c) return c * dir;
        }
        return 0;
      });
    }
    if (this.n) list = list.slice(0, this.n);
    return list.map((d) => project(d, this.projection));
  }
  async toArray() { return this.#result(); }
  async next() { return this.#result()[0] ?? null; }
}

class Collection {
  constructor() { this.docs = new Map(); }
  #match(filter = {}) {
    const q = new Query(filter);
    return [...this.docs.values()].filter((d) => q.test(d));
  }
  async createIndex() { return 'ok'; }
  find(filter, { projection } = {}) { return new Cursor(this.#match(filter), projection); }
  async findOne(filter, { projection } = {}) {
    const d = this.#match(filter)[0];
    return d ? project(d, projection) : null;
  }
  async insertOne(doc) {
    if (this.docs.has(doc._id)) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    this.docs.set(doc._id, clone(doc));
    return { insertedId: doc._id };
  }
  async updateOne(filter, update) {
    const d = this.#match(filter)[0];
    if (d) applyUpdate(d, update);
    return { matchedCount: d ? 1 : 0, modifiedCount: d ? 1 : 0 };
  }
  async updateMany(filter, update) {
    const list = this.#match(filter);
    for (const d of list) applyUpdate(d, update);
    return { matchedCount: list.length, modifiedCount: list.length };
  }
  async findOneAndUpdate(filter, update, { returnDocument = 'before' } = {}) {
    const d = this.#match(filter)[0];
    if (!d) return null;
    const before = clone(d);
    applyUpdate(d, update);
    return returnDocument === 'after' ? clone(d) : before;
  }
  async deleteOne(filter) {
    const d = this.#match(filter)[0];
    if (d) this.docs.delete(d._id);
    return { deletedCount: d ? 1 : 0 };
  }
  async deleteMany(filter) {
    const list = this.#match(filter);
    for (const d of list) this.docs.delete(d._id);
    return { deletedCount: list.length };
  }
  async countDocuments(filter) { return this.#match(filter).length; }
  async distinct(key, filter) {
    const out = [];
    for (const d of this.#match(filter)) {
      const v = getPath(d, key);
      if (v !== undefined && !out.some((x) => same(x, v))) out.push(v);
    }
    return out;
  }
}

/** GridFSBucket 흉내: 파일 정보는 'uploads.files', 내용은 메모리 */
class Bucket {
  constructor(filesCol) {
    this.filesCol = filesCol;
    this.chunks = new Map();
  }
  openUploadStreamWithId(id, filename, { metadata } = {}) {
    const parts = [];
    const { filesCol, chunks } = this;
    return new Writable({
      write(chunk, enc, cb) { parts.push(Buffer.from(chunk)); cb(); },
      final(cb) {
        const buf = Buffer.concat(parts);
        chunks.set(id, buf);
        filesCol.insertOne({ _id: id, filename, length: buf.length, uploadDate: new Date(), metadata }).then(() => cb(), cb);
      },
    });
  }
  openDownloadStream(id) {
    const buf = this.chunks.get(id);
    if (!buf) {
      const r = new Readable({ read() {} });
      process.nextTick(() => r.destroy(new Error('FileNotFound')));
      return r;
    }
    return Readable.from([buf]);
  }
  async delete(id) {
    const had = this.chunks.delete(id);
    const r = await this.filesCol.deleteOne({ _id: id });
    if (!had && !r.deletedCount) throw new Error('FileNotFound');
  }
}

export function createMemoryDb() {
  const cols = new Map();
  const collection = (name) => {
    if (!cols.has(name)) cols.set(name, new Collection());
    return cols.get(name);
  };
  const db = {
    collection,
    async command() { return { ok: 1 }; },
  };
  return { db, bucket: new Bucket(collection('uploads.files')) };
}
