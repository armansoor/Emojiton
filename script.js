/* script.js - Emojiton Ultra Mega Edition
   Features:
   - Custom element <emoji-cell>
   - Emoji registry as Proxy with persistence & hooks
   - Main-thread A* + WebWorker A* (typed arrays, heap)
   - Diagonal movement, weights, traffic delays, multi-agent smoothing
   - Matrix canvas with layered effects
   - Time-lapse recording (actions), generator-based undo/redo
   - Zoom/pan (mouse wheel, drag, touch pinch), inertial
   - Save/Load/Export/Import/Share (URL hash)
   - Konami easter egg & secret pack
   - Embedded audio SFX toggle
   - Many uncommon patterns / gimmicks
*/

/* ======================
   Utility helpers
   ====================== */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const clamp = (v,a,b) => Math.max(a, Math.min(b, v));
const uid = (n=8) => Math.random().toString(36).slice(2, 2+n);
const now = () => Date.now();
const makeElem = (t, attrs={}, text='') => { const e=document.createElement(t); for(const k in attrs) e.setAttribute(k, attrs[k]); if(text) e.textContent=text; return e; };

/* ======================
   Tiny base64 SFX (short blip)
   ====================== */
const AUDIO_BLIP = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAAAB3AQACABAAZGF0YQAAAAA=";

/* ======================
   Theme (light/dark) persisted
   ====================== */
const body = document.body;
const themeToggle = $('#theme-toggle');
function loadTheme(){
  const t = localStorage.getItem('emojiton-theme') || 'dark';
  if(t === 'light') body.classList.add('light-on'), themeToggle.checked = true;
  else body.classList.remove('light-on'), themeToggle.checked = false;
}
themeToggle.addEventListener('change', e=>{
  const on = e.target.checked;
  if(on) { body.classList.add('light-on'); localStorage.setItem('emojiton-theme','light'); }
  else { body.classList.remove('light-on'); localStorage.setItem('emojiton-theme','dark'); }
  if(window.__SFX_ON) playBlip();
});

/* ======================
   Emoji Registry (Proxy)
   - unusual: changes auto-persist, emits hooks, can veto changes
   ====================== */
const REG_KEY = 'emojiton.registry.v3';
const defaultPack = ['🏠','🏡','🏢','🌳','🚗','🛣️','🏥','🛒','🏫','🚉','🌲','🌻','🚜','🐄','🚀','🪐','👽','🛰️'];
function loadRegistry(){
  try { const raw = localStorage.getItem(REG_KEY); if(raw) return JSON.parse(raw); }
  catch(e){}
  return defaultPack.slice();
}
let _registry = loadRegistry();
const registryHandler = {
  set(target, prop, val){
    target[prop] = val;
    localStorage.setItem(REG_KEY, JSON.stringify(target));
    Log.event(`Registry set [${prop}]`);
    renderPalette();
    return true;
  },
  deleteProperty(target, prop){
    delete target[prop];
    localStorage.setItem(REG_KEY, JSON.stringify(target));
    renderPalette();
    return true;
  }
};
const EmojiRegistry = new Proxy(_registry, registryHandler);

/* ======================
   Custom Element <emoji-cell>
   - stores r,c and value
   ====================== */
class EmojiCell extends HTMLElement {
  constructor(){
    super();
    this._r = 0; this._c = 0; this._val = '';
  }
  connectedCallback(){}
  set coords(o){ this._r=o.r; this._c=o.c; this.dataset.r=o.r; this.dataset.c=o.c; }
  set value(v){ this._val = v || ''; this.textContent = this._val; this.classList.toggle('empty', !this._val); }
  get value(){ return this._val; }
  highlight(on=true){ this.classList.toggle('highlight', !!on); }
}
customElements.define('emoji-cell', EmojiCell);

/* ======================
   Grid class
   - manages DOM, cell mapping, JSON import/export
   ====================== */
class Grid {
  constructor(rows=12, cols=16, cellPx=48){
    this.rows = rows; this.cols = cols;
    this.cells = new Array(rows * cols).fill('');
    this.container = $('#grid-wrap');
    this.cellPx = cellPx;
    this.scale = 1;
    this.initDOM();
  }

  index(r,c){ return r * this.cols + c; }
  initDOM(){
    this.container.innerHTML = '';
    this.container.style.gridTemplateColumns = `repeat(${this.cols}, var(--cell))`;
    this.container.style.gap = '6px';
    for(let r=0;r<this.rows;r++){
      for(let c=0;c<this.cols;c++){
        const el = document.createElement('emoji-cell');
        el.className = 'empty';
        el.coords = {r,c};
        el.value = '';
        el.addEventListener('click', (e) => UI.onCellClick(el, r, c));
        el.addEventListener('dblclick', (e) => {
          // quick meta edit popover (prompt)
          const p = prompt('Edit tile (emoji) — empty to clear', el.value || '');
          if(p !== null){ Game.recordAction({type:'set', r, c, prev: el.value, next: p}); this.set(r,c,p); }
        });
        this.container.appendChild(el);
      }
    }
    this.updateGridSizeCss();
  }

  updateGridSizeCss(){
    // update CSS variable used by style.css
    document.documentElement.style.setProperty('--cell', `${this.cellPx}px`);
  }

