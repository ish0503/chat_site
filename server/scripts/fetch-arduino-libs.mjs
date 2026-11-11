// 기본 아두이노 라이브러리(server/arduino-libs.json 에서 optional 이 아닌 것)를 받아 풉니다. 체크섬을 확인합니다.
// 사용: node scripts/fetch-arduino-libs.mjs <받을 폴더>      (Dockerfile · CI · 내 컴퓨터 준비에서 사용. unzip 필요)
import { fetchLibrary, loadCatalog } from '../src/arduino-libs.js';

const dest = process.argv[2];
if (!dest) { console.error('받을 폴더를 지정하세요'); process.exit(1); }
for (const entry of loadCatalog().filter((e) => !e.optional)) {
  const fresh = await fetchLibrary(entry, dest);
  console.log(`${fresh ? '받음' : '이미 있음'}: ${entry.name} ${entry.version}`);
}
