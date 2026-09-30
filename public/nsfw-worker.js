// Runs the nudity model in a background thread so loading it (~6 MB) never freezes the page.
// Receives small video frames as ImageBitmaps and replies with a nudity score (Porn + Hentai).
/* global nsfwjs */
importScripts('/vendor/nsfw-model/model.min.js', '/vendor/nsfw-model/weights.min.js', '/vendor/nsfwjs.min.js');

const canvas = new OffscreenCanvas(224, 224);
const ctx = canvas.getContext('2d', { willReadFrequently: true });
let model = null;

const ready = nsfwjs.load('MobileNetV2')
    .then(m => { model = m; postMessage({ type: 'ready' }); })
    .catch(err => postMessage({ type: 'error', message: String(err && err.message || err) }));

onmessage = async (e) => {
    const { id, bitmap } = e.data;
    try {
        await ready;
        if (!model) throw new Error('model unavailable');
        ctx.drawImage(bitmap, 0, 0, 224, 224);
        const preds = await model.classify(ctx.getImageData(0, 0, 224, 224));
        const p = Object.fromEntries(preds.map(x => [x.className, x.probability]));
        postMessage({ type: 'score', id, score: (p.Porn || 0) + (p.Hentai || 0) });
    } catch (err) {
        postMessage({ type: 'score', id, error: String(err && err.message || err) });
    } finally {
        bitmap.close();
    }
};