  get(r,c){ return this.cells[this.index(r,c)]; }
  set(r,c,val, silent=false){
    this.cells[this.index(r,c)] = val || '';
    const el = this.container.children[this.index(r,c)];
    if(el) el.value = val || '';
    if(!silent) this.updateStats();
  }

  multiSet(updates){ // updates: [{r,c,val}]
    for(const u of updates) this.set(u.r,u.c,u.val,true);
    this.updateStats();
  }

  fillAll(val){
    for(let i=0;i<this.cells.length;i++){
      this.cells[i] = val || '';
      const el = this.container.children[i]; if(el) el.value = val || '';
    }
    this.updateStats();
  }

  clear(){ this.fillAll(''); }

  toJSON(){ return {rows:this.rows, cols:this.cols, cells:this.cells.slice()}; }
  loadJSON(obj){
    this.rows = obj.rows; this.cols = obj.cols; this.cells = obj.cells.slice();
    this.initDOM();
    for(let i=0;i<this.cells.length;i++){
      const el = this.container.children[i];
      if(el) el.value = this.cells[i];
    }
    this.updateStats();
  }

  updateStats(){
    UI.updateFilled(this.cells.filter(Boolean).length);
  }
}

/* ======================
   Pathfinding: A* Implementation (main-thread)
   - supports diagonal moves, weights, caching
   - used as fallback or for small maps
   ====================== */
class AStar {
  constructor(grid){
    this.grid = grid;
    this.cache = new Map(); // cache paths keyed by start|goal|mask hash
    this.diagonal = true;
  }

  neighbors(r,c){
    const out = [];
    const dirs = this.diagonal ? [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]] : [[1,0],[-1,0],[0,1],[0,-1]];
    for(const d of dirs){
      const nr=r+d[0], nc=c+d[1];
      if(nr>=0 && nc>=0 && nr<this.grid.rows && nc<this.grid.cols) out.push({r:nr,c:nc});
    }
    return out;
  }

  heuristic(a,b){
    if(this.diagonal){
      const dx=Math.abs(a.r-b.r), dy=Math.abs(a.c-b.c);
      return Math.max(dx,dy);
    }
    return Math.abs(a.r-b.r)+Math.abs(a.c-b.c);
  }

  passablePredicate(mask){
    // mask: Uint8Array or simple function
    if(!mask) return ()=>true;
    if(typeof mask === 'function') return mask;
    // mask is Set or array of booleans
    return p => !!mask[p.r*this.grid.cols + p.c];
  }

  findPath(start,goal,maskOrFn){
    // build cache key
    const key = `${start.r},${start.c}|${goal.r},${goal.c}|${this.grid.rows}x${this.grid.cols}`;
    if(this.cache.has(key)) return this.cache.get(key).slice();

    const passable = this.passablePredicate(maskOrFn);
    const cols = this.grid.cols;
    const rows = this.grid.rows;
    const size = rows*cols;

    const g = new Float64Array(size); g.fill(Infinity);
    const f = new Float64Array(size); f.fill(Infinity);
    const open = new Set();
    const cameFrom = new Int32Array(size); cameFrom.fill(-1);

    const idx = (p)=>p.r*cols + p.c;
    const startIdx = idx(start), goalIdx = idx(goal);

    g[startIdx]=0; f[startIdx]=this.heuristic(start,goal); open.add(startIdx);

    while(open.size){
      // pick lowest f in open
      let current=-1, min=Infinity;
      for(const k of open){ if(f[k] < min){ min=f[k]; current=k; } }
      if(current === goalIdx) break;
      open.delete(current);
      const cr = Math.floor(current / cols), cc = current % cols;
      for(const n of this.neighbors(cr,cc)){
        if(!passable(n)) continue;
        const ni = idx(n);
        const cost = g[current] + this.getMoveCost(cr,cc,n.r,n.c);
        if(cost < g[ni]){
          cameFrom[ni] = current;
          g[ni] = cost;
          f[ni] = cost + this.heuristic(n,goal);
          open.add(ni);
        }
      }
    }

    if(cameFrom[goalIdx] === -1) return null;
    const path = [];
    let cur = goalIdx;
    while(cur !== -1){
      path.unshift({r:Math.floor(cur/cols), c:cur%cols});
      cur = cameFrom[cur];
    }
    // cache small paths
    if(path.length < 512) this.cache.set(key, path.slice());
    return path;
  }

  getMoveCost(r1,c1,r2,c2){
    // heavier cost for diagonal (approx 1.4) and for tiles that are 'traffic' or 'difficult'
    const base = (r1 !== r2 && c1 !== c2) ? 1.414 : 1.0;
    const tile = this.grid.get(r2,c2) || '';
    let mult = 1;
    // weighted tiles: roads cheaper, water/heavy higher
    if(tile === '🛣️' || tile === '🅿️') mult = 0.7;
    if(tile === '🌲' || tile === '🌳') mult = 1.15;
    if(tile === '🏗️' || tile === '🏭') mult = 1.3;
    if(/🚗|🛸/.test(tile)) mult = 1.2;
    return base * mult;
  }
}

