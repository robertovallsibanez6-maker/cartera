# Cartera

App personal de seguimiento de inversiones para iPhone (web app instalable desde Safari).

- **index.html / app.js / styles.css**: la app. Sin dependencias. Las operaciones se guardan solo en el dispositivo (localStorage) y pueden exportarse e importarse como JSON.
- **data/instruments.json**: catálogo de activos (ISIN, tipo, bloque, bróker, ticker de Yahoo).
- **data/seed.json**: carga inicial de operaciones. Solo se usa la primera vez que se abre la app en un dispositivo (o al pulsar "Restaurar carga inicial").
- **data/lookthrough.json**: composición aproximada de fondos e índices para el análisis de exposición.
- **data/prices.json, events.json, status.json, tickers.json**: generados automáticamente por `scripts/fetch_prices.py` desde GitHub Actions (`.github/workflows/prices.yml`), cada hora en horario de mercado.

## Instalar en el iPhone

1. Abre la URL de GitHub Pages del repositorio en **Safari**.
2. Pulsa el botón de compartir y elige **Añadir a pantalla de inicio**.
3. La app se abre a pantalla completa, con su icono. Funciona sin conexión con los últimos datos descargados.

## Añadir un activo nuevo con precio automático

Desde la app, en Operaciones → "Nuevo activo", indicando el símbolo de Yahoo Finance. O añadiéndolo a `data/instruments.json`: el pipeline lo descargará en la siguiente ejecución. Si se deja `yahoo` en `null`, el script intenta resolverlo por ISIN.

## Ejecutar el pipeline a mano

Actions → "Actualizar precios" → "Run workflow".

