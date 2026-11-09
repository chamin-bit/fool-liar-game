(() => {
  const $ = (s) => document.querySelector(s);
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  };
  const show = (id) => ['home', 'nameGate', 'room'].forEach((x) => $('#' + x).classList.toggle('hidden', x !== id));
  const toast = (t) => {
    const el = $('#toast');
    el.textContent = t;
    el.classList.remove('hidden');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.add('hidden'), 2200);
  };
  const store = {
    get name() { try { return localStorage.getItem('liar.name') || ''; } catch { return ''; } },
    set name(v) { try { localStorage.setItem('liar.name', v); } catch {} },
    pid(code) { try { return localStorage.getItem('liar.pid.' + code); } catch { return null; } },
    setPid(code, v) { try { localStorage.setItem('liar.pid.' + code, v); } catch {} },
  };

  const match = location.pathname.match(/^\/room\/([a-z0-9-]+)/i);
  const code = match ? match[1].toLowerCase() : null;

  // ---------- 홈 ----------
  if (!code) {
    show('home');
    $('#homeName').value = store.name;
    $('#createBtn').onclick = async () => {
      const name = $('#homeName').value.trim();
      if (!name) return toast('닉네임을 입력하세요');
      store.name = name;
      const r = await fetch('/api/new-room').then((x) => x.json());
      location.href = '/room/' + r.code;
    };
    const join = () => {
      const name = $('#homeName').value.trim();
      let c = $('#joinCode').value.trim();
      c = c.replace(/^.*\/room\//, '').toLowerCase();
      if (!name) return toast('닉네임을 입력하세요');
      if (!c) return toast('방 코드를 입력하세요');
      store.name = name;
      location.href = '/room/' + encodeURIComponent(c);
    };
    $('#joinBtn').onclick = join;
    $('#joinCode').onkeydown = (e) => e.key === 'Enter' && join();
    return;
  }

  // ---------- 이름 ----------
  if (!store.name) {
    show('nameGate');
    $('#gateCode').textContent = `방 코드: ${code}`;
    const go = () => {
      const n = $('#gateName').value.trim();
      if (!n) return toast('닉네임을 입력하세요');
      store.name = n;
      enter();
    };
    $('#gateBtn').onclick = go;
    $('#gateName').onkeydown = (e) => e.key === 'Enter' && go();
    $('#gateName').focus();
  } else enter();

  // ---------- 방 ----------
  function enter() {
    show('room');
    $('#roomCode').textContent = code;
    const socket = io({ reconnectionDelay: 500 });
    let S = null;
    let skew = 0;
    let actionKey = '';
    let lastSender = null;
    let myVote = null;
    let myFinal = null;

    const join = () => socket.emit('join', { code, name: store.name, playerId: store.pid(code) }, (r) => {
      if (r.error) { toast(r.error); setTimeout(() => (location.href = '/'), 1500); return; }
      store.setPid(code, r.playerId);
      $('#feed').innerHTML = '';
      lastSender = null;
      r.log.forEach(addMsg);
      scrollFeed(true);
    });
    socket.on('connect', join);
    socket.on('kicked', () => { toast('방에서 내보내졌어요'); setTimeout(() => (location.href = '/'), 1200); });
    socket.on('toast', toast);
    socket.on('msg', (m) => { const near = nearBottom(); addMsg(m); scrollFeed(near); });
    socket.on('state', (s) => {
      const prevPhase = S && S.phase, prevRound = S && S.game && S.game.round, prevCands = S && S.game && S.game.candidates.join();
      S = s;
      skew = s.serverNow - Date.now();
      const g = s.game;
      if (!g || s.phase !== prevPhase || g.round !== prevRound || g.candidates.join() !== prevCands) { myVote = null; myFinal = null; }
      const near = nearBottom();
      render();
      scrollFeed(near);
    });

    // 피드
    const nearBottom = () => { const f = $('#feed'); return f.scrollHeight - f.scrollTop - f.clientHeight < 160; };
    new ResizeObserver(() => scrollFeed(stick)).observe($('#feed'));
    let stick = true;
    $('#feed').addEventListener('scroll', () => (stick = nearBottom()), { passive: true });
    const scrollFeed = (force) => { if (force) { const f = $('#feed'); f.scrollTop = f.scrollHeight; } };
    const fmtTime = (t) => new Date(t).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
    function addMsg(m) {
      const sender = m.type === 'bot' ? 'bot' : m.from;
      const mine = S ? m.from === S.me : m.from === store.pid(code);
      const cont = sender === lastSender;
      lastSender = sender;
      const bubble = h('div', { class: 'bubble' }, m.text);
      const time = h('span', { class: 'time' }, fmtTime(m.t));
      let el;
      if (mine) el = h('div', { class: 'msg mine' }, time, bubble);
      else el = h('div', { class: `msg ${m.type === 'bot' ? 'bot' : ''} ${cont ? 'cont' : ''}` },
        h('div', { class: 'avatar' }, m.type === 'bot' ? '🎭' : '🙂'),
        h('div', { class: 'body' }, h('div', { class: 'name' }, m.type === 'bot' ? '라이어게임' : m.name), h('div', { style: 'display:flex;gap:4px;align-items:flex-end' }, bubble, time)));
      $('#feed').append(el);
    }

    // 채팅
    $('#chatForm').onsubmit = (e) => {
      e.preventDefault();
      const v = $('#chatInput').value.trim();
      if (!v) return;
      socket.emit('chat', v);
      $('#chatInput').value = '';
    };

    // 메뉴
    $('#menuBtn').onclick = (e) => { e.stopPropagation(); $('#menu').classList.toggle('hidden'); };
    document.addEventListener('click', () => $('#menu').classList.add('hidden'));
    $('#menu').onclick = (e) => {
      const act = e.target.dataset.act;
      if (act === 'force') socket.emit('force');
      if (act === 'reset' && confirm('진행 중인 게임을 초기화할까요?')) socket.emit('reset');
      if (act === 'leave' && confirm('방을 나갈까요?')) { socket.emit('leave'); location.href = '/'; }
    };
    $('#copyBtn').onclick = async () => {
      const url = location.origin + '/room/' + code;
      if (navigator.share && /Mobi|Android/i.test(navigator.userAgent)) {
        try { await navigator.share({ title: '바보 라이어 같이 해요!', url }); return; } catch {}
      }
      try { await navigator.clipboard.writeText(url); toast('초대 링크를 복사했어요'); } catch { prompt('이 링크를 복사하세요', url); }
    };

    // 타이머 표시
    setInterval(() => {
      const el = $('#timer');
      if (!el || !S || !S.deadline) return;
      const left = Math.max(0, Math.ceil((S.deadline - (Date.now() + skew)) / 1000));
      el.textContent = `⏱ ${left}초`;
      el.classList.toggle('low', left <= 5);
    }, 250);

    const nm = (id) => (S.players.find((p) => p.id === id) || { name: '???' }).name;
    const isHost = () => S.hostId === S.me;
    const timerEl = () => (S.deadline ? h('span', { id: 'timer', class: 'timer' }, '') : null);

    function render() {
      const g = S.game;
      document.querySelectorAll('.host-only').forEach((b) => b.classList.toggle('hidden', !isHost()));

      // 참가자
      const order = g ? g.order : [];
      const list = g ? [...order.map((id) => S.players.find((p) => p.id === id)).filter(Boolean), ...S.players.filter((p) => !order.includes(p.id))] : S.players;
      $('#players').replaceChildren(...list.map((p, i) => h('span', {
        class: `pchip ${p.online ? '' : 'off'} ${g && g.turnId === p.id ? 'turn' : ''} ${p.id === S.me ? 'me' : ''}`,
      },
      g && order.includes(p.id) ? `${i + 1}.` : null,
      p.id === S.hostId ? '👑' : null,
      p.name,
      g && !order.includes(p.id) ? ' (관전)' : null,
      !g && isHost() && p.id !== S.me ? h('button', { class: 'x', title: '내보내기', onclick: () => confirm(`${p.name} 님을 내보낼까요?`) && socket.emit('kick', p.id) }, '✕') : null)));

      // 제시어 카드
      const wc = $('#wordCard');
      if (g && S.mine) {
        wc.classList.remove('hidden');
        const liar = S.mine.liar;
        wc.classList.toggle('liar', !!liar || !!S.mine.revealedLiar);
        wc.replaceChildren(
          h('div', {},
            h('div', { class: 'label' }, liar ? '당신은' : S.mine.revealedLiar ? '사실 당신은 라이어였어요! 받은 단어' : '내 제시어'),
            h('div', { class: 'word' }, liar ? '🤥 라이어' : S.mine.word)),
          h('div', { class: 'meta' }, `카테고리 ${g.category}`, h('br'), g.mode === 'fool' ? '🤪 바보 모드' : '일반 모드', h('br'), `${g.round}라운드`));
      } else if (g) {
        wc.classList.remove('hidden', 'liar');
        wc.replaceChildren(h('div', {}, h('div', { class: 'label' }, '관전 중'), h('div', { class: 'word' }, '👀')),
          h('div', { class: 'meta' }, `카테고리 ${g.category}`, h('br'), `${g.round}라운드`));
      } else wc.classList.add('hidden');

      renderAction();
    }

    function renderAction() {
      const g = S.game;
      const inGame = g && g.order.includes(S.me);
      const key = JSON.stringify([S.phase, S.hostId === S.me, S.settings, S.players.length, S.deadline, g && [g.turnId, g.round, g.candidates, g.nominee, g.voted.includes(S.me), g.finalVoted.includes(S.me), S.phase === 'vote' || S.phase === 'final' ? [g.voted.length, g.finalVoted.length] : 0], myVote, myFinal, inGame]);
      if (key === actionKey) return;
      actionKey = key;
      const A = $('#action');
      const focused = document.activeElement && A.contains(document.activeElement) ? document.activeElement.id : null;
      const draft = focused ? document.activeElement.value : null;
      A.replaceChildren(...buildAction(g, inGame));
      if (focused && $('#' + focused)) { const el = $('#' + focused); el.value = draft; el.focus(); }
    }

    function inputRow(id, placeholder, ev, max) {
      const send = () => {
        const v = $('#' + id).value.trim();
        if (!v) return toast('내용을 입력하세요');
        socket.emit(ev, v);
      };
      return h('div', { class: 'row' },
        h('input', { id, placeholder, maxlength: max, autocomplete: 'off', enterkeyhint: 'send', onkeydown: (e) => e.key === 'Enter' && !e.isComposing && send() }),
        h('button', { class: 'btn primary', onclick: send }, '제출'));
    }

    function buildAction(g, inGame) {
      const P = S.phase;
      if (P === 'lobby') {
        const online = S.players.filter((p) => p.online).length;
        const enough = online >= S.minPlayers;
        if (!isHost()) {
          return [h('h3', {}, '⏳ 방장이 시작하기를 기다리는 중'),
            h('p', { class: 'hint-text' }, `카테고리: ${S.settings.category} · ${S.settings.mode === 'fool' ? '바보 모드' : '일반 모드'} · 타이머 ${timerSummary()}`),
            h('p', { class: 'hint-text' }, enough ? '인원 충분! 곧 시작해요.' : `${S.minPlayers - online}명 더 모이면 시작할 수 있어요. 위 🔗 버튼으로 링크를 공유하세요.`)];
        }
        const set = (patch) => socket.emit('settings', { ...S.settings, ...patch });
        const timerSel = (k, label) => h('label', { class: 'opt' }, label,
          h('select', { onchange: (e) => set({ timers: { ...S.settings.timers, [k]: Number(e.target.value) } }) },
            S.timerChoices.map((v) => h('option', { value: v, selected: S.settings.timers[k] === v }, v ? `${v}초` : '없음'))));
        return [
          h('h3', {}, '🎮 게임 설정'),
          h('div', { class: 'seg' },
            h('button', { class: S.settings.mode === 'fool' ? 'on' : '', onclick: () => set({ mode: 'fool' }) }, '🤪 바보 모드'),
            h('button', { class: S.settings.mode === 'normal' ? 'on' : '', onclick: () => set({ mode: 'normal' }) }, '🎭 일반 모드')),
          h('label', { class: 'opt' }, '카테고리',
            h('select', { onchange: (e) => set({ category: e.target.value }) },
              ['랜덤', ...S.categories].map((c) => h('option', { value: c, selected: S.settings.category === c }, c === '랜덤' ? '🎲 랜덤' : c)))),
          h('div', { class: 'grid3' }, timerSel('hint', '힌트 시간'), timerSel('vote', '투표 시간'), timerSel('defense', '해명·정답 시간')),
          h('button', { class: 'btn primary big', disabled: !enough, onclick: () => socket.emit('start') },
            enough ? `게임 시작 (${online}명)` : `${S.minPlayers - online}명 더 필요해요 (${online}/${S.minPlayers})`),
        ];
      }
      if (!g) return [];
      if (!inGame && P !== 'end') return [h('h3', {}, '👀 관전 중', timerEl()), h('p', { class: 'hint-text' }, '다음 판부터 참여할 수 있어요.')];

      if (P === 'hint') {
        if (g.turnId === S.me) return [h('h3', {}, `🗣️ 내 차례! 힌트를 입력하세요${g.round > 1 ? ` (${g.round}라운드)` : ''}`, timerEl()),
          h('p', { class: 'hint-text' }, '제시어를 직접 말하지 말고, 아는 사람만 알 만한 힌트로!'),
          inputRow('hintInput', '예) 매콤해요', 'hint', 60)];
        return [h('h3', {}, `🗣️ ${nm(g.turnId)} 님이 힌트를 쓰는 중…`, timerEl()), hostSkip('이 차례 넘기기')];
      }
      if (P === 'vote') {
        const voted = g.voted.length, n = g.order.length;
        return [h('h3', {}, g.revote ? '⚖️ 재투표 (동률 후보만)' : '🗳️ 라이어는 누구?', timerEl()),
          h('div', { class: 'vote-list' }, g.candidates.map((id) => h('button', {
            class: `btn ${myVote === id ? 'sel' : ''}`, disabled: id === S.me,
            onclick: () => { myVote = id; socket.emit('vote', id); renderAction(); },
          }, `${g.order.indexOf(id) + 1}. ${nm(id)}${id === S.me ? ' (나)' : ''}`))),
          h('p', { class: 'progress' }, `${voted}/${n}명 투표 완료${g.voted.includes(S.me) ? ' · 다시 눌러서 바꿀 수 있어요' : ''}`), hostSkip('투표 마감')];
      }
      if (P === 'defense') {
        if (g.nominee === S.me) return [h('h3', {}, '🎤 지목당했어요! 해명하세요', timerEl()), inputRow('defInput', '예) 제 힌트는 모양을 말한 거예요', 'defense', 120)];
        return [h('h3', {}, `🎤 ${nm(g.nominee)} 님이 해명을 쓰는 중…`, timerEl()), hostSkip('해명 건너뛰기')];
      }
      if (P === 'final') {
        const eligible = g.order.length - 1;
        if (g.nominee === S.me) return [h('h3', {}, '⚖️ 다른 사람들이 최종 투표 중…', timerEl()), h('p', { class: 'progress' }, `${g.finalVoted.length}/${eligible}명 투표`)];
        return [h('h3', {}, `⚖️ ${nm(g.nominee)} 님을 라이어로 지목할까요?`, timerEl()),
          h('div', { class: 'grid2' },
            h('button', { class: `btn ${myFinal === true ? 'ok' : ''}`, onclick: () => { myFinal = true; socket.emit('final', true); renderAction(); } }, '👍 찬성'),
            h('button', { class: `btn ${myFinal === false ? 'danger' : ''}`, onclick: () => { myFinal = false; socket.emit('final', false); renderAction(); } }, '👎 반대')),
          h('p', { class: 'progress' }, `${g.finalVoted.length}/${eligible}명 투표 완료`), hostSkip('투표 마감')];
      }
      if (P === 'guess') {
        if (S.mine && (S.mine.liar || S.mine.revealedLiar)) return [h('h3', {}, '🎯 마지막 기회! 시민들의 제시어는?', timerEl()), inputRow('guessInput', '정답 단어만 입력', 'guess', 40)];
        return [h('h3', {}, `🎯 라이어 ${nm(g.nominee)} 님이 정답을 고민 중…`, timerEl()), hostSkip('건너뛰기 (오답 처리)')];
      }
      if (P === 'end') {
        const r = g.result;
        const iWon = inGame && ((r.winner === 'liar') === (S.me === r.liarId));
        return [h('h3', {}, r.winner === 'liar' ? '🎭 라이어 승리!' : '🎉 시민 승리!', inGame ? h('span', { class: 'timer' }, iWon ? '내가 이김 🏆' : '졌어요 😢') : null),
          h('p', { class: 'hint-text' }, `제시어: ${r.word}${r.liarWord ? ` · 라이어 단어: ${r.liarWord}` : ''} · 라이어: ${nm(r.liarId)}`),
          isHost() ? h('button', { class: 'btn primary big', onclick: () => socket.emit('reset') }, '🔁 한 판 더') : h('p', { class: 'hint-text' }, '방장이 새 판을 열면 바로 이어서 할 수 있어요.')];
      }
      return [];
    }

    function hostSkip(label) {
      return isHost() ? h('button', { class: 'btn', onclick: () => confirm(`${label}?`) && socket.emit('force') }, `⏭️ ${label} (방장)`) : null;
    }
    function timerSummary() {
      const t = S.settings.timers;
      if (!t.hint && !t.vote && !t.defense) return '없음';
      const f = (v) => (v ? `${v}초` : '없음');
      return `힌트 ${f(t.hint)}/투표 ${f(t.vote)}/해명 ${f(t.defense)}`;
    }
  }
})();
