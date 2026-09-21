/* ============================================================================
 * dashboard/script.js
 * Lógica del dashboard MLOps: consume la API FastAPI (api/main.py) y pinta
 *   - KPIs y serie temporal de métricas en vivo (SSE + fallback por polling)
 *   - Matriz de confusión (ventana móvil / acumulada / hold-out / CV)
 *   - Mapas de calor (superficie de probabilidad y correlación) en <canvas>
 *   - Deriva de datos, coeficientes, curva ROC, eventos, logs y resumen de datos
 * Estilos: Tailwind CSS vía CDN (configurado en index.html, donde también se
 * definen las clases de componente .card, .kpi, .badge-*, .tab, .cm-cell… en un
 * bloque <style type="text/tailwindcss">). Tema claro profesional.
 * Sin frameworks JS: solo Chart.js (CDN) para los gráficos de línea/barra.
 * ========================================================================== */

(() => {
  'use strict';

  // ─────────────────────────────── utilidades ────────────────────────────────
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const fmtPct = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v)) ? '—' : `${(v * 100).toFixed(d)}%`;
  const fmtNum = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v)) ? '—' : Number(v).toFixed(d);
  const fmtMs = (v) => (v === null || v === undefined) ? '—' : `${Number(v).toFixed(2)} ms`;
  const fmtTime = (iso) => { try { return new Date(iso).toLocaleTimeString('es-PE', { hour12: false }); } catch { return iso; } };
  const fmtUptime = (s) => { s = Math.floor(s || 0); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60; return h ? `${h}h ${m}m` : m ? `${m}m ${r}s` : `${r}s`; };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const LABELS = { temperatura: 'Temperatura (°C)', humedad: 'Humedad (%)', radiacion_solar: 'Radiación solar (MJ/m²)', precipitacion: 'Precipitación (mm)', viento: 'Viento (km/h)', resultado_bin: 'Resultado (SI=1)' };
  const SHORT = { temperatura: 'Temp', humedad: 'Hum', radiacion_solar: 'Rad', precipitacion: 'Prec', viento: 'Viento', resultado_bin: 'Result.' };

  async function api(path, opts = {}) {
    const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
    if (!res.ok) {
      let detail = res.statusText;
      try { detail = (await res.json()).detail || detail; } catch { /* ignore */ }
      throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
    }
    return res.json();
  }

  function flash(el) { if (!el) return; el.classList.remove('animate-flash'); void el.offsetWidth; el.classList.add('animate-flash'); }

  // ─────────────────────────────── estado ────────────────────────────────────
  const state = {
    info: null, training: null, live: null, summary: null, sample: [],
    cmMode: 'ventana', lastPredId: null, sse: null, pollTimer: null, lastSSE: 0,
    heat: { cultivo: 'cafe', x: 'temperatura', y: 'humedad', data: null, puntos: true },
    charts: {},
  };

  // ─────────────────────────────── Chart.js base ─────────────────────────────
  Chart.defaults.color = '#64748b';
  Chart.defaults.borderColor = '#eef2f7';
  Chart.defaults.plugins.tooltip.backgroundColor = '#0f172a';
  Chart.defaults.plugins.tooltip.titleColor = '#f8fafc';
  Chart.defaults.plugins.tooltip.bodyColor = '#e2e8f0';
  Chart.defaults.plugins.tooltip.padding = 8;
  Chart.defaults.plugins.tooltip.cornerRadius = 6;
  Chart.defaults.font.family = 'Inter, ui-sans-serif, system-ui, sans-serif';
  Chart.defaults.font.size = 11;
  Chart.defaults.plugins.legend.display = false;
  Chart.defaults.animation.duration = 350;

  function initCharts() {
    state.charts.serie = new Chart($('#chart-serie'), {
      type: 'line',
      data: { labels: [], datasets: [
        { label: 'Accuracy', data: [], borderColor: '#059669', backgroundColor: 'rgba(5,150,105,.08)', tension: .35, fill: true, pointRadius: 0, borderWidth: 2 },
        { label: 'F1', data: [], borderColor: '#2546e8', tension: .35, pointRadius: 0, borderWidth: 2 },
        { label: 'Recall', data: [], borderColor: '#c026d3', tension: .35, pointRadius: 0, borderWidth: 2 },
        { label: 'Tasa SI', data: [], borderColor: '#d97706', borderDash: [4, 4], tension: .35, pointRadius: 0, borderWidth: 1.5, hidden: true },
      ] },
      options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        scales: { y: { min: 0, max: 1, ticks: { callback: v => `${Math.round(v * 100)}%` } }, x: { ticks: { maxTicksLimit: 8, maxRotation: 0 } } },
        plugins: { tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${fmtPct(c.parsed.y)}` } } } },
    });

    state.charts.cultivo = new Chart($('#chart-cultivo'), {
      type: 'bar',
      data: { labels: [], datasets: [
        { label: 'Pred. NO', data: [], backgroundColor: '#cbd5e1', borderRadius: 4 },
        { label: 'Pred. SI', data: [], backgroundColor: '#8b5cf6', borderRadius: 4 },
      ] },
      options: { responsive: true, maintainAspectRatio: false, indexAxis: 'y',
        scales: { x: { stacked: true, ticks: { precision: 0 } }, y: { stacked: true } },
        plugins: { legend: { display: true, position: 'bottom', labels: { boxWidth: 10 } } } },
    });

    state.charts.coef = new Chart($('#chart-coef'), {
      type: 'bar',
      data: { labels: [], datasets: [{ data: [], backgroundColor: [], borderRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, indexAxis: 'y',
        scales: { x: { grid: { color: ctx => ctx.tick.value === 0 ? '#94a3b8' : '#eef2f7' } } },
        plugins: { tooltip: { callbacks: { label: c => ` coef = ${fmtNum(c.parsed.x, 3)}` } } } },
    });

    state.charts.roc = new Chart($('#chart-roc'), {
      type: 'line',
      data: { datasets: [
        { label: 'ROC', data: [], borderColor: '#2546e8', backgroundColor: 'rgba(37,70,232,.10)', fill: true, stepped: false, tension: 0, pointRadius: 2 },
        { label: 'Azar', data: [{ x: 0, y: 0 }, { x: 1, y: 1 }], borderColor: '#94a3b8', borderDash: [5, 5], pointRadius: 0, borderWidth: 1 },
      ] },
      options: { responsive: true, maintainAspectRatio: false, parsing: false,
        scales: { x: { type: 'linear', min: 0, max: 1, title: { display: true, text: 'FPR (1 − especificidad)' } }, y: { min: 0, max: 1, title: { display: true, text: 'TPR (recall)' } } } },
    });
  }

  // ─────────────────────────────── KPIs ──────────────────────────────────────
  function renderKPIs(m) {
    const set = (id, v) => { const el = $(id); if (el && el.textContent !== String(v)) { el.textContent = v; flash(el.closest('[data-kpi]')); } };
    set('#kpi-total', m.total_predicciones.toLocaleString('es-PE'));
    $('#kpi-throughput').textContent = m.throughput_por_min;
    set('#kpi-accuracy', fmtPct(m.ventana.accuracy));
    $('#kpi-accuracy-acc').textContent = fmtPct(m.acumulado.accuracy);
    set('#kpi-f1', fmtPct(m.ventana.f1));
    $('#kpi-f1-acc').textContent = fmtPct(m.acumulado.f1);
    set('#kpi-precision', fmtPct(m.ventana.precision));
    set('#kpi-recall', fmtPct(m.ventana.recall));
    set('#kpi-tasa', fmtPct(m.tasa_prediccion_si));
    set('#kpi-p95', fmtMs(m.latencia_ms.p95));
    $('#kpi-p50').textContent = fmtMs(m.latencia_ms.p50);
    set('#kpi-pend', m.pendientes_feedback);
    $('#kpi-etiq').textContent = m.total_etiquetadas;
    $('#hdr-uptime').textContent = fmtUptime(m.uptime_s);
    $('#hdr-last').textContent = fmtTime(m.timestamp);
    $('#lbl-window').textContent = m.ventana.tamano;

    // semáforo de accuracy
    const acc = $('#kpi-accuracy');
    acc.className = 'kpi-value ' + (m.ventana.accuracy === null ? 'text-slate-400' : m.ventana.accuracy >= .75 ? 'text-emerald-600' : m.ventana.accuracy >= .6 ? 'text-amber-600' : 'text-rose-600');

    if (state.summary && state.summary.distribucion_resultado) {
      const d = state.summary.distribucion_resultado; const tot = (d.SI || 0) + (d.NO || 0);
      $('#kpi-tasa-train').textContent = tot ? fmtPct((d.SI || 0) / tot) : '—';
    }
  }

  // ─────────────────────────────── serie temporal ────────────────────────────
  function renderSerie(serie) {
    const ch = state.charts.serie; if (!ch) return;
    ch.data.labels = serie.map(p => fmtTime(p.t));
    ch.data.datasets[0].data = serie.map(p => p.accuracy);
    ch.data.datasets[1].data = serie.map(p => p.f1);
    ch.data.datasets[2].data = serie.map(p => p.recall);
    ch.data.datasets[3].data = serie.map(p => p.tasa_si);
    ch.update('none');
  }

  // ─────────────────────────────── matriz de confusión ───────────────────────
  function currentCM() {
    const t = state.training || {};
    switch (state.cmMode) {
      case 'acumulado': return { ...state.live.acumulado, subtitle: 'Producción · acumulado desde el arranque' };
      case 'holdout': return t.holdout ? { ...t.holdout, subtitle: `Entrenamiento · hold-out (${t.n_test} filas)` } : null;
      case 'cv': return t.cv ? { ...t.cv, subtitle: `Entrenamiento · validación cruzada ${t.cv.n_splits}× (out-of-fold)` } : null;
      default: return state.live ? { ...state.live.ventana, subtitle: `Producción · ventana móvil (últimas ${state.live.ventana.tamano} etiquetadas)` } : null;
    }
  }

  function renderCM() {
    const cm = currentCM(); if (!cm) return;
    const [[tn, fp], [fn, tp]] = cm.matriz_confusion;
    const n = tn + fp + fn + tp || 1;
    const cells = { 'cm-tn': [tn, 'emerald'], 'cm-fp': [fp, 'rose'], 'cm-fn': [fn, 'rose'], 'cm-tp': [tp, 'emerald'] };
    for (const [id, [v, tone]] of Object.entries(cells)) {
      const el = document.getElementById(id);
      const num = el.querySelector('.cm-num');
      if (num.textContent !== String(v)) { num.textContent = v; flash(el); }
      el.querySelector('.pct').textContent = fmtPct(v / n, 0);
      const alpha = 0.10 + 0.55 * (v / n);
      el.style.backgroundColor = tone === 'emerald' ? `rgba(16,185,129,${alpha})` : `rgba(244,63,94,${alpha})`;
      num.style.color = alpha > .42 ? '#ffffff' : '#0f172a';
    }
    $('#cm-subtitle').textContent = cm.subtitle;
    $('#cm-acc').textContent = fmtPct(cm.accuracy);
    $('#cm-f1').textContent = fmtPct(cm.f1);
    $('#cm-n').textContent = cm.n;
  }

  // ─────────────────────────────── mapas de calor (canvas) ───────────────────
  // Escala tipo "viridis→magma" simplificada para P(SI): azul oscuro → verde → amarillo → rojo
  function colorProb(t) {
    t = clamp(t, 0, 1);
    // escala secuencial (estilo viridis) adecuada para fondo claro
    const stops = [[0, [68, 1, 84]], [.25, [59, 82, 139]], [.5, [33, 145, 140]], [.75, [94, 201, 98]], [1, [253, 231, 37]]];
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i][0]) {
        const [t0, c0] = stops[i - 1], [t1, c1] = stops[i]; const k = (t - t0) / (t1 - t0);
        return `rgb(${c0.map((c, j) => Math.round(c + (c1[j] - c) * k)).join(',')})`;
      }
    }
    return 'rgb(253,231,37)';
  }
  // Escala divergente para correlación: azul (−1) → gris oscuro (0) → rojo (+1)
  function colorCorr(r) {
    r = clamp(r, -1, 1);
    const neg = [37, 99, 235], mid = [248, 250, 252], pos = [220, 38, 38];
    const [a, b, k] = r < 0 ? [mid, neg, -r] : [mid, pos, r];
    return `rgb(${a.map((c, j) => Math.round(c + (b[j] - c) * k)).join(',')})`;
  }

  function drawLegend(canvasId, colorFn, from, to) {
    const c = document.getElementById(canvasId), ctx = c.getContext('2d');
    for (let i = 0; i < c.height; i++) { const t = to - (to - from) * (i / (c.height - 1)); ctx.fillStyle = colorFn(t); ctx.fillRect(0, i, c.width, 1); }
  }

  function setupCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 500, cssH = parseInt(canvas.getAttribute('height'), 10) || 360;
    canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
    canvas.style.height = `${cssH}px`;
    const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, W: cssW, H: cssH };
  }

  const tooltip = $('#tooltip');
  function showTip(x, y, html) { tooltip.innerHTML = html; tooltip.classList.remove('hidden'); tooltip.style.left = `${x + 14}px`; tooltip.style.top = `${y + 14}px`; }
  function hideTip() { tooltip.classList.add('hidden'); }

  function drawHeatProb() {
    const canvas = $('#heat-prob'), d = state.heat.data; if (!d) return;
    const { ctx, W, H } = setupCanvas(canvas);
    const pad = { l: 52, r: 10, t: 10, b: 40 }; const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
    const nx = d.xs.length, ny = d.ys.length; const cw = pw / nx, chh = ph / ny;
    ctx.clearRect(0, 0, W, H);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      ctx.fillStyle = colorProb(d.z[j][i]);
      ctx.fillRect(pad.l + i * cw, pad.t + (ny - 1 - j) * chh, cw + .5, chh + .5);
    }
    // isolínea del umbral 0.5 (celdas cuya vecina cruza 0.5)
    ctx.strokeStyle = 'rgba(255,255,255,.95)'; ctx.lineWidth = 1.4; ctx.setLineDash([3, 3]);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const v = d.z[j][i] >= .5; const x0 = pad.l + i * cw, y0 = pad.t + (ny - 1 - j) * chh;
      if (i + 1 < nx && (d.z[j][i + 1] >= .5) !== v) { ctx.beginPath(); ctx.moveTo(x0 + cw, y0); ctx.lineTo(x0 + cw, y0 + chh); ctx.stroke(); }
      if (j + 1 < ny && (d.z[j + 1][i] >= .5) !== v) { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0 + cw, y0); ctx.stroke(); }
    }
    ctx.setLineDash([]);
    // puntos reales del dataset (del cultivo seleccionado)
    const xmin = d.xs[0], xmax = d.xs[nx - 1], ymin = d.ys[0], ymax = d.ys[ny - 1];
    const sx = v => pad.l + ((v - xmin) / (xmax - xmin)) * pw, sy = v => pad.t + ph - ((v - ymin) / (ymax - ymin)) * ph;
    if (state.heat.puntos) {
      for (const r of state.sample.filter(r => r.cultivo === d.cultivo)) {
        const px = clamp(sx(r[d.x]), pad.l, pad.l + pw), py = clamp(sy(r[d.y]), pad.t, pad.t + ph);
        ctx.beginPath(); ctx.arc(px, py, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = r.resultado === 'SI' ? '#f97316' : '#ffffff'; ctx.fill();
        ctx.lineWidth = 1.5; ctx.strokeStyle = r.resultado === 'SI' ? '#7c2d12' : '#334155'; ctx.stroke();
      }
    }
    // ejes
    ctx.fillStyle = '#64748b'; ctx.font = '10px Inter, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let k = 0; k <= 4; k++) { const v = xmin + (xmax - xmin) * k / 4; ctx.fillText(v.toFixed(1), sx(v), pad.t + ph + 4); }
    ctx.fillText(LABELS[d.x], pad.l + pw / 2, pad.t + ph + 20);
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let k = 0; k <= 4; k++) { const v = ymin + (ymax - ymin) * k / 4; ctx.fillText(v.toFixed(1), pad.l - 6, sy(v)); }
    ctx.save(); ctx.translate(12, pad.t + ph / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(LABELS[d.y], 0, 0); ctx.restore();
    // leyenda puntos
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.font = '10px Inter, sans-serif';
    const lx = pad.l + 10, ly = pad.t + 11;
    ctx.fillStyle = 'rgba(255,255,255,.92)'; ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(lx - 8, ly - 9, 158, 19, 4); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(lx, ly, 4, 0, Math.PI * 2); ctx.fillStyle = '#f97316'; ctx.fill(); ctx.strokeStyle = '#7c2d12'; ctx.stroke(); ctx.fillStyle = '#334155'; ctx.fillText('SI', lx + 8, ly);
    ctx.beginPath(); ctx.arc(lx + 30, ly, 4, 0, Math.PI * 2); ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.strokeStyle = '#334155'; ctx.stroke(); ctx.fillStyle = '#334155'; ctx.fillText('NO', lx + 38, ly);
    ctx.fillText('- - umbral 0.5', lx + 64, ly);

    canvas.onmousemove = (ev) => {
      const rect = canvas.getBoundingClientRect(); const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
      const i = Math.floor((mx - pad.l) / cw), jj = Math.floor((my - pad.t) / chh);
      if (i < 0 || i >= nx || jj < 0 || jj >= ny) return hideTip();
      const j = ny - 1 - jj;
      showTip(ev.clientX, ev.clientY, `${SHORT[d.x]} ${d.xs[i]} · ${SHORT[d.y]} ${d.ys[j]}<br><b>P(SI) = ${fmtNum(d.z[j][i], 3)}</b>`);
    };
    canvas.onmouseleave = hideTip;
    $('#hm-fijas').textContent = 'Variables fijas: ' + Object.entries(d.fijas).map(([k, v]) => `${SHORT[k]}=${fmtNum(v, 1)}`).join(' · ') + ` · cultivo=${d.cultivo}`;
  }

  function drawHeatCorr() {
    const mc = state.training && state.training.matriz_correlacion; if (!mc) return;
    const canvas = $('#heat-corr'); const { ctx, W, H } = setupCanvas(canvas);
    const cols = mc.columnas, n = cols.length; const pad = { l: 70, r: 10, t: 10, b: 58 };
    const size = Math.min(W - pad.l - pad.r, H - pad.t - pad.b); const cs = size / n;
    const ox = pad.l + ((W - pad.l - pad.r) - size) / 2, oy = pad.t;
    ctx.clearRect(0, 0, W, H);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const v = mc.valores[j][i];
      ctx.fillStyle = colorCorr(v); ctx.fillRect(ox + i * cs + 1, oy + j * cs + 1, cs - 2, cs - 2);
      ctx.fillStyle = Math.abs(v) > .55 ? '#ffffff' : '#1e293b'; ctx.font = `${cs > 48 ? 12 : 10}px JetBrains Mono, monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(v.toFixed(2), ox + i * cs + cs / 2, oy + j * cs + cs / 2);
    }
    ctx.fillStyle = '#64748b'; ctx.font = '10px Inter, sans-serif';
    for (let i = 0; i < n; i++) {
      ctx.save(); ctx.translate(ox + i * cs + cs / 2, oy + size + 8); ctx.rotate(-Math.PI / 5); ctx.textAlign = 'right'; ctx.textBaseline = 'top'; ctx.fillText(SHORT[cols[i]] || cols[i], 0, 0); ctx.restore();
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(SHORT[cols[i]] || cols[i], ox - 6, oy + i * cs + cs / 2);
    }
    canvas.onmousemove = (ev) => {
      const rect = canvas.getBoundingClientRect(); const i = Math.floor((ev.clientX - rect.left - ox) / cs), j = Math.floor((ev.clientY - rect.top - oy) / cs);
      if (i < 0 || j < 0 || i >= n || j >= n) return hideTip();
      showTip(ev.clientX, ev.clientY, `${LABELS[cols[j]] || cols[j]}<br>× ${LABELS[cols[i]] || cols[i]}<br><b>r = ${mc.valores[j][i].toFixed(3)}</b>`);
    };
    canvas.onmouseleave = hideTip;
  }

  async function loadHeatProb() {
    const { cultivo, x, y } = state.heat;
    try {
      state.heat.data = await api(`/api/heatmap/probability?cultivo=${encodeURIComponent(cultivo)}&x=${x}&y=${y}&resolucion=28`);
      drawHeatProb();
    } catch (e) { console.warn('heatmap', e); }
  }

  function setupHeatControls() {
    const feats = state.info.features_numericas;
    const selC = $('#hm-cultivo'), selX = $('#hm-x'), selY = $('#hm-y');
    selC.innerHTML = state.info.categorias_cultivo.map(c => `<option value="${c}">${c}</option>`).join('');
    selX.innerHTML = feats.map(f => `<option value="${f}">${LABELS[f]}</option>`).join('');
    selY.innerHTML = feats.map(f => `<option value="${f}">${LABELS[f]}</option>`).join('');
    selC.value = state.heat.cultivo = state.info.categorias_cultivo.includes('cafe') ? 'cafe' : state.info.categorias_cultivo[0];
    selX.value = state.heat.x; selY.value = state.heat.y;
    const onChange = () => {
      state.heat.cultivo = selC.value;
      if (selX.value === selY.value) { selY.value = feats.find(f => f !== selX.value); }
      state.heat.x = selX.value; state.heat.y = selY.value; loadHeatProb();
    };
    selC.onchange = selX.onchange = selY.onchange = onChange;
    $('#hm-puntos').onchange = (e) => { state.heat.puntos = e.target.checked; drawHeatProb(); };
  }

  // ─────────────────────────────── deriva y cultivo ──────────────────────────
  function renderDrift(m) {
    const cont = $('#drift-list'); const rows = Object.entries(m.deriva || {});
    if (!rows.length) { cont.innerHTML = '<p class="text-xs text-slate-400">Sin datos todavía.</p>'; return; }
    cont.innerHTML = rows.map(([f, d]) => {
      const z = d.z ?? 0; const az = Math.abs(z);
      const tone = az > 2 ? 'bg-rose-500' : az > 1 ? 'bg-amber-500' : 'bg-emerald-500';
      const zcls = az > 2 ? 'text-rose-600' : az > 1 ? 'text-amber-600' : 'text-emerald-600';
      const w = clamp(az / 3 * 50, 2, 50);
      const side = z >= 0 ? `left:50%;width:${w}%` : `left:${50 - w}%;width:${w}%`;
      return `<div>
        <div class="flex justify-between text-xs"><span class="text-slate-700">${LABELS[f]}</span><span class="font-mono text-slate-500">${fmtNum(d.media_actual, 2)} <span class="text-slate-400">vs</span> ${fmtNum(d.media_entrenamiento, 2)} · z=<b class="${zcls}">${z >= 0 ? '+' : ''}${fmtNum(z, 2)}</b></span></div>
        <div class="drift-track"><div class="drift-mid"></div><div class="drift-bar ${tone}" style="${side}"></div></div>
      </div>`;
    }).join('');

    const ch = state.charts.cultivo; const cult = Object.entries(m.por_cultivo || {}).sort();
    ch.data.labels = cult.map(([c]) => c);
    ch.data.datasets[0].data = cult.map(([, d]) => d.total - d.si);
    ch.data.datasets[1].data = cult.map(([, d]) => d.si);
    ch.update('none');
  }

  // ─────────────────────────────── entrenamiento ─────────────────────────────
  function renderTraining() {
    const t = state.training; if (!t) return;
    $('#hdr-model').textContent = `${t.modelo} v${t.version}`;
    const entries = Object.entries(t.coeficientes).sort((a, b) => a[1] - b[1]);
    const ch = state.charts.coef;
    ch.data.labels = entries.map(([k]) => LABELS[k] || k.replace('cultivo_', 'cultivo = '));
    ch.data.datasets[0].data = entries.map(([, v]) => v);
    ch.data.datasets[0].backgroundColor = entries.map(([, v]) => v >= 0 ? '#10b981' : '#f43f5e');
    ch.update();

    const roc = state.charts.roc;
    roc.data.datasets[0].data = t.roc_curve.fpr.map((x, i) => ({ x, y: t.roc_curve.tpr[i] }));
    roc.update(); $('#roc-auc').textContent = fmtNum(t.cv.roc_auc, 3);

    const rows = [
      ['Modelo', t.modelo], ['Versión', t.version], ['Entrenado', new Date(t.fecha_entrenamiento).toLocaleString('es-PE')], ['scikit-learn', t.sklearn_version],
      ['Filas', t.n_filas], ['Train / Test', `${t.n_train} / ${t.n_test}`],
      ['Accuracy hold-out', fmtPct(t.holdout.accuracy)], ['F1 hold-out', fmtPct(t.holdout.f1)],
      ['Accuracy CV', fmtPct(t.cv.accuracy)], ['F1 CV', fmtPct(t.cv.f1)], ['ROC-AUC CV', fmtNum(t.cv.roc_auc, 3)], ['Recall CV', fmtPct(t.cv.recall)],
      ['Artefacto', 'models/modelo.joblib'], ['Métricas', 'models/metricas.json'],
    ];
    $('#train-info').innerHTML = rows.map(([k, v]) => `<div class="flex justify-between gap-2 border-b border-slate-100 pb-1"><dt class="text-slate-500">${k}</dt><dd class="font-mono text-slate-900 text-right">${v}</dd></div>`).join('');
  }

  // ─────────────────────────────── eventos ───────────────────────────────────
  const MAX_ROWS = 60;
  function eventRow(e) {
    const pred = e.prediccion === 1 ? 'SI' : 'NO';
    const real = e.real === null || e.real === undefined ? null : (e.real === 1 ? 'SI' : 'NO');
    const ok = real === null ? null : real === pred;
    const f = e.features;
    const badge = (txt, cls) => `<span class="${cls}">${txt}</span>`;
    return `<tr data-id="${e.id}" class="animate-rise ${ok === false ? 'row-error' : ''}">
      <td class="text-slate-400">${fmtTime(e.timestamp)}</td>
      <td><span class="${e.origen === 'api' ? 'badge-origen-api' : 'badge-origen'}">${e.origen}</span></td>
      <td>${f.cultivo}</td>
      <td class="text-right">${fmtNum(f.temperatura, 1)}</td><td class="text-right">${fmtNum(f.humedad, 1)}</td><td class="text-right">${fmtNum(f.radiacion_solar, 1)}</td><td class="text-right">${fmtNum(f.precipitacion, 1)}</td><td class="text-right">${fmtNum(f.viento, 1)}</td>
      <td class="text-right"><span class="inline-block w-12 text-right">${fmtNum(e.probabilidad_si, 3)}</span><span class="inline-block ml-1 h-1.5 w-10 rounded bg-slate-100 align-middle overflow-hidden"><span class="block h-full" style="width:${e.probabilidad_si * 100}%;background:${colorProb(e.probabilidad_si)}"></span></span></td>
      <td class="text-center">${badge(pred, pred === 'SI' ? 'badge-si' : 'badge-no')}</td>
      <td class="text-center real-cell">${real === null ? '<span class="text-slate-300">…</span>' : badge(real, ok ? 'badge-ok' : 'badge-err') + (ok ? ' <span class="text-emerald-600">✓</span>' : ' <span class="text-rose-600">✗</span>')}</td>
      <td class="text-right text-slate-400">${fmtNum(e.latencia_ms, 2)}</td>
    </tr>`;
  }
  function renderEvents(list) { $('#events-body').innerHTML = list.slice(0, MAX_ROWS).map(eventRow).join(''); }
  function prependEvent(e) {
    const body = $('#events-body'); body.insertAdjacentHTML('afterbegin', eventRow(e));
    while (body.children.length > MAX_ROWS) body.lastElementChild.remove();
  }
  function updateEventRow(e) {
    const tr = $(`#events-body tr[data-id="${e.id}"]`); if (!tr) return;
    tr.outerHTML = eventRow(e);
  }

  // ─────────────────────────────── logs y datos ──────────────────────────────
  let logFile = 'api';
  async function loadLogs() {
    try {
      const r = await api(`/api/logs?n=60&archivo=${logFile}`);
      $('#log-view').innerHTML = r.lineas.map(l => {
        const cls = /ERROR|CRITICAL/.test(l) ? 'log-error' : /WARNING/.test(l) ? 'log-warn' : '';
        return `<span class="${cls}">${l.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</span>`;
      }).join('\n') || '<span class="text-slate-400">— sin registros —</span>';
    } catch (e) { $('#log-view').textContent = `Error: ${e.message}`; }
  }

  function renderSummary() {
    const s = state.summary; if (!s) return;
    $('#ds-fecha').textContent = new Date(s.fecha_ejecucion).toLocaleString('es-PE');
    $('#ds-filas').textContent = s.filas_totales; $('#ds-validas').textContent = s.filas_validas; $('#ds-invalidas').textContent = s.filas_invalidas;
    const feats = Object.keys(s.promedio_general); const cults = Object.keys(s.promedio_por_cultivo).sort();
    $('#ds-table thead').innerHTML = `<tr><th class="text-left">Variable</th><th class="text-right">Válidos</th><th class="text-right">Inválidos</th><th class="text-right">Mín</th><th class="text-right">Promedio</th><th class="text-right">Máx</th>${cults.map(c => `<th class="text-right">Prom. ${c} <span class="lowercase text-slate-400">(SI ${fmtPct(s.tasa_si_por_cultivo[c], 0)})</span></th>`).join('')}</tr>`;
    $('#ds-table tbody').innerHTML = feats.map(f => { const c = s.columnas_numericas[f]; return `<tr><td class="font-sans text-slate-800">${LABELS[f]}</td><td class="text-right">${c.validos}</td><td class="text-right ${c.invalidos ? 'text-rose-600 font-medium' : 'text-slate-400'}">${c.invalidos}</td><td class="text-right">${fmtNum(c.min, 1)}</td><td class="text-right font-medium text-brand-700">${fmtNum(c.promedio, 2)}</td><td class="text-right">${fmtNum(c.max, 1)}</td>${cults.map(cu => `<td class="text-right">${fmtNum(s.promedio_por_cultivo[cu][f], 2)}</td>`).join('')}</tr>`; }).join('');
  }

  // ─────────────────────────────── formulario de predicción ──────────────────
  function setupForm() {
    const info = state.info; const sel = $('#f-cultivo');
    sel.innerHTML = info.categorias_cultivo.map(c => `<option value="${c}">${c}</option>`).join('');
    const cont = $('#f-sliders');
    cont.innerHTML = info.features_numericas.map(f => {
      const [lo, hi] = info.rangos[f] || [0, 100]; const mid = ((lo + hi) / 2).toFixed(1);
      const step = (hi - lo) > 50 ? 0.5 : 0.1;
      return `<div><div class="flex justify-between text-xs"><label for="f-${f}" class="text-slate-500">${LABELS[f]}</label><output id="o-${f}" class="font-mono text-slate-900">${mid}</output></div>
        <input id="f-${f}" name="${f}" type="range" min="${(lo * 0.9).toFixed(1)}" max="${(hi * 1.1).toFixed(1)}" step="${step}" value="${mid}" class="range mt-1" oninput="document.getElementById('o-${f}').value=this.value"></div>`;
    }).join('');
    $('#f-umbral').oninput = (e) => { $('#f-umbral-val').textContent = Number(e.target.value).toFixed(2); };

    $('#btn-aleatorio').onclick = () => {
      if (!state.sample.length) return;
      const r = state.sample[Math.floor(Math.random() * state.sample.length)];
      sel.value = r.cultivo;
      for (const f of info.features_numericas) { const inp = $(`#f-${f}`); inp.value = r[f]; $(`#o-${f}`).value = r[f]; }
      $('#fb-status').textContent = `fila #${r.id} del dataset (real: ${r.resultado})`;
    };

    $('#form-pred').onsubmit = async (ev) => {
      ev.preventDefault();
      const body = { cultivo: sel.value };
      for (const f of info.features_numericas) body[f] = Number($(`#f-${f}`).value);
      const umbral = $('#f-umbral').value;
      const btn = ev.target.querySelector('button[type=submit]'); btn.disabled = true; btn.textContent = 'Prediciendo…';
      try {
        const r = await api(`/predict?umbral=${umbral}`, { method: 'POST', body: JSON.stringify(body) });
        state.lastPredId = r.id;
        const box = $('#pred-result'); box.classList.remove('hidden'); box.classList.remove('animate-rise'); void box.offsetWidth; box.classList.add('animate-rise');
        $('#pred-label').textContent = r.prediccion; $('#pred-label').className = 'text-3xl font-bold ' + (r.prediccion === 'SI' ? 'text-violet-700' : 'text-slate-800');
        $('#pred-prob').textContent = fmtNum(r.probabilidad_si, 3); $('#pred-bar').style.width = `${r.probabilidad_si * 100}%`;
        $('#pred-lat').textContent = `${r.latencia_ms} ms · id ${r.id}`;
        if (!/fila #/.test($('#fb-status').textContent)) $('#fb-status').textContent = '';
        $$('.fb-btn').forEach(b => b.disabled = false);
      } catch (e) { alert(`Error al predecir: ${e.message}`); }
      finally { btn.disabled = false; btn.textContent = 'Predecir'; }
    };

    $$('.fb-btn').forEach(b => b.onclick = async () => {
      if (!state.lastPredId) return;
      try {
        const r = await api('/feedback', { method: 'POST', body: JSON.stringify({ id: state.lastPredId, real: b.dataset.real }) });
        $('#fb-status').textContent = r.acierto ? '✓ acierto registrado' : '✗ error registrado';
        $$('.fb-btn').forEach(x => x.disabled = true);
      } catch (e) { $('#fb-status').textContent = e.message; }
    });
  }

  // ─────────────────────────────── simulador ─────────────────────────────────
  function setupSimulator() {
    const btn = $('#sim-toggle');
    btn.onclick = async () => {
      const activo = state.live && state.live.simulador.activo;
      await api('/api/simulator', { method: 'POST', body: JSON.stringify({ accion: activo ? 'stop' : 'start' }) });
    };
    const speed = $('#sim-speed'); let t;
    speed.oninput = () => { $('#sim-speed-val').textContent = `${Number(speed.value).toFixed(1)}s`; clearTimeout(t); t = setTimeout(() => api('/api/simulator', { method: 'POST', body: JSON.stringify({ accion: 'speed', intervalo: Number(speed.value) }) }), 300); };
    $('#sim-burst').onclick = async () => { await api('/api/simulator', { method: 'POST', body: JSON.stringify({ accion: 'burst', cantidad: 25 }) }); refreshEvents(); };
  }
  function renderSimulator(m) {
    const btn = $('#sim-toggle');
    if (m.simulador.activo) { btn.textContent = '● Activo'; btn.className = 'btn-emerald'; }
    else { btn.textContent = '■ Detenido'; btn.className = 'btn-rose'; }
    const sp = $('#sim-speed'); if (document.activeElement !== sp) { sp.value = m.simulador.intervalo_s; $('#sim-speed-val').textContent = `${Number(m.simulador.intervalo_s).toFixed(1)}s`; }
  }

  // ─────────────────────────────── aplicar métricas ──────────────────────────
  function applyLive(m) {
    state.live = m; renderKPIs(m); renderSerie(m.serie); if (state.cmMode === 'ventana' || state.cmMode === 'acumulado') renderCM(); renderDrift(m); renderSimulator(m);
  }
  async function refreshEvents() { try { const r = await api('/api/events?n=60'); renderEvents(r.eventos); } catch { /* ignore */ } }

  // ─────────────────────────────── conexión SSE ──────────────────────────────
  function setConn(status) {
    const badge = $('#conn-badge'), txt = $('#conn-text'), dot = badge.querySelector('span');
    const map = {
      live: ['border-emerald-200 bg-emerald-50 text-emerald-700', 'bg-emerald-500', 'En vivo (SSE)'],
      poll: ['border-sky-200 bg-sky-50 text-sky-700', 'bg-sky-500', 'Polling 3s'],
      off: ['border-rose-200 bg-rose-50 text-rose-700', 'bg-rose-500', 'Sin conexión'],
      wait: ['border-amber-200 bg-amber-50 text-amber-700', 'bg-amber-500', 'Conectando…'],
    };
    const [b, d, t] = map[status];
    badge.className = `pill ${b}`; dot.className = `h-2 w-2 rounded-full ${d} animate-pulseDot`; txt.textContent = t;
  }

  function connectSSE() {
    if (!('EventSource' in window)) return startPolling();
    setConn('wait');
    const es = new EventSource('/api/stream'); state.sse = es;
    es.onopen = () => { setConn('live'); stopPolling(); };
    es.onmessage = (ev) => {
      state.lastSSE = Date.now();
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.tipo === 'metricas') applyLive(msg.metricas);
      else if (msg.tipo === 'prediccion') prependEvent(msg.evento);
      else if (msg.tipo === 'feedback') updateEventRow(msg.evento);
      // msg.tipo === 'ping' → solo actualiza lastSSE (latido del servidor)
    };
    es.onerror = () => { setConn('poll'); startPolling(); };
  }
  function startPolling() {
    if (state.pollTimer) return;
    state.pollTimer = setInterval(async () => {
      try { applyLive(await api('/api/metrics/live')); refreshEvents(); if (state.sse && state.sse.readyState === EventSource.OPEN) { setConn('live'); stopPolling(); } else setConn('poll'); }
      catch { setConn('off'); }
    }, 3000);
  }
  function stopPolling() { if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; } }

  // ─────────────────────────────── tabs ──────────────────────────────────────
  function setupTabs() {
    const activate = (btns, active) => btns.forEach(b => { b.classList.toggle('tab-active', b === active); b.setAttribute('aria-selected', b === active); });
    const cmTabs = $$('.cm-tab'); cmTabs.forEach(b => b.onclick = () => { state.cmMode = b.dataset.cm; activate(cmTabs, b); renderCM(); });
    const trTabs = $$('.tr-tab'); trTabs.forEach(b => b.onclick = () => { activate(trTabs, b); ['coef', 'roc', 'train'].forEach(p => $(`#panel-${p}`).classList.toggle('hidden', p !== b.dataset.panel)); if (b.dataset.panel === 'roc') state.charts.roc.resize(); if (b.dataset.panel === 'coef') state.charts.coef.resize(); });
    const logTabs = $$('.log-tab'); logTabs.forEach(b => b.onclick = () => { logFile = b.dataset.log; activate(logTabs, b); loadLogs(); });
    $$('.serie-toggle').forEach(cb => cb.onchange = () => { const ds = state.charts.serie.data.datasets[+cb.dataset.ds]; ds.hidden = !cb.checked; state.charts.serie.update(); });
  }

  // ─────────────────────────────── arranque ──────────────────────────────────
  async function init() {
    initCharts(); setupTabs(); setupSimulator();
    drawLegend('heat-prob-legend', colorProb, 0, 1); drawLegend('heat-corr-legend', colorCorr, -1, 1);
    try {
      const [info, training, live, summary, sample, events] = await Promise.all([
        api('/api/info'), api('/api/metrics/training').catch(() => null), api('/api/metrics/live'),
        api('/api/data/summary').catch(() => null), api('/api/data/sample?n=500').catch(() => ({ filas: [] })), api('/api/events?n=60'),
      ]);
      state.info = info; state.training = training; state.summary = summary; state.sample = sample.filas;
      setupForm(); setupHeatControls(); renderTraining(); renderSummary(); drawHeatCorr(); applyLive(live); renderEvents(events.eventos);
      await loadHeatProb(); loadLogs();
      connectSSE();
      setInterval(loadLogs, 10000);
      // vigilancia: si el SSE calla más de 20 s, reconectar
      setInterval(() => { if (state.sse && Date.now() - state.lastSSE > 20000 && state.sse.readyState !== EventSource.CONNECTING) { state.sse.close(); connectSSE(); } }, 5000);
      let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { drawHeatProb(); drawHeatCorr(); }, 150); });
    } catch (e) {
      setConn('off');
      document.body.insertAdjacentHTML('afterbegin', `<div class="alert-banner">No se pudo conectar con la API: ${e.message}. Ejecuta <code class="bg-rose-700 text-white">uvicorn api.main:app --port 8000</code> desde la raíz del proyecto.</div>`);
      console.error(e);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