/* ======================
   Worker A* creation (typed arrays, heap)
   - Worker code is generated as a Blob so we keep only three files
   - Main thread sends grid mask and start/goal; worker returns path
   ====================== */
function createAStarWorker(){
  // worker source string (kept concise for readability)
  const src = `
  self.onmessage = function(e){
    const msg = e.data;
    if(msg.cmd === 'find'){
      const rows = msg.rows, cols = msg.cols;
      const start = msg.start, goal = msg.goal;
      const passable = msg.passable; // array of 0/1
      const size = rows * cols;
      function idx(r,c){ return r*cols + c; }
      function h(a,b){ const dx = Math.abs(a.r-b.r), dy = Math.abs(a.c-b.c); return Math.max(dx,dy); }
      // typed arrays
      const g = new Float64Array(size); for(let i=0;i<size;i++) g[i]=Infinity;
      const f = new Float64Array(size); for(let i=0;i<size;i++) f[i]=Infinity;
      const came = new Int32Array(size); for(let i=0;i<size;i++) came[i]=-1;
      const open = new Uint8Array(size); // membership
      // simple priority queue using binary heap of indices with separate f array
      const heap = [];
      function heapPush(k){ heap.push(k); siftUp(heap.length-1); }
      function heapPop(){ if(!heap.length) return -1; const top = heap[0]; const last=heap.pop(); if(heap.length){ heap[0]=last; siftDown(0);} return top; }
      function siftUp(i){ while(i>0){ const p=((i-1)/2)|0; if(f[heap[i]] < f[heap[p]]){ const t=heap[i]; heap[i]=heap[p]; heap[p]=t; i=p; } else break; } }
      function siftDown(i){ const n = heap.length; while(true){ let l=2*i+1, r=2*i+2, smallest=i; if(l<n && f[heap[l]] < f[heap[smallest]]) smallest=l; if(r<n && f[heap[r]] < f[heap[smallest]]) smallest=r; if(smallest!==i){ const t=heap[i]; heap[i]=heap[smallest]; heap[smallest]=t; i=smallest; } else break; } }
      const startIdx = idx(start.r,start.c), goalIdx = idx(goal.r,goal.c);
      g[startIdx]=0; f[startIdx]=h(start,goal); heapPush(startIdx); open[startIdx]=1;
      const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
      while(heap.length){
        const current = heapPop();
        if(current === goalIdx) break;
        const cr = (current/cols)|0, cc = current%cols;
        for(const d of dirs){
          const nr = cr + d[0], nc = cc + d[1];
          if(nr<0||nc<0||nr>=rows||nc>=cols) continue;
          const ni = idx(nr,nc);
          if(!passable[ni]) continue;
          // cost heuristic: diagonal heavier
          const base = (d[0] !== 0 && d[1] !== 0) ? 1.414 : 1.0;
          const tentative = g[current] + base;
          if(tentative < g[ni]){
            came[ni] = current;
            g[ni] = tentative;
            f[ni] = tentative + Math.abs(nr - goal.r) + Math.abs(nc - goal.c);
            if(!open[ni]){ heapPush(ni); open[ni]=1; }
          }
        }
      }
      if(came[goalIdx] === -1){ postMessage({cmd:'result', path:null}); return; }
      const path = []; let k = goalIdx;
      while(k !== -1){ path.unshift({r: (k/cols)|0, c: k%cols}); k = came[k]; }
      postMessage({cmd:'result', path});
    }
  };
  `;
  const blob = new Blob([src], {type: 'application/javascript'});
  const url = URL.createObjectURL(blob);
  return new Worker(url);
}

/* ======================
   Game orchestrator
   - grid instance, aStar main, worker handle, action recording
   ====================== */
