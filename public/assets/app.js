(function () {
  'use strict';

  const statusDot = document.getElementById('statusDot');
  const titleEl = document.getElementById('title');
  const metaEl = document.getElementById('meta');
  const form = document.getElementById('connectForm');
  const tokenInput = document.getElementById('tokenInput');
  const connectButton = document.getElementById('connectButton');
  const disconnectButton = document.getElementById('disconnectButton');
  const logoutButton = document.getElementById('logoutButton');
  const cwdPathEl = document.getElementById('cwdPath');
  const directoryTreeEl = document.getElementById('directoryTree');
  const refreshTreeButton = document.getElementById('refreshTreeButton');
  const createFileButton = document.getElementById('createFileButton');
  const createDirectoryButton = document.getElementById('createDirectoryButton');
  const workspaceEl = document.getElementById('workspace');
  const fileExplorerEl = document.getElementById('fileExplorer');
  const explorerResizer = document.getElementById('explorerResizer');
  const sidebarToggleButton = document.getElementById('sidebarToggleButton');
  const layoutRoot = document.getElementById('layoutRoot');
  const treeContextMenu = document.getElementById('treeContextMenu');
  const decreaseFontButton = document.getElementById('decreaseFontButton');
  const increaseFontButton = document.getElementById('increaseFontButton');
  const fontSizeValue = document.getElementById('fontSizeValue');
  const entryDialog = document.getElementById('entryDialog');
  const entryForm = document.getElementById('entryForm');
  const entryDialogTitle = document.getElementById('entryDialogTitle');
  const entryNameInput = document.getElementById('entryNameInput');
  const entryDialogError = document.getElementById('entryDialogError');
  const entryCancelButton = document.getElementById('entryCancelButton');
  const deleteDialog = document.getElementById('deleteDialog');
  const deleteForm = document.getElementById('deleteForm');
  const deleteMessage = document.getElementById('deleteMessage');
  const deleteDialogError = document.getElementById('deleteDialogError');
  const deleteCancelButton = document.getElementById('deleteCancelButton');
  const pathInput = document.getElementById('pathInput');
  const treeFilter = document.getElementById('treeFilter');
  const utilityDialog = document.getElementById('utilityDialog');
  const utilityBody = document.getElementById('utilityBody');
  const utilityActions = document.getElementById('utilityActions');
  const transferStatus = document.getElementById('transferStatus');
  const uploadInput = document.getElementById('uploadInput');

  const FitAddonCtor = window.FitAddon && (window.FitAddon.FitAddon || window.FitAddon);
  const tabs = new Map();
  const groups = new Map();
  const directoryCache = new Map();
  const expandedDirectories = new Set();
  const pendingDirectoryRequests = new Map();
  const pendingDirectoryPaths = new Set();
  const pendingFsRequests = new Map();

  let authenticated = false;
  let loggingOut = false;
  let config = {
    authRequired: true,
    title: 'WS Terminal',
    maxSessions: 8,
    maxFileBytes: 1048576
  };
  let tabCounter = 0;
  let groupCounter = 0;
  let terminalCounter = 0;
  let directoryRequestCounter = 0;
  let fsRequestCounter = 0;
  let focusedGroupId = null;
  let currentCwd = '/';
  let terminalFontSize = 14;
  let fileFontSize = 13;
  let treeFontSize = 14;
  let explorerWidth = 300;
  let explorerResize = null;
  let tabDrag = null;
  let contextEntry = null;
  let entryDialogState = null;
  let deleteDialogState = null;
  let fitFrame = 0;
  let showHidden = false;
  let treeRoot = '/';
  let bookmarkPaths = [];
  let restoringLayout = false;
  let restoredWorkspace = false;
  let externalCheckActive = false;
  let layoutSaveTimer = null;
  let searchTimer = null;
  let utilityCleanup = () => {};
  let draftsEnabled = false;
  let draftVault = '';
  let draftCache = new Map();
  let draftRefreshPromise = null;
  try { bookmarkPaths = JSON.parse(localStorage.getItem('ws-terminal-bookmarks') || '[]').filter(value => typeof value === 'string' && value.startsWith('/')); } catch {}

  function iconButton(name, label, action) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'icon-button'; button.title = label; button.setAttribute('aria-label', label);
    button.append(window.WorkbenchIcons(name));
    if (action) button.addEventListener('click', action);
    return button;
  }

  async function api(url, options = {}) {
    let response;
    try { response = await fetch(url, { cache: 'no-store', ...options }); }
    catch (error) { if (error.name === 'AbortError' || error.name === 'TimeoutError') throw error; throw Object.assign(new Error('网络连接失败'), { kind: 'network' }); }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) { authenticated = false; updateControls(); setStatus('pending', '登录已过期'); }
      throw Object.assign(new Error(result.error || `请求失败 (${response.status})`), { status: response.status });
    }
    return result;
  }

  function notifyError(error, retry = null) {
    const region = document.getElementById('notifications');
    const item = document.createElement('div'); item.className = 'notification';
    const text = document.createElement('span'); text.textContent = window.WorkbenchModel.errorText(error); item.append(text);
    if (retry) item.append(actionButton('重试', () => { item.remove(); return retry(); }));
    item.append(iconButton('close', '关闭通知', () => item.remove())); region.append(item);
    while (region.children.length > 3) region.firstElementChild.remove();
  }

  async function loadNodeIdentity() {
    const session = await api('/api/session');
    config = { ...config, ...session };
    const node = session.node;
    if (node) {
      const label = `${node.name} · ${node.ip || location.hostname} · ${node.user} · ${node.mode === 'host' ? '宿主机' : '容器'}`;
      const element = document.getElementById('nodeIdentity');
      element.textContent = label; element.title = label;
      document.title = `${node.name} | Web Terminal`;
    }
  }

  try {
    const savedFontSize = Number.parseInt(localStorage.getItem('ws-terminal-font-size'), 10);
    if (Number.isInteger(savedFontSize) && savedFontSize >= 10 && savedFontSize <= 24) {
      terminalFontSize = savedFontSize;
    }
  } catch {
    // Font size persistence is optional.
  }
  try {
    const savedFileFontSize = Number.parseInt(localStorage.getItem('ws-terminal-file-font-size'), 10);
    if (Number.isInteger(savedFileFontSize) && savedFileFontSize >= 10 && savedFileFontSize <= 28) {
      fileFontSize = savedFileFontSize;
    }
  } catch {
    // Font size persistence is optional.
  }
  try {
    const savedTreeFontSize = Number.parseInt(localStorage.getItem('ws-terminal-tree-font-size'), 10);
    if (Number.isInteger(savedTreeFontSize) && savedTreeFontSize >= 12 && savedTreeFontSize <= 22) {
      treeFontSize = savedTreeFontSize;
    }
    const savedExplorerWidth = Number.parseInt(localStorage.getItem('ws-terminal-explorer-width'), 10);
    if (Number.isInteger(savedExplorerWidth) && savedExplorerWidth >= 180 && savedExplorerWidth <= 640) {
      explorerWidth = savedExplorerWidth;
    }
  } catch {
    // Explorer preferences are optional.
  }

  function setStatus(state, text) {
    statusDot.classList.remove('ready', 'pending');
    if (state === 'ready') {
      statusDot.classList.add('ready');
    } else if (state === 'pending') {
      statusDot.classList.add('pending');
    }
    metaEl.textContent = text || '';
  }

  function explorerWidthLimits() {
    const available = workspaceEl.clientWidth || window.innerWidth;
    return {
      min: Math.min(180, Math.max(120, available - 220)),
      max: Math.max(180, Math.min(640, available - 280))
    };
  }

  function setExplorerWidth(value, persist = true) {
    const limits = explorerWidthLimits();
    explorerWidth = Math.max(limits.min, Math.min(limits.max, Math.round(value)));
    workspaceEl.style.setProperty('--explorer-width', `${explorerWidth}px`);
    explorerResizer.setAttribute('aria-valuemin', String(limits.min));
    explorerResizer.setAttribute('aria-valuemax', String(limits.max));
    explorerResizer.setAttribute('aria-valuenow', String(explorerWidth));
    if (persist) {
      try {
        localStorage.setItem('ws-terminal-explorer-width', String(explorerWidth));
      } catch {
        // Explorer width persistence is optional.
      }
    }
    scheduleFitAllVisibleTerminals();
  }

  function setExplorerHidden(hidden) {
    workspaceEl.classList.toggle('explorer-hidden', hidden);
    fileExplorerEl.setAttribute('aria-hidden', String(hidden));
    sidebarToggleButton.setAttribute('aria-expanded', String(!hidden));
    sidebarToggleButton.title = hidden ? '显示目录' : '隐藏目录';
    sidebarToggleButton.setAttribute('aria-label', sidebarToggleButton.title);
    scheduleFitAllVisibleTerminals();
  }

  function normalizePath(value) {
    if (typeof value !== 'string' || !value.startsWith('/')) {
      return '';
    }
    const segments = [];
    for (const segment of value.split('/')) {
      if (!segment || segment === '.') {
        continue;
      }
      if (segment === '..') {
        segments.pop();
      } else {
        segments.push(segment);
      }
    }
    return `/${segments.join('/')}`;
  }

  function basename(value) {
    const normalized = normalizePath(value);
    if (!normalized || normalized === '/') {
      return '/';
    }
    return normalized.slice(normalized.lastIndexOf('/') + 1);
  }

  function dirname(value) {
    const normalized = normalizePath(value);
    if (!normalized || normalized === '/') {
      return '/';
    }
    const index = normalized.lastIndexOf('/');
    return index <= 0 ? '/' : normalized.slice(0, index);
  }

  function terminalTabs() {
    return [...tabs.values()].filter((tab) => tab.type === 'terminal');
  }

  function groupTabs(group) {
    return [...tabs.values()].filter((tab) => tab.groupId === group.id);
  }

  function focusedGroup() {
    return focusedGroupId ? groups.get(focusedGroupId) : null;
  }

  function activeTabInGroup(group) {
    return group && group.activeTabId ? tabs.get(group.activeTabId) : null;
  }

  function focusedTab() {
    return activeTabInGroup(focusedGroup());
  }

  function focusedTerminal() {
    const tab = focusedTab();
    return tab && tab.type === 'terminal' ? tab : null;
  }

  function updateControls() {
    const terminal = focusedTerminal();
    const needsLogin = config.authRequired && !authenticated;
    tokenInput.hidden = !needsLogin;
    tokenInput.disabled = !needsLogin;
    connectButton.hidden = authenticated && (!terminal || terminal.socket);
    connectButton.disabled = false;
    connectButton.textContent = needsLogin ? '登录' : '重新连接';
    disconnectButton.disabled = !terminal || !terminal.socket;
    logoutButton.hidden = !config.authRequired || !authenticated;
    logoutButton.disabled = loggingOut;
    const canManageFiles = Boolean(authenticated && currentCwd);
    createFileButton.disabled = !canManageFiles;
    createDirectoryButton.disabled = !canManageFiles;
    refreshTreeButton.disabled = !canManageFiles;
    for (const id of ['uploadButton', 'sessionsButton', 'auditButton', 'draftsButton']) document.getElementById(id).disabled = !authenticated;
    const terminalLimitReached = terminalTabs().length >= config.maxSessions;
    for (const group of groups.values()) {
      group.newTerminalButton.disabled = !authenticated || terminalLimitReached;
      group.placeholder.textContent = authenticated ? '暂无打开的内容' : '未登录';
      group.placeholder.hidden = groupTabs(group).length > 0;
    }
  }

  function createGroup(attach = true) {
    const id = `group-${++groupCounter}`;
    const element = document.createElement('section');
    element.className = 'split-group';
    element.dataset.groupId = id;
    const strip = document.createElement('div');
    strip.className = 'tab-strip';
    const tabsElement = document.createElement('div');
    tabsElement.className = 'tabs';
    tabsElement.setAttribute('role', 'tablist');
    tabsElement.setAttribute('aria-label', '已打开的终端和文件');
    const newTerminalButton = document.createElement('button');
    newTerminalButton.type = 'button';
    newTerminalButton.className = 'new-terminal-button';
    newTerminalButton.textContent = '+';
    newTerminalButton.title = '新建终端';
    newTerminalButton.setAttribute('aria-label', '新建终端');
    if (groups.size === 0) {
      newTerminalButton.id = 'newTerminalButton';
    }
    strip.append(tabsElement, newTerminalButton);
    const content = document.createElement('div');
    content.className = 'group-content';
    const panes = document.createElement('div');
    panes.className = 'panes';
    const placeholder = document.createElement('div');
    placeholder.className = 'group-placeholder';
    placeholder.textContent = '未登录';
    panes.append(placeholder);
    const dropLayer = document.createElement('div');
    dropLayer.className = 'drop-layer';
    dropLayer.hidden = true;
    const dropPreview = document.createElement('div');
    dropPreview.className = 'drop-preview';
    dropLayer.append(dropPreview);
    content.append(panes, dropLayer);
    element.append(strip, content);
    const group = {
      id,
      element,
      content,
      tabsElement,
      panes,
      placeholder,
      dropLayer,
      dropPreview,
      newTerminalButton,
      activeTabId: null
    };
    groups.set(id, group);
    newTerminalButton.addEventListener('click', () => createTerminal(group));
    element.addEventListener('pointerdown', () => focusGroup(group));
    if (attach) {
      layoutRoot.append(element);
    }
    updateControls();
    return group;
  }

  function focusGroup(group) {
    if (!group || !groups.has(group.id)) {
      return;
    }
    focusedGroupId = group.id;
    for (const candidate of groups.values()) {
      candidate.element.classList.toggle('focused', candidate.id === group.id);
    }
    const tab = activeTabInGroup(group);
    if (!tab) {
      setStatus(authenticated ? 'pending' : 'offline', authenticated ? '未启动 Terminal' : '需要访问令牌');
    } else if (tab.type === 'terminal') {
      if (tab.connected) {
        setStatus('ready', `${tab.shell || 'shell'} · ${tab.cwd || ''}`);
      } else if (tab.socket) {
        setStatus('pending', 'Terminal 连接中');
      } else {
        setStatus('offline', 'Terminal 已断开');
      }
    } else {
      setStatus(tab.error ? 'offline' : 'ready', `文本文件 · ${tab.path}`);
    }
    updateControls();
  }

  function activateTab(tabId) {
    const tab = tabs.get(tabId);
    const group = tab ? groups.get(tab.groupId) : null;
    if (!tab || !group) {
      return;
    }
    group.activeTabId = tabId;
    for (const candidate of groupTabs(group)) {
      const active = candidate.id === tabId;
      candidate.tabEl.classList.toggle('active', active);
      candidate.selectEl.setAttribute('aria-selected', String(active));
      candidate.pane.classList.toggle('active', active);
    }
    group.placeholder.hidden = true;
    focusGroup(group);
    if (tab.type === 'terminal') {
      requestAnimationFrame(() => {
        fitTerminal(tab);
        tab.term.focus();
      });
    } else {
      requestAnimationFrame(() => tab.editor.focus());
    }
  }

  function refreshGroup(group) {
    const candidates = groupTabs(group);
    if (!candidates.length) {
      group.activeTabId = null;
      group.placeholder.hidden = false;
      return;
    }
    if (!candidates.some((tab) => tab.id === group.activeTabId)) {
      group.activeTabId = candidates[0].id;
    }
    for (const candidate of candidates) {
      const active = candidate.id === group.activeTabId;
      candidate.tabEl.classList.toggle('active', active);
      candidate.selectEl.setAttribute('aria-selected', String(active));
      candidate.pane.classList.toggle('active', active);
    }
    group.placeholder.hidden = true;
  }

  function clearTabDragPreview() {
    for (const group of groups.values()) {
      group.dropLayer.hidden = true;
      group.dropLayer.classList.remove('visible', 'tabs-target');
      delete group.dropPreview.dataset.side;
    }
  }

  function dropSideForPoint(group, clientX, clientY) {
    const rect = group.content.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    const distances = [
      ['left', Math.max(0, clientX - rect.left) / rect.width],
      ['right', Math.max(0, rect.right - clientX) / rect.width],
      ['top', Math.max(0, clientY - rect.top) / rect.height],
      ['bottom', Math.max(0, rect.bottom - clientY) / rect.height]
    ];
    distances.sort((a, b) => a[1] - b[1]);
    return distances[0][0];
  }

  function updateTabDrag(event) {
    if (!tabDrag || event.pointerId !== tabDrag.pointerId) {
      return;
    }
    if (!tabDrag.active && Math.hypot(event.clientX - tabDrag.startX, event.clientY - tabDrag.startY) < 6) {
      return;
    }
    if (!tabDrag.active) {
      tabDrag.active = true;
      tabDrag.item.classList.add('dragging');
      document.body.classList.add('tab-dragging');
    }
    event.preventDefault();
    clearTabDragPreview();
    tabDrag.targetGroup = null;
    tabDrag.side = null;
    tabDrag.moveOnly = false;
    const hit = document.elementFromPoint(event.clientX, event.clientY);
    const groupElement = hit?.closest('.split-group');
    const group = groupElement ? groups.get(groupElement.dataset.groupId) : null;
    if (!group) {
      return;
    }
    const source = groups.get(tabs.get(tabDrag.tabId)?.groupId);
    if (hit.closest('.tab-strip')) {
      tabDrag.targetGroup = group;
      tabDrag.moveOnly = true;
      group.dropLayer.hidden = false;
      group.dropLayer.classList.add('visible', 'tabs-target');
      return;
    }
    if (source === group && groupTabs(group).length < 2) {
      return;
    }
    tabDrag.targetGroup = group;
    tabDrag.side = dropSideForPoint(group, event.clientX, event.clientY);
    if (!tabDrag.side) {
      return;
    }
    group.dropPreview.dataset.side = tabDrag.side;
    group.dropLayer.hidden = false;
    group.dropLayer.classList.add('visible');
  }

  function finishTabDrag(event) {
    if (!tabDrag || event.pointerId !== tabDrag.pointerId) {
      return;
    }
    const completedDrag = tabDrag;
    tabDrag = null;
    window.removeEventListener('pointermove', updateTabDrag);
    window.removeEventListener('pointerup', finishTabDrag);
    window.removeEventListener('pointercancel', cancelTabDrag);
    completedDrag.item.classList.remove('dragging');
    document.body.classList.remove('tab-dragging');
    clearTabDragPreview();
    if (!completedDrag.active || !completedDrag.targetGroup) {
      return;
    }
    if (completedDrag.moveOnly) {
      moveTabToGroup(completedDrag.tabId, completedDrag.targetGroup);
    } else if (completedDrag.side) {
      splitGroup(completedDrag.targetGroup, completedDrag.side, completedDrag.tabId);
    }
  }

  function cancelTabDrag(event) {
    if (!tabDrag || (event && event.pointerId !== tabDrag.pointerId)) {
      return;
    }
    const cancelledDrag = tabDrag;
    tabDrag = null;
    window.removeEventListener('pointermove', updateTabDrag);
    window.removeEventListener('pointerup', finishTabDrag);
    window.removeEventListener('pointercancel', cancelTabDrag);
    cancelledDrag.item.classList.remove('dragging');
    document.body.classList.remove('tab-dragging');
    clearTabDragPreview();
  }

  function beginTabDrag(event, tab, item) {
    if (event.button !== 0 || tabDrag) {
      return;
    }
    activateTab(tab.id);
    tabDrag = {
      tabId: tab.id,
      item,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      targetGroup: null,
      side: null,
      moveOnly: false
    };
    window.addEventListener('pointermove', updateTabDrag, { passive: false });
    window.addEventListener('pointerup', finishTabDrag);
    window.addEventListener('pointercancel', cancelTabDrag);
  }

  function makeTabChrome(tab) {
    const group = groups.get(tab.groupId);
    const item = document.createElement('div');
    item.className = 'tab-item';
    item.dataset.tabId = tab.id;
    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'tab-select';
    select.textContent = tab.title;
    select.title = tab.type === 'file' ? tab.path : tab.title;
    select.setAttribute('role', 'tab');
    select.setAttribute('aria-selected', 'false');
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tab-close';
    close.textContent = '×';
    close.title = `关闭 ${tab.title}`;
    close.setAttribute('aria-label', `关闭 ${tab.title}`);
    select.addEventListener('click', () => activateTab(tab.id));
    select.addEventListener('pointerdown', (event) => beginTabDrag(event, tab, item));
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      closeTab(tab.id);
    });
    item.append(select, close);
    group.tabsElement.append(item);
    tab.tabEl = item;
    tab.selectEl = select;
  }

  function firstGroupIn(element) {
    if (!element) {
      return null;
    }
    if (element.classList?.contains('split-group')) {
      return groups.get(element.dataset.groupId) || null;
    }
    return firstGroupIn(element.querySelector('.split-group'));
  }

  function collapseEmptyGroup(group) {
    if (!group || groupTabs(group).length || groups.size <= 1) {
      return;
    }
    const split = group.element.parentElement;
    if (!split?.classList.contains('split-layout')) {
      return;
    }
    const sibling = [...split.children].find((child) => child !== group.element && !child.classList.contains('split-divider'));
    const parent = split.parentElement;
    parent.replaceChild(sibling, split);
    groups.delete(group.id);
    if (focusedGroupId === group.id) {
      const replacement = firstGroupIn(sibling);
      if (replacement) {
        focusGroup(replacement);
      }
    }
  }

  function moveTabToGroup(tabId, destination, collapseSource = true) {
    const tab = tabs.get(tabId);
    const source = tab ? groups.get(tab.groupId) : null;
    if (!tab || !source || !destination) {
      return;
    }
    if (source.id === destination.id) {
      activateTab(tab.id);
      return;
    }
    tab.groupId = destination.id;
    destination.tabsElement.append(tab.tabEl);
    destination.panes.append(tab.pane);
    if (source.activeTabId === tab.id) {
      source.activeTabId = null;
    }
    refreshGroup(source);
    refreshGroup(destination);
    activateTab(tab.id);
    if (collapseSource) {
      collapseEmptyGroup(source);
    }
    scheduleFitAllVisibleTerminals();
    scheduleWorkspaceSave();
  }

  function setSplitRatio(split, ratio) {
    const horizontal = split.classList.contains('horizontal');
    const rect = split.getBoundingClientRect();
    const available = Math.max(1, (horizontal ? rect.width : rect.height) - 6);
    const minimumPixels = horizontal ? 180 : 120;
    const minimumRatio = Math.min(0.4, minimumPixels / available);
    const nextRatio = Math.max(minimumRatio, Math.min(1 - minimumRatio, ratio));
    split.dataset.ratio = String(nextRatio);
    if (horizontal) {
      split.style.gridTemplateColumns = `${nextRatio}fr 6px ${1 - nextRatio}fr`;
    } else {
      split.style.gridTemplateRows = `${nextRatio}fr 6px ${1 - nextRatio}fr`;
    }
    const divider = split.querySelector(':scope > .split-divider');
    if (divider) {
      divider.setAttribute('aria-valuenow', String(Math.round(nextRatio * 100)));
    }
    scheduleFitAllVisibleTerminals();
    scheduleWorkspaceSave();
  }

  function createSplitDivider(split, horizontal) {
    const divider = document.createElement('div');
    divider.className = 'split-divider';
    divider.tabIndex = 0;
    divider.setAttribute('role', 'separator');
    divider.setAttribute('aria-orientation', horizontal ? 'vertical' : 'horizontal');
    divider.setAttribute('aria-label', '调整分屏大小');
    divider.setAttribute('aria-valuemin', '10');
    divider.setAttribute('aria-valuemax', '90');
    divider.setAttribute('aria-valuenow', '50');
    let resizing = false;
    const updateFromPointer = (event) => {
      if (!resizing) {
        return;
      }
      const rect = split.getBoundingClientRect();
      const available = Math.max(1, (horizontal ? rect.width : rect.height) - 6);
      const offset = horizontal ? event.clientX - rect.left : event.clientY - rect.top;
      setSplitRatio(split, (offset - 3) / available);
    };
    divider.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      resizing = true;
      divider.dataset.pointerIdNumber = String(event.pointerId);
      divider.setPointerCapture(event.pointerId);
      divider.classList.add('resizing');
      document.body.classList.add(horizontal ? 'resizing-columns' : 'resizing-rows');
    });
    divider.addEventListener('pointermove', updateFromPointer);
    divider.addEventListener('pointerup', () => {
      resizing = false;
      divider.classList.remove('resizing');
      document.body.classList.remove(horizontal ? 'resizing-columns' : 'resizing-rows');
    });
    divider.addEventListener('pointercancel', () => {
      resizing = false;
      divider.classList.remove('resizing');
      document.body.classList.remove(horizontal ? 'resizing-columns' : 'resizing-rows');
    });
    divider.addEventListener('dblclick', () => setSplitRatio(split, 0.5));
    divider.addEventListener('keydown', (event) => {
      const backwards = horizontal ? event.key === 'ArrowLeft' : event.key === 'ArrowUp';
      const forwards = horizontal ? event.key === 'ArrowRight' : event.key === 'ArrowDown';
      if (!backwards && !forwards) {
        return;
      }
      event.preventDefault();
      const current = Number.parseFloat(split.dataset.ratio || '0.5');
      setSplitRatio(split, current + (backwards ? -0.05 : 0.05));
    });
    return divider;
  }

  function splitGroup(target, side, tabId) {
    const tab = tabs.get(tabId);
    if (!tab || !target || !target.element.parentElement) {
      return;
    }
    const source = groups.get(tab.groupId);
    const parent = target.element.parentElement;
    const split = document.createElement('div');
    const horizontal = side === 'left' || side === 'right';
    split.className = `split-layout ${horizontal ? 'horizontal' : 'vertical'}`;
    split.dataset.ratio = '0.5';
    const divider = createSplitDivider(split, horizontal);
    const destination = createGroup(false);
    parent.replaceChild(split, target.element);
    if (side === 'left' || side === 'top') {
      split.append(destination.element, divider, target.element);
    } else {
      split.append(target.element, divider, destination.element);
    }
    moveTabToGroup(tab.id, destination, false);
    if (source !== target) {
      collapseEmptyGroup(source);
    }
    setSplitRatio(split, 0.5);
  }

  function closeTab(tabId, force = false) {
    const tab = tabs.get(tabId);
    if (!tab) {
      return false;
    }
    if (!force && tab.type === 'file' && (tab.dirty || tab.saving)) {
      if (!tab.closePending) confirmFileClose(tab);
      return false;
    }
    const group = groups.get(tab.groupId);
    tabs.delete(tab.id);
    tab.tabEl.remove();
    tab.pane.remove();
    if (tab.type === 'terminal') {
      tab.closed = true;
      clearTimeout(tab.reconnectTimer);
      if (tab.sessionId && !tab.processExited) api(`/api/terminals?id=${encodeURIComponent(tab.sessionId)}`, { method: 'DELETE' }).catch(() => {});
      tab.resizeObserver.disconnect();
      if (!tab.processExited && tab.socket && tab.socket.readyState < WebSocket.CLOSING) {
        const socket = tab.socket;
        if (socket.readyState === WebSocket.OPEN) {
          try {
            socket.send(JSON.stringify({ type: 'close' }));
          } catch {
            socket.close(1000, 'terminal tab closed');
          }
          setTimeout(() => {
            if (socket.readyState < WebSocket.CLOSING) {
              socket.close(1000, 'terminal tab closed');
            }
          }, 500);
        } else if (socket.readyState === WebSocket.CONNECTING) {
          // The open handler sends the explicit close as soon as the handshake completes.
        }
      }
      tab.term.dispose();
    } else {
      clearTimeout(tab.draftTimer);
      tab.editor.destroy?.();
      for (const [requestId, request] of pendingFsRequests) {
        if (request.tabId === tab.id) {
          clearTimeout(request.timeout);
          pendingFsRequests.delete(requestId);
        }
      }
    }
    if (group.activeTabId === tab.id) {
      group.activeTabId = null;
    }
    refreshGroup(group);
    collapseEmptyGroup(group);
    if (groups.has(group.id)) {
      focusGroup(group);
    }
    updateControls();
    scheduleWorkspaceSave();
    return true;
  }

  function createTerminalInstance() {
    const fitAddon = new FitAddonCtor();
    const term = new window.Terminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: terminalFontSize,
      letterSpacing: 0,
      lineHeight: 1.15,
      scrollback: 8000,
      tabStopWidth: 4,
      theme: {
        background: '#101216', foreground: '#e7edf4', cursor: '#63d7aa', selectionBackground: '#334155',
        black: '#0f172a', red: '#fb7185', green: '#6ee7b7', yellow: '#facc15', blue: '#93c5fd',
        magenta: '#c4b5fd', cyan: '#67e8f9', white: '#e5e7eb', brightBlack: '#64748b',
        brightRed: '#fda4af', brightGreen: '#86efac', brightYellow: '#fde68a', brightBlue: '#bfdbfe',
        brightMagenta: '#ddd6fe', brightCyan: '#a5f3fc', brightWhite: '#f8fafc'
      }
    });
    term.loadAddon(fitAddon);
    return { term, fitAddon };
  }

  function tabIsVisible(tab) {
    const group = groups.get(tab.groupId);
    return Boolean(group && group.activeTabId === tab.id && tab.pane.classList.contains('active'));
  }

  function fitTerminal(terminal) {
    if (!terminal || terminal.type !== 'terminal' || !tabIsVisible(terminal)) {
      return;
    }
    try {
      terminal.fitAddon.fit();
      if (terminal.socket && terminal.connected && terminal.socket.readyState === WebSocket.OPEN) {
        terminal.socket.send(JSON.stringify({ type: 'resize', cols: terminal.term.cols, rows: terminal.term.rows }));
      }
    } catch {
      // A split or tab can be between layout states for one animation frame.
    }
  }

  function fitAllVisibleTerminals() {
    for (const terminal of terminalTabs()) {
      fitTerminal(terminal);
    }
  }

  function scheduleFitAllVisibleTerminals() {
    if (fitFrame) {
      cancelAnimationFrame(fitFrame);
    }
    fitFrame = requestAnimationFrame(() => {
      fitFrame = 0;
      fitAllVisibleTerminals();
    });
  }

  function setTerminalFontSize(value) {
    terminalFontSize = Math.max(10, Math.min(24, value));
    fontSizeValue.textContent = String(terminalFontSize);
    decreaseFontButton.disabled = terminalFontSize <= 10;
    increaseFontButton.disabled = terminalFontSize >= 24;
    for (const terminal of terminalTabs()) {
      terminal.term.options.fontSize = terminalFontSize;
    }
    try {
      localStorage.setItem('ws-terminal-font-size', String(terminalFontSize));
    } catch {
      // Font size persistence is optional.
    }
    scheduleFitAllVisibleTerminals();
  }

  function setFileFontSize(value) {
    fileFontSize = Math.max(10, Math.min(28, value));
    for (const tab of tabs.values()) {
      if (tab.type === 'file') {
        tab.editor.style.fontSize = `${fileFontSize}px`;
      }
    }
    try {
      localStorage.setItem('ws-terminal-file-font-size', String(fileFontSize));
    } catch {
      // Font size persistence is optional.
    }
  }

  function setTreeFontSize(value) {
    treeFontSize = Math.max(12, Math.min(22, value));
    directoryTreeEl.style.setProperty('--tree-font-size', `${treeFontSize}px`);
    try {
      localStorage.setItem('ws-terminal-tree-font-size', String(treeFontSize));
    } catch {
      // Tree font size persistence is optional.
    }
  }

  async function copyText(text) {
    if (!text) {
      return false;
    }
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // Fall back to the legacy user-gesture copy path.
      }
    }
    const previousFocus = document.activeElement;
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.setAttribute('readonly', '');
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    helper.style.pointerEvents = 'none';
    document.body.append(helper);
    helper.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    helper.remove();
    previousFocus?.focus?.();
    return copied;
  }

  function terminalUrl(term, terminal) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = new URL(`${protocol}//${window.location.host}/ws/terminal`);
    url.searchParams.set('cols', String(term.cols || 100));
    url.searchParams.set('rows', String(term.rows || 30));
    if (terminal.sessionId) { url.searchParams.set('session', terminal.sessionId); url.searchParams.set('after', String(terminal.lastSequence || 0)); }
    return url.toString();
  }

  function createTerminal(group = focusedGroup(), resume = null) {
    if (!authenticated || terminalTabs().length >= config.maxSessions) {
      if (!authenticated) {
        tokenInput.focus();
      }
      return null;
    }
    group = group || groups.values().next().value || createGroup();
    const { term, fitAddon } = createTerminalInstance();
    const id = `tab-${++tabCounter}`;
    const number = ++terminalCounter;
    const pane = document.createElement('section');
    pane.className = 'workbench-pane terminal-pane';
    pane.setAttribute('role', 'tabpanel');
    const host = document.createElement('div');
    host.className = 'terminal-host';
    pane.append(host);
    group.panes.append(pane);
    const terminal = {
      id, groupId: group.id, type: 'terminal', title: `Terminal ${number}`, pane, host, term, fitAddon,
      socket: null, connected: false, closed: false, processExited: false, cwd: '', shell: '', tabEl: null, selectEl: null,
      resizeObserver: null, sessionId: resume?.id || null, lastSequence: 0, reconnectTimer: null, reconnectStartedAt: null, reconnectAttempts: 0
    };
    tabs.set(id, terminal);
    makeTabChrome(terminal);
    term.open(host);
    term.attachCustomKeyEventHandler((event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && term.hasSelection()) {
        copyText(term.getSelection());
        return false;
      }
      return true;
    });
    host.addEventListener('paste', event => {
      event.preventDefault(); event.stopImmediatePropagation();
      approvePaste(terminal, event.clipboardData?.getData('text/plain') || '').catch(notifyError);
    }, { capture: true });
    host.addEventListener('pointerup', (event) => {
      if (event.button === 0 && term.hasSelection()) {
        copyText(term.getSelection());
      }
    });
    host.addEventListener('contextmenu', async (event) => {
      term.focus();
      if (!window.isSecureContext || !navigator.clipboard?.readText) {
        return;
      }
      event.preventDefault();
      try {
        const text = await navigator.clipboard.readText();
        if (text && terminal.socket?.readyState === WebSocket.OPEN && terminal.connected) {
          await approvePaste(terminal, text);
        }
      } catch {
        notifyError(new Error('无法读取剪贴板，请使用键盘或浏览器原生菜单粘贴'));
      }
    });
    host.addEventListener('wheel', (event) => {
      if (!event.ctrlKey) {
        return;
      }
      event.preventDefault();
      setTerminalFontSize(terminalFontSize + (event.deltaY < 0 ? 1 : -1));
    }, { passive: false });
    terminal.resizeObserver = new ResizeObserver(() => fitTerminal(terminal));
    terminal.resizeObserver.observe(host);
    term.onData((data) => {
      if (terminal.socket && terminal.connected && terminal.socket.readyState === WebSocket.OPEN) {
        terminal.socket.send(JSON.stringify({ type: 'input', data }));
      }
    });
    activateTab(terminal.id);
    openTerminalSocket(terminal);
    return terminal;
  }

  function openTerminalSocket(terminal) {
    if (!terminal || terminal.closed || terminal.socket) {
      return;
    }
    fitTerminal(terminal);
    clearTimeout(terminal.reconnectTimer);
    terminal.socket = new WebSocket(terminalUrl(terminal.term, terminal));
    if (focusedTab()?.id === terminal.id) {
      setStatus('pending', 'Terminal 连接中');
    }
    updateControls();
    terminal.socket.addEventListener('open', () => {
      if (terminal.closed) {
        try {
          terminal.socket.send(JSON.stringify({ type: 'close' }));
        } catch {
          terminal.socket.close(1000, 'terminal tab closed');
        }
        return;
      }
      terminal.connected = true;
      if (focusedTab()?.id === terminal.id) {
        setStatus('ready', 'Terminal 已连接');
      }
      updateControls();
      requestAnimationFrame(() => fitTerminal(terminal));
    });
    terminal.socket.addEventListener('message', (event) => handleTerminalMessage(terminal, event));
    terminal.socket.addEventListener('close', async (event) => {
      terminal.connected = false;
      terminal.socket = null;
      terminal.processExited = terminal.processExited || event.reason === 'process exited';
      if (terminal.closed) {
        return;
      }
      if (terminal.processExited) {
        closeTab(terminal.id, true);
        return;
      }
      if (event.reason === 'closed by session manager' || event.reason === 'terminal session expired' || event.reason === 'session attached elsewhere' || event.reason === 'idle timeout' || event.reason === 'maximum duration') {
        closeTab(terminal.id, true); return;
      }
      if (terminal.sessionId && authenticated && !loggingOut) {
        scheduleReconnect(terminal); return;
      }
      if (config.authRequired && !loggingOut) {
        try {
          authenticated = (await fetch('/api/session', { cache: 'no-store' })).ok;
        } catch {
          authenticated = false;
        }
      }
      if (focusedTab()?.id === terminal.id) {
        setStatus(authenticated ? 'offline' : 'pending', authenticated ? 'Terminal 已断开' : '需要访问令牌');
      }
      updateControls();
    });
    terminal.socket.addEventListener('error', () => {
      if (focusedTab()?.id === terminal.id) {
        setStatus('offline', 'Terminal 连接错误');
      }
    });
  }

  function handleTerminalMessage(terminal, event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === 'output') {
      if (message.sequence <= terminal.lastSequence) return;
      terminal.term.write(message.data || '', () => {
        terminal.lastSequence = message.sequence;
        if (terminal.socket?.readyState === WebSocket.OPEN && Number.isSafeInteger(message.sequence)) {
          terminal.socket.send(JSON.stringify({ type: 'ack', sequence: message.sequence }));
        }
      });
      return;
    }
    if (message.type === 'system') {
      terminal.term.write(message.data || '');
      return;
    }
    if (message.type === 'ready') {
      terminal.sessionId = message.id;
      terminal.reconnectStartedAt = null;
      terminal.reconnectAttempts = 0;
      terminal.shell = message.shell || '';
      terminal.cwd = normalizePath(message.cwd);
      if (focusedTab()?.id === terminal.id) {
        setStatus('ready', `${terminal.shell || 'shell'} · ${terminal.cwd}`);
      }
      return;
    }
    if (message.type === 'cwd') {
      terminal.cwd = normalizePath(message.path);
      if (focusedTab()?.id === terminal.id) {
        setStatus('ready', `${terminal.shell || 'shell'} · ${terminal.cwd}`);
      }
      return;
    }
    if (message.type === 'fs:list') {
      receiveDirectoryListing(message, terminal.id);
      return;
    }
    if (message.type === 'fs:file') {
      receiveFile(message, terminal.id);
      return;
    }
    if (message.type === 'fs:saved') {
      receiveSavedFile(message, terminal.id);
      return;
    }
    if (message.type === 'fs:mutated') {
      receiveMutation(message, terminal.id);
      return;
    }
    if (message.type === 'fs:error') {
      if (!receiveDirectoryError(message, terminal.id)) {
        receiveFsError(message, terminal.id);
      }
      return;
    }
    if (message.type === 'exit') {
      terminal.processExited = true;
      queueMicrotask(() => closeTab(terminal.id, true));
    }
  }

  function scheduleReconnect(terminal) {
    if (terminal.closed || loggingOut || !authenticated) return;
    terminal.reconnectStartedAt ||= Date.now();
    if (Date.now() - terminal.reconnectStartedAt > (config.reconnectGraceSeconds || 300) * 1000) {
      terminal.processExited = true; closeTab(terminal.id, true); setStatus('offline', '终端恢复期限已过'); return;
    }
    if (focusedTab()?.id === terminal.id) setStatus('pending', '连接中断，正在恢复终端');
    const delay = Math.min(10000, 500 * (2 ** Math.min(terminal.reconnectAttempts++, 5)));
    terminal.reconnectTimer = setTimeout(async () => {
      try {
        const result = await api('/api/terminals');
        if (!result.sessions.some(session => session.id === terminal.sessionId)) {
          terminal.processExited = true; closeTab(terminal.id, true); setStatus('offline', '原终端已结束'); return;
        }
        openTerminalSocket(terminal);
      } catch (error) {
        if (error.status === 401) { authenticated = false; updateControls(); setStatus('pending', '登录已过期'); }
        else scheduleReconnect(terminal);
      }
    }, delay);
  }

  function clearPendingDirectoryRequests(terminalId = null) {
    for (const [requestId, request] of pendingDirectoryRequests) {
      if (terminalId && request.terminalId !== terminalId) {
        continue;
      }
      clearTimeout(request.timeout);
      pendingDirectoryRequests.delete(requestId);
      pendingDirectoryPaths.delete(request.path);
    }
  }

  function clearPendingFsRequests(terminalId = null) {
    for (const [requestId, request] of pendingFsRequests) {
      if (terminalId && request.terminalId !== terminalId) {
        continue;
      }
      clearTimeout(request.timeout);
      pendingFsRequests.delete(requestId);
      const fileTab = tabs.get(request.tabId);
      if (fileTab?.type === 'file') {
        fileTab.loading = false;
        fileTab.saving = false;
        fileTab.error = '文件连接已断开';
        renderFile(fileTab);
      }
    }
  }

  function loadDirectory(value, force = false, append = false) {
    const directoryPath = normalizePath(value);
    if (!authenticated || !directoryPath || (!force && pendingDirectoryPaths.has(directoryPath)) || (!force && !append && directoryCache.has(directoryPath))) {
      return;
    }
    if (force) for (const [id, pending] of pendingDirectoryRequests) {
      if (pending.path !== directoryPath) continue;
      clearTimeout(pending.timeout); pending.controller?.abort(); pendingDirectoryRequests.delete(id); pendingDirectoryPaths.delete(directoryPath);
    }
    const previous = directoryCache.get(directoryPath);
    const query = document.getElementById('treeSearchMode').value === 'remote' && directoryPath === currentCwd ? treeFilter.value.trim() : '';
    if (append && (!previous?.truncated || previous.query !== query)) return;
    if (force) directoryCache.delete(directoryPath);
    const requestId = `dir-${++directoryRequestCounter}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
      pendingDirectoryRequests.delete(requestId);
      pendingDirectoryPaths.delete(directoryPath);
      directoryCache.set(directoryPath, { entries: previous?.entries || [], error: '目录读取超时，可以刷新重试', truncated: false });
      renderDirectoryTree();
    }, 8000);
    pendingDirectoryRequests.set(requestId, { path: directoryPath, terminalId: 'filesystem', timeout, controller, append, previous });
    pendingDirectoryPaths.add(directoryPath);
    const params = new URLSearchParams({ path: directoryPath, hidden: showHidden ? '1' : '0', query,
      offset: String(append ? previous.nextOffset : 0), revision: append ? previous.revision : '' });
    api(`/api/filesystem/list?${params}`, { signal: controller.signal }).then(payload => {
      receiveDirectoryListing({ requestId, ...payload }, 'filesystem');
    }).catch((error) => {
      receiveDirectoryError({ requestId, error: window.WorkbenchModel.errorText(error) }, 'filesystem');
    });
  }

  function initializeFilesystemTree() {
    currentCwd = '/';
    treeRoot = '/';
    pathInput.value = '/';
    cwdPathEl.textContent = '/';
    cwdPathEl.title = '/';
    expandedDirectories.add('/');
    loadDirectory('/', true);
    renderDirectoryTree();
    updateControls();
    loadNodeIdentity().then(async () => { await initializeDrafts().catch(notifyError); restoreWorkspace(); }).catch(notifyError);
  }

  function receiveDirectoryListing(message, terminalId) {
    const pending = pendingDirectoryRequests.get(message.requestId);
    if (!pending || pending.terminalId !== terminalId) {
      return;
    }
    clearTimeout(pending.timeout);
    pendingDirectoryRequests.delete(message.requestId);
    pendingDirectoryPaths.delete(pending.path);
    const directoryPath = normalizePath(message.path);
    if (!directoryPath || directoryPath !== pending.path || !Array.isArray(message.entries)) {
      return;
    }
    const entries = message.entries.filter((entry) => (
      entry && typeof entry.name === 'string' && (showHidden || !entry.name.startsWith('.')) &&
      typeof entry.path === 'string' && ['directory', 'file', 'symlink', 'other'].includes(entry.type)
    ));
    directoryCache.set(directoryPath, { entries: pending.append ? [...new Map([...pending.previous.entries, ...entries].map(entry => [entry.path, entry])).values()] : entries,
      error: '', truncated: Boolean(message.truncated), nextOffset: message.nextOffset, total: message.total, query: message.query || '', revision: message.revision });
    renderDirectoryTree();
  }

  function receiveDirectoryError(message, terminalId) {
    const pending = pendingDirectoryRequests.get(message.requestId);
    if (!pending || pending.terminalId !== terminalId) {
      return false;
    }
    clearTimeout(pending.timeout);
    pendingDirectoryRequests.delete(message.requestId);
    pendingDirectoryPaths.delete(pending.path);
    directoryCache.set(pending.path, {
      entries: pending.previous?.entries || [],
      error: typeof message.error === 'string' ? message.error : '无法读取目录',
      truncated: false
    });
    renderDirectoryTree();
    return true;
  }

  function fileIconKind(entry) {
    if (entry.type !== 'file') {
      return entry.type;
    }
    const extension = entry.name.toLowerCase().split('.').pop();
    if (['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'go', 'rs', 'java', 'c', 'cc', 'cpp', 'h', 'hpp', 'sh', 'bash', 'zsh', 'ps1'].includes(extension)) {
      return 'code';
    }
    if (['json', 'yaml', 'yml', 'toml', 'ini', 'conf', 'config', 'xml', 'service', 'env'].includes(extension)) {
      return 'config';
    }
    if (['md', 'txt', 'log', 'rst'].includes(extension)) {
      return 'text';
    }
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'].includes(extension)) {
      return 'image';
    }
    if (['zip', 'tar', 'tgz', 'gz', 'bz2', 'xz', '7z'].includes(extension)) {
      return 'archive';
    }
    return 'file';
  }

  function makeTreeNode(entry, depth) {
    const item = document.createElement('li');
    const row = document.createElement('div');
    const isDirectory = entry.type === 'directory';
    const isExpanded = isDirectory && expandedDirectories.has(entry.path);
    row.className = `tree-row ${entry.type}${isExpanded ? ' expanded' : ''}${entry.path === currentCwd ? ' current' : ''}`;
    row.style.setProperty('--tree-depth', String(depth));
    row.dataset.path = entry.path;
    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'tree-main';
    main.title = entry.path;
    main.setAttribute('role', 'treeitem');
    if (isDirectory) {
      main.setAttribute('aria-expanded', String(isExpanded));
    }
    const chevron = document.createElement('span');
    chevron.className = 'tree-chevron';
    if (isDirectory) chevron.append(window.WorkbenchIcons(isExpanded ? 'down' : 'right'));
    chevron.title = isDirectory ? (isExpanded ? '折叠目录' : '展开目录') : '';
    const icon = document.createElement('span');
    icon.className = `tree-icon ${fileIconKind(entry)}`;
    icon.append(window.WorkbenchIcons(fileIconKind(entry)));
    icon.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.className = 'tree-name';
    name.textContent = entry.name;
    main.append(chevron, icon, name);
    const size = document.createElement('span');
    size.className = 'tree-size';
    size.textContent = entry.type === 'directory'
      ? '目录'
      : entry.type === 'file'
        ? (Number.isFinite(entry.size) ? formatBytes(entry.size) : '—')
        : entry.type === 'symlink'
          ? '链接'
          : '特殊';
    size.title = entry.type === 'directory' ? '为避免递归扫描，不计算目录总大小' : size.textContent;
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'tree-action';
    action.append(window.WorkbenchIcons('more'));
    action.title = `${entry.name} 操作`;
    action.setAttribute('aria-label', `${entry.name} 操作`);
    row.append(main, size, action);
    item.append(row);
    main.addEventListener('click', () => {
      if (!isDirectory) {
        openFile(entry.path);
        return;
      }
      currentCwd = entry.path;
      pathInput.value = entry.path;
      cwdPathEl.textContent = entry.path;
      cwdPathEl.title = entry.path;
      if (expandedDirectories.has(entry.path)) {
        expandedDirectories.delete(entry.path);
      } else {
        expandedDirectories.add(entry.path);
        loadDirectory(entry.path);
      }
      renderDirectoryTree();
    });
    action.addEventListener('click', (event) => {
      event.stopPropagation();
      const bounds = action.getBoundingClientRect();
      showTreeContextMenu(entry, bounds.right, bounds.bottom);
    });
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      showTreeContextMenu(entry, event.clientX, event.clientY);
    });
    if (isExpanded) {
      const listing = directoryCache.get(entry.path);
      if (!listing) {
        const loading = document.createElement('div');
        loading.className = 'tree-message';
        loading.textContent = '读取中';
        item.append(loading);
      } else if (listing.error) {
        const error = document.createElement('div');
        error.className = 'tree-message';
        error.textContent = listing.error;
        item.append(error);
      } else {
        const children = document.createElement('ul');
        children.className = 'tree-list';
        children.setAttribute('role', 'group');
        const filter = document.getElementById('treeSearchMode').value === 'local' ? treeFilter.value.trim().toLowerCase() : '';
        for (const child of listing.entries.filter(child => !filter || child.name.toLowerCase().includes(filter) || expandedDirectories.has(child.path))) {
          children.append(makeTreeNode(child, depth + 1));
        }
        if (listing.truncated) {
          const limit = document.createElement('li');
          limit.className = 'tree-limit';
          limit.append(actionButton(`加载更多（${listing.entries.length} / ${listing.total}）`, () => loadDirectory(entry.path, false, true)));
          children.append(limit);
        }
        item.append(children);
      }
    }
    return item;
  }

  function renderDirectoryTree() {
    directoryTreeEl.replaceChildren();
    const tree = document.createElement('ul');
    tree.className = 'tree-list';
    tree.setAttribute('role', 'tree');
    tree.append(makeTreeNode({ name: treeRoot, path: treeRoot, type: 'directory' }, 0));
    directoryTreeEl.append(tree);
    const listing = directoryCache.get(currentCwd);
    document.getElementById('treeSummary').textContent = listing && !listing.error ? `已加载 ${listing.entries.length} / ${listing.total ?? listing.entries.length}${listing.query ? ' · 名称搜索结果' : ''}` : '';
  }

  function showTreeContextMenu(entry, x, y) {
    contextEntry = entry;
    for (const button of treeContextMenu.querySelectorAll('button')) {
      const action = button.dataset.action;
      button.hidden = (action.startsWith('create-') && entry.type !== 'directory') ||
        ((action === 'rename' || action === 'delete') && entry.path === '/') ||
        (action === 'download' && entry.type === 'directory') || ((action === 'bookmark' || action === 'size') && entry.type !== 'directory');
    }
    treeContextMenu.hidden = false;
    const width = treeContextMenu.offsetWidth;
    const height = treeContextMenu.offsetHeight;
    treeContextMenu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - width - 4))}px`;
    treeContextMenu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - height - 4))}px`;
  }

  function hideTreeContextMenu() {
    treeContextMenu.hidden = true;
    contextEntry = null;
  }

  function openUtility(title) {
    utilityCleanup(); utilityCleanup = () => {};
    document.getElementById('utilityTitle').textContent = title;
    utilityBody.replaceChildren(); utilityActions.replaceChildren();
    if (!utilityDialog.open) utilityDialog.showModal();
  }

  function choose(title, message, choices) {
    openUtility(title); utilityBody.textContent = message;
    return utilityChoice(choices);
  }

  function utilityChoice(choices) {
    return new Promise(resolve => {
      let settled = false;
      const onClose = () => { if (!utilityDialog.open) finish(null, false); };
      const finish = (value, close = true) => {
        if (settled) return;
        settled = true; utilityDialog.removeEventListener('close', onClose);
        if (close) utilityDialog.close();
        resolve(value);
      };
      utilityActions.append(...choices.map(choice => actionButton(choice.label, () => finish(choice.value), choice.danger ? 'danger-button' : '')));
      utilityDialog.addEventListener('close', onClose);
    });
  }

  async function approvePaste(terminal, text) {
    if (!text) return;
    if (terminal.closed || !terminal.connected) throw new Error('目标终端未连接，未发送粘贴内容');
    if (new TextEncoder().encode(text).length > (config.maxInputBytes || 65536)) throw new Error('粘贴内容超过终端单次输入限制');
    if (window.WorkbenchModel.needsPasteApproval(text)) {
      const originalSession = terminal.sessionId;
      openUtility('确认粘贴到终端');
      const target = document.createElement('p'); target.textContent = `${config.node?.name || location.hostname} · ${config.node?.user || ''} · ${terminal.cwd} · ${terminal.title}`;
      const preview = document.createElement('pre'); preview.className = 'paste-preview'; preview.textContent = window.WorkbenchModel.pastePreview(text);
      const count = document.createElement('p'); count.textContent = `${text.replace(/\r\n/g, '\n').split(/[\r\n]/).length} 行 · ${new TextEncoder().encode(text).length} 字节`;
      utilityBody.append(target, count, preview);
      const accepted = await utilityChoice([{ label: '取消', value: false }, { label: '确认粘贴', value: true }]);
      if (!accepted || terminal.sessionId !== originalSession) return;
    }
    if (terminal.closed || !terminal.connected || terminal.socket?.readyState !== WebSocket.OPEN) throw new Error('目标终端已断开，未发送粘贴内容');
    terminal.term.paste(text); terminal.term.focus();
  }

  async function confirmFileClose(tab) {
    tab.closePending = true;
    try {
      if (tab.saving) { notifyError(new Error('文件正在保存，请稍后关闭')); return; }
      const choice = await choose(`${tab.title} · 未保存的修改`, tab.path, [
        { label: '取消', value: 'cancel' }, { label: '放弃修改', value: 'discard', danger: true }, { label: '保存并关闭', value: 'save' }
      ]);
      if (!tabs.has(tab.id)) return;
      if (choice === 'save') { if (await saveFile(tab)) closeTab(tab.id, true); }
      if (choice === 'discard') { await removeDraft(tab.path); closeTab(tab.id, true); }
    } catch (error) { notifyError(error); }
    finally { tab.closePending = false; }
  }

  function draftHeaders() { return { 'X-Draft-Vault': draftVault, 'Content-Type': 'application/json' }; }

  async function initializeDrafts() {
    try {
      draftsEnabled = localStorage.getItem('ws-terminal-drafts-enabled') === '1';
      draftVault = localStorage.getItem('ws-terminal-draft-vault') || '';
      if (!/^[a-f0-9]{64}$/.test(draftVault)) {
        draftVault = [...crypto.getRandomValues(new Uint8Array(32))].map(value => value.toString(16).padStart(2, '0')).join('');
        localStorage.setItem('ws-terminal-draft-vault', draftVault);
      }
    } catch { draftsEnabled = false; }
    if (draftsEnabled) await refreshDrafts();
  }

  function refreshDrafts() {
    if (!draftVault) return Promise.resolve();
    if (!draftRefreshPromise) draftRefreshPromise = api('/api/drafts', { headers: draftHeaders() })
      .then(result => { draftCache = new Map(result.items.map(item => [item.path, item])); })
      .finally(() => { draftRefreshPromise = null; });
    return draftRefreshPromise;
  }

  function scheduleDraft(tab) {
    clearTimeout(tab.draftTimer);
    if (!draftsEnabled || !authenticated || !tab.version || !tab.dirty) return;
    tab.draftTimer = setTimeout(() => flushDraft(tab).catch(error => { tab.message = '草稿未备份：' + window.WorkbenchModel.errorText(error); renderFile(tab); }), 350);
  }

  async function flushDraft(tab) {
    clearTimeout(tab.draftTimer);
    if (!draftsEnabled || !authenticated || !tab.dirty || !tab.version) return;
    const payload = { path: tab.path, content: serializedContent(tab), baseVersion: tab.version };
    const pending = (tab.draftPending || Promise.resolve()).catch(() => {}).then(() => api('/api/drafts', {
      method: 'PUT', headers: draftHeaders(), body: JSON.stringify(payload), keepalive: new TextEncoder().encode(payload.content).length < 24000
    }));
    tab.draftPending = pending;
    const result = await pending;
    draftCache.set(tab.path, { ...payload, ...result });
    if (tabs.has(tab.id) && tab.dirty && serializedContent(tab) === payload.content) {
      tab.message = `未保存 · 加密草稿已备份至 ${new Date(result.expiresAt).toLocaleTimeString()}`; renderFile(tab);
    }
  }

  async function removeDraft(value) {
    const tab = [...tabs.values()].find(tab => tab.type === 'file' && tab.path === value);
    if (tab) { clearTimeout(tab.draftTimer); await tab.draftPending?.catch(() => {}); }
    if (!draftVault || (!draftsEnabled && !draftCache.has(value))) return;
    await api(`/api/drafts?path=${encodeURIComponent(value)}`, { method: 'DELETE', headers: draftHeaders() });
    draftCache.delete(value);
  }

  async function showDrafts() {
    await refreshDrafts(); openUtility('短期草稿');
    const label = document.createElement('label'); const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = draftsEnabled;
    label.className = 'draft-setting'; label.append(toggle, document.createTextNode('加密草稿自动备份')); utilityBody.append(label);
    const expiry = document.createElement('p'); expiry.textContent = `服务器保留 ${Math.round((config.draftTtlSeconds || 3600) / 60)} 分钟 · 浏览器不保存正文`; utilityBody.append(expiry);
    toggle.addEventListener('change', async () => {
      draftsEnabled = toggle.checked;
      try {
        localStorage.setItem('ws-terminal-drafts-enabled', draftsEnabled ? '1' : '0');
        if (draftsEnabled) { for (const tab of tabs.values()) if (tab.type === 'file') scheduleDraft(tab); }
        else { for (const tab of tabs.values()) clearTimeout(tab.draftTimer); }
      } catch (error) { notifyError(error); }
    });
    for (const item of draftCache.values()) {
      const row = document.createElement('div'); row.className = 'utility-row';
      const text = document.createElement('span'); text.textContent = `${item.path} · ${new Date(item.expiresAt).toLocaleTimeString()} 到期`;
      row.append(text, actionButton('打开恢复', () => { utilityDialog.close(); const tab = openFile(item.path); tab?.offerDraft?.(); }),
        actionButton('删除草稿', async () => { await removeDraft(item.path); await showDrafts(); })); utilityBody.append(row);
    }
    if (!draftCache.size) { const empty = document.createElement('p'); empty.textContent = '暂无草稿'; utilityBody.append(empty); }
    utilityActions.append(actionButton('清空草稿', async () => {
      if (await choose('清空草稿', '仅删除当前浏览器的草稿，不修改原文件。', [{ label: '取消', value: false }, { label: '清空', value: true, danger: true }])) {
        await Promise.all([...tabs.values()].filter(tab => tab.type === 'file').map(tab => { clearTimeout(tab.draftTimer); return tab.draftPending?.catch(() => {}); }));
        await api('/api/drafts', { method: 'DELETE', headers: draftHeaders() }); draftCache.clear(); await showDrafts();
      }
    }));
  }

  function offerDraft(tab) {
    const draft = draftCache.get(tab.path);
    tab.draftNotice?.remove(); tab.draftNotice = null;
    if (!draft || tab.loading || !tab.version || draft.content === tab.diskContent) return;
    const notice = document.createElement('div'); notice.className = 'draft-notice';
    const text = document.createElement('span'); text.textContent = `发现短期草稿 · ${new Date(draft.updatedAt).toLocaleString()}`;
    notice.append(text, actionButton('恢复草稿', async () => {
      if (tab.dirty && !await choose('恢复草稿', '当前编辑会被草稿替换，磁盘文件不变。', [{ label: '取消', value: false }, { label: '恢复', value: true }])) return;
      const disk = { content: tab.diskContent, version: tab.version };
      applyDiskContent(tab, draft.content); tab.diskContent = disk.content;
      tab.content = editorContentFromDisk(disk.content).content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
      tab.dirty = serializedContent(tab) !== disk.content; tab.error = ''; tab.message = '草稿已恢复，尚未保存';
      if (draft.baseVersion !== disk.version) { tab.externalContent = disk; tab.message = '草稿基于旧版本，请比较合并后保存'; }
      notice.remove(); renderFile(tab);
    }), actionButton('删除草稿', async () => { await removeDraft(tab.path); notice.remove(); }));
    tab.pane.append(notice); tab.draftNotice = notice;
  }

  async function showMerge(tab) {
    const disk = await api('/api/filesystem/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: tab.path }) });
    if (!tabs.has(tab.id)) return;
    const localAtOpen = serializedContent(tab);
    openUtility(`${tab.path} · 比较与合并`);
    const grid = document.createElement('div'); grid.className = 'merge-workspace';
    const views = [];
    for (const [label, content, readonly] of [['磁盘内容（只读）', editorContentFromDisk(disk.content).content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'), true], ['合并结果', tab.editor.value, false]]) {
      const column = document.createElement('section'); const title = document.createElement('h3'); title.textContent = label;
      const view = window.WorkbenchEditor.create(tab.path, label); view.value = content; view.disabled = readonly;
      column.append(title, view); grid.append(column); views.push(view);
    }
    utilityBody.append(grid); utilityCleanup = () => views.forEach(view => view.destroy());
    utilityActions.append(actionButton('取消', () => utilityDialog.close()), actionButton('采用合并结果', () => {
      if (!tabs.has(tab.id) || serializedContent(tab) !== localAtOpen) throw new Error('编辑内容已变化，请重新打开合并窗口');
      const merged = views[1].value;
      applyDiskContent(tab, disk.content); tab.version = disk.version; tab.size = disk.size; tab.modifiedAt = disk.modifiedAt;
      tab.editor.value = merged; tab.externalContent = null; tab.error = ''; tab.dirty = serializedContent(tab) !== tab.diskContent;
      tab.message = '已采用合并结果，尚未保存'; utilityDialog.close(); renderFile(tab); scheduleDraft(tab);
    }, 'primary-button'));
    requestAnimationFrame(() => views.forEach(view => view.remeasure()));
  }

  function actionButton(label, action, className = '') {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = label; button.className = className;
    button.addEventListener('click', () => Promise.resolve().then(action).catch(error => {
      const message = document.createElement('p'); message.className = 'dialog-error'; message.textContent = error.message;
      utilityBody.append(message);
    }));
    return button;
  }

  function drawDiff(before, after) {
    const output = document.createElement('pre'); output.className = 'diff-output';
    const changes = window.WorkbenchEditor.diffLines(before, after, { timeout: 1000, maxEditLength: 4000 });
    if (!changes) { output.textContent = '差异较大，请缩小修改范围后重试。'; }
    else for (const part of changes) {
      const line = document.createElement('span'); line.className = part.added ? 'diff-added' : part.removed ? 'diff-removed' : 'diff-same';
      const prefix = part.added ? '+ ' : part.removed ? '- ' : '  ';
      line.textContent = part.value.split('\n').map((value, index, items) => index === items.length - 1 && value === '' ? '' : prefix + value).join('\n');
      output.append(line);
    }
    utilityBody.append(output);
  }

  function showFileDiff(fileTab) {
    if (fileTab.loading || !fileTab.version) return;
    openUtility(`${fileTab.path} · ${fileTab.externalContent ? '磁盘与编辑内容' : '修改对比'}`);
    drawDiff(fileTab.externalContent?.content ?? fileTab.diskContent ?? '', serializedContent(fileTab));
    utilityActions.append(actionButton('返回编辑', () => utilityDialog.close()));
    if (fileTab.dirty && !fileTab.externalContent) utilityActions.append(actionButton('保存', () => { utilityDialog.close(); saveFile(fileTab); }, 'primary-button'));
    if (fileTab.externalContent) utilityActions.append(actionButton('重新读取磁盘文件', () => { utilityDialog.close(); requestFile(fileTab); }));
    if (fileTab.externalContent) utilityActions.append(actionButton('比较并合并', () => showMerge(fileTab)));
  }

  async function showHistory(fileTab) {
    const result = await api(`/api/filesystem/history?path=${encodeURIComponent(fileTab.path)}`);
    openUtility(`${fileTab.path} · 历史版本`);
    if (!result.items.length) { const empty = document.createElement('p'); empty.textContent = '暂无历史版本'; utilityBody.append(empty); }
    for (const item of result.items) {
      const row = document.createElement('div'); row.className = 'utility-row';
      const label = document.createElement('span'); label.textContent = `${new Date(item.createdAt).toLocaleString()} · ${formatBytes(item.size)}`;
      row.append(label, actionButton('对比', async () => {
        const snapshot = await api(`/api/filesystem/backup?path=${encodeURIComponent(fileTab.path)}&id=${encodeURIComponent(item.id)}`);
        openUtility(`${fileTab.path} · 历史与当前内容`); drawDiff(snapshot.content, serializedContent(fileTab));
        utilityActions.append(actionButton('历史列表', () => showHistory(fileTab)));
      }), actionButton('恢复', async () => {
        if (!window.confirm(`恢复 ${fileTab.path} 到这个版本？${fileTab.dirty ? '未保存的编辑将被放弃。' : ''}`)) return;
        const restored = await api('/api/filesystem/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: fileTab.path, id: item.id, expectedVersion: fileTab.version }) });
        applyDiskContent(fileTab, restored.content); fileTab.version = restored.version; fileTab.modifiedAt = restored.modifiedAt;
        fileTab.size = restored.size; fileTab.dirty = false; fileTab.error = ''; fileTab.externalContent = null; fileTab.message = '已恢复历史版本';
        await removeDraft(fileTab.path); fileTab.draftNotice?.remove();
        renderFile(fileTab); invalidateDirectory(dirname(fileTab.path)); utilityDialog.close();
      }));
      utilityBody.append(row);
    }
  }

  async function checkExternalFiles() {
    if (!authenticated || document.hidden || externalCheckActive) return;
    externalCheckActive = true;
    try {
      for (const fileTab of [...tabs.values()].filter(tab => tab.type === 'file' && !tab.loading && !tab.saving && tab.version)) {
        try {
          const metadata = await api(`/api/filesystem/stat?path=${encodeURIComponent(fileTab.path)}`);
          if (!tabs.has(fileTab.id) || fileTab.saving || fileTab.loading) continue;
          if (metadata.size === fileTab.size && metadata.modifiedAt === fileTab.modifiedAt) continue;
          const disk = await api('/api/filesystem/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: fileTab.path }) });
          if (!tabs.has(fileTab.id) || fileTab.saving || fileTab.loading) continue;
          if (disk.version === fileTab.version) { fileTab.modifiedAt = disk.modifiedAt; continue; }
          if (!fileTab.dirty) {
            applyDiskContent(fileTab, disk.content); fileTab.version = disk.version; fileTab.size = disk.size; fileTab.modifiedAt = disk.modifiedAt;
            fileTab.message = '已更新磁盘内容'; fileTab.error = ''; fileTab.externalContent = null;
          } else { fileTab.externalContent = disk; fileTab.message = '磁盘内容已更新，有未保存的修改'; }
          renderFile(fileTab);
        } catch (error) {
          if (error.status === 404 && tabs.has(fileTab.id)) { fileTab.message = '文件已从磁盘删除'; renderFile(fileTab); }
        }
      }
    } finally { externalCheckActive = false; }
  }

  function navigateDirectory(value) {
    const target = normalizePath(value);
    if (!target || !authenticated) return;
    treeRoot = target; currentCwd = target; pathInput.value = target; cwdPathEl.textContent = target; cwdPathEl.title = target;
    treeFilter.value = ''; expandedDirectories.add(target); loadDirectory(target, true); renderDirectoryTree();
  }

  function renderBookmarks() {
    const container = document.getElementById('bookmarks'); container.replaceChildren();
    for (const value of bookmarkPaths) {
      const button = document.createElement('button'); button.type = 'button'; button.title = value;
      button.append(window.WorkbenchIcons('star'), document.createTextNode(basename(value)));
      button.addEventListener('click', () => navigateDirectory(value)); container.append(button);
    }
  }

  function toggleBookmark(value) {
    bookmarkPaths = bookmarkPaths.includes(value) ? bookmarkPaths.filter(item => item !== value) : [...bookmarkPaths, value].slice(-20);
    try { localStorage.setItem('ws-terminal-bookmarks', JSON.stringify(bookmarkPaths)); } catch {}
    renderBookmarks();
  }

  async function showProperties(value) {
    const info = await api(`/api/filesystem/stat?path=${encodeURIComponent(value)}`);
    openUtility(`${value} · 属性`);
    const list = document.createElement('dl'); list.className = 'properties-list';
    for (const [label, detail] of [['路径', info.path], ['类型', info.type], ['大小', info.type === 'directory' ? '未计算目录总大小' : formatBytes(info.size)],
      ['权限', info.mode], ['所有者 UID / GID', `${info.uid} / ${info.gid}`], ['修改时间', new Date(info.modifiedAt).toLocaleString()], ['链接目标', info.linkTarget]]) {
      if (detail === null) continue;
      const term = document.createElement('dt'); term.textContent = label;
      const text = document.createElement('dd'); text.textContent = detail; list.append(term, text);
    }
    utilityBody.append(list);
  }

  async function calculateSize(value) {
    const controller = new AbortController(); openUtility(`${value} · 目录大小`); utilityBody.textContent = '正在计算';
    utilityActions.append(actionButton('取消', () => { controller.abort(); utilityDialog.close(); }));
    const onClose = () => controller.abort(); utilityDialog.addEventListener('close', onClose, { once: true });
    try {
      const result = await api(`/api/filesystem/size?path=${encodeURIComponent(value)}`, { signal: controller.signal });
      utilityBody.textContent = `${formatBytes(result.size)}${result.partial ? '（部分结果）' : ''} · ${result.entries} 个条目${result.skipped ? ' · 跳过 ' + result.skipped + ' 个条目' : ''}`;
      utilityActions.replaceChildren(actionButton('关闭', () => utilityDialog.close()));
    } finally { utilityDialog.removeEventListener('close', onClose); }
  }

  function downloadFile(value) {
    const link = document.createElement('a'); link.href = `/api/filesystem/download?path=${encodeURIComponent(value)}`; link.download = basename(value);
    document.body.append(link); link.click(); link.remove();
  }

  function uploadOne(file, destination, overwrite = false, expectedFingerprint = '') {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const params = new URLSearchParams({ path: destination, overwrite: overwrite ? '1' : '0', expectedFingerprint });
      xhr.open('POST', `/api/filesystem/upload?${params}`); xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      transferStatus.hidden = false;
      const progressText = document.createElement('span');
      xhr.upload.addEventListener('progress', event => { progressText.textContent = `${file.name} · ${event.lengthComputable ? Math.round(event.loaded / event.total * 100) + '%' : formatBytes(event.loaded)}`; });
      xhr.addEventListener('load', () => {
        let payload = {}; try { payload = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status >= 200 && xhr.status < 300) resolve(payload);
        else reject(Object.assign(new Error(payload.error || '上传失败'), { status: xhr.status }));
      });
      xhr.addEventListener('error', () => reject(new Error('上传连接中断')));
      xhr.addEventListener('abort', () => reject(new Error('上传已取消')));
      const cancel = iconButton('close', '取消上传', () => xhr.abort());
      progressText.textContent = `${file.name} · 0%`;
      transferStatus.replaceChildren(progressText, cancel);
      xhr.send(file);
    });
  }

  async function uploadFiles(files) {
    const directory = currentCwd;
    for (const file of files) {
      if (file.size > config.maxTransferBytes) { transferStatus.hidden = false; transferStatus.textContent = `${file.name} 超过 ${formatBytes(config.maxTransferBytes)} 限制`; continue; }
      let name = file.name;
      let destination = normalizePath(`${directory}/${name}`);
      try {
        await uploadOne(file, destination);
      } catch (error) {
        if (error.status !== 409) { showTransferError(file, error); continue; }
        const choice = await uploadConflict(file, destination);
        if (!choice) continue;
        try {
          if (choice === 'overwrite') {
            const metadata = await api(`/api/filesystem/stat?path=${encodeURIComponent(destination)}`);
            await uploadOne(file, destination, true, metadata.fingerprint);
          } else {
            name = choice; destination = normalizePath(`${directory}/${name}`); await uploadOne(file, destination);
          }
        } catch (retryError) { showTransferError(file, retryError); continue; }
      }
      transferStatus.textContent = `${name} · 上传完成`; invalidateDirectory(directory);
    }
    uploadInput.value = '';
  }

  function uploadConflict(file, destination) {
    return new Promise(resolve => {
      openUtility(`${destination} · 文件已存在`);
      const input = document.createElement('input'); input.value = file.name; input.setAttribute('aria-label', '上传文件新名称'); utilityBody.append(input);
      let finished = false;
      const finish = choice => { if (finished) return; finished = true; utilityDialog.close(); resolve(choice); };
      utilityActions.append(actionButton('跳过', () => finish(null)), actionButton('改名上传', () => {
        const error = validateEntryName(input.value.trim()); if (error) throw new Error(error);
        finish(input.value.trim());
      }), actionButton('覆盖', () => finish('overwrite'), 'danger-button'));
      utilityDialog.addEventListener('close', () => finish(null), { once: true });
    });
  }

  function showTransferError(file, error) {
    const text = document.createElement('span'); text.textContent = `${file.name} · ${window.WorkbenchModel.errorText(error)}`;
    transferStatus.replaceChildren(text, actionButton('重试上传', () => uploadFiles([file])));
  }

  async function showSessions() {
    const result = await api('/api/terminals'); openUtility(`终端会话 · ${result.sessions.length} / ${config.maxSessions}`);
    if (!result.sessions.length) utilityBody.textContent = '暂无终端会话';
    for (const session of result.sessions) {
      const row = document.createElement('div'); row.className = 'utility-row';
      const label = document.createElement('span');
      const remaining = () => session.reconnectExpiresAt ? Math.max(0, Math.ceil((new Date(session.reconnectExpiresAt) - Date.now()) / 1000)) : 0;
      const update = () => { label.textContent = `PID ${session.pid} · ${session.cwd} · ${session.attached ? '已连接' : `等待重连 · 剩余 ${remaining()} 秒`} · ${new Date(session.startedAt).toLocaleTimeString()}`; };
      update();
      const timer = setInterval(update, 1000);
      const oldCleanup = utilityCleanup; utilityCleanup = () => { oldCleanup(); clearInterval(timer); };
      row.append(label, actionButton(session.attached ? '打开 / 接管' : '恢复终端', async () => {
        const local = terminalTabs().find(tab => tab.sessionId === session.id);
        if (local) { utilityDialog.close(); activateTab(local.id); if (!local.socket) openTerminalSocket(local); return; }
        const fresh = await api('/api/terminals');
        const current = fresh.sessions.find(item => item.id === session.id);
        if (!current) { await showSessions(); throw new Error('原终端已结束，未创建新进程'); }
        if (current.attached && !await choose('接管终端', `PID ${session.pid} · ${session.cwd}。原页面的连接将关闭，但不会结束进程。`, [{ label: '取消', value: false }, { label: '接管', value: true }])) return;
        utilityDialog.close(); createTerminal(focusedGroup(), session);
      }), actionButton('结束', async () => { await api(`/api/terminals?id=${encodeURIComponent(session.id)}`, { method: 'DELETE' }); await showSessions(); }, 'danger-button'));
      utilityBody.append(row);
    }
  }

  async function showAudit() {
    const result = await api('/api/audit'); openUtility('操作记录');
    const output = document.createElement('pre'); output.className = 'audit-output';
    output.textContent = result.items.slice().reverse().map(item => `${new Date(item.time).toLocaleString()}  ${item.node}  ${item.event}  ${item.remoteAddress || ''}  ${item.path || item.sessionId || ''}${item.newPath ? ' → ' + item.newPath : ''}`).join('\n');
    utilityBody.append(output);
  }

  function layoutSnapshot(element) {
    if (element.classList.contains('split-group')) {
      const group = groups.get(element.dataset.groupId);
      return { type: 'group', files: groupTabs(group).filter(tab => tab.type === 'file').map(tab => tab.path), active: activeTabInGroup(group)?.path || null };
    }
    if (!element.classList.contains('split-layout')) return null;
    return { type: 'split', horizontal: element.classList.contains('horizontal'), ratio: Number(element.dataset.ratio || 0.5),
      children: [...element.children].filter(child => !child.classList.contains('split-divider')).map(layoutSnapshot) };
  }

  function scheduleWorkspaceSave() {
    if (restoringLayout || !restoredWorkspace || loggingOut) return;
    clearTimeout(layoutSaveTimer);
    layoutSaveTimer = setTimeout(() => {
      try { localStorage.setItem(`ws-terminal-layout:${config.node?.name || location.host}`, JSON.stringify(layoutSnapshot(layoutRoot.firstElementChild))); } catch {}
    }, 150);
  }

  function restoreWorkspace() {
    if (restoredWorkspace) return;
    restoredWorkspace = true;
    let saved; try { saved = JSON.parse(localStorage.getItem(`ws-terminal-layout:${config.node?.name || location.host}`)); } catch {}
    if (!saved || tabs.size) return;
    let restoredFiles = 0; let restoredGroups = 0;
    restoringLayout = true;
    const build = (node, depth = 0) => {
      if (!node || depth > 8 || ++restoredGroups > 16) return createGroup(false).element;
      if (node.type === 'split' && Array.isArray(node.children) && node.children.length === 2) {
        const split = document.createElement('div'); split.className = `split-layout ${node.horizontal ? 'horizontal' : 'vertical'}`;
        split.append(build(node.children[0], depth + 1), createSplitDivider(split, node.horizontal), build(node.children[1], depth + 1));
        requestAnimationFrame(() => setSplitRatio(split, Math.max(0.1, Math.min(0.9, Number(node.ratio) || 0.5)))); return split;
      }
      const group = createGroup(false); focusGroup(group);
      for (const value of Array.isArray(node.files) ? node.files : []) { if (restoredFiles++ >= 30) break; if (normalizePath(value)) openFile(value); }
      const active = groupTabs(group).find(tab => tab.path === node.active); if (active) activateTab(active.id);
      return group.element;
    };
    groups.clear(); layoutRoot.replaceChildren();
    try { layoutRoot.append(build(saved)); } finally { restoringLayout = false; }
    scheduleFitAllVisibleTerminals(); updateControls();
  }

  function validateEntryName(name) {
    if (!name || name === '.' || name === '..' || name.includes('\0') || name.includes('/') || name.includes('\\')) {
      return '名称不能为空，不能是 . 或 ..，也不能包含路径分隔符';
    }
    if (new TextEncoder().encode(name).length > 255) {
      return '名称过长';
    }
    return '';
  }

  function openEntryDialog(operation, targetPath) {
    hideTreeContextMenu();
    const target = normalizePath(targetPath);
    if (!target || !authenticated) {
      setStatus('offline', '需要先登录');
      return;
    }
    entryDialogState = { operation, path: target };
    entryDialogError.textContent = '';
    if (operation === 'create-file') {
      entryDialogTitle.textContent = '新建文件';
      entryNameInput.value = '';
    } else if (operation === 'create-directory') {
      entryDialogTitle.textContent = '新建目录';
      entryNameInput.value = '';
    } else {
      entryDialogTitle.textContent = '重命名';
      entryNameInput.value = basename(target);
    }
    entryDialog.showModal();
    requestAnimationFrame(() => {
      entryNameInput.focus();
      entryNameInput.select();
    });
  }

  function openDeleteDialog(entry) {
    hideTreeContextMenu();
    if (!entry || entry.path === '/' || !authenticated) {
      return;
    }
    deleteDialogState = { path: entry.path, entryType: entry.type };
    deleteMessage.textContent = `确定删除 ${entry.path} 吗？`;
    deleteDialogError.textContent = '';
    deleteDialog.showModal();
  }

  function sendMutation(operation, path, name = '') {
    if (!authenticated) {
      return false;
    }
    const requestId = `fs-${++fsRequestCounter}`;
    const timeout = setTimeout(() => {
      pendingFsRequests.delete(requestId);
      const errorEl = operation === 'delete' ? deleteDialogError : entryDialogError;
      errorEl.textContent = '文件操作超时';
    }, 10000);
    pendingFsRequests.set(requestId, { kind: 'mutation', operation, path, name, terminalId: 'filesystem', timeout });
    api('/api/filesystem/mutate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation, path, name }), signal: AbortSignal.timeout(10000)
    }).then(payload => {
      receiveMutation({ requestId, ...payload }, 'filesystem');
    }).catch((error) => receiveFsError({ requestId, error: window.WorkbenchModel.errorText(error), status: error.status }, 'filesystem'));
    return true;
  }

  function invalidateDirectory(pathValue) {
    const path = normalizePath(pathValue);
    if (!path) {
      return;
    }
    directoryCache.delete(path);
    if (expandedDirectories.has(path)) {
      loadDirectory(path, true);
    }
  }

  function updateOpenPaths(oldPath, newPath) {
    for (const tab of tabs.values()) {
      if (tab.type !== 'file' || (tab.path !== oldPath && !tab.path.startsWith(`${oldPath}/`))) {
        continue;
      }
      tab.path = `${newPath}${tab.path.slice(oldPath.length)}`;
      tab.title = basename(tab.path);
      tab.pathEl.textContent = tab.path;
      tab.pathEl.title = tab.path;
      tab.selectEl.textContent = tab.title;
      tab.selectEl.title = tab.path;
    }
  }

  function closeTabsUnderPath(path) {
    for (const tab of [...tabs.values()]) {
      if (tab.type === 'file' && (tab.path === path || tab.path.startsWith(`${path}/`))) {
        closeTab(tab.id, true);
      }
    }
  }

  function receiveMutation(message, terminalId) {
    const pending = pendingFsRequests.get(message.requestId);
    if (!pending || pending.terminalId !== terminalId || pending.kind !== 'mutation') {
      return;
    }
    clearTimeout(pending.timeout);
    pendingFsRequests.delete(message.requestId);
    if (pending.operation === 'create-file' || pending.operation === 'create-directory') {
      entryDialog.close();
      entryDialogState = null;
      invalidateDirectory(pending.path);
      if (pending.operation === 'create-file' && message.path) {
        openFile(message.path, terminalId);
      } else if (message.path) {
        expandedDirectories.add(message.path);
      }
    } else if (pending.operation === 'rename') {
      entryDialog.close();
      entryDialogState = null;
      const newPath = normalizePath(message.newPath);
      if (newPath) {
        updateOpenPaths(pending.path, newPath);
      }
      invalidateDirectory(dirname(pending.path));
    } else if (pending.operation === 'delete') {
      deleteDialog.close();
      deleteDialogState = null;
      closeTabsUnderPath(pending.path);
      invalidateDirectory(dirname(pending.path));
    }
    setStatus('ready', '文件操作完成');
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) {
      return '';
    }
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    if (bytes < 1048576) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }

  function editorContentFromDisk(content) {
    if (content.endsWith('\r\n')) {
      return { content: content.slice(0, -2), finalNewline: '\r\n' };
    }
    if (content.endsWith('\n')) {
      return { content: content.slice(0, -1), finalNewline: '\n' };
    }
    return { content, finalNewline: '' };
  }

  function applyDiskContent(fileTab, content) {
    const display = editorContentFromDisk(content);
    fileTab.bom = display.content.startsWith('\uFEFF') ? '\uFEFF' : '';
    fileTab.lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
    fileTab.diskContent = content;
    fileTab.content = display.content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    fileTab.finalNewline = display.finalNewline;
    fileTab.applyingContent = true;
    fileTab.editor.value = fileTab.content;
    fileTab.applyingContent = false;
  }

  function serializedContent(fileTab) {
    return `${fileTab.bom || ''}${fileTab.editor.value.replace(/\r\n/g, '\n').replace(/\n/g, fileTab.lineEnding || '\n')}${fileTab.finalNewline}`;
  }

  function renderFile(fileTab) {
    fileTab.editor.hidden = fileTab.loading || Boolean(fileTab.error && !fileTab.version);
    fileTab.statusEl.hidden = !fileTab.editor.hidden;
    fileTab.statusEl.className = `file-status${fileTab.error ? ' error' : ''}`;
    fileTab.statusEl.textContent = fileTab.loading ? '正在读取文件' : fileTab.error;
    fileTab.editor.disabled = fileTab.loading || fileTab.saving;
    fileTab.saveButton.disabled = fileTab.loading || fileTab.saving || !fileTab.dirty;
    fileTab.saveButton.textContent = fileTab.saving ? '保存中' : '保存';
    fileTab.saveButton.classList.toggle('dirty', fileTab.dirty);
    fileTab.selectEl?.classList.toggle('dirty', fileTab.dirty);
    fileTab.metaEl.textContent = fileTab.loading || !fileTab.version
      ? ''
      : [formatBytes(fileTab.size), fileTab.lineEnding === '\r\n' ? 'CRLF' : 'LF', fileTab.bom ? 'UTF-8 BOM' : 'UTF-8'].filter(Boolean).join(' · ');
    fileTab.messageEl.hidden = !fileTab.message;
    fileTab.messageEl.textContent = fileTab.message;
    fileTab.messageEl.classList.toggle('error', Boolean(fileTab.error));
    if (focusedTab()?.id === fileTab.id) {
      setStatus(authenticated ? 'ready' : 'pending', authenticated ? `文本文件 · ${fileTab.path}` : '登录已过期，编辑内容已保留');
    }
  }

  function requestFile(fileTab, discardDirty = false) {
    if (!authenticated) {
      fileTab.loading = false;
      fileTab.error = '需要先登录才能读取文件';
      renderFile(fileTab);
      return;
    }
    if (fileTab.dirty && !discardDirty && !window.confirm('重新读取会放弃未保存的修改，确认继续吗？')) {
      return;
    }
    for (const [requestId, request] of pendingFsRequests) {
      if (request.tabId === fileTab.id) {
        clearTimeout(request.timeout);
        pendingFsRequests.delete(requestId);
      }
    }
    fileTab.loading = true;
    fileTab.error = '';
    fileTab.message = '';
    renderFile(fileTab);
    const requestId = `fs-${++fsRequestCounter}`;
    const timeout = setTimeout(() => {
      pendingFsRequests.delete(requestId);
      if (tabs.has(fileTab.id)) {
        fileTab.loading = false;
        fileTab.error = '文件读取超时';
        renderFile(fileTab);
      }
    }, 10000);
    pendingFsRequests.set(requestId, { kind: 'read', tabId: fileTab.id, terminalId: 'filesystem', path: fileTab.path, timeout });
    api('/api/filesystem/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: fileTab.path }), signal: AbortSignal.timeout(10000)
    }).then(payload => {
      receiveFile({ requestId, ...payload }, 'filesystem');
    }).catch((error) => receiveFsError({ requestId, error: window.WorkbenchModel.errorText(error), status: error.status }, 'filesystem'));
  }

  async function saveFile(fileTab) {
    if (!authenticated || fileTab.loading || fileTab.saving || !fileTab.dirty) {
      if (!authenticated) notifyError(Object.assign(new Error('未登录，编辑内容已保留'), { status: 401 }));
      return false;
    }
    const content = serializedContent(fileTab);
    const size = new TextEncoder().encode(content).length;
    if (size > config.maxFileBytes) {
      fileTab.error = `文件超过 ${formatBytes(config.maxFileBytes)} 的保存限制`;
      fileTab.message = fileTab.error;
      renderFile(fileTab);
      return;
    }
    fileTab.saving = true;
    fileTab.error = '';
    fileTab.message = '';
    renderFile(fileTab);
    const requestId = `fs-${++fsRequestCounter}`;
    const timeout = setTimeout(() => {
      pendingFsRequests.delete(requestId);
      if (tabs.has(fileTab.id)) {
        fileTab.saving = false;
        fileTab.error = '文件保存超时';
        fileTab.message = fileTab.error;
        renderFile(fileTab);
      }
    }, 12000);
    pendingFsRequests.set(requestId, { kind: 'write', tabId: fileTab.id, terminalId: 'filesystem', path: fileTab.path, timeout });
    return api('/api/filesystem/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: fileTab.path, content, expectedVersion: fileTab.version }), signal: AbortSignal.timeout(12000)
    }).then(async payload => {
      if (!pendingFsRequests.has(requestId)) return false;
      receiveSavedFile({ requestId, ...payload }, 'filesystem');
      await removeDraft(fileTab.path).catch(notifyError);
      return !fileTab.dirty;
    }).catch(async error => {
      receiveFsError({ requestId, error: window.WorkbenchModel.errorText(error), status: error.status }, 'filesystem');
      if (error.status === 409 && tabs.has(fileTab.id)) {
        fileTab.externalContent = await api('/api/filesystem/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: fileTab.path }) }).catch(() => null);
        renderFile(fileTab);
      }
      return false;
    });
  }

  function receiveFile(message, terminalId) {
    const pending = pendingFsRequests.get(message.requestId);
    if (!pending || pending.terminalId !== terminalId || pending.kind !== 'read') {
      return;
    }
    clearTimeout(pending.timeout);
    pendingFsRequests.delete(message.requestId);
    const fileTab = tabs.get(pending.tabId);
    if (!fileTab || fileTab.type !== 'file' || message.path !== fileTab.path || typeof message.content !== 'string') {
      return;
    }
    fileTab.loading = false;
    fileTab.error = '';
    fileTab.message = '';
    applyDiskContent(fileTab, message.content);
    fileTab.dirty = false;
    fileTab.size = Number(message.size) || 0;
    fileTab.modifiedAt = typeof message.modifiedAt === 'string' ? message.modifiedAt : '';
    fileTab.version = typeof message.version === 'string' ? message.version : '';
    fileTab.externalContent = null;
    scheduleWorkspaceSave();
    renderFile(fileTab);
    offerDraft(fileTab);
  }

  function receiveSavedFile(message, terminalId) {
    const pending = pendingFsRequests.get(message.requestId);
    if (!pending || pending.terminalId !== terminalId || pending.kind !== 'write') {
      return;
    }
    clearTimeout(pending.timeout);
    pendingFsRequests.delete(message.requestId);
    const fileTab = tabs.get(pending.tabId);
    if (!fileTab || fileTab.type !== 'file' || message.path !== fileTab.path) {
      return;
    }
    fileTab.saving = false;
    fileTab.error = '';
    fileTab.message = '已保存';
    applyDiskContent(fileTab, typeof message.content === 'string'
      ? message.content
      : `${fileTab.editor.value}${fileTab.finalNewline}`);
    fileTab.dirty = false;
    fileTab.size = Number(message.size) || 0;
    fileTab.modifiedAt = typeof message.modifiedAt === 'string' ? message.modifiedAt : '';
    fileTab.version = typeof message.version === 'string' ? message.version : '';
    fileTab.externalContent = null;
    fileTab.draftNotice?.remove();
    renderFile(fileTab);
    invalidateDirectory(dirname(fileTab.path));
  }

  function receiveFsError(message, terminalId) {
    const pending = pendingFsRequests.get(message.requestId);
    if (!pending || pending.terminalId !== terminalId) {
      return;
    }
    clearTimeout(pending.timeout);
    pendingFsRequests.delete(message.requestId);
    const error = typeof message.error === 'string' ? message.error : '文件操作失败';
    if (pending.kind === 'mutation') {
      const errorEl = pending.operation === 'delete' ? deleteDialogError : entryDialogError;
      errorEl.textContent = error;
      return;
    }
    const fileTab = tabs.get(pending.tabId);
    if (!fileTab || fileTab.type !== 'file') {
      return;
    }
    fileTab.loading = false;
    fileTab.saving = false;
    fileTab.error = error;
    fileTab.message = error;
    renderFile(fileTab);
  }

  function openFile(value, terminalId = null) {
    const filePath = normalizePath(value);
    if (!filePath) {
      return;
    }
    const existing = [...tabs.values()].find((tab) => tab.type === 'file' && tab.path === filePath);
    if (existing) {
      activateTab(existing.id);
      return existing;
    }
    const group = focusedGroup() || groups.values().next().value;
    const id = `tab-${++tabCounter}`;
    const pane = document.createElement('section');
    pane.className = 'workbench-pane file-pane';
    pane.setAttribute('role', 'tabpanel');
    const toolbar = document.createElement('div');
    toolbar.className = 'file-toolbar';
    const pathEl = document.createElement('span');
    pathEl.className = 'file-path';
    pathEl.textContent = filePath;
    pathEl.title = filePath;
    const meta = document.createElement('span');
    meta.className = 'file-meta';
    const reload = document.createElement('button');
    reload.type = 'button';
    reload.className = 'icon-button refresh-icon';
    reload.textContent = '↻';
    reload.title = '重新读取文件';
    reload.setAttribute('aria-label', '重新读取文件');
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'save-button';
    save.textContent = '保存';
    toolbar.append(pathEl, meta, reload, save);
    const editor = window.WorkbenchEditor.create(filePath, `${basename(filePath)} 文件内容`);
    editor.style.fontSize = `${fileFontSize}px`;
    const status = document.createElement('div');
    status.className = 'file-status';
    const message = document.createElement('div');
    message.className = 'file-message';
    message.hidden = true;
    pane.append(toolbar, editor, status, message);
    group.panes.append(pane);
    const fileTab = {
      id, groupId: group.id, type: 'file', title: basename(filePath), path: filePath, terminalId,
      pane, editor, statusEl: status, messageEl: message, pathEl, metaEl: meta, saveButton: save,
      content: '', finalNewline: '', size: 0, modifiedAt: '', version: '', loading: true, saving: false, dirty: false,
      error: '', message: '', tabEl: null, selectEl: null
    };
    tabs.set(id, fileTab);
    makeTabChrome(fileTab);
    editor.addEventListener('editor-change', () => {
      if (fileTab.applyingContent) return;
      fileTab.dirty = serializedContent(fileTab) !== fileTab.diskContent;
      fileTab.error = '';
      fileTab.message = fileTab.dirty ? '未保存' : '';
      renderFile(fileTab);
      scheduleDraft(fileTab);
    });
    editor.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        saveFile(fileTab);
      }
    });
    editor.addEventListener('wheel', (event) => {
      if (!event.ctrlKey) {
        return;
      }
      event.preventDefault();
      setFileFontSize(fileFontSize + (event.deltaY < 0 ? 1 : -1));
    }, { passive: false, capture: true });
    reload.addEventListener('click', () => requestFile(fileTab));
    save.addEventListener('click', () => saveFile(fileTab));
    reload.replaceChildren(window.WorkbenchIcons('refresh'));
    const compare = iconButton('compare', '对比修改', () => showFileDiff(fileTab));
    const merge = iconButton('merge', '比较并合并', () => showMerge(fileTab).catch(notifyError));
    const history = iconButton('history', '历史版本', () => showHistory(fileTab).catch(error => {
      fileTab.error = error.message; renderFile(fileTab);
    }));
    const search = iconButton('search', '查找与替换', () => editor.search());
    const jump = iconButton('right', '跳转行', () => editor.gotoLine());
    const download = iconButton('download', '下载文件', () => downloadFile(fileTab.path));
    toolbar.insertBefore(compare, reload); toolbar.insertBefore(merge, reload); toolbar.insertBefore(history, reload); toolbar.insertBefore(search, reload); toolbar.insertBefore(jump, reload); toolbar.insertBefore(download, reload);
    fileTab.offerDraft = () => offerDraft(fileTab);
    activateTab(id);
    requestFile(fileTab, true);
    scheduleWorkspaceSave();
    return fileTab;
  }

  async function login() {
    const token = tokenInput.value.trim();
    if (!token) {
      tokenInput.focus();
      setStatus('pending', '需要访问令牌');
      return false;
    }
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    tokenInput.value = '';
    if (!response.ok) {
      setStatus('pending', response.status === 401 ? '访问令牌不正确' : '尚未登录');
      notifyError(Object.assign(new Error(response.status === 401 ? '访问令牌不正确' : response.status === 429 ? '登录尝试过多，请稍后重试' : '登录请求失败'), { status: response.status }));
      return false;
    }
    authenticated = true;
    setStatus('pending', '已登录，未启动 Terminal');
    initializeFilesystemTree();
    updateControls();
    return true;
  }

  async function connect() {
    try {
      if (config.authRequired && !authenticated) {
        await login();
        return;
      }
      const terminal = focusedTerminal();
      if (terminal && !terminal.socket) {
        openTerminalSocket(terminal);
      }
    } catch (error) {
      setStatus('offline', '服务不可用');
      notifyError(error);
      updateControls();
    }
  }

  async function logout() {
    const dirtyFiles = [...tabs.values()].filter((tab) => tab.type === 'file' && tab.dirty);
    if (dirtyFiles.length && !window.confirm('存在未保存的文件，确认退出吗？')) {
      return;
    }
    loggingOut = true;
    authenticated = false;
    for (const tabId of [...tabs.keys()]) {
      closeTab(tabId, true);
    }
    try {
      await fetch('/api/logout', { method: 'POST' });
    } finally {
      loggingOut = false;
      clearPendingDirectoryRequests();
      clearPendingFsRequests();
      directoryCache.clear();
      expandedDirectories.clear();
      currentCwd = '/';
      cwdPathEl.textContent = '/';
      cwdPathEl.title = '/';
      renderDirectoryTree();
      setStatus('pending', '需要访问令牌');
      updateControls();
      tokenInput.focus();
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    connect();
  });
  disconnectButton.addEventListener('click', () => {
    const terminal = focusedTerminal();
    if (terminal) {
      closeTab(terminal.id);
    }
  });
  logoutButton.addEventListener('click', logout);
  decreaseFontButton.addEventListener('click', () => setTerminalFontSize(terminalFontSize - 1));
  increaseFontButton.addEventListener('click', () => setTerminalFontSize(terminalFontSize + 1));
  refreshTreeButton.addEventListener('click', () => loadDirectory(currentCwd, true));
  createFileButton.addEventListener('click', () => openEntryDialog('create-file', currentCwd));
  createDirectoryButton.addEventListener('click', () => openEntryDialog('create-directory', currentCwd));
  treeContextMenu.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button || !contextEntry) {
      return;
    }
    const entry = contextEntry;
    const action = button.dataset.action;
    if (action === 'create-file' || action === 'create-directory') {
      openEntryDialog(action, entry.path);
    } else if (action === 'rename') {
      openEntryDialog('rename', entry.path);
    } else if (action === 'delete') {
      openDeleteDialog(entry);
    } else if (action === 'download') {
      hideTreeContextMenu(); downloadFile(entry.path);
    } else if (action === 'bookmark') {
      hideTreeContextMenu(); toggleBookmark(entry.path);
    } else if (action === 'properties') {
      hideTreeContextMenu(); showProperties(entry.path).catch(notifyError);
    } else if (action === 'size') {
      hideTreeContextMenu(); calculateSize(entry.path).catch(error => { if (error.name !== 'AbortError') notifyError(error); });
    }
  });
  document.addEventListener('pointerdown', (event) => {
    if (!treeContextMenu.hidden && !treeContextMenu.contains(event.target)) {
      hideTreeContextMenu();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && tabDrag) {
      cancelTabDrag();
    }
  });
  entryCancelButton.addEventListener('click', () => {
    entryDialog.close();
    entryDialogState = null;
  });
  entryForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!entryDialogState) {
      return;
    }
    const name = entryNameInput.value.trim();
    const error = validateEntryName(name);
    if (error) {
      entryDialogError.textContent = error;
      return;
    }
    entryDialogError.textContent = '';
    sendMutation(entryDialogState.operation, entryDialogState.path, name);
  });
  deleteCancelButton.addEventListener('click', () => {
    deleteDialog.close();
    deleteDialogState = null;
  });
  deleteForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (deleteDialogState) {
      deleteDialogError.textContent = '';
      sendMutation('delete', deleteDialogState.path);
    }
  });
  window.addEventListener('resize', scheduleFitAllVisibleTerminals);
  directoryTreeEl.addEventListener('wheel', (event) => {
    if (!event.ctrlKey) {
      return;
    }
    event.preventDefault();
    setTreeFontSize(treeFontSize + (event.deltaY < 0 ? 1 : -1));
  }, { passive: false });
  sidebarToggleButton.addEventListener('click', () => {
    setExplorerHidden(!workspaceEl.classList.contains('explorer-hidden'));
  });
  explorerResizer.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) {
      return;
    }
    explorerResize = { pointerId: event.pointerId, startX: event.clientX, startWidth: explorerWidth };
    workspaceEl.classList.add('resizing-explorer');
    explorerResizer.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  explorerResizer.addEventListener('pointermove', (event) => {
    if (!explorerResize || explorerResize.pointerId !== event.pointerId) {
      return;
    }
    setExplorerWidth(explorerResize.startWidth + event.clientX - explorerResize.startX, false);
  });
  const finishExplorerResize = (event) => {
    if (!explorerResize || explorerResize.pointerId !== event.pointerId) {
      return;
    }
    explorerResize = null;
    workspaceEl.classList.remove('resizing-explorer');
    setExplorerWidth(explorerWidth, true);
  };
  explorerResizer.addEventListener('pointerup', finishExplorerResize);
  explorerResizer.addEventListener('pointercancel', finishExplorerResize);
  explorerResizer.addEventListener('dblclick', () => setExplorerWidth(300));
  explorerResizer.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return;
    }
    event.preventDefault();
    setExplorerWidth(explorerWidth + (event.key === 'ArrowLeft' ? -20 : 20));
  });
  window.addEventListener('resize', () => setExplorerWidth(explorerWidth, false));
  async function init() {
    setTerminalFontSize(terminalFontSize);
    setFileFontSize(fileFontSize);
    setTreeFontSize(treeFontSize);
    setExplorerWidth(explorerWidth, false);
    setExplorerHidden(false);
    const rootGroup = createGroup();
    focusGroup(rootGroup);
    try {
      const response = await fetch('/api/config', { cache: 'no-store' });
      if (!response.ok) {
        throw new Error('Config unavailable');
      }
      config = { ...config, ...await response.json() };
      titleEl.textContent = config.title || 'WS Terminal';
      if (config.authRequired) {
        authenticated = (await fetch('/api/session', { cache: 'no-store' })).ok;
      } else {
        authenticated = true;
      }
      updateControls();
      renderDirectoryTree();
      if (authenticated) {
        initializeFilesystemTree();
        setStatus('pending', '已登录，未启动 Terminal');
      } else {
        setStatus('pending', '需要访问令牌');
        tokenInput.focus();
      }
    } catch {
      setStatus('offline', '服务不可用');
      updateControls();
    }
  }

  document.getElementById('utilityClose').addEventListener('click', () => utilityDialog.close());
  utilityDialog.addEventListener('close', () => { if (!utilityDialog.open) { utilityCleanup(); utilityCleanup = () => {}; } });
  document.getElementById('pathForm').addEventListener('submit', event => { event.preventDefault(); navigateDirectory(pathInput.value); });
  const applyTreeSearch = () => {
    clearTimeout(searchTimer);
    if (document.getElementById('treeSearchMode').value === 'remote') {
      treeRoot = currentCwd; expandedDirectories.add(treeRoot); loadDirectory(treeRoot, true);
    } else renderDirectoryTree();
  };
  treeFilter.addEventListener('input', () => {
    clearTimeout(searchTimer);
    if (document.getElementById('treeSearchMode').value === 'remote') searchTimer = setTimeout(applyTreeSearch, 300);
    else renderDirectoryTree();
  });
  document.getElementById('treeSearchMode').addEventListener('change', () => { treeFilter.value = ''; loadDirectory(currentCwd, true); renderDirectoryTree(); });
  document.getElementById('hiddenButton').addEventListener('click', () => {
    showHidden = !showHidden;
    const button = document.getElementById('hiddenButton'); button.setAttribute('aria-pressed', String(showHidden));
    button.title = showHidden ? '隐藏隐藏文件' : '显示隐藏文件'; button.setAttribute('aria-label', button.title);
    button.replaceChildren(window.WorkbenchIcons(showHidden ? 'visible' : 'hidden'));
    directoryCache.clear(); for (const value of expandedDirectories) loadDirectory(value, true); renderDirectoryTree();
  });
  document.getElementById('uploadButton').addEventListener('click', () => uploadInput.click());
  uploadInput.addEventListener('change', () => uploadFiles([...uploadInput.files]).catch(notifyError));
  fileExplorerEl.addEventListener('dragover', event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); fileExplorerEl.classList.add('file-drop-target'); } });
  fileExplorerEl.addEventListener('dragleave', event => { if (!fileExplorerEl.contains(event.relatedTarget)) fileExplorerEl.classList.remove('file-drop-target'); });
  fileExplorerEl.addEventListener('drop', event => {
    fileExplorerEl.classList.remove('file-drop-target');
    if (!event.dataTransfer.files.length) return;
    event.preventDefault(); if (authenticated) uploadFiles([...event.dataTransfer.files]).catch(notifyError);
  });
  document.getElementById('sessionsButton').addEventListener('click', () => showSessions().catch(notifyError));
  document.getElementById('auditButton').addEventListener('click', () => showAudit().catch(notifyError));
  document.getElementById('draftsButton').addEventListener('click', () => showDrafts().catch(notifyError));
  document.querySelectorAll('[data-icon]').forEach(button => button.append(window.WorkbenchIcons(button.dataset.icon)));
  sidebarToggleButton.replaceChildren(window.WorkbenchIcons('panel'));
  createFileButton.replaceChildren(window.WorkbenchIcons('file-add'));
  createDirectoryButton.replaceChildren(window.WorkbenchIcons('folder-add'));
  refreshTreeButton.replaceChildren(window.WorkbenchIcons('refresh'));
  window.addEventListener('beforeunload', event => {
    if ([...tabs.values()].some(tab => tab.type === 'file' && tab.dirty)) { event.preventDefault(); event.returnValue = ''; }
    if (restoredWorkspace) try { localStorage.setItem(`ws-terminal-layout:${config.node?.name || location.host}`, JSON.stringify(layoutSnapshot(layoutRoot.firstElementChild))); } catch {}
  });
  window.addEventListener('focus', checkExternalFiles);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && draftsEnabled) for (const tab of tabs.values()) if (tab.type === 'file' && tab.dirty) flushDraft(tab).catch(() => {});
  });
  setInterval(checkExternalFiles, 8000);
  renderBookmarks();
  init();
}());
