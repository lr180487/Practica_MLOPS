# AGENT-REACT-RAG

Aplicación web basada en **FastAPI** para orquestación de agentes, recuperación de información documental (RAG) e integración de herramientas.

> **Estado:** proyecto en desarrollo. Verifica las pruebas, las integraciones externas y la configuración de seguridad antes de desplegar en producción.

## Características

- API HTTP con FastAPI y documentación OpenAPI.
- Flujo de procesamiento de consultas con componentes de análisis, procesamiento y respuesta.
- Recuperación de información documental (RAG).
- Integración configurable con servicios externos, según las dependencias y variables de entorno disponibles.
- Configuración mediante variables de entorno.
- Gestión de dependencias con `uv`.

> Las funciones disponibles dependen de los módulos y proveedores configurados en el entorno.

## Requisitos

- Python en una versión compatible con `.python-version` y `pyproject.toml`.
- [`uv`](https://docs.astral.sh/uv/).
- Credenciales y servicios externos necesarios para las funciones que se vayan a utilizar.

## Instalación

Clona el repositorio y entra en el directorio del proyecto:

```powershell
git clone <URL_DEL_REPOSITORIO>
cd agente_react_rag
```

Instala las dependencias declaradas y bloqueadas:

```powershell
uv sync --locked
```

Si el comando falla, revisa el error de construcción del paquete y comprueba que los archivos referenciados por `pyproject.toml`, incluido `README.md`, existan en la raíz del proyecto.

## Configuración del entorno

Si el repositorio incluye `.env.example`, crea una configuración local:

```powershell
Copy-Item .env.example .env
```

Edita `.env` y configura las variables que requiere la aplicación. No compartas el archivo `.env` ni guardes claves API, contraseñas o secretos reales en el repositorio.

## Ejecución local

Si `app/main.py` es el punto de entrada de la aplicación:

```powershell
uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Al iniciar el servidor, consulta:

- Swagger UI: <http://127.0.0.1:8000/docs>
- ReDoc: <http://127.0.0.1:8000/redoc>
- Esquema OpenAPI: <http://127.0.0.1:8000/openapi.json>

Si el punto de entrada difiere, ajusta el comando a la estructura real del repositorio.

## Pruebas y validación

Si `pytest` está instalado y las pruebas están configuradas:

```powershell
uv run pytest -q
```

Verifica que la aplicación se pueda importar:

```powershell
uv run python -c "import app.main; print('Importación correcta')"
```

Comprueba la construcción de las distribuciones:

```powershell
uv build
```

## Estructura del proyecto

La estructura exacta depende de los directorios presentes en el repositorio. Los siguientes archivos cumplen estas funciones cuando están disponibles:

| Archivo o directorio | Propósito |
|---|---|
| `app/` | Código de la aplicación backend. |
| `tests/` | Pruebas automatizadas. |
| `src/` | Código del paquete, si se utiliza en la configuración de construcción. |
| `pyproject.toml` | Metadatos, dependencias y configuración de herramientas. |
| `uv.lock` | Resolución bloqueada de dependencias. |
| `.python-version` | Versión de Python seleccionada para el proyecto. |
| `.env.example` | Plantilla de variables de entorno, si está incluida. |
| `.env` | Configuración local; no debe publicarse si contiene secretos. |

## Seguridad

- Mantén `.env` fuera del control de versiones.
- Usa secretos fuertes y únicos en cada entorno.
- Restringe CORS a los orígenes autorizados.
- Verifica autenticación y autorización en los endpoints protegidos.
- No registres credenciales ni datos sensibles en logs.
- Prueba el manejo de errores, los límites de solicitudes y los fallbacks de servicios externos antes de producción.

## Solución del error de Hatchling

Si aparece:

```text
OSError: Readme file does not exist: README.md
```

comprueba que este archivo esté en la misma carpeta raíz que `pyproject.toml` y que el campo `readme` de la configuración apunte al nombre y ruta correctos. Después ejecuta:

```powershell
uv lock --check
uv sync --locked
uv build
```

## Contribución

Antes de enviar cambios:

1. Ejecuta las pruebas disponibles.
2. Revisa los cambios con `git diff --check`.
3. No incluyas secretos, bases de datos locales ni archivos generados innecesarios.
4. Documenta cualquier cambio en la configuración o en los comandos de ejecución.

## Licencia

Pendiente de definir. Añade aquí la licencia aplicable antes de distribuir el proyecto.
