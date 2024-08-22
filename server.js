require('dotenv').config();
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const session = require('express-session');
const { Pool } = require('pg');
const multer = require('multer');
const excel = require('exceljs');
const nodemailer = require('nodemailer');  // Agregar nodemailer para enviar correos
const fs = require('fs');  // Importar fs para manejar archivos

// Configurar nodemailer
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,  // Email del remitente
        pass: process.env.EMAIL_PASS   // Contraseña del remitente
    }
});


const app = express();

// Configuración de la base de datos
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Configuración de EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Configuración de middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: 'secret-key',
    resave: false,
    saveUninitialized: true
}));

// Configuración de Multer para subir archivos
const upload = multer({ dest: 'uploads/' });

// Ruta raíz para redirigir a login o index
app.get('/', (req, res) => {
    if (!req.session.user) {
        res.redirect('/login');
    } else {
        res.redirect('/index');
    }
});

// Ruta para el login
app.get('/login', (req, res) => {
    res.render('login');
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1 AND password = $2', [username, password]);
        if (result.rows.length > 0) {
            req.session.user = result.rows[0];
            res.redirect('/index');
        } else {
            res.redirect('/login?error=Invalid%20credentials');
        }
    } catch (err) {
        console.error(err);
        res.redirect('/login?error=Server%20error');
    }
});

app.get('/index', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }
    try {
        const sucursalesResult = await pool.query('SELECT * FROM sucursales');
        const empleadosResult = await pool.query('SELECT * FROM empleados');
        const sucursales = sucursalesResult.rows;
        const empleados = empleadosResult.rows;

        sucursales.forEach(sucursal => {
            const historicoVentas = sucursal.historico_ventas;
            const diasAbiertos = sucursal.dias_abiertos.split(','); // Obtener los días en que la sucursal está abierta
            let totalVentas = 0;
            let semanas = 0;
            let ventasPorHora = {};
            let ventasPorDia = { Lunes: 0, Martes: 0, Miércoles: 0, Jueves: 0, Viernes: 0, Sábado: 0, Domingo: 0 };

            if (historicoVentas) {
                for (const mes in historicoVentas) {
                    const ventas = historicoVentas[mes].ventas;
                    totalVentas += ventas;
                    semanas += 4; // Suponiendo 4 semanas por mes

                    // Distribuir las ventas en horas y días
                    for (let hora in historicoVentas[mes].horas) {
                        if (!ventasPorHora[hora]) ventasPorHora[hora] = 0;
                        ventasPorHora[hora] += historicoVentas[mes].horas[hora];
                    }
                    for (let dia in historicoVentas[mes].dias) {
                        ventasPorDia[dia] += historicoVentas[mes].dias[dia];
                    }
                }
            }

            const promedioSemanal = semanas > 0 ? totalVentas / semanas : 0;

            // Determinar las horas pico (horas con mayores ventas)
            const horasPico = Object.keys(ventasPorHora).sort((a, b) => ventasPorHora[b] - ventasPorHora[a]).slice(0, 3); // Top 3 horas pico

            // Distribuir empleados según el día y la hora
            let empleadosNecesariosPorTurno = [];
            const totalEmpleados = sucursal.cantidad_empleados;
            const maxEmpleadosPorTurno = sucursal.cantidad_pc + 1; // Máximo empleados = número de PCs + 1

            const turnos = sucursal.turnos.split('/').length;

            // Distribución de empleados por día según ventas y día de la semana
            const distribucionPorDia = {
                Lunes: 0.9, // Peso menor para lunes
                Martes: 1,  // Peso estándar
                Miércoles: 1,
                Jueves: 1.1,  // Ligeramente más para jueves
                Viernes: 1.2,  // Más empleados para viernes
                Sábado: 1.3,  // Peso mayor para sábado
                Domingo: 1.4  // Mayor peso para domingo
            };

            sucursal.turnos.split('/').forEach((turno, turnoIndex) => {
                let empleadosParaEsteTurno = 0;

                const diaSemana = turnoIndex % 7;
                const dias = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
                const diaActual = dias[diaSemana];

                // Verificar si la sucursal está abierta ese día
                if (diasAbiertos.includes(diaActual)) {
                    // Distribuir empleados según la venta del día y el turno
                    empleadosParaEsteTurno = Math.ceil((distribucionPorDia[diaActual] * promedioSemanal * 0.1) + (horasPico.includes(turno) ? 0.5 : 0));

                    // Aplicar límite según el número de PCs disponibles más uno
                    empleadosParaEsteTurno = Math.min(empleadosParaEsteTurno, maxEmpleadosPorTurno);
                }

                empleadosNecesariosPorTurno.push(empleadosParaEsteTurno);
            });

            sucursal.empleados_necesarios = empleadosNecesariosPorTurno;
        });

        res.render('index', { sucursales, empleados });
    } catch (err) {
        console.error(err);
        res.redirect('/login?error=Server%20error');
    }
});





