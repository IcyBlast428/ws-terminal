import { basicSetup } from 'codemirror';
import { EditorView, keymap } from '@codemirror/view';
import { Compartment, EditorState } from '@codemirror/state';
import { indentWithTab, emacsStyleKeymap } from '@codemirror/commands';
import { openSearchPanel, gotoLine } from '@codemirror/search';
import { StreamLanguage, HighlightStyle, syntaxHighlighting, indentUnit } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { python } from '@codemirror/lang-python';
import { markdown } from '@codemirror/lang-markdown';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { sql } from '@codemirror/lang-sql';
import { vim, Vim } from '@replit/codemirror-vim';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { diffLines } from 'diff';
import { createElement, PanelLeft, FilePlus2, FolderPlus, RefreshCw, Upload, Download, Search, Eye, EyeOff, Star, Info, History, GitCompareArrows, GitMerge, FileClock, Save, List, ScrollText, X, Folder, File, FileCode2, FileCog, FileText, Image, FileArchive, Link, ChevronRight, ChevronDown, ChevronLeft, Ellipsis, Copy, Scissors, ClipboardPaste, Files, Trash2, Terminal, Maximize2, Minimize2, Command, PanelsTopLeft, SaveAll, FilePenLine, Pencil, ArrowUp, Settings2, RotateCw, ZoomIn, ZoomOut } from 'lucide';

const editorEvent = (cm, name, detail = {}) => cm.getWrapperElement().closest('.file-editor')?.dispatchEvent(new CustomEvent(name, { detail }));
Vim.defineEx('write', 'w', cm => editorEvent(cm, 'editor-save'));
Vim.defineEx('wq', 'wq', cm => editorEvent(cm, 'editor-save', { close: true }));
Vim.defineEx('quit', 'q', cm => editorEvent(cm, 'editor-close'));

function languageName(filePath, selected = 'auto') {
  if (selected !== 'auto') return selected;
  for (const [name, pattern] of Object.entries({ typescript: /\.tsx?$/i, javascript: /\.(js|mjs|cjs|jsx)$/i, json: /\.json$/i, yaml: /\.ya?ml$/i, python: /\.py$/i, shell: /\.(sh|bash|zsh)$/i, ini: /\.(conf|ini|service|env|properties)$/i, markdown: /\.(md|markdown)$/i, html: /\.html?$/i, css: /\.css$/i, sql: /\.sql$/i })) if (pattern.test(filePath)) return name;
  return 'plain';
}
function language(filePath, selected) {
  return { javascript: () => javascript({ jsx: /\.jsx$/i.test(filePath) }), typescript: () => javascript({ typescript: true, jsx: /\.tsx$/i.test(filePath) }), json, yaml, python, shell: () => StreamLanguage.define(shell), ini: () => StreamLanguage.define(properties), markdown, html, css, sql }[languageName(filePath, selected)]?.() || [];
}

