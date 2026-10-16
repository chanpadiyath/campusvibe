const $ = (id) => document.getElementById(id);

const SUGGESTED = ['coding', 'music', 'gaming', 'cricket', 'movies', 'anime', 'gym', 'startups', 'books', 'memes', 'placements', 'travel'];
const EMOJI = { coding: '💻', music: '🎵', gaming: '🎮', cricket: '🏏', movies: '🎬', anime: '🍥', gym: '💪', startups: '🚀', books: '📚', memes: '😂', placements: '💼', travel: '✈️' };
// Icebreakers: tapping "Break the ice" sends ONE of these (once per chat; no repeats until all are used)
const ICEBREAKERS = [
    "Would you rather have unlimited Swiggy credits or never have an 8 AM class again? 🍔⏰",
    "Would you rather your crush see your search history or your camera roll? 👀",
    "Would you rather be famous on campus for a viral reel or a legendary fest performance? 🎤",
    "Would you rather give a surprise viva unprepared or sing on stage at the fest? 😬",
    "Would you rather always have 100% attendance or always have 100% phone battery? 🔋",
    "Would you rather fight one horse-sized pigeon or 50 pigeon-sized horses? 🐴",
    "Would you rather eat mess food forever or only Maggi forever? 🍜",
    "Would you rather know every exam question in advance or every crush's answer in advance? 💘",
    "Hot take time: what's the most overrated thing about college life? 🔥",
    "What's a hill you will absolutely die on? (Food opinions count.) ⛰️",
    "Unpopular opinion you'd defend in front of the whole class? 🎙️",
    "Rank these: biryani, momos, shawarma, dosa. No ties allowed. 🏆",
    "Is a hot dog a sandwich? Defend your answer like it's your end-sem. 🌭",
    "What's the funniest thing you've seen happen in a lecture? 😂",
    "Worst excuse you've ever given for missing class (that actually worked)? 🙈",
    "If campus had a secret level, where would the entrance be? 🕹️",
    "What's your 2 AM hostel/room snack of choice? 🌙",
    "Which professor would survive a zombie apocalypse the longest? 🧟",
    "If you ran the canteen for a day, what's the first thing you'd change? 🍽️",
    "Describe your attendance percentage using only an emoji. 📉",
    "What's the most chaotic group project story you have? 📂",
    "Back-bencher, front-bencher, or 'I sit wherever my friends are'? 🪑",
    "You're the main character in a movie. What's the title and genre? 🎬",
    "If your life had a loading screen tip, what would it say? 💡",
    "You get one cheat code for real life. What does it do? 🎮",
    "If your pet (real or imaginary) could talk, what would it roast you for? 🐶",
    "You can only eat one cuisine for the rest of your life. Go. 🌶️",
    "You wake up as the college principal for one day. First announcement? 📢",
    "If you were a villain, what would your evil plan be? 😈",
    "Your phone's autocorrect becomes your personality. What are you now? 📱",
    "You can instantly master one skill. What are you picking? ⚡",
    "Which fictional world would you move into tomorrow? 🪄",
    "If you started a YouTube channel today, what would it be about? 📹",
    "What's something you're weirdly, unreasonably good at? 🏅",
    "What's the last song you played on repeat until it got annoying? 🎧",
    "What's a small thing that instantly makes your day better? ☀️",
    "What's your go-to karaoke song when nobody's judging? 🎤",
    "What's the best trip you've been on, and what made it so good? ✈️",
    "Which show or anime would you make everyone watch if you could? 📺",
    "What's your most useless talent? Show-off time. 🤹",
    "What's the most 'main character' thing you've ever done? 🌟",
    "What's one thing you'd do if you knew nobody would ever find out? (Keep it legal 😅)",
    "What's your comfort movie that you've seen way too many times? 🍿",
    "What's your current obsession? Anything goes. 🌀",
    "Which emoji describes your personality best, and why? 😎",
    "Rapid fire: chai or coffee, mountains or beaches, call or text? ☕",
    "Rapid fire: night owl or early bird, cats or dogs, sweet or spicy? 🦉",
    "Rapid fire: Marvel or DC, Insta or Snap, sunrise or sunset? 🌅",
    "Two truths and a lie. You go first! 🤔",
    "Tell me three emojis that sum up your week, and I'll guess what happened. 🔮",
    "Guess my zodiac sign in one try. Winner gets bragging rights. ♈",
    "Let's play: describe your dream day in exactly 5 words. ✋",
];
let icebreakerBag = [];
function nextIcebreaker() {
    if (!icebreakerBag.length) icebreakerBag = [...ICEBREAKERS].sort(() => Math.random() - 0.5);
    return icebreakerBag.pop();
}

