import { marked } from 'marked';
import DOMPurify from 'dompurify';
import Papa from 'papaparse';

const button = (icon, label, action) => {
  const node = document.createElement('button'); node.type = 'button'; node.className = 'icon-button'; node.title = label; node.setAttribute('aria-label', label); node.append(window.WorkbenchIcons(icon)); node.addEventListener('click', action); return node;
};
const status = (text, className = '') => { const node = document.createElement('p'); node.className = `preview-status ${className}`; node.textContent = text; return node; };
const check = signal => signal?.throwIfAborted();

async function markdownPreview(container, options) {
  const fragment = DOMPurify.sanitize(marked.parse(options.text, { async: false, gfm: true }), { RETURN_DOM_FRAGMENT: true, USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'object', 'embed', 'video', 'audio', 'source', 'link', 'meta'], FORBID_ATTR: ['style', 'srcset'] });
  for (const link of fragment.querySelectorAll('a')) if (!link.getAttribute('href')?.startsWith('#')) { link.title = link.getAttribute('href') || ''; link.removeAttribute('href'); }
  let images = 0; let imageBytes = 0;
  for (const image of fragment.querySelectorAll('img')) {
    const raw = image.getAttribute('src') || ''; image.removeAttribute('src');
    try {
      if (++images > 8) throw new Error('图片数量达到预览上限');
      if (/^data:image\/(png|jpeg|gif|webp);base64,/i.test(raw) && raw.length < 262144) { image.src = raw; continue; }
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) throw new Error('不加载外部图片');
      const base = options.path.slice(0, options.path.lastIndexOf('/') + 1);
      const target = decodeURIComponent(new URL(raw, `https://preview.invalid${base}`).pathname);
      const asset = await options.loadAsset(target); check(options.signal);
      if (!asset.mime.startsWith('image/') || (imageBytes += asset.data.byteLength) > 20971520) throw new Error('图片预览超过大小限制');
      // An opaque sandbox cannot read its parent's partitioned blob URLs.
      image.src = await new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
        options.cleanup(() => { if (reader.readyState === FileReader.LOADING) reader.abort(); }); reader.readAsDataURL(new Blob([asset.data], { type: asset.mime }));
      });
    } catch (error) { if (options.signal.aborted) throw error; image.alt = image.alt || '图片不可用'; image.title = error.message; }
  }
  check(options.signal);
  const content = document.createElement('div'); const styled = document.createElement('div'); styled.style.fontSize = `${options.fontSize || 14}px`; styled.append(fragment);
  for (const heading of styled.querySelectorAll('h1, h2, h3')) heading.style.fontSize = { H1: '1.9em', H2: '1.5em', H3: '1.25em' }[heading.tagName]; content.append(styled);
  const frame = document.createElement('iframe'); frame.className = 'markdown-preview'; frame.title = 'Markdown 预览'; frame.setAttribute('sandbox', ''); frame.referrerPolicy = 'no-referrer';
  const light = options.theme === 'light';
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; base-uri 'none'; form-action 'none'"><style>:root{color-scheme:${light ? 'light' : 'dark'}}body{margin:0;padding:24px;font:14px/1.7 system-ui,sans-serif;color:${light ? '#242a2e' : '#dce4ec'};background:${light ? '#fff' : '#111418'};overflow-wrap:anywhere}h1,h2,h3{line-height:1.3}h1{font-size:26px}h2{font-size:21px}h3{font-size:17px}pre{overflow:auto;padding:12px;background:${light ? '#f1f4f5' : '#20262c'};border-radius:4px}code{font-family:ui-monospace,Consolas,monospace}img{max-width:100%;height:auto}table{border-collapse:collapse;max-width:100%;display:block;overflow:auto}th,td{padding:6px 10px;border:1px solid ${light ? '#cdd4d7' : '#414951'}}blockquote{margin-left:0;padding-left:16px;border-left:3px solid #719c89}a{color:${light ? '#236351' : '#8bd6b2'}}</style></head><body>${content.innerHTML}</body></html>`;
  container.append(frame);
}

function jsonPreview(container, options) {
  let value; try { value = JSON.parse(options.text.replace(/^\uFEFF/, '')); } catch (error) { container.append(status(`JSON 格式错误：${error.message}`, 'error')); return; }
  let nodes = 0;
  const primitive = value => typeof value === 'string' ? JSON.stringify(value) : String(value);
  const create = (key, value, depth) => {
    if (++nodes > 10000) return status('节点数量达到预览上限');
    if (value === null || typeof value !== 'object') { const row = document.createElement('div'); row.className = 'json-value'; row.textContent = `${key ? key + ': ' : ''}${primitive(value)}`; row.dataset.type = value === null ? 'null' : typeof value; return row; }
    const node = document.createElement('details'); node.className = 'json-node';
    const summary = document.createElement('summary'); const keys = Object.keys(value); summary.textContent = `${key ? key + ': ' : ''}${Array.isArray(value) ? '[' : '{'} ${keys.length} ${Array.isArray(value) ? '项 ]' : '项 }'}`; node.append(summary);
    const children = document.createElement('div'); children.className = 'json-children'; let offset = 0; let more;
    const append = () => {
      more?.remove();
      if (depth >= 40) { children.append(status('嵌套层数达到预览上限')); return; }
      const end = Math.min(keys.length, offset + 200);
      for (; offset < end && nodes < 10000; offset++) children.append(create(keys[offset], value[keys[offset]], depth + 1));
      if (offset < keys.length && nodes < 10000) { more = document.createElement('button'); more.textContent = '加载更多'; more.addEventListener('click', append); children.append(more); }
      else if (nodes >= 10000) children.append(status('节点数量达到预览上限'));
    };
    node.addEventListener('toggle', () => { if (node.open && !node.contains(children)) { append(); node.append(children); } });
    if (depth === 0) node.open = true;
    return node;
  };
  const tree = document.createElement('div'); tree.className = 'json-preview'; tree.append(create('', value, 0)); container.append(tree);
}