window.WorkbenchEditor = {
  create(filePath, label, initial = window.WorkbenchPreferences?.load() || {}) {
    const host = document.createElement('div');
    host.className = 'file-editor';
    const editable = new Compartment();
    const syntax = new Compartment();
    const options = new Compartment();
    const bindings = new Compartment();
    const theme = new Compartment();
    let settings = initial;
    let override = 'auto';
    const effectiveLanguage = () => override === 'auto' ? settings.language || 'auto' : override;
    const themeExtension = () => EditorView.theme({ '&': { height: '100%', fontSize: 'inherit', backgroundColor: 'var(--editor-bg)', color: 'var(--text)' },
      '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', lineHeight: '1.4' },
      '.cm-content': { padding: '10px 0 32px' }, '.cm-gutters': { backgroundColor: 'var(--surface)', color: 'var(--muted)', borderRight: '1px solid var(--line)' },
      '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--active-line)' }, '.cm-cursor': { borderLeftColor: 'var(--text)' },
      '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--text)' }, '.cm-selectionBackground': { backgroundColor: 'var(--selection) !important' }
    }, { dark: document.documentElement.dataset.theme !== 'light' });
    const preferenceExtensions = () => [settings.wordWrap ? EditorView.lineWrapping : [], indentUnit.of(settings.useTabs ? '\t' : ' '.repeat(settings.indentSize || 2)), EditorState.tabSize.of(settings.indentSize || 2)];
    const bindingExtensions = () => settings.keymap === 'vim' ? vim({ status: true }) : settings.keymap === 'emacs' ? keymap.of([{ key: 'Ctrl-s', run: openSearchPanel }, { key: 'Ctrl-x Ctrl-s', run: () => { host.dispatchEvent(new Event('editor-save')); return true; } }, ...emacsStyleKeymap]) : [];
    const view = new EditorView({ parent: host, state: EditorState.create({ doc: '', extensions: [
      bindings.of(bindingExtensions()), basicSetup, syntax.of(language(filePath, effectiveLanguage())), options.of(preferenceExtensions()), keymap.of([indentWithTab]), editable.of(EditorView.editable.of(true)),
      syntaxHighlighting(HighlightStyle.define([
        { tag: tags.keyword, color: 'var(--syntax-keyword)' }, { tag: [tags.string, tags.regexp], color: 'var(--syntax-string)' },
        { tag: [tags.number, tags.bool, tags.null], color: 'var(--syntax-number)' }, { tag: tags.comment, color: 'var(--muted)', fontStyle: 'italic' },
        { tag: [tags.propertyName, tags.attributeName, tags.variableName], color: 'var(--syntax-property)' },
        { tag: [tags.typeName, tags.className, tags.tagName], color: 'var(--syntax-number)' }
      ])),
      EditorView.contentAttributes.of({ 'aria-label': label }),
      theme.of(themeExtension()),
      EditorView.updateListener.of(update => { if (update.docChanged) host.dispatchEvent(new Event('editor-change')); if (update.docChanged || update.selectionSet) host.dispatchEvent(new Event('editor-status')); })
    ] }) });
    Object.defineProperties(host, {
      value: { get: () => view.state.doc.toString(), set: value => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } }) },
      disabled: { set: value => view.dispatch({ effects: editable.reconfigure([EditorView.editable.of(!value), EditorState.readOnly.of(value)]) }) }
    });
    host.focus = () => view.focus();
    host.search = () => openSearchPanel(view);
    host.gotoLine = () => gotoLine(view);
    host.setPath = value => { filePath = value; view.dispatch({ effects: syntax.reconfigure(language(filePath, effectiveLanguage())) }); };
    host.setLanguage = value => { override = value; view.dispatch({ effects: syntax.reconfigure(language(filePath, effectiveLanguage())) }); };
    host.configure = value => { const previous = settings; settings = value; const effects = [options.reconfigure(preferenceExtensions()), syntax.reconfigure(language(filePath, effectiveLanguage())), theme.reconfigure(themeExtension())]; if (previous.keymap !== settings.keymap) effects.push(bindings.reconfigure(bindingExtensions())); view.dispatch({ effects }); };
    host.getStatus = () => { const selection = view.state.selection.main; const line = view.state.doc.lineAt(selection.head); return { line: line.number, column: selection.head - line.from + 1, selected: Math.abs(selection.to - selection.from), lines: view.state.doc.lines, language: languageName(filePath, effectiveLanguage()) }; };
    host.destroy = () => view.destroy();
    host.remeasure = () => view.requestMeasure();
    return host;
  },
  diffLines, languageName
};

const icons = { panel: PanelLeft, 'file-add': FilePlus2, 'folder-add': FolderPlus, refresh: RefreshCw, upload: Upload, download: Download,
  search: Search, hidden: Eye, visible: EyeOff, star: Star, info: Info, history: History, compare: GitCompareArrows, save: Save,
  sessions: List, audit: ScrollText, draft: FileClock, merge: GitMerge, close: X, directory: Folder, file: File, code: FileCode2, config: FileCog, text: FileText,
  image: Image, archive: FileArchive, symlink: Link, other: File, right: ChevronRight, down: ChevronDown, more: Ellipsis,
  copy: Copy, cut: Scissors, paste: ClipboardPaste, duplicate: Files, delete: Trash2, terminal: Terminal, maximize: Maximize2, minimize: Minimize2,
  command: Command, tabs: PanelsTopLeft, 'save-all': SaveAll, 'save-as': FilePenLine, rename: Pencil, up: ArrowUp, settings: Settings2, preview: Eye, edit: FilePenLine, left: ChevronLeft, rotate: RotateCw, 'zoom-in': ZoomIn, 'zoom-out': ZoomOut };
window.WorkbenchIcons = (name) => createElement(icons[name] || File, { width: 16, height: 16, 'stroke-width': 1.6, 'aria-hidden': 'true' });
