// config/db.js
const mysql = require('mysql2/promise');
require('dotenv').config();

// Buat pool koneksi database
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
});

// Fungsi untuk test koneksi
async function testConnection() {
    try {
        const connection = await pool.getConnection();
        console.log('✅ Berhasil terkoneksi ke database MySQL.');
        connection.release();
        return { success: true, message: 'Database connected' };
    } catch (err) {
        console.error('❌ Gagal terkoneksi ke database:', err.message);
        return { success: false, message: err.message };
    }
}

// Fungsi untuk mendapatkan koneksi (dengan transaction support)
async function getConnection() {
    return await pool.getConnection();
}

// Fungsi untuk eksekusi query
async function executeQuery(sql, params = []) {
    try {
        const [rows] = await pool.execute(sql, params);
        return rows;
    } catch (error) {
        console.error('Query error:', error);
        throw error;
    }
}

// Fungsi untuk transaction
async function transaction(callback) {
    const connection = await pool.getConnection();
    await connection.beginTransaction();
    try {
        const result = await callback(connection);
        await connection.commit();
        return result;
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

// ✅ EKSPOR pool dengan metode execute
module.exports = {
    pool,  // ← Pastikan pool diekspor
    testConnection,
    getConnection,
    executeQuery,
    transaction,
};