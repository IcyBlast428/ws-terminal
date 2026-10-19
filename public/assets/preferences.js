(function (root) {
  'use strict';
  const defaults = Object.freeze({ theme: 'dark', wordWrap: false, indentSize: 2, useTabs: false, keymap: 'default', language: 'auto', terminalFontSize: 14, fileFontSize: 13, treeFontSize: 14, cursorBlink: true, scrollback: 8000 });
  const languages = Object.freeze({ auto: '自动识别', plain: '纯文本', javascript: 'JavaScript', typescript: 'TypeScript', json: 'JSON', yaml: 'YAML', python: 'Python', shell: 'Shell', ini: 'INI', markdown: 'Markdown', html: 'HTML', css: 'CSS', sql: 'SQL' });
  function normalize(value) {
    value = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const result = { ...defaults };
    for (const [key, values] of Object.entries({ theme: ['dark', 'light', 'system'], keymap: ['default', 'vim', 'emacs'], language: Object.keys(languages) })) if (values.includes(value[key])) result[key] = value[key];
    for (const key of ['wordWrap', 'useTabs', 'cursorBlink']) if (typeof value[key] === 'boolean') result[key] = value[key];
    for (const [key, [min, max]] of Object.entries({ indentSize: [1, 8], terminalFontSize: [10, 24], fileFontSize: [10, 28], treeFontSize: [12, 22], scrollback: [1000, 50000] })) if (Number.isInteger(value[key])) result[key] = Math.min(max, Math.max(min, value[key]));
    return result;
  }
  function load() {
    try {
      const saved = localStorage.getItem('ws-terminal-preferences');
      if (saved) return normalize(JSON.parse(saved));
      const migrated = {};
      for (const [key, old] of Object.entries({ terminalFontSize: 'font-size', fileFontSize: 'file-font-size', treeFontSize: 'tree-font-size' })) {
        const value = localStorage.getItem(`ws-terminal-${old}`); if (value !== null) migrated[key] = Number(value);
      }
      return normalize(migrated);
    } catch { return { ...defaults }; }
  }
  function save(value) { const result = normalize(value); try { localStorage.setItem('ws-terminal-preferences', JSON.stringify(result)); } catch {} return result; }
  const api = { defaults, languages, normalize, load, save };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WorkbenchPreferences = api;
}(typeof window === 'undefined' ? globalThis : window));
