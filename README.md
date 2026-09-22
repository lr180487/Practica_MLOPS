# Práctica MLOps · Colab → GitHub → Pipeline → Modelo → Gradio / FastAPI / Dashboard

Proyecto de práctica que recorre un flujo MLOps completo sobre el dataset agroclimático
`data/datos.csv` (50 observaciones de **café, papa y uva** con `temperatura`, `humedad`,
`radiacion_solar`, `precipitacion`, `viento` y la etiqueta `resultado ∈ {SI, NO}`).

Incluye un **dashboard web (HTML + Tailwind CSS + JavaScript)** con métricas en vivo,
matriz de confusión y mapas de calor, alimentado en tiempo real por la API FastAPI.

---

## 1. Estructura del proyecto

```
Practica_MLOPS/
│
├── procesar_datos.py          # Ingesta + validación + estadísticas → output/resultado.json
│
├── data/
│   └── datos.csv              # Dataset de entrada
│
├── output/
│   ├── resultado.json         # Resumen del procesamiento (filas, válidos, inválidos, promedios…)
│   ├── matriz_confusion.png   # Generado por el notebook
│   └── heatmap_correlacion.png
│
├── logs/
│   ├── ejecucion.log          # Log de procesar_datos.py
│   └── api.log                # Log de la API (predicciones, feedback, simulador)
│
├── models/
│   ├── modelo.joblib          # Pipeline scikit-learn serializado (artefacto que consumen Gradio/FastAPI)
│   └── metricas.json          # Métricas de entrenamiento, matriz de confusión, ROC, coeficientes, correlación
│
├── notebooks/
│   └── entrenamiento.ipynb    # Entrena el modelo y genera los artefactos anteriores
│
├── app/
│   └── gradio_app.py          # Interfaz web sencilla (Gradio)
│
├── api/
│   └── main.py                # API REST (FastAPI) + SSE + sirve el dashboard
│
├── dashboard/                 # Dashboard HTML + Tailwind CSS (CDN) + JavaScript (modo claro)
│   ├── index.html             # Estructura + config de Tailwind + clases de componente; enlaza script.js
│   ├── script.js              # Lógica: SSE, Chart.js, heatmaps en <canvas>, formulario, tabs
│   ├── vendor/chart.umd.min.js# Respaldo local de Chart.js por si el CDN no está disponible
│   └── preview.png            # Captura del dashboard
│
├── requirements.txt
├── README.md
└── .gitignore
```

## 2. Flujo MLOps

```
                         ┌─────────────────┐
                         │  GOOGLE COLAB   │
                         │ entrenamiento   │
                         └────────┬────────┘
                                  ▼
                         ┌─────────────────┐
                         │    datos.csv    │
                         └────────┬────────┘
                                  ▼
                         ┌─────────────────┐
                         │     GITHUB      │
                         │ control versión │
                         └────────┬────────┘
                                  ▼
                       ┌─────────────────────┐
                       │  procesar_datos.py  │
                       │       Pandas        │
                       └─────────┬───────────┘
                    ┌────────────┴────────────┐
                    ▼                         ▼
             resultado.json             ejecucion.log
                    │
                    ▼
             ┌──────────────────┐
             │ entrenamiento    │
             │ .ipynb           │
             │ Scikit-Learn     │
             └────────┬─────────┘
                      ▼
             ┌──────────────────┐
             │ modelo.joblib    │
             │ + metricas.json  │
             └────────┬─────────┘
          ┌───────────┼───────────┐
          ▼           ▼           ▼
   ┌───────────┐ ┌───────────┐ ┌──────────────────────┐
   │  GRADIO   │ │  FASTAPI  │ │  DASHBOARD (HTML +   │
   │  Web UI   │ │  REST API │─│  Tailwind + JS, SSE) │
   └─────┬─────┘ └─────┬─────┘ └──────────┬───────────┘
         └─────────────┴──────────────────┘
                       ▼
                  ┌─────────┐
                  │ USUARIO │
                  └─────────┘
```

## 3. Instalación