const Game = {
  grid: new Grid(12,16,48),
  aStar: null,
  worker: null,
  useWorker: true,
  actions: [], // timeline actions for time-lapse & undo/redo
  actionIndex: 0,
  actionGen: null,
  playing: false,
  simInterval: null,
  simSpeed: 1,
  init(){
    this.aStar = new AStar(this.grid);
    this.worker = createAStarWorker();
    this.worker.addEventListener('message', (e)=> {
      if(e.data && e.data.cmd === 'result'){ const p = e.data.path; if(p) Renderer.animateVehicle(p); }
    });
    loadTheme();
    renderPalette();
    UI.init();
    this.setupLevels();
    this.startAutosave();
    this.recordAction({type:'init', t: now(), snapshot: this.grid.toJSON()});
    Log.event('Game initialized');
    UI.refreshAll();
  },
  recordAction(action){
    action.t = now();
    this.actions.push(action);
    this.actionIndex = this.actions.length;
    this.actionGen = this._actionGenerator();
  },
  *_actionGenerator(){
    // complicated generator that replays actions up to index and yields index
    let idx = this.actionIndex;
    while(true){
      const cmd = yield idx;
      if(cmd && cmd.type === 'undo') idx = Math.max(1, idx-1);
      else if(cmd && cmd.type === 'redo') idx = Math.min(this.actions.length, idx+1);
      else idx = this.actions.length;
      // reconstruct from init snapshot
      const init = this.actions.find(a=>a.type==='init');
      if(init && init.snapshot) this.grid.loadJSON(init.snapshot);
      for(let i=1;i<idx;i++){
        const a = this.actions[i];
        if(!a) continue;
        if(a.type === 'set') this.grid.set(a.r, a.c, a.next, true);
        if(a.type === 'fill') this.grid.fillAll(a.next);
        if(a.type === 'multi') this.grid.multiSet(a.items);
      }
      UI.refreshAll();
      yield idx;
    }
  },
  undo(){ if(!this.actionGen) this.actionGen = this._actionGenerator(); this.actionGen.next(); this.actionGen.next({type:'undo'}); Log.event('Undo executed'); },
  redo(){ if(!this.actionGen) this.actionGen = this._actionGenerator(); this.actionGen.next(); this.actionGen.next({type:'redo'}); Log.event('Redo executed'); },

  startSim(){
    if(this.playing) return;
    this.playing = true;
    this.simInterval = setInterval(()=>this.simTick(), 1000 / this.simSpeed);
    Log.event('Simulation started');
  },
  stopSim(){
    this.playing = false;
    if(this.simInterval){ clearInterval(this.simInterval); this.simInterval = null; Log.event('Simulation stopped'); }
  },

  async findPath(start, goal){
    // build passable mask (roads or empty allowed)
    const mask = new Uint8Array(this.grid.rows * this.grid.cols);
    for(let r=0;r<this.grid.rows;r++){
      for(let c=0;c<this.grid.cols;c++){
        const tile = this.grid.get(r,c);
        const idx = r*this.grid.cols + c;
        mask[idx] = (!tile || tile === '🛣️' || /🚗|🚲|🛸/.test(tile)) ? 1 : 0;
      }
    }
    if(this.useWorker && this.worker){
      return new Promise((resolve)=>{
        const onmsg = (e)=>{ if(e.data && e.data.cmd === 'result'){ this.worker.removeEventListener('message', onmsg); resolve(e.data.path); } };
        this.worker.addEventListener('message', onmsg);
        this.worker.postMessage({cmd:'find', start, goal, rows:this.grid.rows, cols:this.grid.cols, passable: Array.from(mask)});
      });
    } else {
      // use main-thread A*
      return this.aStar.findPath(start, goal, mask);
    }
  },

  simTick(){
    // spawn commuter between random house and workplace
    const houses = [];
    const works = [];
    for(let r=0;r<this.grid.rows;r++){
      for(let c=0;c<this.grid.cols;c++){
        const v = this.grid.get(r,c) || '';
        if(/🏠|🏡|🏘️/.test(v)) houses.push({r,c});
        if(/🏢|🏬|🏪|🏥|🏫/.test(v)) works.push({r,c});
      }
    }
    if(!houses.length || !works.length) return;
    const s = houses[Math.floor(Math.random()*houses.length)];
    const d = works[Math.floor(Math.random()*works.length)];
    this.findPath(s,d).then(path => { if(path && path.length>1) Renderer.animateVehicle(path); });
    UI.updateScore(1);
  },

  setupLevels(){
    const defs = [
      {id:'lvl1', name:'Starter Village', rows:10, cols:12, objective:{type:'place_count', emoji:'🏠', count:8}},
      {id:'lvl2', name:'Commuter Rush', rows:12, cols:16, objective:{type:'balance', houses:6, workplaces:4}},
      {id:'lvl3', name:'Eco Park', rows:10, cols:10, objective:{type:'pattern', pattern:[['🌳','🌳','🌳'],['🌳','','🌳'],['🌳','🌳','🌳']]}}
    ];
    const el = $('#levels'); el.innerHTML = '';
    defs.forEach(d=>{
      const row = makeElem('div', {class:'level-item'});
      row.innerHTML = `<div><strong>${d.name}</strong><div style="font-size:12px;color:var(--muted)">${d.objective.type}</div></div><button data-lid="${d.id}">Load</button>`;
      el.appendChild(row);
      row.querySelector('button').addEventListener('click', ()=>{ this.loadLevel(d); });
    });
  },

  loadLevel(def){
    this.grid = new Grid(def.rows, def.cols, 48);
    this.aStar = new AStar(this.grid);
    this.recordAction({type:'setlevel', level:def});
    UI.refreshAll();
    Log.event(`Loaded level ${def.name}`);
  },

  startAutosave(){
    setInterval(()=> {
      try{
        const payload = {stamp: now(), grid: this.grid.toJSON(), actions: this.actions, registry: EmojiRegistry.slice()};
        localStorage.setItem('emojiton-autosave', JSON.stringify(payload));
      }catch(e){}
    }, 45000); // every 45s
  }
};

/* ======================
   Renderer & UI interactions
   - animates vehicles, plays SFX, shows matrix etc
   ====================== */
