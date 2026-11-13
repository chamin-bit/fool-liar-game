// 4명이 바보 모드로 한 판 끝까지 진행하는 자동 테스트. 실행: PORT=3123 node server.js 후 node test/e2e.js
const { io } = require('socket.io-client');
const URL = process.env.URL || 'http://localhost:3123';
const code = 'test-' + Date.now().toString(36);
const names = ['차민', '예지', '은주', '유택'];
const SLOW = Number(process.env.SLOW || 1); // 원격 서버 테스트 시 SLOW=8 등
const wait = (ms) => new Promise((r) => setTimeout(r, ms > 5000 ? ms + 2000 * SLOW : ms * SLOW));
const fail = (m) => { console.error('FAIL:', m); process.exit(1); };

(async () => {
  const P = [];
  for (const name of names) {
    const s = io(URL, { transports: ['websocket'] });
    const p = { name, s, state: null, msgs: [] };
    s.on('state', (st) => (p.state = st));
    s.on('msg', (m) => p.msgs.push(m));
    await new Promise((res) => s.on('connect', () => s.emit('join', { code, name }, (r) => { p.id = r.playerId; res(); })));
    P.push(p);
  }
  await wait(200);
  const host = P[0];
  if (host.state.hostId !== host.id) fail('첫 입장자가 방장이 아님');
  host.s.emit('settings', { categories: ['음식'], mode: 'fool', timers: { hint: 0, vote: 0, defense: 0 } });
  host.s.emit('start');
  await wait(200);

  // 비밀 정보 누출 검사: 아무 state에도 liarId/word가 없어야 함
  for (const p of P) {
    const raw = JSON.stringify(p.state);
    if (p.state.game.result) fail('게임 중 결과 노출');
    if (raw.includes('liarId')) fail('liarId 노출');
    if (!p.state.mine.word) fail(`${p.name} 제시어 없음 (바보 모드)`);
  }
  const words = P.map((p) => p.state.mine.word);
  const counts = {};
  words.forEach((w) => (counts[w] = (counts[w] || 0) + 1));
  const citizenWord = Object.keys(counts).find((w) => counts[w] === 3);
  const liar = P.find((p) => p.state.mine.word !== citizenWord);
  if (!citizenWord || !liar) fail('바보 모드 단어 분배 이상: ' + words.join(','));
  console.log('제시어', citizenWord, '/ 라이어', liar.name, '(받은 단어', liar.state.mine.word + ')');

  const byId = (id) => P.find((p) => p.id === id);
  const playRound = async () => {
    for (let i = 0; i < 4; i++) {
      const turn = byId(host.state.game.turnId);
      turn.s.emit('hint', `${turn.name}의 힌트`);
      await wait(80);
    }
    if (host.state.phase !== 'vote') fail('힌트 후 투표로 안 넘어감: ' + host.state.phase);
  };

  // 1라운드: 일부러 라이어 아닌 사람 지목 → 해명 → 반대로 합의 실패
  await playRound();
  const innocent = P.find((p) => p !== liar);
  for (const p of P) p.s.emit('vote', p === innocent ? liar.id : innocent.id);
  await wait(150);
  if (host.state.phase !== 'defense' || host.state.game.nominee !== innocent.id) fail('지목 실패 ' + host.state.phase);
  innocent.s.emit('defense', '억울해요');
  await wait(100);
  for (const p of P) if (p !== innocent) p.s.emit('final', false);
  await wait(150);
  if (host.state.phase !== 'hint' || host.state.game.round !== 2) fail('합의 실패 후 2라운드 안 감');
  console.log('1라운드 합의 실패 → 2라운드 OK');

  // 2라운드: 라이어 지목 → 찬성 → 정답 맞히기 (오답)
  await playRound();
  for (const p of P) p.s.emit('vote', p === liar ? innocent.id : liar.id);
  await wait(150);
  if (host.state.game.nominee !== liar.id) fail('라이어 지목 실패');
  liar.s.emit('defense', '저 아니에요');
  await wait(100);
  for (const p of P) if (p !== liar) p.s.emit('final', true);
  await wait(150);
  if (host.state.phase !== 'guess') fail('정답 단계 안 감: ' + host.state.phase);
  if (!liar.state.mine.revealedLiar) fail('바보 라이어에게 정체 공개 안 됨');
  innocent.s.emit('guess', citizenWord); // 라이어 아닌 사람이 보낸 건 무시돼야 함
  await wait(100);
  if (host.state.phase !== 'guess') fail('라이어 아닌 사람이 정답 제출 가능');
  liar.s.emit('guess', ' ' + citizenWord + ' ');
  await wait(150);
  if (host.state.phase !== 'end' || host.state.game.result.winner !== 'liar') fail('정답 맞혔는데 라이어 승리 아님');
  console.log('라이어 정답 → 라이어 역전승 OK');

  // 동률 재투표 + 타이머 테스트
  host.s.emit('reset');
  await wait(100);
  host.s.emit('settings', { categories: [], mode: 'normal', timers: { hint: 10, vote: 0, defense: 0 } });
  host.s.emit('start');
  await wait(150);
  const liars = P.filter((p) => p.state.mine.liar);
  if (liars.length !== 1 || liars[0].state.mine.word) fail('일반 모드 라이어 정보 이상');
  if (!host.state.deadline) fail('힌트 타이머 deadline 없음');
  console.log('일반 모드 + 타이머 deadline OK, 10초 타임아웃 대기…');
  const t0 = host.state.game.turnId;
  await wait(10600);
  if (host.state.game.turnId === t0) fail('타이머 초과 후 차례가 안 넘어감');
  console.log('힌트 타임아웃 자동 패스 OK');
  // 방장이 아닌 사람도 /넘기기 사용 가능
  for (let i = 0; i < 6 && host.state.phase === 'hint'; i++) { P[2].s.emit('chat', '/넘기기'); await wait(150); }
  if (host.state.phase !== 'vote') fail('/넘기기로 투표 단계 못 감');
  console.log('일반 참가자 /넘기기 OK');
  const [a, b] = host.state.game.order;
  const others = P.filter((p) => p.id !== a && p.id !== b);
  P.forEach((p) => p.s.emit('vote', p.id === a ? b : p.id === b ? a : p === others[0] ? a : b));
  await wait(200);
  if (!host.state.game.revote) fail('동률인데 재투표 아님: ' + host.state.phase);
  console.log('동률 → 재투표 OK');

  // 전적·랭킹
  const st = host.state.stats;
  if (Object.keys(st).length !== 4 || Object.values(st).some((s) => s.games !== 1)) fail('전적 집계 이상 ' + JSON.stringify(st));
  P[1].s.emit('chat', '/랭킹');
  await wait(150);
  if (!host.msgs.slice(-1)[0].text.includes('승률')) fail('/랭킹 응답 없음');
  console.log('전적·/랭킹 OK');

  // 일반 참가자 /초기화 → /시작, 같은 카테고리에서 단어가 안 겹치는지
  const WORDS = require('../words');
  P[3].s.emit('chat', '/초기화');
  await wait(150);
  if (host.state.phase !== 'lobby') fail('/초기화 안 됨');
  host.s.emit('settings', { categories: ['과일'], mode: 'fool', timers: { hint: 0, vote: 0, defense: 0 } });
  await wait(100);
  const seen = new Set();
  const groups = WORDS['과일'];
  for (let i = 0; i < 20; i++) {
    P[3].s.emit('chat', i ? '/초기화' : '/명령어');
    await wait(80);
    P[2].s.emit('chat', '/시작');
    await wait(150);
    if (host.state.phase !== 'hint' || host.state.game.category !== '과일') fail('/시작 안 됨 ' + host.state.phase);
    const ws = P.map((p) => p.state.mine.word);
    const cnt = {}; ws.forEach((w) => (cnt[w] = (cnt[w] || 0) + 1));
    const cw = Object.keys(cnt).find((w) => cnt[w] === 3);
    const lw = Object.keys(cnt).find((w) => cnt[w] === 1);
    if (seen.has(cw)) fail(`단어 중복: ${cw}`);
    seen.add(cw);
    if (!groups.some((g) => g.includes(cw) && g.includes(lw))) fail(`바보 단어가 같은 묶음이 아님: ${cw} / ${lw}`);
  }
  console.log('20판 단어 중복 없음 + 바보 단어 같은 묶음 OK:', [...seen].slice(0, 8).join(', '), '…');

  console.log('\nALL PASS ✅');
  P.forEach((p) => p.s.close());
  process.exit(0);
})();
