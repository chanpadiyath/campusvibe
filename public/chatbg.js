// Chat screen background: glyphs drifting slowly upward on a few faint vertical lines.
// Follows the dark/light theme and only runs while the chat screen is visible.
window.ChatBg = (() => {
    const canvas = document.getElementById('chatBg');
    const ctx = canvas.getContext('2d');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const GLYPHS = 'CAMPUSVIBESRM0123456789·+×/◦ABCDEFGHKLNORTWXYZ';

    let W = 0, H = 0, dpr = 1;
    let particles = [];
    let lines = [];
    let running = false;
    let raf = 0;
    let last = 0;
    let rgb = '232, 225, 211';
    let accent = '169, 155, 214';
    let mouse = { x: 0, y: 0 }, parallax = { x: 0, y: 0 };

    const pick = () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)];

    function makeParticle(anywhere) {
        const z = 0.25 + Math.random() * 0.75;               // depth: 1 = near
        return {
            x: Math.random() * W,
            y: anywhere ? Math.random() * H : H + 20,
            z,
            ch: pick(),
            speed: 6 + z * 18,                                 // px per second, upward
            sway: Math.random() * Math.PI * 2,
            swap: 2 + Math.random() * 6,                       // seconds until the glyph changes
            hot: Math.random() < 0.06,                         // a few glow in the accent colour
        };
    }

    function resize() {
        const w = canvas.clientWidth, h = canvas.clientHeight;
        if (w === W && h === H) return;
        W = w; H = h;
        dpr = Math.min(window.devicePixelRatio || 1, 1.5);
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
        const count = Math.round(Math.min(140, (W * H) / 9000));
        particles = Array.from({ length: count }, () => makeParticle(true));
        const cols = Math.max(3, Math.round(W / 260));
        lines = Array.from({ length: cols }, (_, i) => ({
            x: ((i + 0.5) / cols) * W + (Math.random() - 0.5) * 60,
            glint: Math.random() * H,
            speed: 30 + Math.random() * 50,
        }));
    }

    function readTheme() {
        const s = getComputedStyle(document.body);
        rgb = (s.getPropertyValue('--c-rgb') || rgb).trim() || rgb;
        const light = document.body.dataset.theme === 'light';
        accent = light ? '108, 91, 168' : '169, 155, 214';
    }

    function frame(now) {
        if (!running) return;
        const dt = Math.min(0.05, (now - last) / 1000 || 0);
        last = now;
        resize();

        parallax.x += (mouse.x - parallax.x) * 0.04;
        parallax.y += (mouse.y - parallax.y) * 0.04;

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);

        // Faint vertical lines with a glint sliding down each
        for (const l of lines) {
            ctx.fillStyle = `rgba(${rgb}, 0.06)`;
            ctx.fillRect(l.x, 0, 1, H);
            l.glint = (l.glint + l.speed * dt) % (H + 160);
            const g = ctx.createLinearGradient(0, l.glint - 160, 0, l.glint);
            g.addColorStop(0, `rgba(${rgb}, 0)`);
            g.addColorStop(1, `rgba(${rgb}, 0.35)`);
            ctx.fillStyle = g;
            ctx.fillRect(l.x, l.glint - 160, 1, 160);
        }

        // Drifting glyphs
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (let i = 0; i < particles.length; i++) {
            const p = particles[i];
            if (!reduceMotion) {
                p.y -= p.speed * dt;
                p.sway += dt * 0.6;
                p.swap -= dt;
                if (p.swap <= 0) { p.ch = pick(); p.swap = 2 + Math.random() * 6; }
                if (p.y < -20) particles[i] = makeParticle(false);
            }
            const x = p.x + Math.sin(p.sway) * 6 * p.z + parallax.x * p.z * 18;
            const y = p.y + parallax.y * p.z * 12;
            const size = 9 + p.z * 7;
            ctx.font = `${size}px 'IBM Plex Mono', monospace`;
            ctx.fillStyle = p.hot ? `rgba(${accent}, ${0.35 + p.z * 0.45})` : `rgba(${rgb}, ${0.1 + p.z * 0.34})`;
            ctx.fillText(p.ch, x, y);
        }

        raf = requestAnimationFrame(frame);
    }

    addEventListener('pointermove', (e) => {
        mouse.x = (e.clientX / innerWidth - 0.5) * 2;
        mouse.y = (e.clientY / innerHeight - 0.5) * 2;
    }, { passive: true });

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) cancelAnimationFrame(raf);
        else if (running) { last = performance.now(); raf = requestAnimationFrame(frame); }
    });

    return {
        start() {
            readTheme();
            if (running) return;
            running = true;
            last = performance.now();
            raf = requestAnimationFrame(frame);
        },
        stop() {
            running = false;
            cancelAnimationFrame(raf);
        },
        refreshTheme: readTheme,
    };
})();
