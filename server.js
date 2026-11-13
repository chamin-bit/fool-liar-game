const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const WORDS = require('./words');

const PORT = process.env.PORT || 3000;
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 10;
const MAX_ROUNDS = 3;
const CATEGORIES = Object.keys(WORDS);
const TIMER_CHOICES = [0, 10, 15, 20, 30, 45, 60, 90, 120];

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/room/:code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/api/new-room', (req, res) => res.json({ code: newRoomCode() }));

/** @type {Map<string, any>} */
const rooms = new Map();

// ---------- utils ----------
function newRoomCode() {
  const C = 'bcdfghjklmnprstvz', V = 'aeiou';
  const part = () => Array.from({ length: 5 }, (_, i) => (i % 2 ? V : C)[crypto.randomInt(i % 2 ? V.length : C.length)]).join('');
  let code;
  do code = `${part()}-${part()}`; while (rooms.has(code));
  return code;
}
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};
const pick = (arr) => arr[crypto.randomInt(arr.length)];
const norm = (s) => String(s || '').toLowerCase().replace(/[\s.,!?~'"()\-_:]/g, '');
const clean = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

function getRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
      code, players: [], hostId: null, phase: 'lobby',
      // categories: 비어 있으면 전체에서 랜덤
      settings: { categories: [], mode: 'fool', timers: { hint: 0, vote: 0, defense: 0 } },
      game: null, log: [], seq: 0, emptySince: null, timer: null, timerTok: 0, deadline: null,
      used: {}, lastCategory: null, stats: {}, gameNo: 0,
    });
  }
  return rooms.get(code);
}
const P = (room, id) => room.players.find((p) => p.id === id);
const nameOf = (room, id) => (P(room, id) || { name: '???' }).name;

function bot(room, text) { pushLog(room, { type: 'bot', text }); }
function pushLog(room, msg) {
  msg.id = ++room.seq;
  msg.t = Date.now();
  room.log.push(msg);
  if (room.log.length > 400) room.log.shift();
  io.to(room.code).emit('msg', msg);
}

// ---------- 타이머 ----------
function arm(room, kind) {
  disarm(room);
  const sec = room.settings.timers[kind] || 0;
  if (!sec) return;
  const tok = room.timerTok;
  room.deadline = Date.now() + sec * 1000;
  room.timer = setTimeout(() => {
    if (room.timerTok !== tok) return;
    room.deadline = null;
    try { forceNext(room, '⏰ 시간 초과!'); } catch (e) { console.error(e); }
    sync(room);
  }, sec * 1000);
}
function disarm(room) {
  room.timerTok++;
  clearTimeout(room.timer);
  room.timer = null;
  room.deadline = null;
}

// ---------- 전적 (닉네임 기준, 방 안에서만 유지) ----------
function statOf(room, name) {
  return (room.stats[name] ||= { games: 0, wins: 0, liar: 0, liarWins: 0 });
}
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
function rankingText(room) {
  const rows = Object.entries(room.stats).filter(([, s]) => s.games > 0)
    .sort((a, b) => pct(b[1].wins, b[1].games) - pct(a[1].wins, a[1].games) || b[1].wins - a[1].wins);
  if (!rows.length) return '📊 아직 끝난 판이 없어요.';
  const medal = ['🥇', '🥈', '🥉'];
  return `📊 랭킹 (${room.gameNo}판)\n` + rows.map(([n, s], i) =>
    `${medal[i] || `${i + 1}.`} ${n}  승률 ${pct(s.wins, s.games)}% (${s.wins}/${s.games})` +
    (s.liar ? ` · 라이어 ${s.liar}회 ${s.liarWins}승` : '')).join('\n');
}

// ---------- 상태 전송 ----------
function hintSummary(room) {
  const g = room.game;
  return g.order.map((pid, i) => {
    const hs = g.hints[pid].filter(Boolean);
    const body = hs.length > 1 ? hs.map((h, r) => `[${r + 1}R] ${h}`).join(' → ') : hs[0] || '-';
    return `${i + 1}. ${nameOf(room, pid)}: ${body}`;
  }).join('\n');
}

