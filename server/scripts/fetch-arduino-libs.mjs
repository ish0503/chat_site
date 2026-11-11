// 기본 아두이노 라이브러리(server/arduino-libs.json 에서 optional 이 아닌 것)를 받아 풉니다. 체크섬을 확인합니다.
// 사용: node scripts/fetch-arduino-libs.mjs <받을 폴더> [선택 라이브러리 id …]     (Dockerfile · CI · 내 컴퓨터 준비에서 사용. unzip 필요)
import { fetchLibrary, loadCatalog } from '../src/arduino-libs.js';

const [dest, ...extra] = process.argv.slice(2);
if (!dest) { console.error('받을 폴더를 지정하세요'); process.exit(1); }
const catalog = loadCatalog();
const byId = new Map(catalog.map((e) => [e.id, e]));
const want = new Set(catalog.filter((e) => !e.optional).map((e) => e.id));
const add = (id) => { const e = byId.get(id); if (!e) { console.error(`목록에 없는 라이브러리: ${id}`); process.exit(1); } want.add(id); (e.requires || []).forEach(add); };
extra.forEach(add);
for (const entry of catalog.filter((e) => want.has(e.id))) {
  const fresh = await fetchLibrary(entry, dest);
  console.log(`${fresh ? '받음' : '이미 있음'}: ${entry.name} ${entry.version}`);
}