let socket = null;
let myEmail = '';
let mode = null;          // nothing picked until the user chooses
let interests = [];
let localStream = null;
let peer = null;
let iceServers = null;
let iceFetchedAt = 0;        // TURN credentials expire, so fetch fresh ones every few hours
let relayOnly = false;       // true when the server has a TURN relay: video never goes direct, so IPs stay hidden
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

// "Break the ice" button in the chat: one tap sends one random question as your message
function addIcebreakerButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'icebreaker';
    btn.innerHTML = '<b>🧊 Break the ice</b><span>Tap to ask a random question</span>';
    // One question per chat: the button sends a single question when tapped, then disappears
    btn.addEventListener('click', () => {
        if (!isMatched || btn.disabled) return;
        btn.disabled = true;
        const q = nextIcebreaker();
        socket.emit('chat_message', q);
        btn.remove();
        addMsg(q, 'me');
        stopTyping();
    }, { once: true });
    $('messages').appendChild(btn);
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
    await setupLogin();
    show('login');
    // Logged out because this email signed in on too many devices
    if (data?.reason === 'device_limit' || new URLSearchParams(location.search).get('signedout') === 'device') {
        $('loginError').textContent = 'You were logged out here because this email logged in on 2 other devices. Log in again to use it here.';
        history.replaceState(null, '', '/');
    }
})();

// Another device took this login's place: reload into the login screen with an explanation
function loggedOutByDeviceLimit() {
    location.href = '/?signedout=device';
}

// ---------- Login ----------
let pendingEmail = '';
let loginConfig = { googleClientId: null, codeLogin: true, domain: 'srmist.edu.in' };

function showLoginStep(step) {           // 'google' | 'email' | 'code'
    $('googleArea').hidden = step !== 'google';
    $('emailForm').hidden = step !== 'email';
    $('codeForm').hidden = step !== 'code';
    $('loginError').textContent = '';
}

// Both boxes (18+ / rules, and Terms + Privacy) must be ticked before any login
function needsAgreement() {
    const missing = [$('agreeInput'), $('termsInput')].filter(box => !box.checked);
    if (!missing.length) return false;
    $('loginError').textContent = missing.length === 2
        ? 'Tick both boxes first ☝️'
        : missing[0] === $('agreeInput') ? 'Tick the 18+ box first ☝️' : 'Please accept the Terms & Privacy Policy first ☝️';
    missing[0].focus();
    return true;
}

// Offer Google sign-in when it's set up, with the email code as a backup
async function setupLogin() {
    const { ok, data } = await api('/api/config');
    if (ok) loginConfig = data;
    $('useCodeBtn').hidden = !loginConfig.codeLogin;
    $('useGoogleBtn').hidden = !loginConfig.googleClientId;

    if (!loginConfig.googleClientId) return showLoginStep('email');
    showLoginStep('google');
    try {
        await loadScript('https://accounts.google.com/gsi/client');
        google.accounts.id.initialize({
            client_id: loginConfig.googleClientId,
            callback: onGoogleCredential,
            hd: loginConfig.domain,            // only a hint for Google's account picker; the server enforces it
            ux_mode: 'popup',
            auto_select: false,
        });
        google.accounts.id.renderButton($('googleBtn'), {
            type: 'standard', theme: 'outline', size: 'large', shape: 'pill', text: 'continue_with', logo_alignment: 'left',
            width: Math.min(400, Math.max(220, $('googleArea').clientWidth || 320)),
        });
    } catch (err) {
        console.warn(err);
        if (loginConfig.codeLogin) showLoginStep('email');
        $('loginError').textContent = "Couldn't load Google sign-in." + (loginConfig.codeLogin ? ' Use an email code instead.' : ' Refresh and try again.');
    }
}

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.async = true;
        s.onload = resolve;
        s.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.head.appendChild(s);
    });
}

async function onGoogleCredential(response) {
    if (needsAgreement()) return;
    $('loginError').textContent = '';
    const { ok, status, data } = await api('/api/google', { credential: response.credential, agree: true });
    if (!ok) {
        if (status === 403 && data.error === 'banned') return showBanned(data.until);
        return ($('loginError').textContent = data.error || 'Google sign-in failed. Try again.');
    }
    window.Entry.play(() => enterLobby(data.email));
}

$('useCodeBtn').addEventListener('click', () => { showLoginStep('email'); $('emailInput').focus(); });
$('useGoogleBtn').addEventListener('click', () => showLoginStep('google'));