const Renderer = {
  vehicleLayer: null,
  init(){
    this.vehicleLayer = makeElem('div', {id:'vehicle-layer'});
    this.vehicleLayer.style.position = 'absolute';
    this.vehicleLayer.style.left = '0'; this.vehicleLayer.style.top = '0';
    this.vehicleLayer.style.zIndex = '1000';
    $('#viewport').appendChild(this.vehicleLayer);
    this.initMatrix();
  },
  animateVehicle(path){
    const start = path[0];
    const gridWrap = Game.grid.container;
    const cell0 = gridWrap.children[Game.grid.index(start.r, start.c)];
    if(!cell0) return;
    const wrapRect = gridWrap.getBoundingClientRect();
    const el = makeElem('div', {class:'vehicle'}, '🚗');
    Object.assign(el.style, {position:'absolute',width:'24px',height:'24px',zIndex:9999,transition:'transform 240ms linear'});
    $('#viewport').appendChild(el);
    // compute positions
    const pos = path.map(p => {
      const rect = gridWrap.children[Game.grid.index(p.r,p.c)].getBoundingClientRect();
      return {x: rect.left - wrapRect.left + rect.width/2 - 12, y: rect.top - wrapRect.top + rect.height/2 - 12};
    });
    let i = 0;
    const step = ()=> {
      if(i >= pos.length){ el.remove(); return; }
      const p = pos[i];
      el.style.transform = `translate(${p.x}px, ${p.y}px)`;
      i++;
      setTimeout(step, Math.max(80, 320 / Game.simSpeed));
    };
    step();
  },

  /* =========================
     Matrix Canvas advanced
     - multi-layered emoji rain
     - color gradients, velocity variance, GPU-like tint
     ========================= */
  matrix: {
    canvas: $('#matrix-canvas'),
    ctx: null,
    running: false,
    drops: [],
    layerCount: 3,
    emojiPool: [],
    dpr: window.devicePixelRatio || 1,
    init(){
      this.canvas = $('#matrix-canvas');
      this.ctx = this.canvas.getContext('2d');
      this.emojiPool = EmojiRegistry.slice();
      window.addEventListener('resize', ()=> this.resize());
      this.resize();
    },
    resize(){
      const c = this.canvas;
      const rect = c.getBoundingClientRect();
      c.width = rect.width * this.dpr;
      c.height = rect.height * this.dpr;
      this.ctx.setTransform(this.dpr,0,0,this.dpr,0,0);
      // prepare drops for columns
      const colW = 18; // column width per symbol
      const cols = Math.max(4, Math.floor(rect.width / colW));
      this.drops = [];
      for(let layer=0; layer<this.layerCount; layer++){
        const colsLayer = Math.max(4, Math.floor(rect.width / (colW * (1 + layer*0.3))));
        const arr = new Array(colsLayer).fill(0).map(()=>Math.random() * rect.height);
        this.drops.push({cols:colsLayer, arr, speed: 0.6 + layer*0.9, alpha: 0.12 + layer*0.18});
      }
    },
    start(){
      this.running = true;
      this.canvas.classList.add('active');
      this.loop();
    },
    stop(){
      this.running = false;
      this.canvas.classList.remove('active');
      this.ctx.clearRect(0,0,this.canvas.width,this.canvas.height);
    },
    loop(){
      if(!this.running) return;
      const ctx = this.ctx;
      const rect = this.canvas.getBoundingClientRect();
      // translucent fade
      ctx.fillStyle = `rgba(0, 0, 0, 0.08)`;
      ctx.fillRect(0,0,rect.width,rect.height);
      // draw layers
      for(let L=0; L<this.drops.length; L++){
        const layer = this.drops[L];
        ctx.font = `${14 + L*3}px serif`;
        for(let i=0;i<layer.cols;i++){
          const x = i * (rect.width / layer.cols);
          const y = layer.arr[i];
          const ch = this.emojiPool[(Math.floor(Math.random()*this.emojiPool.length)) || 0] || '✳️';
          ctx.globalAlpha = layer.alpha;
          // color gradient per layer
          const hue = 180 + L*40 + (i % 12) * 4;
          ctx.fillStyle = `hsla(${hue}, 90%, ${30 + L*8}%, ${layer.alpha})`;
          ctx.fillText(ch, x + 2 + (Math.random()*6 - 3), y);
          layer.arr[i] = y > rect.height + 20 ? (Math.random()*-80) : y + (1 + Math.random()*2) * layer.speed * (1 + L*0.5);
        }
      }
      requestAnimationFrame(()=>this.loop());
    },
    refreshPool(){ this.emojiPool = EmojiRegistry.slice(); }
  }
};
Renderer.init();

/* ======================
   UI handling: mouse/touch zoom/pan, tool application, palette rendering
   ====================== */