function publicState(room, viewerId) {
  const g = room.game;
  const s = {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    settings: room.settings,
    categories: CATEGORIES,
    minPlayers: MIN_PLAYERS,
    maxRounds: MAX_ROUNDS,
    players: room.players.map((p) => ({ id: p.id, name: p.name, online: p.online })),
    stats: room.stats,
    gameNo: room.gameNo,
    me: viewerId,
    timerChoices: TIMER_CHOICES,
    deadline: room.deadline,
    serverNow: Date.now(),
  };
  if (g) {
    s.game = {
      category: g.category,
      mode: g.mode,
      round: g.round,
      order: g.order,
      turnId: room.phase === 'hint' ? g.order[g.turnIdx] : null,
      hints: g.hints,
      candidates: g.candidates,
      revote: g.revote,
      voted: Object.keys(g.votes),
      nominee: g.nominee,
      defense: g.defense,
      finalVoted: Object.keys(g.finalVotes),
      result: g.result,
    };
    if (g.order.includes(viewerId)) {
      const isLiar = viewerId === g.liarId;
      if (g.mode === 'fool') {
        s.mine = { word: isLiar ? g.liarWord : g.word };
        if (isLiar && (room.phase === 'guess' || room.phase === 'end')) s.mine.revealedLiar = true;
      } else {
        s.mine = isLiar ? { liar: true } : { word: g.word };
      }
    }
  }
  return s;
}
function sync(room) {
  for (const p of room.players) if (p.socketId) io.to(p.socketId).emit('state', publicState(room, p.id));
}

// ---------- 제시어 고르기 ----------
function chooseCategory(room) {
  const sel = room.settings.categories.filter((c) => CATEGORIES.includes(c));
  const pool = sel.length ? sel : CATEGORIES;
  const fresh = pool.length > 1 ? pool.filter((c) => c !== room.lastCategory) : pool;
  return pick(fresh);
}
// 이미 나온 단어는 그 카테고리를 한 바퀴 다 돌 때까지 다시 안 나온다.
function chooseWords(room, category) {
  const groups = WORDS[category];
  const used = (room.used[category] ||= new Set());
  let options = groups.flatMap((g, gi) => g.filter((w) => !used.has(w)).map((w) => [gi, w]));
  if (!options.length) { used.clear(); options = groups.flatMap((g, gi) => g.map((w) => [gi, w])); }
  const [gi, word] = pick(options);
  used.add(word);
  const liarWord = pick(groups[gi].filter((w) => w !== word));
  return { word, liarWord };
}

// ---------- 게임 진행 ----------
function startGame(room) {
  const active = room.players.filter((p) => p.online);
  if (active.length < MIN_PLAYERS) return `최소 ${MIN_PLAYERS}명이 필요해요. (지금 ${active.length}명)`;
  const category = chooseCategory(room);
  room.lastCategory = category;
  const mode = room.settings.mode;
  const { word, liarWord } = chooseWords(room, category);
  const order = shuffle(active.map((p) => p.id));
  room.game = {
    category, mode, word, liarWord: mode === 'fool' ? liarWord : null,
    liarId: pick(order), order, round: 1, turnIdx: 0,
    hints: Object.fromEntries(order.map((id) => [id, []])),
    votes: {}, candidates: [], revote: false, nominee: null, defense: null, finalVotes: {}, result: null,
  };
  room.phase = 'hint';
  bot(room, `🎭 게임 시작! ${category} · ${mode === 'fool' ? '바보 모드 🤪' : '일반 모드'} · ${order.length}명\n제시어는 화면 맨 위에 있어요.`);
  announceTurn(room);
  return null;
}

function announceTurn(room) {
  const g = room.game;
  bot(room, `🗣️ ${nameOf(room, g.order[g.turnIdx])} 님 차례${g.round > 1 ? ` (${g.round}R)` : ''}`);
  arm(room, 'hint');
}

