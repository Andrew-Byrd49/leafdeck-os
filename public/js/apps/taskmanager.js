// Task Manager (Shift+Esc), after Windows' own: Processes (everything running on the computer), Performance (live
// graphs of CPU, memory, disks and network) and Leafdeck (each site window and Leafdeck process, with sleep / reload /
// end). Processes, disks and network need Linux; elsewhere it's Performance (CPU and memory) and Leafdeck.

import { $, $$, esc, hashHue } from '../util.js';
import { icon } from '../icons.js';
import { registerApp, wins, toast, openApp, showMenu } from '../wm.js';
import { confirmDialog } from '../dialogs.js';
import { shell } from '../shell.js';
import { favicon } from './bookmarks.js';
import { bytes } from './downloads.js';

const LINUX = /Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent);
const HISTORY = 60; // seconds of graph

const cleanError = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const hostOf = (u) => {
  try {
    return new URL(u).host.replace(/^www\./, '');
  } catch {
    return '';
  }
};
const store = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

/* ---------------- formatting ---------------- */

const pct = (n) => `${Math.round(n || 0)}%`;
const gb = (n) => `${((n || 0) / 1024 ** 3).toFixed(1)} GB`;
const ghz = (mhz) => `${((mhz || 0) / 1000).toFixed(2)} GHz`;
const rate = (n) => `${bytes(n)}/s`;
/** Network speeds in bits, like Windows: 12 Kbps, 4.2 Mbps. */
function bits(bytesPerSec) {
  const b = (bytesPerSec || 0) * 8;
  if (b < 1000) return `${Math.round(b)} bps`;
  const u = ['Kbps', 'Mbps', 'Gbps'];
  const i = Math.min(u.length - 1, Math.floor(Math.log10(b) / 3) - 1);
  const v = b / 1000 ** (i + 1);
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}
function uptime(secs) {
  const s = Math.floor(secs || 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${Math.floor(s / 86400)}:${pad(Math.floor(s / 3600) % 24)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}
/** A round top for a graph of rates: 1, 2 or 5 times a power of ten, never below `floor`. */
function niceMax(values, floor) {
  const top = Math.max(floor, ...values) * 1.1;
  const p = 10 ** Math.floor(Math.log10(top));
  return [1, 2, 5, 10].map((m) => m * p).find((v) => v >= top);
}

/* ---------------- graphs ---------------- */

const COLOR = { cpu: '#2a8fdc', memory: '#a24fd6', disk: '#4caf38', net: '#de8a2c' };

/**
 * A Windows-style history graph on a canvas: a grid that scrolls with time, and each series as a line (filled under
 * the first). Series are newest-last arrays of up to HISTORY values; `max` is the top of the graph.
 */
function drawGraph(canvas, series, { max = 100, color, tick = 0, grid = true, dashed = [] } = {}) {
  const dpr = devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) Object.assign(canvas, { width: w, height: h });
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, w, h);
  if (grid) {
    g.strokeStyle = getComputedStyle(canvas).color; // the grid color comes from CSS, so it follows the theme
    g.lineWidth = 1;
    g.beginPath();
    for (let i = 1; i < 10; i++) {
      const y = Math.round((h * i) / 10) + 0.5;
      g.moveTo(0, y);
      g.lineTo(w, y);
    }
    const cols = 12; // one line every 5 seconds, moving left as time passes
    const step = w / cols;
    const shift = ((tick % 5) / 5) * step;
    for (let x = step - shift; x < w; x += step) {
      g.moveTo(Math.round(x) + 0.5, 0);
      g.lineTo(Math.round(x) + 0.5, h);
    }
    g.stroke();
  }
  const dx = w / (HISTORY - 1);
  series.forEach((data, si) => {
    if (!data?.length) return;
    const pts = data.slice(-HISTORY).map((v, i, a) => [w - (a.length - 1 - i) * dx, h - Math.min(1, Math.max(0, v / max)) * (h - dpr) - dpr / 2]);
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.setLineDash(dashed.includes(si) ? [4 * dpr, 3 * dpr] : []);
    g.strokeStyle = color;
    g.lineWidth = 1.5 * dpr;
    g.stroke();
    if (si === 0) {
      g.lineTo(pts.at(-1)[0], h);
      g.lineTo(pts[0][0], h);
      g.closePath();
      g.fillStyle = color + '24';
      g.fill();
    }
  });
  g.setLineDash([]);
  if (grid) {
    g.strokeStyle = color;
    g.lineWidth = dpr;
    g.strokeRect(dpr / 2, dpr / 2, w - dpr, h - dpr);
  }
}

/** The desktop window showing a given site webContents. */
function windowFor(webContentsId) {
  for (const w of wins.values()) {
    try {
      if (w.web?.webview && w.web.wcId() === webContentsId) return w;
    } catch {}
  }
  return null;
}

const KIND_LABEL = { app: 'Leafdeck', site: 'Site', popup: 'Pop-up', browser: 'System', gpu: 'System', system: 'System' };