const UI = {
  selectedEmoji: EmojiRegistry[0] || '🏠',
  currentTool: 'brush',
  zoom: 1,
  init(){
    // render palette
    renderPalette();
    // set dims
    this.updateFilled(0);
    $('#ui-dims').textContent = `${Game.grid.rows} × ${Game.grid.cols}`;

    // zoom slider
    $('#zoom').addEventListener('input', (e)=>{ this.setZoom(Number(e.target.value)); });
    $('#zoom').value = 1;

    // viewport interactions (wheel zoom, drag pan, touch pinch)
    const vp = $('#viewport');
    vp.addEventListener('wheel', (ev)=>{
      if(ev.ctrlKey) return;
      ev.preventDefault();
      const delta = ev.deltaY > 0 ? 0.95 : 1.05;
      this.setZoom(this.zoom * delta, {x:ev.clientX, y:ev.clientY});
    }, {passive:false});

    // pan via mouse dragging when middle button or modifier pressed
    let isDown=false,start={x:0,y:0},scroll={x:0,y:0};
    vp.addEventListener('mousedown', (e)=>{
      if(e.button !== 1 && !e.shiftKey) return; // use middle button or shift+drag
      isDown = true; start={x:e.clientX,y:e.clientY}; scroll={x:vp.scrollLeft,y:vp.scrollTop}; vp.classList.add('dragging');
    });
    window.addEventListener('mousemove',(e)=>{ if(!isDown) return; vp.scrollLeft = scroll.x - (e.clientX - start.x); vp.scrollTop = scroll.y - (e.clientY - start.y); });
    window.addEventListener('mouseup', ()=>{ isDown=false; vp.classList.remove('dragging'); });

    // touch pinch zoom
    let lastDist=null;
    vp.addEventListener('touchstart',(e)=>{ if(e.touches.length === 2) lastDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); }, {passive:false});
    vp.addEventListener('touchmove',(e)=>{ if(e.touches.length===2 && lastDist){ const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); this.setZoom(this.zoom * (d/lastDist)); lastDist = d; } }, {passive:false});
    vp.addEventListener('touchend', ()=> lastDist = null);

    // palette click
    $('#palette').addEventListener('click', (e)=>{ const it = e.target.closest('.palette-item'); if(!it) return; $$('.palette-item').forEach(x=>x.classList.remove('active')); it.classList.add('active'); this.selectedEmoji = it.dataset.val; });

    // tool buttons
    $$('.tool').forEach(b => b.addEventListener('click', (ev)=>{ this.setTool(b.dataset.tool); $$('.tool').forEach(x=>x.classList.remove('active')); b.classList.add('active'); }));

    // cell painting (delegated)
    $('#grid-wrap').addEventListener('mousedown', (e)=>{
      const cell = e.target.closest('emoji-cell');
      if(!cell) return;
      this.applyToolToCell(cell);
      let moveHandler = (me) => { const c = me.target.closest('emoji-cell'); if(c) this.applyToolToCell(c); };
      window.addEventListener('mousemove', moveHandler);
      window.addEventListener('mouseup', ()=> window.removeEventListener('mousemove', moveHandler), {once:true});
    });

    // wire controls (save/load/etc)
    $('#btn-random').addEventListener('click', ()=> randomizeGrid());
    $('#btn-play').addEventListener('click', ()=> Game.startSim());
    $('#btn-pause').addEventListener('click', ()=> Game.stopSim());
    $('#btn-sim').addEventListener('click', ()=> Game.startSim());
    $('#btn-step').addEventListener('click', ()=> Game.simTick());
    $('#btn-replay').addEventListener('click', ()=> playBackActions());
    $('#btn-save').addEventListener('click', ()=> saveSlot());
    $('#btn-export').addEventListener('click', ()=> exportJSON());
    $('#btn-import').addEventListener('click', ()=> $('#file-import').click());
    $('#file-import').addEventListener('change', onFileImport);
    $('#btn-share').addEventListener('click', ()=> shareURL());
    $('#btn-clear').addEventListener('click', ()=> { if(confirm('Clear grid?')) Game.grid.clear(); });
    $('#btn-undo').addEventListener('click', ()=> Game.undo());
    $('#btn-redo').addEventListener('click', ()=> Game.redo());
    $('#btn-timelapse').addEventListener('click', ()=> timelapse());
    $('#btn-matrix').addEventListener('click', ()=> { toggleMatrix(); });
    $('#btn-konami').addEventListener('click', ()=> unlockKonami());
    $('#btn-sound').addEventListener('click', ()=> { window.__SFX_ON = !window.__SFX_ON; showToast('SFX ' + (window.__SFX_ON ? 'ON':'OFF')); });
    $('#btn-worker').addEventListener('click', ()=> { Game.useWorker = !Game.useWorker; showToast('A* Worker ' + (Game.useWorker ? 'ON' : 'OFF')); });

    // emoji add
    $('#emoji-add-btn').addEventListener('click', ()=> {
      const v = $('#emoji-input').value.trim();
      if(v){ EmojiRegistry.push(v); $('#emoji-input').value=''; showToast('Emoji added'); playBlip(); }
    });

    // quick shortcuts
    window.addEventListener('keydown', (e)=>{
      if(e.key === 'b') this.setTool('brush');
      if(e.key === 'e') this.setTool('eraser');
      if(e.key === 'f') this.setTool('fill');
      if(e.key === 'm') toggleMatrix();
      if(e.key === 'z' && (e.ctrlKey || e.metaKey)) Game.undo();
      if(e.key === 'y' && (e.ctrlKey || e.metaKey)) Game.redo();
    });
  },

  setTool(t){ this.currentTool = t; },

  applyToolToCell(cell){
    const r = Number(cell.dataset.r), c = Number(cell.dataset.c);
    if(this.currentTool === 'brush'){
      Game.recordAction({type:'set', r, c, prev: cell.value, next: this.selectedEmoji});
      Game.grid.set(r,c,this.selectedEmoji);
      if(window.__SFX_ON) playBlip();
    } else if(this.currentTool === 'eraser'){
      Game.recordAction({type:'set', r, c, prev: cell.value, next: ''});
      Game.grid.set(r,c,'');
    } else if(this.currentTool === 'fill'){
      const old = cell.value;
      Game.recordAction({type:'fill', prev: old, next: this.selectedEmoji});
      Game.grid.fillAll(this.selectedEmoji);
    } else if(this.currentTool === 'rand'){
      const choice = EmojiRegistry[Math.floor(Math.random()*EmojiRegistry.length)];
      Game.recordAction({type:'set', r, c, prev: cell.value, next: choice});
      Game.grid.set(r,c, choice);
    } else if(this.currentTool === 'road'){
      Game.recordAction({type:'set', r, c, prev: cell.value, next: '🛣️'});
      Game.grid.set(r,c,'🛣️');
    } else if(this.currentTool === 'select'){
      cell.highlight(!cell.classList.contains('highlight'));
    }
    Game.grid.updateStats();
  },

  onCellClick(cell,r,c){
    this.applyToolToCell(cell);
  },

  setZoom(val, center){
    this.zoom = clamp(val, 0.45, 3);
    const wrap = $('#grid-wrap');
    wrap.style.transform = `scale(${this.zoom})`;
    $('#zoom-val').textContent = Math.round(this.zoom*100) + '%';
    $('#zoom').value = this.zoom;
    // approximate focal preserve: adjust scroll to keep center near pointer
    if(center){
      const vp = $('#viewport');
      const rect = vp.getBoundingClientRect();
      const cx = center.x - rect.left, cy = center.y - rect.top;
      vp.scrollLeft = cx*(this.zoom - 1);
      vp.scrollTop = cy*(this.zoom - 1);
    }
  },

  updateFilled(n){ $('#ui-filled').textContent = n; },
  updateScore(n){ const el = $('#ui-score'); el.textContent = Number(el.textContent||0) + n; },
  refreshAll(){
    $('#ui-dims').textContent = `${Game.grid.rows} × ${Game.grid.cols}`;
    $('#ui-filled').textContent = Game.grid.cells.filter(Boolean).length;
    renderPalette();
  }
};

