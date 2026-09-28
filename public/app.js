const $ = (id) => document.getElementById(id);

const SUGGESTED = ['coding', 'music', 'gaming', 'cricket', 'movies', 'anime', 'gym', 'startups', 'books', 'memes', 'placements', 'travel'];
const EMOJI = { coding: '💻', music: '🎵', gaming: '🎮', cricket: '🏏', movies: '🎬', anime: '🍥', gym: '💪', startups: '🚀', books: '📚', memes: '😂', placements: '💼', travel: '✈️' };
const OPENERS = ["Say hi! 👋", "Break the ice 🧊", "Ask them their major 🎓", "Rate the mess food 1–10 🍛"];

let socket = null;
let myEmail = '';
let mode = null;          // nothing picked until the user chooses
let interests = [];
let localStream = null;
let peer = null;
let iceServers = null;
let isMatched = false;
let videoTimer = null;
let researchTimer = null;
let typingTimer = null;
let sentTyping = false;

// ---------- Helpers ----------

function show(screen, opts = {}) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    $(`screen-${screen}`).classList.add('active');
    document.body.dataset.screen = screen;
    window.scrollTo(0, 0);
    if (screen === 'login') playHeroVideo();
    if (screen === 'lobby') window.Lobby?.start(opts.atDoor);
    else window.Lobby?.stop();
    if (screen === 'chat') window.ChatBg?.start();
    else window.ChatBg?.stop();
}

// Autoplay can get paused (hidden tab, phone battery saver); nudge it again
function playHeroVideo() {
    document.querySelector('.hl-bg')?.play().catch(() => { });
}
document.addEventListener('pointerdown', playHeroVideo, { once: true });
document.addEventListener('visibilitychange', () => {
    if (!document.hidden && document.body.dataset.screen === 'login') playHeroVideo();
});

function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), 2800);
}

async function api(path, body) {
    const res = await fetch(path, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
}

function setStatus(text, searching = false) {
    $('status').textContent = text;
    $('status').classList.toggle('searching', searching);
}

function addMsg(text, who) {
    const div = document.createElement('div');
    div.className = `msg ${who}`;
    div.textContent = text;
    $('messages').appendChild(div);
    $('messages').scrollTop = $('messages').scrollHeight;
}

function addSys(text, fun = false) {
    const div = document.createElement('div');
    div.className = fun ? 'sys fun' : 'sys';
    div.textContent = text;
    $('messages').appendChild(div);
    $('messages').scrollTop = $('messages').scrollHeight;
}

function setChatEnabled(on) {
    $('msgInput').disabled = !on;
    $('sendBtn').disabled = !on;
    $('reportBtn').disabled = !on;
    if (on && window.matchMedia('(min-width: 801px)').matches) $('msgInput').focus();
}

// ---------- Startup ----------
(async function init() {
    const { ok, status, data } = await api('/api/me');
    if (ok) return enterLobby(data.email);
    if (status === 403) return showBanned(data.until);
    show('login');
})();

// ---------- Login ----------
let pendingEmail = '';

$('emailForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('loginError').textContent = '';
    const btn = e.submitter;
    btn.disabled = true;
    const email = $('emailInput').value.trim();
    const { ok, data } = await api('/api/request-code', { email });
    btn.disabled = false;
    if (!ok) {
        return ($('loginError').textContent = data.error || 'Something went wrong');
    }
    pendingEmail = email;
    $('sentTo').textContent = email;
    $('emailForm').hidden = true;
    $('codeForm').hidden = false;
    $('codeInput').focus();
});

$('codeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('loginError').textContent = '';
    if (!$('agreeInput').checked) {
        return ($('loginError').textContent = 'Tick the 18+ box first ☝️');
    }
    const btn = e.submitter;
    btn.disabled = true;
    const { ok, data } = await api('/api/verify-code', { email: pendingEmail, code: $('codeInput').value, agree: true });
    btn.disabled = false;
    if (!ok) {
        return ($('loginError').textContent = data.error || 'Something went wrong');
    }
    window.Entry.play(() => enterLobby(data.email));
});

$('changeEmailBtn').addEventListener('click', () => {
    $('codeForm').hidden = true;
    $('emailForm').hidden = false;
    $('loginError').textContent = '';
});

$('logoutBtn').addEventListener('click', async () => {
    await api('/api/logout', {});
    location.reload();
});