const TABS = [
  ['processes', 'Processes', 'list'],
  ['performance', 'Performance', 'chart'],
  ['leafdeck', 'Leafdeck', 'leaf'],
].filter(([id]) => id !== 'processes' || LINUX);

registerApp({
  id: 'taskmanager',
  name: 'Task Manager',
  icon: 'chart',
  size: [980, 640],
  min: [640, 420],
  openTab(win, tab) {
    win.showTab?.(tab);
  },
  mount(win) {
    if (!shell) {
      win.body.innerHTML = `<div class="empty"><div class="empty-title">Task Manager runs in the Leafdeck app</div>
        <p>In the web version, use your browser’s own task manager (Shift+Esc in Chrome and Edge).</p></div>`;
      return;
    }
    let tab = TABS.some(([id]) => id === store.get('tm.tab')) ? store.get('tm.tab') : TABS[0][0];

    win.tools.innerHTML = `<div class="seg" data-tabs>${TABS.map(([id, label, ic]) => `<button data-tab="${id}">${icon(ic, 13)}<span class="seg-label">${label}</span></button>`).join('')}</div>
      <span class="tm-tools" data-tools="processes"><label class="tb-search">${icon('search', 13)}<input type="search" placeholder="Name or PID" aria-label="Search processes"></label>
        <button class="btn small" data-end disabled>End task</button></span>
      <span class="tm-tools" data-tools="leafdeck"><span class="muted small tm-hint">Updates every 2 seconds</span><button class="tb-pill" data-tm-settings>Memory saver…</button></span>`;
    win.body.innerHTML = TABS.map(([id]) => `<div class="tm-pane tm-${id}" data-pane="${id}"></div>`).join('');
    win.body.classList.add('tm-body');
    const pane = (id) => $(`[data-pane="${id}"]`, win.body);

    const showTab = (id) => {
      if (!TABS.some(([t]) => t === id)) return;
      tab = id;
      store.set('tm.tab', id);
      $$('[data-tab]', win.tools).forEach((b) => b.classList.toggle('on', b.dataset.tab === id));
      $$('[data-tools]', win.tools).forEach((t) => (t.hidden = t.dataset.tools !== id));
      $$('[data-pane]', win.body).forEach((p) => (p.hidden = p.dataset.pane !== id));
      if (id === 'processes') refreshProcs().then(() => setTimeout(refreshProcs, 500));
      if (id === 'performance') drawPerf(true);
      if (id === 'leafdeck') refreshLeafdeck().then(() => setTimeout(refreshLeafdeck, 500));
    };
    win.showTab = showTab;
    win.tools.addEventListener('click', (e) => {
      const t = e.target.closest('[data-tab]');
      if (t) showTab(t.dataset.tab);
      if (e.target.closest('[data-tm-settings]')) openApp('settings');
      if (e.target.closest('[data-end]')) endSelected();
    });

    /* ================= Performance ================= */

    const hist = { cpu: [], cores: [], memory: [], disk: {}, net: {} };
    const push = (arr, v) => {
      arr.push(v);
      if (arr.length > HISTORY) arr.shift();
    };
    let sys = null; // the latest sample
    let ticks = 0;
    let perfSel = 'cpu';
    let perfShape = ''; // which resources the side list was built for
    let cpuView = store.get('tm.cpuView') === 'cores' ? 'cores' : 'overall';

    const sample = async () => {
      try {
        sys = await shell.perf.system();
      } catch {
        return;
      }
      // A window's very first sample has no earlier one to measure against (all zeros); keep it out of the graphs.
      if (!ticks++ && sys.cpu.usage === 0) return;
      push(hist.cpu, sys.cpu.usage);
      sys.cpu.perCore.forEach((v, i) => push((hist.cores[i] ||= []), v));
      push(hist.memory, sys.memory.used);
      for (const d of sys.disks) {
        const hd = (hist.disk[d.name] ||= { active: [], read: [], write: [] });
        push(hd.active, d.active);
        push(hd.read, d.readRate);
        push(hd.write, d.writeRate);
      }
      for (const n of sys.network) {
        const hn = (hist.net[n.name] ||= { send: [], receive: [] });
        push(hn.send, n.sendRate);
        push(hn.receive, n.receiveRate);
      }
      if (tab === 'performance' && !win.minimized) drawPerf();
      if (tab === 'processes') drawHeader();
    };

    const resources = () => {
      if (!sys) return [];
      const list = [
        { id: 'cpu', kind: 'cpu', title: 'CPU' },
        { id: 'memory', kind: 'memory', title: 'Memory' },
      ];
      sys.disks.forEach((d, i) => list.push({ id: `disk:${d.name}`, kind: 'disk', title: `Disk ${i}`, sub: d.name, disk: d }));
      sys.network.forEach((n) => list.push({ id: `net:${n.name}`, kind: 'net', title: n.kind, sub: n.name, net: n }));
      return list;
    };

    /** The value line under a resource in the side list. */
    const tileText = (r) => {
      const m = sys.memory;
      if (r.kind === 'cpu') return `${pct(sys.cpu.usage)}  ${ghz(sys.cpu.speed)}`;
      if (r.kind === 'memory') return `${(m.used / 1024 ** 3).toFixed(1)}/${gb(m.total)} (${pct((m.used / m.total) * 100)})`;
      if (r.kind === 'disk') return `${r.disk.kind}<br>${pct(r.disk.active)}`;
      return r.net.up ? `S: ${bits(r.net.sendRate)}<br>R: ${bits(r.net.receiveRate)}` : 'Not connected';
    };
    const tileSeries = (r) =>
      r.kind === 'cpu'
        ? { series: [hist.cpu], max: 100 }
        : r.kind === 'memory'
          ? { series: [hist.memory], max: sys.memory.total }
          : r.kind === 'disk'
            ? { series: [hist.disk[r.disk.name].active], max: 100 }
            : { series: [hist.net[r.net.name].receive, hist.net[r.net.name].send], max: niceMax([...hist.net[r.net.name].receive, ...hist.net[r.net.name].send], 12500) };

    const statBig = (label, value) => `<div class="tm-big"><span>${label}</span><b>${value}</b></div>`;
    const statRow = (label, value) => `<tr><th>${label}</th><td>${value}</td></tr>`;

    /** The detail view of one resource: its graphs and numbers. Built once per selection; filled in every second. */
    const detailShell = (r) => {
      const graph = (key, label, main = false) => `<div class="tm-glabel"><span>${label}</span><span data-max="${key}"></span></div>
        <canvas class="tm-graph${main ? ' tm-graph-main' : ''}" data-graph="${key}"></canvas>`;
      const axis = '<div class="tm-axis"><span>60 seconds</span><span>0</span></div>';
      let graphs = '';
      if (r.kind === 'cpu')
        graphs = `<div class="tm-glabel"><span>% Utilization over 60 seconds</span>
            <span class="seg tm-cpuview"><button data-cpuview="overall" class="${cpuView === 'overall' ? 'on' : ''}">Overall</button><button data-cpuview="cores" class="${cpuView === 'cores' ? 'on' : ''}">Logical processors</button></span><span>100%</span></div>
          ${cpuView === 'cores' ? `<div class="tm-cores" style="--cols:${Math.ceil(Math.sqrt(sys.cpu.logical * 1.6))}">${sys.cpu.perCore.map((_, i) => `<canvas class="tm-graph" data-core="${i}"></canvas>`).join('')}</div>` : '<canvas class="tm-graph tm-graph-main" data-graph="cpu"></canvas>'}${axis}`;
      if (r.kind === 'memory')
        graphs = `${graph('memory', 'Memory usage', true)}${axis}
          <div class="tm-glabel"><span>Memory composition</span></div><div class="tm-comp" data-comp></div>`;
      if (r.kind === 'disk') graphs = `${graph('active', 'Active time')}${axis}${graph('transfer', 'Disk transfer rate')}${axis}`;
      if (r.kind === 'net') graphs = `${graph('net', 'Throughput', true)}${axis}`;
      const head = r.kind === 'cpu' ? sys.cpu.model : r.kind === 'memory' ? gb(sys.memory.total) : r.kind === 'disk' ? r.disk.model : r.sub;
      const title = r.kind === 'disk' ? `${r.title} <small>(${esc(r.sub)})</small>` : r.title;
      return `<div class="tm-dhead" style="--c:${COLOR[r.kind]}"><h2>${title}</h2><span>${esc(head)}</span></div>
        <div class="tm-graphs" style="--c:${COLOR[r.kind]}">${graphs}</div>
        <div class="tm-stats" style="--c:${COLOR[r.kind]}"><div class="tm-bigs" data-bigs></div><table class="tm-facts"><tbody data-facts></tbody></table></div>`;
    };

    const fillDetail = (r, root) => {
      const c = COLOR[r.kind];
      const set = (sel, html) => {
        const el = $(sel, root);
        if (el && el.innerHTML !== html) el.innerHTML = html;
      };
      const cpu = sys.cpu;
      const m = sys.memory;
      if (r.kind === 'cpu') {
        if (cpuView === 'cores') $$('[data-core]', root).forEach((cv) => drawGraph(cv, [hist.cores[cv.dataset.core]], { color: c, tick: ticks }));
        else drawGraph($('[data-graph="cpu"]', root), [hist.cpu], { color: c, tick: ticks });
        set(
          '[data-bigs]',
          statBig('Utilization', pct(cpu.usage)) + statBig('Speed', ghz(cpu.speed)) + (cpu.processes ? statBig('Processes', cpu.processes) + statBig('Threads', cpu.threads) : '') + statBig('Up time', uptime(cpu.uptime)),
        );
        set('[data-facts]', statRow('Base speed:', cpu.baseSpeed ? ghz(cpu.baseSpeed) : '—') + statRow('Sockets:', cpu.sockets) + (cpu.physicalCores ? statRow('Cores:', cpu.physicalCores) : '') + statRow('Logical processors:', cpu.logical));
      }
      if (r.kind === 'memory') {
        set('[data-max="memory"]', gb(m.total));
        drawGraph($('[data-graph="memory"]', root), [hist.memory], { max: m.total, color: c, tick: ticks });
        const part = (n, cls, label) => `<i class="${cls}" style="width:${(n / m.total) * 100}%" title="${label}: ${gb(n)}"></i>`;
        set('[data-comp]', part(m.used, 'used', 'In use') + part(Math.max(0, m.cached), 'cached', 'Cached') + part(Math.max(0, m.total - m.used - Math.max(0, m.cached)), 'free', 'Free'));
        set(
          '[data-bigs]',
          statBig('In use', gb(m.used)) + statBig('Available', gb(m.available)) + (m.committed ? statBig('Committed', `${(m.committed / 1024 ** 3).toFixed(1)}/${gb(m.commitLimit)}`) : '') + (sys.linux ? statBig('Cached', gb(m.cached)) : ''),
        );
        set('[data-facts]', m.swapTotal ? statRow('Swap in use:', `${gb(m.swapUsed)} of ${gb(m.swapTotal)}`) + statRow('Free:', gb(m.free)) : '');
      }
      if (r.kind === 'disk') {
        const hd = hist.disk[r.disk.name];
        const top = niceMax([...hd.read, ...hd.write], 100 * 1024);
        set('[data-max="active"]', '100%');
        set('[data-max="transfer"]', rate(top));
        drawGraph($('[data-graph="active"]', root), [hd.active], { color: c, tick: ticks });
        drawGraph($('[data-graph="transfer"]', root), [hd.read, hd.write], { max: top, color: c, tick: ticks, dashed: [1] });
        set('[data-bigs]', statBig('Active time', pct(r.disk.active)) + statBig('<span class="tm-key"></span>Read speed', rate(r.disk.readRate)) + statBig('<span class="tm-key dashed"></span>Write speed', rate(r.disk.writeRate)));
        set('[data-facts]', statRow('Capacity:', bytes(r.disk.capacity)) + statRow('Type:', r.disk.kind) + statRow('Device:', esc(r.disk.name)));
      }
      if (r.kind === 'net') {
        const hn = hist.net[r.net.name];
        const top = niceMax([...hn.send, ...hn.receive], 12500);
        set('[data-max="net"]', bits(top));
        drawGraph($('[data-graph="net"]', root), [hn.receive, hn.send], { max: top, color: c, tick: ticks, dashed: [1] });
        set('[data-bigs]', statBig('<span class="tm-key dashed"></span>Send', bits(r.net.sendRate)) + statBig('<span class="tm-key"></span>Receive', bits(r.net.receiveRate)));
        set(
          '[data-facts]',
          statRow('Adapter name:', esc(r.net.name)) +
            statRow('Connection type:', r.net.kind) +
            (r.net.linkSpeed ? statRow('Link speed:', bits(r.net.linkSpeed / 8)) : '') +
            statRow('IPv4 address:', esc(r.net.ipv4 || '—')) +
            statRow('IPv6 address:', esc(r.net.ipv6 || '—')),
        );
      }
    };

    const drawPerf = (rebuild = false) => {
      const root = pane('performance');
      if (!sys) return void (root.innerHTML = '<div class="empty"><p>Measuring…</p></div>');
      const list = resources();
      if (!list.some((r) => r.id === perfSel)) perfSel = 'cpu';
      const shape = list.map((r) => r.id).join() + '|' + perfSel + '|' + cpuView;
      if (rebuild || shape !== perfShape || !$('.tm-side', root)) {
        perfShape = shape;
        root.innerHTML = `<div class="tm-side">${list
          .map(
            (r) => `<button class="tm-tile${r.id === perfSel ? ' on' : ''}" data-res="${esc(r.id)}" style="--c:${COLOR[r.kind]}">
              <canvas class="tm-spark"></canvas><span><b>${r.title}${r.sub && r.kind === 'disk' ? ` <small>(${esc(r.sub)})</small>` : ''}</b><small data-tile></small></span></button>`,
          )
          .join('')}</div><div class="tm-detail" data-detail>${detailShell(list.find((r) => r.id === perfSel))}</div>`;
      }
      list.forEach((r) => {
        const tile = $(`[data-res="${CSS.escape(r.id)}"]`, root);
        if (!tile) return;
        const text = tileText(r);
        const t = $('[data-tile]', tile);
        if (t.innerHTML !== text) t.innerHTML = text;
        const { series, max } = tileSeries(r);
        drawGraph($('canvas', tile), series, { max, color: COLOR[r.kind], grid: false, dashed: [1] });
      });
      fillDetail(
        list.find((r) => r.id === perfSel),
        $('[data-detail]', root),
      );
    };

    pane('performance').addEventListener('click', (e) => {
      const res = e.target.closest('[data-res]');
      if (res) {
        perfSel = res.dataset.res;
        return drawPerf(true);
      }
      const v = e.target.closest('[data-cpuview]');
      if (v) {
        cpuView = v.dataset.cpuview;
        store.set('tm.cpuView', cpuView);
        drawPerf(true);
      }
    });
    // Graphs size themselves to the window; redraw when it changes rather than waiting for the next second.
    const ro = new ResizeObserver(() => tab === 'performance' && sys && drawPerf());
    ro.observe(pane('performance'));
    win.cleanups.push(() => ro.disconnect());

    /* ================= Processes ================= */

    let procs = [];
    let procErr = '';
    let sortKey = 'cpu';
    let q = '';
    const expanded = new Set();
    let selected = null; // 'g:<section>:<name>' for a group, 'p:<pid>' for one process

    const SORTS = { name: 'Name', pid: 'PID', cpu: 'CPU', memory: 'Memory', disk: 'Disk' };

    const groupsOf = () => {
      const ql = q.trim().toLowerCase();
      const match = (p) => !ql || p.name.toLowerCase().includes(ql) || String(p.pid) === ql || p.command.toLowerCase().includes(ql);
      const sections = [
        { id: 'leafdeck', label: 'Leafdeck', list: procs.filter((p) => p.leafdeck) },
        { id: 'mine', label: 'Your processes', list: procs.filter((p) => !p.leafdeck && p.mine) },
        { id: 'system', label: 'System processes', list: procs.filter((p) => !p.leafdeck && !p.mine) },
      ];
      const by = (a, b) =>
        sortKey === 'name' ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : sortKey === 'pid' ? (a.pid ?? 1e9) - (b.pid ?? 1e9) : (b[sortKey] || 0) - (a[sortKey] || 0);
      return sections
        .map((s) => {
          const map = new Map();
          // Leafdeck is one app however many processes it runs; everything else groups by program name.
          for (const p of s.list.filter(match)) {
            const name = s.id === 'leafdeck' ? 'Leafdeck' : p.name;
            if (!map.has(name)) map.set(name, []);
            map.get(name).push(p);
          }
          const groups = [...map].map(([name, list]) => ({
            key: list.length > 1 ? `g:${s.id}:${name}` : `p:${list[0].pid}`,
            name,
            list: list.sort(by),
            pid: list.length > 1 ? null : list[0].pid,
            cpu: list.reduce((t, p) => t + p.cpu, 0),
            memory: list.reduce((t, p) => t + p.memory, 0),
            disk: list.reduce((t, p) => t + p.disk, 0),
          }));
          return { ...s, groups: groups.sort(by), count: s.list.filter(match).length };
        })
        .filter((s) => s.groups.length);
    };

    // Cells shade from pale to strong yellow with how much they use, as in Windows.
    const heat = (v) => `style="--heat:${Math.min(1, Math.max(0, v)).toFixed(3)}"`;
    const cells = (x) => {
      const total = sys?.memory.total || 1;
      return `<td class="num tm-pid">${x.pid ?? ''}</td>
        <td class="num tm-heat" ${heat(x.cpu / 40)}>${x.cpu.toFixed(1)}%</td>
        <td class="num tm-heat" ${heat(x.memory / (total * 0.2))}>${bytes(x.memory)}</td>
        <td class="num tm-heat" ${heat(x.disk / (20 * 1024 * 1024))}>${x.disk >= 1024 ? rate(x.disk) : '0 MB/s'}</td>
        <td class="tm-actions">${endable(x.list || [x]) ? `<button class="icon-btn" data-end-row title="${x.list?.length > 1 ? `End all ${x.list.length}` : 'End task'}" aria-label="End task">${icon('x', 13)}</button>` : ''}</td>`;
    };
    /** Only your own processes can be ended, and not Leafdeck's (that's what the Leafdeck tab is for). */
    const endable = (list) => list.length && list.every((p) => p.mine && !p.leafdeck);
    const glyph = (name, leafdeck) =>
      leafdeck ? `<span class="tm-glyph tm-leaf">${icon('leaf', 12)}</span>` : `<span class="tm-glyph" style="--h:${hashHue(name)}">${esc(name.replace(/^[^a-z0-9]+/i, '').charAt(0).toUpperCase() || '?')}</span>`;

    const procRows = () => {
      const out = [];
      for (const s of groupsOf()) {
        out.push(`<tr class="tm-section"><td colspan="6">${s.label} <span>(${s.count})</span></td></tr>`);
        for (const g of s.groups) {
          const many = g.list.length > 1;
          const open = many && (expanded.has(g.key) || (q && g.list.length < 6));
          const tip = many ? `${g.list.length} processes` : `${g.list[0].command}\nUser: ${g.list[0].user}`;
          out.push(`<tr class="tm-row${selected === g.key ? ' sel' : ''}" data-key="${esc(g.key)}" title="${esc(tip)}">
            <td><div class="tm-name">${many ? `<button class="tm-twisty${open ? ' open' : ''}" data-toggle aria-label="${open ? 'Collapse' : 'Expand'}">${icon('right', 11)}</button>` : '<span class="tm-twisty-gap"></span>'}${glyph(g.name, s.id === 'leafdeck')}
              <span class="tm-pname">${esc(g.name)}${many ? ` <small>(${g.list.length})</small>` : ''}</span></div></td>${cells(g)}</tr>`);
          if (open)
            for (const p of g.list)
              out.push(`<tr class="tm-row tm-child${selected === `p:${p.pid}` ? ' sel' : ''}" data-key="p:${p.pid}" title="${esc(`${p.command}\nUser: ${p.user}`)}">
                <td><div class="tm-name"><span class="tm-pname">${esc(p.name)}</span></div></td>${cells(p)}</tr>`);
        }
      }
      return out.join('') || `<tr><td colspan="6" class="muted tm-none">${procErr ? esc(procErr) : q ? 'No processes match' : 'Loading…'}</td></tr>`;
    };

    const drawHeader = () => {
      const root = pane('processes');
      const head = $('thead', root);
      if (!head) return;
      const m = sys?.memory;
      const disk = sys ? Math.max(0, ...sys.disks.map((d) => d.active)) : 0;
      const top = { cpu: sys ? pct(sys.cpu.usage) : '', memory: m ? pct((m.used / m.total) * 100) : '', disk: sys?.disks.length ? pct(disk) : '' };
      head.innerHTML = `<tr>${Object.entries(SORTS)
        .map(([k, label]) => `<th class="tm-sort${k === 'name' ? '' : ' num'}${sortKey === k ? ' on' : ''}${k === 'pid' ? ' tm-pid' : ''}" data-sort="${k}"><b>${top[k] ?? ''}</b><span>${label}</span></th>`)
        .join('')}<th></th></tr>`;
    };

    /** Processes the selection covers, and whether End task can act on them. */
    const selection = (key = selected) => {
      if (!key) return { list: [] };
      if (key.startsWith('p:')) {
        const p = procs.find((x) => x.pid === Number(key.slice(2)));
        return { list: p ? [p] : [] };
      }
      const [, section, ...name] = key.split(':');
      const n = name.join(':');
      const list = procs.filter((p) => (section === 'leafdeck' ? p.leafdeck : !p.leafdeck && p.name === n && (section === 'mine') === p.mine));
      return { list };
    };
    const updateEnd = () => {
      const b = $('[data-end]', win.tools);
      const { list } = selection();
      const leafdeck = list.some((p) => p.leafdeck);
      const others = list.some((p) => !p.mine);
      b.disabled = !endable(list);
      b.title = leafdeck ? 'Leafdeck’s own processes are in the Leafdeck tab' : others ? 'That belongs to the system or another user' : list.length > 1 ? `End all ${list.length} processes` : '';
    };

    const drawProcs = () => {
      const root = pane('processes');
      if (!$('table', root)) {
        root.innerHTML = `<div class="tbl-wrap tm-scroll" tabindex="0"><table class="tbl tm tm-procs"><colgroup><col><col class="tm-pid"><col class="tm-c"><col class="tm-c"><col class="tm-c"><col class="tm-x"></colgroup>
          <thead></thead><tbody></tbody></table></div>`;
      }
      drawHeader();
      $('tbody', root).innerHTML = procRows();
      if (selected && !selection().list.length) selected = null;
      updateEnd();
    };

    let procBusy = false;
    const refreshProcs = async () => {
      if (procBusy || !LINUX) return;
      procBusy = true;
      try {
        const r = await shell.perf.processes();
        procs = r.list;
        procErr = '';
      } catch (err) {
        procErr = cleanError(err);
      }
      procBusy = false;
      drawProcs();
    };

    /** A process and everything it started (a shell and the programs running in it), Leafdeck's own left out. */
    const tree = (list) => {
      const out = new Map(list.map((p) => [p.pid, p]));
      for (let grew = true; grew; ) {
        grew = false;
        for (const p of procs) if (!out.has(p.pid) && out.has(p.ppid) && !p.leafdeck) out.set(p.pid, p), (grew = true);
      }
      return [...out.values()];
    };

    /** End processes; `force` kills at once instead of asking them to quit first. */
    async function endProcs(list, { force = false, what = '' } = {}) {
      if (!list.length) return;
      // A group is every process with that name, which can be unrelated programs (all your shells, say): check first.
      if (list.length > 1 && !(await confirmDialog(`End ${what || `all ${list.length} “${list[0].name}” processes`}? Anything unsaved in them will be lost.`, { ok: 'End', danger: true }))) return;
      const results = await Promise.allSettled(list.map((p) => shell.perf.endProcess(p.pid, force)));
      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length) toast(cleanError(failed[0].reason), 'error');
      else toast(list.length > 1 ? `Ended ${list.length} processes` : `Ended ${list[0].name}`);
      selected = null;
      setTimeout(refreshProcs, 400);
      setTimeout(refreshProcs, force ? 900 : 3500); // and again once anything that ignored the request has been forced
    }
    const endSelected = () => endProcs(selection().list);

    pane('processes').addEventListener('click', (e) => {
      const sort = e.target.closest('[data-sort]');
      if (sort) {
        sortKey = sort.dataset.sort;
        return drawProcs();
      }
      const row = e.target.closest('[data-key]');
      if (!row) return;
      if (e.target.closest('[data-end-row]')) return void endProcs(selection(row.dataset.key).list);
      if (e.target.closest('[data-toggle]')) {
        const k = row.dataset.key;
        expanded.has(k) ? expanded.delete(k) : expanded.add(k);
      } else selected = row.dataset.key;
      drawProcs();
    });
    pane('processes').addEventListener('dblclick', (e) => {
      const row = e.target.closest('[data-key^="g:"]');
      if (!row || e.target.closest('[data-toggle]')) return;
      expanded.has(row.dataset.key) ? expanded.delete(row.dataset.key) : expanded.add(row.dataset.key);
      drawProcs();
    });
    pane('processes').addEventListener('contextmenu', (e) => {
      const row = e.target.closest('[data-key]');
      if (!row) return;
      e.preventDefault();
      selected = row.dataset.key;
      drawProcs();
      const { list } = selection();
      if (!list.length) return;
      const one = list.length === 1 ? list[0] : null;
      const ok = endable(list);
      const kids = tree(list);
      if (list.some((p) => p.leafdeck))
        return showMenu(e.clientX, e.clientY, [{ label: 'Show in the Leafdeck tab', act: () => showTab('leafdeck') }, '-', { label: 'Copy PIDs', act: () => copy(list.map((p) => p.pid).join(' ')) }]);
      showMenu(e.clientX, e.clientY, [
        { label: one ? 'End task' : `End all ${list.length}`, key: 'Del', disabled: !ok, act: () => endProcs(list) },
        { label: `End process tree${kids.length > list.length ? ` (${kids.length})` : ''}`, disabled: !ok || !endable(kids) || kids.length === list.length, act: () => endProcs(kids, { what: `${kids.length} processes (${list[0].name} and everything it started)` }) },
        { label: 'Force end', disabled: !ok, act: () => endProcs(list, { force: true }) },
        ...(ok ? [] : [{ header: 'Belongs to the system or another user' }]),
        '-',
        one && { label: `Copy PID (${one.pid})`, act: () => copy(String(one.pid)) },
        one && { label: 'Copy command line', act: () => copy(one.command) },
        !one && { label: 'Copy PIDs', act: () => copy(list.map((p) => p.pid).join(' ')) },
      ]);
    });
    const copy = (text) => navigator.clipboard.writeText(text).then(() => toast('Copied'));
    pane('processes').addEventListener('keydown', (e) => {
      if (e.key === 'Delete' && selected && !$('[data-end]', win.tools).disabled) endSelected();
    });
    $('[data-tools="processes"] input', win.tools).addEventListener('input', (e) => {
      q = e.target.value;
      drawProcs();
    });

    /* ================= Leafdeck (its own windows and processes) ================= */

    let rows = [];
    let meta = { gpuStatus: {}, gpu: '' };
    let lsort = 'memory';

    const drawLeafdeck = () => {
      const root = pane('leafdeck');
      // Sleeping windows have no process; list them so you can see what's been unloaded.
      const sleeping = [...wins.values()].filter((w) => w.web?.sleeping);
      const totalMem = rows.reduce((t, r) => t + (r.memory || 0), 0);
      const totalCpu = rows.reduce((t, r) => t + (r.cpu || 0), 0);
      const sites = rows.filter((r) => r.kind === 'site');
      const accel = meta.gpuStatus.gpu_compositing?.startsWith('enabled');
      const sorted = [...rows].sort((a, b) => (b[lsort] || 0) - (a[lsort] || 0));

      const name = (r) => {
        if (r.kind === 'site' || r.kind === 'popup') {
          const w = windowFor(r.webContentsId);
          const title = r.title || w?.app.name || hostOf(r.url);
          return `<img class="fav" src="${esc(favicon(r.url))}" alt="" referrerpolicy="no-referrer"><span class="cell-main"><b>${esc(title)}</b><small>${esc(hostOf(r.url))}${r.shared ? ' · shares a process' : ''}</small></span>`;
        }
        return `<span class="tm-sys">${icon(r.kind === 'app' ? 'grid' : r.kind === 'gpu' ? 'sparkle' : 'sliders', 13)}</span><span class="cell-main"><b>${esc(r.title)}</b><small>${KIND_LABEL[r.kind]}</small></span>`;
      };
      const status = (r) =>
        r.frozen ? '<span class="pill pill-blue">Paused</span>' : r.audible ? '<span class="pill pill-purple">Playing audio</span>' : r.kind === 'site' ? '<span class="pill pill-green">Active</span>' : '';
      const actions = (r) =>
        r.kind === 'site'
          ? `<button class="btn small" data-tm="sleep" title="Unload to free memory">Sleep</button>
             <button class="icon-btn" data-tm="reload" title="Reload">${icon('refresh', 13)}</button>
             <button class="icon-btn" data-tm="end" title="End process">${icon('x', 13)}</button>`
          : r.kind === 'popup'
            ? `<button class="icon-btn" data-tm="end" title="End process">${icon('x', 13)}</button>`
            : '';

      root.innerHTML = `<div class="summary">
          <div class="stat"><span>Memory in use</span><b>${bytes(totalMem)}</b><small>${rows.length} processes</small></div>
          <div class="stat"><span>CPU</span><b>${totalCpu.toFixed(1)}%</b><small>of one core</small></div>
          <div class="stat"><span>Sites</span><b>${sites.length}</b><small>${sites.filter((r) => r.frozen).length} paused · ${sleeping.length} sleeping</small></div>
          <div class="stat ${accel ? 'good' : 'warn'}"><span>Graphics</span><b>${accel ? 'Accelerated' : 'Software'}</b><small>${esc(meta.gpu || 'GPU')}</small></div>
        </div>
        <div class="tbl-wrap"><table class="tbl tm">
          <thead><tr><th>Task</th><th>Status</th>
            <th class="num tm-sort ${lsort === 'memory' ? 'on' : ''}" data-lsort="memory">Memory</th>
            <th class="num tm-sort ${lsort === 'cpu' ? 'on' : ''}" data-lsort="cpu">CPU</th><th></th></tr></thead>
          <tbody>
            ${sorted
              .map(
                (r) => `<tr data-wc="${r.webContentsId ?? ''}" data-kind="${r.kind}">
                  <td><div class="cell-person">${name(r)}</div></td><td>${status(r)}</td>
                  <td class="num">${r.shared ? '—' : bytes(r.memory)}</td><td class="num">${r.shared ? '—' : (r.cpu || 0).toFixed(1) + '%'}</td>
                  <td class="num tm-actions">${actions(r)}</td></tr>`,
              )
              .join('')}
            ${sleeping
              .map(
                (w) => `<tr data-sleeping="${esc(w.id)}" class="tm-sleeping"><td><div class="cell-person"><img class="fav" src="${esc(favicon(w.web.url()))}" alt="" referrerpolicy="no-referrer">
                  <span class="cell-main"><b>${esc($('.win-title-text', w.el)?.textContent || hostOf(w.web.url()))}</b><small>${esc(hostOf(w.web.url()))}</small></span></div></td>
                  <td><span class="pill">Sleeping</span></td><td class="num muted">0 B</td><td class="num muted">—</td>
                  <td class="num tm-actions"><button class="btn small" data-tm="wake">Wake</button></td></tr>`,
              )
              .join('')}
          </tbody></table></div>`;
    };

    const refreshLeafdeck = async () => {
      try {
        const m = await shell.perf.metrics();
        rows = m.rows;
        meta = m;
        drawLeafdeck();
      } catch (err) {
        pane('leafdeck').innerHTML = `<div class="empty"><p>${esc(cleanError(err))}</p></div>`;
      }
    };

    pane('leafdeck').addEventListener('click', async (e) => {
      const sort = e.target.closest('[data-lsort]');
      if (sort) {
        lsort = sort.dataset.lsort;
        return drawLeafdeck();
      }
      const b = e.target.closest('[data-tm]');
      if (!b) return;
      const tr = b.closest('tr');
      if (b.dataset.tm === 'wake') {
        wins.get(tr.dataset.sleeping)?.web?.wake();
        return setTimeout(refreshLeafdeck, 600);
      }
      const id = Number(tr.dataset.wc);
      const w = windowFor(id);
      try {
        if (b.dataset.tm === 'sleep') {
          if (!w) throw new Error('That page isn’t in a Leafdeck window');
          w.web.sleep();
        } else if (b.dataset.tm === 'reload') w?.web?.reload();
        else if (b.dataset.tm === 'end') {
          await shell.perf.end(id);
          toast('Process ended — reload the page to start it again');
        }
      } catch (err) {
        toast(cleanError(err), 'error');
      }
      setTimeout(refreshLeafdeck, 600);
    });

    /* ================= timers ================= */

    win.every(1000, sample);
    win.every(2000, () => {
      if (win.minimized) return;
      if (tab === 'processes') refreshProcs();
      if (tab === 'leafdeck') refreshLeafdeck();
    });
    // CPU and rates are measured between two samples, so the first is always 0: take a second one quickly.
    sample().then(() => setTimeout(sample, 400));
    showTab(tab);
  },
});
