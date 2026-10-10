declare module "web-push" {
  export interface VapidKeys {
    publicKey: string;
    privateKey: string;
  }

  export interface VapidDetails {
    subject: string;
    publicKey: string;
    privateKey: string;
  }

  export class WebPushError extends Error {
    constructor(message: string, statusCode: number, headers: Record<string, string>, body: string, endpoint: string);
    statusCode: number;
    headers: Record<string, string>;
    body: string;
    endpoint: string;
  }

  export function generateVAPIDKeys(): VapidKeys;
  export function sendNotification(
    subscription: { endpoint: string; keys?: { p256dh?: string; auth?: string } },
    payload?: string | Buffer | null,
    options?: {
      vapidDetails?: VapidDetails;
      contentEncoding?: "aes128gcm" | "aesgcm";
      TTL?: number;
      urgency?: "very-low" | "low" | "normal" | "high";
      topic?: string;
    },
  ): Promise<{ statusCode: number; headers: Record<string, string>; body: string }>;

  const _default: {
    generateVAPIDKeys: typeof generateVAPIDKeys;
    sendNotification: typeof sendNotification;
    supportedContentEncodings: ["aesgcm", "aes128gcm"];
    WebPushError: typeof WebPushError;
  };
  export default _default;
}