// ---------- Lobby ----------
function enterLobby(email) {
    myEmail = email;
    $('helloName').textContent = email.split('@')[0];
    $('myEmail').textContent = email;
    renderMode();
    renderChips();
    connectSocket();
    show('lobby');
}

function renderMode() {
    document.querySelectorAll('.mode').forEach(b => {
        const active = b.dataset.mode === mode;
        b.classList.toggle('active', active);
        b.setAttribute('aria-checked', active);
    });
    $('goBtn').classList.toggle('locked', !mode);
}

document.querySelectorAll('.mode').forEach(b => b.addEventListener('click', () => {
    mode = b.dataset.mode;
    renderMode();
}));


function renderChips() {
    $('myChips').replaceChildren(...interests.map(i => {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = i;
        chip.title = 'Remove';
        chip.onclick = () => { interests = interests.filter(x => x !== i); renderChips(); };
        return chip;
    }));
    $('suggested').replaceChildren(...SUGGESTED.filter(s => !interests.includes(s)).map(s => {
        const b = document.createElement('button');
        b.textContent = s;
        b.onclick = () => addInterest(s);
        return b;
    }));
}

function addInterest(raw) {
    const tag = raw.toLowerCase().replace(/[^a-z0-9 +#.-]/g, '').trim().slice(0, 20);
    if (!tag || interests.includes(tag)) return;
    if (interests.length >= 5) return toast('Max 5 interests 🙅');
    interests.push(tag);
    renderChips();
}

$('interestInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        addInterest(e.target.value);
        e.target.value = '';
    } else if (e.key === 'Backspace' && !e.target.value && interests.length) {
        interests.pop();
        renderChips();
    }
});

$('goBtn').addEventListener('click', async () => {
    if (!mode) {
        const modes = document.querySelector('.enf-modes');
        modes.classList.remove('nudge');
        void modes.offsetWidth;
        modes.classList.add('nudge');
        return toast('Pick Video or Text first ☝️');
    }
    if (mode === 'video') {
        const ok = await startCamera();
        if (!ok) {
            mode = 'text';
            renderMode();
            toast("Couldn't get your camera 📷 so we switched to text mode");
        }
        if (!iceServers) {
            const { ok: iceOk, data } = await api('/api/ice');
            iceServers = iceOk ? data.iceServers : [{ urls: 'stun:stun.l.google.com:19302' }];
        }
    }
    document.body.classList.toggle('text-mode', mode === 'text');
    $('messages').replaceChildren();
    show('chat');
    startSearch();
});

async function startCamera() {
    if (localStream) return true;
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        $('localVideo').srcObject = localStream;
        $('micBtn').classList.remove('off');
        $('camBtn').classList.remove('off');
        $('micBtn').textContent = 'MIC ON';
        $('camBtn').textContent = 'CAM ON';
        return true;
    } catch (err) {
        console.warn(err);
        return false;
    }
}

function stopCamera() {
    localStream?.getTracks().forEach(t => t.stop());
    localStream = null;
    $('localVideo').srcObject = null;
}

// ---------- Socket ----------
function connectSocket() {
    if (socket) return;
    socket = io();

    socket.on('connect_error', (err) => {
        if (err.message === 'unauthorized') { socket.disconnect(); socket = null; show('login'); }
        if (err.message === 'banned') showBanned();
    });

    socket.on('online', (n) => document.querySelectorAll('.online-count').forEach(el => (el.textContent = n)));

    socket.on('matched', ({ initiator, shared }) => {
        clearTimeout(researchTimer);
        isMatched = true;
        $('messages').replaceChildren();
        addSys('You matched with a random SRM student! Be kind, and never share your number, address or passwords.');
        if (shared.length) addSys(`You both like: ${shared.map(s => `${EMOJI[s] || '✨'} ${s}`).join(', ')}`, true);
        addSys(OPENERS[Math.floor(Math.random() * OPENERS.length)], true);
        setChatEnabled(true);

        if (mode === 'text') {
            setStatus('Chatting with a stranger 💬');
        } else {
            setStatus('Connecting video… 📡', true);
            startPeer(initiator);
        }
    });

    socket.on('signal', (signal) => peer?.signal(signal));

    socket.on('chat_message', (text) => {
        $('typing').hidden = true;
        addMsg(text, 'stranger');
    });

    socket.on('typing', (on) => ($('typing').hidden = !on));
    socket.on('system', (text) => addSys(text));

    socket.on('partner_left', () => {
        if (!isMatched) return;
        isMatched = false;
        addSys('Stranger bounced 💨 Finding someone new…', true);
        endPeer();
        setChatEnabled(false);
        researchTimer = setTimeout(startSearch, 1500);
    });

    socket.on('banned', ({ until } = {}) => showBanned(until));

    socket.on('disconnect', (reason) => {
        if (reason === 'io server disconnect') return;
        if (isMatched) {
            isMatched = false;
            endPeer();
            setChatEnabled(false);
            addSys('Connection lost. Reconnecting…');
        }
    });
    socket.io.on('reconnect', () => {
        if ($('screen-chat').classList.contains('active')) startSearch();
    });
}