$('emailForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('loginError').textContent = '';
    if (needsAgreement()) return;
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
    $('sentLabel').textContent = data.emailed === false ? 'Your code is already in the inbox (or spam) of'
        : data.resent ? 'Same code re-sent to' : 'Code sent to';
    $('codeMinutes').textContent = data.minutes || 15;
    showLoginStep('code');
    $('codeInput').focus();
});

$('codeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('loginError').textContent = '';
    if (needsAgreement()) return;
    const btn = e.submitter;
    btn.disabled = true;
    const { ok, data } = await api('/api/verify-code', { email: pendingEmail, code: $('codeInput').value, agree: true });
    btn.disabled = false;
    if (!ok) {
        // Expired or locked out: the server already emailed a fresh code
        if (data.newCode) {
            $('codeInput').value = '';
            $('sentLabel').textContent = 'New code sent to';
            $('codeMinutes').textContent = data.minutes || 15;
        }
        return ($('loginError').textContent = data.error || 'Something went wrong');
    }
    window.Entry.play(() => enterLobby(data.email));
});

$('changeEmailBtn').addEventListener('click', () => showLoginStep('email'));

// "Resend code": really emails the code again (same code while it's still valid)
$('resendBtn').addEventListener('click', async () => {
    const btn = $('resendBtn'), status = $('resendStatus');
    $('loginError').textContent = '';
    btn.disabled = true;
    status.textContent = 'Sending…';
    const { ok, data } = await api('/api/request-code', { email: pendingEmail, resend: true });
    if (!ok) {
        status.textContent = '';
        $('loginError').textContent = data.error || "Couldn't resend. Try again.";
    } else {
        status.textContent = data.emailed ? 'Sent ✓ check inbox & spam' : 'Just sent, give it a minute';
        $('sentLabel').textContent = 'Code sent to';
        $('codeMinutes').textContent = data.minutes || 15;
    }
    // Short cooldown so a double-tap doesn't send two emails
    setTimeout(() => { btn.disabled = false; status.textContent = ''; }, 10000);
});

$('logoutBtn').addEventListener('click', async () => {
    await api('/api/logout', {});
    try { google.accounts.id.disableAutoSelect(); } catch { }
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
    // Only admins see the Moderation link in the menu
    api('/api/me').then(({ ok, data }) => { $('menuAdmin').hidden = !(ok && data.admin); });
}

// ---------- Menu (top right of the lobby) ----------
function setMenu(open) {
    $('menuList').hidden = !open;
    $('menuBtn').setAttribute('aria-expanded', open);
    $('menuBtn').classList.toggle('open', open);
    if (open) $('menuList').querySelector('a:not([hidden]), button')?.focus();
}
$('menuBtn').addEventListener('click', (e) => { e.stopPropagation(); setMenu($('menuList').hidden); });
document.addEventListener('click', (e) => { if (!$('menuList').hidden && !e.target.closest('.menu')) setMenu(false); });
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('menuList').hidden) { setMenu(false); $('menuBtn').focus(); }
});
$('menuLogout').addEventListener('click', () => $('logoutBtn').click());

