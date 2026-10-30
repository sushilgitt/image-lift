import { authenticate } from '../shopify.server';
import { getBillingStateCached } from '../billing.server';
import { entitled } from '../plans.server';
import {
  listProductImages,
  optimizeOneImage,
  finalizeProduct,
} from '../optimize.server';

/**
 * The per-image optimization API the optimizer page drives.
 *
 * A resource route (no default export) so a plain `fetch` gets JSON back,
 * which is what lets the browser run a real queue: ask for a product's
 * images, work through them a few at a time, and update the progress rail on
 * every response — instead of submitting a whole batch through React
 * Router's fetcher and waiting several seconds for the single combined
 * response. App Bridge attaches the session token to same-origin fetches, so
 * `authenticate.admin` works here exactly as it does on the page itself.
 *
 * The page action still exposes the batch path (`optimizeProduct`) —
 * optimizeBatch is also what the products/create webhook uses, and it has no
 * browser to drive it.
 */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function action({ request }) {
  if (request.method !== 'POST') {
    return json({ success: false, error: 'Method not allowed.' }, 405);
  }

  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get('intent');
  const productId = formData.get('productId');

  if (!productId) {
    return json({ success: false, error: 'No product was given.' }, 400);
  }

  try {
    if (intent === 'listImages') {
      const product = await listProductImages(admin, productId);
      if (!product) {
        return json({ success: false, error: 'That product could not be loaded.' }, 404);
      }
      return json({ success: true, ...product });
    }

    if (intent === 'optimizeImage') {
      const imageId = formData.get('imageId');
      if (!imageId) {
        return json({ success: false, error: 'No image was given.' }, 400);
      }
      let mediaOrder = [];
      try {
        const raw = formData.get('mediaOrder');
        if (raw) mediaOrder = JSON.parse(raw);
      } catch { /* order is cosmetic — a bad value just skips repositioning */ }

      // Already cached per shop, so a per-image request doesn't add a billing
      // round-trip.
      const { plan } = await getBillingStateCached(admin, session.shop);
      return json(
        await optimizeOneImage({
          admin,
          productId,
          imageId,
          shop: session.shop,
          plan,
          genAlt: entitled(plan, 'altText'),
          mediaOrder: Array.isArray(mediaOrder) ? mediaOrder : [],
        })
      );
    }

    if (intent === 'finalize') {
      const summary = await finalizeProduct(admin, productId);
      return json({ success: true, summary });
    }

    return json({ success: false, error: `Unknown intent "${intent}".` }, 400);
  } catch (error) {
    const detail = error?.graphQLErrors?.[0]?.message || error?.message || 'unknown error';
    console.error('[api.optimize] %s failed:', intent, detail);
    return json({ success: false, error: detail }, 500);
  }
}
