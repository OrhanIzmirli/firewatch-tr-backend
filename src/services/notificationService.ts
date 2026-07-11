import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';

// Firebase initialization - Base64 env variable'dan oku
try {
  const base64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;

  if (base64) {
    const serviceAccount = JSON.parse(
      Buffer.from(base64, 'base64').toString('utf-8')
    );

    if (getApps().length === 0) {
      initializeApp({
        credential: cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DATABASE_URL,
      });
    }
    console.log('✅ Firebase initialized');
  } else {
    console.warn('⚠️ FIREBASE_SERVICE_ACCOUNT_BASE64 not found - Firebase disabled');
  }
} catch (error) {
  console.error('❌ Firebase initialization error:', error);
}

class NotificationService {
  async sendToToken(token: string, title: string, body: string, data?: any): Promise<boolean> {
    try {
      const message = {
        notification: { title, body },
        data: data || {},
        token,
      };
      const response = await getMessaging().send(message);
      console.log('✅ Message sent:', response);
      return true;
    } catch (error) {
      console.error('❌ Error sending message:', error);
      return false;
    }
  }

  async sendToTokens(tokens: string[], title: string, body: string, data?: any): Promise<number> {
    try {
      const response = await getMessaging().sendEachForMulticast({
        tokens,
        notification: { title, body },
        data: data || {},
      });
      console.log(`✅ Sent to ${response.successCount} devices`);
      return response.successCount;
    } catch (error) {
      console.error('❌ Error sending multicast:', error);
      return 0;
    }
  }

  async sendToTopic(topic: string, title: string, body: string, data?: any): Promise<boolean> {
    try {
      const message = {
        notification: { title, body },
        data: data || {},
        topic,
      };
      const response = await getMessaging().send(message);
      console.log('✅ Message sent to topic:', response);
      return true;
    } catch (error) {
      console.error('❌ Error sending to topic:', error);
      return false;
    }
  }
}

export default new NotificationService();
