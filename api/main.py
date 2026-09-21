"""
api/main.py
-----------
API REST (FastAPI) que expone el modelo `models/modelo.joblib` y alimenta el
dashboard en vivo (`dashboard/`).

Ejecutar desde la raíz del proyecto:

    uvicorn api.main:app --host 0.0.0.0 --port 8000 --reload

Endpoints principales
---------------------
GET  /                         Dashboard (index.html + Tailwind CDN + script.js)
GET  /docs                     Swagger UI
GET  /health                   Estado del servicio
POST /predict                  Predicción individual  (SI / NO + probabilidad)
POST /predict/batch            Predicción por lotes
POST /feedback                 Etiqueta real de una predicción (cierra el ciclo)
GET  /api/info                 Metadatos del modelo
GET  /api/metrics/training     Métricas de entrenamiento (metricas.json)
GET  /api/metrics/live         Métricas en vivo (ventana móvil + acumulado)
GET  /api/stream               Server-Sent Events con eventos en tiempo real
GET  /api/heatmap/probability  Superficie de probabilidad P(SI) en una rejilla 2D
GET  /api/data/summary         output/resultado.json (procesar_datos.py)
GET  /index.html               Dashboard (/ y /dashboard redirigen aquí)
GET  /resultados.html          Página para ver y descargar resultado.json (/resultados redirige aquí)
GET  /download/resultado.json  Descarga directa del JSON (también .csv)
POST /api/data/reprocess       Vuelve a ejecutar procesar_datos.py
GET  /api/logs                 Últimas líneas de los logs
POST /api/simulator            Controla el simulador de tráfico (start/stop/speed)
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import time
import uuid
from collections import deque
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

import joblib
import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

# --------------------------------------------------------------------------- #
# Rutas y constantes
# --------------------------------------------------------------------------- #
BASE_DIR = Path(__file__).resolve().parent.parent
MODEL_PATH = BASE_DIR / "models" / "modelo.joblib"
METRICS_PATH = BASE_DIR / "models" / "metricas.json"
DATA_PATH = BASE_DIR / "data" / "datos.csv"
RESULT_PATH = BASE_DIR / "output" / "resultado.json"
LOGS_DIR = BASE_DIR / "logs"
DASHBOARD_DIR = BASE_DIR / "dashboard"

FEATURES_NUM = ["temperatura", "humedad", "radiacion_solar", "precipitacion", "viento"]
FEATURE_CAT = "cultivo"
CLASES = ["NO", "SI"]
WINDOW = 50            # tamaño de la ventana móvil para métricas en vivo
HISTORY_MAX = 500      # eventos que se conservan en memoria

LOGS_DIR.mkdir(parents=True, exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
    handlers=[logging.FileHandler(LOGS_DIR / "api.log", encoding="utf-8"), logging.StreamHandler()],
)
log = logging.getLogger("api")


# --------------------------------------------------------------------------- #
# Estado global del servicio
# --------------------------------------------------------------------------- #
class Estado:
    modelo: Any = None
    metricas_entrenamiento: dict = {}
    dataset: pd.DataFrame | None = None
    categorias: list[str] = []
    inicio: float = time.time()

    # monitoreo en vivo
    eventos: deque = deque(maxlen=HISTORY_MAX)     # todos los eventos (predicciones)
    pendientes: dict[str, dict] = {}                # predicciones a la espera de feedback
    total_predicciones: int = 0
    total_etiquetadas: int = 0
    cm_acumulada: list[list[int]] = [[0, 0], [0, 0]]  # [[TN, FP], [FN, TP]]
    latencias: deque = deque(maxlen=HISTORY_MAX)
    serie: deque = deque(maxlen=120)                # puntos de la serie temporal (accuracy/f1 móviles)

    # simulador
    simulador_activo: bool = True
    simulador_intervalo: float = 2.0
    simulador_tarea: asyncio.Task | None = None

    # suscriptores SSE
    suscriptores: set[asyncio.Queue] = set()


estado = Estado()


def ahora_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


# --------------------------------------------------------------------------- #
# Carga de artefactos
# --------------------------------------------------------------------------- #
def cargar_artefactos() -> None:
    if not MODEL_PATH.exists():
        raise RuntimeError(
            f"No existe {MODEL_PATH}. Ejecuta primero notebooks/entrenamiento.ipynb para generar el modelo."
        )
    estado.modelo = joblib.load(MODEL_PATH)
    log.info("Modelo cargado desde %s", MODEL_PATH)

    if METRICS_PATH.exists():
        estado.metricas_entrenamiento = json.loads(METRICS_PATH.read_text(encoding="utf-8"))
        estado.categorias = estado.metricas_entrenamiento.get("categorias_cultivo", [])
        log.info("Métricas de entrenamiento cargadas (%s)", estado.metricas_entrenamiento.get("fecha_entrenamiento"))

    if DATA_PATH.exists():
        df = pd.read_csv(DATA_PATH)
        df["resultado"] = df["resultado"].astype(str).str.strip().str.upper()
        df = df.dropna(subset=FEATURES_NUM + [FEATURE_CAT, "resultado"]).reset_index(drop=True)
        estado.dataset = df
        if not estado.categorias:
            estado.categorias = sorted(df[FEATURE_CAT].unique().tolist())
        log.info("Dataset de referencia cargado: %d filas", len(df))


# --------------------------------------------------------------------------- #
# Esquemas Pydantic
# --------------------------------------------------------------------------- #
class Observacion(BaseModel):
    cultivo: str = Field(..., examples=["cafe"], description="Tipo de cultivo: cafe | papa | uva")
    temperatura: float = Field(..., ge=-10, le=50, examples=[21.0], description="°C")
    humedad: float = Field(..., ge=0, le=100, examples=[80.0], description="% humedad relativa")
    radiacion_solar: float = Field(..., ge=0, le=40, examples=[16.0], description="MJ/m²")
    precipitacion: float = Field(..., ge=0, le=100, examples=[12.0], description="mm")
    viento: float = Field(..., ge=0, le=60, examples=[5.0], description="km/h")

    @field_validator("cultivo")
    @classmethod
    def normalizar_cultivo(cls, v: str) -> str:
        return v.strip().lower()


class Prediccion(BaseModel):
    id: str
    prediccion: Literal["SI", "NO"]
    probabilidad_si: float
    probabilidad_no: float
    umbral: float
    latencia_ms: float
    timestamp: str


class LoteObservaciones(BaseModel):
    observaciones: list[Observacion] = Field(..., min_length=1, max_length=500)


class Feedback(BaseModel):
    id: str = Field(..., description="id devuelto por /predict")
    real: Literal["SI", "NO"]


class ControlSimulador(BaseModel):
    accion: Literal["start", "stop", "speed", "burst"]
    intervalo: float | None = Field(None, ge=0.2, le=60, description="Segundos entre eventos (accion=speed)")
    cantidad: int | None = Field(None, ge=1, le=200, description="Eventos a generar de golpe (accion=burst)")


# --------------------------------------------------------------------------- #
# Lógica de predicción y monitoreo
# --------------------------------------------------------------------------- #
def predecir_df(df: pd.DataFrame, umbral: float = 0.5) -> tuple[np.ndarray, np.ndarray]:
    proba = estado.modelo.predict_proba(df[FEATURES_NUM + [FEATURE_CAT]])[:, 1]
    pred = (proba >= umbral).astype(int)
    return proba, pred


def registrar_evento(obs: dict, proba: float, pred: int, latencia_ms: float, origen: str,
                     real: int | None = None) -> dict:
    """Guarda una predicción en el historial y, si tiene etiqueta real, actualiza la matriz."""
    evento = {
        "id": uuid.uuid4().hex[:12],
        "timestamp": ahora_iso(),
        "t": time.time(),
        "origen": origen,
        "features": obs,
        "probabilidad_si": round(float(proba), 4),
        "prediccion": int(pred),
        "real": real,
        "latencia_ms": round(latencia_ms, 3),
    }
    estado.eventos.append(evento)
    estado.latencias.append(latencia_ms)
    estado.total_predicciones += 1
    if real is None:
        estado.pendientes[evento["id"]] = evento
    else:
        _actualizar_matriz(pred, real)
    return evento


def _actualizar_matriz(pred: int, real: int) -> None:
    estado.cm_acumulada[real][pred] += 1
    estado.total_etiquetadas += 1


def _metricas_desde_cm(cm: list[list[int]]) -> dict:
    (tn, fp), (fn, tp) = cm
    total = tn + fp + fn + tp
    acc = (tp + tn) / total if total else None
    prec = tp / (tp + fp) if (tp + fp) else None
    rec = tp / (tp + fn) if (tp + fn) else None
    esp = tn / (tn + fp) if (tn + fp) else None
    f1 = (2 * prec * rec / (prec + rec)) if (prec and rec) else (0.0 if total else None)
    r = lambda v: None if v is None else round(v, 4)  # noqa: E731
    return {"accuracy": r(acc), "precision": r(prec), "recall": r(rec), "especificidad": r(esp),
            "f1": r(f1), "n": total, "matriz_confusion": cm}


def metricas_en_vivo() -> dict:
    etiquetados = [e for e in estado.eventos if e["real"] is not None]
    ventana = etiquetados[-WINDOW:]
    cm_ventana = [[0, 0], [0, 0]]
    for e in ventana:
        cm_ventana[e["real"]][e["prediccion"]] += 1

    ultimos = list(estado.eventos)[-WINDOW:]
    lat = list(estado.latencias)
    tasa_si = float(np.mean([e["prediccion"] for e in ultimos])) if ultimos else None

    # deriva de datos: media de la ventana vs media de entrenamiento (z-score)
    medias_train = estado.metricas_entrenamiento.get("medias_entrenamiento", {})
    desv_train = estado.metricas_entrenamiento.get("desviaciones_entrenamiento", {})
    deriva = {}
    if ultimos:
        for f in FEATURES_NUM:
            vals = [e["features"][f] for e in ultimos]
            media = float(np.mean(vals))
            sd = desv_train.get(f) or 1.0
            deriva[f] = {"media_actual": round(media, 3), "media_entrenamiento": medias_train.get(f),
                         "z": round((media - medias_train.get(f, media)) / sd, 3) if medias_train else None}

    # distribución de predicciones por cultivo (ventana)
    por_cultivo: dict[str, dict] = {}
    for e in ultimos:
        c = e["features"][FEATURE_CAT]
        d = por_cultivo.setdefault(c, {"total": 0, "si": 0})
        d["total"] += 1
        d["si"] += e["prediccion"]

    hace_1min = time.time() - 60
    throughput = sum(1 for e in estado.eventos if e["t"] >= hace_1min)

    return {
        "timestamp": ahora_iso(),
        "uptime_s": round(time.time() - estado.inicio, 1),
        "total_predicciones": estado.total_predicciones,
        "total_etiquetadas": estado.total_etiquetadas,
        "pendientes_feedback": len(estado.pendientes),
        "throughput_por_min": throughput,
        "latencia_ms": {
            "p50": round(float(np.percentile(lat, 50)), 3) if lat else None,
            "p95": round(float(np.percentile(lat, 95)), 3) if lat else None,
            "max": round(float(np.max(lat)), 3) if lat else None,
        },
        "tasa_prediccion_si": round(tasa_si, 4) if tasa_si is not None else None,
        "ventana": {"tamano": WINDOW, **_metricas_desde_cm(cm_ventana)},
        "acumulado": _metricas_desde_cm([row[:] for row in estado.cm_acumulada]),
        "deriva": deriva,
        "por_cultivo": por_cultivo,
        "serie": list(estado.serie),
        "simulador": {"activo": estado.simulador_activo, "intervalo_s": estado.simulador_intervalo},
    }


async def difundir(tipo: str, payload: dict) -> None:
    """Envía un evento a todos los clientes SSE conectados."""
    mensaje = {"tipo": tipo, **payload}
    for q in list(estado.suscriptores):
        try:
            q.put_nowait(mensaje)
        except asyncio.QueueFull:
            pass


def _punto_serie() -> dict:
    m = metricas_en_vivo()
    return {
        "t": m["timestamp"],
        "accuracy": m["ventana"]["accuracy"],
        "f1": m["ventana"]["f1"],
        "recall": m["ventana"]["recall"],
        "precision": m["ventana"]["precision"],
        "tasa_si": m["tasa_prediccion_si"],
        "p95": m["latencia_ms"]["p95"],
    }


# --------------------------------------------------------------------------- #
# Simulador de tráfico de producción
# --------------------------------------------------------------------------- #
def generar_observacion_sintetica(rng: random.Random) -> tuple[dict, int]:
    """Toma una fila real del dataset, le añade ruido y devuelve (features, etiqueta_real)."""
    df = estado.dataset
    fila = df.iloc[rng.randrange(len(df))]
    desv = estado.metricas_entrenamiento.get("desviaciones_entrenamiento", {})
    obs = {FEATURE_CAT: str(fila[FEATURE_CAT])}
    for f in FEATURES_NUM:
        sd = float(desv.get(f) or df[f].std() or 1.0)
        v = float(fila[f]) + rng.gauss(0, 0.15 * sd)
        lo, hi = float(df[f].min()), float(df[f].max())
        obs[f] = round(min(max(v, lo * 0.9), hi * 1.1), 2)
    real = 1 if str(fila["resultado"]).upper() == "SI" else 0
    # ~5 % de "ruido de etiqueta" para que el monitoreo no sea perfecto
    if rng.random() < 0.05:
        real = 1 - real
    return obs, real


async def generar_evento_simulado(rng: random.Random) -> dict:
    obs, real = generar_observacion_sintetica(rng)
    t0 = time.perf_counter()
    proba, pred = predecir_df(pd.DataFrame([obs]))
    latencia = (time.perf_counter() - t0) * 1000
    evento = registrar_evento(obs, float(proba[0]), int(pred[0]), latencia, origen="simulador", real=real)
    return evento


async def bucle_simulador() -> None:
    rng = random.Random()
    log.info("Simulador de tráfico iniciado (intervalo=%.1fs)", estado.simulador_intervalo)
    contador = 0
    while True:
        try:
            if estado.simulador_activo and estado.modelo is not None and estado.dataset is not None:
                evento = await generar_evento_simulado(rng)
                contador += 1
                await difundir("prediccion", {"evento": evento})
                if contador % 3 == 0:
                    estado.serie.append(_punto_serie())
                await difundir("metricas", {"metricas": metricas_en_vivo()})
            await asyncio.sleep(estado.simulador_intervalo)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            log.exception("Error en el simulador: %s", exc)
            await asyncio.sleep(2)


# --------------------------------------------------------------------------- #
# Aplicación
# --------------------------------------------------------------------------- #
@asynccontextmanager
async def lifespan(app: FastAPI):
    cargar_artefactos()
    # Pre-calentamos el monitoreo con algunos eventos para que el dashboard no arranque vacío
    rng = random.Random(7)
    for _ in range(30):
        await generar_evento_simulado(rng)
    estado.serie.append(_punto_serie())
    estado.simulador_tarea = asyncio.create_task(bucle_simulador())
    yield
    if estado.simulador_tarea:
        estado.simulador_tarea.cancel()


app = FastAPI(
    title="Práctica MLOps – API de predicción",
    description="Expone el modelo `modelo.joblib` (clasificación SI/NO) y alimenta el dashboard en vivo.",
    version="1.0.0",
    lifespan=lifespan,
)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# ---------- Dashboard (estáticos) ------------------------------------------ #
# index.html carga Tailwind CSS y Chart.js desde sus CDN y enlaza script.js con
# ruta relativa, así que se sirve desde la raíz junto con vendor/ (respaldo local
# de Chart.js). De este modo el dashboard también funciona publicándolo como
# carpeta estática (GitHub Pages, `python -m http.server`) apuntando a la API.
@app.get("/", include_in_schema=False)
@app.get("/dashboard", include_in_schema=False)
@app.get("/dashboard/", include_in_schema=False)
async def dashboard():
    """La raíz y /dashboard redirigen a la página del dashboard (index.html)."""
    return RedirectResponse(url="/index.html", status_code=307)


@app.get("/index.html", include_in_schema=False)
async def dashboard_index():
    return FileResponse(DASHBOARD_DIR / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/script.js", include_in_schema=False)
async def dashboard_js():
    return FileResponse(DASHBOARD_DIR / "script.js", media_type="application/javascript")


@app.get("/resultados.html", include_in_schema=False)
async def pagina_resultados():
    """Página para ver y descargar output/resultado.json."""
    return FileResponse(DASHBOARD_DIR / "resultados.html", headers={"Cache-Control": "no-cache"})


@app.get("/resultados", include_in_schema=False)
@app.get("/resultados/", include_in_schema=False)
async def pagina_resultados_redirect():
    return RedirectResponse(url="/resultados.html", status_code=307)


@app.get("/resultados.js", include_in_schema=False)
async def pagina_resultados_js():
    return FileResponse(DASHBOARD_DIR / "resultados.js", media_type="application/javascript")


@app.api_route("/download/resultado.json", methods=["GET", "HEAD"], tags=["datos"])
async def descargar_resultado():
    """Descarga directa de output/resultado.json (Content-Disposition: attachment)."""
    if not RESULT_PATH.exists():
        raise HTTPException(status_code=404, detail="No existe output/resultado.json. Ejecuta procesar_datos.py.")
    return FileResponse(RESULT_PATH, media_type="application/json", filename="resultado.json",
                        headers={"Cache-Control": "no-cache"})


@app.get("/download/resultado.csv", tags=["datos"])
async def descargar_resultado_csv():
    """Versión tabular (CSV) de las estadísticas por variable de resultado.json."""
    if not RESULT_PATH.exists():
        raise HTTPException(status_code=404, detail="No existe output/resultado.json. Ejecuta procesar_datos.py.")
    r = json.loads(RESULT_PATH.read_text(encoding="utf-8"))
    filas = []
    for f, c in r.get("columnas_numericas", {}).items():
        fila = {"variable": f, **c}
        for cu, prom in r.get("promedio_por_cultivo", {}).items():
            fila[f"promedio_{cu}"] = prom.get(f)
        filas.append(fila)
    csv = pd.DataFrame(filas).to_csv(index=False)
    return Response(content=csv, media_type="text/csv",
                    headers={"Content-Disposition": 'attachment; filename="resultado.csv"'})


@app.post("/api/data/reprocess", tags=["datos"])
async def reprocesar_datos():
    """Vuelve a ejecutar procesar_datos.py y devuelve el nuevo resultado.json."""
    import subprocess
    import sys

    proc = await asyncio.to_thread(
        subprocess.run, [sys.executable, str(BASE_DIR / "procesar_datos.py")],
        capture_output=True, text=True, cwd=str(BASE_DIR), timeout=120,
    )
    log.info("reprocess exit=%s", proc.returncode)
    if proc.returncode != 0:
        raise HTTPException(status_code=500, detail=f"procesar_datos.py falló: {proc.stderr[-800:]}")
    return {"ok": True, "resultado": json.loads(RESULT_PATH.read_text(encoding="utf-8"))}


app.mount("/vendor", StaticFiles(directory=DASHBOARD_DIR / "vendor"), name="vendor")
app.mount("/static", StaticFiles(directory=DASHBOARD_DIR), name="static")  # compatibilidad
app.mount("/output", StaticFiles(directory=BASE_DIR / "output"), name="output")


# ---------- Salud e info ---------------------------------------------------- #
@app.get("/health", tags=["sistema"])
async def health():
    return {"status": "ok", "modelo_cargado": estado.modelo is not None, "uptime_s": round(time.time() - estado.inicio, 1),
            "timestamp": ahora_iso()}


@app.get("/api/info", tags=["sistema"])
async def info():
    m = estado.metricas_entrenamiento
    return {
        "modelo": m.get("modelo", type(estado.modelo).__name__),
        "version": m.get("version"),
        "fecha_entrenamiento": m.get("fecha_entrenamiento"),
        "sklearn_version": m.get("sklearn_version"),
        "features_numericas": FEATURES_NUM,
        "feature_categorica": FEATURE_CAT,
        "categorias_cultivo": estado.categorias,
        "clases": CLASES,
        "rangos": m.get("rangos", {}),
        "n_filas": m.get("n_filas"),
        "ruta_modelo": str(MODEL_PATH.relative_to(BASE_DIR)),
    }


# ---------- Predicción ------------------------------------------------------ #
def _validar_cultivo(c: str) -> None:
    if estado.categorias and c not in estado.categorias:
        raise HTTPException(status_code=422, detail=f"cultivo '{c}' no reconocido. Valores válidos: {estado.categorias}")


@app.post("/predict", response_model=Prediccion, tags=["prediccion"])
async def predict(obs: Observacion, umbral: float = Query(0.5, ge=0.05, le=0.95)):
    _validar_cultivo(obs.cultivo)
    datos = obs.model_dump()
    t0 = time.perf_counter()
    proba, pred = predecir_df(pd.DataFrame([datos]), umbral)
    latencia = (time.perf_counter() - t0) * 1000
    evento = registrar_evento(datos, float(proba[0]), int(pred[0]), latencia, origen="api")
    log.info("predict id=%s cultivo=%s p_si=%.3f -> %s", evento["id"], obs.cultivo, proba[0], CLASES[int(pred[0])])
    await difundir("prediccion", {"evento": evento})
    await difundir("metricas", {"metricas": metricas_en_vivo()})
    return Prediccion(
        id=evento["id"], prediccion=CLASES[int(pred[0])], probabilidad_si=round(float(proba[0]), 4),
        probabilidad_no=round(1 - float(proba[0]), 4), umbral=umbral, latencia_ms=round(latencia, 3),
        timestamp=evento["timestamp"],
    )


@app.post("/predict/batch", tags=["prediccion"])
async def predict_batch(lote: LoteObservaciones, umbral: float = Query(0.5, ge=0.05, le=0.95)):
    for o in lote.observaciones:
        _validar_cultivo(o.cultivo)
    df = pd.DataFrame([o.model_dump() for o in lote.observaciones])
    t0 = time.perf_counter()
    proba, pred = predecir_df(df, umbral)
    latencia = (time.perf_counter() - t0) * 1000 / len(df)
    salida = []
    for i, fila in enumerate(df.to_dict(orient="records")):
        ev = registrar_evento(fila, float(proba[i]), int(pred[i]), latencia, origen="api-batch")
        salida.append({"id": ev["id"], "prediccion": CLASES[int(pred[i])], "probabilidad_si": round(float(proba[i]), 4)})
    await difundir("metricas", {"metricas": metricas_en_vivo()})
    return {"n": len(salida), "umbral": umbral, "resultados": salida}


@app.post("/feedback", tags=["prediccion"])
async def feedback(fb: Feedback):
    evento = estado.pendientes.pop(fb.id, None)
    if evento is None:
        raise HTTPException(status_code=404, detail="id no encontrado o ya etiquetado")
    real = CLASES.index(fb.real)
    evento["real"] = real
    _actualizar_matriz(evento["prediccion"], real)
    log.info("feedback id=%s real=%s pred=%s", fb.id, fb.real, CLASES[evento["prediccion"]])
    estado.serie.append(_punto_serie())
    await difundir("feedback", {"evento": evento})
    await difundir("metricas", {"metricas": metricas_en_vivo()})
    return {"ok": True, "id": fb.id, "acierto": evento["prediccion"] == real}


# ---------- Métricas -------------------------------------------------------- #
@app.get("/api/metrics/training", tags=["metricas"])
async def metrics_training():
    if not estado.metricas_entrenamiento:
        raise HTTPException(status_code=404, detail="No existe models/metricas.json. Ejecuta el notebook.")
    return estado.metricas_entrenamiento


@app.get("/api/metrics/live", tags=["metricas"])
async def metrics_live():
    return metricas_en_vivo()


@app.get("/api/events", tags=["metricas"])
async def events(n: int = Query(30, ge=1, le=HISTORY_MAX)):
    return {"eventos": list(estado.eventos)[-n:][::-1]}


@app.get("/api/stream", tags=["metricas"])
async def stream(request: Request):
    """Server-Sent Events: emite `prediccion`, `feedback` y `metricas` en tiempo real."""
    cola: asyncio.Queue = asyncio.Queue(maxsize=200)
    estado.suscriptores.add(cola)

    async def generador():
        try:
            yield "retry: 3000\n\n"
            yield f"data: {json.dumps({'tipo': 'metricas', 'metricas': metricas_en_vivo()})}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    msg = await asyncio.wait_for(cola.get(), timeout=15)
                    yield f"data: {json.dumps(msg)}\n\n"
                except asyncio.TimeoutError:
                    yield f"data: {json.dumps({'tipo': 'ping', 'timestamp': ahora_iso()})}\n\n"
        finally:
            estado.suscriptores.discard(cola)

    return StreamingResponse(generador(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"})


# ---------- Mapa de calor de probabilidad ---------------------------------- #
@app.get("/api/heatmap/probability", tags=["metricas"])
async def heatmap_probability(
    cultivo: str = Query("cafe"),
    x: str = Query("temperatura"),
    y: str = Query("humedad"),
    resolucion: int = Query(20, ge=5, le=40),
):
    """Evalúa el modelo sobre una rejilla (x, y); el resto de variables se fijan en su media."""
    cultivo = cultivo.strip().lower()
    _validar_cultivo(cultivo)
    if x not in FEATURES_NUM or y not in FEATURES_NUM or x == y:
        raise HTTPException(status_code=422, detail=f"x e y deben ser distintos y pertenecer a {FEATURES_NUM}")
    rangos = estado.metricas_entrenamiento.get("rangos") or {
        f: [float(estado.dataset[f].min()), float(estado.dataset[f].max())] for f in FEATURES_NUM
    }
    medias = estado.metricas_entrenamiento.get("medias_entrenamiento") or {
        f: float(estado.dataset[f].mean()) for f in FEATURES_NUM
    }
    xs = np.linspace(rangos[x][0], rangos[x][1], resolucion)
    ys = np.linspace(rangos[y][0], rangos[y][1], resolucion)
    gx, gy = np.meshgrid(xs, ys)
    df = pd.DataFrame({f: np.full(gx.size, medias[f]) for f in FEATURES_NUM})
    df[x] = gx.ravel()
    df[y] = gy.ravel()
    df[FEATURE_CAT] = cultivo
    proba = estado.modelo.predict_proba(df[FEATURES_NUM + [FEATURE_CAT]])[:, 1].reshape(resolucion, resolucion)
    return {"cultivo": cultivo, "x": x, "y": y, "xs": [round(float(v), 2) for v in xs],
            "ys": [round(float(v), 2) for v in ys], "z": np.round(proba, 4).tolist(), "fijas": {f: medias[f] for f in FEATURES_NUM if f not in (x, y)}}


# ---------- Datos y logs ---------------------------------------------------- #
@app.get("/api/data/summary", tags=["datos"])
async def data_summary():
    if not RESULT_PATH.exists():
        raise HTTPException(status_code=404, detail="No existe output/resultado.json. Ejecuta procesar_datos.py.")
    return json.loads(RESULT_PATH.read_text(encoding="utf-8"))


@app.get("/api/data/sample", tags=["datos"])
async def data_sample(n: int = Query(50, ge=1, le=500)):
    return {"filas": estado.dataset.head(n).to_dict(orient="records")}


@app.get("/api/logs", tags=["sistema"])
async def logs(n: int = Query(40, ge=1, le=500), archivo: Literal["api", "ejecucion"] = "api"):
    ruta = LOGS_DIR / f"{archivo}.log"
    if not ruta.exists():
        return {"archivo": ruta.name, "lineas": []}
    lineas = ruta.read_text(encoding="utf-8", errors="replace").splitlines()
    return {"archivo": ruta.name, "lineas": lineas[-n:][::-1]}


# ---------- Simulador ------------------------------------------------------- #
@app.post("/api/simulator", tags=["sistema"])
async def simulador(ctrl: ControlSimulador):
    if ctrl.accion == "start":
        estado.simulador_activo = True
    elif ctrl.accion == "stop":
        estado.simulador_activo = False
    elif ctrl.accion == "speed":
        if ctrl.intervalo is None:
            raise HTTPException(status_code=422, detail="intervalo requerido")
        estado.simulador_intervalo = ctrl.intervalo
    elif ctrl.accion == "burst":
        rng = random.Random()
        for _ in range(ctrl.cantidad or 20):
            await generar_evento_simulado(rng)
        estado.serie.append(_punto_serie())
    log.info("simulador accion=%s intervalo=%s cantidad=%s", ctrl.accion, ctrl.intervalo, ctrl.cantidad)
    m = metricas_en_vivo()
    await difundir("metricas", {"metricas": m})
    return {"ok": True, "simulador": m["simulador"], "total_predicciones": m["total_predicciones"]}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("api.main:app", host="0.0.0.0", port=8000, reload=True)
