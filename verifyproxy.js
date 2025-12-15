import crypto from 'crypto';

export default function verifyProxy(req) {
  const { signature, ...params } = req.query;

  if (!signature) return false;

  const message = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('');

  const generatedSignature = crypto
    .createHmac('sha256', process.env.SHOPIFY_APP_SECRET)
    .update(message)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(generatedSignature, 'utf8'),
      Buffer.from(signature, 'utf8')
    );
  } catch {
    return false;
  }
}
