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

function getServiceLabel(serviceType) {
    const map = {
        'transfer': 'Transfer',
        'fastboat': 'Fastboat',
        'ticketboat': 'Ticket Boat'
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
 * Kirim email instruksi pembayaran
 * 🔥 Gunakan template 'payment-instruction.hbs'
 */
async function sendPaymentInstruction(email, bookingData) {
    try {
        const html = loadTemplate('payment-instruction.hbs', {
            customer_name: bookingData.customer_name || 'Customer',
            booking_reference: bookingData.booking_reference || '-',
            service_type: bookingData.service_type || '-',
            service_label: getServiceLabel(bookingData.service_type),
            depart_datetime: bookingData.depart_datetime || '-',
            return_datetime: bookingData.return_datetime || '-',
            pickup_address: bookingData.pickup_address || '-',
            dropoff_address: bookingData.dropoff_address || '-',
            tb_pickup_location: bookingData.tb_pickup_location || '-',
            tb_dropoff_location: bookingData.tb_dropoff_location || '-',
            tb_ticket_type: bookingData.tb_ticket_type || '-',
            total_pax: getTotalPax(bookingData),
            total_price: formatRupiah(bookingData.total_price || 0),
            discount_amount: formatRupiah(bookingData.discount_amount || 0),
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
 */
async function sendInvoiceWithPDF(email, bookingData, pdfBuffer) {
    try {
        const html = loadTemplate('invoice.hbs', {
            booking_reference: bookingData.booking_reference || '-',
            customer_name: bookingData.customer_name || 'Customer',
            customer_phone: bookingData.customer_phone || '-',
            customer_email: bookingData.customer_email || '-',
            service_type: bookingData.service_type || '-',
            service_label: getServiceLabel(bookingData.service_type),
            total_price: formatRupiah(bookingData.total_price || 0),
            final_price: formatRupiah(bookingData.final_price || 0),
            discount_amount: formatRupiah(bookingData.discount_amount || 0),
            base_price: formatRupiah(bookingData.base_price || 0),
            depart_datetime: bookingData.depart_datetime || '-',
            return_datetime: bookingData.return_datetime || '-',
            pickup_address: bookingData.pickup_address || '-',
            dropoff_address: bookingData.dropoff_address || '-',
            distance_km: bookingData.distance_km || '-',
            tb_pickup_location: bookingData.tb_pickup_location || '-',
            tb_dropoff_location: bookingData.tb_dropoff_location || '-',
            tb_ticket_type: bookingData.tb_ticket_type || '-',
            tb_adult_count: bookingData.tb_adult_count || 0,
            tb_child_count: bookingData.tb_child_count || 0,
            tb_total_pax: bookingData.tb_total_pax || 0,
            fb_adult_count: bookingData.fb_adult_count || 0,
            fb_child_count: bookingData.fb_child_count || 0,
            total_pax: getTotalPax(bookingData),
            status: bookingData.status || 'pending',
            completed_at: new Date().toLocaleString('id-ID', {
                day: '2-digit', month: 'long', year: 'numeric',
                hour: '2-digit', minute: '2-digit'
            }),
            app_name: 'Gobali Traveling',
            app_phone: '081234567890',
            app_email: 'info@gobalitraveling.com',
            app_address: 'Desa Ketewel, Kec. Sukawati, Kab. Gianyar, Bali 80582',
            admin_commission: formatRupiah(bookingData.admin_commission || 0),
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