function submitHint(room, id, text) {
  const g = room.game;
  g.hints[id][g.round - 1] = text || '(패스)';
  bot(room, `💬 ${nameOf(room, id)}: ${g.hints[id][g.round - 1]}`);
  g.turnIdx++;
  if (g.turnIdx < g.order.length) return announceTurn(room);
  bot(room, `📝 힌트 요약\n${hintSummary(room)}\n\n토론하고 아래에서 투표하세요!`);
  openVote(room, [...g.order], false);
}

function openVote(room, candidates, revote) {
  const g = room.game;
  room.phase = 'vote';
  g.votes = {};
  g.candidates = candidates;
  g.revote = revote;
  g.nominee = null; g.defense = null; g.finalVotes = {};
  if (revote) bot(room, `⚖️ 동률! ${candidates.map((c) => nameOf(room, c)).join(' vs ')} 재투표`);
  arm(room, 'vote');
}

function castVote(room, voterId, targetId) {
  const g = room.game;
  if (!g.candidates.includes(targetId) || targetId === voterId) return;
  g.votes[voterId] = targetId;
  const n = g.order.length;
  const count = Object.keys(g.votes).length;
  const top = Math.max(...Object.values(tallyVotes(g)));
  if (top > n / 2 && count < n) return closeVote(room, true);
  if (count >= n) closeVote(room);
}
function tallyVotes(g) {
  const t = Object.fromEntries(g.candidates.map((c) => [c, 0]));
  for (const v of Object.values(g.votes)) if (v in t) t[v]++;
  return t;
}
function closeVote(room, early = false) {
  const g = room.game;
  const t = tallyVotes(g);
  const sorted = [...g.candidates].sort((a, b) => t[b] - t[a]);
  bot(room, `📊 개표${early ? ' (과반 조기 종료)' : ''}\n${sorted.filter((c) => t[c] > 0).map((c) => `${nameOf(room, c)} ${t[c]}표`).join(' · ') || '표 없음'}`);
  const top = Math.max(...Object.values(t));
  const leaders = g.candidates.filter((c) => t[c] === top);
  if (top === 0) return failRound(room, '아무도 투표하지 않았어요.');
  if (leaders.length > 1) {
    if (!g.revote) return openVote(room, leaders, true);
    return failRound(room, '재투표도 동률이에요.');
  }
  g.nominee = leaders[0];
  room.phase = 'defense';
  bot(room, `🎤 ${nameOf(room, g.nominee)} 님 지목! 해명하세요.`);
  arm(room, 'defense');
}

function submitDefense(room, text) {
  const g = room.game;
  g.defense = text || '(해명 없음)';
  room.phase = 'final';
  g.finalVotes = {};
  bot(room, `⚖️ ${nameOf(room, g.nominee)} 님 해명: ${g.defense}\n라이어로 지목할까요? 찬반 투표!`);
  arm(room, 'vote');
}

function castFinal(room, voterId, agree) {
  const g = room.game;
  if (voterId === g.nominee) return;
  g.finalVotes[voterId] = !!agree;
  const eligible = g.order.length - 1;
  const vals = Object.values(g.finalVotes);
  const yes = vals.filter(Boolean).length, no = vals.length - yes;
  if (vals.length < eligible && (yes > eligible / 2 || no >= eligible / 2)) return closeFinal(room, true);
  if (vals.length >= eligible) closeFinal(room);
}
function closeFinal(room, early = false) {
  const g = room.game;
  const vals = Object.values(g.finalVotes);
  const yes = vals.filter(Boolean).length, no = vals.length - yes;
  const tally = `찬성 ${yes} · 반대 ${no}${early ? ' (조기 종료)' : ''}`;
  if (yes <= no) return failRound(room, `${tally} → 🤝 합의 실패!`);
  if (g.nominee === g.liarId) {
    room.phase = 'guess';
    bot(room, `${tally}\n🎯 ${nameOf(room, g.nominee)} 님은 라이어였습니다!` +
      (g.mode === 'fool' ? ` (받은 단어: ${g.liarWord} 🤪)` : '') + '\n마지막 기회! 시민들의 제시어를 맞혀보세요.');
    arm(room, 'defense');
  } else {
    bot(room, tally);
    endGame(room, 'liar', `❌ ${nameOf(room, g.nominee)} 님은 라이어가 아니었어요! 라이어 승리 🎭`);
  }
}

