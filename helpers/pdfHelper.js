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
        ticketboat: 'Traditional Boat'
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
    const templatePath = path.join(__dirname, '../templates/invoice.hbs');
    const source = fs.readFileSync(templatePath, 'utf8');
    const template = handlebars.compile(source);

    const serviceType = bookingData.service_type;

    return template({
        // Identitas booking
        booking_reference: bookingData.booking_reference,
        status: bookingData.status || 'completed',
        status_badge: statusBadge(bookingData.status || 'completed'),
        completed_at: new Date().toLocaleString('id-ID', {
            day: '2-digit', month: 'long', year: 'numeric',
            hour: '2-digit', minute: '2-digit'
        }),
        service_type: serviceType,
        service_label: serviceLabel(serviceType),
        trip_type: bookingData.trip_type || null,
        depart_datetime: bookingData.depart_datetime || null,
        return_datetime: bookingData.trip_type === 'return' ? (bookingData.return_datetime || null) : null,

        // Data pelanggan
        customer_name: bookingData.customer_name || 'Customer',
        customer_phone: bookingData.customer_phone || null,
        customer_email: bookingData.customer_email || null,

        // Transfer -- hanya diisi kalau service_type transfer
        pickup_address: serviceType === 'transfer' ? (bookingData.pickup_address || null) : null,
        dropoff_address: serviceType === 'transfer' ? (bookingData.dropoff_address || null) : null,
        distance_km: serviceType === 'transfer' ? (bookingData.distance_km || null) : null,
        duration_minutes: serviceType === 'transfer' ? (bookingData.duration_minutes || null) : null,

        // Fastboat -- hanya diisi kalau service_type fastboat
        fb_pickup_port: serviceType === 'fastboat' ? (bookingData.fb_pickup_port || null) : null,
        fb_dropoff_port: serviceType === 'fastboat' ? (bookingData.fb_dropoff_port || null) : null,
        fb_depart_date: serviceType === 'fastboat' ? (bookingData.fb_depart_date || null) : null,
        fb_depart_slot: serviceType === 'fastboat' ? (bookingData.fb_depart_slot || null) : null,
        fb_depart_time: serviceType === 'fastboat' ? (bookingData.fb_depart_time || null) : null,
        fb_return_date: serviceType === 'fastboat' ? (bookingData.fb_return_date || null) : null,
        fb_return_slot: serviceType === 'fastboat' ? (bookingData.fb_return_slot || null) : null,
        fb_return_time: serviceType === 'fastboat' ? (bookingData.fb_return_time || null) : null,
        fb_nationality: serviceType === 'fastboat' ? (bookingData.fb_nationality || null) : null,
        fb_adult_count: bookingData.fb_adult_count || 0,
        fb_child_count: bookingData.fb_child_count || 0,

        // Ticket boat -- hanya diisi kalau service_type ticketboat
        tb_pickup_location: serviceType === 'ticketboat' ? (bookingData.tb_pickup_location || null) : null,
        tb_dropoff_location: serviceType === 'ticketboat' ? (bookingData.tb_dropoff_location || null) : null,
        tb_ticket_type: serviceType === 'ticketboat' ? (bookingData.tb_ticket_type || null) : null,
        tb_depart_date: serviceType === 'ticketboat' ? (bookingData.tb_depart_date || null) : null,
        tb_depart_time: serviceType === 'ticketboat' ? (bookingData.tb_depart_time || null) : null,
        tb_return_date: serviceType === 'ticketboat' ? (bookingData.tb_return_date || null) : null,
        tb_return_time: serviceType === 'ticketboat' ? (bookingData.tb_return_time || null) : null,
        tb_adult_count: bookingData.tb_adult_count || 0,
        tb_child_count: bookingData.tb_child_count || 0,
        tb_total_pax: bookingData.tb_total_pax || null,

        // PENTING: kirim angka MENTAH (bukan string yang sudah diformat)
        // supaya helper {{multiply}} di template bisa menghitung dengan benar.
        // Formatnya dilakukan di template lewat {{formatRupiah ...}}.
        tb_price_per_adult: serviceType === 'ticketboat' ? (bookingData.tb_price_per_adult || null) : null,
        tb_price_per_child: (serviceType === 'ticketboat' && bookingData.tb_child_count)
            ? (bookingData.tb_price_per_child || null) : null,
        tb_port_fee: serviceType === 'ticketboat' ? (bookingData.tb_port_fee || null) : null,

        // Total PAX
        total_pax: getTotalPax(bookingData),

        // Rincian biaya
        // "Harga Dasar" hanya berlaku untuk transfer; fastboat & ticketboat
        // punya rincian harga sendiri (atau tidak ditampilkan sama sekali).
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