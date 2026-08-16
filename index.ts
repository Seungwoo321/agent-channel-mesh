/**
 * Vercel Bun 프리셋의 진입점.
 *
 * 프리셋은 `index` 라는 이름을 찾는다 — `src/index.ts` 는 라이브러리 배럴이라
 * 여기에 서버를 둘 수 없다(배럴을 import 하는 것만으로 서버가 뜨게 된다).
 * 그래서 루트 `index.ts` 가 진입점이 되고, 실제 서버는 `src/server.ts` 가 갖는다.
 *
 * 진입점의 default export 는 함수이거나 Bun Server 여야 한다.
 */
export { default } from './src/server.js'
