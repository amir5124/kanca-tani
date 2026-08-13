// ==================== IMPORTS ====================
require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, query, validationResult } = require('express-validator');
const moment = require('moment');

// ==================== HELPERS ====================
const { sendPaymentInstruction, sendInvoiceWithPDF } = require('./helpers/emailHelper');
const { generateInvoicePDF } = require('./helpers/pdfHelper');
const { sendNotificationToUser } = require('./helpers/notificationHelper');

// ==================== EXPRESS SETUP ====================
const app = express();
const PORT = process.env.PORT || 5000;

// ==================== DATABASE ====================
// ✅ Buat pool di sini
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

async function testDbConnection() {
    try {
        const connection = await pool.getConnection();
        console.log('✅ Berhasil terkoneksi ke database MySQL.');
        connection.release();
    } catch (err) {
        console.error('❌ Gagal terkoneksi ke database:', err.message);
    }
}
testDbConnection();

// ✅ Ekspor pool agar bisa dipakai helper lain
module.exports = pool;
// ==================== MIDDLEWARE ====================
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors());
app.use(express.json());

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use('/api/', limiter);

// ==================== AUTH MIDDLEWARE ====================
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: 'Access denied. No token provided.' });
    }
    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid or expired token.' });
        }
        req.user = user;
        next();
    });
};

const authenticateAdmin = (req, res, next) => {
    authenticateToken(req, res, () => {
        if (req.user.role !== 'admin' && req.user.role !== 'admin_master') {
            return res.status(403).json({ error: 'Access denied. Admin only.' });
        }
        next();
    });
};

const authenticateMasterAdmin = (req, res, next) => {
    authenticateToken(req, res, () => {
        if (req.user.role !== 'admin_master') {
            return res.status(403).json({ error: 'Access denied. Master admin only.' });
        }
        next();
    });
};

// ==================== HELPER FUNCTIONS ====================
function generateBookingReference(prefix = 'BKG') {
    const timestamp = moment().format('YYYYMMDD');
    const random = Math.floor(1000 + Math.random() * 9000);
    return `${prefix}-${timestamp}-${random}`;
}

function generateReferralCode() {
    const prefix = 'REF';
    const random = Math.random().toString(36).substring(2, 8).toUpperCase();
    return `${prefix}${random}`;
}

function formatRupiah(amount) {
    if (!amount && amount !== 0) return 'Rp 0';
    return new Intl.NumberFormat('id-ID', {
        style: 'currency',
        currency: 'IDR',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
    }).format(amount);
}

function calculatePrice(basePrice, distanceKm, pricePerKm, isReturn, discountPercent) {
    let total = basePrice;
    if (distanceKm) {
        total += distanceKm * pricePerKm;
    }
    if (isReturn) {
        total *= 2;
    }
    const discountAmount = total * (discountPercent / 100);
    const finalPrice = total - discountAmount;
    return {
        totalPrice: total,
        discountAmount: discountAmount,
        finalPrice: finalPrice
    };
}

// ==================== VALIDASI EMAIL DENGAN EMAIL REPUTATION API ====================

