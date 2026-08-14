// helpers/emailHelper.js
const nodemailer = require('nodemailer');
const handlebars = require('handlebars');
const fs = require('fs');
const path = require('path');

const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
        user: 'linkutransport@gmail.com',
        pass: 'qbckptzxgdumxtdm'
    }
});

// Register Handlebars helpers
handlebars.registerHelper('eq', function(a, b) {
    return a === b;
});

handlebars.registerHelper('year', function() {
    return new Date().getFullYear();
});

function loadTemplate(templateName, data) {
    const possiblePaths = [
        path.join(__dirname, '../templates', templateName),
        path.join(__dirname, '../templates', templateName.replace('-email', '')),
        path.join(__dirname, '..', 'templates', templateName),
    ];

    let source = null;
    let usedPath = null;

    for (const templatePath of possiblePaths) {
        try {
            if (fs.existsSync(templatePath)) {
                source = fs.readFileSync(templatePath, 'utf8');
                usedPath = templatePath;
                break;
            }
        } catch (error) {
            // Lanjut ke path berikutnya
        }
    }

    if (!source) {
        throw new Error(`Template not found: ${templateName}`);
    }

    console.log(`📄 Using template: ${usedPath}`);
    const template = handlebars.compile(source);
    return template(data);
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

// Format tanggal saja, mis. "14 Agustus 2026". Mengembalikan null jika kosong,
// supaya {{#if ...}} di template bisa menyembunyikan baris yang tidak relevan.
function formatDate(dateVal) {
    if (!dateVal) return null;
    const d = new Date(dateVal);
    if (isNaN(d.getTime())) return dateVal; // biarkan apa adanya kalau bukan tanggal valid
    return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' });
}

// Format tanggal + jam, mis. "14 Agustus 2026, 14:30"
function formatDateTime(dateVal) {
    if (!dateVal) return null;
    const d = new Date(dateVal);
    if (isNaN(d.getTime())) return dateVal;
    return d.toLocaleString('id-ID', {
        day: '2-digit', month: 'long', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });
}

function getServiceLabel(serviceType) {
    const map = {
        'transfer': 'Transfer',
        'fastboat': 'Fastboat',
        'ticketboat': 'Traditional Boat'
    };
    return map[serviceType] || serviceType || '-';
}

function getTotalPax(bookingData) {
    if (bookingData.service_type === 'ticketboat') {
        return bookingData.tb_total_pax || 0;
    }
    if (bookingData.service_type === 'fastboat') {
        return (bookingData.fb_adult_count || 0) + (bookingData.fb_child_count || 0);
    }
    return 1;
}

/**
 * Bangun field detail perjalanan sesuai service_type.
 * Field yang tidak relevan untuk tipe layanan tsb sengaja diisi `null`
 * (bukan '-') supaya {{#if field}} di template Handlebars menyembunyikannya,
 * bukan malah menampilkan "-".
 */
function buildTripFields(bookingData) {
    const type = bookingData.service_type;

    const fields = {
        // Transfer
        pickup_address: null,
        dropoff_address: null,
        distance_km: null,
        duration_minutes: null,
        depart_datetime: null,
        return_datetime: null,

        // Fastboat
        fb_pickup_port: null,
        fb_dropoff_port: null,
        fb_depart_date: null,
        fb_depart_slot: null,
        fb_return_date: null,
        fb_return_slot: null,

        // Ticket boat
        tb_pickup_location: null,
        tb_dropoff_location: null,
        tb_ticket_type: null,
        tb_depart_date: null,
        tb_depart_time: null,
        tb_return_date: null,
        tb_return_time: null,
    };

    if (type === 'transfer') {
        fields.pickup_address = bookingData.pickup_address || null;
        fields.dropoff_address = bookingData.dropoff_address || null;
        fields.distance_km = bookingData.distance_km || null;
        fields.duration_minutes = bookingData.duration_minutes || null;
        fields.depart_datetime = formatDateTime(bookingData.depart_datetime);
        if (bookingData.trip_type === 'return') {
            fields.return_datetime = formatDateTime(bookingData.return_datetime);
        }
    } else if (type === 'fastboat') {
        fields.fb_pickup_port = bookingData.fb_pickup_port || null;
        fields.fb_dropoff_port = bookingData.fb_dropoff_port || null;
        fields.fb_depart_date = formatDate(bookingData.fb_depart_date);
        fields.fb_depart_slot = bookingData.fb_depart_slot || null;
        if (bookingData.fb_return_date) {
            fields.fb_return_date = formatDate(bookingData.fb_return_date);
            fields.fb_return_slot = bookingData.fb_return_slot || null;
        }
    } else if (type === 'ticketboat') {
        fields.tb_pickup_location = bookingData.tb_pickup_location || null;
        fields.tb_dropoff_location = bookingData.tb_dropoff_location || null;
        fields.tb_ticket_type = bookingData.tb_ticket_type || null;
        fields.tb_depart_date = formatDate(bookingData.tb_depart_date);
        fields.tb_depart_time = bookingData.tb_depart_time || null;
        if (bookingData.tb_return_date) {
            fields.tb_return_date = formatDate(bookingData.tb_return_date);
            fields.tb_return_time = bookingData.tb_return_time || null;
        }
    }

    return fields;
}

/**
 * Bangun rincian biaya sesuai service_type. Sama seperti buildTripFields,
 * field yang tidak relevan diisi null agar disembunyikan di template.
 * Harga per-unit (tb_price_per_adult, dll) dikirim sebagai ANGKA MENTAH
 * (bukan string yang sudah diformat) supaya helper `multiply` di Handlebars
 * bisa menghitungnya dengan benar; formatnya dilakukan di template
 * lewat helper {{formatRupiah ...}}.
 */
function buildPriceFields(bookingData) {
    const type = bookingData.service_type;

    const fields = {
        base_price: formatRupiah(bookingData.base_price || 0),
        distance_cost: null,
        tb_price_per_adult: null,
        tb_price_per_child: null,
        tb_port_fee: null,
        discount_amount: bookingData.discount_amount ? formatRupiah(bookingData.discount_amount) : null,
        final_price: formatRupiah(bookingData.final_price || 0),
        admin_commission: bookingData.admin_commission ? formatRupiah(bookingData.admin_commission) : null,
    };

    if (type === 'transfer') {
        fields.distance_cost = bookingData.distance_cost ? formatRupiah(bookingData.distance_cost) : null;
    } else if (type === 'ticketboat') {
        fields.tb_price_per_adult = bookingData.tb_price_per_adult || null;
        fields.tb_price_per_child = bookingData.tb_child_count ? (bookingData.tb_price_per_child || null) : null;
        fields.tb_port_fee = bookingData.tb_port_fee || null;
    }

    return fields;
}

/**
 * Kirim email instruksi pembayaran
 * 🔥 Gunakan template 'payment-instruction.hbs'
 */
async function sendPaymentInstruction(email, bookingData) {
    try {
        const tripFields = buildTripFields(bookingData);

        const html = loadTemplate('payment-instruction.hbs', {
            customer_name: bookingData.customer_name || 'Customer',
            booking_reference: bookingData.booking_reference || '-',
            service_type: bookingData.service_type || '-',
            service_label: getServiceLabel(bookingData.service_type),

            ...tripFields,

            total_pax: getTotalPax(bookingData),
            total_price: formatRupiah(bookingData.total_price || 0),
            discount_amount: bookingData.discount_amount ? formatRupiah(bookingData.discount_amount) : null,
            final_price: formatRupiah(bookingData.final_price || 0),
            payment_deadline: bookingData.payment_deadline || 'Saat keberangkatan',

            app_name: 'Gobali Traveling',
            app_phone: '081234567890',
            app_email: 'info@gobalitraveling.com',
            app_address: 'Desa Ketewel, Kec. Sukawati, Kab. Gianyar, Bali 80582',
            year: new Date().getFullYear()
        });

        const mailOptions = {
            from: '"Gobali Traveling" <linkutransport@gmail.com>',
            to: email,
            subject: `💳 Payment Instruction - ${bookingData.booking_reference}`,
            html: html
        };

        const info = await transporter.sendMail(mailOptions);
        console.log(`✅ Payment instruction sent to ${email}:`, info.messageId);
        return { success: true, messageId: info.messageId };
    } catch (error) {
        console.error('❌ Error sending payment instruction email:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Kirim email dengan PDF invoice
 * 🔥 Gunakan template 'invoice.hbs'
 *
 * Catatan: template 'invoice.hbs' (badan email, bukan PDF-nya) tidak
 * disertakan saat perbaikan ini dibuat. Data di bawah sudah disusun
 * dengan pola null-fallback per service_type; sesuaikan blok
 * {{#if ...}} di 'templates/invoice.hbs' agar konsisten dengan
 * 'invoice-template.hbs' (lihat versi yang sudah diperbaiki).
 */
async function sendInvoiceWithPDF(email, bookingData, pdfBuffer) {
    try {
        const tripFields = buildTripFields(bookingData);
        const priceFields = buildPriceFields(bookingData);

        const html = loadTemplate('invoice.hbs', {
            booking_reference: bookingData.booking_reference || '-',
            customer_name: bookingData.customer_name || 'Customer',
            customer_phone: bookingData.customer_phone || null,
            customer_email: bookingData.customer_email || null,
            service_type: bookingData.service_type || '-',
            service_label: getServiceLabel(bookingData.service_type),

            ...tripFields,
            ...priceFields,

            tb_adult_count: bookingData.tb_adult_count || 0,
            tb_child_count: bookingData.tb_child_count || 0,
            tb_total_pax: bookingData.tb_total_pax || 0,
            fb_adult_count: bookingData.fb_adult_count || 0,
            fb_child_count: bookingData.fb_child_count || 0,
            total_pax: getTotalPax(bookingData),

            total_price: formatRupiah(bookingData.total_price || 0),
            status: bookingData.status || 'pending',
            completed_at: new Date().toLocaleString('id-ID', {
                day: '2-digit', month: 'long', year: 'numeric',
                hour: '2-digit', minute: '2-digit'
            }),

            app_name: 'Gobali Traveling',
            app_phone: '081234567890',
            app_email: 'info@gobalitraveling.com',
            app_address: 'Desa Ketewel, Kec. Sukawati, Kab. Gianyar, Bali 80582',
            year: new Date().getFullYear()
        });

        const mailOptions = {
            from: '"Gobali Traveling" <linkutransport@gmail.com>',
            to: email,
            subject: `🧾 Invoice - ${bookingData.booking_reference}`,
            html: html,
            attachments: [{
                filename: `invoice-${bookingData.booking_reference}.pdf`,
                content: pdfBuffer,
                contentType: 'application/pdf',
            }]
        };

        const info = await transporter.sendMail(mailOptions);
        console.log(`✅ Invoice PDF sent to ${email}:`, info.messageId);
        return { success: true, messageId: info.messageId };
    } catch (error) {
        console.error('❌ Error sending invoice email:', error);
        return { success: false, error: error.message };
    }
}

module.exports = { 
    sendPaymentInstruction, 
    sendInvoiceWithPDF 
};