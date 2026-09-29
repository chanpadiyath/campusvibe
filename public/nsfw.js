// Nudity filter for video chats. Runs entirely in this browser: frames are checked on the device
// and never sent anywhere. It isn't perfect, so reporting still matters.
//  - Stranger's video: if two checks in a row look like nudity, it's blurred for the rest of that chat.
//  - Your own camera: if two checks in a row look like nudity, your camera is switched off before it's sent.
window.NsfwGuard = (() => {
    const CHECK_EVERY_MS = 1000;
    const BLOCK_AT = 0.7;        // Porn + Hentai probability that counts as "looks like nudity"
    const IN_A_ROW = 2;          // consecutive hits needed, to avoid one-frame false alarms

    let model = null;
    let loading = null;
    let timer = null;
    let busy = false;
    let hooks = {};
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 224;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const state = { remoteHits: 0, localHits: 0, remoteBlocked: false };

    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = src;
            s.onload = resolve;
            s.onerror = () => reject(new Error(`Failed to load ${src}`));
            document.head.appendChild(s);
        });
    }

    // Load the model once, in the background (about 6 MB, cached by the browser afterwards)
    function load() {
        if (model) return Promise.resolve(model);
        if (!loading) {
            loading = (async () => {
                await loadScript('/vendor/nsfw-model/model.min.js');
                await loadScript('/vendor/nsfw-model/weights.min.js');
                await loadScript('/vendor/nsfwjs.min.js');
                model = await window.nsfwjs.load('MobileNetV2');
                return model;
            })().catch(err => {
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

    async function score(video) {
        ctx.drawImage(video, 0, 0, 224, 224);
        const preds = await model.classify(canvas);
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