// ---------- Matching ----------
function startSearch() {
    clearTimeout(researchTimer);
    isMatched = false;
    endPeer();
    setChatEnabled(false);
    $('typing').hidden = true;
    setStatus('Rolling the dice… 🎲', true);
    if (!$('messages').children.length) addSys('Looking for someone…');
    socket.emit('join', { mode, interests });
}

function nextPerson() {
    if (isMatched) addSys('You skipped ⏭️');
    startSearch();
}

function goHome() {
    clearTimeout(researchTimer);
    socket.emit('leave');
    isMatched = false;
    endPeer();
    stopCamera();
    show('lobby', { atDoor: true });
}

// ---------- Video (WebRTC) ----------
function startPeer(initiator) {
    peer = new SimplePeer({ initiator, stream: localStream, trickle: false, config: { iceServers } });
    const thisPeer = peer;

    peer.on('signal', (data) => socket.emit('signal', data));

    peer.on('stream', (stream) => {
        clearTimeout(videoTimer);
        $('remoteVideo').srcObject = stream;
        $('remotePlaceholder').hidden = true;
        setStatus('Connected! 🎉');
    });

    peer.on('error', (err) => {
        console.warn(err);
        if (peer === thisPeer && isMatched) addSys('Video connection dropped 😕 You can keep texting or hit Next.');
    });

    videoTimer = setTimeout(() => {
        if (peer === thisPeer && isMatched) {
            setStatus('Text chat only 💬');
            addSys("Video couldn't connect (the network might be blocking it). You can still text, or hit Next.");
        }
    }, 20000);
}

function endPeer() {
    clearTimeout(videoTimer);
    if (peer) { peer.destroy(); peer = null; }
    $('remoteVideo').srcObject = null;
    $('remotePlaceholder').hidden = false;
}

// ---------- Chat input ----------
$('msgForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('msgInput').value.trim();
    if (!text || !isMatched) return;
    socket.emit('chat_message', text);
    addMsg(text, 'me');
    $('msgInput').value = '';
    stopTyping();
});

$('msgInput').addEventListener('input', () => {
    if (!isMatched) return;
    if (!sentTyping) { socket.emit('typing', true); sentTyping = true; }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(stopTyping, 1500);
});

function stopTyping() {
    clearTimeout(typingTimer);
    if (sentTyping) { socket.emit('typing', false); sentTyping = false; }
}

// ---------- Controls ----------
$('nextBtn').addEventListener('click', nextPerson);
$('homeBtn').addEventListener('click', goHome);

$('micBtn').addEventListener('click', () => {
    const track = localStream?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    $('micBtn').classList.toggle('off', !track.enabled);
    $('micBtn').textContent = track.enabled ? 'MIC ON' : 'MIC OFF';
});

$('camBtn').addEventListener('click', () => {
    const track = localStream?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    $('camBtn').classList.toggle('off', !track.enabled);
    $('camBtn').textContent = track.enabled ? 'CAM ON' : 'CAM OFF';
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('screen-chat').classList.contains('active') && !$('reportDialog').open) nextPerson();
});

// ---------- Report ----------
$('reportBtn').addEventListener('click', () => $('reportDialog').showModal());
$('cancelReport').addEventListener('click', () => $('reportDialog').close());

document.querySelectorAll('.report-reasons button').forEach(b => b.addEventListener('click', () => {
    $('reportDialog').close();
    if (!isMatched) return;
    socket.emit('report', { reason: b.dataset.reason });
    isMatched = false;
    toast('Reported. Thanks for keeping it chill 🙏');
    $('messages').replaceChildren();
    startSearch();
}));

// ---------- Banned ----------
function showBanned(until) {
    endPeer();
    stopCamera();
    if (until) $('bannedText').textContent = `Too many people reported you. You can come back after ${new Date(until).toLocaleString()}.`;
    show('banned');
}
