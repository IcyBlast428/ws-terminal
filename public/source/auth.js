import { createElement, Eye, EyeOff, Terminal, ArrowRight } from 'lucide';

function mount(container, onAuthenticated) {
  const form = document.createElement('form'); form.className = 'auth-form'; form.autocomplete = 'off';
  const mark = document.createElement('div'); mark.className = 'auth-mark'; mark.append(createElement(Terminal, { width: 28, height: 28, 'aria-hidden': 'true' }));
  const heading = document.createElement('h1'); heading.textContent = 'WS Terminal';
  const host = document.createElement('p'); host.className = 'auth-host'; host.textContent = location.host;
  const label = document.createElement('label'); label.htmlFor = 'tokenInput'; label.textContent = '访问令牌';
  const field = document.createElement('div'); field.className = 'auth-token-field';
  const input = document.createElement('input'); input.id = 'tokenInput'; input.type = 'password'; input.name = 'token'; input.autocomplete = 'off'; input.required = true; input.spellcheck = false; input.setAttribute('aria-label', '访问令牌');
  const reveal = document.createElement('button'); reveal.type = 'button'; reveal.className = 'icon-button';
  const updateReveal = () => { const visible = input.type === 'text'; reveal.title = visible ? '隐藏令牌' : '显示令牌'; reveal.setAttribute('aria-label', reveal.title); reveal.setAttribute('aria-pressed', String(visible)); reveal.replaceChildren(createElement(visible ? EyeOff : Eye, { width: 17, height: 17, 'aria-hidden': 'true' })); };
  reveal.addEventListener('click', () => { input.type = input.type === 'password' ? 'text' : 'password'; updateReveal(); input.focus(); }); updateReveal();
  field.append(input, reveal);
  const error = document.createElement('p'); error.className = 'auth-error'; error.setAttribute('role', 'alert');
  const submit = document.createElement('button'); submit.type = 'submit'; submit.className = 'auth-submit'; const caption = document.createElement('span'); caption.textContent = '登录'; submit.append(caption, createElement(ArrowRight, { width: 18, height: 18, 'aria-hidden': 'true' }));
  form.append(mark, heading, host, label, field, error, submit); container.replaceChildren(form);
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (submit.disabled || !input.value.trim()) return;
    submit.disabled = true; input.disabled = true; reveal.disabled = true; caption.textContent = '登录中'; error.textContent = '';
    try {
      const response = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: input.value.trim() }), cache: 'no-store' });
      input.value = ''; input.type = 'password'; updateReveal();
      if (!response.ok) throw new Error(response.status === 401 ? '访问令牌不正确' : response.status === 429 ? '登录尝试过多，请稍后重试' : response.status === 403 ? '登录请求被拒绝，请检查代理设置' : '暂时无法连接服务');
      await onAuthenticated();
    } catch (failure) { error.textContent = failure instanceof TypeError ? '无法连接服务，请检查网络后重试' : failure.message; }
    finally { submit.disabled = false; input.disabled = false; reveal.disabled = false; caption.textContent = '登录'; if (container.isConnected) input.focus(); }
  });
  requestAnimationFrame(() => input.focus());
  return { focus: () => input.focus(), clear: () => { input.value = ''; input.type = 'password'; } };
}

window.WorkbenchAuth = { mount };
const page = document.getElementById('loginMount');
if (page) {
  const preferences = window.WorkbenchPreferences?.load();
  document.documentElement.dataset.theme = preferences?.theme === 'light' || (preferences?.theme === 'system' && matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  mount(page, () => location.replace('/'));
}