function renderMode() {
    document.querySelectorAll('.mode').forEach(b => {
        const active = b.dataset.mode === mode;
        b.classList.toggle('active', active);
        b.setAttribute('aria-checked', active);
    });
    $('goBtn').classList.toggle('locked', !mode);
    // The button says what's missing, then exactly what it will do
    $('goLabel').textContent = mode === 'video' ? 'Start video chat' : mode === 'text' ? 'Start text chat' : 'Choose Video or Text to start';
    document.querySelector('.enf-modes').classList.toggle('chosen', !!mode);
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
        if (!iceServers || Date.now() - iceFetchedAt > 4 * 3600e3) {
            const { ok: iceOk, data } = await api('/api/ice');
            iceServers = iceOk ? data.iceServers : [{ urls: 'stun:stun.l.google.com:19302' }];
            relayOnly = iceOk && data.relayOnly === true;
            iceFetchedAt = iceOk ? Date.now() : 0;
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
        if (err.message === 'unauthorized') { socket.disconnect(); socket = null; location.reload(); }
        if (err.message === 'device_limit') loggedOutByDeviceLimit();
        if (err.message === 'banned') showBanned();
    });
    socket.on('logged_out', () => loggedOutByDeviceLimit());

    socket.on('online', (n) => document.querySelectorAll('.online-count').forEach(el => (el.textContent = n)));

    socket.on('matched', ({ initiator, shared, sameNetwork, callId }) => {
        currentCallId = callId;
        lastStrangerChatAt = 0;
        clearTimeout(researchTimer);
        isMatched = true;
        $('messages').replaceChildren();
        addSys('You matched with someone who has a verified SRM email. Be kind, and never share your number, address or passwords.');
        if (shared.length) addSys(`You both like: ${shared.map(s => `${EMOJI[s] || '✨'} ${s}`).join(', ')}`, true);
        addIcebreakerButton();
        setChatEnabled(true);

        if (mode === 'text') {
            setStatus('Chatting with a stranger 💬');
        } else {
            setStatus('Connecting video… 📡', true);
            setRemotePlaceholder('Connecting video…');
            startPeer(initiator, sameNetwork);
        }
    });

    // Only accept video-setup messages for the current call (not leftovers from the previous stranger)
    socket.on('signal', (msg) => { if (msg?.callId === currentCallId && peer) peer.signal(msg.data); });

    socket.on('chat_message', (text) => {
        lastStrangerChatAt = Date.now();
        $('typing').hidden = true;
        addMsg(text, 'stranger');
    });

    socket.on('typing', (on) => {
        if (on) lastStrangerChatAt = Date.now();
        $('typing').hidden = !on;
    });
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

    // Red mark: many different people reported this account
    socket.on('warning', ({ reporters, reasons } = {}) => {
        const labels = { nudity: 'nudity or sexual content', harassment: 'harassment or hate', underage: 'looking under 18', spam: 'spam or ads', other: 'something else' };
        $('warningText').textContent = `${reporters} different people have reported your account in the last 30 days, for:`;
        $('warningReasons').replaceChildren(...Object.entries(reasons || {}).map(([r, n]) => {
            const li = document.createElement('li');
            li.textContent = `${labels[r] || r} (${n})`;
            return li;
        }));
        if (!$('warningDialog').open) $('warningDialog').showModal();
    });

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
    if (!socket) connectSocket();      // socket dropped (e.g. brief network blip): reconnect; io() buffers this join until it's back
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
let currentCallId = null;
let lastStrangerChatAt = 0;   // last time the stranger typed or sent a message (counts as "still here")

