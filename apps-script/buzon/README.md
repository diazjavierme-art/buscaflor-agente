# Buzón Buscaflor (Apps Script)

Copia del proyecto «Buzón Buscaflor» de facturasbuscaflor@gmail.com.
Es una copia de seguridad: el código que funciona es el del editor de Apps Script.
Si se cambia allí, hay que volver a copiarlo aquí.

Archivos:
- Código.gs: clasifica el correo, guarda facturas en Drive, pagos exterior, avisos y resumen diario.
- vuelos.gs: control de facturas por guía (AWB) e inventario de stock de cada vuelo.
- vallinoto.gs: Excel mensual de Vallinoto.
- Gastos.gs: Excel global de gastos (facturas españolas).
- EstadosCuenta.gs: petición de estados de cuenta a fincas y transitarios, y a clientes.
- Envioentregas.gs: envío de entregas firmadas desde la app de reparto.
- appsscript.json: ajustes del proyecto.

Las claves (Gemini, etc.) están en Propiedades del script, nunca en el código.

## GitHub es el original
Desde el 25-11-2026 el código se cambia aquí, no en el editor de Apps Script.
Cada cambio en esta carpeta se sube solo al buzón (acción «Subir buzón a Apps Script»).
Si alguien cambia algo en el editor, se perderá en la siguiente subida.

- PagosEspana.gs: justificantes de transferencias a proveedores españoles soltados en
  «04 Gastos España / _Subir pagos aquí» → «04 Gastos España / Pagos / AÑO / Proveedor».
