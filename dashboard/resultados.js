/* ============================================================================
 * dashboard/resultados.js
 * Página /resultados: carga output/resultado.json desde la API, lo muestra
 * (KPIs, tabla de variables, distribuciones, árbol navegable y JSON resaltado)
 * y ofrece descarga (JSON / CSV), copia al portapapeles y re-procesado.
 * ========================================================================== */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const fmtNum = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v)) ? '—' : Number(v).toFixed(d);
  const fmtPct = (v, d = 0) => (v === null || v === undefined) ? '—' : `${(v * 100).toFixed(d)}%`;
  const LABELS = { temperatura: 'Temperatura (°C)', humedad: 'Humedad (%)', radiacion_solar: 'Radiación solar (MJ/m²)', precipitacion: 'Precipitación (mm)', viento: 'Viento (km/h)' };
  const CULTIVO_COLORS = { cafe: '#b45309', papa: '#7c3aed', uva: '#0e7490' };

  let datos = null;

  async function api(path, opts = {}) {
    const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
    if (!res.ok) {
      let detail = res.statusText;
      try { detail = (await res.json()).detail || detail; } catch { /* ignore */ }
      throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
    }
    return res.json();
  }

  function setEstado(msg, ok = true) {
    const el = $('#estado'); el.textContent = msg; el.className = `text-xs ${ok ? 'text-emerald-700' : 'text-rose-700'}`;
    if (msg) setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 5000);
  }

  // ─────────────────────────────── KPIs ──────────────────────────────────────
  function renderKPIs(r, tamano) {
    const total = r.filas_totales || 0;
    const dist = r.distribucion_resultado || {};
    const si = dist.SI || 0, no = dist.NO || 0;
    const cultivos = Object.keys(r.distribucion_cultivo || {}).sort();
    $('#k-filas').textContent = total;
    $('#k-origen').textContent = `origen: ${r.archivo_origen || 'datos.csv'}`;
    $('#k-validas').textContent = r.filas_validas ?? '—';
    $('#k-validas-pct').textContent = total ? `${fmtPct(r.filas_validas / total, 1)} del total` : '—';
    $('#k-invalidas').textContent = r.filas_invalidas ?? '—';
    $('#k-si-no').textContent = `${si} / ${no}`;
    $('#k-tasa-si').textContent = (si + no) ? `tasa de SI ${fmtPct(si / (si + no), 1)}` : '—';
    $('#k-cultivos').textContent = cultivos.length;
    $('#k-cultivos-lista').textContent = cultivos.join(' · ') || '—';
    const fecha = r.fecha_ejecucion ? new Date(r.fecha_ejecucion) : null;
    $('#k-fecha').textContent = fecha ? fecha.toLocaleDateString('es-PE', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' + fecha.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
    $('#k-tamano').textContent = tamano ? `${(tamano / 1024).toFixed(1)} KB` : '';
  }

  // ─────────────────────────────── tabla de variables ────────────────────────
  function renderTabla(r) {
    const cols = r.columnas_numericas || {};
    const cultivos = Object.keys(r.promedio_por_cultivo || {}).sort();
    $('#tabla-vars thead').innerHTML = `<tr><th class="text-left">Variable</th><th class="text-right">Válidos</th><th class="text-right">Inválidos</th>
      <th class="text-right">Mín</th><th class="text-right">Promedio</th><th class="text-right">Máx</th><th class="text-left w-40">Posición del promedio</th>
      ${cultivos.map((c) => `<th class="text-right">Prom. ${esc(c)} <span class="lowercase text-slate-400">(SI ${fmtPct((r.tasa_si_por_cultivo || {})[c])})</span></th>`).join('')}</tr>`;
    $('#tabla-vars tbody').innerHTML = Object.entries(cols).map(([f, c]) => {
      const rango = (c.max - c.min) || 1; const pos = Math.max(0, Math.min(100, ((c.promedio - c.min) / rango) * 100));
      return `<tr>
        <td class="font-sans text-slate-800">${esc(LABELS[f] || f)}</td>
        <td class="text-right">${c.validos}</td>
        <td class="text-right ${c.invalidos ? 'text-rose-600 font-medium' : 'text-slate-400'}">${c.invalidos}</td>
        <td class="text-right">${fmtNum(c.min, 1)}</td>
        <td class="text-right font-medium text-brand-700">${fmtNum(c.promedio, 2)}</td>
        <td class="text-right">${fmtNum(c.max, 1)}</td>
        <td><div class="relative h-2 w-36 rounded-full bg-slate-100"><div class="absolute inset-y-0 left-0 mini-bar" style="width:${pos}%"></div></div></td>
        ${cultivos.map((cu) => `<td class="text-right">${fmtNum((r.promedio_por_cultivo[cu] || {})[f], 2)}</td>`).join('')}
      </tr>`;
    }).join('');
  }

  // ─────────────────────────────── distribuciones ────────────────────────────
  function barra(label, valor, total, color, extra = '') {
    const pct = total ? (valor / total) * 100 : 0;
    return `<div>
      <div class="flex items-baseline justify-between text-xs"><span class="font-medium text-slate-700">${esc(label)}</span>
        <span class="font-mono text-slate-500"><b class="text-slate-900">${valor}</b> · ${pct.toFixed(1)}%${extra}</span></div>
      <div class="mt-1 h-2.5 w-full rounded-full bg-slate-100"><div class="h-full rounded-full transition-all duration-700" style="width:${pct}%;background:${color}"></div></div>
    </div>`;
  }
  function renderDistribuciones(r) {
    const dr = r.distribucion_resultado || {}; const totalR = Object.values(dr).reduce((a, b) => a + b, 0);
    $('#dist-resultado').innerHTML = ['SI', 'NO'].filter((k) => k in dr).concat(Object.keys(dr).filter((k) => !['SI', 'NO'].includes(k)))
      .map((k) => barra(`Resultado ${k}`, dr[k], totalR, k === 'SI' ? '#7c3aed' : '#64748b')).join('') || '<p class="text-xs text-slate-400">Sin datos.</p>';
    const dc = r.distribucion_cultivo || {}; const totalC = Object.values(dc).reduce((a, b) => a + b, 0);
    $('#dist-cultivo').innerHTML = Object.keys(dc).sort().map((c) => barra(c, dc[c], totalC, CULTIVO_COLORS[c] || '#2546e8',
      ` · <span class="text-violet-700">SI ${fmtPct((r.tasa_si_por_cultivo || {})[c])}</span>`)).join('') || '<p class="text-xs text-slate-400">Sin datos.</p>';
  }

  // ─────────────────────────────── JSON resaltado ────────────────────────────
  function resaltar(json) {
    return esc(JSON.stringify(json, null, 2)).replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
      (m) => {
        let cls = 'json-num';
        if (/^"/.test(m)) cls = /:$/.test(m) ? 'json-key' : 'json-str';
        else if (/true|false/.test(m)) cls = 'json-bool';
        else if (/null/.test(m)) cls = 'json-null';
        return `<span class="${cls}">${m}</span>`;
      });
  }

  // ─────────────────────────────── árbol navegable ───────────────────────────
  function nodo(clave, valor, nivel) {
    const esObj = valor !== null && typeof valor === 'object';
    if (!esObj) {
      const cls = typeof valor === 'string' ? 'json-str' : typeof valor === 'number' ? 'json-num' : typeof valor === 'boolean' ? 'json-bool' : 'json-null';
      const txt = typeof valor === 'string' ? `"${esc(valor)}"` : String(valor);
      return `<div class="tree-row"><span class="tree-toggle"></span><span class="json-key">${esc(clave)}</span><span class="text-slate-400">:</span><span class="${cls}">${txt}</span></div>`;
    }
    const esArr = Array.isArray(valor); const n = esArr ? valor.length : Object.keys(valor).length;
    const abierto = nivel < 1;
    const hijos = (esArr ? valor.map((v, i) => [i, v]) : Object.entries(valor)).map(([k, v]) => nodo(k, v, nivel + 1)).join('');
    return `<details class="tree-details" ${abierto ? 'open' : ''}>
      <summary class="tree-row cursor-pointer list-none"><span class="tree-toggle">▸</span><span class="json-key">${esc(clave)}</span>
        <span class="text-slate-400">${esArr ? `[${n}]` : `{${n}}`}</span></summary>
      <div class="tree-node">${hijos}</div></details>`;
  }
  function renderArbol(r) {
    $('#vista-arbol').innerHTML = Object.entries(r).map(([k, v]) => nodo(k, v, 0)).join('');
  }

  // ─────────────────────────────── carga ─────────────────────────────────────
  async function cargar() {
    try {
      const [r, head] = await Promise.all([api('/api/data/summary'), fetch('/download/resultado.json', { method: 'HEAD' }).catch(() => null)]);
      datos = r;
      const tamano = head && head.ok ? Number(head.headers.get('content-length')) : null;
      $('#aviso').classList.add('hidden');
      renderKPIs(r, tamano); renderTabla(r); renderDistribuciones(r); renderArbol(r);
      $('#vista-codigo').innerHTML = resaltar(r);
      document.title = `Resultados · ${r.filas_totales} filas · resultado.json`;
    } catch (e) {
      const av = $('#aviso'); av.classList.remove('hidden');
      av.innerHTML = `No se pudo cargar <code class="bg-rose-700 text-white">output/resultado.json</code>: ${esc(e.message)}. Ejecuta <code class="bg-rose-700 text-white">python procesar_datos.py</code> o pulsa “Volver a ejecutar”.`;
    }
  }

  // ─────────────────────────────── acciones ──────────────────────────────────
  function setupAcciones() {
    $$('.tab[data-vista]').forEach((b) => b.onclick = () => {
      $$('.tab[data-vista]').forEach((x) => x.classList.toggle('tab-active', x === b));
      $('#vista-arbol').classList.toggle('hidden', b.dataset.vista !== 'arbol');
      $('#vista-codigo').classList.toggle('hidden', b.dataset.vista !== 'codigo');
    });
    $('#btn-recargar').onclick = async () => { await cargar(); setEstado('Recargado.'); };
    $('#btn-copiar').onclick = async () => {
      if (!datos) return;
      try { await navigator.clipboard.writeText(JSON.stringify(datos, null, 2)); setEstado('JSON copiado al portapapeles.'); }
      catch { setEstado('El navegador bloqueó el portapapeles; usa “Abrir JSON crudo”.', false); }
    };
    $('#btn-reprocesar').onclick = async (ev) => {
      const b = ev.currentTarget; b.disabled = true; const txt = b.textContent; b.textContent = '⏳ Ejecutando…';
      try { await api('/api/data/reprocess', { method: 'POST' }); await cargar(); setEstado('procesar_datos.py ejecutado; resultado.json actualizado.'); }
      catch (e) { setEstado(`Error: ${e.message}`, false); }
      finally { b.disabled = false; b.textContent = txt; }
    };
  }

  function init() { setupAcciones(); cargar(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