function startPeer(initiator, sameNetwork) {
    const started = performance.now();
    peer = new SimplePeer({
        initiator,
        stream: localStream,
        // Trickle: send each connection route as soon as it's found, instead of waiting for all of them.
        trickle: true,
        config: {
            iceServers,
            // Relay-only hides IPs from strangers; on the same network (e.g. campus Wi-Fi) connect directly.
            iceTransportPolicy: relayOnly && !sameNetwork ? 'relay' : 'all',
            iceCandidatePoolSize: 4,   // start gathering routes before they're needed
        },
    });
    const thisPeer = peer;
    const callId = currentCallId;

    peer.on('signal', (data) => socket.emit('signal', { callId, data }));
    let connected = false;
    peer.on('connect', () => {
        connected = true;
        if (peer === thisPeer && isMatched) {
            setStatus('Connected! 🎉');
            setRemotePlaceholder('No picture from them right now');   // hidden as soon as their video shows
        }
        console.info(`Video connected in ${Math.round(performance.now() - started)} ms`);
    });

    // Auto-skip ONLY in two cases, so nobody is left stranded with a dead call:
    //   1. The call never connects (or the connection fails / drops for good).
    //   2. It's connected but dead: their video is black AND they're silent AND they haven't
    //      typed anything, all at the same time for DEAD_MS in a row.
    // A dark room with someone talking, or a camera-off person who's chatting, never gets skipped.
    let skipped = false;
    const autoSkip = (why, text) => {
        if (skipped || peer !== thisPeer || !isMatched) return;
        skipped = true;
        clearTimeout(videoTimer);
        console.info('auto-skip:', why);
        addSys(text, true);
        startSearch();
    };
    // Wait a moment first: when they hit Next, their side closes a split second before the
    // server's "partner_left" arrives, and that message (not "connection dropped") should win.
    const lostConnection = () => setTimeout(() => autoSkip('connection failed', connected
        ? 'The connection to them dropped 📡 finding someone new…'
        : "Couldn't connect to them 📡 finding someone new…"), 2500);

    peer.on('stream', (stream) => {
        if (peer !== thisPeer) return;
        const v = $('remoteVideo');
        v.srcObject = stream;
        v.play?.().catch(() => { });
    });

    peer.on('error', (err) => { console.warn(err); lostConnection(); });
    peer.on('close', lostConnection);

    // One health loop, every 2 s:
    //  - say "Connected" the moment real frames decode (a blocked path can deliver a black, frozen stream)
    //  - case 1: not connected after CONNECT_MS → skip
    //  - case 2: black + silent + no chat for DEAD_MS → skip
    const CONNECT_MS = 20000, DEAD_MS = 20000;
    const sampler = document.createElement('canvas');
    sampler.width = 32; sampler.height = 24;
    const sctx = sampler.getContext('2d', { willReadFrequently: true });
    let lastTime = -1, showing = false, deadSince = null, audio = null;

    // Is their picture black (no new frames, or almost no light at all)?
    const isBlack = (v) => {
        const fresh = v.videoWidth > 0 && v.currentTime > 0 && v.currentTime !== lastTime;
        lastTime = v.currentTime;
        if (!fresh) return true;
        try {
            sctx.drawImage(v, 0, 0, 32, 24);
            const px = sctx.getImageData(0, 0, 32, 24).data;
            let sum = 0;
            for (let i = 0; i < px.length; i += 4) sum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
            return sum / (px.length / 4) < 6;    // mean brightness out of 255; a dim room is well above this
        } catch { return false; }                // can't tell → assume it's fine
    };

    // Have they made any sound since the last check? Unknown → assume yes (never skip on a guess).
    // Browsers only measure loudness while the sound is actually playing, so if playback is muted
    // or blocked (e.g. autoplay rules) we can't tell, and treat it as sound.
    const madeSound = async () => {
        const v = $('remoteVideo');
        if (v.muted || v.paused || v.volume === 0) return true;
        try {
            const stats = await thisPeer._pc.getStats();
            let rtp = null;
            stats.forEach(r => { if (r.type === 'inbound-rtp' && r.kind === 'audio') rtp = r; });
            if (!rtp) return !connected;          // no audio stream at all yet
            if (rtp.totalAudioEnergy !== undefined && rtp.totalSamplesDuration !== undefined) {
                const prev = audio;
                audio = { e: rtp.totalAudioEnergy, d: rtp.totalSamplesDuration };
                if (!prev || audio.d <= prev.d) return true;   // no new audio measured → can't tell
                return Math.sqrt((audio.e - prev.e) / (audio.d - prev.d)) > 0.01;   // average loudness (0–1)
            }
            return rtp.audioLevel === undefined || rtp.audioLevel > 0.01;
        } catch { return true; }
    };

    const checkHealth = async () => {
        if (skipped || peer !== thisPeer || !isMatched) return;
        const now = performance.now();
        if (!connected && now - started > CONNECT_MS) return autoSkip('never connected', "Couldn't connect to them 📡 finding someone new…");

        const v = $('remoteVideo');
        const black = isBlack(v);
        if (!black && !showing) {
            showing = true;
            console.info(`Video showing after ${Math.round(now - started)} ms`);
            $('remotePlaceholder').hidden = true;
            setStatus('Connected! 🎉');
        }

        if (connected) {
            const sound = await madeSound();
            if (skipped || peer !== thisPeer || !isMatched) return;
            const chatted = Date.now() - lastStrangerChatAt < DEAD_MS;
            if (black && !sound && !chatted) {
                deadSince ??= now;
                if (now - deadSince > DEAD_MS) return autoSkip('black + silent', 'No video, no sound and no messages from them 🙈 finding someone new…');
            } else {
                deadSince = null;
            }
        }
        videoTimer = setTimeout(checkHealth, 2000);
    };
    videoTimer = setTimeout(checkHealth, 2000);
}

function endPeer() {
    clearTimeout(videoTimer);
    if (peer) { peer.destroy(); peer = null; }
    $('remoteVideo').srcObject = null;
    $('remotePlaceholder').hidden = false;
    setRemotePlaceholder('Finding someone from campus…');
}

function setRemotePlaceholder(text) {
    $('remotePlaceholderText').textContent = text;
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

$('reportBtn').addEventListener('click', () => { $('reportNote').value = ''; });

document.querySelectorAll('.report-reasons button').forEach(b => b.addEventListener('click', () => {
    $('reportDialog').close();
    if (!isMatched) return;
    socket.emit('report', { reason: b.dataset.reason, note: $('reportNote').value.trim().slice(0, 200) });
    isMatched = false;
    toast('Reported. Thanks for keeping it chill 🙏');
    $('messages').replaceChildren();
    startSearch();
}));

$('warningOk').addEventListener('click', () => {
    socket?.emit('ack_warning');
    $('warningDialog').close();
});
// The warning can only be closed with "I understand"
$('warningDialog').addEventListener('cancel', (e) => e.preventDefault());

// ---------- Banned ----------
function showBanned(until) {
    endPeer();
    stopCamera();
    if (until) $('bannedText').textContent = `Too many people reported you. You can come back after ${new Date(until).toLocaleString()}.`;
    show('banned');
}
