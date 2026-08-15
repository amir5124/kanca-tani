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

// ============================================================
// LANGUAGE HELPERS
// ============================================================
// Normalisasi nilai bahasa dari DB. Default 'id' kalau kosong/tidak valid.
function resolveLang(bookingData) {
    return bookingData && bookingData.language === 'en' ? 'en' : 'id';
}

// Pilih nama file template sesuai bahasa.
// Konvensi: versi Indonesia = nama asli (tanpa suffix),
//           versi Inggris   = nama asli + '-en' sebelum ekstensi.
// Contoh: 'invoice.hbs' -> 'invoice-en.hbs'
function localizedTemplateName(baseName, lang) {
    if (lang !== 'en') return baseName;
    const ext = path.extname(baseName); // '.hbs'
    const nameNoExt = baseName.slice(0, -ext.length);
    return `${nameNoExt}-en${ext}`;
}

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

// Format tanggal saja, mis. "14 Agustus 2026" / "August 14, 2026".
// Mengembalikan null jika kosong, supaya {{#if ...}} di template
// bisa menyembunyikan baris yang tidak relevan.
function formatDate(dateVal, lang) {
    if (!dateVal) return null;
    const d = new Date(dateVal);
    if (isNaN(d.getTime())) return dateVal; // biarkan apa adanya kalau bukan tanggal valid
    if (lang === 'en') {
        return d.toLocaleDateString('en-US', { day: '2-digit', month: 'long', year: 'numeric' });
    }
    return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' });
}

// Format tanggal + jam, mis. "14 Agustus 2026, 14:30" / "August 14, 2026, 2:30 PM"
function formatDateTime(dateVal, lang) {
    if (!dateVal) return null;
    const d = new Date(dateVal);
    if (isNaN(d.getTime())) return dateVal;
    if (lang === 'en') {
        return d.toLocaleString('en-US', {
            day: '2-digit', month: 'long', year: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });
    }
    return d.toLocaleString('id-ID', {
        day: '2-digit', month: 'long', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });
}

function getServiceLabel(serviceType, lang) {
    const mapId = {
        'transfer': 'Transfer',
        'fastboat': 'Fastboat',
        'ticketboat': 'Kapal Tradisional'
    };
    const mapEn = {
        'transfer': 'Transfer',
        'fastboat': 'Fastboat',
        'ticketboat': 'Traditional Boat'
    };
    const map = lang === 'en' ? mapEn : mapId;
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

function getPaymentDeadlineLabel(bookingData, lang) {
    // Kalau caller sudah mengirim payment_deadline eksplisit, hormati itu.
    if (bookingData.payment_deadline) return bookingData.payment_deadline;
    return lang === 'en' ? 'Within 24 hours after confirmation' : '24 jam setelah konfirmasi';
}

/**
 * Bangun field detail perjalanan sesuai service_type.
 * Field yang tidak relevan untuk tipe layanan tsb sengaja diisi `null`
 * (bukan '-') supaya {{#if field}} di template Handlebars menyembunyikannya,
 * bukan malah menampilkan "-".
 */
function buildTripFields(bookingData, lang) {
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
        fields.depart_datetime = formatDateTime(bookingData.depart_datetime, lang);
        if (bookingData.trip_type === 'return') {
            fields.return_datetime = formatDateTime(bookingData.return_datetime, lang);
        }
    } else if (type === 'fastboat') {
        fields.fb_pickup_port = bookingData.fb_pickup_port || null;
        fields.fb_dropoff_port = bookingData.fb_dropoff_port || null;
        fields.fb_depart_date = formatDate(bookingData.fb_depart_date, lang);
        fields.fb_depart_slot = bookingData.fb_depart_slot || null;
        if (bookingData.fb_return_date) {
            fields.fb_return_date = formatDate(bookingData.fb_return_date, lang);
            fields.fb_return_slot = bookingData.fb_return_slot || null;
        }
    } else if (type === 'ticketboat') {
        fields.tb_pickup_location = bookingData.tb_pickup_location || null;
        fields.tb_dropoff_location = bookingData.tb_dropoff_location || null;
        fields.tb_ticket_type = bookingData.tb_ticket_type || null;
        fields.tb_depart_date = formatDate(bookingData.tb_depart_date, lang);
        fields.tb_depart_time = bookingData.tb_depart_time || null;
        if (bookingData.tb_return_date) {
            fields.tb_return_date = formatDate(bookingData.tb_return_date, lang);
            fields.tb_return_time = bookingData.tb_return_time || null;
        }
    }

    return fields;
}

