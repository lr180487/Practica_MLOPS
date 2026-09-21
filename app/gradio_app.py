"""
app/gradio_app.py
-----------------
Interfaz web sencilla (Gradio) para consultar el modelo `models/modelo.joblib`.

Ejecutar desde la raíz del proyecto:

    python app/gradio_app.py

Se abre en http://localhost:7860
"""

from __future__ import annotations

import json
from pathlib import Path

import gradio as gr
import joblib
import pandas as pd

BASE_DIR = Path(__file__).resolve().parent.parent
MODEL_PATH = BASE_DIR / "models" / "modelo.joblib"
METRICS_PATH = BASE_DIR / "models" / "metricas.json"

FEATURES_NUM = ["temperatura", "humedad", "radiacion_solar", "precipitacion", "viento"]

modelo = joblib.load(MODEL_PATH)
metricas = json.loads(METRICS_PATH.read_text(encoding="utf-8")) if METRICS_PATH.exists() else {}
cultivos = metricas.get("categorias_cultivo", ["cafe", "papa", "uva"])
rangos = metricas.get("rangos", {})


def predecir(cultivo: str, temperatura: float, humedad: float, radiacion_solar: float,
             precipitacion: float, viento: float, umbral: float):
    entrada = pd.DataFrame([{
        "cultivo": cultivo, "temperatura": temperatura, "humedad": humedad,
        "radiacion_solar": radiacion_solar, "precipitacion": precipitacion, "viento": viento,
    }])
    p_si = float(modelo.predict_proba(entrada)[0, 1])
    etiqueta = "SI" if p_si >= umbral else "NO"
    detalle = (
        f"**Predicción: {etiqueta}**  \n"
        f"P(SI) = {p_si:.3f} · P(NO) = {1 - p_si:.3f} · umbral = {umbral:.2f}"
    )
    return {"SI": p_si, "NO": 1 - p_si}, detalle


def _slider(nombre: str, etiqueta: str, valor: float, paso: float = 0.1):
    lo, hi = rangos.get(nombre, [0, 100])
    return gr.Slider(minimum=round(lo * 0.9, 1), maximum=round(hi * 1.1, 1), value=valor, step=paso, label=etiqueta)


with gr.Blocks(title="Práctica MLOps – Predicción", theme=gr.themes.Soft()) as demo:
    gr.Markdown(
        f"""
        # 🌱 Práctica MLOps · Predicción de `resultado`
        Modelo **{metricas.get('modelo', 'LogisticRegression')} v{metricas.get('version', '1.0.0')}**
        entrenado el {metricas.get('fecha_entrenamiento', '—')} ·
        accuracy hold-out {metricas.get('holdout', {}).get('accuracy', '—')} ·
        F1 CV {metricas.get('cv', {}).get('f1', '—')}
        """
    )
    with gr.Row():
        with gr.Column():
            cultivo = gr.Dropdown(cultivos, value=cultivos[0], label="Cultivo")
            temperatura = _slider("temperatura", "Temperatura (°C)", 21.0)
            humedad = _slider("humedad", "Humedad (%)", 75.0)
            radiacion = _slider("radiacion_solar", "Radiación solar (MJ/m²)", 17.0)
            precipitacion = _slider("precipitacion", "Precipitación (mm)", 8.0)
            viento = _slider("viento", "Viento (km/h)", 6.0)
            umbral = gr.Slider(0.05, 0.95, value=0.5, step=0.05, label="Umbral de decisión")
            boton = gr.Button("Predecir", variant="primary")
        with gr.Column():
            salida = gr.Label(num_top_classes=2, label="Probabilidades")
            texto = gr.Markdown()

    boton.click(predecir, [cultivo, temperatura, humedad, radiacion, precipitacion, viento, umbral], [salida, texto])
    gr.Examples(
        examples=[
            ["cafe", 24.8, 83.1, 19.3, 13.9, 5.6, 0.5],
            ["uva", 27.7, 65.0, 21.0, 5.4, 6.2, 0.5],
            ["papa", 13.2, 86.2, 16.3, 4.8, 6.9, 0.5],
        ],
        inputs=[cultivo, temperatura, humedad, radiacion, precipitacion, viento, umbral],
    )

if __name__ == "__main__":
    demo.launch(server_name="0.0.0.0", server_port=7860)
