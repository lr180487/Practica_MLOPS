"""
procesar_datos.py
-----------------
Etapa de ingesta y validación del pipeline MLOps.

1. Lee  data/datos.csv
2. Valida el esquema y los tipos de datos
3. Convierte las columnas numéricas (coerción -> NaN si es inválido)
4. Calcula estadísticas (promedios, conteos, válidos / inválidos)
5. Escribe output/resultado.json
6. Registra todo en logs/ejecucion.log
"""

from __future__ import annotations

import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

# --------------------------------------------------------------------------- #
# Rutas
# --------------------------------------------------------------------------- #
BASE_DIR = Path(__file__).resolve().parent
DATA_PATH = BASE_DIR / "data" / "datos.csv"
OUTPUT_PATH = BASE_DIR / "output" / "resultado.json"
LOG_PATH = BASE_DIR / "logs" / "ejecucion.log"

# Esquema esperado del dataset
COLUMNAS_NUMERICAS = ["temperatura", "humedad", "radiacion_solar", "precipitacion", "viento"]
COLUMNA_CATEGORICA = "cultivo"
COLUMNA_OBJETIVO = "resultado"
COLUMNAS_REQUERIDAS = ["id", COLUMNA_CATEGORICA, *COLUMNAS_NUMERICAS, COLUMNA_OBJETIVO]

# --------------------------------------------------------------------------- #
# Logging
# --------------------------------------------------------------------------- #
LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(message)s",
    handlers=[
        logging.FileHandler(LOG_PATH, encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger("procesar_datos")


# --------------------------------------------------------------------------- #
# Funciones
# --------------------------------------------------------------------------- #
def leer_datos(ruta: Path) -> pd.DataFrame:
    """Lee el CSV y falla de forma explícita si no existe."""
    if not ruta.exists():
        raise FileNotFoundError(f"No se encontró el dataset en {ruta}")
    df = pd.read_csv(ruta)
    log.info("Dataset leído: %s (%d filas, %d columnas)", ruta.name, *df.shape)
    return df


def validar_esquema(df: pd.DataFrame) -> None:
    """Comprueba que estén todas las columnas necesarias."""
    faltantes = [c for c in COLUMNAS_REQUERIDAS if c not in df.columns]
    if faltantes:
        raise ValueError(f"Faltan columnas requeridas: {faltantes}")
    log.info("Esquema validado correctamente (%d columnas requeridas)", len(COLUMNAS_REQUERIDAS))


def convertir_numericos(df: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    """Convierte las columnas numéricas y contabiliza valores inválidos."""
    detalle = {}
    for col in COLUMNAS_NUMERICAS:
        original_nulos = int(df[col].isna().sum())
        df[col] = pd.to_numeric(df[col], errors="coerce")
        nuevos_nulos = int(df[col].isna().sum())
        invalidos = nuevos_nulos - original_nulos
        detalle[col] = {
            "validos": int(df[col].notna().sum()),
            "invalidos": invalidos,
            "nulos_originales": original_nulos,
            "promedio": round(float(df[col].mean()), 3) if df[col].notna().any() else None,
            "min": round(float(df[col].min()), 3) if df[col].notna().any() else None,
            "max": round(float(df[col].max()), 3) if df[col].notna().any() else None,
        }
        if invalidos:
            log.warning("Columna '%s': %d valores no numéricos convertidos a NaN", col, invalidos)
    return df, detalle


def normalizar_objetivo(df: pd.DataFrame) -> pd.DataFrame:
    """Normaliza la variable objetivo a mayúsculas sin espacios."""
    df[COLUMNA_OBJETIVO] = df[COLUMNA_OBJETIVO].astype(str).str.strip().str.upper()
    valores_raros = set(df[COLUMNA_OBJETIVO].unique()) - {"SI", "NO"}
    if valores_raros:
        log.warning("Valores inesperados en '%s': %s", COLUMNA_OBJETIVO, sorted(valores_raros))
    return df


def construir_resultado(df: pd.DataFrame, detalle: dict) -> dict:
    """Construye el diccionario que se serializa a JSON."""
    filas_validas = int(df.dropna(subset=COLUMNAS_NUMERICAS).shape[0])
    filas_invalidas = int(df.shape[0] - filas_validas)

    distribucion_objetivo = df[COLUMNA_OBJETIVO].value_counts().to_dict()
    distribucion_cultivo = df[COLUMNA_CATEGORICA].value_counts().to_dict()
    promedio_por_cultivo = (
        df.groupby(COLUMNA_CATEGORICA)[COLUMNAS_NUMERICAS].mean().round(3).to_dict(orient="index")
    )
    tasa_si_por_cultivo = (
        df.assign(_si=(df[COLUMNA_OBJETIVO] == "SI").astype(int))
        .groupby(COLUMNA_CATEGORICA)["_si"]
        .mean()
        .round(3)
        .to_dict()
    )

    return {
        "fecha_ejecucion": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "archivo_origen": DATA_PATH.name,
        "filas_totales": int(df.shape[0]),
        "filas_validas": filas_validas,
        "filas_invalidas": filas_invalidas,
        "columnas": list(df.columns),
        "columnas_numericas": detalle,
        "promedio_general": {c: detalle[c]["promedio"] for c in COLUMNAS_NUMERICAS},
        "distribucion_resultado": {k: int(v) for k, v in distribucion_objetivo.items()},
        "distribucion_cultivo": {k: int(v) for k, v in distribucion_cultivo.items()},
        "promedio_por_cultivo": promedio_por_cultivo,
        "tasa_si_por_cultivo": tasa_si_por_cultivo,
    }


def guardar_json(resultado: dict, ruta: Path) -> None:
    ruta.parent.mkdir(parents=True, exist_ok=True)
    with ruta.open("w", encoding="utf-8") as f:
        json.dump(resultado, f, ensure_ascii=False, indent=2)
    log.info("Resultado guardado en %s", ruta)


def main() -> int:
    log.info("=" * 60)
    log.info("Inicio del procesamiento de datos")
    try:
        df = leer_datos(DATA_PATH)
        validar_esquema(df)
        df, detalle = convertir_numericos(df)
        df = normalizar_objetivo(df)
        resultado = construir_resultado(df, detalle)
        guardar_json(resultado, OUTPUT_PATH)
        log.info(
            "Resumen: %d filas | %d válidas | %d inválidas | resultado=%s",
            resultado["filas_totales"],
            resultado["filas_validas"],
            resultado["filas_invalidas"],
            resultado["distribucion_resultado"],
        )
        log.info("Procesamiento finalizado con éxito")
        return 0
    except Exception as exc:  # noqa: BLE001 - queremos registrar cualquier fallo
        log.exception("Error durante el procesamiento: %s", exc)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
