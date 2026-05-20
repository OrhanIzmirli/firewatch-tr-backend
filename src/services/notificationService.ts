import * as admin from 'firebase-admin';
import * as path from 'path';

// Firebase initialization
const serviceAccountPath = process.env.FIREBASE_CREDENTIALS_PATH || './firewatch-tr-firebase-adminsdk-fbsvc-9604dc98c3.json';

try {
  admin.initializeApp({
    credential: admin.credential.cert(require(path.resolve(serviceAccountPath))),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  });
  console.log(' Firebase initialized');
} catch (error) {
  console.error(' Firebase initialization error:', error);
}

class NotificationService {
  // Send notification to specific token
  async sendToToken(token: string, title: string, body: string, data?: any): Promise<boolean> {
    try {
      const message = {
        notification: {
          title,
          body,
        },
        data: data || {},
        token,
      };

      const response = await admin.messaging().send(message);
      console.log(' Message sent:', response);
      return true;
    } catch (error) {
      console.error(' Error sending message:', error);
      return false;
    }
  }

  // Send notification to multiple tokens
  async sendToTokens(tokens: string[], title: string, body: string, data?: any): Promise<number> {
    try {
      const message = {
        notification: {
          title,
          body,
        },
        data: data || {},
      };

      const response = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: message.notification,
      data: message.data,
    });

      console.log(` Sent to ${response.successCount} devices`);
      return response.successCount;
    } catch (error) {
      console.error(' Error sending multicast:', error);
      return 0;
    }
  }

  // Send to topic
  async sendToTopic(topic: string, title: string, body: string, data?: any): Promise<boolean> {
    try {
      const message = {
        notification: {
          title,
          body,
        },
        data: data || {},
        topic,
      };

      const response = await admin.messaging().send(message);
      console.log(' Message sent to topic:', response);
      return true;
    } catch (error) {
      console.error(' Error sending to topic:', error);
      return false;
    }
  }
}

export default new NotificationService();
export { admin };