/**
 * Bangun rincian biaya sesuai service_type. Sama seperti buildTripFields,
 * field yang tidak relevan diisi null agar disembunyikan di template.
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
 * Kirim email instruksi pembayaran.
 * Template dipilih otomatis sesuai bookingData.language:
 *   'id' -> templates/payment-instruction.hbs
 *   'en' -> templates/payment-instruction-en.hbs
 */
async function sendPaymentInstruction(email, bookingData) {
    try {
        const lang = resolveLang(bookingData);
        const tripFields = buildTripFields(bookingData, lang);
        const templateFile = localizedTemplateName('payment-instruction.hbs', lang);

        const html = loadTemplate(templateFile, {
            customer_name: bookingData.customer_name || 'Customer',
            booking_reference: bookingData.booking_reference || '-',
            service_type: bookingData.service_type || '-',
            service_label: getServiceLabel(bookingData.service_type, lang),

            ...tripFields,

            total_pax: getTotalPax(bookingData),
            total_price: formatRupiah(bookingData.total_price || 0),
            discount_amount: bookingData.discount_amount ? formatRupiah(bookingData.discount_amount) : null,
            final_price: formatRupiah(bookingData.final_price || 0),
            payment_deadline: getPaymentDeadlineLabel(bookingData, lang),

            app_name: 'Gobali Traveling',
            app_phone: '08216337247',
            app_email: 'info@gobalitraveling.com',
            app_address: 'Desa Ketewel, Kec. Sukawati, Kab. Gianyar, Bali 80582',
            year: new Date().getFullYear()
        });

        const subject = lang === 'en'
            ? `💳 Payment Instruction - ${bookingData.booking_reference}`
            : `💳 Instruksi Pembayaran - ${bookingData.booking_reference}`;

        const mailOptions = {
            from: '"Gobali Traveling" <linkutransport@gmail.com>',
            to: email,
            subject,
            html: html
        };

        const info = await transporter.sendMail(mailOptions);
        console.log(`✅ Payment instruction (${lang}) sent to ${email}:`, info.messageId);
        return { success: true, messageId: info.messageId };
    } catch (error) {
        console.error('❌ Error sending payment instruction email:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Kirim email dengan PDF invoice.
 * Template badan email dipilih otomatis sesuai bookingData.language:
 *   'id' -> templates/invoice.hbs
 *   'en' -> templates/invoice-en.hbs
 * (Catatan: PDF-nya sendiri dibuat terpisah di pdfHelper.js — pastikan
 * pdfHelper juga sudah disesuaikan agar bahasanya konsisten.)
 */
async function sendInvoiceWithPDF(email, bookingData, pdfBuffer) {
    try {
        const lang = resolveLang(bookingData);
        const tripFields = buildTripFields(bookingData, lang);
        const priceFields = buildPriceFields(bookingData);
        const templateFile = localizedTemplateName('invoice.hbs', lang);

        const html = loadTemplate(templateFile, {
            booking_reference: bookingData.booking_reference || '-',
            customer_name: bookingData.customer_name || 'Customer',
            customer_phone: bookingData.customer_phone || null,
            customer_email: bookingData.customer_email || null,
            service_type: bookingData.service_type || '-',
            service_label: getServiceLabel(bookingData.service_type, lang),

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
            completed_at: lang === 'en'
                ? new Date().toLocaleString('en-US', {
                    day: '2-digit', month: 'long', year: 'numeric',
                    hour: '2-digit', minute: '2-digit'
                })
                : new Date().toLocaleString('id-ID', {
                    day: '2-digit', month: 'long', year: 'numeric',
                    hour: '2-digit', minute: '2-digit'
                }),

            app_name: 'Gobali Traveling',
            app_phone: '08216337247',
            app_email: 'info@gobalitraveling.com',
            app_address: 'Desa Ketewel, Kec. Sukawati, Kab. Gianyar, Bali 80582',
            year: new Date().getFullYear()
        });

        const subject = lang === 'en'
            ? `🧾 Invoice - ${bookingData.booking_reference}`
            : `🧾 Invoice - ${bookingData.booking_reference}`;

        const mailOptions = {
            from: '"Gobali Traveling" <linkutransport@gmail.com>',
            to: email,
            subject,
            html: html,
            attachments: [{
                filename: `invoice-${bookingData.booking_reference}.pdf`,
                content: pdfBuffer,
                contentType: 'application/pdf',
            }]
        };

        const info = await transporter.sendMail(mailOptions);
        console.log(`✅ Invoice PDF (${lang}) sent to ${email}:`, info.messageId);
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