function csvPreview(container, options) {
  const parsed = Papa.parse(options.text, { delimiter: /\.tsv$/i.test(options.path) ? '\t' : '', preview: 20001, dynamicTyping: false, skipEmptyLines: false });
  const records = parsed.data;
  if (/[\r\n]$/.test(options.text) && records.at(-1)?.length === 1 && records.at(-1)[0] === '') records.pop();
  const controls = document.createElement('div'); controls.className = 'preview-controls';
  const label = document.createElement('label'); const header = document.createElement('input'); header.type = 'checkbox'; header.checked = true; header.setAttribute('aria-label', '首行作为标题'); label.append(header, document.createTextNode('首行标题'));
  const info = document.createElement('span'); const previous = button('left', 'CSV 上一页', () => { page--; render(); }); const next = button('right', 'CSV 下一页', () => { page++; render(); }); controls.append(label, info, previous, next);
  const scroller = document.createElement('div'); scroller.className = 'csv-preview'; const table = document.createElement('table'); table.setAttribute('aria-label', 'CSV 表格'); scroller.append(table); container.append(controls, scroller);
  let page = 0;
  function render() {
    const start = header.checked ? 1 : 0; const count = Math.max(0, records.length - start); const pages = Math.max(1, Math.ceil(count / 100)); page = Math.max(0, Math.min(page, pages - 1));
    const columns = Math.min(200, records.reduce((maximum, row) => Math.max(maximum, row.length), 0));
    info.textContent = `${count} 行 · ${columns} 列 · ${page + 1} / ${pages}${parsed.meta.truncated ? ' · 已截断' : ''}`; previous.disabled = page === 0; next.disabled = page >= pages - 1; table.replaceChildren();
    const head = document.createElement('thead'); const heading = document.createElement('tr');
    for (let col = 0; col < columns; col++) { const cell = document.createElement('th'); cell.textContent = header.checked ? records[0]?.[col] || '' : String(col + 1); heading.append(cell); }
    head.append(heading); table.append(head); const body = document.createElement('tbody');
    for (const record of records.slice(start + page * 100, start + (page + 1) * 100)) { const row = document.createElement('tr'); for (let col = 0; col < columns; col++) { const cell = document.createElement('td'); cell.textContent = record[col] || ''; row.append(cell); } body.append(row); }
    table.append(body);
  }
  header.addEventListener('change', () => { page = 0; render(); }); render();
  if (parsed.errors.length) container.append(status(`CSV：${parsed.errors[0].message}`, 'error'));
}

async function imagePreview(container, options) {
  if (!options.mime?.startsWith('image/')) throw new Error('该文件不是支持的图片');
  const url = URL.createObjectURL(new Blob([options.data], { type: options.mime })); options.cleanup(() => URL.revokeObjectURL(url));
  const controls = document.createElement('div'); controls.className = 'preview-controls'; const info = document.createElement('span');
  const stage = document.createElement('div'); stage.className = 'image-preview'; const surface = document.createElement('div'); surface.className = 'image-surface'; const image = document.createElement('img'); image.alt = options.path.split('/').at(-1); image.src = url; surface.append(image); stage.append(surface);
  let zoom = 1; let rotate = 0; let fit = true;
  const update = () => {
    if (!image.naturalWidth) return;
    const turned = rotate % 180 !== 0; const width = turned ? image.naturalHeight : image.naturalWidth; const height = turned ? image.naturalWidth : image.naturalHeight;
    const scale = fit ? Math.min(1, Math.max(1, stage.clientWidth - 32) / width, Math.max(1, stage.clientHeight - 32) / height) : zoom;
    stage.classList.toggle('fit', fit); image.style.transform = `translate(-50%, -50%) rotate(${rotate}deg)`;
    image.style.width = `${image.naturalWidth * scale}px`; image.style.height = `${image.naturalHeight * scale}px`; surface.style.width = `${width * scale}px`; surface.style.height = `${height * scale}px`;
    info.textContent = `${image.naturalWidth} × ${image.naturalHeight} · ${fit ? '适应窗口' : Math.round(zoom * 100) + '%'}`;
  };
  controls.append(button('zoom-out', '缩小图片', () => { fit = false; zoom = Math.max(.1, zoom - .25); update(); }), button('zoom-in', '放大图片', () => { fit = false; zoom = Math.min(4, zoom + .25); update(); }), button('maximize', '图片适应窗口', () => { fit = true; update(); }), button('rotate', '旋转图片', () => { rotate = (rotate + 90) % 360; update(); }), info); container.append(controls, stage);
  container.addEventListener('wheel', event => { if (!event.ctrlKey) return; event.preventDefault(); fit = false; zoom = Math.max(.1, Math.min(4, zoom + (event.deltaY < 0 ? .25 : -.25))); update(); }, { passive: false, signal: options.signal });
  await image.decode(); check(options.signal);
  if (image.naturalWidth * image.naturalHeight > 50000000) { image.remove(); throw new Error('图片像素超过预览上限，请下载查看'); }
  const observer = new ResizeObserver(update); observer.observe(stage); options.cleanup(() => observer.disconnect());
  update();
}

