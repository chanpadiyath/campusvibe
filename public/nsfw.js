// Nudity filter for video chats. Runs entirely in this browser: frames are checked on the device
// and never sent anywhere. It isn't perfect, so reporting still matters.
//  - Stranger's video: if two checks in a row look like nudity, it's blurred for the rest of that chat.
//  - Your own camera: if two checks in a row look like nudity, your camera is switched off before it's sent.
window.NsfwGuard = (() => {
    const CHECK_EVERY_MS = 1000;
    const BLOCK_AT = 0.7;        // Porn + Hentai probability that counts as "looks like nudity"
    const IN_A_ROW = 2;          // consecutive hits needed, to avoid one-frame false alarms

    let model = null;            // truthy once the model can score frames (worker or fallback)
    let loading = null;
    let timer = null;
    let busy = false;
    let hooks = {};
    const state = { remoteHits: 0, localHits: 0, remoteBlocked: false };

    // Preferred: a background worker, so loading the ~6 MB model never freezes the page
    let worker = null;
    let nextId = 0;
    const waiting = new Map();

    function loadInWorker() {
        return new Promise((resolve, reject) => {
            worker = new Worker('/nsfw-worker.js');
            worker.onmessage = (e) => {
                const m = e.data;
                if (m.type === 'ready') resolve('worker');
                else if (m.type === 'error') reject(new Error(m.message));
                else if (m.type === 'score') {
                    const w = waiting.get(m.id);
                    waiting.delete(m.id);
                    if (w) m.error ? w.reject(new Error(m.error)) : w.resolve(m.score);
                }
            };
            worker.onerror = (e) => reject(new Error(e.message || 'worker failed'));
        });
    }

    // Fallback for browsers without worker canvas support: load on the page, but only once the
    // call is up and the page is idle, so it doesn't delay connecting
    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = src;
            s.onload = resolve;
            s.onerror = () => reject(new Error(`Failed to load ${src}`));
            document.head.appendChild(s);
        });
    }
    async function loadOnPage() {
        await new Promise(r => setTimeout(r, 5000));
        await loadScript('/vendor/nsfw-model/model.min.js');
        await loadScript('/vendor/nsfw-model/weights.min.js');
        await loadScript('/vendor/nsfwjs.min.js');
        return window.nsfwjs.load('MobileNetV2');
    }

    function load() {
        if (model) return Promise.resolve(model);
        if (!loading) {
            const canWorker = typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function';
            loading = (canWorker ? loadInWorker() : Promise.reject(new Error('no worker support')))
                .catch(err => {
                    console.info('Nudity filter: using the on-page fallback', err.message);
                    worker?.terminate();
                    worker = null;
                    return loadOnPage();
                })
                .then(m => { model = m; return m; })
                .catch(err => {
                    console.warn('Nudity filter unavailable:', err);
                    loading = null;
                    throw err;
                });
        }
        return loading;
    }

    function ready(video) {
        return video && video.srcObject && video.readyState >= 2 && video.videoWidth > 0;
    }

    const pageCanvas = document.createElement('canvas');
    pageCanvas.width = pageCanvas.height = 224;
    const pageCtx = pageCanvas.getContext('2d', { willReadFrequently: true });

    async function score(video) {
        if (worker) {
            const bitmap = await createImageBitmap(video, { resizeWidth: 224, resizeHeight: 224 });
            const id = ++nextId;
            return new Promise((resolve, reject) => {
                waiting.set(id, { resolve, reject });
                worker.postMessage({ id, bitmap }, [bitmap]);
            });
        }
        pageCtx.drawImage(video, 0, 0, 224, 224);
        const preds = await model.classify(pageCanvas);
        const p = Object.fromEntries(preds.map(x => [x.className, x.probability]));
        return (p.Porn || 0) + (p.Hentai || 0);
    }

    async function check() {
        // Keep checking even in a background tab: your camera is still being sent while you're on another tab
        if (busy || !model) return;
        busy = true;
        try {
            const remote = hooks.remoteVideo?.();
            if (!state.remoteBlocked && ready(remote)) {
                state.remoteHits = (await score(remote)) >= BLOCK_AT ? state.remoteHits + 1 : 0;
                if (state.remoteHits >= IN_A_ROW) {
                    state.remoteBlocked = true;
                    hooks.onRemoteBlocked?.();
                }
            }
            const local = hooks.localVideo?.();
            const track = local?.srcObject?.getVideoTracks?.()[0];
            if (track && track.enabled && ready(local)) {
                state.localHits = (await score(local)) >= BLOCK_AT ? state.localHits + 1 : 0;
                if (state.localHits >= IN_A_ROW) {
                    state.localHits = 0;
                    hooks.onLocalBlocked?.();
                }
            }
        } catch (err) {
            console.warn('Nudity check failed:', err);
        } finally {
            busy = false;
        }
    }

    return {
        // hooks: { remoteVideo(), localVideo(), onRemoteBlocked(), onLocalBlocked() }
        start(h) {
            hooks = h;
            load().then(() => {
                if (!timer) timer = setInterval(check, CHECK_EVERY_MS);
            }).catch(() => hooks.onUnavailable?.());
        },
        stop() {
            clearInterval(timer);
            timer = null;
        },
        // New chat partner: start fresh
        newMatch() {
            state.remoteHits = 0;
            state.remoteBlocked = false;
        },
        preload: () => load().catch(() => { }),
    };
})();
