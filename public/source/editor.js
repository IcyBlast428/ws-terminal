import { basicSetup } from 'codemirror';
import { EditorView, keymap } from '@codemirror/view';
import { Compartment, EditorState } from '@codemirror/state';
import { indentWithTab } from '@codemirror/commands';
import { openSearchPanel, gotoLine } from '@codemirror/search';
import { StreamLanguage, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { python } from '@codemirror/lang-python';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { diffLines } from 'diff';
import { createElement, PanelLeft, FilePlus2, FolderPlus, RefreshCw, Upload, Download, Search, Eye, EyeOff, Star, Info, History, GitCompareArrows, GitMerge, FileClock, Save, List, ScrollText, X, Folder, File, FileCode2, FileCog, FileText, Image, FileArchive, Link, ChevronRight, ChevronDown, Ellipsis } from 'lucide';

function language(filePath) {
  if (/\.(?:js|mjs|cjs|jsx|ts|tsx)$/i.test(filePath)) return javascript({ typescript: /\.tsx?$/i.test(filePath), jsx: /\.[jt]sx$/i.test(filePath) });
  if (/\.json$/i.test(filePath)) return json();
  if (/\.ya?ml$/i.test(filePath)) return yaml();
  if (/\.py$/i.test(filePath)) return python();
  if (/\.(?:sh|bash|zsh)$/i.test(filePath)) return StreamLanguage.define(shell);
  if (/\.(?:conf|ini|service|env|properties)$/i.test(filePath)) return StreamLanguage.define(properties);
  return [];
}

window.WorkbenchEditor = {
  create(filePath, label) {
    const host = document.createElement('div');
    host.className = 'file-editor';
    const editable = new Compartment();
    const view = new EditorView({ parent: host, state: EditorState.create({ doc: '', extensions: [
      basicSetup, language(filePath), keymap.of([indentWithTab]), editable.of(EditorView.editable.of(true)),
      syntaxHighlighting(HighlightStyle.define([
        { tag: tags.keyword, color: '#c7acdf' }, { tag: [tags.string, tags.regexp], color: '#a7d7af' },
        { tag: [tags.number, tags.bool, tags.null], color: '#e2bf78' }, { tag: tags.comment, color: '#82928a', fontStyle: 'italic' },
        { tag: [tags.propertyName, tags.attributeName, tags.variableName], color: '#90cbd0' },
        { tag: [tags.typeName, tags.className, tags.tagName], color: '#dfb988' }
      ])),
      EditorView.contentAttributes.of({ 'aria-label': label }),
      EditorView.theme({ '&': { height: '100%', fontSize: 'inherit', backgroundColor: '#0f1115', color: '#dce4ec' },
        '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', lineHeight: '1.4' },
        '.cm-content': { padding: '10px 0 32px' }, '.cm-gutters': { backgroundColor: '#15181d', color: '#76818e', borderRight: '1px solid #303640' },
        '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: '#1c2427' }, '.cm-cursor': { borderLeftColor: '#dce4ec' },
        '.cm-panels': { backgroundColor: '#20242a', color: '#dce4ec' }, '.cm-selectionBackground': { backgroundColor: '#355949 !important' }
      }, { dark: true }),
      EditorView.updateListener.of(update => { if (update.docChanged) host.dispatchEvent(new Event('editor-change')); })
    ] }) });
    Object.defineProperties(host, {
      value: { get: () => view.state.doc.toString(), set: value => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } }) },
      disabled: { set: value => view.dispatch({ effects: editable.reconfigure([EditorView.editable.of(!value), EditorState.readOnly.of(value)]) }) }
    });
    host.focus = () => view.focus();
    host.search = () => openSearchPanel(view);
    host.gotoLine = () => gotoLine(view);
    host.destroy = () => view.destroy();
    host.remeasure = () => view.requestMeasure();
    return host;
  },
  diffLines
};

const icons = { panel: PanelLeft, 'file-add': FilePlus2, 'folder-add': FolderPlus, refresh: RefreshCw, upload: Upload, download: Download,
  search: Search, hidden: Eye, visible: EyeOff, star: Star, info: Info, history: History, compare: GitCompareArrows, save: Save,
  sessions: List, audit: ScrollText, draft: FileClock, merge: GitMerge, close: X, directory: Folder, file: File, code: FileCode2, config: FileCog, text: FileText,
  image: Image, archive: FileArchive, symlink: Link, other: File, right: ChevronRight, down: ChevronDown, more: Ellipsis };
window.WorkbenchIcons = (name) => createElement(icons[name] || File, { width: 16, height: 16, 'stroke-width': 1.6, 'aria-hidden': 'true' });
