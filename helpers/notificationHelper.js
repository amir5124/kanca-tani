// helpers/notificationHelper.js
const { messaging } = require('../config/firebase');
const { pool } = require('../config/db');

/**
 * 🔥 Convert semua nilai di object data menjadi string
 * Firebase FCM hanya menerima string values
 */
function sanitizeData(data) {
    if (!data) return {};
    const sanitized = {};
    for (const [key, value] of Object.entries(data)) {
        if (value === null || value === undefined) {
            sanitized[key] = '';
        } else if (typeof value === 'object') {
            sanitized[key] = JSON.stringify(value);
        } else {
            sanitized[key] = String(value);
        }
    }
    return sanitized;
}

/**
 * Get all active FCM tokens for a user
 */
async function getUserFcmTokens(userId) {
    try {
        const [rows] = await pool.execute(
            `SELECT fcm_token FROM user_devices 
             WHERE user_id = ? AND is_active = TRUE`,
            [userId]
        );
        return rows.map(row => row.fcm_token);
    } catch (error) {
        console.error('❌ Error getting FCM tokens:', error);
        return [];
    }
}

/**
 * Send notification to single device
 */
async function sendNotificationToDevice(fcmToken, title, body, data = {}) {
    try {
        // 🔥 Sanitize data - semua nilai harus string
        const sanitizedData = sanitizeData(data);

        const message = {
            notification: {
                title: title,
                body: body,
            },
            data: sanitizedData,  // ✅ Semua nilai sudah string
            token: fcmToken,
            android: {
                priority: 'high',
                notification: {
                    sound: 'default',
                    channelId: 'default',
                },
            },
            apns: {
                payload: {
                    aps: {
                        sound: 'default',
                        badge: 1,
                    },
                },
            },
        };

        const response = await messaging.send(message);
        console.log('✅ Notification sent to:', fcmToken.substring(0, 20) + '...');
        return { success: true, response };
    } catch (error) {
        console.error('❌ Error sending notification:', error.message);

        // Jika token invalid, nonaktifkan
        if (error.code === 'messaging/registration-token-not-registered') {
            try {
                await pool.execute(
                    'UPDATE user_devices SET is_active = FALSE WHERE fcm_token = ?',
                    [fcmToken]
                );
                console.log(`⚠️ Token ${fcmToken.substring(0, 20)}... marked as inactive`);
            } catch (dbError) {
                console.error('❌ Error updating token status:', dbError);
            }
        }

        return { success: false, error: error.message };
    }
}

/**
 * Send notification to all devices of a user
 */
async function sendNotificationToUser(userId, title, body, data = {}) {
    try {
        const tokens = await getUserFcmTokens(userId);
        
        if (tokens.length === 0) {
            console.log(`ℹ️ No active tokens found for user ${userId}`);
            return { success: false, message: 'No active tokens' };
        }

        console.log(`📨 Sending to user ${userId}, ${tokens.length} device(s)`);

        const results = await Promise.all(
            tokens.map(token => sendNotificationToDevice(token, title, body, data))
        );

        const successCount = results.filter(r => r.success).length;
        const failCount = results.length - successCount;

        console.log(`📨 Notifications sent: ${successCount} success, ${failCount} failed`);
        
        return {
            success: true,
            total: tokens.length,
            successCount,
            failCount,
            results,
        };
    } catch (error) {
        console.error('❌ Error sending notification to user:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Send notification to multiple users
 */
async function sendNotificationToUsers(userIds, title, body, data = {}) {
    try {
        const results = await Promise.all(
            userIds.map(userId => sendNotificationToUser(userId, title, body, data))
        );

        return {
            success: true,
            total_users: userIds.length,
            results,
        };
    } catch (error) {
        console.error('❌ Error sending notifications to users:', error);
        return { success: false, error: error.message };
    }
}

module.exports = {
    getUserFcmTokens,
    sendNotificationToDevice,
    sendNotificationToUser,
    sendNotificationToUsers,
};