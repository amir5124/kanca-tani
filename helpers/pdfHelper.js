// helpers/pdfHelper.js
const fs = require('fs');
const path = require('path');
const handlebars = require('handlebars');
const puppeteer = require('puppeteer');

// ============ HANDLEBARS HELPERS ============
handlebars.registerHelper('or', function (...args) {
    args.pop();
    return args.some(Boolean);
});

handlebars.registerHelper('multiply', function (a, b) {
    return (parseFloat(a) || 0) * (parseFloat(b) || 0);
});

handlebars.registerHelper('formatRupiah', function (amount) {
    return formatRupiah(amount);
});

handlebars.registerHelper('eq', function(a, b) {
    return a === b;
});

handlebars.registerHelper('year', function() {
    return new Date().getFullYear();
});

function formatRupiah(amount) {
    if (!amount && amount !== 0) return 'Rp 0';
    return new Intl.NumberFormat('id-ID', {
        style: 'currency',
        currency: 'IDR',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
    }).format(amount);
}

// ============================================================
// LANGUAGE HELPERS
// ============================================================
function resolveLang(bookingData) {
    return bookingData && bookingData.language === 'en' ? 'en' : 'id';
}

function localizedTemplateName(baseName, lang) {
    if (lang !== 'en') return baseName;
    const ext = path.extname(baseName);
    const nameNoExt = baseName.slice(0, -ext.length);
    return `${nameNoExt}-en${ext}`;
}

function statusBadge(status, lang) {
    const mapId = {
        pending: '<span class="badge badge-warning">Pending</span>',
        confirmed: '<span class="badge badge-info">Dikonfirmasi</span>',
        completed: '<span class="badge badge-success">Selesai</span>',
        cancelled: '<span class="badge badge-danger">Dibatalkan</span>'
    };
    const mapEn = {
        pending: '<span class="badge badge-warning">Pending</span>',
        confirmed: '<span class="badge badge-info">Confirmed</span>',
        completed: '<span class="badge badge-success">Completed</span>',
        cancelled: '<span class="badge badge-danger">Cancelled</span>'
    };
    const map = lang === 'en' ? mapEn : mapId;
    return map[status] || '<span class="badge badge-info">-</span>';
}

function serviceLabel(serviceType, lang) {
    const mapId = {
        transfer: 'Transfer',
        fastboat: 'Fastboat',
        ticketboat: 'Kapal Tradisional'
    };
    const mapEn = {
        transfer: 'Transfer',
        fastboat: 'Fastboat',
        ticketboat: 'Traditional Boat'
    };
    const map = lang === 'en' ? mapEn : mapId;
    return map[serviceType] || serviceType || '-';
}

