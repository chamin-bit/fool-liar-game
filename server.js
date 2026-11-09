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
const norm = (s) => String(s || '').toLowerCase().replace(/[\s.,!?~'"()\-_]/g, '');
const clean = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

function getRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
      code, players: [], hostId: null, phase: 'lobby',
      settings: { category: '랜덤', mode: 'fool', timers: { hint: 0, vote: 0, defense: 0 } },
      game: null, log: [], seq: 0, emptySince: null, timer: null, timerTok: 0, deadline: null,
    });
  }
  return rooms.get(code);
}
const P = (room, id) => room.players.find((p) => p.id === id);
const nameOf = (room, id) => (P(room, id) || { name: '???' }).name;

function bot(room, text) { pushLog(room, { type: 'bot', text }); }

// ---------- 타이머 ----------
const TIMER_CHOICES = [0, 10, 15, 20, 30, 45, 60, 90, 120];
function arm(room, kind) {
  disarm(room);
  const sec = room.settings.timers[kind] || 0;
  if (!sec) return;
  const tok = room.timerTok;
  room.deadline = Date.now() + sec * 1000;
  room.timer = setTimeout(() => {
    if (room.timerTok !== tok) return;
    room.deadline = null;
    try { forceNext(room, true); } catch (e) { console.error(e); }
    sync(room);
  }, sec * 1000);
}
function disarm(room) {
  room.timerTok++;
  clearTimeout(room.timer);
  room.timer = null;
  room.deadline = null;
}
function pushLog(room, msg) {
  msg.id = ++room.seq;
  msg.t = Date.now();
  room.log.push(msg);
  if (room.log.length > 400) room.log.shift();
  io.to(room.code).emit('msg', msg);
}

// ---------- state broadcast ----------
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
        s.mine = { word: isLiar ? g.liarWord : g.word, knowsLiar: false };
        if (isLiar && (room.phase === 'guess' || room.phase === 'end')) s.mine.revealedLiar = true;
      } else {
        s.mine = isLiar ? { liar: true, knowsLiar: true } : { word: g.word, knowsLiar: true };
      }
    }
  }
  return s;
}
function sync(room) {
  for (const p of room.players) if (p.socketId) io.to(p.socketId).emit('state', publicState(room, p.id));
}

// ---------- game flow ----------
function startGame(room) {
  const active = room.players.filter((p) => p.online);
  if (active.length < MIN_PLAYERS) return `최소 ${MIN_PLAYERS}명이 필요해요.`;
  const category = room.settings.category === '랜덤' ? pick(CATEGORIES) : room.settings.category;
  const mode = room.settings.mode;
  const [word, liarWord] = shuffle(WORDS[category]);
  const order = shuffle(active.map((p) => p.id));
  room.game = {
    category, mode, word, liarWord: mode === 'fool' ? liarWord : null,
    liarId: pick(order), order, round: 1, turnIdx: 0,
    hints: Object.fromEntries(order.map((id) => [id, []])),
    votes: {}, candidates: [], revote: false, nominee: null, defense: null, finalVotes: {}, result: null,
  };
  room.phase = 'hint';
  bot(room, `🎭 게임 시작!\n• 카테고리: ${category}\n• 모드: ${mode === 'fool' ? '바보 모드 🤪' : '일반 모드'}\n• 참가자: ${order.length}명\n\n화면 위쪽 카드에서 제시어를 확인하세요.` +
    (mode === 'fool' ? '\n(바보 모드: 라이어도 제시어를 받지만 다른 단어예요. 본인이 라이어인지 아무도 몰라요!)' : ''));
  announceTurn(room);
}

function announceTurn(room) {
  const g = room.game;
  const id = g.order[g.turnIdx];
  bot(room, `🗣️ ${nameOf(room, id)} 님 차례입니다${g.round > 1 ? ` - ${g.round}라운드` : ''}.\n힌트를 입력하세요. 예) 매콤해요`);
  arm(room, 'hint');
}

function submitHint(room, id, text) {
  const g = room.game;
  g.hints[id][g.round - 1] = text || '(패스)';
  bot(room, `🗣️ ${nameOf(room, id)}: ${g.hints[id][g.round - 1]}`);
  g.turnIdx++;
  if (g.turnIdx < g.order.length) return announceTurn(room);
  // 힌트 요약 → 투표
  const lines = g.order.map((pid, i) => {
    const hs = g.hints[pid];
    const body = hs.length > 1 ? hs.map((h, r) => `[${r + 1}R] ${h}`).join(' → ') : hs[0];
    return `  ${i + 1}. ${nameOf(room, pid)}: ${body}`;
  });
  bot(room, `📝 힌트 요약\n${lines.join('\n')}\n\n자유롭게 토론한 뒤, 라이어로 의심되는 사람에게 투표하세요.`);
  openVote(room, [...g.order], false);
}

