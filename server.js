// =====================================================================
//  API del inventario de gorras (Node.js + Express + SQL Server)
//  Ejecutar con:  npm install   y luego   npm start
//  Abrir en el navegador:  http://localhost:3000
// =====================================================================
const express = require('express');
const sql = require('mssql');
const path = require('path');
const cors = require('cors');

// ---- CONFIGURACIÓN (cambia estos datos si tu SQL Server es distinto) ----
const SERVIDOR = 'localhost';
const INSTANCIA = '';            // Si usas SQL Express escribe: 'SQLEXPRESS'
const PUERTO_WEB = 3000;

const config = {
  server: 'InventarioGorrasDB.mssql.somee.com',
  user: 'angel_25_SQLLogin_1',
  password: 'qrxmis3yk8', 
  database: 'InventarioGorrasDB',
  options: {
    encrypt: true,
    trustServerCertificate: true
  }
};
if (INSTANCIA) config.options.instanceName = INSTANCIA;

// ---- CONEXIÓN ----
const poolPromise = sql.connect(config).then(pool => {
  console.log('Conectado a SQL Server.');
  return pool;
});
poolPromise.catch(err => {
  console.error('No se pudo conectar a SQL Server:', err.message);
  console.error('Revisa el archivo LEEME.md (sección "Problemas comunes").');
});

// ---- UTILIDADES ----
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Error "de negocio": se muestra tal cual al usuario (código 400)
const fallar = (mensaje) => { throw Object.assign(new Error(mensaje), { number: 50000 }); };

// Envuelve cada ruta para capturar errores en un solo lugar
const ruta = (fn) => async (req, res) => {
  try {
    await fn(req, res, await poolPromise);
  } catch (e) {
    console.error(e.message);
    const esNegocio = e.number >= 50000;
    res.status(esNegocio ? 400 : 500)
       .json({ error: esNegocio ? e.message : 'Error en el servidor: ' + e.message });
  }
};

function validarGorra(b) {
  const g = {
    nombre: String(b.nombre || '').trim(),
    idMarca: parseInt(b.idMarca), idCategoria: parseInt(b.idCategoria), idProveedor: parseInt(b.idProveedor),
    color: String(b.color || '').trim(), talla: String(b.talla || 'Ajustable').trim(),
    precio: Number(b.precio), stock: parseInt(b.stock) || 0, stockMinimo: parseInt(b.stockMinimo)
  };
  if (!g.nombre) fallar('El nombre es obligatorio.');
  if (!g.idMarca || !g.idCategoria || !g.idProveedor) fallar('Elige marca, categoría y proveedor.');
  if (!g.color) fallar('El color es obligatorio.');
  if (!(g.precio >= 0)) fallar('El precio debe ser un número mayor o igual a 0.');
  if (!(g.stockMinimo >= 0)) fallar('El stock mínimo debe ser 0 o más.');
  if (g.stock < 0) fallar('El stock inicial no puede ser negativo.');
  return g;
}

// =====================================================================
//  RUTAS
// =====================================================================

// Marcas, categorías y proveedores (para llenar los select del formulario)
app.get('/api/catalogos', ruta(async (req, res, pool) => {
  const r = await pool.request().query(`
    SELECT IdMarca AS id, Nombre AS nombre FROM Marcas ORDER BY Nombre;
    SELECT IdCategoria AS id, Nombre AS nombre FROM Categorias ORDER BY Nombre;
    SELECT IdProveedor AS id, Nombre AS nombre FROM Proveedores ORDER BY Nombre;`);
  res.json({ marcas: r.recordsets[0], categorias: r.recordsets[1], proveedores: r.recordsets[2] });
}));

// Resumen para el tablero principal
app.get('/api/resumen', ruta(async (req, res, pool) => {
  const r = await pool.request().query(`
    SELECT COUNT(*) AS modelos,
           ISNULL(SUM(Stock), 0) AS piezas,
           ISNULL(SUM(Stock * Precio), 0) AS valor,
           ISNULL(SUM(CASE WHEN Stock = 0 THEN 1 ELSE 0 END), 0) AS agotadas,
           ISNULL(SUM(CASE WHEN Stock > 0 AND Stock <= StockMinimo THEN 1 ELSE 0 END), 0) AS stockBajo
    FROM Gorras WHERE Activo = 1`);
  res.json(r.recordset[0]);
}));