function getNationalityLabel(nationality, lang) {
    if (!nationality) return null;
    const mapId = {
        'lokal': 'Lokal (Indonesia)',
        'asing': 'Asing'
    };
    const mapEn = {
        'lokal': 'Local (Indonesia)',
        'asing': 'Foreign'
    };
    const map = lang === 'en' ? mapEn : mapId;
    return map[nationality] || nationality;
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

// ============================================================
// LOAD INVOICE HTML - FIXED
// ============================================================
function loadInvoiceHtml(bookingData) {
    const lang = resolveLang(bookingData);
    const templateFile = localizedTemplateName('invoice.hbs', lang);
    const templatePath = path.join(__dirname, '../templates', templateFile);
    const source = fs.readFileSync(templatePath, 'utf8');
    const template = handlebars.compile(source);

    const serviceType = bookingData.service_type;
    const isFastboat = serviceType === 'fastboat';
    const isTicketboat = serviceType === 'ticketboat';

    // 🔥 FIX: Ambil data fastboat termasuk nationality dan harga asing
    const fbAdultCount = bookingData.fb_adult_count || 0;
    const fbChildCount = bookingData.fb_child_count || 0;
    const fbNationality = bookingData.fb_nationality || null;

    // 🔥 FIX: Price fields untuk fastboat
    let fbPricePerAdult = null;
    let fbPricePerChild = null;
    let fbPricePerAdultAsing = null;
    let fbPricePerChildAsing = null;

    if (isFastboat) {
        fbPricePerAdult = bookingData.fb_price_per_person || null;
        fbPricePerChild = bookingData.fb_child_price_value || null;
        fbPricePerAdultAsing = bookingData.fb_price_per_person_asing || null;
        fbPricePerChildAsing = bookingData.fb_child_price_value_asing || null;
    }

    return template({
        // Identitas booking
        booking_reference: bookingData.booking_reference,
        status: bookingData.status || 'completed',
        status_badge: statusBadge(bookingData.status || 'completed', lang),
        completed_at: lang === 'en'
            ? new Date().toLocaleString('en-US', {
                day: '2-digit', month: 'long', year: 'numeric',
                hour: '2-digit', minute: '2-digit'
            })
            : new Date().toLocaleString('id-ID', {
                day: '2-digit', month: 'long', year: 'numeric',
                hour: '2-digit', minute: '2-digit'
            }),
        service_type: serviceType,
        service_label: serviceLabel(serviceType, lang),
        trip_type: bookingData.trip_type || null,
        depart_datetime: bookingData.depart_datetime || null,
        return_datetime: bookingData.trip_type === 'return' ? (bookingData.return_datetime || null) : null,

        // Data pelanggan
        customer_name: bookingData.customer_name || 'Customer',
        customer_phone: bookingData.customer_phone || null,
        customer_email: bookingData.customer_email || null,

        // Transfer
        pickup_address: serviceType === 'transfer' ? (bookingData.pickup_address || null) : null,
        dropoff_address: serviceType === 'transfer' ? (bookingData.dropoff_address || null) : null,
        distance_km: serviceType === 'transfer' ? (bookingData.distance_km || null) : null,
        duration_minutes: serviceType === 'transfer' ? (bookingData.duration_minutes || null) : null,

        // Fastboat
        fb_pickup_port: isFastboat ? (bookingData.fb_pickup_port || null) : null,
        fb_dropoff_port: isFastboat ? (bookingData.fb_dropoff_port || null) : null,
        fb_depart_date: isFastboat ? (bookingData.fb_depart_date || null) : null,
        fb_depart_slot: isFastboat ? (bookingData.fb_depart_slot || null) : null,
        fb_depart_time: isFastboat ? (bookingData.fb_depart_time || null) : null,
        fb_return_date: isFastboat ? (bookingData.fb_return_date || null) : null,
        fb_return_slot: isFastboat ? (bookingData.fb_return_slot || null) : null,
        fb_return_time: isFastboat ? (bookingData.fb_return_time || null) : null,
        // 🔥 BARU: nationality untuk fastboat
        fb_nationality: fbNationality,
        fb_nationality_label: getNationalityLabel(fbNationality, lang),
        fb_adult_count: fbAdultCount,
        fb_child_count: fbChildCount,
        // 🔥 BARU: harga fastboat
        fb_price_per_adult: fbPricePerAdult,
        fb_price_per_child: fbPricePerChild,
        fb_price_per_adult_asing: fbPricePerAdultAsing,
        fb_price_per_child_asing: fbPricePerChildAsing,

        // Ticket boat
        tb_pickup_location: isTicketboat ? (bookingData.tb_pickup_location || null) : null,
        tb_dropoff_location: isTicketboat ? (bookingData.tb_dropoff_location || null) : null,
        tb_ticket_type: isTicketboat ? (bookingData.tb_ticket_type || null) : null,
        tb_depart_date: isTicketboat ? (bookingData.tb_depart_date || null) : null,
        tb_depart_time: isTicketboat ? (bookingData.tb_depart_time || null) : null,
        tb_return_date: isTicketboat ? (bookingData.tb_return_date || null) : null,
        tb_return_time: isTicketboat ? (bookingData.tb_return_time || null) : null,
        tb_adult_count: bookingData.tb_adult_count || 0,
        tb_child_count: bookingData.tb_child_count || 0,
        tb_total_pax: bookingData.tb_total_pax || null,

        // Ticket boat prices
        tb_price_per_adult: isTicketboat ? (bookingData.tb_price_per_adult || null) : null,
        tb_price_per_child: (isTicketboat && bookingData.tb_child_count)
            ? (bookingData.tb_price_per_child || null) : null,
        tb_port_fee: isTicketboat ? (bookingData.tb_port_fee || null) : null,

        // Total PAX
        total_pax: getTotalPax(bookingData),

        // Rincian biaya
        base_price: serviceType === 'transfer' ? formatRupiah(bookingData.base_price || 0) : null,
        distance_cost: (serviceType === 'transfer' && bookingData.distance_cost)
            ? formatRupiah(bookingData.distance_cost) : null,
        discount_amount: bookingData.discount_amount
            ? formatRupiah(bookingData.discount_amount) : null,
        final_price: formatRupiah(bookingData.final_price || 0),
        admin_commission: bookingData.admin_commission
            ? formatRupiah(bookingData.admin_commission) : null,

        notes: bookingData.notes || null,

        // Info perusahaan
        app_name: 'Gobali Traveling',
        app_address: 'Desa Ketewel, Kec. Sukawati, Kab. Gianyar, Bali 80582',
        app_phone: '+62 812-3456-7890',
        app_email: 'gobali@gmail.com',
        app_website: 'gobalitraveling.com',
        year: new Date().getFullYear()
    });
}

// ============================================================
// GENERATE INVOICE PDF
// ============================================================
async function generateInvoicePDF(bookingData) {
    const html = loadInvoiceHtml(bookingData);

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });

        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '20px', bottom: '20px', left: '20px', right: '20px' }
        });

        return pdfBuffer;
    } finally {
        if (browser) await browser.close();
    }
}

module.exports = { generateInvoicePDF };