require('dotenv').config();
const { Pool } = require('pg');

// Configuración de la base de datos
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function addUniqueConstraint() {
    try {
        // Ejecutar la consulta para agregar la restricción UNIQUE
        await pool.query('ALTER TABLE sucursales ADD CONSTRAINT unique_nombre UNIQUE (nombre)');
        console.log('Unique constraint added to the "nombre" column in "sucursales".');
    } catch (err) {
        // Si la restricción ya existe, manejar el error
        if (err.code === '23505' || err.message.includes('already exists')) {
            console.log('Unique constraint on "nombre" column already exists.');
        } else {
            console.error('Error adding unique constraint:', err);
        }
    } finally {
        // Cerrar la conexión a la base de datos
        await pool.end();
    }
}

// Ejecutar la función para agregar el índice único
addUniqueConstraint();
