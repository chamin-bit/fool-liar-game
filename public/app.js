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
      const c = $('#joinCode').value.trim().replace(/^.*\/room\//, '').toLowerCase();
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
    const socket = io({ reconnectionDelay: 500 });
    let S = null;
    let skew = 0;
    let actionKey = '';
    let lastSender = null;
    let myVote = null;
    let myFinal = null;
    let showSummary = false;
    let settingsOpen = true;
    const feed = $('#feed');
    const roomEl = $('#room');

    // 폰 키보드가 올라와도 화면이 밀리지 않도록 실제 보이는 높이에 맞춘다
    const vv = window.visualViewport;
    const fitViewport = () => {
      if (!vv) return;
      document.documentElement.style.setProperty('--app-h', `${vv.height}px`);
      window.scrollTo(0, 0);
      if (stick) feed.scrollTop = feed.scrollHeight;
    };
    if (vv) { vv.addEventListener('resize', fitViewport); vv.addEventListener('scroll', fitViewport); }

    // 스크롤: 맨 아래를 보고 있으면 계속 맨 아래에 붙어 있게
    let stick = true;
    const nearBottom = () => feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
    feed.addEventListener('scroll', () => (stick = nearBottom()), { passive: true });
    new ResizeObserver(() => { if (stick) feed.scrollTop = feed.scrollHeight; }).observe(feed);
    const toBottom = () => { feed.scrollTop = feed.scrollHeight; stick = true; };

    const join = () => socket.emit('join', { code, name: store.name, playerId: store.pid(code) }, (r) => {
      if (r.error) { toast(r.error); setTimeout(() => (location.href = '/'), 1500); return; }
      store.setPid(code, r.playerId);
      feed.innerHTML = '';
      lastSender = null;
      r.log.forEach(addMsg);
      toBottom();
    });
    socket.on('connect', join);
    socket.on('kicked', () => { toast('방에서 내보내졌어요'); setTimeout(() => (location.href = '/'), 1200); });
    socket.on('toast', toast);
    socket.on('msg', (m) => { const was = stick; addMsg(m); if (was || m.from === (S && S.me)) toBottom(); });
    socket.on('state', (s) => {
      const prev = S;
      S = s;
      skew = s.serverNow - Date.now();
      const g = s.game, pg = prev && prev.game;
      if (!g || !pg || s.phase !== prev.phase || g.round !== pg.round || g.candidates.join() !== pg.candidates.join()) {
        myVote = null; myFinal = null;
        if (!prev || s.phase !== prev.phase) showSummary = false;
      }
      render();
    });

    // ---------- 채팅 메시지 ----------
    const fmtTime = (t) => new Date(t).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
    function addMsg(m) {
      const mine = m.from && m.from === (S ? S.me : store.pid(code));
      // 짧은 봇 알림은 가운데 작은 한 줄로 (공간 절약)
      if (m.type === 'bot' && !m.text.includes('\n') && m.text.length <= 42) {
        lastSender = null;
        feed.append(h('div', { class: 'msg sys' }, h('div', { class: 'bubble' }, m.text)));
        return;
      }
      const sender = m.type === 'bot' ? 'bot' : m.from;
      const cont = sender === lastSender;
      lastSender = sender;
      const bubble = h('div', { class: 'bubble' }, m.text);
      const time = h('span', { class: 'time' }, fmtTime(m.t));
      if (mine) return feed.append(h('div', { class: 'msg mine' }, h('div', { class: 'line' }, time, bubble)));
      feed.append(h('div', { class: `msg ${m.type === 'bot' ? 'bot' : ''} ${cont ? 'cont' : ''}` },
        h('div', { class: 'avatar' }, m.type === 'bot' ? '🎭' : '🙂'),
        h('div', { class: 'body' }, h('div', { class: 'name' }, m.type === 'bot' ? '라이어게임' : m.name), h('div', { class: 'line' }, bubble, time))));
    }

    const sendChat = (text) => socket.emit('chat', text);
    $('#chatForm').onsubmit = (e) => {
      e.preventDefault();
      const v = $('#chatInput').value.trim();
      if (!v) return;
      sendChat(v);
      $('#chatInput').value = '';
    };
    // 채팅 입력 중에는 참가자 줄·패널을 접어 대화가 더 보이게
    $('#chatInput').addEventListener('focus', () => { roomEl.classList.add('typing'); setTimeout(toBottom, 300); });
    $('#chatInput').addEventListener('blur', () => setTimeout(() => {
      if (document.activeElement !== $('#chatInput')) roomEl.classList.remove('typing');
    }, 150));

    // 메뉴
    $('#menuBtn').onclick = (e) => { e.stopPropagation(); $('#menu').classList.toggle('hidden'); };
    document.addEventListener('click', () => $('#menu').classList.add('hidden'));
    $('#menu').onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.cmd) {
        if (b.dataset.cmd === '/초기화' && !confirm('진행 중인 게임을 초기화할까요?')) return;
        sendChat(b.dataset.cmd);
      }
      if (b.dataset.act === 'leave' && confirm('방을 나갈까요?')) { socket.emit('leave'); location.href = '/'; }
    };
    $('#copyBtn').onclick = async () => {
      const url = location.origin + '/room/' + code;
      if (navigator.share && /Mobi|Android|iPhone/i.test(navigator.userAgent)) {
        try { await navigator.share({ title: '바보 라이어 같이 해요!', url }); return; } catch {}
      }
      try { await navigator.clipboard.writeText(url); toast('초대 링크를 복사했어요'); } catch { prompt('이 링크를 복사하세요', url); }
    };

    // 타이머
    setInterval(() => {
      const el = $('#timer');
      if (!el || !S || !S.deadline) return;
      const left = Math.max(0, Math.ceil((S.deadline - (Date.now() + skew)) / 1000));
      el.textContent = `⏱ ${left}`;
      el.classList.toggle('low', left <= 5);
    }, 250);

    const nm = (id) => (S.players.find((p) => p.id === id) || { name: '???' }).name;
    const isHost = () => S.hostId === S.me;
    const timerEl = () => (S.deadline ? h('span', { id: 'timer', class: 'timer' }, '') : null);
    const rateOf = (name) => { const s = S.stats[name]; return s && s.games ? Math.round((s.wins / s.games) * 100) : null; };

    function render() {
      const g = S.game;

      // 상단 한 줄: 내 제시어
      const wp = $('#wordPill');
      wp.className = 'word-pill';
      if (g && S.mine) {
        const liar = S.mine.liar || S.mine.revealedLiar;
        if (liar) wp.classList.add('liar');
        wp.replaceChildren(
          h('span', { class: 'lbl' }, S.mine.liar ? '나는' : S.mine.revealedLiar ? '라이어였음' : '제시어'),
          h('span', { class: 'w' }, S.mine.liar ? '🤥 라이어' : S.mine.word),
          h('span', { class: 'meta' }, g.category, h('br'), `${g.mode === 'fool' ? '🤪바보' : '일반'} · ${g.round}R`));
      } else if (g) {
        wp.replaceChildren(h('span', { class: 'lbl' }, '관전 중'), h('span', { class: 'w' }, '👀'), h('span', { class: 'meta' }, g.category, h('br'), `${g.round}R`));
      } else {
        wp.replaceChildren(h('span', { class: 'brand' }, '🤪 바보 라이어'), h('span', { class: 'meta' }, code));
      }

      // 참가자 (+승률)
      const order = g ? g.order : [];
      const list = g ? [...order.map((id) => S.players.find((p) => p.id === id)).filter(Boolean), ...S.players.filter((p) => !order.includes(p.id))] : S.players;
      $('#players').replaceChildren(...list.map((p, i) => {
        const r = rateOf(p.name);
        return h('span', { class: `pchip ${p.online ? '' : 'off'} ${g && g.turnId === p.id ? 'turn' : ''} ${p.id === S.me ? 'me' : ''}` },
          g && order.includes(p.id) ? `${i + 1}.` : null,
          p.id === S.hostId ? '👑' : null,
          p.name,
          r != null ? h('span', { class: 'rate' }, ` ${r}%`) : null,
          g && !order.includes(p.id) ? ' (관전)' : null,
          !g && isHost() && p.id !== S.me ? h('button', { class: 'x', title: '내보내기', onclick: () => confirm(`${p.name} 님을 내보낼까요?`) && socket.emit('kick', p.id) }, '✕') : null);
      }));

      renderAction();
    }

    function renderAction() {
      const g = S.game;
      const inGame = g && g.order.includes(S.me);
      const key = JSON.stringify([S.phase, isHost(), S.settings, S.players.filter((p) => p.online).length, S.deadline, showSummary, settingsOpen,
        g && [g.turnId, g.round, g.candidates, g.nominee, g.voted.length, g.finalVoted.length, g.voted.includes(S.me), JSON.stringify(g.hints)],
        myVote, myFinal, inGame, S.gameNo]);
      if (key === actionKey) return;
      actionKey = key;
      const A = $('#action');
      const focused = document.activeElement && A.contains(document.activeElement) ? document.activeElement.id : null;
      const draft = focused ? document.activeElement.value : null;
      const wasStick = stick;
      A.replaceChildren(...buildAction(g, inGame).filter(Boolean));
      if (focused && $('#' + focused)) { const el = $('#' + focused); el.value = draft; el.focus(); }
      if (wasStick) toBottom();
    }

    function head(title, ...extra) { return h('div', { class: 'head' }, h('h3', {}, title), ...extra); }
    function summaryToggle(g) {
      if (!g || !g.order.some((id) => g.hints[id].length)) return null;
      return h('button', { class: 'mini', onclick: () => { showSummary = !showSummary; renderAction(); } }, showSummary ? '📝 접기' : '📝 힌트');
    }
    function summaryBox(g) {
      if (!showSummary || !g) return null;
      const lines = g.order.map((id, i) => {
        const hs = g.hints[id].filter(Boolean);
        return `${i + 1}. ${nm(id)}: ${hs.length ? hs.map((x, r) => (hs.length > 1 ? `[${r + 1}R] ` : '') + x).join(' → ') : '-'}`;
      });
      return h('pre', { class: 'summary' }, lines.join('\n'));
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
      if (P === 'lobby') return buildLobby();
      if (!g) return [];
      const sum = summaryToggle(g);
      if (!inGame && P !== 'end') return [head('👀 관전 중 · 다음 판부터 참여', timerEl(), sum), summaryBox(g)];

      if (P === 'hint') {
        if (g.turnId === S.me) return [head(`🗣️ 내 차례! 힌트 입력${g.round > 1 ? ` (${g.round}R)` : ''}`, timerEl(), sum), summaryBox(g),
          inputRow('hintInput', '제시어는 직접 말하지 말고!', 'hint', 60)];
        return [head(`🗣️ ${nm(g.turnId)} 님이 힌트 쓰는 중…`, timerEl(), sum), summaryBox(g)];
      }
      if (P === 'vote') {
        const voted = g.voted.length, n = g.order.length;
        return [head(g.revote ? '⚖️ 재투표 (동률 후보만)' : '🗳️ 라이어는 누구?', timerEl(), sum), summaryBox(g),
          h('div', { class: 'vote-list' }, g.candidates.filter((id) => id !== S.me).map((id) => h('button', {
            class: `btn ${myVote === id ? 'sel' : ''}`,
            onclick: () => { myVote = id; socket.emit('vote', id); renderAction(); },
          }, `${g.order.indexOf(id) + 1}. ${nm(id)}`))),
          h('p', { class: 'progress' }, `${voted}/${n}명 투표${g.voted.includes(S.me) ? ' · 다시 눌러 바꿀 수 있어요' : ''}`)];
      }
      if (P === 'defense') {
        if (g.nominee === S.me) return [head('🎤 지목당했어요! 해명하세요', timerEl(), sum), summaryBox(g), inputRow('defInput', '예) 제 힌트는 모양을 말한 거예요', 'defense', 120)];
        return [head(`🎤 ${nm(g.nominee)} 님 해명 쓰는 중…`, timerEl(), sum), summaryBox(g)];
      }
      if (P === 'final') {
        const eligible = g.order.length - 1;
        if (g.nominee === S.me) return [head(`⚖️ 찬반 투표 중… (${g.finalVoted.length}/${eligible})`, timerEl(), sum), summaryBox(g)];
        return [head(`⚖️ ${nm(g.nominee)} 님이 라이어?`, timerEl(), sum), summaryBox(g),
          h('div', { class: 'grid2' },
            h('button', { class: `btn ${myFinal === true ? 'ok' : ''}`, onclick: () => { myFinal = true; socket.emit('final', true); renderAction(); } }, '👍 찬성'),
            h('button', { class: `btn ${myFinal === false ? 'danger' : ''}`, onclick: () => { myFinal = false; socket.emit('final', false); renderAction(); } }, '👎 반대')),
          h('p', { class: 'progress' }, `${g.finalVoted.length}/${eligible}명 투표`)];
      }
      if (P === 'guess') {
        if (S.mine && (S.mine.liar || S.mine.revealedLiar)) return [head('🎯 마지막 기회! 시민들의 제시어는?', timerEl(), sum), summaryBox(g), inputRow('guessInput', '정답 단어만 입력', 'guess', 40)];
        return [head(`🎯 ${nm(g.nominee)} 님이 정답 고민 중…`, timerEl(), sum), summaryBox(g)];
      }
      if (P === 'end') {
        const r = g.result;
        const iWon = inGame && ((r.winner === 'liar') === (S.me === r.liarId));
        return [head(`${r.winner === 'liar' ? '🎭 라이어 승리!' : '🎉 시민 승리!'}${inGame ? (iWon ? ' · 내가 이김 🏆' : ' · 졌어요 😢') : ''}`, sum), summaryBox(g),
          h('div', { class: 'grid2' },
            h('button', { class: 'btn primary', onclick: () => sendChat('/시작') }, '🔁 바로 한 판 더'),
            h('button', { class: 'btn', onclick: () => sendChat('/초기화') }, '⚙️ 설정 바꾸기')),
          h('button', { class: 'btn sm', onclick: () => sendChat('/랭킹') }, '📊 랭킹 보기')];
      }
      return [];
    }

    function buildLobby() {
      const online = S.players.filter((p) => p.online).length;
      const enough = online >= S.minPlayers;
      const sel = S.settings.categories;
      const catLabel = sel.length ? (sel.length <= 3 ? sel.join('·') : `${sel.length}개 카테고리`) : '전체 랜덤';
      const t = S.settings.timers;
      const timerLabel = (!t.hint && !t.vote && !t.defense) ? '타이머 없음' : `⏱ ${t.hint || '-'}/${t.vote || '-'}/${t.defense || '-'}초`;
      const summary = `${S.settings.mode === 'fool' ? '🤪 바보' : '🎭 일반'} · ${catLabel} · ${timerLabel}`;
      const startBtn = h('button', { class: 'btn primary big', disabled: !enough, onclick: () => sendChat('/시작') },
        enough ? `게임 시작 (${online}명)` : `${S.minPlayers - online}명 더 필요해요 (${online}/${S.minPlayers})`);

      if (!isHost()) {
        return [head('⏳ 대기 중'), h('p', { class: 'hint-text' }, summary),
          enough ? startBtn : h('p', { class: 'hint-text' }, `${S.minPlayers - online}명 더 모이면 시작할 수 있어요. 🔗 버튼으로 링크 공유!`)];
      }
      const set = (patch) => socket.emit('settings', { ...S.settings, ...patch });
      const toggleCat = (c) => set({ categories: sel.includes(c) ? sel.filter((x) => x !== c) : [...sel, c] });
      const timerSel = (k, label) => h('label', { class: 'opt' }, label,
        h('select', { onchange: (e) => set({ timers: { ...t, [k]: Number(e.target.value) } }) },
          S.timerChoices.map((v) => h('option', { value: v, selected: t[k] === v }, v ? `${v}초` : '없음'))));
      const toggle = h('button', { class: 'mini', onclick: () => { settingsOpen = !settingsOpen; renderAction(); } }, settingsOpen ? '접기 ▴' : '설정 ▾');
      if (!settingsOpen) return [head('🎮 게임 설정', toggle), h('p', { class: 'hint-text' }, summary), startBtn];
      return [
        head('🎮 게임 설정', toggle),
        h('div', { class: 'seg' },
          h('button', { class: S.settings.mode === 'fool' ? 'on' : '', onclick: () => set({ mode: 'fool' }) }, '🤪 바보 모드'),
          h('button', { class: S.settings.mode === 'normal' ? 'on' : '', onclick: () => set({ mode: 'normal' }) }, '🎭 일반 모드')),
        h('p', { class: 'hint-text' }, `카테고리 · 여러 개 고르면 그중에서 랜덤 (${sel.length ? `${sel.length}개 선택` : '안 고르면 전체'})`),
        h('div', { class: 'cats' },
          h('button', { class: `cat all ${sel.length ? '' : 'on'}`, onclick: () => set({ categories: [] }) }, '🎲 전체'),
          S.categories.map((c) => h('button', { class: `cat ${sel.includes(c) ? 'on' : ''}`, onclick: () => toggleCat(c) }, c))),
        h('div', { class: 'grid3' }, timerSel('hint', '힌트'), timerSel('vote', '투표'), timerSel('defense', '해명·정답')),
        startBtn,
      ];
    }
  }
})();
