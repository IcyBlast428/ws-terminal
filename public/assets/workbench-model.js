(function (root) {
  'use strict';
  function errorText(error) {
    const message = error?.message || String(error);
    const prefix = { 401: '登录已过期，请重新登录后重试', 403: '访问被拒绝，请检查文件权限或代理设置', 404: '目标不存在，可能已被删除或会话已结束',
      409: '内容发生变化，请刷新或合并后重试', 413: '超过大小限制', 429: '请求或容量达到限制，请稍后重试',
      502: '反向代理无法连接后端服务', 503: '服务暂时不可用', 504: '反向代理等待后端超时' }[error?.status];
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return '请求超时或已取消，可以重试';
    if (error?.kind === 'network') return '网络连接失败，请检查网络或代理后重试';
    return prefix ? `${prefix}${message && !/^请求失败|^Unauthorized$/.test(message) ? '：' + message : ''}` : message;
  }
  function needsPasteApproval(text) { return /[\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text); }
  function pastePreview(text) { return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, value => '\\x' + value.charCodeAt(0).toString(16).padStart(2, '0')); }
  function topLevelPaths(paths) {
    const unique = [...new Set(paths)];
    return unique.filter(value => !unique.some(parent => parent !== value && value.startsWith(`${parent}/`)));
  }
  function breadcrumbs(value) {
    let current = '';
    return [{ name: '/', path: '/' }, ...value.split('/').filter(Boolean).map(name => ({ name, path: current += '/' + name }))];
  }
  const model = { errorText, needsPasteApproval, pastePreview, topLevelPaths, breadcrumbs };
  if (typeof module !== 'undefined' && module.exports) module.exports = model;
  else root.WorkbenchModel = model;
}(typeof window === 'undefined' ? globalThis : window));
