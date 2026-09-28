// Lobby "walk": seven doorways lined up on one axis. Scrolling moves the camera
// forward through them (and backward when you scroll up). The last door is where
// you pick video/text and interests.
window.Lobby = (() => {
    const screen = document.getElementById('screen-lobby');
    const walk = document.getElementById('enfWalk');
    const stage = document.querySelector('.enf-stage');
    const canvas = document.getElementById('enfCanvas');
    const ctx = canvas.getContext('2d');
    const intro = document.getElementById('enfIntro');
    const plates = [...document.querySelectorAll('.enf-plate')];
    const hud = {
        chamber: document.getElementById('hudChamber'),
        matter: document.getElementById('hudMatter'),
        pct: document.getElementById('hudPct'),
        dir: document.getElementById('hudDir'),
    };
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const P = 800;              // "camera" perspective
    const SPACING = 1600;       // distance between doorways
    const FIRST = 900;          // distance to the first doorway
    const numerals = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
    const rooms = plates.map(p => ({ accent: p.dataset.accent, deep: p.dataset.deep, name: p.dataset.name, matter: p.dataset.matter }));
    const depths = rooms.map((_, i) => FIRST + i * SPACING);
    const MAX_Z = depths[depths.length - 1] - 350;

    let W = 0, H = 0, S = 0, dpr = 1;
    let running = false;
    let raf = 0;
    let camZ = 0;
    let renderedZ = null;
    let last = performance.now();
    let current = -1;
    let dirTimer = null;

    // The walls are drawn on one canvas every frame (no giant 3D layers, so no flicker)
    function sizeCanvas() {
        const w = stage.clientWidth, h = stage.clientHeight;
        if (w === W && h === H) return;
        W = w; H = h;
        dpr = Math.min(window.devicePixelRatio || 1, 1.5);
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
        S = 3 * Math.max(W, H);          // size of a wall when it sits at the screen plane
        renderedZ = null;
    }

    const hexA = (hex, a) => {
        const n = parseInt(hex.slice(1), 16);
        return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
    };

    // Arch outline in wall units (0..1000, doorway centred at 500)
    function arch(X, Y, left, right, radius, u) {
        ctx.moveTo(X(left), Y(595));
        ctx.lineTo(X(left), Y(462));
        ctx.arc(X(500), Y(462), radius * u, Math.PI, 2 * Math.PI);
        ctx.lineTo(X(right), Y(595));
    }

    function draw() {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);
        const cx = W / 2, cy = H / 2;

        // Far light at the end of the axis
        const endK = P / (P + depths[depths.length - 1] + 900 - camZ);
        const endR = S * endK * 0.22;
        const glow = ctx.createRadialGradient(cx, cy + S * endK * 0.02, 0, cx, cy, endR);
        glow.addColorStop(0, hexA(rooms[rooms.length - 1].accent, 0.9));
        glow.addColorStop(1, hexA(rooms[rooms.length - 1].accent, 0));
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, W, H);

        // Farthest wall first, nearest last
        for (let i = rooms.length - 1; i >= 0; i--) {
            const d = depths[i] - camZ;
            if (P + d < 120) continue;                   // already walked through it
            const k = P / (P + d);
            const size = S * k, u = size / 1000;
            if (55 * u > Math.hypot(W, H)) continue;     // doorway bigger than the screen: passed
            const X = (x) => cx + (x - 500) * u;
            const Y = (y) => cy + (y - 500) * u;
            const room = rooms[i];

            ctx.globalAlpha = Math.max(0, Math.min(1, 1.25 - d / 7000));

            // Wall with the doorway cut out
            const g = ctx.createRadialGradient(X(500), Y(520), 0, X(500), Y(520), 550 * u);
            g.addColorStop(0, hexA(room.accent, 0.55));
            g.addColorStop(0.35, room.deep);
            g.addColorStop(1, '#050404');
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.rect(X(0), Y(0), size, size);
            arch(X, Y, 445, 555, 55, u);
            ctx.closePath();
            ctx.fill('evenodd');

            // Mouldings
            ctx.strokeStyle = room.accent;
            ctx.lineCap = 'round';
            const line = (w, a, build) => {
                ctx.globalAlpha = Math.max(0, Math.min(1, 1.25 - d / 7000)) * a;
                ctx.lineWidth = Math.max(0.5, w * u);
                ctx.beginPath();
                build();
                ctx.stroke();
            };
            line(2.2, 0.75, () => arch(X, Y, 432, 568, 68, u));
            line(0.8, 0.4, () => arch(X, Y, 424, 576, 76, u));
            line(1, 0.25, () => { ctx.moveTo(X(0), Y(595)); ctx.lineTo(X(1000), Y(595)); });
            line(0.8, 0.2, () => {
                ctx.moveTo(X(392), Y(595)); ctx.lineTo(X(392), Y(380));
                ctx.moveTo(X(608), Y(595)); ctx.lineTo(X(608), Y(380));
            });
        }
        ctx.globalAlpha = 1;
    }

    function targetZ() {
        const r = walk.getBoundingClientRect();
        const travel = r.height - H;                     // stage height, not window height (stable on phones)
        const p = Math.min(1, Math.max(0, -r.top / travel));
        const x = Math.min(1, p / 0.9);                  // last 10% of scroll: stand still at the door
        return MAX_Z * (1 - Math.pow(1 - x, 1.5));       // slow down smoothly as you arrive
    }

    function setRoom(i) {
        if (i === current) return;
        current = i;
        const room = rooms[i];
        screen.style.setProperty('--accent', room.accent);
        screen.style.setProperty('--deep', room.deep);
        hud.chamber.textContent = `${numerals[i]} · ${room.name}`;
        hud.matter.textContent = room.matter;
    }

    function frame(now) {
        if (!running) return;
        const dt = Math.min(100, now - last);
        last = now;

        sizeCanvas();
        const target = targetZ();
        const delta = target - camZ;
        camZ += reduceMotion ? delta : delta * (1 - Math.exp(-dt / 90));
        if (Math.abs(target - camZ) < 1.5) camZ = target;   // settle instead of creeping forever

        if (camZ !== renderedZ) {
            renderedZ = camZ;
            draw();

            // Which room are we in, and the text plates for it
            const progress = camZ / MAX_Z;
            const room = Math.min(rooms.length - 1, Math.floor(progress * rooms.length));
            setRoom(room);
            intro.style.opacity = Math.max(0, 1 - camZ / 380).toFixed(3);
            intro.style.pointerEvents = camZ < 200 ? 'auto' : 'none';
            const local = progress * rooms.length - room;       // 0..1 inside this room
            plates.forEach((p, i) => {
                const on = i === room && camZ > 460;             // only after the intro has faded
                const fade = on ? Math.min(1, local * 5, (1 - local) * 5 + (i === rooms.length - 1 ? 1 : 0)) : 0;
                p.style.opacity = Math.max(0, fade).toFixed(3);
            });
            hud.pct.textContent = String(Math.round(progress * 100)).padStart(3, '0');
        }

        if (Math.abs(delta) > 2) {
            hud.dir.textContent = delta > 0 ? 'FORWARD' : 'REVERSE';
            clearTimeout(dirTimer);
            dirTimer = setTimeout(() => (hud.dir.textContent = 'IDLE'), 400);
        }

        raf = requestAnimationFrame(frame);
    }

    // Light / dark theme for the chat screen (dark by default, remembered in this browser)
    let theme = 'dark';
    try { theme = localStorage.getItem('theme') === 'light' ? 'light' : 'dark'; } catch { }
    const applyTheme = () => {
        document.body.dataset.theme = theme;
        document.getElementById('themeToggle').setAttribute('aria-pressed', theme === 'light');
    };
    applyTheme();
    document.getElementById('themeToggle').addEventListener('click', () => {
        theme = theme === 'light' ? 'dark' : 'light';
        try { localStorage.setItem('theme', theme); } catch { }
        applyTheme();
        window.ChatBg?.refreshTheme();
    });

    document.getElementById('enfWalkBtn').addEventListener('click', () => {
        scrollTo({ top: walk.offsetTop + (walk.offsetHeight - innerHeight) / 7, behavior: 'smooth' });
    });
    document.getElementById('enfSkipBtn').addEventListener('click', () => {
        document.getElementById('enfDoor').scrollIntoView({ behavior: 'smooth' });
    });

    return {
        // atDoor: jump straight to the choices (e.g. coming back from a chat)
        start(atDoor = false) {
            if (atDoor) {
                const door = document.getElementById('enfDoor');
                scrollTo(0, door.offsetTop);
                camZ = MAX_Z;
            } else {
                camZ = 0;
            }
            current = -1;
            renderedZ = null;
            if (running) return;
            running = true;
            last = performance.now();
            raf = requestAnimationFrame(frame);
        },
        stop() {
            running = false;
            cancelAnimationFrame(raf);
        },
    };
})();
