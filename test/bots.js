// 화면 테스트용 봇: node test/bots.js <방코드> [인원]
const { io } = require('socket.io-client');
const URL = process.env.URL || 'http://localhost:3123';
const code = process.argv[2] || 'demo-room';
const n = Number(process.argv[3] || 3);
const names = ['봇은주', '봇유택', '봇예지', '봇중엽', '봇수진'];
for (let i = 0; i < n; i++) {
  const s = io(URL, { transports: ['websocket'] });
  let me = null, last = '';
  s.on('connect', () => s.emit('join', { code, name: names[i] }, (r) => (me = r.playerId)));
  s.on('state', (st) => {
    const g = st.game;
    const key = [st.phase, g && g.turnId, g && g.round, g && g.candidates.join(), g && g.nominee].join('|');
    if (key === last || !g) return;
    last = key;
    setTimeout(() => {
      if (st.phase === 'hint' && g.turnId === me) s.emit('hint', ['음… 좋아하는 거', '자주 봐요', '생각보다 비싸요', '여름에 생각나요'][Math.floor(Math.random() * 4)]);
      if (st.phase === 'vote') { const c = g.candidates.filter((x) => x !== me); s.emit('vote', c[Math.floor(Math.random() * c.length)]); }
      if (st.phase === 'defense' && g.nominee === me) s.emit('defense', '저 진짜 아니에요 ㅠㅠ');
      if (st.phase === 'final' && g.nominee !== me) s.emit('final', Math.random() < 0.6);
      if (st.phase === 'guess' && st.mine && (st.mine.liar || st.mine.revealedLiar)) s.emit('guess', '떡볶이');
    }, 1200 + Math.random() * 1500);
  });
}