```bash
git clone <tu-repositorio> Practica_MLOPS
cd Practica_MLOPS
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## 4. Ejecución paso a paso

| Paso | Comando (desde la raíz) | Produce |
|------|--------------------------|---------|
| 1. Procesar datos | `python procesar_datos.py` | `output/resultado.json`, `logs/ejecucion.log` |
| 2. Entrenar | `jupyter nbconvert --to notebook --execute --inplace notebooks/entrenamiento.ipynb` (o abrirlo en Colab/Jupyter) | `models/modelo.joblib`, `models/metricas.json`, `output/*.png` |
| 3. API + Dashboard | `uvicorn api.main:app --host 0.0.0.0 --port 8000 --reload` | http://localhost:8000 (dashboard) · http://localhost:8000/docs (Swagger) |
| 4. Gradio | `python app/gradio_app.py` | http://localhost:7860 |

> **Nota sobre el modelo:** como `resultado` es binaria (SI/NO) el notebook entrena una
> **`LogisticRegression`** (modelo lineal de clasificación) en lugar de `LinearRegression`
> (pensada para objetivos continuos). Así se obtienen probabilidades, matriz de confusión,
> precisión/recall/F1 y curva ROC, que son exactamente lo que muestra el dashboard.

## 5. Dashboard (HTML + Tailwind CSS + JavaScript)

Abre **http://localhost:8000** una vez levantada la API.

### 5.1 Cómo están integrados HTML + Tailwind (CDN) + script.js

```
index.html ──<script src>──▶ https://cdn.tailwindcss.com/3.4.17     (Tailwind CSS, CDN oficial)
           ──<script>──────▶ tailwind.config = { … }                 (paleta, sombras, animaciones)
           ──<style type="text/tailwindcss">──▶ @layer components    (.card .kpi .tab .badge-* …)
           ──<script src>──▶ https://cdn.jsdelivr.net/npm/chart.js   (Chart.js; respaldo: vendor/)
           ──<script src defer>──▶ script.js                          (consume /api/* y pinta todo)
```

* **Tailwind se carga desde el CDN oficial** con la versión fijada (`3.4.17`), por lo que
  **no hace falta Node ni ningún paso de compilación**: basta con servir la carpeta.
* La configuración del tema (`tailwind.config`) y las **clases de componente** (`.card`,
  `.kpi`, `.pill`, `.badge-si`, `.tab-active`, `.cm-cell`, `.btn-primary`, `.table`,
  `.log-view`, `.drift-bar`…) viven en el `<head>` de `index.html`. El CDN de Tailwind procesa
  el bloque `<style type="text/tailwindcss">`, que admite `@layer` y `@apply`.
* **`script.js`** se carga con `defer` al final del `<body>` y aplica esas mismas clases al
  generar filas, badges, botones y estados; el CDN de Tailwind observa el DOM (MutationObserver)
  y genera al vuelo las utilidades que el JS añada dinámicamente.
* La API sirve `/` (index.html), `/script.js` y `/vendor/*` desde `dashboard/`, y `/output/*`
  para las imágenes del notebook.

> El CDN de Tailwind está pensado para desarrollo y prototipos (muestra un aviso en consola).
> Para producción se recomienda compilar el CSS con Tailwind CLI; el HTML no cambiaría salvo
> sustituir el `<script>` del CDN por un `<link rel="stylesheet">`.

### 5.2 Diseño

Tema **claro profesional**: fondo gris-azulado (`#f6f8fb`), tarjetas blancas con borde
sutil y sombra ligera, tipografía Inter / JetBrains Mono, color primario índigo (`brand-600`)
y semántica de color consistente (verde = acierto/OK, rojo = error/FP-FN, violeta = clase SI,
ámbar = advertencia/pendiente). Layout responsive: 8 KPIs en fila en pantallas XL, 4 en
tablet y 2 en móvil; los mapas de calor se redibujan al cambiar el tamaño.

### 5.3 Secciones

| Sección | Qué muestra | Fuente |
|---------|-------------|--------|
| **KPIs en vivo** | Predicciones totales, throughput/min, accuracy, F1, precisión, recall, tasa de SI, latencia p50/p95, pendientes de feedback | `GET /api/metrics/live` + SSE |
| **Serie temporal** | Evolución de accuracy / F1 / recall / tasa SI sobre una ventana móvil de 50 predicciones etiquetadas | SSE `/api/stream` |
| **Matriz de confusión** | 4 vistas: *Vivo* (ventana móvil), *Acumulado* (desde el arranque), *Hold-out* y *CV 5×* (entrenamiento). Celdas coloreadas por proporción | `/api/metrics/live`, `/api/metrics/training` |
| **Mapa de calor · superficie de decisión** | P(SI) del modelo sobre una rejilla 2-D (elige cultivo y par de variables). Superpone los puntos reales y la isolínea del umbral 0.5 | `GET /api/heatmap/probability` |
| **Mapa de calor · correlación** | Matriz de Pearson de las variables + objetivo binarizado | `models/metricas.json` |
| **Probar el modelo** | Formulario → `POST /predict`, y botones SI/NO → `POST /feedback` (cierra el ciclo y actualiza la matriz en vivo) | API |
| **Deriva de datos** | z-score de la media reciente vs. la media de entrenamiento por variable (ámbar > 1σ, rojo > 2σ) + predicciones por cultivo | `/api/metrics/live` |
| **Coeficientes / ROC / Ficha** | Importancia de variables (log-odds), curva ROC out-of-fold y ficha del modelo con las imágenes del notebook | `/api/metrics/training` |
| **Flujo de predicciones** | Tabla en vivo de eventos (features, P(SI), predicción, real, latencia) | SSE |
| **Logs** | Cola de `logs/api.log` y `logs/ejecucion.log` | `GET /api/logs` |
| **Resumen del procesamiento** | Contenido de `output/resultado.json` | `GET /api/data/summary` |

**Tiempo real:** el navegador se suscribe a `GET /api/stream` (Server-Sent Events). Si el
stream no está disponible, el dashboard cae automáticamente a *polling* cada 3 s.

**Simulador de tráfico:** la API incluye un generador de observaciones sintéticas
(filas reales + ruido gaussiano, con ~5 % de ruido de etiqueta) que llegan ya etiquetadas
para que las métricas se muevan. Desde la barra del dashboard puedes pausarlo, cambiar la
velocidad o lanzar una ráfaga (`POST /api/simulator`).

## 6. API REST

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/health` | Estado del servicio |
| GET | `/api/info` | Metadatos del modelo (features, categorías, rangos) |
| POST | `/predict?umbral=0.5` | Predicción individual → `{prediccion, probabilidad_si, id, …}` |
| POST | `/predict/batch` | Predicción por lotes |
| POST | `/feedback` | `{id, real}` — etiqueta real de una predicción |
| GET | `/api/metrics/training` | Métricas de entrenamiento (`metricas.json`) |
| GET | `/api/metrics/live` | Métricas de producción (ventana, acumulado, latencia, deriva) |
| GET | `/api/stream` | SSE con eventos `prediccion`, `feedback`, `metricas` |
| GET | `/api/heatmap/probability?cultivo=cafe&x=temperatura&y=humedad` | Superficie P(SI) |
| GET | `/api/events?n=30` | Últimos eventos |
| GET | `/api/data/summary` · `/api/data/sample` | `resultado.json` y filas del CSV |
| GET | `/api/logs?archivo=api\|ejecucion` | Últimas líneas de logs |
| POST | `/api/simulator` | `{"accion": "start"\|"stop"\|"speed"\|"burst", ...}` |

Ejemplo:

```bash
curl -X POST "http://localhost:8000/predict" -H "Content-Type: application/json" \
     -d '{"cultivo":"cafe","temperatura":21,"humedad":80,"radiacion_solar":16,"precipitacion":12,"viento":5}'
# {"id":"cf6fc2500d6d","prediccion":"SI","probabilidad_si":0.56,...}

curl -X POST "http://localhost:8000/feedback" -H "Content-Type: application/json" \
     -d '{"id":"cf6fc2500d6d","real":"SI"}'
```

## 7. Resultados de referencia (dataset de 50 filas)

| Evaluación | Accuracy | Precisión | Recall | F1 | ROC-AUC |
|------------|---------:|----------:|-------:|---:|--------:|
| Hold-out (13 filas) | 0.846 | 0.600 | 1.000 | 0.750 | 0.900 |
| Validación cruzada 5× (50 filas) | 0.620 | 0.235 | 0.400 | 0.296 | 0.610 |

El dataset es pequeño y desbalanceado (10 SI / 40 NO), por lo que las métricas tienen alta
varianza: el dashboard muestra precisamente cómo se comportan en "producción".

## 8. Uso en Google Colab

1. Sube el repositorio (o haz `!git clone …`) y sitúate en la raíz del proyecto.
2. Ejecuta `notebooks/entrenamiento.ipynb`; detecta automáticamente la raíz y guarda
   `models/modelo.joblib` y `models/metricas.json`.
3. Haz `git add models/ output/resultado.json && git commit && git push` para versionar el artefacto.
#   P r a c t i c a _ M L O P S  
 #   P r a c t i c a _ M L O P S  
 