function openVote(room, candidates, revote) {
  const g = room.game;
  room.phase = 'vote';
  g.votes = {};
  g.candidates = candidates;
  g.revote = revote;
  g.nominee = null; g.defense = null; g.finalVotes = {};
  if (revote) bot(room, `⚖️ 동률입니다! 재투표를 진행합니다. (1인 1표)\n${candidates.map((c, i) => `  ${i + 1}. ${nameOf(room, c)}`).join('\n')}`);
  else bot(room, '🗳️ 투표해 주세요! 아래 버튼에서 의심되는 사람을 고르세요.');
  arm(room, 'vote');
}

function castVote(room, voterId, targetId) {
  const g = room.game;
  if (!g.candidates.includes(targetId) || targetId === voterId) return;
  const first = !(voterId in g.votes);
  g.votes[voterId] = targetId;
  const n = g.order.length;
  const count = Object.keys(g.votes).length;
  if (first) bot(room, `🗳️ ${nameOf(room, voterId)} 투표 완료 (${count}/${n})`);
  const tally = tallyVotes(g);
  const top = Math.max(...Object.values(tally));
  if (top > n / 2 && count < n) { bot(room, '⚡ 과반이 나와 조기 종료합니다.'); return closeVote(room); }
  if (count >= n) closeVote(room);
}
function tallyVotes(g) {
  const t = Object.fromEntries(g.candidates.map((c) => [c, 0]));
  for (const v of Object.values(g.votes)) if (v in t) t[v]++;
  return t;
}
function closeVote(room) {
  const g = room.game;
  const t = tallyVotes(g);
  bot(room, `📊 개표 결과\n${g.candidates.map((c) => `  ${nameOf(room, c)}: ${t[c]}표`).join('\n')}`);
  const top = Math.max(...Object.values(t));
  const leaders = g.candidates.filter((c) => t[c] === top);
  if (top === 0) return failRound(room, '아무도 투표하지 않았어요.');
  if (leaders.length > 1) {
    if (!g.revote) return openVote(room, leaders, true);
    return failRound(room, '재투표도 동률이에요.');
  }
  g.nominee = leaders[0];
  room.phase = 'defense';
  bot(room, `🎤 ${nameOf(room, g.nominee)} 님이 지목되었습니다.\n해명을 입력해주세요.\n예) 제가 말한 힌트는 제시어의 모양을 표현한 거예요.`);
  arm(room, 'defense');
}

function submitDefense(room, text) {
  const g = room.game;
  g.defense = text || '(해명 없음)';
  room.phase = 'final';
  g.finalVotes = {};
  bot(room, `⚖️ ${nameOf(room, g.nominee)} 님의 해명이 제출되었습니다.\n\n💬 ${g.defense}\n\n이 사람을 라이어로 지목할지 최종 투표해주세요.\n(지목 대상 본인 제외 ${g.order.length - 1}명 투표)`);
  arm(room, 'vote');
}

function castFinal(room, voterId, agree) {
  const g = room.game;
  if (voterId === g.nominee) return;
  const first = !(voterId in g.finalVotes);
  g.finalVotes[voterId] = !!agree;
  const eligible = g.order.length - 1;
  const vals = Object.values(g.finalVotes);
  const yes = vals.filter(Boolean).length, no = vals.length - yes;
  if (first) bot(room, `⚖️ 투표 완료 (${vals.length}/${eligible})`);
  if (vals.length < eligible && (yes > eligible / 2 || no >= eligible / 2)) {
    bot(room, '⚡ 과반이 나와 조기 종료합니다.');
    return closeFinal(room);
  }
  if (vals.length >= eligible) closeFinal(room);
}
function closeFinal(room) {
  const g = room.game;
  const vals = Object.values(g.finalVotes);
  const yes = vals.filter(Boolean).length, no = vals.length - yes;
  bot(room, `찬성 ${yes} · 반대 ${no}`);
  if (yes <= no) return failRound(room, '🤝 합의 실패!');
  if (g.nominee === g.liarId) {
    room.phase = 'guess';
    bot(room, `🎯 ${nameOf(room, g.nominee)} 님은 라이어였습니다!\n` +
      (g.mode === 'fool' ? `(바보 모드: 받은 단어는 "${g.liarWord}"였어요 🤪)\n` : '') +
      '라이어에게 마지막 기회: 시민들의 제시어를 맞혀보세요.');
    arm(room, 'defense');
  } else {
    endGame(room, 'liar', `❌ ${nameOf(room, g.nominee)} 님은 라이어가 아니었습니다!\n라이어 승리! 🎭`);
  }
}

