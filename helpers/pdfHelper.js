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

function statusBadge(status) {
    const map = {
        pending: '<span class="badge badge-warning">Pending</span>',
        confirmed: '<span class="badge badge-info">Dikonfirmasi</span>',
        completed: '<span class="badge badge-success">Selesai</span>',
        cancelled: '<span class="badge badge-danger">Dibatalkan</span>'
    };
    return map[status] || '<span class="badge badge-info">-</span>';
}

function serviceLabel(serviceType) {
    const map = {
        transfer: 'Transfer',
        fastboat: 'Fastboat',
        ticketboat: 'Ticket Boat'
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

function loadInvoiceHtml(bookingData) {
    const templatePath = path.join(__dirname, '../templates/invoice-template.hbs');
    const source = fs.readFileSync(templatePath, 'utf8');
    const template = handlebars.compile(source);

    return template({
        // Identitas booking
        booking_reference: bookingData.booking_reference,
        status_badge: statusBadge(bookingData.status || 'completed'),
        completed_at: new Date().toLocaleString('id-ID', {
            day: '2-digit', month: 'long', year: 'numeric',
            hour: '2-digit', minute: '2-digit'
        }),
        service_label: serviceLabel(bookingData.service_type),

        // Data pelanggan
        customer_name: bookingData.customer_name || 'Customer',
        customer_phone: bookingData.customer_phone || '-',
        customer_email: bookingData.customer_email || null,

        // Transfer / Fastboat
        pickup_address: bookingData.pickup_address || null,
        dropoff_address: bookingData.dropoff_address || null,
        distance_km: bookingData.distance_km || null,
        duration_minutes: bookingData.duration_minutes || null,

        // Fastboat spesifik
        fb_pickup_port: bookingData.fb_pickup_port || null,
        fb_dropoff_port: bookingData.fb_dropoff_port || null,
        fb_depart_date: bookingData.fb_depart_date || null,
        fb_depart_slot: bookingData.fb_depart_slot || null,
        fb_return_date: bookingData.fb_return_date || null,
        fb_return_slot: bookingData.fb_return_slot || null,
        fb_adult_count: bookingData.fb_adult_count || 0,
        fb_child_count: bookingData.fb_child_count || 0,

        // Ticket boat spesifik
        tb_pickup_location: bookingData.tb_pickup_location || null,
        tb_dropoff_location: bookingData.tb_dropoff_location || null,
        tb_ticket_type: bookingData.tb_ticket_type || null,
        tb_depart_date: bookingData.tb_depart_date || null,
        tb_depart_time: bookingData.tb_depart_time || null,
        tb_return_date: bookingData.tb_return_date || null,
        tb_return_time: bookingData.tb_return_time || null,
        tb_adult_count: bookingData.tb_adult_count || 0,
        tb_child_count: bookingData.tb_child_count || 0,
        tb_total_pax: bookingData.tb_total_pax || null,
        tb_price_per_adult: bookingData.tb_price_per_adult
            ? formatRupiah(bookingData.tb_price_per_adult) : null,
        tb_price_per_child: bookingData.tb_price_per_child
            ? formatRupiah(bookingData.tb_price_per_child) : null,
        tb_port_fee: bookingData.tb_port_fee
            ? formatRupiah(bookingData.tb_port_fee) : null,

        // Total PAX
        total_pax: getTotalPax(bookingData),

        // Rincian biaya
        base_price: formatRupiah(bookingData.base_price || 0),
        distance_cost: bookingData.distance_cost
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