function isValidEmailFormat(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ✅ Gunakan Email Reputation API (bukan Email Validation API)
const ABSTRACT_API_URL = 'https://emailreputation.abstractapi.com/v1/';

app.route('/api/validate-email')
  .post(async (req, res) => {
    const { email } = req.body;
    await handleEmailValidation(req, res, email);
  })
  .get(async (req, res) => {
    const { email } = req.query;
    await handleEmailValidation(req, res, email);
  });

async function handleEmailValidation(req, res, email) {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📧 Email Validation Request`);
  console.log(`📧 Method: ${req.method}`);
  console.log(`📧 Email: ${email}`);
  console.log(`📧 IP: ${req.ip || req.connection?.remoteAddress}`);
  console.log(`📧 Timestamp: ${new Date().toISOString()}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // 1. Validasi email wajib diisi
  if (!email) {
    console.log('❌ Validation failed: Email is empty');
    return res.status(400).json({ 
      valid: false, 
      message: 'Email wajib diisi' 
    });
  }

  // 2. Filter cepat - validasi format
  if (!isValidEmailFormat(email)) {
    console.log(`❌ Validation failed: Invalid format for ${email}`);
    return res.json({ 
      valid: false, 
      message: 'Format email tidak valid' 
    });
  }

  // 3. Panggil Email Reputation API (bukan Email Validation)
  const apiKey = process.env.ABSTRACT_API_KEY || '28cdc3adf33543cba045088c47a75c9f';
  
  try {
    console.log(`🔍 Calling AbstractAPI Email Reputation for: ${email}`);
    console.log(`🔑 API Key: ${apiKey.substring(0, 8)}...${apiKey.substring(apiKey.length - 4)}`);
    
    const apiUrl = `https://emailreputation.abstractapi.com/v1/?api_key=${apiKey}&email=${encodeURIComponent(email)}`;
    console.log(`📡 API URL: ${apiUrl.replace(apiKey, 'HIDDEN')}`);
    
    const response = await fetch(apiUrl, {
      timeout: 10000
    });

    console.log(`📡 AbstractAPI Response Status: ${response.status}`);

    if (!response.ok) {
      console.error(`❌ AbstractAPI error: ${response.status}`);
      // Fail-open: kalau API error, jangan block user
      return res.json({ 
        valid: true, 
        message: 'Validasi eksternal gagal, dilewati',
        warning: true
      });
    }

    const data = await response.json();
    console.log(`✅ AbstractAPI Response received`);
    console.log(`📊 Results:`, {
      deliverability: data.email_deliverability?.status,
      isFormatValid: data.email_deliverability?.is_format_valid,
      isSmtpValid: data.email_deliverability?.is_smtp_valid,
      isMxValid: data.email_deliverability?.is_mx_valid,
      isDisposable: data.email_quality?.is_disposable,
      isCatchall: data.email_quality?.is_catchall,
      qualityScore: data.email_quality?.score,
      riskStatus: data.email_risk?.address_risk_status
    });

    // 4. Analisis hasil dari Email Reputation API
    const deliverability = data.email_deliverability;
    const quality = data.email_quality;
    const risk = data.email_risk;

    // Cek deliverability
    if (!deliverability || deliverability.status === 'undeliverable') {
      console.log(`❌ Undeliverable email: ${email}`);
      return res.json({ 
        valid: false, 
        message: 'Email tidak dapat menerima pesan',
        details: { deliverability: deliverability?.status }
      });
    }

    // Cek format & MX
    if (!deliverability?.is_format_valid) {
      console.log(`❌ Invalid format: ${email}`);
      return res.json({ 
        valid: false, 
        message: 'Format email tidak valid' 
      });
    }

    if (!deliverability?.is_mx_valid) {
      console.log(`❌ Invalid MX: ${email}`);
      return res.json({ 
        valid: false, 
        message: 'Domain email tidak valid' 
      });
    }

    // Cek disposable
    if (quality?.is_disposable) {
      console.log(`❌ Disposable email: ${email}`);
      return res.json({ 
        valid: false, 
        message: 'Email sementara/disposable tidak diperbolehkan' 
      });
    }

    // Cek catchall (biasanya dianggap risky)
    if (quality?.is_catchall) {
      console.log(`⚠️ Catchall email detected: ${email}`);
      // Bisa diizinkan dengan warning, atau ditolak tergantung kebijakan
      // return res.json({ valid: false, message: 'Catchall email tidak diperbolehkan' });
    }

    // Cek risk
    if (risk?.address_risk_status === 'high' || risk?.domain_risk_status === 'high') {
      console.log(`⚠️ High risk email: ${email}`);
      // Bisa ditolak atau diizinkan dengan warning
    }

    // 5. ✅ Email valid
    console.log(`✅ Email validation SUCCESS: ${email}`);
    return res.json({ 
      valid: true,
      deliverability: deliverability?.status,
      qualityScore: quality?.score,
      riskStatus: risk?.address_risk_status,
      message: 'Email valid'
    });

  } catch (err) {
    console.error(`❌ Email validation error:`, err.message);
    console.error(`📚 Full error:`, err);
    
    // 🔄 Fail-open: Kalau API down, jangan block user booking
    console.log(`⚠️ Fail-open: Allowing ${email} due to external API error`);
    return res.json({ 
      valid: true, 
      message: 'Validasi eksternal gagal, dilewati',
      warning: true
    });
  }
}

// ==================== ENDPOINT STATUS ====================
app.get('/api/validate-email-status', (req, res) => {
  const apiKey = process.env.ABSTRACT_API_KEY || '28cdc3adf33543cba045088c47a75c9f';
  
  res.json({
    status: 'OK',
    apiKeyConfigured: true,
    apiKeyPreview: `${apiKey.substring(0, 8)}...${apiKey.substring(apiKey.length - 4)}`,
    apiProduct: 'Email Reputation API',
    validationMethod: 'AbstractAPI Email Reputation + Local',
    endpoints: {
      validate: 'GET /api/validate-email?email=your@email.com',
      status: 'GET /api/validate-email-status'
    }
  });
});

// ==================== TICKET BOAT HELPER FUNCTIONS ====================
async function getTicketBoatRoutes() {
    const [routes] = await pool.execute(
        'SELECT pickup_location, dropoff_location, base_price, port_fee, child_price FROM ticket_boat_routes WHERE is_active = 1'
    );
    return routes;
}

async function getTicketBoatTypes() {
    const [types] = await pool.execute(
        'SELECT code, name, description, price FROM ticket_boat_types WHERE is_active = 1'
    );
    return types;
}

async function getTicketBoatPrice(pickup, dropoff) {
    const [routes] = await pool.execute(
        'SELECT base_price, port_fee, child_price FROM ticket_boat_routes WHERE pickup_location = ? AND dropoff_location = ? AND is_active = 1',
        [pickup, dropoff]
    );
    if (routes.length === 0) {
        const [reverseRoutes] = await pool.execute(
            'SELECT base_price, port_fee, child_price FROM ticket_boat_routes WHERE pickup_location = ? AND dropoff_location = ? AND is_active = 1',
            [dropoff, pickup]
        );
        if (reverseRoutes.length === 0) {
            return null;
        }
        return reverseRoutes[0];
    }
    return routes[0];
}

function calculateTbPrice(route, ticketType, adultCount, childCount, isReturn) {
    const adultPrice = parseFloat(ticketType.price) + parseFloat(route.port_fee);
    const childPrice = parseFloat(route.child_price) + parseFloat(route.port_fee);
    let total = (adultCount * adultPrice) + (childCount * childPrice);
    if (isReturn) {
        total *= 2;
    }
    return {
        adultPrice: adultPrice,
        childPrice: childPrice,
        totalPrice: total
    };
}

// ==================== AUTH ROUTES ====================
// ==================== AUTH ROUTES ====================

// ============ LOGIN ============
app.post('/api/auth/login', [
    body('email').isEmail().withMessage('Invalid email'),
    body('password').notEmpty().withMessage('Password required')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    try {
        const [rows] = await pool.execute(
            'SELECT id, email, password_hash, full_name, role, referral_code, is_active FROM users WHERE email = ?',
            [email]
        );

        if (rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const user = rows[0];

        // Cek apakah user aktif
        if (!user.is_active) {
            return res.status(401).json({ error: 'Account is deactivated' });
        }

        const isValidPassword = await bcrypt.compare(password, user.password_hash);
        if (!isValidPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Generate JWT Token
        const token = jwt.sign(
            { 
                id: user.id, 
                email: user.email, 
                role: user.role,
                full_name: user.full_name 
            },
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );

        // Response
        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                email: user.email,
                full_name: user.full_name,
                role: user.role,
                referral_code: user.referral_code
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============ REGISTER ============
app.post('/api/auth/register', [
    body('email').isEmail().withMessage('Invalid email'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('full_name').notEmpty().withMessage('Full name required'),
    body('phone').notEmpty().withMessage('Phone number required'),
    body('referral_code').optional().isString().withMessage('Invalid referral code')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }

    const { email, password, full_name, phone, referral_code } = req.body;

    try {
        // Cek email sudah terdaftar
        const [existing] = await pool.execute('SELECT id FROM users WHERE email = ?', [email]);
        if (existing.length > 0) {
            return res.status(400).json({ error: 'Email already registered' });
        }

        // Cek referral code jika ada
        let adminId = null;
        if (referral_code) {
            const [admin] = await pool.execute(
                'SELECT id FROM users WHERE referral_code = ? AND role IN ("admin", "admin_master") AND is_active = TRUE',
                [referral_code]
            );
            if (admin.length === 0) {
                return res.status(400).json({ error: 'Invalid referral code' });
            }
            adminId = admin[0].id;
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Insert user
        const [result] = await pool.execute(
            'INSERT INTO users (email, password_hash, full_name, phone, role, referral_code, is_active) VALUES (?, ?, ?, ?, ?, ?, TRUE)',
            [email, hashedPassword, full_name, phone, 'customer', null]
        );

        // Ambil user yang baru dibuat
        const [newUser] = await pool.execute(
            'SELECT id, email, full_name, role, referral_code FROM users WHERE id = ?',
            [result.insertId]
        );

        // Generate JWT Token
        const token = jwt.sign(
            { 
                id: newUser[0].id, 
                email: newUser[0].email, 
                role: newUser[0].role,
                full_name: newUser[0].full_name 
            },
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.status(201).json({
            success: true,
            message: 'Registration successful',
            token,
            user: newUser[0]
        });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============ DEVICE REGISTRATION ============
app.post('/api/devices/register', authenticateToken, async (req, res) => {
    const { userId, fcmToken, platform, deviceName, appVersion } = req.body;

    if (!userId || !fcmToken) {
        return res.status(400).json({ error: 'userId and fcmToken required' });
    }

    try {
        // UPSERT: Insert atau Update
        await pool.execute(
            `INSERT INTO user_devices (user_id, fcm_token, platform, device_name, app_version, is_active, last_active_at)
             VALUES (?, ?, ?, ?, ?, true, NOW())
             ON DUPLICATE KEY UPDATE
               platform = VALUES(platform),
               device_name = VALUES(device_name),
               app_version = VALUES(app_version),
               is_active = true,
               last_active_at = NOW()`,
            [userId, fcmToken, platform, deviceName, appVersion]
        );

        res.json({ 
            success: true, 
            message: 'Device registered successfully' 
        });
    } catch (error) {
        console.error('Error registering device:', error);
        res.status(500).json({ error: 'Failed to register device' });
    }
});

// ============ LOGOUT ============
app.post('/api/auth/logout', authenticateToken, async (req, res) => {
    const { fcmToken } = req.body;

    try {
        if (fcmToken) {
            await pool.execute(
                'UPDATE user_devices SET is_active = FALSE WHERE fcm_token = ?',
                [fcmToken]
            );
        }
        res.json({ 
            success: true, 
            message: 'Logged out successfully' 
        });
    } catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ==================== BOOKING ROUTES ====================
// ==================== BOOKING ROUTES ====================
// ==================== BOOKING ROUTES ====================
// ==================== BOOKING ROUTES ====================
app.post('/api/bookings', [
    body('customer.full_name').notEmpty().withMessage('Full name required'),
    body('customer.whatsapp').notEmpty().withMessage('WhatsApp number required'),
    body('customer.email').optional().isEmail().withMessage('Invalid email'),
    body('service_type').isIn(['transfer', 'fastboat', 'ticketboat']).withMessage('Invalid service type'),
    body('trip_type').isIn(['oneway', 'return']).withMessage('Invalid trip type'),
    body('depart_datetime').notEmpty().withMessage('Departure datetime required'),
    body('referral_code').optional().isString().withMessage('Invalid referral code')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }
    const connection = await pool.getConnection();
    await connection.beginTransaction();
    try {
        const {
            customer,
            service_type,
            trip_type,
            pickup_address,
            pickup_lat,
            pickup_lng,
            dropoff_address,
            dropoff_lat,
            dropoff_lng,
            depart_datetime,
            return_datetime,
            fb_pickup_port,
            fb_dropoff_port,
            fb_depart_date,
            fb_depart_slot,
            fb_depart_time,        // 🔥 HARUS diterima
            fb_return_date,
            fb_return_slot,
            fb_return_time,        // 🔥 HARUS diterima
            fb_nationality,
            fb_adult_count,
            fb_child_count,
            fb_price_per_person,   // 🔥 HARUS diterima
            fb_total_pax,          // 🔥 HARUS diterima
            tb_pickup_location,
            tb_dropoff_location,
            tb_ticket_type,
            tb_depart_date,
            tb_depart_time,
            tb_return_date,
            tb_return_time,
            tb_adult_count,
            tb_child_count,
            distance_km,
            duration_minutes,
            notes,
            referral_code
        } = req.body;

        // ============ 🔥 LOGGING UNTUK DEBUG ============
        console.log('📦 ====== BOOKING REQUEST ======');
        console.log('📦 service_type:', service_type);
        console.log('📦 trip_type:', trip_type);
        console.log('📦 depart_datetime:', depart_datetime);
        console.log('📦 return_datetime:', return_datetime);
        console.log('📦 fb_pickup_port:', fb_pickup_port);
        console.log('📦 fb_dropoff_port:', fb_dropoff_port);
        console.log('📦 fb_depart_date:', fb_depart_date);
        console.log('📦 fb_depart_slot:', fb_depart_slot);
        console.log('📦 fb_depart_time:', fb_depart_time);
        console.log('📦 fb_return_date:', fb_return_date);
        console.log('📦 fb_return_slot:', fb_return_slot);
        console.log('📦 fb_return_time:', fb_return_time);
        console.log('📦 fb_nationality:', fb_nationality);
        console.log('📦 fb_adult_count:', fb_adult_count);
        console.log('📦 fb_child_count:', fb_child_count);
        console.log('📦 fb_price_per_person:', fb_price_per_person);
        console.log('📦 fb_total_pax:', fb_total_pax);
        console.log('📦 referral_code:', referral_code);
        console.log('📦 ================================');

        // Check min booking time
        const departDate = new Date(depart_datetime);
        const minDate = new Date();
        minDate.setHours(minDate.getHours() + parseInt(process.env.MIN_BOOKING_HOURS || 12));
        if (departDate < minDate) {
            await connection.rollback();
            return res.status(400).json({
                error: `Booking must be at least ${process.env.MIN_BOOKING_HOURS || 12} hours before departure`
            });
        }

        // Get settings
        const [settings] = await connection.execute(
            'SELECT setting_key, setting_value FROM settings WHERE setting_key IN ("base_price", "price_per_km", "discount_percent", "commission_percent")'
        );
        const settingsMap = {};
        settings.forEach(s => settingsMap[s.setting_key] = parseFloat(s.setting_value));
        const basePrice = settingsMap.base_price || 100000;
        const pricePerKm = settingsMap.price_per_km || 4000;
        const discountPercent = settingsMap.discount_percent || 5;
        const commissionPercent = settingsMap.commission_percent || 5;

        let adminId = null;
        let discountApplied = 0;
        let commissionAmount = 0;
        let referralCodeUsed = null;

        // Check referral code
        if (referral_code) {
            const [admin] = await connection.execute(
                'SELECT id FROM users WHERE referral_code = ? AND role IN ("admin", "admin_master") AND is_active = TRUE',
                [referral_code]
            );
            if (admin.length > 0) {
                adminId = admin[0].id;
                referralCodeUsed = referral_code;
                discountApplied = discountPercent;
            }
        }

        let totalPrice = 0;
        let discountAmount = 0;
        let finalPrice = 0;
        let distanceCost = 0;
        let pricePerAdult = null;
        let pricePerChild = null;
        let portFee = null;
        let totalPax = 0;
        let childPriceValue = 0;

        // Generate booking reference with prefix
        let prefix = 'BKG';
        if (service_type === 'ticketboat') prefix = 'TKB';
        else if (service_type === 'fastboat') prefix = 'FBT';
        else if (service_type === 'transfer') prefix = 'TRF';
        const bookingRef = generateBookingReference(prefix);

        // Insert customer
        const [customerResult] = await connection.execute(
            `INSERT INTO booking_customers 
            (full_name, whatsapp, email, notes, booking_reference) 
            VALUES (?, ?, ?, ?, ?)`,
            [customer.full_name, customer.whatsapp, customer.email || null, customer.notes || null, bookingRef]
        );
        const customerId = customerResult.insertId;

        const isReturn = trip_type === 'return';

        // ============ 🔥 FIX: PERHITUNGAN HARGA ============
        if (service_type === 'fastboat') {
            // ✅ Gunakan harga dari frontend
            const pricePerPerson = parseFloat(fb_price_per_person) || 0;
            const adultCount = parseInt(fb_adult_count) || 1;
            const childCount = parseInt(fb_child_count) || 0;
            const totalPaxCount = parseInt(fb_total_pax) || (adultCount + childCount);

            // Ambil child_price dari database
            childPriceValue = 0;
            if (fb_pickup_port && fb_dropoff_port) {
                const [route] = await connection.execute(
                    'SELECT child_price FROM fastboat_routes WHERE pickup_port = ? AND dropoff_port = ? AND is_active = 1',
                    [fb_pickup_port, fb_dropoff_port]
                );
                if (route.length > 0) {
                    childPriceValue = parseFloat(route[0].child_price) || pricePerPerson * 0.5;
                } else {
                    childPriceValue = pricePerPerson * 0.5;
                }
            } else {
                childPriceValue = pricePerPerson * 0.5;
            }

            // 🔥 HITUNG TOTAL DENGAN BENAR
            let adultTotal = adultCount * pricePerPerson;
            let childTotal = childCount * childPriceValue;
            totalPrice = adultTotal + childTotal;

            if (isReturn) {
                totalPrice *= 2;
            }

            distanceCost = 0;
            discountAmount = totalPrice * (discountApplied / 100);
            finalPrice = totalPrice - discountAmount;
            commissionAmount = finalPrice * (commissionPercent / 100);
            pricePerAdult = pricePerPerson;
            pricePerChild = childPriceValue;
            totalPax = totalPaxCount;

            console.log('💰 Fastboat Price Calculation:', {
                pricePerPerson,
                childPriceValue,
                adultCount,
                childCount,
                totalPax,
                isReturn,
                totalPrice,
                finalPrice,
                discountAmount,
                commissionAmount
            });

        } else if (service_type === 'ticketboat') {
            // ============ TICKET BOAT ============
            if (!tb_pickup_location || !tb_dropoff_location || !tb_ticket_type) {
                await connection.rollback();
                return res.status(400).json({ error: 'Missing required fields for ticket boat' });
            }
            const [route] = await connection.execute(
                'SELECT base_price, port_fee, child_price FROM ticket_boat_routes WHERE pickup_location = ? AND dropoff_location = ? AND is_active = 1',
                [tb_pickup_location, tb_dropoff_location]
            );
            if (route.length === 0) {
                await connection.rollback();
                return res.status(400).json({ error: 'Invalid route for ticket boat' });
            }
            const [ticketType] = await connection.execute(
                'SELECT price FROM ticket_boat_types WHERE code = ? AND is_active = 1',
                [tb_ticket_type]
            );
            if (ticketType.length === 0) {
                await connection.rollback();
                return res.status(400).json({ error: 'Invalid ticket type' });
            }
            const adultCount = parseInt(tb_adult_count) || 1;
            const childCount = parseInt(tb_child_count) || 0;
            const priceCalc = calculateTbPrice(route[0], ticketType[0], adultCount, childCount, isReturn);
            totalPrice = priceCalc.totalPrice;
            distanceCost = 0;
            discountAmount = totalPrice * (discountApplied / 100);
            finalPrice = totalPrice - discountAmount;
            commissionAmount = finalPrice * (commissionPercent / 100);
            pricePerAdult = ticketType[0].price;
            pricePerChild = route[0].child_price;
            portFee = route[0].port_fee;
            totalPax = adultCount + childCount;

        } else {
            // ============ TRANSFER ============
            const priceCalc = calculatePrice(basePrice, distance_km, pricePerKm, isReturn, discountApplied);
            totalPrice = priceCalc.totalPrice;
            distanceCost = distance_km ? distance_km * pricePerKm : 0;
            discountAmount = priceCalc.discountAmount;
            finalPrice = priceCalc.finalPrice;
            commissionAmount = finalPrice * (commissionPercent / 100);
        }

        // ============ 🔥 INSERT BOOKING LENGKAP ============
        const [bookingResult] = await connection.execute(
            `INSERT INTO bookings (
                booking_reference, customer_id, service_type, trip_type,
                pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng,
                distance_km, duration_minutes,
                fb_pickup_port, fb_dropoff_port, fb_depart_date, fb_depart_slot, fb_depart_time,
                fb_return_date, fb_return_slot, fb_return_time,
                fb_nationality, fb_adult_count, fb_child_count,
                tb_pickup_location, tb_dropoff_location, tb_ticket_type,
                tb_depart_date, tb_depart_time, tb_return_date, tb_return_time,
                tb_adult_count, tb_child_count,
                tb_price_per_adult, tb_price_per_child, tb_port_fee, tb_total_pax,
                depart_datetime, return_datetime,
                base_price, distance_cost, total_price, discount_percent, discount_amount,
                final_price, referral_code_used, admin_id, admin_commission, notes
            ) VALUES (
                ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?,
                ?, ?,
                ?, ?, ?, ?, ?,
                ?, ?, ?,
                ?, ?, ?,
                ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?,
                ?, ?, ?, ?,
                ?, ?,
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?
            )`,
            [
                // 1-4: booking_reference, customer_id, service_type, trip_type
                bookingRef, customerId, service_type, trip_type,

                // 5-10: pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng
                pickup_address || null,
                pickup_lat || null,
                pickup_lng || null,
                dropoff_address || null,
                dropoff_lat || null,
                dropoff_lng || null,

                // 11-12: distance_km, duration_minutes
                distance_km || null,
                duration_minutes || null,

                // 13-17: fb_pickup_port, fb_dropoff_port, fb_depart_date, fb_depart_slot, fb_depart_time
                fb_pickup_port || null,
                fb_dropoff_port || null,
                fb_depart_date || null,
                fb_depart_slot || null,
                fb_depart_time || null,  // 🔥 SAVE DEPARTURE TIME

                // 18-20: fb_return_date, fb_return_slot, fb_return_time
                fb_return_date || null,
                fb_return_slot || null,
                fb_return_time || null,  // 🔥 SAVE RETURN TIME

                // 21-23: fb_nationality, fb_adult_count, fb_child_count
                fb_nationality || null,
                fb_adult_count || null,
                fb_child_count || null,

                // 24-26: tb_pickup_location, tb_dropoff_location, tb_ticket_type
                tb_pickup_location || null,
                tb_dropoff_location || null,
                tb_ticket_type || null,

                // 27-30: tb_depart_date, tb_depart_time, tb_return_date, tb_return_time
                tb_depart_date || null,
                tb_depart_time || null,
                tb_return_date || null,
                tb_return_time || null,

                // 31-32: tb_adult_count, tb_child_count
                tb_adult_count || null,
                tb_child_count || null,

                // 33-36: tb_price_per_adult, tb_price_per_child, tb_port_fee, tb_total_pax
                pricePerAdult || null,
                pricePerChild || null,
                portFee || null,
                totalPax || 0,

                // 37-38: depart_datetime, return_datetime
                depart_datetime || null,
                return_datetime || null,

                // 39-43: base_price, distance_cost, total_price, discount_percent, discount_amount
                basePrice,
                distanceCost || 0,
                totalPrice,
                discountApplied,
                discountAmount,

                // 44-48: final_price, referral_code_used, admin_id, admin_commission, notes
                finalPrice,
                referralCodeUsed,
                adminId,
                commissionAmount,
                notes || null
            ]
        );
        const bookingId = bookingResult.insertId;

        // Referral usage (pending)
        if (adminId && referral_code) {
            await connection.execute(
                `INSERT INTO referral_usage 
                (booking_id, admin_id, referral_code, discount_percent, commission_percent,
                discount_amount, commission_amount, commission_status) 
                VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
                [bookingId, adminId, referral_code, discountPercent, commissionPercent,
                discountAmount, commissionAmount]
            );
        }

        // Booking history
        await connection.execute(
            `INSERT INTO booking_histories (booking_id, status_from, status_to, notes) 
            VALUES (?, NULL, 'pending', 'Booking created')`,
            [bookingId]
        );

        await connection.commit();

        // ============ 🔔 SEND NOTIFICATION KE ADMIN ============
        try {
            const [adminUsers] = await pool.execute(
                `SELECT id, full_name FROM users WHERE role IN ('admin', 'admin_master') AND is_active = TRUE`
            );

            if (adminUsers.length > 0) {
                await Promise.all(adminUsers.map(admin =>
                    sendNotificationToUser(
                        admin.id,
                        '📦 Pesanan Baru!',
                        `Pesanan ${bookingRef} oleh ${customer.full_name}`,
                        {
                            type: 'new_booking',
                            booking_reference: String(bookingRef),
                            booking_id: String(bookingId),
                            customer_name: String(customer.full_name),
                            service_type: String(service_type),
                            via_referral: String((referralCodeUsed && admin.id === adminId) ? 'true' : 'false'),
                            timestamp: String(new Date().toISOString())
                        }
                    ).catch(err => console.error(`❌ Failed to notify admin ${admin.id} (${admin.full_name}):`, err))
                ));
                console.log(`📨 Booking notification sent to ${adminUsers.length} admin(s)`);
            }
        } catch (notifErr) {
            console.error('❌ Failed to fetch/notify admin list:', notifErr);
        }

        // ============ ✅ RESPONSE ============
        console.log(`✅ Booking ${bookingRef} created successfully`);
        console.log(`💰 Total: ${formatRupiah(totalPrice)}, Final: ${formatRupiah(finalPrice)}`);

        res.status(201).json({
            success: true,
            booking: {
                reference: bookingRef,
                customer_id: customerId,
                booking_id: bookingId,
                service_type: service_type,
                total_price: totalPrice,
                discount_applied: discountApplied,
                discount_amount: discountAmount,
                final_price: finalPrice,
                admin_commission: commissionAmount,
                referral_code_used: referralCodeUsed,
                status: 'pending',
                commission_status: 'pending'
            }
        });
    } catch (error) {
        await connection.rollback();
        console.error('❌ Booking error:', error);
        res.status(500).json({
            error: 'Failed to create booking',
            message: error.message,
            sql: error.sql,
            sqlMessage: error.sqlMessage
        });
    } finally {
        connection.release();
    }
});
// ============ GET BOOKING BY REFERENCE (PUBLIC) ============
app.get('/api/bookings/:reference', async (req, res) => {
    const { reference } = req.params;
    try {
        const [bookings] = await pool.execute(
            `SELECT b.*, 
                    c.full_name as customer_name, 
                    c.whatsapp as customer_phone, 
                    c.email as customer_email, 
                    u.full_name as admin_name,
                    -- ✅ Format depart datetime dengan jam
                    CONCAT(DATE_FORMAT(b.tb_depart_date, '%d/%m/%Y'), ' ', TIME_FORMAT(b.tb_depart_time, '%H:%i')) as tb_depart_datetime_formatted,
                    -- ✅ Format return datetime dengan jam
                    CONCAT(DATE_FORMAT(b.tb_return_date, '%d/%m/%Y'), ' ', TIME_FORMAT(b.tb_return_time, '%H:%i')) as tb_return_datetime_formatted,
                    -- Format transfer/fastboat datetime
                    DATE_FORMAT(b.depart_datetime, '%d/%m/%Y %H:%i') as depart_datetime_formatted,
                    DATE_FORMAT(b.return_datetime, '%d/%m/%Y %H:%i') as return_datetime_formatted
            FROM bookings b
            LEFT JOIN booking_customers c ON b.customer_id = c.id
            LEFT JOIN users u ON b.admin_id = u.id
            WHERE b.booking_reference = ?`,
            [reference]
        );
        if (bookings.length === 0) {
            return res.status(404).json({ error: 'Booking not found' });
        }
        res.json(bookings[0]);
    } catch (error) {
        console.error('Get booking error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ==================== TICKET BOAT PUBLIC ROUTES ====================
app.get('/api/ticket-boat/routes', async (req, res) => {
    try {
        const routes = await getTicketBoatRoutes();
        res.json({ routes });
    } catch (error) {
        console.error('Get ticket boat routes error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/ticket-boat/types', async (req, res) => {
    try {
        const types = await getTicketBoatTypes();
        res.json({ types });
    } catch (error) {
        console.error('Get ticket boat types error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/ticket-boat/price', [
    body('pickup').notEmpty().withMessage('Pickup location required'),
    body('dropoff').notEmpty().withMessage('Dropoff location required'),
    body('ticket_type').notEmpty().withMessage('Ticket type required'),
    body('adult_count').optional().isInt({ min: 1 }),
    body('child_count').optional().isInt({ min: 0 }),
    body('is_return').optional().isBoolean()
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }
    try {
        const { pickup, dropoff, ticket_type, adult_count = 1, child_count = 0, is_return = false } = req.query;
        const route = await getTicketBoatPrice(pickup, dropoff);
        if (!route) {
            return res.status(404).json({ error: 'Route not found' });
        }
        const [types] = await pool.execute(
            'SELECT * FROM ticket_boat_types WHERE code = ? AND is_active = 1',
            [ticket_type]
        );
        if (types.length === 0) {
            return res.status(404).json({ error: 'Ticket type not found' });
        }
        const adultCount = parseInt(adult_count) || 1;
        const childCount = parseInt(child_count) || 0;
        const isReturn = is_return === 'true' || is_return === true;
        const priceCalc = calculateTbPrice(route, types[0], adultCount, childCount, isReturn);
        res.json({
            route: {
                pickup: pickup,
                dropoff: dropoff,
                base_price: route.base_price,
                port_fee: route.port_fee,
                child_price: route.child_price
            },
            ticket_type: types[0],
            adult_count: adultCount,
            child_count: childCount,
            is_return: isReturn,
            price_per_adult: priceCalc.adultPrice,
            price_per_child: priceCalc.childPrice,
            total_price: priceCalc.totalPrice,
            currency: 'IDR'
        });
    } catch (error) {
        console.error('Get ticket boat price error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/ticket-boat/availability', [
    body('pickup').notEmpty().withMessage('Pickup location required'),
    body('dropoff').notEmpty().withMessage('Dropoff location required'),
    body('depart_date').notEmpty().withMessage('Depart date required')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }
    try {
        const { pickup, dropoff, depart_date } = req.query;
        const route = await getTicketBoatPrice(pickup, dropoff);
        if (!route) {
            return res.status(404).json({
                available: false,
                message: 'Route not available'
            });
        }
        const departDate = new Date(depart_date);
        const minDate = new Date();
        minDate.setHours(minDate.getHours() + parseInt(process.env.MIN_BOOKING_HOURS || 12));
        if (departDate < minDate) {
            return res.json({
                available: false,
                message: `Booking must be at least ${process.env.MIN_BOOKING_HOURS || 12} hours before departure`,
                min_date: minDate.toISOString().split('T')[0]
            });
        }
        res.json({
            available: true,
            message: 'Route available',
            route: {
                pickup: pickup,
                dropoff: dropoff,
                base_price: route.base_price,
                port_fee: route.port_fee,
                child_price: route.child_price
            }
        });
    } catch (error) {
        console.error('Get ticket boat availability error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ==================== ADMIN ROUTES ====================
// ============ GET ALL BOOKINGS (ADMIN) ============
app.get('/api/admin/bookings', authenticateAdmin, async (req, res) => {
    const { status, service_type, limit = 50, offset = 0 } = req.query;
    try {
        const limitInt = parseInt(limit) || 50;
        const offsetInt = parseInt(offset) || 0;
        const validStatuses = ['pending', 'confirmed', 'completed', 'cancelled'];
        const validServiceTypes = ['transfer', 'fastboat', 'ticketboat'];
        const sanitizedStatus = status && validStatuses.includes(status) ? status : null;
        const sanitizedServiceType = service_type && validServiceTypes.includes(service_type) ? service_type : null;
        
        let sql = `
            SELECT b.*, 
                   c.full_name as customer_name, 
                   c.whatsapp as customer_phone,
                   u.full_name as admin_name,
                   tt.name as ticket_type_name,
                   -- ✅ Format depart datetime dengan jam
                   CONCAT(DATE_FORMAT(b.tb_depart_date, '%d/%m/%Y'), ' ', TIME_FORMAT(b.tb_depart_time, '%H:%i')) as tb_depart_datetime_formatted,
                   -- ✅ Format return datetime dengan jam
                   CONCAT(DATE_FORMAT(b.tb_return_date, '%d/%m/%Y'), ' ', TIME_FORMAT(b.tb_return_time, '%H:%i')) as tb_return_datetime_formatted
            FROM bookings b
            LEFT JOIN booking_customers c ON b.customer_id = c.id
            LEFT JOIN users u ON b.admin_id = u.id
            LEFT JOIN ticket_boat_types tt ON b.tb_ticket_type = tt.code
            WHERE 1=1
        `;

        if (sanitizedStatus) {
            sql += ` AND b.status = '${sanitizedStatus}'`;
        }
        if (sanitizedServiceType) {
            sql += ` AND b.service_type = '${sanitizedServiceType}'`;
        }

        sql += ` ORDER BY b.created_at DESC LIMIT ${limitInt} OFFSET ${offsetInt}`;

        const [bookings] = await pool.query(sql);

        let countSql = 'SELECT COUNT(*) as total FROM bookings WHERE 1=1';
        if (sanitizedStatus) {
            countSql += ` AND status = '${sanitizedStatus}'`;
        }
        if (sanitizedServiceType) {
            countSql += ` AND service_type = '${sanitizedServiceType}'`;
        }

        const [countResult] = await pool.query(countSql);

        res.json({
            bookings,
            pagination: {
                total: countResult[0].total,
                limit: limitInt,
                offset: offsetInt
            }
        });
    } catch (error) {
        console.error('Get bookings error:', error);
        res.status(500).json({
            error: 'Internal server error',
            message: error.message
        });
    }
});

// ============ GET BOOKING DETAIL (ADMIN) ============
app.get('/api/admin/bookings/:id', authenticateAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const [bookings] = await pool.query(
            `SELECT b.*, 
                    c.full_name as customer_name, 
                    c.whatsapp as customer_phone,
                    c.email as customer_email, 
                    u.full_name as admin_name,
                    tt.name as ticket_type_name,
                    -- ✅ Format depart datetime dengan jam
                    CONCAT(DATE_FORMAT(b.tb_depart_date, '%d/%m/%Y'), ' ', TIME_FORMAT(b.tb_depart_time, '%H:%i')) as tb_depart_datetime_formatted,
                    -- ✅ Format return datetime dengan jam
                    CONCAT(DATE_FORMAT(b.tb_return_date, '%d/%m/%Y'), ' ', TIME_FORMAT(b.tb_return_time, '%H:%i')) as tb_return_datetime_formatted,
                    -- Format transfer/fastboat datetime
                    DATE_FORMAT(b.depart_datetime, '%d/%m/%Y %H:%i') as depart_datetime_formatted,
                    DATE_FORMAT(b.return_datetime, '%d/%m/%Y %H:%i') as return_datetime_formatted
            FROM bookings b
            LEFT JOIN booking_customers c ON b.customer_id = c.id
            LEFT JOIN users u ON b.admin_id = u.id
            LEFT JOIN ticket_boat_types tt ON b.tb_ticket_type = tt.code
            WHERE b.id = ?`,
            [id]
        );
        if (bookings.length === 0) {
            return res.status(404).json({ error: 'Booking not found' });
        }
        res.json(bookings[0]);
    } catch (error) {
        console.error('Get booking detail error:', error);
        res.status(500).json({
            error: 'Internal server error',
            message: error.message
        });
    }
});

// ============ UPDATE BOOKING STATUS ============
app.patch('/api/admin/bookings/:id/status', authenticateAdmin, [
    body('status').isIn(['pending', 'confirmed', 'completed', 'cancelled']).withMessage('Invalid status')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }
    const { id } = req.params;
    const { status, notes } = req.body;
    const connection = await pool.getConnection();
    await connection.beginTransaction();

    // FIX: flag & data dikumpulkan dulu di dalam transaksi,
    // notifikasi baru benar-benar dikirim SETELAH commit (lihat di bawah)
    let commissionStatus = 'pending';
    let commissionMessage = '';
    let oldStatus = null;
    let bookingData = null;

    try {
        const [booking] = await connection.query(
            `SELECT b.*, c.full_name as customer_name, c.whatsapp as customer_phone, c.email as customer_email
            FROM bookings b
            LEFT JOIN booking_customers c ON b.customer_id = c.id
            WHERE b.id = ?`,
            [id]
        );
        if (booking.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Booking not found' });
        }
        oldStatus = booking[0].status;
        bookingData = booking[0];

        await connection.query(
            'UPDATE bookings SET status = ?, updated_at = NOW() WHERE id = ?',
            [status, id]
        );

        // ============ LOGIKA KOMISI (tetap di dalam transaksi) ============
        if (status === 'completed' && oldStatus !== 'completed') {
            const [referral] = await connection.query(
                `SELECT id, commission_amount, commission_status 
                FROM referral_usage 
                WHERE booking_id = ? AND commission_status = 'pending'`,
                [id]
            );
            if (referral.length > 0) {
                const referralData = referral[0];
                await connection.query(
                    `UPDATE referral_usage 
                    SET commission_status = 'completed', 
                        commission_paid_at = NOW()
                    WHERE id = ?`,
                    [referralData.id]
                );
                if (bookingData.admin_id) {
                    await connection.query(
                        `INSERT INTO admin_commissions 
                        (admin_id, total_commission, total_orders, last_updated) 
                        VALUES (?, ?, 1, NOW())
                        ON DUPLICATE KEY UPDATE 
                        total_commission = total_commission + VALUES(total_commission),
                        total_orders = total_orders + 1,
                        last_updated = NOW()`,
                        [bookingData.admin_id, referralData.commission_amount]
                    );
                }
                commissionStatus = 'completed';
                commissionMessage = `Commission paid: ${formatRupiah(referralData.commission_amount)}`;
            }
        }
        if (status === 'cancelled') {
            const [referral] = await connection.query(
                `SELECT id, commission_status 
                FROM referral_usage 
                WHERE booking_id = ? AND commission_status = 'pending'`,
                [id]
            );
            if (referral.length > 0) {
                await connection.query(
                    `UPDATE referral_usage 
                    SET commission_status = 'cancelled' 
                    WHERE id = ?`,
                    [referral[0].id]
                );
                commissionStatus = 'cancelled';
                commissionMessage = 'Commission cancelled';
            }
        }

        await connection.query(
            `INSERT INTO booking_histories (booking_id, status_from, status_to, changed_by, notes)
            VALUES (?, ?, ?, ?, ?)`,
            [id, oldStatus, status, req.user.id, notes || commissionMessage || null]
        );

        await connection.commit();

        // ============ 🔔 NOTIFICATION & EMAIL (setelah commit, tidak boleh gagalkan transaksi) ============
        let notificationSent = false;
        let emailSent = false;
        let pdfGenerated = false;
        let paymentEmailSent = false; // 🔥 Tambahkan flag untuk payment email

        try {
            // FIX: ambil SEMUA admin & admin_master aktif, broadcast ke semua,
            // bukan cuma bookingData.admin_id (yang cuma ada kalau pakai referral code)
            const [adminUsers] = await pool.execute(
                `SELECT id, full_name FROM users WHERE role IN ('admin', 'admin_master') AND is_active = TRUE`
            );

            let title = null;
            let body = null;
            let notifType = null;

            if (status === 'confirmed' && oldStatus !== 'confirmed') {
                title = '📋 Pesanan Dikonfirmasi';
                body = `Pesanan ${bookingData.booking_reference} telah dikonfirmasi.`;
                notifType = 'booking_confirmed';

                // ============ 🔥 KIRIM EMAIL INSTRUKSI PEMBAYARAN KETIKA CONFIRMED ============
                if (bookingData.customer_email) {
                    try {
                        // Format tanggal untuk email
                        let departDateFormatted = bookingData.depart_datetime;
                        if (bookingData.tb_depart_date && bookingData.tb_depart_time) {
                            departDateFormatted = `${bookingData.tb_depart_date} ${bookingData.tb_depart_time}`;
                        }

                        await sendPaymentInstruction(bookingData.customer_email, {
                            booking_reference: bookingData.booking_reference,
                            customer_name: bookingData.customer_name || 'Customer',
                            total_price: bookingData.total_price,
                            final_price: bookingData.final_price,
                            discount_amount: bookingData.discount_amount || 0,
                            service_type: bookingData.service_type,
                            depart_datetime: departDateFormatted,
                            pickup_address: bookingData.pickup_address,
                            dropoff_address: bookingData.dropoff_address,
                            payment_deadline: '24 jam setelah konfirmasi'
                        });
                        paymentEmailSent = true;
                        console.log(`📧 Payment instruction email sent to ${bookingData.customer_email} for booking ${bookingData.booking_reference}`);
                    } catch (emailErr) {
                        console.error('❌ Failed to send payment instruction email:', emailErr);
                    }
                }

            } else if (status === 'completed' && oldStatus !== 'completed') {
                title = '✅ Pesanan Selesai!';
                body = `Pesanan ${bookingData.booking_reference} telah selesai.`;
                notifType = 'booking_completed';
            } else if (status === 'cancelled' && oldStatus !== 'cancelled') {
                title = '❌ Pesanan Dibatalkan';
                body = `Pesanan ${bookingData.booking_reference} telah dibatalkan.`;
                notifType = 'booking_cancelled';

                // ============ 🔥 OPSIONAL: KIRIM EMAIL PEMBATALAN ============
                if (bookingData.customer_email) {
                    try {
                        // Bisa tambahkan fungsi sendCancellationEmail() jika diperlukan
                        console.log(`📧 Cancellation notification would be sent to ${bookingData.customer_email}`);
                    } catch (emailErr) {
                        console.error('❌ Failed to send cancellation email:', emailErr);
                    }
                }

            } else if (status === 'pending' && oldStatus !== 'pending') {
                title = '↩️ Pesanan Dikembalikan ke Pending';
                body = `Pesanan ${bookingData.booking_reference} diubah kembali ke pending.`;
                notifType = 'booking_pending';
            }

            // Kirim notifikasi ke admin
            if (title && adminUsers.length > 0) {
                await Promise.all(adminUsers.map(admin =>
                    sendNotificationToUser(
                        admin.id,
                        title,
                        body,
                        {
                            type: notifType,
                            booking_reference: bookingData.booking_reference,
                            booking_id: id.toString(),
                            customer_name: bookingData.customer_name || 'Customer',
                            service_type: bookingData.service_type,
                            old_status: oldStatus,
                            new_status: status,
                            timestamp: new Date().toISOString()
                        }
                    ).catch(err => console.error(`❌ Failed to notify admin ${admin.id} (${admin.full_name}):`, err))
                ));
                notificationSent = true;
            }
        } catch (notifErr) {
            console.error('❌ Failed to fetch/notify admin list:', notifErr);
        }

        // ============ EMAIL INVOICE PDF KETIKA COMPLETED ============
        if (status === 'completed' && oldStatus !== 'completed' && bookingData.customer_email) {
            try {
                const pdfBuffer = await generateInvoicePDF(bookingData);
                pdfGenerated = true;
                await sendInvoiceWithPDF(bookingData.customer_email, bookingData, pdfBuffer);
                emailSent = true;
                console.log(`📧 Invoice PDF sent to ${bookingData.customer_email} for booking ${bookingData.booking_reference}`);
            } catch (pdfError) {
                console.error('❌ Error generating/sending PDF:', pdfError);
            }
        }

        // ============ RESPONSE ============
        res.json({
            message: 'Booking status updated successfully',
            booking_id: id,
            old_status: oldStatus,
            new_status: status,
            commission_status: commissionStatus,
            commission_message: commissionMessage,
            notification_sent: notificationSent,
            email_sent: emailSent,           // Invoice PDF (completed)
            pdf_generated: pdfGenerated,
            payment_email_sent: paymentEmailSent // 🔥 Payment instruction (confirmed)
        });

    } catch (error) {
        await connection.rollback();
        console.error('Update booking status error:', error);
        res.status(500).json({
            error: 'Internal server error',
            message: error.message
        });
    } finally {
        connection.release();
    }
});

// ==================== ADMIN TICKET BOAT ROUTES ====================
app.post('/api/admin/ticket-boat/routes', authenticateAdmin, [
    body('pickup_location').notEmpty().withMessage('Pickup location required'),
    body('dropoff_location').notEmpty().withMessage('Dropoff location required'),
    body('base_price').isNumeric().withMessage('Base price must be a number')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }
    const { pickup_location, dropoff_location, base_price, port_fee, child_price } = req.body;
    try {
        const [existing] = await pool.execute(
            'SELECT id FROM ticket_boat_routes WHERE pickup_location = ? AND dropoff_location = ?',
            [pickup_location, dropoff_location]
        );
        if (existing.length > 0) {
            return res.status(400).json({ error: 'Route already exists' });
        }
        const [result] = await pool.execute(
            `INSERT INTO ticket_boat_routes 
            (pickup_location, dropoff_location, base_price, port_fee, child_price) 
            VALUES (?, ?, ?, ?, ?)`,
            [pickup_location, dropoff_location, base_price, port_fee || 15000, child_price || 200000]
        );
        res.status(201).json({
            message: 'Route created successfully',
            route_id: result.insertId
        });
    } catch (error) {
        console.error('Create ticket boat route error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/api/admin/ticket-boat/routes/:id', authenticateAdmin, [
    body('base_price').optional().isNumeric(),
    body('port_fee').optional().isNumeric(),
    body('child_price').optional().isNumeric(),
    body('is_active').optional().isBoolean()
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }
    const { id } = req.params;
    const { base_price, port_fee, child_price, is_active } = req.body;
    try {
        const updates = [];
        const values = [];
        if (base_price !== undefined) { updates.push('base_price = ?'); values.push(base_price); }
        if (port_fee !== undefined) { updates.push('port_fee = ?'); values.push(port_fee); }
        if (child_price !== undefined) { updates.push('child_price = ?'); values.push(child_price); }
        if (is_active !== undefined) { updates.push('is_active = ?'); values.push(is_active ? 1 : 0); }
        if (updates.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }
        values.push(id);
        await pool.execute(
            `UPDATE ticket_boat_routes SET ${updates.join(', ')} WHERE id = ?`,
            values
        );
        res.json({ message: 'Route updated successfully' });
    } catch (error) {
        console.error('Update ticket boat route error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/admin/ticket-boat/routes', authenticateAdmin, async (req, res) => {
    try {
        const [routes] = await pool.execute(
            'SELECT * FROM ticket_boat_routes ORDER BY pickup_location, dropoff_location'
        );
        res.json({ routes });
    } catch (error) {
        console.error('Get ticket boat routes error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/api/admin/ticket-boat/routes/:id', authenticateAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const [result] = await pool.execute(
            'DELETE FROM ticket_boat_routes WHERE id = ?',
            [id]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Route not found' });
        }
        res.json({ message: 'Route deleted successfully' });
    } catch (error) {
        console.error('Delete ticket boat route error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ==================== MASTER ADMIN ROUTES ====================
app.post('/api/master/admins', authenticateMasterAdmin, [
    body('email').isEmail().withMessage('Invalid email'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('full_name').notEmpty().withMessage('Full name required'),
    body('phone').notEmpty().withMessage('Phone required')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }
    const { email, password, full_name, phone } = req.body;
    try {
        const [existing] = await pool.execute('SELECT id FROM users WHERE email = ?', [email]);
        if (existing.length > 0) {
            return res.status(400).json({ error: 'Email already registered' });
        }
        let referralCode = generateReferralCode();
        let unique = false;
        while (!unique) {
            const [existingCode] = await pool.execute('SELECT id FROM users WHERE referral_code = ?', [referralCode]);
            if (existingCode.length === 0) {
                unique = true;
            } else {
                referralCode = generateReferralCode();
            }
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        const [result] = await pool.execute(
            `INSERT INTO users (email, password_hash, full_name, phone, role, referral_code, is_active)
            VALUES (?, ?, ?, ?, 'admin', ?, TRUE)`,
            [email, hashedPassword, full_name, phone, referralCode]
        );
        await pool.execute(
            'INSERT INTO admin_commissions (admin_id) VALUES (?)',
            [result.insertId]
        );
        res.status(201).json({
            message: 'Admin created successfully',
            admin: {
                id: result.insertId,
                email,
                full_name,
                phone,
                referral_code: referralCode
            }
        });
    } catch (error) {
        console.error('Create admin error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/master/admins', authenticateMasterAdmin, async (req, res) => {
    try {
        const [admins] = await pool.execute(
            `SELECT u.id, u.email, u.full_name, u.phone, u.referral_code, u.is_active, u.created_at,
                    ac.total_commission, ac.total_orders
            FROM users u
            LEFT JOIN admin_commissions ac ON u.id = ac.admin_id
            WHERE u.role IN ('admin', 'admin_master')
            ORDER BY u.created_at DESC`
        );
        res.json(admins);
    } catch (error) {
        console.error('Get admins error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.patch('/api/master/admins/:id/toggle', authenticateMasterAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const [admin] = await pool.execute(
            'SELECT id, role FROM users WHERE id = ? AND role = "admin"',
            [id]
        );
        if (admin.length === 0) {
            return res.status(404).json({ error: 'Admin not found' });
        }
        await pool.execute(
            'UPDATE users SET is_active = NOT is_active WHERE id = ?',
            [id]
        );
        const [updated] = await pool.execute('SELECT is_active FROM users WHERE id = ?', [id]);
        res.json({
            message: `Admin ${updated[0].is_active ? 'activated' : 'deactivated'} successfully`,
            is_active: updated[0].is_active === 1
        });
    } catch (error) {
        console.error('Toggle admin error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ==================== PUBLIC ROUTES ====================
app.get('/api/verify-referral/:code', async (req, res) => {
    const { code } = req.params;
    try {
        const [admin] = await pool.execute(
            'SELECT id, full_name, referral_code FROM users WHERE referral_code = ? AND role IN ("admin", "admin_master") AND is_active = TRUE',
            [code]
        );
        if (admin.length === 0) {
            return res.status(404).json({ valid: false, message: 'Invalid referral code' });
        }
        res.json({
            valid: true,
            admin: {
                id: admin[0].id,
                full_name: admin[0].full_name,
                referral_code: admin[0].referral_code
            },
            discount_percent: 5
        });
    } catch (error) {
        console.error('Verify referral error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/settings', async (req, res) => {
    try {
        const [settings] = await pool.execute('SELECT setting_key, setting_value FROM settings');
        const settingsMap = {};
        settings.forEach(s => settingsMap[s.setting_key] = s.setting_value);
        res.json(settingsMap);
    } catch (error) {
        console.error('Get settings error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ==================== ADMIN DASHBOARD ====================
app.get('/api/admin/dashboard', authenticateAdmin, async (req, res) => {
    try {
        const [totalBookings] = await pool.execute('SELECT COUNT(*) as total FROM bookings');
        const [statusStats] = await pool.execute(
            `SELECT status, COUNT(*) as count FROM bookings GROUP BY status`
        );
        const [todayBookings] = await pool.execute(
            `SELECT COUNT(*) as count FROM bookings WHERE DATE(created_at) = CURDATE()`
        );
        const [revenue] = await pool.execute(
            `SELECT 
                SUM(final_price) as total_revenue,
                SUM(final_price) - SUM(discount_amount) as gross_revenue,
                SUM(discount_amount) as total_discounts,
                SUM(admin_commission) as total_commissions
            FROM bookings WHERE status IN ('confirmed', 'completed')`
        );
        const [serviceTypeStats] = await pool.execute(
            `SELECT service_type, COUNT(*) as count FROM bookings GROUP BY service_type`
        );
        let adminBookings = null;
        if (req.user.role !== 'admin_master') {
            const [adminStats] = await pool.execute(
                `SELECT COUNT(*) as count, SUM(final_price) as revenue
                FROM bookings WHERE admin_id = ? AND status IN ('confirmed', 'completed')`,
                [req.user.id]
            );
            adminBookings = adminStats[0];
        }
        const [recentBookings] = await pool.execute(
            `SELECT b.id, b.booking_reference, b.service_type, b.status, b.total_price, b.final_price,
                    b.created_at, c.full_name as customer_name
            FROM bookings b
            LEFT JOIN booking_customers c ON b.customer_id = c.id
            ORDER BY b.created_at DESC LIMIT 5`
        );
        res.json({
            total_bookings: totalBookings[0].total,
            status_stats: statusStats,
            today_bookings: todayBookings[0].count,
            revenue: revenue[0] || { total_revenue: 0, gross_revenue: 0, total_discounts: 0, total_commissions: 0 },
            service_type_stats: serviceTypeStats,
            recent_bookings: recentBookings,
            admin_stats: adminBookings,
            user: {
                id: req.user.id,
                full_name: req.user.full_name,
                role: req.user.role
            }
        });
    } catch (error) {
        console.error('Dashboard error:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

// ==================== ADMIN REFERRAL ROUTES ====================
app.get('/api/admin/referrals', authenticateAdmin, async (req, res) => {
    const { status, service_type, limit = 50, offset = 0 } = req.query;
    try {
        const limitInt = parseInt(limit) || 50;
        const offsetInt = parseInt(offset) || 0;
        const validCommissionStatus = ['pending', 'completed', 'cancelled'];
        const sanitizedStatus = status && validCommissionStatus.includes(status) ? status : null;
        const validServiceTypes = ['transfer', 'fastboat', 'ticketboat'];
        const sanitizedServiceType = service_type && validServiceTypes.includes(service_type) ? service_type : null;
        let query = `
            SELECT 
                ru.id,
                ru.booking_id,
                ru.admin_id,
                ru.referral_code,
                ru.discount_percent,
                ru.commission_percent,
                ru.discount_amount,
                ru.commission_amount,
                ru.commission_status,
                ru.commission_paid_at,
                ru.used_at,
                b.booking_reference,
                b.final_price,
                b.status as booking_status,
                b.service_type,
                b.created_at as booking_created_at,
                c.full_name as customer_name,
                c.whatsapp as customer_phone,
                c.email as customer_email,
                u.full_name as admin_name,
                u.email as admin_email,
                u.phone as admin_phone
            FROM referral_usage ru
            LEFT JOIN bookings b ON ru.booking_id = b.id
            LEFT JOIN booking_customers c ON b.customer_id = c.id
            LEFT JOIN users u ON ru.admin_id = u.id
            WHERE 1=1
        `;
        let params = [];
        if (sanitizedStatus) {
            query += ` AND ru.commission_status = ?`;
            params.push(sanitizedStatus);
        }
        if (sanitizedServiceType) {
            query += ` AND b.service_type = ?`;
            params.push(sanitizedServiceType);
        }
        if (req.user.role !== 'admin_master') {
            query += ` AND ru.admin_id = ?`;
            params.push(req.user.id);
        }
        query += ` ORDER BY ru.used_at DESC LIMIT ${limitInt} OFFSET ${offsetInt}`;
        const [referrals] = await pool.query(query, params);
        let summaryQuery = `
            SELECT 
                COUNT(*) as total_referrals,
                SUM(CASE WHEN commission_status = 'pending' THEN 1 ELSE 0 END) as pending,
                SUM(CASE WHEN commission_status = 'completed' THEN 1 ELSE 0 END) as completed,
                SUM(CASE WHEN commission_status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
                SUM(CASE WHEN commission_status = 'completed' THEN commission_amount ELSE 0 END) as total_paid_commission
            FROM referral_usage ru
            WHERE 1=1
        `;
        let summaryParams = [];
        if (req.user.role !== 'admin_master') {
            summaryQuery += ` AND ru.admin_id = ?`;
            summaryParams.push(req.user.id);
        }
        const [summary] = await pool.query(summaryQuery, summaryParams);
        res.json({
            referrals: referrals,
            summary: {
                total: summary[0]?.total_referrals || 0,
                pending: summary[0]?.pending || 0,
                completed: summary[0]?.completed || 0,
                cancelled: summary[0]?.cancelled || 0,
                total_paid_commission: summary[0]?.total_paid_commission || 0
            },
            pagination: {
                limit: limitInt,
                offset: offsetInt
            },
            user: {
                id: req.user.id,
                full_name: req.user.full_name,
                role: req.user.role
            }
        });
    } catch (error) {
        console.error('Get referrals error:', error);
        res.status(500).json({
            error: 'Internal server error',
            message: error.message
        });
    }
});

app.get('/api/admin/referrals/stats', authenticateAdmin, async (req, res) => {
    const { period = 'month' } = req.query;
    try {
        let groupBy = 'DATE(ru.used_at)';
        let limit = 30;
        switch (period) {
            case 'day':
                groupBy = 'DATE_FORMAT(ru.used_at, "%Y-%m-%d %H:00")';
                limit = 24;
                break;
            case 'week':
                groupBy = 'DATE(ru.used_at)';
                limit = 7;
                break;
            case 'year':
                groupBy = 'DATE_FORMAT(ru.used_at, "%Y-%m")';
                limit = 12;
                break;
            default:
                groupBy = 'DATE(ru.used_at)';
                limit = 30;
        }
        let whereClause = '';
        let params = [];
        if (req.user.role !== 'admin_master') {
            whereClause = 'WHERE ru.admin_id = ?';
            params = [req.user.id];
        }
        const query = `
            SELECT 
                ${groupBy} as date,
                COUNT(*) as total_referrals,
                SUM(commission_amount) as total_commission,
                SUM(discount_amount) as total_discounts,
                AVG(commission_amount) as avg_commission
            FROM referral_usage ru
            ${whereClause}
            GROUP BY ${groupBy}
            ORDER BY date DESC
            LIMIT ${limit}
        `;
        const [stats] = await pool.execute(query, params);
        res.json({
            period: period,
            stats: stats,
            user: {
                id: req.user.id,
                full_name: req.user.full_name,
                role: req.user.role
            }
        });
    } catch (error) {
        console.error('Get referral stats error:', error);
        res.status(500).json({
            error: 'Internal server error',
            message: error.message
        });
    }
});

app.get('/api/admin/referrals/booking/:bookingId', authenticateAdmin, async (req, res) => {
    const { bookingId } = req.params;
    try {
        let query = `
            SELECT 
                ru.*,
                b.booking_reference,
                b.final_price,
                b.status,
                c.full_name as customer_name,
                c.whatsapp as customer_phone,
                c.email as customer_email,
                u.full_name as admin_name,
                u.email as admin_email
            FROM referral_usage ru
            LEFT JOIN bookings b ON ru.booking_id = b.id
            LEFT JOIN booking_customers c ON b.customer_id = c.id
            LEFT JOIN users u ON ru.admin_id = u.id
            WHERE ru.booking_id = ?
        `;
        let params = [bookingId];
        if (req.user.role !== 'admin_master') {
            query += ' AND ru.admin_id = ?';
            params.push(req.user.id);
        }
        const [referrals] = await pool.execute(query, params);
        if (referrals.length === 0) {
            return res.status(404).json({
                error: 'Referral not found or you do not have permission to view it'
            });
        }
        res.json(referrals[0]);
    } catch (error) {
        console.error('Get referral by booking error:', error);
        res.status(500).json({
            error: 'Internal server error',
            message: error.message
        });
    }
});

app.get('/api/admin/commission/summary', authenticateAdmin, async (req, res) => {
    try {
        let query = '';
        let params = [];
        if (req.user.role === 'admin_master') {
            query = `
                SELECT 
                    u.id as admin_id,
                    u.full_name as admin_name,
                    u.email as admin_email,
                    u.referral_code,
                    ac.total_commission,
                    ac.total_orders,
                    ac.last_updated,
                    COUNT(ru.id) as referral_count,
                    SUM(ru.commission_amount) as referral_commission,
                    SUM(ru.discount_amount) as total_discounts_given
                FROM admin_commissions ac
                LEFT JOIN users u ON ac.admin_id = u.id
                LEFT JOIN referral_usage ru ON ru.admin_id = u.id
                WHERE u.role IN ('admin', 'admin_master')
                GROUP BY u.id
                ORDER BY ac.total_commission DESC
            `;
        } else {
            query = `
                SELECT 
                    u.id as admin_id,
                    u.full_name as admin_name,
                    u.email as admin_email,
                    u.referral_code,
                    ac.total_commission,
                    ac.total_orders,
                    ac.last_updated,
                    COUNT(ru.id) as referral_count,
                    SUM(ru.commission_amount) as referral_commission,
                    SUM(ru.discount_amount) as total_discounts_given
                FROM admin_commissions ac
                LEFT JOIN users u ON ac.admin_id = u.id
                LEFT JOIN referral_usage ru ON ru.admin_id = u.id
                WHERE u.id = ?
                GROUP BY u.id
            `;
            params = [req.user.id];
        }
        const [commissions] = await pool.execute(query, params);
        let topAdmins = [];
        if (req.user.role === 'admin_master') {
            const [topResults] = await pool.execute(`
                SELECT 
                    u.id,
                    u.full_name,
                    u.referral_code,
                    ac.total_commission,
                    ac.total_orders,
                    COUNT(ru.id) as referral_count
                FROM users u
                LEFT JOIN admin_commissions ac ON u.id = ac.admin_id
                LEFT JOIN referral_usage ru ON ru.admin_id = u.id
                WHERE u.role IN ('admin', 'admin_master')
                GROUP BY u.id
                ORDER BY ac.total_commission DESC
                LIMIT 5
            `);
            topAdmins = topResults;
        }
        res.json({
            commissions: commissions,
            top_admins: topAdmins,
            user: {
                id: req.user.id,
                full_name: req.user.full_name,
                role: req.user.role
            }
        });
    } catch (error) {
        console.error('Get commission summary error:', error);
        res.status(500).json({
            error: 'Internal server error',
            message: error.message
        });
    }
});

app.get('/api/admin/referrals/export', authenticateAdmin, async (req, res) => {
    try {
        let query = `
            SELECT 
                ru.id,
                ru.referral_code,
                ru.discount_percent,
                ru.commission_percent,
                ru.discount_amount,
                ru.commission_amount,
                ru.commission_status,
                ru.used_at,
                b.booking_reference,
                b.final_price,
                b.status,
                b.service_type,
                c.full_name as customer_name,
                c.whatsapp as customer_phone,
                c.email as customer_email,
                u.full_name as admin_name,
                u.email as admin_email
            FROM referral_usage ru
            LEFT JOIN bookings b ON ru.booking_id = b.id
            LEFT JOIN booking_customers c ON b.customer_id = c.id
            LEFT JOIN users u ON ru.admin_id = u.id
        `;
        let params = [];
        if (req.user.role !== 'admin_master') {
            query += ' WHERE ru.admin_id = ?';
            params = [req.user.id];
        }
        query += ' ORDER BY ru.used_at DESC';
        const [referrals] = await pool.execute(query, params);
        const headers = [
            'ID', 'Referral Code', 'Booking Reference', 'Customer Name',
            'Customer Phone', 'Customer Email', 'Admin Name', 'Service Type',
            'Booking Status', 'Commission Status', 'Discount %', 'Commission %',
            'Discount Amount', 'Commission Amount', 'Final Price', 'Used At'
        ];
        let csv = headers.join(',') + '\n';
        referrals.forEach(r => {
            const row = [
                r.id, r.referral_code || '', r.booking_reference || '',
                r.customer_name || '', r.customer_phone || '', r.customer_email || '',
                r.admin_name || '', r.service_type || '', r.status || '',
                r.commission_status || '', r.discount_percent || 0,
                r.commission_percent || 0, r.discount_amount || 0,
                r.commission_amount || 0, r.final_price || 0, r.used_at || ''
            ];
            csv += row.join(',') + '\n';
        });
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=referral-report-${new Date().toISOString().split('T')[0]}.csv`);
        res.send(csv);
    } catch (error) {
        console.error('Export referrals error:', error);
        res.status(500).json({
            error: 'Internal server error',
            message: error.message
        });
    }
});

// ==================== ADMIN TICKET BOAT ROUTES (CRUD LENGKAP) ====================
app.post('/api/admin/ticket-boat/routes', authenticateAdmin, [
    body('pickup_location').notEmpty().withMessage('Pickup location required'),
    body('dropoff_location').notEmpty().withMessage('Dropoff location required'),
    body('base_price').isNumeric().withMessage('Base price must be a number'),
    body('port_fee').optional().isNumeric().withMessage('Port fee must be a number'),
    body('child_price').optional().isNumeric().withMessage('Child price must be a number'),
    body('is_active').optional().isBoolean().withMessage('is_active must be boolean')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }
    const { pickup_location, dropoff_location, base_price, port_fee, child_price, is_active } = req.body;
    try {
        const [existing] = await pool.execute(
            'SELECT id FROM ticket_boat_routes WHERE pickup_location = ? AND dropoff_location = ?',
            [pickup_location, dropoff_location]
        );
        if (existing.length > 0) {
            return res.status(400).json({ error: 'Route already exists' });
        }
        const [result] = await pool.execute(
            `INSERT INTO ticket_boat_routes 
            (pickup_location, dropoff_location, base_price, port_fee, child_price, is_active) 
            VALUES (?, ?, ?, ?, ?, ?)`,
            [
                pickup_location,
                dropoff_location,
                base_price,
                port_fee || 15000,
                child_price || 200000,
                is_active !== undefined ? (is_active ? 1 : 0) : 1
            ]
        );
        const [newRoute] = await pool.execute(
            'SELECT * FROM ticket_boat_routes WHERE id = ?',
            [result.insertId]
        );
        res.status(201).json({
            success: true,
            message: 'Route created successfully',
            route: newRoute[0]
        });
    } catch (error) {
        console.error('Create ticket boat route error:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

app.get('/api/admin/ticket-boat/routes', authenticateAdmin, async (req, res) => {
    const { is_active, search } = req.query;
    try {
        let query = 'SELECT * FROM ticket_boat_routes WHERE 1=1';
        let params = [];
        if (is_active !== undefined) {
            query += ' AND is_active = ?';
            params.push(is_active === 'true' ? 1 : 0);
        }
        if (search) {
            query += ' AND (pickup_location LIKE ? OR dropoff_location LIKE ?)';
            const searchTerm = `%${search}%`;
            params.push(searchTerm, searchTerm);
        }
        query += ' ORDER BY pickup_location, dropoff_location';
        const [routes] = await pool.execute(query, params);
        const [countResult] = await pool.execute(
            'SELECT COUNT(*) as total FROM ticket_boat_routes'
        );
        res.json({
            success: true,
            routes: routes,
            total: countResult[0].total,
            filters: {
                is_active: is_active || null,
                search: search || null
            }
        });
    } catch (error) {
        console.error('Get ticket boat routes error:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

app.get('/api/admin/ticket-boat/routes/:id', authenticateAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const [routes] = await pool.execute(
            'SELECT * FROM ticket_boat_routes WHERE id = ?',
            [id]
        );
        if (routes.length === 0) {
            return res.status(404).json({ error: 'Route not found' });
        }
        res.json({
            success: true,
            route: routes[0]
        });
    } catch (error) {
        console.error('Get ticket boat route error:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

app.put('/api/admin/ticket-boat/routes/:id', authenticateAdmin, [
    body('pickup_location').optional().notEmpty().withMessage('Pickup location cannot be empty'),
    body('dropoff_location').optional().notEmpty().withMessage('Dropoff location cannot be empty'),
    body('base_price').optional().isNumeric().withMessage('Base price must be a number'),
    body('port_fee').optional().isNumeric().withMessage('Port fee must be a number'),
    body('child_price').optional().isNumeric().withMessage('Child price must be a number'),
    body('is_active').optional().isBoolean().withMessage('is_active must be boolean')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }
    const { id } = req.params;
    const { pickup_location, dropoff_location, base_price, port_fee, child_price, is_active } = req.body;
    try {
        const [existing] = await pool.execute(
            'SELECT id FROM ticket_boat_routes WHERE id = ?',
            [id]
        );
        if (existing.length === 0) {
            return res.status(404).json({ error: 'Route not found' });
        }
        if (pickup_location && dropoff_location) {
            const [duplicate] = await pool.execute(
                'SELECT id FROM ticket_boat_routes WHERE pickup_location = ? AND dropoff_location = ? AND id != ?',
                [pickup_location, dropoff_location, id]
            );
            if (duplicate.length > 0) {
                return res.status(400).json({ error: 'Route with same pickup and dropoff already exists' });
            }
        }
        const updates = [];
        const values = [];
        if (pickup_location !== undefined) {
            updates.push('pickup_location = ?');
            values.push(pickup_location);
        }
        if (dropoff_location !== undefined) {
            updates.push('dropoff_location = ?');
            values.push(dropoff_location);
        }
        if (base_price !== undefined) {
            updates.push('base_price = ?');
            values.push(base_price);
        }
        if (port_fee !== undefined) {
            updates.push('port_fee = ?');
            values.push(port_fee);
        }
        if (child_price !== undefined) {
            updates.push('child_price = ?');
            values.push(child_price);
        }
        if (is_active !== undefined) {
            updates.push('is_active = ?');
            values.push(is_active ? 1 : 0);
        }
        if (updates.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }
        values.push(id);
        await pool.execute(
            `UPDATE ticket_boat_routes SET ${updates.join(', ')} WHERE id = ?`,
            values
        );
        const [updatedRoute] = await pool.execute(
            'SELECT * FROM ticket_boat_routes WHERE id = ?',
            [id]
        );
        res.json({
            success: true,
            message: 'Route updated successfully',
            route: updatedRoute[0]
        });
    } catch (error) {
        console.error('Update ticket boat route error:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

app.delete('/api/admin/ticket-boat/routes/:id', authenticateAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const [existing] = await pool.execute(
            'SELECT id FROM ticket_boat_routes WHERE id = ?',
            [id]
        );
        if (existing.length === 0) {
            return res.status(404).json({ error: 'Route not found' });
        }
        const [used] = await pool.execute(
            'SELECT COUNT(*) as count FROM bookings WHERE tb_pickup_location = (SELECT pickup_location FROM ticket_boat_routes WHERE id = ?) AND tb_dropoff_location = (SELECT dropoff_location FROM ticket_boat_routes WHERE id = ?)',
            [id, id]
        );
        if (used[0].count > 0) {
            return res.status(400).json({
                error: 'Cannot delete route because it is used in existing bookings',
                bookings_count: used[0].count
            });
        }
        await pool.execute(
            'DELETE FROM ticket_boat_routes WHERE id = ?',
            [id]
        );
        res.json({
            success: true,
            message: 'Route deleted successfully',
            route_id: parseInt(id)
        });
    } catch (error) {
        console.error('Delete ticket boat route error:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

app.patch('/api/admin/ticket-boat/routes/:id/toggle', authenticateAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const [existing] = await pool.execute(
            'SELECT id, is_active FROM ticket_boat_routes WHERE id = ?',
            [id]
        );
        if (existing.length === 0) {
            return res.status(404).json({ error: 'Route not found' });
        }
        const newStatus = existing[0].is_active === 1 ? 0 : 1;
        await pool.execute(
            'UPDATE ticket_boat_routes SET is_active = ? WHERE id = ?',
            [newStatus, id]
        );
        res.json({
            success: true,
            message: `Route ${newStatus ? 'activated' : 'deactivated'} successfully`,
            route_id: parseInt(id),
            is_active: newStatus === 1
        });
    } catch (error) {
        console.error('Toggle ticket boat route error:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

app.post('/api/admin/ticket-boat/routes/bulk', authenticateAdmin, [
    body('routes').isArray().withMessage('Routes must be an array'),
    body('routes.*.pickup_location').notEmpty().withMessage('Pickup location required'),
    body('routes.*.dropoff_location').notEmpty().withMessage('Dropoff location required'),
    body('routes.*.base_price').isNumeric().withMessage('Base price must be a number')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }
    const { routes } = req.body;
    const connection = await pool.getConnection();
    await connection.beginTransaction();
    try {
        const created = [];
        const errors_list = [];
        for (const route of routes) {
            try {
                const { pickup_location, dropoff_location, base_price, port_fee, child_price, is_active } = route;
                const [existing] = await connection.execute(
                    'SELECT id FROM ticket_boat_routes WHERE pickup_location = ? AND dropoff_location = ?',
                    [pickup_location, dropoff_location]
                );
                if (existing.length > 0) {
                    errors_list.push({
                        route: route,
                        error: 'Route already exists'
                    });
                    continue;
                }
                const [result] = await connection.execute(
                    `INSERT INTO ticket_boat_routes 
                    (pickup_location, dropoff_location, base_price, port_fee, child_price, is_active) 
                    VALUES (?, ?, ?, ?, ?, ?)`,
                    [
                        pickup_location,
                        dropoff_location,
                        base_price,
                        port_fee || 15000,
                        child_price || 200000,
                        is_active !== undefined ? (is_active ? 1 : 0) : 1
                    ]
                );
                const [newRoute] = await connection.execute(
                    'SELECT * FROM ticket_boat_routes WHERE id = ?',
                    [result.insertId]
                );
                created.push(newRoute[0]);
            } catch (err) {
                errors_list.push({
                    route: route,
                    error: err.message
                });
            }
        }
        await connection.commit();
        res.status(201).json({
            success: true,
            message: `${created.length} routes created successfully`,
            created: created,
            errors: errors_list,
            total_attempted: routes.length,
            total_created: created.length,
            total_errors: errors_list.length
        });
    } catch (error) {
        await connection.rollback();
        console.error('Bulk create ticket boat routes error:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    } finally {
        connection.release();
    }
});

app.get('/api/admin/ticket-boat/routes/stats', authenticateAdmin, async (req, res) => {
    try {
        const [totalRoutes] = await pool.execute(
            'SELECT COUNT(*) as total FROM ticket_boat_routes'
        );
        const [activeStats] = await pool.execute(
            `SELECT 
                SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active,
                SUM(CASE WHEN is_active = 0 THEN 1 ELSE 0 END) as inactive
            FROM ticket_boat_routes`
        );
        const [pickupStats] = await pool.execute(
            `SELECT 
                pickup_location,
                COUNT(*) as total_routes
            FROM ticket_boat_routes
            GROUP BY pickup_location
            ORDER BY total_routes DESC`
        );
        const [dropoffStats] = await pool.execute(
            `SELECT 
                dropoff_location,
                COUNT(*) as total_routes
            FROM ticket_boat_routes
            GROUP BY dropoff_location
            ORDER BY total_routes DESC`
        );
        const [priceRange] = await pool.execute(
            `SELECT 
                MIN(base_price) as min_price,
                MAX(base_price) as max_price,
                AVG(base_price) as avg_price
            FROM ticket_boat_routes`
        );
        res.json({
            success: true,
            stats: {
                total_routes: totalRoutes[0].total,
                active: activeStats[0].active || 0,
                inactive: activeStats[0].inactive || 0,
                pickup_locations: pickupStats,
                dropoff_locations: dropoffStats,
                price_range: {
                    min: priceRange[0].min_price || 0,
                    max: priceRange[0].max_price || 0,
                    avg: Math.round(priceRange[0].avg_price || 0)
                }
            }
        });
    } catch (error) {
        console.error('Get ticket boat route stats error:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

// ==================== VERIFY TOKEN ====================
app.get('/api/auth/verify', authenticateToken, async (req, res) => {
    try {
        const [user] = await pool.execute(
            'SELECT id, email, full_name, role, referral_code FROM users WHERE id = ? AND is_active = TRUE',
            [req.user.id]
        );
        if (user.length === 0) {
            return res.status(401).json({ error: 'User not found or inactive' });
        }
        res.json({
            valid: true,
            user: user[0]
        });
    } catch (error) {
        console.error('Verify token error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
    try {
        const [user] = await pool.execute(
            'SELECT id, email, full_name, phone, role, referral_code, created_at FROM users WHERE id = ? AND is_active = TRUE',
            [req.user.id]
        );
        if (user.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json(user[0]);
    } catch (error) {
        console.error('Get user error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ==================== ADMIN TICKET BOAT TYPES ROUTES (CRUD LENGKAP) ====================
// Tempel blok ini setelah bagian "ADMIN TICKET BOAT ROUTES (CRUD LENGKAP)" di server.js

app.post('/api/admin/ticket-boat/types', authenticateAdmin, [
    body('code').notEmpty().withMessage('Code required'),
    body('name').notEmpty().withMessage('Name required'),
    body('price').isNumeric().withMessage('Price must be a number'),
    body('description').optional().isString(),
    body('is_active').optional().isBoolean().withMessage('is_active must be boolean')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }
    const { code, name, description, price, is_active } = req.body;
    const normalizedCode = code.trim().toUpperCase();
    try {
        const [existing] = await pool.execute(
            'SELECT id FROM ticket_boat_types WHERE code = ?',
            [normalizedCode]
        );
        if (existing.length > 0) {
            return res.status(400).json({ error: 'Ticket type code already exists' });
        }
        const [result] = await pool.execute(
            `INSERT INTO ticket_boat_types
            (code, name, description, price, is_active)
            VALUES (?, ?, ?, ?, ?)`,
            [
                normalizedCode,
                name,
                description || null,
                price,
                is_active !== undefined ? (is_active ? 1 : 0) : 1
            ]
        );
        const [newType] = await pool.execute(
            'SELECT * FROM ticket_boat_types WHERE id = ?',
            [result.insertId]
        );
        res.status(201).json({
            success: true,
            message: 'Ticket type created successfully',
            type: newType[0]
        });
    } catch (error) {
        console.error('Create ticket boat type error:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

app.get('/api/admin/ticket-boat/types', authenticateAdmin, async (req, res) => {
    const { is_active, search, limit = 100, offset = 0 } = req.query;
    try {
        const limitInt = parseInt(limit) || 100;
        const offsetInt = parseInt(offset) || 0;
        let query = 'SELECT * FROM ticket_boat_types WHERE 1=1';
        let params = [];
        if (is_active !== undefined) {
            query += ' AND is_active = ?';
            params.push(is_active === 'true' ? 1 : 0);
        }
        if (search) {
            query += ' AND (code LIKE ? OR name LIKE ?)';
            const searchTerm = `%${search}%`;
            params.push(searchTerm, searchTerm);
        }
        query += ` ORDER BY price ASC LIMIT ${limitInt} OFFSET ${offsetInt}`;
        const [types] = await pool.execute(query, params);
        const [countResult] = await pool.execute(
            'SELECT COUNT(*) as total FROM ticket_boat_types'
        );
        res.json({
            success: true,
            types: types,
            total: countResult[0].total,
            filters: {
                is_active: is_active || null,
                search: search || null
            }
        });
    } catch (error) {
        console.error('Get ticket boat types error:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

app.get('/api/admin/ticket-boat/types/:id', authenticateAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const [types] = await pool.execute(
            'SELECT * FROM ticket_boat_types WHERE id = ?',
            [id]
        );
        if (types.length === 0) {
            return res.status(404).json({ error: 'Ticket type not found' });
        }
        res.json({
            success: true,
            type: types[0]
        });
    } catch (error) {
        console.error('Get ticket boat type error:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

app.put('/api/admin/ticket-boat/types/:id', authenticateAdmin, [
    body('name').optional().notEmpty().withMessage('Name cannot be empty'),
    body('description').optional().isString(),
    body('price').optional().isNumeric().withMessage('Price must be a number'),
    body('is_active').optional().isBoolean().withMessage('is_active must be boolean')
], async (req, res) => {
    // Catatan: "code" sengaja tidak bisa diupdate di sini karena dipakai sebagai
    // referensi di bookings.tb_ticket_type. Kalau memang perlu diubah, hapus dan
    // buat ulang jenis tiketnya.
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }
    const { id } = req.params;
    const { name, description, price, is_active } = req.body;
    try {
        const [existing] = await pool.execute(
            'SELECT id FROM ticket_boat_types WHERE id = ?',
            [id]
        );
        if (existing.length === 0) {
            return res.status(404).json({ error: 'Ticket type not found' });
        }
        const updates = [];
        const values = [];
        if (name !== undefined) { updates.push('name = ?'); values.push(name); }
        if (description !== undefined) { updates.push('description = ?'); values.push(description); }
        if (price !== undefined) { updates.push('price = ?'); values.push(price); }
        if (is_active !== undefined) { updates.push('is_active = ?'); values.push(is_active ? 1 : 0); }
        if (updates.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }
        values.push(id);
        await pool.execute(
            `UPDATE ticket_boat_types SET ${updates.join(', ')} WHERE id = ?`,
            values
        );
        const [updatedType] = await pool.execute(
            'SELECT * FROM ticket_boat_types WHERE id = ?',
            [id]
        );
        res.json({
            success: true,
            message: 'Ticket type updated successfully',
            type: updatedType[0]
        });
    } catch (error) {
        console.error('Update ticket boat type error:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

app.delete('/api/admin/ticket-boat/types/:id', authenticateAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const [existing] = await pool.execute(
            'SELECT id, code FROM ticket_boat_types WHERE id = ?',
            [id]
        );
        if (existing.length === 0) {
            return res.status(404).json({ error: 'Ticket type not found' });
        }
        const [used] = await pool.execute(
            'SELECT COUNT(*) as count FROM bookings WHERE tb_ticket_type = ?',
            [existing[0].code]
        );
        if (used[0].count > 0) {
            return res.status(400).json({
                error: 'Cannot delete ticket type because it is used in existing bookings',
                bookings_count: used[0].count
            });
        }
        await pool.execute('DELETE FROM ticket_boat_types WHERE id = ?', [id]);
        res.json({
            success: true,
            message: 'Ticket type deleted successfully',
            type_id: parseInt(id)
        });
    } catch (error) {
        console.error('Delete ticket boat type error:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

app.patch('/api/admin/ticket-boat/types/:id/toggle', authenticateAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const [existing] = await pool.execute(
            'SELECT id, is_active FROM ticket_boat_types WHERE id = ?',
            [id]
        );
        if (existing.length === 0) {
            return res.status(404).json({ error: 'Ticket type not found' });
        }
        const newStatus = existing[0].is_active === 1 ? 0 : 1;
        await pool.execute(
            'UPDATE ticket_boat_types SET is_active = ? WHERE id = ?',
            [newStatus, id]
        );
        res.json({
            success: true,
            message: `Ticket type ${newStatus ? 'activated' : 'deactivated'} successfully`,
            type_id: parseInt(id),
            is_active: newStatus === 1
        });
    } catch (error) {
        console.error('Toggle ticket boat type error:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

app.post('/api/admin/ticket-boat/types/bulk', authenticateAdmin, [
    body('types').isArray().withMessage('Types must be an array'),
    body('types.*.code').notEmpty().withMessage('Code required'),
    body('types.*.name').notEmpty().withMessage('Name required'),
    body('types.*.price').isNumeric().withMessage('Price must be a number')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }
    const { types } = req.body;
    const connection = await pool.getConnection();
    await connection.beginTransaction();
    try {
        const created = [];
        const errors_list = [];
        for (const type of types) {
            try {
                const { code, name, description, price, is_active } = type;
                const normalizedCode = code.trim().toUpperCase();
                const [existing] = await connection.execute(
                    'SELECT id FROM ticket_boat_types WHERE code = ?',
                    [normalizedCode]
                );
                if (existing.length > 0) {
                    errors_list.push({ type, error: 'Ticket type code already exists' });
                    continue;
                }
                const [result] = await connection.execute(
                    `INSERT INTO ticket_boat_types
                    (code, name, description, price, is_active)
                    VALUES (?, ?, ?, ?, ?)`,
                    [
                        normalizedCode,
                        name,
                        description || null,
                        price,
                        is_active !== undefined ? (is_active ? 1 : 0) : 1
                    ]
                );
                const [newType] = await connection.execute(
                    'SELECT * FROM ticket_boat_types WHERE id = ?',
                    [result.insertId]
                );
                created.push(newType[0]);
            } catch (err) {
                errors_list.push({ type, error: err.message });
            }
        }
        await connection.commit();
        res.status(201).json({
            success: true,
            message: `${created.length} ticket types created successfully`,
            created: created,
            errors: errors_list,
            total_attempted: types.length,
            total_created: created.length,
            total_errors: errors_list.length
        });
    } catch (error) {
        await connection.rollback();
        console.error('Bulk create ticket boat types error:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    } finally {
        connection.release();
    }
});

// ==================== TICKET BOAT SCHEDULES (PUBLIC) ====================

// GET jam keberangkatan yang tersedia untuk 1 rute — dipakai frontend untuk isi dropdown jam
// ==================== TICKET BOAT SCHEDULES (PUBLIC) ====================

// GET jam keberangkatan yang tersedia untuk 1 rute — dipakai frontend untuk isi dropdown jam
app.get('/api/ticket-boat/schedules', [
    query('pickup').notEmpty().withMessage('Pickup location required'),  // 🔥 Ganti body → query
    query('dropoff').notEmpty().withMessage('Dropoff location required') // 🔥 Ganti body → query
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }
    const { pickup, dropoff } = req.query;
    try {
        const [schedules] = await pool.execute(
            `SELECT s.id, s.departure_time
            FROM ticket_boat_schedules s
            JOIN ticket_boat_routes r ON s.route_id = r.id
            WHERE r.pickup_location = ? AND r.dropoff_location = ?
              AND r.is_active = 1 AND s.is_active = 1
            ORDER BY s.departure_time ASC`,
            [pickup, dropoff]
        );
        if (schedules.length === 0) {
            return res.status(404).json({
                available: false,
                message: 'Belum ada jadwal untuk rute ini'
            });
        }
        res.json({
            available: true,
            pickup,
            dropoff,
            schedules
        });
    } catch (error) {
        console.error('Get ticket boat schedules error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ==================== ADMIN TICKET BOAT SCHEDULES (CRUD) ====================

// Buat jadwal baru untuk sebuah rute
app.post('/api/admin/ticket-boat/schedules', authenticateAdmin, [
    body('route_id').isInt().withMessage('route_id must be an integer'),
    body('departure_time').matches(/^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/).withMessage('departure_time must be HH:mm or HH:mm:ss'),
    body('is_active').optional().isBoolean()
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }
    const { route_id, departure_time, is_active } = req.body;
    try {
        const [route] = await pool.execute(
            'SELECT id FROM ticket_boat_routes WHERE id = ?',
            [route_id]
        );
        if (route.length === 0) {
            return res.status(404).json({ error: 'Route not found' });
        }
        const [existing] = await pool.execute(
            'SELECT id FROM ticket_boat_schedules WHERE route_id = ? AND departure_time = ?',
            [route_id, departure_time]
        );
        if (existing.length > 0) {
            return res.status(400).json({ error: 'Schedule already exists for this route and time' });
        }
        const [result] = await pool.execute(
            `INSERT INTO ticket_boat_schedules (route_id, departure_time, is_active)
            VALUES (?, ?, ?)`,
            [route_id, departure_time, is_active !== undefined ? (is_active ? 1 : 0) : 1]
        );
        const [newSchedule] = await pool.execute(
            'SELECT * FROM ticket_boat_schedules WHERE id = ?',
            [result.insertId]
        );
        res.status(201).json({
            success: true,
            message: 'Schedule created successfully',
            schedule: newSchedule[0]
        });
    } catch (error) {
        console.error('Create ticket boat schedule error:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

// List semua jadwal (opsional filter per rute), sekalian join info rute biar enak dibaca di dashboard admin
app.get('/api/admin/ticket-boat/schedules', authenticateAdmin, async (req, res) => {
    const { route_id, is_active } = req.query;
    try {
        let query = `
            SELECT s.id, s.route_id, s.departure_time, s.is_active,
                   r.pickup_location, r.dropoff_location
            FROM ticket_boat_schedules s
            JOIN ticket_boat_routes r ON s.route_id = r.id
            WHERE 1=1
        `;
        const params = [];
        if (route_id) {
            query += ' AND s.route_id = ?';
            params.push(route_id);
        }
        if (is_active !== undefined) {
            query += ' AND s.is_active = ?';
            params.push(is_active === 'true' ? 1 : 0);
        }
        query += ' ORDER BY r.pickup_location, r.dropoff_location, s.departure_time';
        const [schedules] = await pool.execute(query, params);
        res.json({ success: true, schedules });
    } catch (error) {
        console.error('Get ticket boat schedules error:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

// Update jam / status aktif sebuah jadwal
app.put('/api/admin/ticket-boat/schedules/:id', authenticateAdmin, [
    body('departure_time').optional().matches(/^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/).withMessage('departure_time must be HH:mm or HH:mm:ss'),
    body('is_active').optional().isBoolean()
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }
    const { id } = req.params;
    const { departure_time, is_active } = req.body;
    try {
        const [existing] = await pool.execute(
            'SELECT id, route_id FROM ticket_boat_schedules WHERE id = ?',
            [id]
        );
        if (existing.length === 0) {
            return res.status(404).json({ error: 'Schedule not found' });
        }
        if (departure_time) {
            const [duplicate] = await pool.execute(
                'SELECT id FROM ticket_boat_schedules WHERE route_id = ? AND departure_time = ? AND id != ?',
                [existing[0].route_id, departure_time, id]
            );
            if (duplicate.length > 0) {
                return res.status(400).json({ error: 'Schedule with this time already exists for the route' });
            }
        }
        const updates = [];
        const values = [];
        if (departure_time !== undefined) { updates.push('departure_time = ?'); values.push(departure_time); }
        if (is_active !== undefined) { updates.push('is_active = ?'); values.push(is_active ? 1 : 0); }
        if (updates.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }
        values.push(id);
        await pool.execute(
            `UPDATE ticket_boat_schedules SET ${updates.join(', ')} WHERE id = ?`,
            values
        );
        const [updated] = await pool.execute('SELECT * FROM ticket_boat_schedules WHERE id = ?', [id]);
        res.json({ success: true, message: 'Schedule updated successfully', schedule: updated[0] });
    } catch (error) {
        console.error('Update ticket boat schedule error:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

// Hapus jadwal — dicegah kalau sudah dipakai di booking (perlu kolom bookings.tb_depart_time, lihat catatan di bawah)
app.delete('/api/admin/ticket-boat/schedules/:id', authenticateAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const [existing] = await pool.execute(
            'SELECT s.id, s.departure_time, r.pickup_location, r.dropoff_location FROM ticket_boat_schedules s JOIN ticket_boat_routes r ON s.route_id = r.id WHERE s.id = ?',
            [id]
        );
        if (existing.length === 0) {
            return res.status(404).json({ error: 'Schedule not found' });
        }
        const [used] = await pool.execute(
            `SELECT COUNT(*) as count FROM bookings
            WHERE tb_pickup_location = ? AND tb_dropoff_location = ? AND tb_depart_time = ?`,
            [existing[0].pickup_location, existing[0].dropoff_location, existing[0].departure_time]
        );
        if (used[0].count > 0) {
            return res.status(400).json({
                error: 'Cannot delete schedule because it is used in existing bookings',
                bookings_count: used[0].count
            });
        }
        await pool.execute('DELETE FROM ticket_boat_schedules WHERE id = ?', [id]);
        res.json({ success: true, message: 'Schedule deleted successfully', schedule_id: parseInt(id) });
    } catch (error) {
        console.error('Delete ticket boat schedule error:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

// Aktif/nonaktifkan jadwal tanpa menghapus (lebih aman daripada delete)
app.patch('/api/admin/ticket-boat/schedules/:id/toggle', authenticateAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const [existing] = await pool.execute(
            'SELECT id, is_active FROM ticket_boat_schedules WHERE id = ?',
            [id]
        );
        if (existing.length === 0) {
            return res.status(404).json({ error: 'Schedule not found' });
        }
        const newStatus = existing[0].is_active === 1 ? 0 : 1;
        await pool.execute('UPDATE ticket_boat_schedules SET is_active = ? WHERE id = ?', [newStatus, id]);
        res.json({
            success: true,
            message: `Schedule ${newStatus ? 'activated' : 'deactivated'} successfully`,
            schedule_id: parseInt(id),
            is_active: newStatus === 1
        });
    } catch (error) {
        console.error('Toggle ticket boat schedule error:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

// ==================== FASTBOAT ROUTES (CRUD) ====================

// ==================== FASTBOAT ROUTES (CRUD) ====================

// ============ CREATE FASTBOAT ROUTE ============
app.post('/api/admin/fastboat/routes', authenticateAdmin, [
    body('pickup_port').notEmpty().withMessage('Pickup port required'),
    body('dropoff_port').notEmpty().withMessage('Dropoff port required'),
    body('base_price').isNumeric().withMessage('Base price must be a number'),
    body('child_price').optional().isNumeric().withMessage('Child price must be a number'),
    body('is_active').optional().isBoolean().withMessage('is_active must be boolean')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }

    const { pickup_port, dropoff_port, base_price, child_price, is_active } = req.body;

    try {
        const [existing] = await pool.execute(
            'SELECT id FROM fastboat_routes WHERE pickup_port = ? AND dropoff_port = ?',
            [pickup_port, dropoff_port]
        );
        if (existing.length > 0) {
            return res.status(400).json({ error: 'Route already exists' });
        }

        const [result] = await pool.execute(
            `INSERT INTO fastboat_routes 
            (pickup_port, dropoff_port, base_price, child_price, is_active) 
            VALUES (?, ?, ?, ?, ?)`,
            [
                pickup_port,
                dropoff_port,
                base_price,
                child_price || 0,
                is_active !== undefined ? (is_active ? 1 : 0) : 1
            ]
        );

        const [newRoute] = await pool.execute(
            'SELECT * FROM fastboat_routes WHERE id = ?',
            [result.insertId]
        );

        res.status(201).json({
            success: true,
            message: 'Fastboat route created successfully',
            route: newRoute[0]
        });
    } catch (error) {
        console.error('Create fastboat route error:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

// ============ GET ALL FASTBOAT ROUTES ============
app.get('/api/admin/fastboat/routes', authenticateAdmin, async (req, res) => {
    const { is_active, search, limit, offset } = req.query;

    try {
        const limitInt = parseInt(limit) || 20;
        const offsetInt = parseInt(offset) || 0;
        const safeLimit = Math.max(1, limitInt);
        const safeOffset = Math.max(0, offsetInt);

        let query = 'SELECT * FROM fastboat_routes WHERE 1=1';
        let params = [];

        if (is_active !== undefined) {
            query += ' AND is_active = ?';
            params.push(is_active === 'true' ? 1 : 0);
        }

        if (search) {
            query += ' AND (pickup_port LIKE ? OR dropoff_port LIKE ?)';
            const searchTerm = `%${search}%`;
            params.push(searchTerm, searchTerm);
        }

        // 🔥 FIX: Template literal untuk LIMIT/OFFSET
        query += ` ORDER BY pickup_port, dropoff_port LIMIT ${safeLimit} OFFSET ${safeOffset}`;

        console.log('📡 SQL:', query);
        console.log('📡 Params:', params);

        const [routes] = await pool.execute(query, params);

        const [countResult] = await pool.execute(
            'SELECT COUNT(*) as total FROM fastboat_routes'
        );

        res.json({
            success: true,
            routes: routes,
            total: countResult[0].total,
            filters: {
                is_active: is_active || null,
                search: search || null
            }
        });
    } catch (error) {
        console.error('Get fastboat routes error:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});
// ============ GET FASTBOAT ROUTE BY ID ============
app.get('/api/admin/fastboat/routes/:id', authenticateAdmin, async (req, res) => {
    const { id } = req.params;

    try {
        const [routes] = await pool.execute(
            'SELECT * FROM fastboat_routes WHERE id = ?',
            [id]
        );

        if (routes.length === 0) {
            return res.status(404).json({ error: 'Fastboat route not found' });
        }

        res.json({
            success: true,
            route: routes[0]
        });
    } catch (error) {
        console.error('Get fastboat route error:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

// ============ UPDATE FASTBOAT ROUTE ============
app.put('/api/admin/fastboat/routes/:id', authenticateAdmin, [
    body('pickup_port').optional().notEmpty().withMessage('Pickup port cannot be empty'),
    body('dropoff_port').optional().notEmpty().withMessage('Dropoff port cannot be empty'),
    body('base_price').optional().isNumeric().withMessage('Base price must be a number'),
    body('child_price').optional().isNumeric().withMessage('Child price must be a number'),
    body('is_active').optional().isBoolean().withMessage('is_active must be boolean')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }

    const { id } = req.params;
    const { pickup_port, dropoff_port, base_price, child_price, is_active } = req.body;

    try {
        const [existing] = await pool.execute(
            'SELECT id FROM fastboat_routes WHERE id = ?',
            [id]
        );
        if (existing.length === 0) {
            return res.status(404).json({ error: 'Fastboat route not found' });
        }

        if (pickup_port && dropoff_port) {
            const [duplicate] = await pool.execute(
                'SELECT id FROM fastboat_routes WHERE pickup_port = ? AND dropoff_port = ? AND id != ?',
                [pickup_port, dropoff_port, id]
            );
            if (duplicate.length > 0) {
                return res.status(400).json({ error: 'Route with same pickup and dropoff already exists' });
            }
        }

        const updates = [];
        const values = [];

        if (pickup_port !== undefined) {
            updates.push('pickup_port = ?');
            values.push(pickup_port);
        }
        if (dropoff_port !== undefined) {
            updates.push('dropoff_port = ?');
            values.push(dropoff_port);
        }
        if (base_price !== undefined) {
            updates.push('base_price = ?');
            values.push(base_price);
        }
        if (child_price !== undefined) {
            updates.push('child_price = ?');
            values.push(child_price);
        }
        if (is_active !== undefined) {
            updates.push('is_active = ?');
            values.push(is_active ? 1 : 0);
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        values.push(id);
        await pool.execute(
            `UPDATE fastboat_routes SET ${updates.join(', ')} WHERE id = ?`,
            values
        );

        const [updatedRoute] = await pool.execute(
            'SELECT * FROM fastboat_routes WHERE id = ?',
            [id]
        );

        res.json({
            success: true,
            message: 'Fastboat route updated successfully',
            route: updatedRoute[0]
        });
    } catch (error) {
        console.error('Update fastboat route error:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

// ============ DELETE FASTBOAT ROUTE ============
app.delete('/api/admin/fastboat/routes/:id', authenticateAdmin, async (req, res) => {
    const { id } = req.params;

    try {
        const [existing] = await pool.execute(
            'SELECT id FROM fastboat_routes WHERE id = ?',
            [id]
        );
        if (existing.length === 0) {
            return res.status(404).json({ error: 'Fastboat route not found' });
        }

        const [used] = await pool.execute(
            `SELECT COUNT(*) as count FROM bookings WHERE fb_pickup_port = (SELECT pickup_port FROM fastboat_routes WHERE id = ?) AND fb_dropoff_port = (SELECT dropoff_port FROM fastboat_routes WHERE id = ?)`,
            [id, id]
        );

        if (used[0].count > 0) {
            return res.status(400).json({
                error: 'Cannot delete route because it is used in existing bookings',
                bookings_count: used[0].count
            });
        }

        await pool.execute(
            'DELETE FROM fastboat_routes WHERE id = ?',
            [id]
        );

        res.json({
            success: true,
            message: 'Fastboat route deleted successfully',
            route_id: parseInt(id)
        });
    } catch (error) {
        console.error('Delete fastboat route error:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

// ============ TOGGLE FASTBOAT ROUTE ACTIVE ============
app.patch('/api/admin/fastboat/routes/:id/toggle', authenticateAdmin, async (req, res) => {
    const { id } = req.params;

    try {
        const [existing] = await pool.execute(
            'SELECT id, is_active FROM fastboat_routes WHERE id = ?',
            [id]
        );
        if (existing.length === 0) {
            return res.status(404).json({ error: 'Fastboat route not found' });
        }

        const newStatus = existing[0].is_active === 1 ? 0 : 1;

        await pool.execute(
            'UPDATE fastboat_routes SET is_active = ? WHERE id = ?',
            [newStatus, id]
        );

        res.json({
            success: true,
            message: `Fastboat route ${newStatus ? 'activated' : 'deactivated'} successfully`,
            route_id: parseInt(id),
            is_active: newStatus === 1
        });
    } catch (error) {
        console.error('Toggle fastboat route error:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

// ============ BULK CREATE FASTBOAT ROUTES ============
app.post('/api/admin/fastboat/routes/bulk', authenticateAdmin, [
    body('routes').isArray().withMessage('Routes must be an array'),
    body('routes.*.pickup_port').notEmpty().withMessage('Pickup port required'),
    body('routes.*.dropoff_port').notEmpty().withMessage('Dropoff port required'),
    body('routes.*.base_price').isNumeric().withMessage('Base price must be a number')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }

    const { routes } = req.body;
    const connection = await pool.getConnection();
    await connection.beginTransaction();

    try {
        const created = [];
        const errors_list = [];

        for (const route of routes) {
            try {
                const { pickup_port, dropoff_port, base_price, child_price, is_active } = route;

                const [existing] = await connection.execute(
                    'SELECT id FROM fastboat_routes WHERE pickup_port = ? AND dropoff_port = ?',
                    [pickup_port, dropoff_port]
                );
                if (existing.length > 0) {
                    errors_list.push({
                        route: route,
                        error: 'Route already exists'
                    });
                    continue;
                }

                const [result] = await connection.execute(
                    `INSERT INTO fastboat_routes 
                    (pickup_port, dropoff_port, base_price, child_price, is_active) 
                    VALUES (?, ?, ?, ?, ?)`,
                    [
                        pickup_port,
                        dropoff_port,
                        base_price,
                        child_price || 0,
                        is_active !== undefined ? (is_active ? 1 : 0) : 1
                    ]
                );

                const [newRoute] = await connection.execute(
                    'SELECT * FROM fastboat_routes WHERE id = ?',
                    [result.insertId]
                );

                created.push(newRoute[0]);
            } catch (err) {
                errors_list.push({
                    route: route,
                    error: err.message
                });
            }
        }

        await connection.commit();

        res.status(201).json({
            success: true,
            message: `${created.length} fastboat routes created successfully`,
            created: created,
            errors: errors_list,
            total_attempted: routes.length,
            total_created: created.length,
            total_errors: errors_list.length
        });
    } catch (error) {
        await connection.rollback();
        console.error('Bulk create fastboat routes error:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    } finally {
        connection.release();
    }
});

// ==================== FASTBOAT SCHEDULES (CRUD) ====================

// ============ CREATE FASTBOAT SCHEDULE ============
app.post('/api/admin/fastboat/schedules', authenticateAdmin, [
    body('route_id').isInt().withMessage('route_id must be an integer'),
    body('departure_time').matches(/^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/).withMessage('departure_time must be HH:mm or HH:mm:ss'),
    body('boat_name').optional().isString().withMessage('Boat name must be a string'),
    body('is_active').optional().isBoolean()
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }

    const { route_id, departure_time, boat_name, is_active } = req.body;

    try {
        const [route] = await pool.execute(
            'SELECT id FROM fastboat_routes WHERE id = ?',
            [route_id]
        );
        if (route.length === 0) {
            return res.status(404).json({ error: 'Route not found' });
        }

        const [existing] = await pool.execute(
            'SELECT id FROM fastboat_schedules WHERE route_id = ? AND departure_time = ?',
            [route_id, departure_time]
        );
        if (existing.length > 0) {
            return res.status(400).json({ error: 'Schedule already exists for this route and time' });
        }

        const [result] = await pool.execute(
            `INSERT INTO fastboat_schedules (route_id, departure_time, boat_name, is_active)
            VALUES (?, ?, ?, ?)`,
            [
                route_id,
                departure_time,
                boat_name || null,
                is_active !== undefined ? (is_active ? 1 : 0) : 1
            ]
        );

        const [newSchedule] = await pool.execute(
            'SELECT * FROM fastboat_schedules WHERE id = ?',
            [result.insertId]
        );

        res.status(201).json({
            success: true,
            message: 'Fastboat schedule created successfully',
            schedule: newSchedule[0]
        });
    } catch (error) {
        console.error('Create fastboat schedule error:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

// ============ GET ALL FASTBOAT SCHEDULES ============
app.get('/api/admin/fastboat/schedules', authenticateAdmin, async (req, res) => {
    const { route_id, is_active } = req.query;

    try {
        let query = `SELECT s.id, s.route_id, s.departure_time, s.boat_name, s.is_active, r.pickup_port, r.dropoff_port FROM fastboat_schedules s JOIN fastboat_routes r ON s.route_id = r.id WHERE 1=1`;
        const params = [];

        if (route_id) {
            query += ' AND s.route_id = ?';
            params.push(parseInt(route_id));
        }

        if (is_active !== undefined) {
            query += ' AND s.is_active = ?';
            params.push(is_active === 'true' ? 1 : 0);
        }

        query += ' ORDER BY r.pickup_port, r.dropoff_port, s.departure_time';

        const [schedules] = await pool.execute(query, params);

        res.json({
            success: true,
            schedules: schedules
        });
    } catch (error) {
        console.error('Get fastboat schedules error:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

// ============ GET FASTBOAT SCHEDULE BY ID ============
app.get('/api/admin/fastboat/schedules/:id', authenticateAdmin, async (req, res) => {
    const { id } = req.params;

    try {
        const [schedules] = await pool.execute(
            `SELECT s.id, s.route_id, s.departure_time, s.boat_name, s.is_active, r.pickup_port, r.dropoff_port FROM fastboat_schedules s JOIN fastboat_routes r ON s.route_id = r.id WHERE s.id = ?`,
            [id]
        );

        if (schedules.length === 0) {
            return res.status(404).json({ error: 'Fastboat schedule not found' });
        }

        res.json({
            success: true,
            schedule: schedules[0]
        });
    } catch (error) {
        console.error('Get fastboat schedule error:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

// ============ UPDATE FASTBOAT SCHEDULE ============
app.put('/api/admin/fastboat/schedules/:id', authenticateAdmin, [
    body('departure_time').optional().matches(/^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/).withMessage('departure_time must be HH:mm or HH:mm:ss'),
    body('boat_name').optional().isString().withMessage('Boat name must be a string'),
    body('is_active').optional().isBoolean()
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }

    const { id } = req.params;
    const { departure_time, boat_name, is_active } = req.body;

    try {
        const [existing] = await pool.execute(
            'SELECT id, route_id FROM fastboat_schedules WHERE id = ?',
            [id]
        );
        if (existing.length === 0) {
            return res.status(404).json({ error: 'Fastboat schedule not found' });
        }

        if (departure_time) {
            const [duplicate] = await pool.execute(
                'SELECT id FROM fastboat_schedules WHERE route_id = ? AND departure_time = ? AND id != ?',
                [existing[0].route_id, departure_time, id]
            );
            if (duplicate.length > 0) {
                return res.status(400).json({ error: 'Schedule with this time already exists for this route' });
            }
        }

        const updates = [];
        const values = [];

        if (departure_time !== undefined) {
            updates.push('departure_time = ?');
            values.push(departure_time);
        }
        if (boat_name !== undefined) {
            updates.push('boat_name = ?');
            values.push(boat_name);
        }
        if (is_active !== undefined) {
            updates.push('is_active = ?');
            values.push(is_active ? 1 : 0);
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        values.push(id);
        await pool.execute(
            `UPDATE fastboat_schedules SET ${updates.join(', ')} WHERE id = ?`,
            values
        );

        const [updated] = await pool.execute(
            'SELECT * FROM fastboat_schedules WHERE id = ?',
            [id]
        );

        res.json({
            success: true,
            message: 'Fastboat schedule updated successfully',
            schedule: updated[0]
        });
    } catch (error) {
        console.error('Update fastboat schedule error:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

// ============ DELETE FASTBOAT SCHEDULE ============
app.delete('/api/admin/fastboat/schedules/:id', authenticateAdmin, async (req, res) => {
    const { id } = req.params;

    try {
        const [existing] = await pool.execute(
            `SELECT s.id, s.departure_time, r.pickup_port, r.dropoff_port FROM fastboat_schedules s JOIN fastboat_routes r ON s.route_id = r.id WHERE s.id = ?`,
            [id]
        );
        if (existing.length === 0) {
            return res.status(404).json({ error: 'Fastboat schedule not found' });
        }

        const [used] = await pool.execute(
            `SELECT COUNT(*) as count FROM bookings WHERE fb_pickup_port = ? AND fb_dropoff_port = ?`,
            [existing[0].pickup_port, existing[0].dropoff_port]
        );

        if (used[0].count > 0) {
            return res.status(400).json({
                error: 'Cannot delete schedule because it is used in existing bookings',
                bookings_count: used[0].count
            });
        }

        await pool.execute(
            'DELETE FROM fastboat_schedules WHERE id = ?',
            [id]
        );

        res.json({
            success: true,
            message: 'Fastboat schedule deleted successfully',
            schedule_id: parseInt(id)
        });
    } catch (error) {
        console.error('Delete fastboat schedule error:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

// ============ TOGGLE FASTBOAT SCHEDULE ACTIVE ============
app.patch('/api/admin/fastboat/schedules/:id/toggle', authenticateAdmin, async (req, res) => {
    const { id } = req.params;

    try {
        const [existing] = await pool.execute(
            'SELECT id, is_active FROM fastboat_schedules WHERE id = ?',
            [id]
        );
        if (existing.length === 0) {
            return res.status(404).json({ error: 'Fastboat schedule not found' });
        }

        const newStatus = existing[0].is_active === 1 ? 0 : 1;

        await pool.execute(
            'UPDATE fastboat_schedules SET is_active = ? WHERE id = ?',
            [newStatus, id]
        );

        res.json({
            success: true,
            message: `Fastboat schedule ${newStatus ? 'activated' : 'deactivated'} successfully`,
            schedule_id: parseInt(id),
            is_active: newStatus === 1
        });
    } catch (error) {
        console.error('Toggle fastboat schedule error:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

// ==================== FASTBOAT PUBLIC ROUTES ====================

// ============ GET FASTBOAT ROUTES (PUBLIC) ============
app.get('/api/fastboat/routes', async (req, res) => {
    try {
        const [routes] = await pool.execute(
            `SELECT id, pickup_port, dropoff_port, base_price, child_price FROM fastboat_routes WHERE is_active = 1 ORDER BY pickup_port, dropoff_port`
        );

        res.json({
            success: true,
            routes: routes
        });
    } catch (error) {
        console.error('Get fastboat routes error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============ GET FASTBOAT SCHEDULES BY ROUTE (PUBLIC) ============
app.get('/api/fastboat/schedules', [
    query('pickup_port').notEmpty().withMessage('Pickup port required'),
    query('dropoff_port').notEmpty().withMessage('Dropoff port required')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }

    const { pickup_port, dropoff_port } = req.query;

    try {
        const [schedules] = await pool.execute(
            `SELECT fs.id, fs.departure_time, fs.boat_name FROM fastboat_schedules fs JOIN fastboat_routes fr ON fs.route_id = fr.id WHERE fr.pickup_port = ? AND fr.dropoff_port = ? AND fr.is_active = 1 AND fs.is_active = 1 ORDER BY fs.departure_time ASC`,
            [pickup_port, dropoff_port]
        );

        if (schedules.length === 0) {
            return res.status(404).json({
                available: false,
                message: 'No schedules available for this route'
            });
        }

        res.json({
            success: true,
            available: true,
            pickup_port,
            dropoff_port,
            schedules: schedules
        });
    } catch (error) {
        console.error('Get fastboat schedules error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============ GET FASTBOAT PRICE (PUBLIC) ============
app.get('/api/fastboat/price', [
    query('pickup_port').notEmpty().withMessage('Pickup port required'),
    query('dropoff_port').notEmpty().withMessage('Dropoff port required')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }

    const { pickup_port, dropoff_port, adult_count = 1, child_count = 0, is_return = false } = req.query;

    try {
        const [route] = await pool.execute(
            `SELECT id, base_price, child_price FROM fastboat_routes WHERE pickup_port = ? AND dropoff_port = ? AND is_active = 1`,
            [pickup_port, dropoff_port]
        );

        if (route.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Route not found'
            });
        }

        const adultCount = parseInt(adult_count) || 1;
        const childCount = parseInt(child_count) || 0;
        const isReturn = is_return === 'true' || is_return === true;

        const adultPrice = parseFloat(route[0].base_price);
        const childPrice = parseFloat(route[0].child_price) || 0;
        let total = (adultCount * adultPrice) + (childCount * childPrice);

        if (isReturn) {
            total *= 2;
        }

        res.json({
            success: true,
            route: {
                pickup_port,
                dropoff_port,
                base_price: adultPrice,
                child_price: childPrice
            },
            adult_count: adultCount,
            child_count: childCount,
            is_return: isReturn,
            total_price: total,
            currency: 'IDR'
        });
    } catch (error) {
        console.error('Get fastboat price error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something went wrong!' });
});

// ==================== START SERVER ====================
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📧 Email: linkutransport@gmail.com`);
    console.log(`📱 App: Gobali Traveling`);
});