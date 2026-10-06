// Lobby: the "How do you want to meet people?" page (Video/Text, interests, start).
// Also owns the light/dark theme (switch on the chat screen and in the lobby menu).
window.Lobby = (() => {
    // Light / dark theme for the chat screen (dark by default, remembered in this browser)
    let theme = 'dark';
    try { theme = localStorage.getItem('theme') === 'light' ? 'light' : 'dark'; } catch { }
    const menuTheme = document.getElementById('menuTheme');
    const applyTheme = () => {
        document.body.dataset.theme = theme;
        document.getElementById('themeToggle').setAttribute('aria-pressed', theme === 'light');
        // The lobby menu offers the opposite of the current theme
        menuTheme.textContent = theme === 'light' ? '🌙 Dark mode' : '☀️ Light mode';
        menuTheme.setAttribute('aria-pressed', theme === 'light');
    };
    const toggleTheme = () => {
        theme = theme === 'light' ? 'dark' : 'light';
        try { localStorage.setItem('theme', theme); } catch { }
        applyTheme();
        window.ChatBg?.refreshTheme();
    };
    applyTheme();
    // Same setting from both places: the chat screen's DARK · LIGHT switch and the lobby menu
    document.getElementById('themeToggle').addEventListener('click', toggleTheme);
    menuTheme.addEventListener('click', toggleTheme);

    return {
        start() { scrollTo(0, 0); },
        stop() { },
    };
})();