function failRound(room, why) {
  const g = room.game;
  if (g.round >= MAX_ROUNDS) return endGame(room, 'liar', `${why}\n${MAX_ROUNDS}라운드 안에 못 찾았어요. 라이어 승리 🎭`);
  g.round++;
  g.turnIdx = 0;
  room.phase = 'hint';
  bot(room, `${why} 힌트 ${g.round}라운드!`);
  announceTurn(room);
}

function submitGuess(room, text) {
  const g = room.game;
  const ok = norm(text) && norm(text) === norm(g.word);
  if (ok) endGame(room, 'liar', `⭕ 정답! (${text}) 라이어 역전승 🎭`);
  else endGame(room, 'citizen', `❌ 오답! (${text || '제출 없음'}) 시민 승리 🎉`);
}

function endGame(room, winner, headline) {
  const g = room.game;
  disarm(room);
  room.phase = 'end';
  g.result = { winner, word: g.word, liarWord: g.liarWord, liarId: g.liarId };
  room.gameNo++;
  for (const id of g.order) {
    const s = statOf(room, nameOf(room, id));
    const isLiar = id === g.liarId;
    const won = (winner === 'liar') === isLiar;
    s.games++;
    if (won) s.wins++;
    if (isLiar) { s.liar++; if (won) s.liarWins++; }
  }
  bot(room, `${headline}\n\n제시어: ${g.word}` + (g.mode === 'fool' ? ` / 라이어 단어: ${g.liarWord}` : '') +
    `\n라이어: ${nameOf(room, g.liarId)} · 카테고리: ${g.category}\n\n/시작 으로 바로 한 판 더, /랭킹 으로 전적 보기`);
}

function forceNext(room, reason) {
  const g = room.game;
  if (!g || room.phase === 'lobby' || room.phase === 'end') return false;
  disarm(room);
  switch (room.phase) {
    case 'hint': bot(room, `${reason} ${nameOf(room, g.order[g.turnIdx])} 님 패스`); submitHint(room, g.order[g.turnIdx], '(패스)'); break;
    case 'vote': bot(room, `${reason} 투표 마감`); closeVote(room); break;
    case 'defense': bot(room, `${reason} 해명 없이 진행`); submitDefense(room, '(해명 없음)'); break;
    case 'final': bot(room, `${reason} 찬반 투표 마감`); closeFinal(room); break;
    case 'guess': bot(room, `${reason} 정답 제출 없음`); submitGuess(room, ''); break;
  }
  return true;
}

function resetToLobby(room) {
  disarm(room);
  room.phase = 'lobby';
  room.game = null;
  room.players = room.players.filter((p) => p.online || !p.announcedOff);
}

// 한 판 더: 끝난 판이면 같은 설정으로 바로 새 판
function quickStart(room) {
  if (room.phase === 'end') resetToLobby(room);
  if (room.phase !== 'lobby') return '이미 게임이 진행 중이에요. 그만하려면 /초기화';
  return startGame(room);
}

// ---------- 채팅 명령어 (누구나 사용 가능) ----------
const HELP = `📖 명령어 (누구나 사용 가능)
/시작 · 게임 시작 (끝난 판이면 같은 설정으로 바로 한 판 더)
/초기화 · 진행 중인 판을 끝내고 대기실로
/넘기기 · 잠수한 사람 차례·투표를 넘기기
/힌트요약 · 지금까지 힌트 다시 보기
/랭킹 · 승률 랭킹 보기
/명령어 · 이 도움말`;