function failRound(room, why) {
  const g = room.game;
  if (g.round >= MAX_ROUNDS) return endGame(room, 'liar', `${why}\n${MAX_ROUNDS}라운드 안에 라이어를 찾지 못했어요.\n라이어 승리! 🎭`);
  g.round++;
  g.turnIdx = 0;
  room.phase = 'hint';
  bot(room, `${why} 힌트 ${g.round}라운드를 진행합니다.`);
  announceTurn(room);
}

function submitGuess(room, text) {
  const g = room.game;
  const ok = norm(text) && norm(text) === norm(g.word);
  if (ok) endGame(room, 'liar', `⭕ 정답! (제출: ${text})\n라이어 역전승! 🎭`);
  else endGame(room, 'citizen', `❌ 오답! (제출: ${text || '없음'})\n시민 승리! 🎉`);
}

function endGame(room, winner, headline) {
  const g = room.game;
  disarm(room);
  room.phase = 'end';
  g.result = { winner, word: g.word, liarWord: g.liarWord, liarId: g.liarId };
  bot(room, `${headline}\n\n카테고리: ${g.category}\n정답 제시어: ${g.word}\n` +
    (g.mode === 'fool' ? `라이어가 받은 단어: ${g.liarWord}\n` : '') + `라이어: ${nameOf(room, g.liarId)}`);
  bot(room, '🔁 한 판 더? 방장이 아래 버튼으로 새 판을 시작할 수 있어요.');
}

// 방장 강제 진행 (잠수/이탈 대응)
function forceNext(room, timeout = false) {
  const g = room.game;
  if (!g) return;
  disarm(room);
  const who = timeout ? '⏰ 시간 초과!' : '⏭️ 방장이 넘겼어요.';
  switch (room.phase) {
    case 'hint': bot(room, `${who} (${nameOf(room, g.order[g.turnIdx])} 님 차례)`); return submitHint(room, g.order[g.turnIdx], '(패스)');
    case 'vote': bot(room, `${who} 투표를 마감합니다.`); return closeVote(room);
    case 'defense': bot(room, who); return submitDefense(room, '(해명 없음)');
    case 'final': bot(room, `${who} 최종 투표를 마감합니다.`); return closeFinal(room);
    case 'guess': bot(room, who); return submitGuess(room, '');
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
      else bot(room, `👀 ${p.name} 님이 들어왔어요. 다음 판부터 참여합니다.`);
    } else if (!p.online && p.announcedOff) {
      bot(room, `🔌 ${p.name} 님이 다시 접속했어요.`);
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
    if (text) pushLog(room, { type: 'chat', from: me.id, name: me.name, text });
  }));

  socket.on('settings', guard((s) => {
    if (!isHost() || room.phase !== 'lobby') return;
    if (s.category === '랜덤' || CATEGORIES.includes(s.category)) room.settings.category = s.category;
    if (s.mode === 'fool' || s.mode === 'normal') room.settings.mode = s.mode;
    if (s.timers) for (const k of ['hint', 'vote', 'defense']) {
      const v = Number(s.timers[k]);
      if (TIMER_CHOICES.includes(v)) room.settings.timers[k] = v;
    }
  }));

  socket.on('start', guard(() => {
    if (!isHost() || room.phase !== 'lobby') return;
    const err = startGame(room);
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

  socket.on('force', guard(() => { if (isHost()) forceNext(room); }));

  socket.on('reset', guard(() => {
    if (!isHost()) return;
    if (room.phase !== 'end') bot(room, '🧹 방장이 게임을 초기화했습니다.');
    disarm(room);
    room.phase = 'lobby';
    room.game = null;
    room.players = room.players.filter((p) => p.online);
    bot(room, `🎭 새 판 대기 중! (현재 ${room.players.length}명)\n방장이 카테고리와 모드를 고르고 시작하세요.`);
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
        bot(r, `📴 ${p.name} 님 연결이 끊겼어요. (방장이 ⏭️ 버튼으로 넘길 수 있어요)`);
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
