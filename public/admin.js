// Moderation dashboard: reported accounts, red marks, bans. Only works for ADMIN_EMAILS.
const $ = (id) => document.getElementById(id);
const REASONS = { nudity: 'Nudity / sexual', harassment: 'Harassment / hate', underage: 'Looks under 18', spam: 'Spam / ads', other: 'Other' };
let data = null;
let filter = 'all';

const fmt = (ms) => new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') node.className = v;
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v);
    }
    for (const c of children.flat()) if (c != null && c !== false) node.append(c);
    return node;
}

async function api(path, body) {
    const res = await fetch(path, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.error || `Error ${res.status}`), { status: res.status });
    return json;
}

async function load() {
    $('error').textContent = '';
    try {
        data = await api('/api/admin/reports');
        render();
    } catch (err) {
        $('summary').textContent = '';
        $('error').textContent = err.status === 401 ? 'Log in to CampusVibe first, then come back to /admin.'
            : err.status === 403 ? 'Not authorized. This page is only for moderators.'
            : `Couldn't load reports: ${err.message}`;
    }
}

function render() {
    const redCount = data.accounts.filter(a => a.redMark).length;
    const bannedCount = data.accounts.filter(a => a.banned).length;
    $('summary').textContent = `${data.accounts.length} REPORTED · ${redCount} RED MARK · ${bannedCount} BANNED · ${data.online} ONLINE NOW`;
    $('rules').textContent = `Red mark: more than ${data.redMarkAt} different people reported the account in 30 days (they see a warning once). `
        + `Auto-ban: ${data.banAt} different reporters within 7 days → ${data.banHours}h ban. Reports are deleted after 30 days.`;

    const shown = data.accounts.filter(a => filter === 'all' || (filter === 'red' && a.redMark) || (filter === 'banned' && a.banned));
    $('list').replaceChildren(...(shown.length ? shown.map(card) : [el('p', { class: 'empty' }, 'Nothing here. 🎉')]));
}

function card(a) {
    const badges = [
        a.redMark && el('span', { class: 'badge red' }, 'Red mark'),
        a.warned === 'pending' && el('span', { class: 'badge' }, 'Warning not seen yet'),
        a.warned === 'acknowledged' && el('span', { class: 'badge' }, 'Warning seen'),
        a.banned && el('span', { class: 'badge ban' }, a.banned.until === null ? 'Banned permanently' : `Banned until ${fmt(a.banned.until)}`),
    ];
    return el('article', { class: `account${a.redMark ? ' red' : ''}` },
        el('div', { class: 'account-head' },
            el('span', { class: 'account-email' }, a.email),
            el('div', { class: 'badges' }, badges)),
        a.reports > 0 && el('p', { class: 'stats' },
            `${a.reporters} different reporter${a.reporters === 1 ? '' : 's'} (${a.reporters7d} this week) · ${a.reports} report${a.reports === 1 ? '' : 's'} · last ${fmt(a.lastAt)}`),
        el('div', { class: 'reasons' }, Object.entries(a.reasons).map(([r, n]) => el('span', { class: 'reason' }, `${REASONS[r] || r} × ${n}`))),
        a.notes.length > 0 && el('ul', { class: 'notes', 'aria-label': 'Notes from reporters' },
            a.notes.map(n => el('li', {}, el('span', { class: 'when' }, `${fmt(n.at)} · ${REASONS[n.reason] || n.reason}`), n.note))),
        el('div', { class: 'actions' },
            a.banned
                ? el('button', { class: 'act', onclick: () => act('/api/admin/unban', a.email, 'Unban') }, 'Unban')
                : [
                    el('button', { class: 'act danger', onclick: () => act('/api/admin/ban', a.email, 'Ban for 24 hours', 24) }, 'Ban 24h'),
                    el('button', { class: 'act danger', onclick: () => act('/api/admin/ban', a.email, 'Ban for 7 days', 168) }, 'Ban 7 days'),
                    el('button', { class: 'act danger', onclick: () => act('/api/admin/ban', a.email, 'Ban permanently', null) }, 'Ban forever'),
                ],
            a.reports > 0 && el('button', { class: 'act', onclick: () => act('/api/admin/clear', a.email, 'Clear all reports and the red mark for') }, 'Clear reports')));
}

async function act(path, email, label, hours) {
    if (!confirm(`${label}: ${email}?`)) return;
    try {
        await api(path, hours === undefined ? { email } : { email, hours });
        await load();
    } catch (err) {
        $('error').textContent = err.message;
    }
}

document.querySelectorAll('.filter[data-filter]').forEach(b => b.addEventListener('click', () => {
    filter = b.dataset.filter;
    document.querySelectorAll('.filter[data-filter]').forEach(x => x.classList.toggle('active', x === b));
    if (data) render();
}));
$('refresh').addEventListener('click', load);
load();
