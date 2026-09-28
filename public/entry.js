// After a successful login: flash of light, then a black "double door" loader
// counts to 100 and swings open onto the lobby.
window.Entry = (() => {
    const frame = document.querySelector('.hl-frame');
    const entry = document.getElementById('entry');
    const fill = document.getElementById('entryFill');
    const pct = document.getElementById('entryPct');
    const status = document.getElementById('entryStatus');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const STATUSES = [[0, 'OPENING THE FIRST DOOR'], [45, 'STEPPING INSIDE'], [80, 'FINDING YOUR PEOPLE']];

    const wait = (ms) => new Promise(r => setTimeout(r, ms));

    function countUp(duration) {
        const start = performance.now();
        return new Promise(resolve => {
            const step = (now) => {
                const t = Math.min(1, (now - start) / duration);
                const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
                const n = Math.round(eased * 100);
                pct.textContent = n;
                fill.style.transform = `scaleX(${eased})`;
                status.textContent = STATUSES.filter(([at]) => n >= at).pop()[1];
                if (t < 1) requestAnimationFrame(step);
                else resolve();
            };
            requestAnimationFrame(step);
        });
    }

    return {
        async play(onReady) {
            // 1. Form fades, then a flash of light over the scene
            frame.classList.add('leaving');
            await wait(reduceMotion ? 0 : 350);
            frame.classList.add('flashing');
            await wait(reduceMotion ? 0 : 450);

            // 2. Closed black doors with the loader on them
            entry.hidden = false;
            void entry.offsetWidth;
            entry.classList.add('in');
            await wait(400);
            await countUp(reduceMotion ? 500 : 2400);

            // 3. Lobby goes in behind the doors, light leaks through the gap, doors swing open
            onReady();
            frame.classList.remove('leaving', 'flashing');
            entry.classList.add('glow');
            await wait(reduceMotion ? 0 : 550);
            entry.classList.add('opening');
            await wait(reduceMotion ? 0 : 1300);

            entry.hidden = true;
            entry.classList.remove('in', 'glow', 'opening');
            fill.style.transform = 'scaleX(0)';
            pct.textContent = '0';
        },
    };
})();