app.post('/index/exportar', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT s.nombre AS sucursal_nombre, s.horario, t.turno, e.nombre AS empleado_nombre
            FROM sucursales s
            JOIN empleados e ON e.sucursal_id = s.id
            JOIN (SELECT unnest(string_to_array(turnos, '/')) AS turno, id FROM sucursales) t ON t.id = s.id
            ORDER BY s.id, t.turno
        `);
        const rows = result.rows;

        let content = '';

        let currentSucursal = '';
        rows.forEach(row => {
            if (row.sucursal_nombre !== currentSucursal) {
                currentSucursal = row.sucursal_nombre;
                content += `\nSucursal: ${currentSucursal}\nHorario: ${row.horario}\n\n`;
            }
            content += `${row.turno}: Empleado: ${row.empleado_nombre}\n`;
        });

        const filePath = path.join(__dirname, 'public', 'turnos.txt');
        fs.writeFileSync(filePath, content);

        res.download(filePath, 'turnos.txt');
    } catch (err) {
        console.error(err);
        res.redirect('/index?error=Server%20error');
    }
});


app.get('/modificaciones', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    try {
        const result = await pool.query('SELECT * FROM modificaciones WHERE estado = $1', ['Pendiente']);
        res.render('modificaciones', { modificaciones: result.rows });
    } catch (err) {
        console.error(err);
        res.redirect('/index?error=Server%20error');
    }
});

app.post('/modificaciones/aprobar/:id', async (req, res) => {
    const modificacionId = req.params.id;

    try {
        await pool.query('UPDATE modificaciones SET estado = $1 WHERE id = $2', ['Aprobada', modificacionId]);
        res.redirect('/modificaciones');
    } catch (err) {
        console.error(err);
        res.redirect('/modificaciones?error=Server%20error');
    }
});

app.post('/modificaciones/desaprobar/:id', async (req, res) => {
    const modificacionId = req.params.id;

    try {
        await pool.query('UPDATE modificaciones SET estado = $1 WHERE id = $2', ['Desaprobada', modificacionId]);
        res.redirect('/modificaciones');
    } catch (err) {
        console.error(err);
        res.redirect('/modificaciones?error=Server%20error');
    }
});


app.post('/index/empleados/:id', async (req, res) => {
    const sucursalId = req.params.id;
    const empleadosAsignados = [];

    for (let key in req.body) {
        if (key.startsWith('empleado_')) {
            const empleadoId = req.body[key];
            if (empleadoId) {
                const [_, diaIndex, turnoIndex, empIndex] = key.split('_').slice(2);
                empleadosAsignados.push({
                    dia: diaIndex,
                    turno: turnoIndex,
                    empIndex: empIndex,
                    id: empleadoId,
                    color: req.body[`color_${sucursalId}_${diaIndex}_${turnoIndex}`] || '#ffffff'
                });
            }
        }
    }

    try {
        for (const empleado of empleadosAsignados) {
            await pool.query(
                'UPDATE empleados SET turno = $1, color = $2 WHERE id = $3 AND sucursal_id = $4',
                [`${empleado.dia}-${empleado.turno}`, empleado.color, empleado.id, sucursalId]
            );
        }

        // Registrar la modificación
        await pool.query('INSERT INTO modificaciones (sucursal_id, estado) VALUES ($1, $2)', [sucursalId, 'Pendiente']);

        // Enviar correo al administrador
        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: process.env.ADMIN_EMAIL,
            subject: 'Modificación de horarios pendiente de aprobación',
            text: `Se han modificado los horarios de la sucursal con ID ${sucursalId}. Por favor, revisa y aprueba o desaprueba los cambios.`
        };

        transporter.sendMail(mailOptions, (error, info) => {
            if (error) {
                console.log(error);
            } else {
                console.log('Correo enviado: ' + info.response);
            }
        });

        res.redirect('/index');
    } catch (err) {
        console.error(err);
        res.redirect('/index?error=Server%20error');
    }
});



// Ruta para ver las sucursales (CRUD)
app.get('/sucursales', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM sucursales');
        res.render('sucursales', { sucursales: result.rows });
    } catch (err) {
        console.error(err);
        res.redirect('/sucursales?error=Server%20error');
    }
});

// Ruta para agregar una nueva sucursal
app.post('/sucursales/add', async (req, res) => {
    const { nombre, horario, cantidad_empleados, cantidad_pc, turnos, historico_ventas } = req.body;
    try {
        await pool.query(
            'INSERT INTO sucursales (nombre, horario, cantidad_empleados, cantidad_pc, turnos, historico_ventas) VALUES ($1, $2, $3, $4, $5, $6)',
            [nombre, horario, cantidad_empleados, cantidad_pc, turnos, JSON.parse(historico_ventas)]
        );
        res.redirect('/sucursales');
    } catch (err) {
        console.error(err);
        res.redirect('/sucursales?error=Server%20error');
    }
});

// Ruta para eliminar una sucursal
app.post('/sucursales/delete/:id', async (req, res) => {
    const sucursalId = req.params.id;
    try {
        await pool.query('DELETE FROM sucursales WHERE id = $1', [sucursalId]);
        res.redirect('/sucursales');
    } catch (err) {
        console.error(err);
        res.redirect('/sucursales?error=Server%20error');
    }
});

// Ruta para actualizar una sucursal (si fuera necesario para un CRUD más completo)
app.post('/sucursales/update/:id', async (req, res) => {
    const sucursalId = req.params.id;
    const { nombre, horario, cantidad_empleados, cantidad_pc, turnos, historico_ventas } = req.body;
    try {
        await pool.query(
            'UPDATE sucursales SET nombre = $1, horario = $2, cantidad_empleados = $3, cantidad_pc = $4, turnos = $5, historico_ventas = $6 WHERE id = $7',
            [nombre, horario, cantidad_empleados, cantidad_pc, turnos, JSON.parse(historico_ventas), sucursalId]
        );
        res.redirect('/sucursales');
    } catch (err) {
        console.error(err);
        res.redirect('/sucursales?error=Server%20error');
    }
});

app.post('/sucursales/dias_abiertos/:id', async (req, res) => {
    const sucursalId = req.params.id;
    const { dias_abiertos } = req.body;

    try {
        await pool.query('UPDATE sucursales SET dias_abiertos = $1 WHERE id = $2', [dias_abiertos, sucursalId]);
        res.redirect('/sucursales');
    } catch (err) {
        console.error(err);
        res.redirect('/sucursales?error=Server%20error');
    }
});


// Ruta para agregar o actualizar sucursales desde un archivo Excel
app.post('/sucursales/import', upload.single('file'), async (req, res) => {
    const workbook = new excel.Workbook();
    try {
        await workbook.xlsx.readFile(req.file.path);
        const worksheet = workbook.getWorksheet(1);
        worksheet.eachRow(async (row, rowNumber) => {
            if (rowNumber > 1) {
                const nombre = row.getCell(1).value;
                const horario = row.getCell(2).value;
                const cantidad_empleados = row.getCell(3).value;
                const cantidad_pc = row.getCell(4).value;
                const turnos = row.getCell(5).value;
                const historico_ventas = JSON.stringify(row.getCell(6).value);

                await pool.query(
                    'INSERT INTO sucursales (nombre, horario, cantidad_empleados, cantidad_pc, turnos, historico_ventas) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (nombre) DO UPDATE SET horario = EXCLUDED.horario, cantidad_empleados = EXCLUDED.cantidad_empleados, cantidad_pc = EXCLUDED.cantidad_pc, turnos = EXCLUDED.turnos, historico_ventas = EXCLUDED.historico_ventas',
                    [nombre, horario, cantidad_empleados, cantidad_pc, turnos, historico_ventas]
                );
            }
        });
        res.redirect('/sucursales');
    } catch (err) {
        console.error(err);
        res.redirect('/sucursales?error=Server%20error');
    }
});

// Ruta para exportar un archivo Excel de ejemplo
app.get('/sucursales/export', (req, res) => {
    const workbook = new excel.Workbook();
    const worksheet = workbook.addWorksheet('Sucursales');

    worksheet.columns = [
        { header: 'Nombre', key: 'nombre', width: 30 },
        { header: 'Horario', key: 'horario', width: 20 },
        { header: 'Cantidad de Empleados', key: 'cantidad_empleados', width: 20 },
        { header: 'Cantidad de PCs', key: 'cantidad_pc', width: 20 },
        { header: 'Turnos', key: 'turnos', width: 30 },
        { header: 'Histórico de Ventas (JSON)', key: 'historico_ventas', width: 30 }
    ];

    worksheet.addRow({
        nombre: 'Ejemplo Sucursal',
        horario: '08:00 - 18:00',
        cantidad_empleados: 10,
        cantidad_pc: 5,
        turnos: 'Mañana/Tarde',
        historico_ventas: '{"2024-06": {"ventas": 1000}, "2024-07": {"ventas": 1200}}'
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=sucursales_ejemplo.xlsx');

    return workbook.xlsx.write(res).then(() => {
        res.end();
    });
});

// Iniciar el servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