// Listar inventario
app.get('/api/gorras', ruta(async (req, res, pool) => {
  const r = await pool.request().query('SELECT * FROM vw_Inventario ORDER BY Nombre');
  res.json(r.recordset);
}));

// Crear gorra
app.post('/api/gorras', ruta(async (req, res, pool) => {
  const g = validarGorra(req.body);
  const r = await pool.request()
    .input('nombre', sql.NVarChar(100), g.nombre)
    .input('marca', sql.Int, g.idMarca).input('categoria', sql.Int, g.idCategoria)
    .input('proveedor', sql.Int, g.idProveedor)
    .input('color', sql.NVarChar(30), g.color).input('talla', sql.NVarChar(20), g.talla)
    .input('precio', sql.Decimal(10, 2), g.precio)
    .input('stock', sql.Int, g.stock).input('minimo', sql.Int, g.stockMinimo)
    .query(`
      INSERT INTO Gorras (Nombre, IdMarca, IdCategoria, IdProveedor, Color, Talla, Precio, Stock, StockMinimo)
      VALUES (@nombre, @marca, @categoria, @proveedor, @color, @talla, @precio, 0, @minimo);
      DECLARE @id INT = SCOPE_IDENTITY();
      IF @stock > 0 EXEC sp_RegistrarMovimiento @id, 'ENTRADA', @stock, N'Stock inicial';
      SELECT @id AS IdGorra;`);
  res.status(201).json({ idGorra: r.recordset[0].IdGorra });
}));

// Editar gorra (el stock se cambia solo con movimientos)
app.put('/api/gorras/:id', ruta(async (req, res, pool) => {
  const g = validarGorra(req.body);
  const r = await pool.request()
    .input('id', sql.Int, parseInt(req.params.id))
    .input('nombre', sql.NVarChar(100), g.nombre)
    .input('marca', sql.Int, g.idMarca).input('categoria', sql.Int, g.idCategoria)
    .input('proveedor', sql.Int, g.idProveedor)
    .input('color', sql.NVarChar(30), g.color).input('talla', sql.NVarChar(20), g.talla)
    .input('precio', sql.Decimal(10, 2), g.precio).input('minimo', sql.Int, g.stockMinimo)
    .query(`
      UPDATE Gorras SET Nombre=@nombre, IdMarca=@marca, IdCategoria=@categoria, IdProveedor=@proveedor,
             Color=@color, Talla=@talla, Precio=@precio, StockMinimo=@minimo
      WHERE IdGorra=@id AND Activo=1`);
  if (r.rowsAffected[0] === 0) fallar('La gorra no existe.');
  res.json({ ok: true });
}));

// Eliminar gorra (borrado lógico: se conserva el historial de movimientos)
app.delete('/api/gorras/:id', ruta(async (req, res, pool) => {
  const r = await pool.request()
    .input('id', sql.Int, parseInt(req.params.id))
    .query('UPDATE Gorras SET Activo = 0 WHERE IdGorra = @id AND Activo = 1');
  if (r.rowsAffected[0] === 0) fallar('La gorra no existe.');
  res.json({ ok: true });
}));

// Últimos movimientos
app.get('/api/movimientos', ruta(async (req, res, pool) => {
  const r = await pool.request().query(`
    SELECT TOP 50 mv.IdMovimiento, g.Nombre AS Gorra, mv.Tipo, mv.Cantidad, mv.Fecha, mv.Nota
    FROM Movimientos mv JOIN Gorras g ON g.IdGorra = mv.IdGorra
    ORDER BY mv.Fecha DESC, mv.IdMovimiento DESC`);
  res.json(r.recordset);
}));

// Registrar entrada o salida (usa el procedimiento almacenado)
app.post('/api/movimientos', ruta(async (req, res, pool) => {
  const { idGorra, tipo, cantidad, nota } = req.body;
  const id = parseInt(idGorra), cant = parseInt(cantidad);
  if (!id) fallar('Elige una gorra.');
  if (!(cant > 0)) fallar('La cantidad debe ser un número mayor a cero.');
  await pool.request()
    .input('IdGorra', sql.Int, id)
    .input('Tipo', sql.VarChar(10), String(tipo || '').toUpperCase())
    .input('Cantidad', sql.Int, cant)
    .input('Nota', sql.NVarChar(200), nota ? String(nota).trim() : null)
    .execute('sp_RegistrarMovimiento');
  res.status(201).json({ ok: true });
}));

app.listen(PUERTO_WEB, () => console.log(`Abre en tu navegador: http://localhost:${PUERTO_WEB}`));