function runCommand(room, me, text) {
  const cmd = text.slice(1).split(/\s+/)[0];
  switch (cmd) {
    case '시작': case '게임시작': case '한판더': {
      const err = quickStart(room);
      if (err) bot(room, `⚠️ ${err}`);
      return true;
    }
    case '초기화': case '리셋':
      if (room.phase === 'lobby') { bot(room, '이미 대기실이에요. /시작 으로 시작하세요.'); return true; }
      resetToLobby(room);
      bot(room, `🧹 ${me.name} 님이 초기화했어요. (현재 ${room.players.filter((p) => p.online).length}명)\n/시작 으로 새 판!`);
      return true;
    case '넘기기': case '스킵': case '패스':
      if (!forceNext(room, `⏭️ ${me.name} 님이 넘겼어요:`)) bot(room, '지금은 넘길 게 없어요.');
      return true;
    case '힌트요약': case '요약': case '힌트':
      if (!room.game || !room.game.order.some((id) => room.game.hints[id].length)) bot(room, '아직 힌트가 없어요.');
      else bot(room, `📝 힌트 요약\n${hintSummary(room)}`);
      return true;
    case '랭킹': case '전적': case '승률':
      bot(room, rankingText(room));
      return true;
    case '참가':
      bot(room, `✅ ${me.name} 님은 이미 참가 중이에요.`);
      return true;
    case '명령어': case '도움말': case '도움':
      bot(room, HELP);
      return true;
    default:
      return false;
  }
}