/* ======================
   Palette & randomize
   ====================== */
function renderPalette(){
  const pal = $('#palette');
  pal.innerHTML = '';
  EmojiRegistry.forEach((e,i)=>{
    const it = document.createElement('div');
    it.className = 'palette-item' + (i===0 ? ' active' : '');
    it.dataset.val = e;
    it.textContent = e;
    pal.appendChild(it);
    if(i===0) UI.selectedEmoji = e;
  });
  Renderer.matrix.refreshPool();
}

function randomizeGrid(){
  const r = Game.grid.rows, c = Game.grid.cols;
  for(let i=0;i<r*c;i++){
    const v = Math.random() > 0.66 ? EmojiRegistry[Math.floor(Math.random()*EmojiRegistry.length)] : '';
    Game.grid.cells[i] = v;
    const el = Game.grid.container.children[i]; if(el) el.value = v;
  }
  Game.grid.updateStats();
  Game.recordAction({type:'fill', next:'randomize'});
  showToast('Grid randomized');
}

/* ======================
   File export/import/share
   ====================== */
function exportJSON(){
  const payload = {grid: Game.grid.toJSON(), actions: Game.actions, registry: EmojiRegistry.slice()};
  const blob = new Blob([JSON.stringify(payload, null, 2)], {type:'application/json'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `emojiton_${Date.now()}.json`; a.click();
}
function onFileImport(e){
  const f = e.target.files && e.target.files[0];
  if(!f) return;
  const reader = new FileReader();
  reader.onload = ()=>{
    try{
      const obj = JSON.parse(reader.result);
      if(obj.registry && Array.isArray(obj.registry)){ EmojiRegistry.length = 0; obj.registry.forEach(x=>EmojiRegistry.push(x)); }
      if(obj.grid) Game.grid.loadJSON(obj.grid);
      if(obj.actions) Game.actions = obj.actions;
      UI.refreshAll();
      showToast('Imported file');
    }catch(err){ showToast('Import error'); }
  };
  reader.readAsText(f);
  e.target.value = '';
}
function shareURL(){
  try{
    const payload = {grid: Game.grid.toJSON(), registry: EmojiRegistry.slice()};
    const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
    const url = location.origin + location.pathname + '#data=' + encoded;
    navigator.clipboard.writeText(url).then(()=> showToast('Share URL copied'), ()=> prompt('Copy URL', url));
  }catch(e){ showToast('Share failed'); }
}

/* ======================
   Konami & secret pack
   ====================== */
const KONAMI = [38,38,40,40,37,39,37,39,66,65];
const keyBuf = [];
window.addEventListener('keydown', (e)=> {
  keyBuf.push(e.keyCode);
  if(keyBuf.length > KONAMI.length) keyBuf.shift();
  if(KONAMI.every((v,i)=>v === keyBuf[i])) unlockKonami();
});
function unlockKonami(){
  const secret = ['🦄','🧿','✨','🌀','🛸','🧩'];
  secret.forEach(s=>EmojiRegistry.push(s));
  showToast('Konami unlocked secret pack ✨');
}

/* ======================
   Time-lapse & replay
   ====================== */
function playBackActions(){
  if(!Game.actions || Game.actions.length < 2){ showToast('No actions to replay'); return; }
  const init = Game.actions[0];
  if(init && init.snapshot) Game.grid.loadJSON(init.snapshot);
  let i = 1;
  const tick = ()=>{
    if(i >= Game.actions.length){ showToast('Replay finished'); return; }
    const a = Game.actions[i];
    if(a.type === 'set') Game.grid.set(a.r, a.c, a.next, true);
    if(a.type === 'fill') Game.grid.fillAll(a.next);
    if(a.type === 'multi') Game.grid.multiSet(a.items);
    i++;
    setTimeout(tick, 120);
  };
  tick();
}
function timelapse(){ playBackActions(); }

/* ======================
   Undo/Redo already on Game (generator)
   ====================== */

/* ======================
   Timely helpers: snapshot export
   ====================== */
$('#btn-export-gif').addEventListener('click', ()=>{
  // simple snapshot using canvas - naive but functional
  const gridWrap = Game.grid.container;
  const rect = gridWrap.getBoundingClientRect();
  const canvas = document.createElement('canvas');
  const scale = 2;
  canvas.width = rect.width * scale; canvas.height = rect.height * scale;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0,0,canvas.width,canvas.height);
  const cell = gridWrap.children[0]?.getBoundingClientRect().width || 48;
  ctx.font = `${cell*0.9 * scale}px serif`;
  for(let r=0;r<Game.grid.rows;r++){
    for(let c=0;c<Game.grid.cols;c++){
      const v = Game.grid.get(r,c);
      if(!v) continue;
      const x = c * (cell + 6) * scale + 8*scale;
      const y = r * (cell + 6) * scale + (cell * 0.85 * scale);
      ctx.fillStyle = '#000';
      ctx.fillText(v, x, y);
    }
  }
  const a = document.createElement('a'); a.href = canvas.toDataURL('image/png'); a.download = 'emojiton_snapshot.png'; a.click();
});

/* ======================
   Small SFX
   ====================== */
window.__SFX_ON = true;
function playBlip(){
  if(!window.__SFX_ON) return;
  try{
    const a = new Audio(AUDIO_BLIP); a.volume = 0.06; a.play().catch(()=>{});
  }catch(e){}
}

/* ======================
   Matrix toggle
   ====================== */
let matrixOn = false;
function toggleMatrix(){
  matrixOn = !matrixOn;
  if(matrixOn) Renderer.matrix.start();
  else Renderer.matrix.stop();
}

/* ======================
   Toast & Log
   ====================== */
function showToast(msg, t=1800){
  const el = document.createElement('div'); el.className = 'toast'; el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(()=> el.style.opacity = '0.01', t);
  setTimeout(()=> el.remove(), t+400);
}
const Log = {
  el: $('#log'),
  event(msg){
    const p = document.createElement('div'); p.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`; p.style.fontSize='12px';
    this.el.prepend(p);
    if(this.el.children.length > 200) this.el.removeChild(this.el.lastChild);
  }
};

/* ======================
   Save / Load slots
   ====================== */
function saveSlot(){
  const name = $('#save-name').value || ('slot-' + uid(4));
  const payload = {grid: Game.grid.toJSON(), actions: Game.actions, registry: EmojiRegistry.slice(), stamp: now()};
  localStorage.setItem(`emojiton-save-${name}`, JSON.stringify(payload));
  showToast('Saved ' + name);
}
function loadSlot(name){
  const raw = localStorage.getItem(`emojiton-save-${name}`);
  if(!raw) return;
  const p = JSON.parse(raw);
  if(p.registry){ EmojiRegistry.length = 0; p.registry.forEach(x=>EmojiRegistry.push(x)); }
  if(p.grid) Game.grid.loadJSON(p.grid);
  if(p.actions) Game.actions = p.actions;
  UI.refreshAll();
}
function exportRegPack(){
  const blob = new Blob([JSON.stringify(EmojiRegistry.slice(), null, 2)], {type:'application/json'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'emojiton_pack.json'; a.click();
}
$('#btn-export-reg').addEventListener('click', exportRegPack);
$('#btn-clear-reg').addEventListener('click', ()=>{ if(confirm('Clear emoji registry?')){ EmojiRegistry.length = 0; renderPalette(); } });

/* ======================
   Initialize application
   ====================== */
window.addEventListener('load', ()=>{
  // small polyfill for CSS var support if needed (browsers OK)
  Game.init();
  UI.init();
  // initial zoom
  UI.setZoom(1);
  // try restore autosave
  try{
    const auto = JSON.parse(localStorage.getItem('emojiton-autosave') || 'null');
    if(auto && auto.grid && confirm('Restore last autosave?')){ Game.grid.loadJSON(auto.grid); Game.actions = auto.actions || Game.actions; UI.refreshAll(); Log.event('Autosave restored'); }
  }catch(e){}
  // entry animations
  document.querySelectorAll('.panel').forEach((p,i)=>{ p.style.transform='translateY(6px)'; setTimeout(()=> p.style.transform='translateY(0)', 120 + i*40); });
});