async function pdfPreview(container, options) {
  if (options.mime !== 'application/pdf') throw new Error('该文件不是 PDF');
  const pdf = await import('/assets/pdf/pdf.mjs'); check(options.signal);
  pdf.GlobalWorkerOptions.workerSrc = '/assets/pdf/pdf.worker.mjs';
  const task = pdf.getDocument({ data: options.data, isEvalSupported: false, enableXfa: false, cMapUrl: '/assets/pdf/cmaps/', cMapPacked: true, standardFontDataUrl: '/assets/pdf/standard_fonts/', wasmUrl: '/assets/pdf/wasm/', iccUrl: '/assets/pdf/iccs/', useSystemFonts: true });
  let renderTask; let disposed = false;
  options.cleanup(() => { disposed = true; renderTask?.cancel(); task.destroy().catch(() => {}); });
  const documentProxy = await task.promise; check(options.signal);
  const controls = document.createElement('div'); controls.className = 'preview-controls'; const pageInput = document.createElement('input'); pageInput.type = 'number'; pageInput.min = '1'; pageInput.max = String(documentProxy.numPages); pageInput.value = '1'; pageInput.setAttribute('aria-label', 'PDF 页码');
  const count = document.createElement('span'); count.textContent = `/ ${documentProxy.numPages}`;
  const scroller = document.createElement('div'); scroller.className = 'pdf-preview'; const canvas = document.createElement('canvas'); canvas.setAttribute('aria-label', 'PDF 页面'); scroller.append(canvas);
  let current = 1; let scale = 1.25; let epoch = 0;
  const previous = button('left', 'PDF 上一页', () => show(current - 1)); const next = button('right', 'PDF 下一页', () => show(current + 1));
  controls.append(previous, pageInput, count, next, button('zoom-out', '缩小 PDF', () => { scale = Math.max(.4, scale - .25); show(current); }), button('zoom-in', '放大 PDF', () => { scale = Math.min(3, scale + .25); show(current); })); container.append(controls, scroller);
  pageInput.addEventListener('change', () => show(Number(pageInput.value)));
  container.addEventListener('wheel', event => { if (!event.ctrlKey) return; event.preventDefault(); scale = Math.max(.4, Math.min(3, scale + (event.deltaY < 0 ? .25 : -.25))); show(current); }, { passive: false, signal: options.signal });
  async function show(value) {
    current = Math.max(1, Math.min(documentProxy.numPages, Math.round(value) || 1)); pageInput.value = String(current); previous.disabled = current === 1; next.disabled = current === documentProxy.numPages;
    const generation = ++epoch;
    const pending = renderTask; pending?.cancel(); if (pending) await pending.promise.catch(() => {});
    if (disposed || generation !== epoch) return;
    try {
      if (!canvas.isConnected) scroller.replaceChildren(canvas);
      const page = await documentProxy.getPage(current); if (disposed || generation !== epoch) return;
      const raw = page.getViewport({ scale: 1 }); const viewport = page.getViewport({ scale: Math.min(scale, 4096 / raw.width, 8192 / raw.height) });
      const ratio = Math.min(devicePixelRatio || 1, 2, Math.sqrt(16000000 / (viewport.width * viewport.height)));
      canvas.width = Math.ceil(viewport.width * ratio); canvas.height = Math.ceil(viewport.height * ratio); canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
      renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0] }); await renderTask.promise;
    } catch (error) { if (!disposed && error.name !== 'RenderingCancelledException') { scroller.replaceChildren(status(`PDF 预览失败：${error.message}`, 'error')); } }
  }
  await show(1);
}

window.WorkbenchPreview = {
  kind(path) { return /\.pdf$/i.test(path) ? 'pdf' : /\.(png|jpe?g|gif|webp|bmp|ico)$/i.test(path) ? 'image' : 'text'; },
  async render(container, options) {
    check(options.signal);
    const renderer = { markdown: markdownPreview, json: jsonPreview, csv: csvPreview, image: imagePreview, pdf: pdfPreview }[options.kind];
    if (!renderer) throw new Error('不支持的打开方式');
    container.className = `preview-renderer kind-${options.kind}`;
    await renderer(container, options);
  }
};