// ---------- sockets ----------
io.on('connection', (socket) => {
  let room = null, me = null;

  socket.on('join', ({ code, name, playerId }, ack) => {
    code = clean(code, 40).toLowerCase();
    name = clean(name, 12);
    if (!/^[a-z0-9-]{3,40}$/.test(code)) return ack?.({ error: '잘못된 방 주소예요.' });
    if (!name) return ack?.({ error: '닉네임을 입력하세요.' });
    room = getRoom(code);
    let p = playerId && P(room, playerId);
    if (!p) {
      if (room.players.length >= MAX_PLAYERS) return ack?.({ error: `방이 가득 찼어요. (최대 ${MAX_PLAYERS}명)` });
      let n = name, k = 2;
      while (room.players.some((x) => x.name === n)) n = `${name}${k++}`;
      p = { id: crypto.randomUUID(), name: n, online: true };
      room.players.push(p);
      if (room.phase === 'lobby') bot(room, `✅ ${p.name} 님 참가! (현재 ${room.players.length}명)`);
      else bot(room, `👀 ${p.name} 님 입장 · 다음 판부터 참여해요.`);
    } else if (!p.online && p.announcedOff) {
      bot(room, `🔌 ${p.name} 님 다시 접속`);
    }
    p.announcedOff = false;
    if (p.socketId && p.socketId !== socket.id) io.sockets.sockets.get(p.socketId)?.disconnect(true);
    p.online = true;
    p.socketId = socket.id;
    me = p;
    room.emptySince = null;
    const host = P(room, room.hostId);
    if (!host || (!host.online && host.announcedOff)) room.hostId = p.id;
    socket.join(code);
    ack?.({ ok: true, playerId: p.id, log: room.log });
    sync(room);
  });

  const guard = (fn) => (...args) => {
    if (!room || !me) return;
    try { fn(...args); } catch (e) { console.error(e); }
    sync(room);
  };
  const isHost = () => room.hostId === me.id;
  const inGame = () => room.game && room.game.order.includes(me.id);

  socket.on('chat', guard((text) => {
    text = clean(text, 200);
    if (!text) return;
    pushLog(room, { type: 'chat', from: me.id, name: me.name, text });
    if (text.startsWith('/')) runCommand(room, me, text);
  }));

  socket.on('settings', guard((s) => {
    if (!isHost() || room.phase !== 'lobby') return;
    if (Array.isArray(s.categories)) room.settings.categories = s.categories.filter((c) => CATEGORIES.includes(c));
    if (s.mode === 'fool' || s.mode === 'normal') room.settings.mode = s.mode;
    if (s.timers) for (const k of ['hint', 'vote', 'defense']) {
      const v = Number(s.timers[k]);
      if (TIMER_CHOICES.includes(v)) room.settings.timers[k] = v;
    }
  }));

  socket.on('start', guard(() => {
    if (!isHost()) return;
    const err = quickStart(room);
    if (err) socket.emit('toast', err);
  }));

  socket.on('hint', guard((text) => {
    const g = room.game;
    if (room.phase !== 'hint' || g.order[g.turnIdx] !== me.id) return;
    submitHint(room, me.id, clean(text, 60));
  }));

  socket.on('vote', guard((targetId) => {
    if (room.phase !== 'vote' || !inGame()) return;
    castVote(room, me.id, targetId);
  }));

  socket.on('defense', guard((text) => {
    if (room.phase !== 'defense' || room.game.nominee !== me.id) return;
    submitDefense(room, clean(text, 120));
  }));

  socket.on('final', guard((agree) => {
    if (room.phase !== 'final' || !inGame()) return;
    castFinal(room, me.id, agree);
  }));

  socket.on('guess', guard((text) => {
    if (room.phase !== 'guess' || room.game.liarId !== me.id) return;
    submitGuess(room, clean(text, 40));
  }));

  socket.on('force', guard(() => { forceNext(room, `⏭️ ${me.name} 님이 넘겼어요:`); }));

  socket.on('reset', guard(() => {
    if (room.phase === 'lobby') return;
    resetToLobby(room);
    bot(room, `🧹 ${me.name} 님이 초기화했어요. /시작 으로 새 판!`);
  }));

  socket.on('kick', guard((id) => {
    if (!isHost() || room.phase !== 'lobby' || id === me.id) return;
    const p = P(room, id);
    if (!p) return;
    room.players = room.players.filter((x) => x.id !== id);
    if (p.socketId) { io.to(p.socketId).emit('kicked'); io.sockets.sockets.get(p.socketId)?.disconnect(true); }
    bot(room, `👋 ${p.name} 님이 내보내졌어요.`);
  }));

  socket.on('leave', guard(() => {
    if (room.phase === 'lobby' || !inGame()) {
      room.players = room.players.filter((x) => x.id !== me.id);
      bot(room, `👋 ${me.name} 님이 나갔어요.`);
    }
    me.online = false; me.socketId = null; me.announcedOff = true;
    if (room.hostId === me.id) { const next = room.players.find((x) => x.online); room.hostId = next ? next.id : null; }
  }));

  socket.on('disconnect', () => {
    if (!room || !me || me.socketId !== socket.id) return;
    const p = me, r = room;
    p.online = false;
    p.socketId = null;
    if (!r.players.some((x) => x.online)) r.emptySince = Date.now();
    // 폰에서 앱 전환·새로고침으로 잠깐 끊기는 경우가 많아서 20초 유예 후 처리
    setTimeout(() => {
      if (p.online || !P(r, p.id)) return;
      p.announcedOff = true;
      if (r.phase === 'lobby') {
        r.players = r.players.filter((x) => x.id !== p.id);
        bot(r, `👋 ${p.name} 님이 나갔어요.`);
      } else if (r.game && r.game.order.includes(p.id)) {
        bot(r, `📴 ${p.name} 님 연결 끊김 (/넘기기 로 차례를 넘길 수 있어요)`);
      }
      if (r.hostId === p.id) {
        const next = r.players.find((x) => x.online);
        if (next) { r.hostId = next.id; bot(r, `👑 방장이 ${next.name} 님으로 바뀌었어요.`); }
      }
      sync(r);
    }, 20000);
    sync(r);
  });
});

// 빈 방 정리 (30분)
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) if (r.emptySince && now - r.emptySince > 30 * 60 * 1000) rooms.delete(code);
}, 5 * 60 * 1000);

server.listen(PORT, () => console.log(`바보 라이어 서버: http://localhost:${PORT}`));
