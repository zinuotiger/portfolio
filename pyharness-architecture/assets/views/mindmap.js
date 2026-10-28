'use strict';
(() => {
  const data = window.ARCHITECTURE_MINDMAP;
  if (!data) { document.getElementById('map-loading').textContent = '数据未能加载，请重新打开网页。'; return; }
  const $ = id => document.getElementById(id);
  const escape = text => String(text ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const plain = text => String(text ?? '').replace(/<br\s*\/?\s*>/gi, ' · ');
  const views = new Map(data.views.map(view => [view.id, view]));
  const files = new Map(data.files.map(file => [file.path, file]));
  const palettes = ['#39795b','#497d9c','#aa8241','#8a649f','#b46b57','#538f86'];
  const sessions = new Map();
  let view = views.get(new URLSearchParams(location.search).get('view')) || data.views[0];
  let state, model, visible = [], positions = new Map(), bounds, drag = null, keyboardFocus = false;
  let stacked = false;
  const gapX = 72, gapY = 24;

  function rememberFocus() {
    const el = document.activeElement;
    const scope = el?.closest('#graph-world,#node-inspector,#category-nav,#view-nav');
    return el?.tagName === 'BUTTON' && scope ? {scope:scope.id,data:{...el.dataset}} : null;
  }
  function restoreFocus(saved) {
    if (!saved) return;
    const scope = $(saved.scope);
    const target = scope && [...scope.querySelectorAll('button')].find(el => Object.entries(saved.data).every(([key,value]) => el.dataset[key] === value));
    (target || $('map-canvas')).focus({preventScroll:true});
  }

  function session(item) {
    if (!sessions.has(item.id)) sessions.set(item.id, {arch:new Set(item.readingHierarchy.roots.length === 1 ? item.readingHierarchy.roots : ['@root']), code:new Set(), symbols:new Set(), selected:null, scale:1, x:0, y:12, fit:true});
    return sessions.get(item.id);
  }
  function makeModel() {
    const nodes = new Map();
    const originals = new Map(view.nodes.map(node => [node.id, node]));
    function symbolNodes(symbols, owner, file, parent) {
      return symbols.map(symbol => {
        const key = owner + '::symbol:' + symbol.line + ':' + (symbol.qualified || symbol.name);
        const item = {key,type:'symbol',owner,file,symbol,parent,label:symbol.name + '（' + (symbol.label || '源码定义') + '）',note:symbol.description || '',children:[]};
        nodes.set(key,item);
        item.children = symbolNodes(symbol.children || [],owner,file,key);
        return key;
      });
    }
    for (const node of view.nodes) {
      const file = files.get(node.path);
      const item = {key:node.id,type:'component',owner:node.id,node,file,label:plain(node.label),note:node.note,parent:view.readingHierarchy.parents[node.id],children:view.readingHierarchy.children[node.id] || []};
      nodes.set(item.key,item);
      if (state.code.has(node.id) && file) {
        const key = node.id + '::file';
        const fileNode = {key,type:'file',owner:node.id,file,parent:node.id,label:file.path.split('/').pop() + '（关联源码文件）',note:file.note || '',children:[]};
        nodes.set(key,fileNode);
        fileNode.children = symbolNodes(file.symbols || [],node.id,file,key);
        item.fileKey = key;
      }
    }
    for (const group of view.groups || []) nodes.set(group.id,{key:group.id,type:'group',label:group.label,note:'职责阅读分组，不表示调用、执行先后或独立部署单元。',children:group.node_ids,parent:'@root'});
    let root = view.readingHierarchy.roots[0];
    if (view.readingHierarchy.roots.length !== 1) {
      root = '@root';
      nodes.set(root,{key:root,type:'root',label:view.title,note:'本图阅读起点；向两侧展开职责分组',children:view.readingHierarchy.roots});
      for (const key of view.readingHierarchy.roots) nodes.get(key).parent = root;
    }
    function children(item) {
      if (item.type === 'component') return [...(state.arch.has(item.key) ? item.children : []), ...(item.fileKey ? [item.fileKey] : [])];
      return (['root','group'].includes(item.type) ? state.arch : state.symbols).has(item.key) ? item.children : [];
    }
    const result = {nodes,root,originals,children};
    return result;
  }
  function reveal(owner) {
    let key = owner;
    while (view.readingHierarchy.parents[key]) { key = view.readingHierarchy.parents[key]; state.arch.add(key); }
    state.arch.add('@root');
  }
  function sourceUrl(item, directory = false) {
    const owner = model.nodes.get(item.owner || item.key);
    if (!owner?.file) return '';
    const file = item.file || owner.file;
    const line = item.symbol?.line || owner.node.line;
    const url = new URL(file.preview,location.href);
    url.searchParams.set('view',view.id);
    url.searchParams.set('reader','mindmap');
    url.searchParams.set('diagram',view.id);
    url.searchParams.set('start',line);
    url.searchParams.set('end',item.symbol?.end || owner.node.end || line);
    url.searchParams.set('node',owner.key);
    if (state.code.has(owner.key)) url.searchParams.set('code','1');
    if (item.type === 'file') url.searchParams.set('selection','file');
    if (item.symbol) { url.searchParams.set('symbol',String(item.symbol.line)); url.searchParams.set('definition',item.symbol.qualified || item.symbol.name); }
    url.hash = directory ? 'source-structure' : 'L' + line;
    return url.href;
  }
  function updateUrl() {
    const item = model.nodes.get(state.selected) || model.nodes.get(model.root);
    const url = new URL(location.href);
    url.search = '';
    url.searchParams.set('view',view.id);
    if (item.owner) {
      url.searchParams.set('node',item.owner);
      if (state.code.has(item.owner)) url.searchParams.set('code','1');
      if (item.type === 'file') url.searchParams.set('selection','file');
      if (item.symbol) { url.searchParams.set('symbol',String(item.symbol.line)); url.searchParams.set('definition',item.symbol.qualified || item.symbol.name); }
    }
    url.hash = 'mindmap';
    history.replaceState(null,'',url);
  }
  function labelParts(label) {
    const at = label.indexOf('（');
    if (at > 0) return '<strong>' + escape(label.slice(0,at).replace(/\s*·\s*$/,'')) + '</strong><span class="node-note">' + escape(label.slice(at)) + '</span>';
    return '<strong>' + escape(label) + '</strong>';
  }
  function nodeMarkup(item, root) {
    let actions = '', codeActions = '';
    const branchSet = ['component','root','group'].includes(item.type) ? state.arch : state.symbols;
    if (item.children.length) actions += '<button type="button" data-action="branch" data-key="' + escape(item.key) + '" aria-expanded="' + branchSet.has(item.key) + '" aria-label="' + escape((branchSet.has(item.key) ? '收起' : '展开') + item.label + '的' + (item.type === 'symbol' || item.type === 'file' ? '内部定义' : '架构分支')) + '">' + (branchSet.has(item.key) ? '－' : '＋') + (item.type === 'symbol' || item.type === 'file' ? ' 内部定义 ' : ' 分支 ') + item.children.length + '</button>';
    if (item.type === 'component' && item.file?.symbol_count) codeActions += '<button class="code-control" type="button" data-action="code" data-key="' + escape(item.key) + '" aria-expanded="' + state.code.has(item.key) + '" aria-label="' + escape((state.code.has(item.key) ? '收起' : '展开') + item.label + '关联文件的代码定义') + '">' + (state.code.has(item.key) ? '－' : '＋') + ' 代码 ' + item.file.symbol_count + '</button>';
    if (item.type === 'symbol' || item.type === 'file') codeActions += '<a href="' + escape(sourceUrl(item,item.type === 'file')) + '">' + (item.type === 'symbol' ? '源码第 ' + item.symbol.line + ' 行 ↗' : '打开源码目录 ↗') + '</a>';
    const kind = item.type === 'symbol' ? item.symbol.label : item.type === 'file' ? '源码文件' : item.type === 'root' ? '阅读起点' : item.type === 'group' ? '职责分组' : root ? '架构起点' : '架构组件';
    return '<div class="graph-node' + (root ? ' is-root' : '') + (['file','symbol'].includes(item.type) ? ' is-code' : '') + (state.selected === item.key ? ' is-selected' : '') + '" data-graph-key="' + escape(item.key) + '"><button type="button" class="node-title" data-action="select" data-key="' + escape(item.key) + '" aria-label="查看' + escape(item.label) + '的详情" aria-pressed="' + (state.selected === item.key) + '"><span class="node-kind">' + escape(kind) + '</span>' + '<span class="node-label">' + labelParts(item.label) + '</span></button>' + (actions ? '<div class="node-actions">' + actions + '</div>' : '') + (codeActions ? '<div class="node-actions node-code-actions">' + codeActions + '</div>' : '') + '</div>';
  }
  function render(anchor) {
    const focus = rememberFocus();
    const oldCard = anchor && [...$('graph-world').querySelectorAll('.graph-node')].find(el => el.dataset.graphKey === anchor);
    const oldTop = oldCard?.getBoundingClientRect().top;
    stacked = $('map-canvas').clientWidth < 720;
    model = makeModel();
    if (!model.nodes.has(state.selected)) state.selected = model.root;
    visible = [];
    function collect(key,depth,color) {
      const item = model.nodes.get(key);
      item.depth = depth;
      item.color = item.type === 'file' || item.type === 'symbol' ? '#8965a7' : color;
      visible.push(item);
      model.children(item).forEach((child,index) => collect(child,depth + 1,depth === 0 ? palettes[index % palettes.length] : color));
    }
    collect(model.root,0,'#39795b');
    $('graph-world').innerHTML = visible.map(item => nodeMarkup(item,item.key === model.root)).join('');
    const elements = new Map([...$('graph-world').querySelectorAll('.graph-node')].map(el => [el.dataset.graphKey,el]));
    // Measure the complete label and controls before laying out variable-width cards.
    const world = $('graph-world');
    world.classList.add('measuring');
    const naturalWidths = new Map([...elements].map(([key,element]) => [key,element.offsetWidth]));
    world.classList.remove('measuring');
    for (const item of visible) {
      const maxWidth = stacked ? Math.max(140, $('map-canvas').clientWidth - 52 - Math.min(item.depth,3)*8) : 860;
      item.width = Math.min(maxWidth,Math.max(258,naturalWidths.get(item.key)+3));
      elements.get(item.key).style.width = item.width + 'px';
    }
    function measure(key) {
      const item = model.nodes.get(key);
      item.height = elements.get(key).offsetHeight;
      const children = model.children(item);
      item.total = Math.max(item.height,children.reduce((n,c) => n + measure(c),0) + Math.max(0,children.length - 1) * gapY);
      return item.total;
    }
    measure(model.root);
    positions = new Map();
    const root = model.nodes.get(model.root);
    positions.set(root.key,{x:0,y:-root.height / 2});
    function place(key,x,center,direction) {
      const item = model.nodes.get(key);
      positions.set(key,{x,y:center - item.height / 2});
      const children = model.children(item);
      let y = center - (children.reduce((sum,c) => sum + model.nodes.get(c).total,0) + Math.max(0,children.length - 1) * gapY) / 2;
      for (const child of children) { const childItem = model.nodes.get(child); place(child,direction > 0 ? x + item.width + gapX : x - childItem.width - gapX,y + childItem.total / 2,direction); y += childItem.total + gapY; }
    }
    const branches = model.children(root);
    const sides = branches.length < 2 ? [[],branches] : [branches.slice(0,Math.ceil(branches.length / 2)),branches.slice(Math.ceil(branches.length / 2))];
    sides.forEach((keys,index) => {
      let y = -(keys.reduce((sum,key) => sum + model.nodes.get(key).total,0) + Math.max(0,keys.length - 1) * gapY) / 2;
      for (const key of keys) { const item = model.nodes.get(key); place(key,index === 0 ? -item.width-gapX : root.width+gapX,y + item.total / 2,index === 0 ? -1 : 1); y += item.total + gapY; }
    });
    if (stacked) {
      let top = 0;
      for (const item of visible) { positions.set(item.key,{x:Math.min(item.depth,3)*8,y:top}); top += item.height + gapY; }
    }
    const padding = stacked ? 14 : 48;
    const minX = Math.min(...[...positions.values()].map(p => p.x)) - padding;
    const minY = Math.min(...[...positions.values()].map(p => p.y)) - padding;
    bounds = {width:Math.max(...visible.map(item => positions.get(item.key).x + item.width)) - minX + padding,height:Math.max(...visible.map(item => positions.get(item.key).y + item.height)) - minY + padding};
    for (const item of visible) {
      const point = positions.get(item.key); point.x -= minX; point.y -= minY;
      const element = elements.get(item.key);
      element.style.left = point.x + 'px'; element.style.top = point.y + 'px'; element.style.setProperty('--branch-color',item.color);
    }
    drawEdges();
    transform();
    if (oldTop >= 0 && oldTop < innerHeight && elements.has(anchor)) window.scrollBy({top:elements.get(anchor).getBoundingClientRect().top-oldTop,behavior:'instant'});
    $('map-loading').hidden = true;
    $('map-status').textContent = '当前显示 ' + visible.filter(n => n.type === 'component').length + ' / ' + view.nodes.length + ' 个组件 · ' + visible.filter(n => n.type === 'symbol').length + ' 个代码定义';
    renderInspector();
    restoreFocus(focus);
  }
  function drawEdges() {
    let paths = '';
    for (const parent of visible) {
      for (const key of model.children(parent)) {
        const child = model.nodes.get(key),a = positions.get(parent.key),b = positions.get(key);
        const right = b.x > a.x, x1 = a.x + (right ? parent.width : 0),x2 = b.x + (right ? 0 : child.width),y1 = a.y + parent.height / 2,y2 = b.y + child.height / 2;
        const curve = stacked ? 'M'+a.x+','+y1+' H'+(Math.min(a.x,b.x)-8)+' V'+y2+' H'+b.x : 'M'+x1+','+y1+' C'+((x1+x2)/2)+','+y1+' '+((x1+x2)/2)+','+y2+' '+x2+','+y2;
        paths += '<path d="' + curve + '" fill="none" stroke="' + child.color + '" stroke-width="2" opacity=".55"/>';
      }
    }
    let real = '';
    if ($('show-relations').checked) {
      for (const edge of view.edges) {
        const a = positions.get(edge.source),b = positions.get(edge.target);
        if (!a || !b) continue;
        const na = model.nodes.get(edge.source),nb = model.nodes.get(edge.target);
        const x1 = a.x + na.width / 2,x2 = b.x + nb.width / 2,y1 = a.y + na.height,y2 = b.y + nb.height;
        real += '<path d="M' + x1 + ',' + y1 + ' Q' + ((x1+x2)/2) + ',' + (Math.max(y1,y2)+55) + ' ' + x2 + ',' + y2 + '" fill="none" stroke="#78867d" stroke-dasharray="5 5" stroke-width="1.5" opacity=".7"' + (edge.undirected ? '' : ' marker-end="url(#real-arrow)"') + '><title>' + escape((edge.undirected ? '无向关联：' : '源码关系：') + edge.source + (edge.undirected ? ' — ' : ' → ') + edge.target + ' ' + plain(edge.label)) + '</title></path>';
      }
    }
    $('graph-world').querySelector('svg')?.remove();
    $('graph-world').insertAdjacentHTML('afterbegin','<svg width="' + bounds.width + '" height="' + (bounds.height + 80) + '" aria-hidden="true"><defs><marker id="real-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0 L7 3.5 L0 7Z" fill="#78867d"/></marker></defs>' + paths + real + '</svg>');
    $('graph-world').style.width = bounds.width + 'px'; $('graph-world').style.height = bounds.height + 'px';
  }
  function transform() {
    const canvas = $('map-canvas'), available = canvas.clientWidth;
    if (state.fit) state.scale = Math.min(1, Math.max(.005,(available-24)/bounds.width));
    const overflow = Math.max(0,bounds.width*state.scale-available);
    state.x = overflow ? Math.max(-overflow,Math.min(0,state.x)) : (available-bounds.width*state.scale)/2;
    state.y = 12;
    canvas.style.height = Math.ceil(Math.max(360,(bounds.height+80)*state.scale+24))+'px';
    $('graph-world').style.transform = 'translate(' + state.x + 'px,' + state.y + 'px) scale(' + state.scale + ')';
    $('zoom-level').textContent = Math.round(state.scale * 100) + '%';
    $('zoom-out').disabled = state.scale <= .005;
    $('zoom-in').disabled = state.scale >= 1.8;
  }
  function centerNode(key, scroll = false) {
    const point = positions.get(key) || positions.get(model.root), item = model.nodes.get(key) || model.nodes.get(model.root);
    const box = $('map-canvas');
    state.x = box.clientWidth / 2 - (point.x + item.width / 2) * state.scale;
    transform();
    if (scroll) [...$('graph-world').querySelectorAll('.graph-node')].find(el => el.dataset.graphKey === (positions.has(key) ? key : model.root))?.scrollIntoView({block:'center',behavior:'instant'});
  }
  function focusExpansion(key) {
    // Read newly revealed content at its current readable scale, without fitting the whole graph.
    const children = model.children(model.nodes.get(key));
    if (!children.length) { centerNode(key,true); return; }
    const revealed = [];
    function collect(child) {
      const item = model.nodes.get(child);
      if (!positions.has(child)) return;
      revealed.push(item);
      model.children(item).forEach(collect);
    }
    children.forEach(collect);
    const first = revealed.reduce((top,item) => positions.get(item.key).y < positions.get(top.key).y ? item : top);
    const point = positions.get(first.key), canvas = $('map-canvas');
    state.selected = first.key;
    for (const card of $('graph-world').querySelectorAll('.graph-node')) {
      const selected = card.dataset.graphKey === state.selected;
      card.classList.toggle('is-selected',selected);
      card.querySelector('.node-title').setAttribute('aria-pressed',String(selected));
    }
    renderInspector();
    const left = Math.min(...revealed.map(item => positions.get(item.key).x));
    const right = Math.max(...revealed.map(item => positions.get(item.key).x + item.width));
    // Include the file and its definitions together when they fit at readable size.
    const center = (right-left)*state.scale <= canvas.clientWidth-32 ? (left+right)/2 : point.x+first.width/2;
    state.x = canvas.clientWidth/2-center*state.scale;
    transform();
    const top = Math.min(...revealed.map(item => positions.get(item.key).y));
    const toolbarHeight = document.querySelector('.map-section>.toolbar').getBoundingClientRect().height;
    window.scrollTo({top:window.scrollY+canvas.getBoundingClientRect().top+state.y+top*state.scale-toolbarHeight-20,behavior:'instant'});
  }
  function zoom(factor) {
    const next = Math.min(1.8,Math.max(.005,state.scale * factor)),ratio = next / state.scale;
    const canvas = $('map-canvas');
    const anchorY = Math.max(0,-canvas.getBoundingClientRect().top + Math.min(innerHeight/2,280));
    state.fit = false;
    state.x = canvas.clientWidth/2 - (canvas.clientWidth/2 - state.x) * ratio;
    state.scale = next; transform();
    window.scrollBy({top:anchorY*(ratio-1),behavior:'instant'});
  }
  function select(key, focusCanvas = false) {
    const item = model.nodes.get(key);
    if (!item) return;
    state.selected = key;
    if (item.owner) reveal(item.owner);
    render(); centerNode(key,focusCanvas); updateUrl();
  }
  function rowsMarkup(rows) {
    return rows.map(row => '<dl class="fields">' + [['responsibility','职责'],['input','输入'],['output','输出'],['boundary','边界']].map(([key,label]) => '<div><dt>' + label + '</dt><dd>' + escape(row[key]) + '</dd></div>').join('') + '</dl>').join('');
  }
  function relationMarkup(owner,mode) {
    const edges = view.edges.filter(e => mode === 'related' ? e.undirected && (e.source === owner || e.target === owner) : !e.undirected && (mode === 'in' ? e.target === owner : e.source === owner));
    if (!edges.length) return '<p class="muted">本图未列出此类关系。</p>';
    return '<ul>' + edges.map(edge => {
      const other = mode === 'in' || (mode === 'related' && edge.target === owner) ? edge.source : edge.target;
      return '<li><span>' + escape(plain(edge.label) || (mode === 'related' ? '无向关联' : '源码关系')) + '</span><button type="button" data-action="reveal" data-key="' + escape(other) + '">' + escape(plain(model.originals.get(other).label)) + '</button></li>';
    }).join('') + '</ul>';
  }
  function evidenceMarkup(owner){
    if(!owner?.node?.sources)return '';
    return '<section class="source-extra"><h4>全部源码依据 · GitHub 固定提交</h4><ul>'+owner.node.sources.map(r=>{const q=new URLSearchParams({reader:'mindmap',diagram:view.id,node:owner.key,start:r.start,end:r.end});return '<li>'+escape(r.path)+' · L'+r.start+'–L'+r.end+'<small>'+escape(r.symbol||'实现依据')+'</small><a href="sources/'+escape(r.path)+'.html?'+escape(q)+'#L'+r.start+'">完整源码预览 ↗</a><a href="'+data.snapshot.repo+'/blob/'+data.snapshot.sha+'/'+escape(r.path)+'#L'+r.start+'-L'+r.end+'" target="_blank" rel="noopener noreferrer">GitHub 固定行号 ↗</a></li>';}).join('')+'</ul><a href="architecture-detailed.html?node='+escape(owner.key)+'">在六层源码交互图定位此组件 ↗</a></section>';
  }
  function renderInspector() {
    const item = model.nodes.get(state.selected);
    const owner = model.nodes.get(item.owner);
    const english = owner?.label.split(/[（(]/)[0].replace(/\s*·\s*$/,'').trim();
    const rows = item.type === 'component' ? view.rows.filter(row => row.module.includes(english + '（')) : [];
    const source = item.file ? '<div class="source-actions"><a href="' + escape(sourceUrl(item)) + '">查看源码 · 第 ' + (item.symbol?.line || owner.node.line) + ' 行 ↗</a><a href="' + escape(sourceUrl(item,true)) + '">打开源码结构目录 ↗</a>' + (item.type === 'component' && item.file.symbol_count ? '<button type="button" data-action="code" data-key="' + escape(item.key) + '" aria-expanded="' + state.code.has(item.key) + '">' + (state.code.has(item.key) ? '收起' : '在图中展开') + '代码 · ' + item.file.symbol_count + ' 个定义</button>' : '') + '</div><p class="file-location">' + escape(item.file.path) + '</p>' : '';
    const related = owner ? '<div class="relations"><section><h4>上游 · 来自哪些组件</h4>' + relationMarkup(owner.key,'in') + '</section><section><h4>下游 · 连接哪些组件</h4>' + relationMarkup(owner.key,'out') + '</section><section><h4>相关组件 · 无方向关联</h4>' + relationMarkup(owner.key,'related') + '</section></div>' : '';
    $('node-inspector').innerHTML = '<div class="inspector-head"><div><p class="eyebrow">' + (item.type === 'symbol' ? '代码定义 · 属于 ' + escape(owner.label) : '所选节点 · ' + escape(view.title)) + '</p><h3 id="inspector-title">' + escape(item.label) + '</h3></div><a href="#mindmap">回到导图 ↑</a></div><p class="purpose">' + escape(item.note || '选择分支上的组件，查看职责、真实关系和源码。') + '</p>' + rowsMarkup(rows) + source + (item.type === 'component' && !rows.length ? '<p class="muted">本图完整职责表可在页面下方展开。</p>' : '') + related + evidenceMarkup(owner) + '<p class="tip">导图上的“代码”展开关联文件的完整定义结构；它不表示这些定义全部属于当前组件。</p>';
  }
  function renderOutline() {
    const originals = new Map([...view.nodes.map(node => [node.id,node]),...(view.groups||[]).map(g=>[g.id,{id:g.id,label:g.label}])]);
    function branch(key) {
      const node = originals.get(key),children = view.readingHierarchy.children[key] || [];
      const button = '<button type="button" data-action="'+((view.groups||[]).some(g=>g.id===key)?'select':'reveal')+'" data-key="' + escape(key) + '">' + escape(plain(node.label)) + '</button>';
      return '<li>' + (children.length ? '<details><summary>' + escape(plain(node.label)) + ' · ' + children.length + ' 个分支</summary>' + button + '<ul>' + children.map(branch).join('') + '</ul></details>' : button) + '</li>';
    }
    $('outline').innerHTML = '<ul>' + view.readingHierarchy.roots.map(branch).join('') + '</ul>';
    $('responsibility-list').innerHTML = view.rows.length ? view.rows.map(row => '<section class="responsibility-row"><h4>' + escape(row.module) + '</h4>' + rowsMarkup([row]) + '</section>').join('') : '<p class="muted">此总览的职责说明见组件详情与本类专题图。</p>';
  }
  function showView(id, owner, writeHistory = true) {
    const focus = rememberFocus();
    view = views.get(id) || view;
    state = session(view);
    const category = data.categories.find(c => c.id === view.major);
    $('category-nav').innerHTML = data.categories.map((c,index) => '<button type="button" data-category="' + escape(c.id) + '" class="' + (c.id === category.id ? 'active' : '') + '" aria-pressed="' + (c.id === category.id) + '"><b>' + (c.id==='source'?'全':'0'+(index+1)) + '</b><strong>' + escape(c.label) + '</strong><span>' + escape(c.english) + '</span></button>').join('');
    $('view-title').textContent = view.title;
    $('category-description').textContent = category.description;
    $('view-counts').textContent = view.nodes.length + ' 个组件 · ' + view.edges.length + ' 条关系';
    $('view-description').textContent = view.description || '';
    $('category-boundaries').innerHTML = [...(category.notes || view.categoryNotes || []),view.boundary].filter(Boolean).map(note => '<li>' + escape(note) + '</li>').join('');
    $('view-nav').innerHTML = category.viewIds.map((id,index) => '<button type="button" data-view="' + escape(id) + '" class="' + (id === view.id ? 'active' : '') + '" aria-pressed="' + (id === view.id) + '">' + (index === 0 ? '本类总览' : escape(views.get(id).title)) + '</button>').join('');
    if (owner && view.nodes.some(n => n.id === owner)) { reveal(owner); state.selected = owner; state.fit = true; }
    render(); renderOutline();
    if (writeHistory) updateUrl();
    restoreFocus(focus);
  }
  function search() {
    const term = $('node-search').value.trim().toLocaleLowerCase();
    $('search-results').hidden = !term;
    if (!term) { $('search-status').textContent = ''; $('search-results').innerHTML = ''; return; }
    const found=data.nodeIndex.filter(n=>[n.name,n.purpose,n.boundary,...n.evidence.map(r=>r.path)].join(' ').toLocaleLowerCase().includes(term));
    $('search-status').textContent='找到 '+found.length+' / '+data.nodeIndex.length+' 个组件，按六层职责分组；选择后在完整目录中定位。';
    $('search-results').innerHTML=data.layers.map(layer=>{const matches=found.filter(n=>layer.ids.includes(n.id));if(!matches.length)return '';return '<li class="search-group"><h3>'+escape(layer.label)+' · '+matches.length+' 个组件</h3><ul>'+matches.map(n=>'<li><button type="button" data-search-view="source-index" data-search-node="'+escape(n.id)+'">'+escape(n.name)+'<small>'+escape(n.purpose)+'</small></button></li>').join('')+'</ul></li>';}).join('');
  }
  document.addEventListener('click',event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.category) { showView(data.categories.find(c => c.id === button.dataset.category).viewIds[0]); return; }
    if (button.dataset.view) { showView(button.dataset.view); return; }
    if (button.dataset.searchView) { showView(button.dataset.searchView,button.dataset.searchNode); centerNode(button.dataset.searchNode,true); return; }
    const {action,key} = button.dataset;
    if (!action) return;
    if (action === 'reveal') { reveal(key); select(key,true); }
    if (action === 'select') select(key);
    if (action === 'branch') {
      const item = model.nodes.get(key),set = ['component','root','group'].includes(item.type) ? state.arch : state.symbols;
      const opening = !set.has(key);
      if (opening) set.add(key); else set.delete(key);
      state.selected = opening ? item.children[0] || key : key;
      state.fit = false;
      if (opening) state.scale = Math.max(1,state.scale);
      render();
      if (opening) focusExpansion(key); else centerNode(key,true);
      updateUrl();
    }
    if (action === 'code') {
      const opening = !state.code.has(key);
      if (opening) { state.code.add(key); state.symbols.add(key + '::file'); } else state.code.delete(key);
      state.selected = opening ? key + '::file' : key;
      state.fit = false;
      if (opening) state.scale = Math.max(1,state.scale);
      render();
      if (opening) focusExpansion(key); else centerNode(key,true);
      updateUrl();
    }
  });
  document.addEventListener('pointerdown',() => { keyboardFocus = false; },true);
  document.addEventListener('keydown',event => { if (['Tab','Enter',' ','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) keyboardFocus = true; },true);
  $('expand-architecture').addEventListener('click',() => { view.nodes.forEach(n => state.arch.add(n.id)); (view.groups||[]).forEach(g=>state.arch.add(g.id)); state.arch.add('@root'); state.fit=false; state.scale=Math.max(1,state.scale); render(); centerNode(state.selected,true); });
  $('collapse-architecture').addEventListener('click',() => { state.arch.clear(); state.code.clear(); state.symbols.clear(); state.selected = model.root; state.fit=true; render(); centerNode(model.root,true); updateUrl(); });
  $('zoom-in').addEventListener('click',() => zoom(1.2));
  $('zoom-out').addEventListener('click',() => zoom(1/1.2));
  $('focus-selection').addEventListener('click',() => { state.fit=false;state.scale=1;centerNode(state.selected,true); });
  $('fit-map').addEventListener('click',() => { state.fit=true;transform();$('map-canvas').scrollIntoView({block:'start',behavior:'instant'}); });
  $('show-relations').addEventListener('change',drawEdges);
  $('node-search').addEventListener('input',search);
  $('search-form').addEventListener('submit',event => event.preventDefault());
  $('clear-search').addEventListener('click',() => { $('node-search').value = ''; search(); $('node-search').focus(); });
  const canvas = $('map-canvas');
  canvas.addEventListener('pointerdown',event => {
    if (event.button !== 0 || event.pointerType === 'touch' || event.target.closest('button,a')) return;
    drag = {id:event.pointerId,x:event.clientX,y:event.clientY,panX:state.x,scrollY:window.scrollY};
    canvas.setPointerCapture(event.pointerId); canvas.classList.add('dragging'); event.preventDefault();
  });
  canvas.addEventListener('pointermove',event => { if (drag && drag.id === event.pointerId) { state.x = drag.panX + event.clientX - drag.x; transform(); window.scrollTo({top:drag.scrollY+drag.y-event.clientY,behavior:'instant'}); } });
  const stopDrag = () => { drag = null; canvas.classList.remove('dragging'); };
  canvas.addEventListener('pointerup',stopDrag); canvas.addEventListener('pointercancel',stopDrag);
  canvas.addEventListener('keydown',event => {
    if (event.target !== canvas) return;
    const delta = {ArrowLeft:[70,0],ArrowRight:[-70,0],ArrowUp:[0,70],ArrowDown:[0,-70]}[event.key];
    if (delta) { event.preventDefault(); state.x += delta[0]; transform(); if(delta[1]) window.scrollBy({top:-delta[1],behavior:'instant'}); }
    if (['+','=','-','_'].includes(event.key)) { event.preventDefault(); zoom(event.key === '-' || event.key === '_' ? 1/1.2 : 1.2); }
  });
  canvas.addEventListener('focusin',event => {
    if (!keyboardFocus) return;
    const card = event.target.closest('.graph-node');
    if (!card) return;
    const rect = event.target.getBoundingClientRect(),area = canvas.getBoundingClientRect();
    if (rect.left < area.left || rect.right > area.right || rect.top < 80 || rect.bottom > innerHeight) centerNode(card.dataset.graphKey,true);
  });
  let observedWidth = 0;
  new ResizeObserver(() => { const next=canvas.clientWidth;if(state&&model&&next!==observedWidth){observedWidth=next;render();if(!state.fit)centerNode(state.selected,true);} }).observe(canvas);
  function fromUrl() {
    const params = new URLSearchParams(location.search);
    showView(params.get('view') || view.id,params.get('node'),false);
    const owner = params.get('node'),line = Number(params.get('symbol')),definition = params.get('definition');
    if (owner && view.nodes.some(n => n.id === owner) && (params.get('code') === '1' || line > 0)) {
      state.code.add(owner); state.symbols.add(owner + '::file'); model = makeModel();
      if (params.get('selection') === 'file') state.selected = owner + '::file';
      const candidates = [...model.nodes.values()].filter(n => n.owner === owner && n.symbol?.line === line && (!definition || (n.symbol.qualified || n.symbol.name) === definition));
      const symbol = candidates.length === 1 ? candidates[0] : null;
      if (symbol) { let key = symbol.parent; while (key && model.nodes.has(key)) { state.symbols.add(key); key = model.nodes.get(key).parent; } state.selected = symbol.key; }
      render();
    }
    if (owner) {
      const locate = () => requestAnimationFrame(() => requestAnimationFrame(() => { state.fit=false;state.scale=Math.max(1,state.scale);centerNode(state.selected,true); }));
      if (document.readyState === 'complete') locate(); else window.addEventListener('load',locate,{once:true});
    }
  }
  window.addEventListener('popstate',fromUrl);
  fromUrl();
})();
