// Image-optimization pipeline (server only).
//
// Extracted from app/routes/app.Productoptimization.jsx so it can be shared by
// both the interactive optimizer route AND the background products/create
// webhook. Everything here runs server-side (uses sharp + node DNS).
//
// optimizeBatch processes ONE batch of a product's images per call and persists
// per-image + summary metafields. Callers loop it until { done: true }. It also
// enforces the per-shop monthly image quota: pass { shop, remainingQuota } and it
// caps the batch, meters usage, and reports { quotaExceeded } when the cap is hit
// with images still pending.
import sharp from "sharp";
import { setDefaultResultOrder } from "node:dns";
import { incrementUsage, reserveImages, refundImages } from "./usage.server";
import db from "./db.server";

/* -------------------------------------------------------------------------- */
/*  Networking helpers                                                        */
/* -------------------------------------------------------------------------- */

// The container was hanging ~10s per image on IPv6 connect attempts to the
// Shopify CDN (ConnectTimeoutError to 2620:127:f00e::). Prefer IPv4 so fetch
// connects to the reachable address first, and cap every CDN request with an
// explicit timeout so a single bad fetch can never stall the loader or a batch.
let dnsConfigured = false;
function preferIPv4() {
  if (dnsConfigured) return;
  try { setDefaultResultOrder("ipv4first"); } catch { /* older runtimes */ }
  dnsConfigured = true;
}

export async function timedFetch(url, opts = {}, timeoutMs = 20000) {
  preferIPv4();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Run async `fn` over `items` with at most `limit` in flight at once.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) break;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

// Cheaply measure an image's size in bytes via a HEAD request (no body download).
export async function headSizeBytes(url) {
  try {
    const res = await timedFetch(url, { method: "HEAD" }, 8000);
    if (!res.ok) return 0;
    const cl = res.headers.get("content-length");
    return cl ? parseInt(cl, 10) : 0;
  } catch {
    return 0;
  }
}

export async function headSizeMB(url) {
  return (await headSizeBytes(url)) / (1024 * 1024);
}

// Resolve many image sizes at once, in MB, keyed by url.
//
// This replaces a HEAD request per image on every product-list render. Sizes are
// read from the ImageSize cache first and only the misses go over the network;
// because a Shopify CDN url changes whenever its bytes change, a hit is always
// correct. The cache write is best-effort — if the table isn't migrated yet the
// whole thing silently degrades to the old measure-everything behaviour.
export async function measureSizesMB(urls, concurrency = 24) {
  const unique = [...new Set(urls.filter(Boolean))];
  const bytesByUrl = new Map();
  if (unique.length === 0) return bytesByUrl;

  // Chunked so a large catalog can't build a single enormous IN (...) query.
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500);
    try {
      const rows = await db.imageSize.findMany({ where: { url: { in: chunk } } });
      for (const row of rows) bytesByUrl.set(row.url, row.bytes);
    } catch {
      break; // table unavailable — measure everything below
    }
  }

  const missing = unique.filter((u) => !bytesByUrl.has(u));
  if (missing.length > 0) {
    const measured = await mapLimit(missing, concurrency, headSizeBytes);
    const rows = [];
    missing.forEach((url, i) => {
      const bytes = measured[i] || 0;
      bytesByUrl.set(url, bytes);
      if (bytes > 0) rows.push({ url, bytes });
    });
    if (rows.length > 0) {
      try {
        await db.imageSize.createMany({ data: rows, skipDuplicates: true });
      } catch { /* caching is an optimization, never a failure path */ }
    }
  }

  const mbByUrl = new Map();
  for (const [url, bytes] of bytesByUrl) mbByUrl.set(url, bytes / (1024 * 1024));
  return mbByUrl;
}

export const BATCH_SIZE = 6;          // images optimized per batch call
export const BATCH_CONCURRENCY = 6;   // images processed in parallel within a batch

/* -------------------------------------------------------------------------- */
/*  Optimization primitives                                                   */
/* -------------------------------------------------------------------------- */

// Download + compress one image with Sharp. Always re-encodes to WebP, which
// reliably beats JPEG/PNG (typically 25-40% smaller at q80). Retries the
// download once to ride out transient CDN blips.
export async function optimizeImage(imageUrl) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await timedFetch(imageUrl, {}, 25000);
      if (!response.ok) throw new Error(`Fetch image HTTP ${response.status}`);
      const originalBuffer = Buffer.from(await response.arrayBuffer());
      const originalSizeMB = originalBuffer.byteLength / (1024 * 1024);

      const optimizedBuffer = await sharp(originalBuffer)
        .rotate() // honor EXIF orientation before stripping metadata
        .resize(2048, 2048, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 80, effort: 4 })
        .toBuffer();

      const optimizedSizeMB = optimizedBuffer.byteLength / (1024 * 1024);
      return {
        originalSizeMB,
        optimizedSizeMB,
        optimizedBuffer,
        compressionRate: originalSizeMB > 0
          ? Math.round(((originalSizeMB - optimizedSizeMB) / originalSizeMB) * 100)
          : 0,
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/* -------------------------------------------------------------------------- */
/*  Per-product media mutation lock                                          */
/* -------------------------------------------------------------------------- */

// Shopify locks a product's media while a mutation on it is in flight, and
// rejects a second concurrent one with "Media cannot be modified at this
// moment because it is currently being modified by another operation". Several
// images of the SAME product can be optimizing at once, so their
// productCreateMedia / productDeleteMedia calls would collide without this —
// images failed mid-run and only succeeded on a re-click.
//
// The expensive work (download + WebP encode, and the staged upload) stays
// parallel; only the media MUTATION needs to be serialized, and only against
// other mutations on the same product. This is a per-productId promise chain:
// a mutation waits for the previous one on that product to finish, then runs.
const productMediaChains = new Map(); // productId -> Promise (tail of the chain)

function withProductMediaLock(productId, task) {
  const prev = productMediaChains.get(productId) || Promise.resolve();
  // Run `task` after the previous holder settles, whether it resolved or threw
  // — one image's failure must not wedge the rest of the product's queue.
  const run = prev.then(task, task);
  // The stored tail swallows errors so the chain never rejects; callers still
  // see the real result/rejection through `run`.
  const tail = run.then(() => {}, () => {});
  productMediaChains.set(productId, tail);
  // Drop the map entry once this product's queue drains, so the Map can't grow
  // without bound across a large catalog — but only if no newer mutation has
  // already replaced the tail.
  tail.finally(() => {
    if (productMediaChains.get(productId) === tail) productMediaChains.delete(productId);
  });
  return run;
}

/* -------------------------------------------------------------------------- */
/*  Swapping an original for its optimized copy                              */
/* -------------------------------------------------------------------------- */

// Upload the optimized buffer and swap it in for `oldMediaId` on the product,
// keeping variant images and position intact.
//
// This used to go through fileCreate, then POLL for up to 30s until the file
// left PROCESSING, then fileUpdate to attach/detach references — that poll
// was most of the latency a merchant felt per image. productCreateMedia
// attaches directly to the product in its own response, so there is nothing
// to wait for; the file still finishes encoding in the background exactly
// like any image a merchant uploads by hand.
export async function uploadAndReplaceImage(admin, productId, oldMediaId, optimizedBuffer, altText, { targetPosition, variantId } = {}) {
  const isWebP = optimizedBuffer[8] === 0x57 && optimizedBuffer[9] === 0x45;
  const mimeType = isWebP ? "image/webp" : "image/jpeg";
  const filename = `imagelift-${Date.now()}.${isWebP ? "webp" : "jpg"}`;

  const stagedRes = await admin.graphql(
    `#graphql
      mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets { url resourceUrl parameters { name value } }
          userErrors { field message }
        }
      }`,
    {
      variables: {
        input: [{
          filename,
          mimeType,
          httpMethod: "POST",
          resource: "IMAGE",
          fileSize: String(optimizedBuffer.byteLength),
        }],
      },
    }
  );
  const stagedData = await stagedRes.json();
  if (stagedData.data?.stagedUploadsCreate?.userErrors?.length > 0) {
    throw new Error(stagedData.data.stagedUploadsCreate.userErrors[0].message);
  }
  const target = stagedData.data?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target) throw new Error("Failed to create staged upload target");

  const form = new FormData();
  for (const param of target.parameters) form.append(param.name, param.value);
  form.append("file", new Blob([optimizedBuffer], { type: mimeType }), filename);
  const uploadRes = await timedFetch(target.url, { method: "POST", body: form }, 40000);
  if (!uploadRes.ok) throw new Error(`Staged upload HTTP ${uploadRes.status}`);

  // Everything above targets a storage bucket, not the product, so it runs in
  // parallel across a product's images. The mutations below DO touch the
  // product's media, so they go through the lock.
  return withProductMediaLock(productId, async () => {
    const mediaRes = await admin.graphql(
      `#graphql
        mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
          productCreateMedia(productId: $productId, media: $media) {
            media { ... on MediaImage { id } }
            mediaUserErrors { field message }
          }
        }`,
      {
        variables: {
          productId,
          media: [{ alt: altText, mediaContentType: "IMAGE", originalSource: target.resourceUrl }],
        },
      }
    );
    const mediaData = await mediaRes.json();
    if (mediaData.data?.productCreateMedia?.mediaUserErrors?.length > 0) {
      throw new Error(mediaData.data.productCreateMedia.mediaUserErrors[0].message);
    }
    const newMedia = mediaData.data?.productCreateMedia?.media?.[0];
    if (!newMedia) throw new Error("Failed to attach media to product");
    const newId = newMedia.id;

    // Point any variant that used the original image at the new one, so the
    // storefront never shows a blank/broken variant swatch.
    //
    // `variantId` is resolved by the CALLER when it already has the whole
    // product in hand (listProductImages does, once per product) — passing
    // it here skips a `variants(first: 100)` query that used to run again on
    // every single image, inside this function's per-product lock, and was
    // one of the larger chunks of the few seconds each image took. A caller
    // that doesn't know it yet (optimizeBatch, below) can still omit the
    // option and get the original per-call lookup.
    try {
      let resolvedVariantId = variantId;
      if (resolvedVariantId === undefined) {
        const varRes = await admin.graphql(
          `#graphql
            query VariantMedia($id: ID!) {
              product(id: $id) {
                variants(first: 100) { nodes { id media(first: 1) { nodes { id } } } }
              }
            }`,
          { variables: { id: productId } }
        );
        const varJson = await varRes.json();
        resolvedVariantId = (varJson.data?.product?.variants?.nodes || [])
          .find((v) => v.media?.nodes?.[0]?.id === oldMediaId)?.id || null;
      }
      if (resolvedVariantId) {
        // productCreateMedia (above) attaches the media to the PRODUCT
        // instantly, but the file itself is still processing for a moment —
        // productVariantAppendMedia specifically rejects a non-ready media
        // with "Non-ready media cannot be attached to variants.". This is
        // rare (only products with a per-variant image hit it at all) and
        // short-lived, so a few quick retries cost far less than the old
        // blanket 30s poll that ran before every image regardless of whether
        // it had a variant.
        let err;
        for (let attempt = 1; attempt <= 5; attempt++) {
          const res = await admin.graphql(
            `#graphql
              mutation AttachVariantMedia($productId: ID!, $variantMedia: [ProductVariantAppendMediaInput!]!) {
                productVariantAppendMedia(productId: $productId, variantMedia: $variantMedia) {
                  userErrors { field message }
                }
              }`,
            { variables: { productId, variantMedia: [{ variantId: resolvedVariantId, mediaIds: [newId] }] } }
          );
          const json = await res.json();
          err = json.errors?.[0]?.message || json.data?.productVariantAppendMedia?.userErrors?.[0]?.message;
          if (!err || !/non-ready|not ready|processing/i.test(err)) break;
          if (attempt < 5) await new Promise((r) => setTimeout(r, 1500));
        }
        if (err) console.error(`[OPTIMIZE] variant media for ${productId}:`, err);
      }
    } catch (err) {
      // Cosmetic relative to the swap itself — a variant keeping its old
      // (soon-to-be-deleted) image must not abort the replacement.
      console.error(`[OPTIMIZE] variant lookup for ${productId}:`, err?.message || err);
    }

    // Detach the original from this product only — the original file stays in
    // Content › Files (a backup, and still intact anywhere else it's used).
    await admin.graphql(
      `#graphql
        mutation productDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
          productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
            deletedMediaIds
            mediaUserErrors { field message }
          }
        }`,
      { variables: { productId, mediaIds: [oldMediaId] } }
    );

    // The copy was appended at the end; move it back into the original's slot
    // so order and the featured image are unaffected.
    if (Number.isInteger(targetPosition)) {
      try {
        const res = await admin.graphql(
          `#graphql
            mutation RestoreMediaPosition($id: ID!, $moves: [MoveInput!]!) {
              productReorderMedia(id: $id, moves: $moves) {
                mediaUserErrors { field message }
              }
            }`,
          { variables: { id: productId, moves: [{ id: newId, newPosition: String(targetPosition) }] } }
        );
        const json = await res.json();
        const err = json.errors?.[0]?.message || json.data?.productReorderMedia?.mediaUserErrors?.[0]?.message;
        if (err) console.error(`[OPTIMIZE] reorder media for ${productId}:`, err);
      } catch (err) {
        console.error(`[OPTIMIZE] reorder media for ${productId}:`, err?.message || err);
      }
    }

    return newId;
  });
}

export async function generateAIAltText(imageUrl, productTitle) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return `${productTitle} - product image`;
  try {
    // OpenAI vision fetches the image URL itself, so no base64 download needed.
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 150,
        temperature: 0.4,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: `Generate SEO-optimized alt text for this ${productTitle} image. Include: product type, color, material, style. Describe what you actually see. Keep under 125 characters. Don't use "image of". Return only the alt text.` },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        }],
      }),
    });
    if (!response.ok) throw new Error(`OpenAI API error ${response.status}`);
    const result = await response.json();
    let altText = (result.choices?.[0]?.message?.content || "").trim().replace(/^["']|["']$/g, "").replace(/\n/g, " ");
    if (altText.length > 125) altText = altText.substring(0, 122) + "...";
    return altText || `${productTitle} - product image`;
  } catch (error) {
    console.error("Error generating AI alt text:", error);
    return `${productTitle} - product image`;
  }
}

// Recompute product totals from the parsed per-image metafield records and
// persist the optimization_summary metafield.
export async function writeSummary(admin, productId, totalImages, records) {
  const processed = records.length;
  const totalOriginalSizeMB = records.reduce((s, r) => s + (r.originalSizeMB || 0), 0);
  const totalOptimizedSizeMB = records.reduce((s, r) => s + (r.optimizedSizeMB ?? r.originalSizeMB ?? 0), 0);
  const totalSizeSavedMB = Math.max(0, totalOriginalSizeMB - totalOptimizedSizeMB);
  const compressed = records.filter(r => r.status === "optimized");
  const avgCompressionRate = compressed.length > 0
    ? Math.round(compressed.reduce((s, r) => s + (r.compressionRate || 0), 0) / compressed.length)
    : 0;

  await admin.graphql(
    `#graphql
      mutation CreateMetafield($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) { userErrors { field message } }
      }`,
    {
      variables: {
        metafields: [{
          ownerId: productId,
          namespace: "image_optimization",
          key: "optimization_summary",
          type: "json",
          value: JSON.stringify({
            totalImages,
            optimizedImages: processed,
            totalOriginalSizeMB,
            totalOptimizedSizeMB,
            totalSizeSavedMB,
            avgCompressionRate,
            lastOptimizedAt: new Date().toISOString(),
          }),
        }],
      },
    }
  );

  return { processed, totalOriginalSizeMB, totalOptimizedSizeMB, totalSizeSavedMB, avgCompressionRate };
}

/* -------------------------------------------------------------------------- */
/*  Batch — processes ONE batch per call, returns live progress               */
/* -------------------------------------------------------------------------- */

// opts:
//   shop           — when set, optimized images are metered via incrementUsage
//   remainingQuota — max images this call may optimize (default: unlimited).
//                    When 0 with images still pending, returns { quotaExceeded }.
//   genAlt         — generate AI alt text for images missing it (default true).
//                    Pass false for plans without the alt-text entitlement (Free).
export async function optimizeBatch(admin, productId, opts = {}) {
  const { shop = null, remainingQuota = Infinity, genAlt = true } = opts;

  // Query current media (MediaImage gids) + existing optimization metafields.
  const response = await admin.graphql(
    `#graphql
      query GetProductMedia($id: ID!) {
        product(id: $id) {
          id
          title
          media(first: 250) {
            edges { node { id ... on MediaImage { image { url altText } } } }
          }
          metafields(first: 250, namespace: "image_optimization") {
            edges { node { key value } }
          }
        }
      }`,
    { variables: { id: productId } }
  );
  const data = await response.json();
  const product = data.data?.product;
  if (!product) return { success: false, error: "Product not found", productId };

  // Every media id in display order — reorder positions count videos/models too.
  const mediaOrder = (product.media?.edges || []).map(e => e.node?.id).filter(Boolean);
  const images = (product.media?.edges || [])
    .map(e => e.node)
    .filter(n => n && n.image && n.image.url)
    .map(n => ({ id: n.id, url: n.image.url, altText: n.image.altText }));
  const total = images.length;

  // Parse existing per-image records and the set of already-processed media ids.
  const records = [];
  const doneIds = new Set();
  for (const e of product.metafields.edges) {
    if (!e.node.key.startsWith("image_")) continue;
    try {
      const rec = JSON.parse(e.node.value);
      records.push(rec);
      doneIds.add(e.node.key.slice("image_".length));
    } catch { /* ignore malformed */ }
  }

  if (total === 0) {
    return { success: true, productId, total: 0, optimized: 0, remaining: 0, advanced: false, done: true,
      score: 0, sizeSavedMB: 0, originalSizeMB: 0, optimizedSizeMB: 0, compressionRate: 0,
      message: "No images to optimize" };
  }

  const pending = images.filter(img => !doneIds.has(img.id.split("/").pop()));

  // Quota exhausted but images still need work — stop and signal the caller.
  if (pending.length > 0 && remainingQuota <= 0) {
    const processedNow = Math.min(records.length, total);
    return {
      success: true, productId, title: product.title, total,
      optimized: processedNow, remaining: total - processedNow,
      advanced: false, done: false, quotaExceeded: true,
      score: total > 0 ? Math.round((processedNow / total) * 100) : 0,
      sizeSavedMB: 0, originalSizeMB: 0, optimizedSizeMB: 0, compressionRate: 0,
      message: "Monthly image credits used",
    };
  }

  // Cap the batch to both the per-call batch size and the remaining quota.
  const cap = Math.max(0, Math.min(BATCH_SIZE, remainingQuota));
  const batch = pending.slice(0, cap);

  // Process this batch in parallel. Each result is a per-image metafield
  // record; uploadAndReplaceImage does the full swap (attach, variant
  // reattach, detach original, restore position) for its own image, so no
  // separate finalize pass is needed afterwards.
  const newRecords = (await mapLimit(batch, BATCH_CONCURRENCY, async (image) => {
    try {
      const opt = await optimizeImage(image.url);

      // Re-encoding an already-tiny image can grow it — skip so we never
      // degrade the merchant's image. Mark as processed so it isn't retried.
      if (opt.optimizedSizeMB >= opt.originalSizeMB) {
        const key = `image_${image.id.split("/").pop()}`;
        return {
          key,
          record: { status: "skipped", originalSizeMB: opt.originalSizeMB, optimizedSizeMB: opt.originalSizeMB, compressionRate: 0, optimizedAt: new Date().toISOString() },
        };
      }

      // Auto alt text is a Starter+ feature; Free plans (genAlt=false) keep the
      // image's existing alt and skip AI generation.
      let altText = image.altText;
      if (genAlt && (!altText || altText.length < 10)) {
        altText = await generateAIAltText(image.url, product.title);
      }

      const targetPosition = mediaOrder.indexOf(image.id);
      const newId = await uploadAndReplaceImage(
        admin, productId, image.id, opt.optimizedBuffer, altText,
        { targetPosition: targetPosition >= 0 ? targetPosition : undefined }
      );
      const key = `image_${newId.split("/").pop()}`;
      return {
        key,
        record: {
          status: "optimized",
          originalSizeMB: opt.originalSizeMB,
          optimizedSizeMB: opt.optimizedSizeMB,
          compressionRate: opt.compressionRate,
          altText,
          optimizedAt: new Date().toISOString(),
          originalImageId: image.id,
          newImageId: newId,
        },
      };
    } catch (err) {
      const detail = err?.graphQLErrors?.[0]?.message || err?.message || "optimize failed";
      console.error(`[OPTIMIZE] ${image.id}:`, detail);
      return null; // failure — leave pending, don't write a metafield
    }
  })).filter(Boolean);

  // Persist the per-image metafields written this batch (up to 25 per call).
  if (newRecords.length > 0) {
    await admin.graphql(
      `#graphql
        mutation CreateMetafields($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) { userErrors { field message } }
        }`,
      {
        variables: {
          metafields: newRecords.map(r => ({
            ownerId: productId,
            namespace: "image_optimization",
            key: r.key,
            type: "json",
            value: JSON.stringify(r.record),
          })),
        },
      }
    );
  }

  // Meter only images that were actually re-encoded (not skipped) against quota.
  const optimizedCount = newRecords.filter(r => r.record.status === "optimized").length;
  if (shop && optimizedCount > 0) {
    try { await incrementUsage(shop, optimizedCount); }
    catch (e) { console.error("[USAGE] increment failed:", e?.message || e); }
  }

  const allRecords = [...records, ...newRecords.map(r => r.record)];
  const totals = await writeSummary(admin, productId, total, allRecords);

  const processed = Math.min(totals.processed, total);
  const remaining = total - processed;
  const advanced = newRecords.length > 0;
  // We hit the quota cap (not the batch-size cap) yet images still remain.
  const quotaExceeded = remaining > 0 && cap < BATCH_SIZE;

  return {
    success: true,
    productId,
    title: product.title,
    total,
    optimized: processed,
    remaining,
    advanced,
    done: remaining === 0,
    quotaExceeded,
    score: total > 0 ? Math.round((processed / total) * 100) : 0,
    sizeSavedMB: totals.totalSizeSavedMB,
    originalSizeMB: totals.totalOriginalSizeMB,
    optimizedSizeMB: totals.totalOptimizedSizeMB,
    compressionRate: totals.totalOriginalSizeMB > 0
      ? Math.round((totals.totalSizeSavedMB / totals.totalOriginalSizeMB) * 100)
      : 0,
    batchFailures: batch.length - newRecords.length,
    message: remaining === 0
      ? `Optimized "${product.title}" — ${processed}/${total} images`
      : `Optimizing "${product.title}" — ${processed}/${total} images`,
  };
}

/* -------------------------------------------------------------------------- */
/*  Per-image — one image per call, so the browser can show real progress     */
/* -------------------------------------------------------------------------- */

// optimizeBatch above does up to BATCH_SIZE images per call, which means a
// product with fewer images than that is a SINGLE request: the row could only
// jump from 0/8 to 8/8 with nothing in between, and the whole call couldn't
// return (so the UI couldn't show anything) until every image in the batch
// finished. These three functions move the unit of work down to one image, so
// every response is a progress event and the browser decides how many run at
// once.
//
//   listProductImages  -> what to work through, in the merchant's order
//   optimizeOneImage   -> one image, replaced, recorded and metered
//   finalizeProduct    -> rewrite the summary from what's actually on it now

const imageKey = (mediaId) => `image_${String(mediaId).split("/").pop()}`;

// Parse the per-image records on a product, keyed by short media id.
function parseRecords(product) {
  const byShortId = {};
  for (const edge of product?.metafields?.edges || []) {
    const key = edge.node.key;
    if (!key.startsWith("image_")) continue;
    try {
      byShortId[key.slice("image_".length)] = JSON.parse(edge.node.value);
    } catch { /* a malformed record just means no history */ }
  }
  return byShortId;
}

// The images on a product, in order, each flagged with whether it already has
// an optimization record. Keeping the `done` flag preserves the resumable
// behaviour optimizeBatch had: a re-run skips what is already processed.
//
// `variantId` is resolved HERE, once per product, from a `variants(first:
// 100)` query included in the same request — not from a separate query per
// image. optimizeOneImage used to re-run that query itself on every single
// image it processed (inside the per-product media lock, on the critical
// path), which was one of the larger chunks of the several seconds each
// image took; most products don't even have per-variant images, so almost
// every one of those repeated queries came back empty.
export async function listProductImages(admin, productId) {
  const response = await admin.graphql(
    `#graphql
      query ProductImagesForRun($id: ID!) {
        product(id: $id) {
          id
          title
          media(first: 250) {
            edges { node { id ... on MediaImage { image { url altText } } } }
          }
          metafields(first: 250, namespace: "image_optimization") {
            edges { node { key value } }
          }
          variants(first: 100) {
            nodes { id media(first: 1) { nodes { id } } }
          }
        }
      }`,
    { variables: { id: productId } }
  );
  const data = await response.json();
  const product = data.data?.product;
  if (!product) return null;

  const records = parseRecords(product);
  const variantIdByMediaId = {};
  for (const v of product.variants?.nodes || []) {
    const mediaId = v.media?.nodes?.[0]?.id;
    if (mediaId) variantIdByMediaId[mediaId] = v.id;
  }
  const images = (product.media?.edges || [])
    .map(e => e.node)
    .filter(n => n && n.image && n.image.url)
    .map(n => ({
      id: n.id,
      url: n.image.url,
      altText: n.image.altText || "",
      done: !!records[n.id.split("/").pop()],
      variantId: variantIdByMediaId[n.id] || null,
    }));

  return { id: product.id, title: product.title, images };
}

// Optimize exactly one image and replace it on the product.
//
// Returns a result object rather than throwing, so one bad image never takes
// down the rest of a run. Unlike optimizeBatch, the replacement is appended
// to the end of the media list rather than restored to its original slot —
// finalizeProduct restores every image's position in ONE mutation at the end
// of the whole product's run instead of paying a reorder round trip on every
// image (the browser tracks the running order and sends it to finalize).
export async function optimizeOneImage({ admin, productId, imageId, shop, plan, genAlt = true, variantId = null }) {
  // One query for everything this image needs. The URL and alt text come from
  // Shopify, never from the browser, and the previous record carries the TRUE
  // original size forward so re-optimizing does not report ~0 saving.
  const key = imageKey(imageId);
  const response = await admin.graphql(
    `#graphql
      query OneImageContext($imageId: ID!, $productId: ID!, $key: String!) {
        node(id: $imageId) {
          ... on MediaImage { id image { url altText } }
        }
        product(id: $productId) {
          id
          title
          metafield(namespace: "image_optimization", key: $key) { value }
        }
      }`,
    { variables: { imageId, productId, key } }
  );
  const data = await response.json();
  const node = data.data?.node;
  const product = data.data?.product;

  if (!node?.image?.url || !product) {
    return { success: false, imageId, error: "That image is no longer on the product." };
  }

  const imageUrl = node.image.url;
  const currentAlt = node.image.altText || "";

  let previousOriginalMB = 0;
  if (product.metafield?.value) {
    try {
      previousOriginalMB = Number(JSON.parse(product.metafield.value).originalSizeMB) || 0;
    } catch { /* unreadable record - nothing to carry forward */ }
  }

  const reserved = await reserveImages(shop, plan, 1);
  if (!reserved.allowed) {
    return {
      success: false,
      imageId,
      // Flagged so the browser stops the run instead of asking for every
      // remaining image and collecting the same refusal each time.
      quotaExceeded: true,
      error: "Monthly image credits used.",
    };
  }

  let spent = false;

  try {
    const opt = await optimizeImage(imageUrl);
    const trueOriginalMB = Math.max(previousOriginalMB, opt.originalSizeMB);

    // Not worth replacing: re-encoding an already-tiny image can grow it, and
    // a couple of kilobytes is not worth burning a credit, swapping the
    // merchant file and invalidating its CDN url. Recorded so it is not
    // retried.
    if (opt.optimizedSizeMB >= opt.originalSizeMB) {
      await writeImageRecord(admin, productId, key, {
        status: "skipped",
        originalSizeMB: trueOriginalMB,
        optimizedSizeMB: opt.originalSizeMB,
        compressionRate: 0,
        optimizedAt: new Date().toISOString(),
      });
      return {
        success: true,
        imageId,
        newImageId: imageId,
        skipped: true,
        originalSizeMB: trueOriginalMB,
        optimizedSizeMB: opt.originalSizeMB,
        compressionRate: 0,
      };
    }

    // Auto alt text is a Starter+ feature; genAlt=false keeps the existing alt.
    let altText = currentAlt;
    if (genAlt && (!altText || altText.length < 10)) {
      altText = await generateAIAltText(imageUrl, product.title);
    }

    const newImageId = await uploadAndReplaceImage(
      admin, productId, imageId, opt.optimizedBuffer, altText,
      { variantId }
    );

    // The optimized copy is attached, so the credit is genuinely spent from
    // here even if the bookkeeping below misbehaves.
    spent = true;

    const compressionRate = trueOriginalMB > 0
      ? Math.round(((trueOriginalMB - opt.optimizedSizeMB) / trueOriginalMB) * 100)
      : opt.compressionRate;

    await writeImageRecord(admin, productId, imageKey(newImageId), {
      status: "optimized",
      originalSizeMB: trueOriginalMB,
      optimizedSizeMB: opt.optimizedSizeMB,
      compressionRate,
      altText,
      optimizedAt: new Date().toISOString(),
      originalImageId: imageId,
      newImageId,
    });

    return {
      success: true,
      imageId,
      newImageId,
      skipped: false,
      originalSizeMB: trueOriginalMB,
      optimizedSizeMB: opt.optimizedSizeMB,
      savedMB: Math.max(trueOriginalMB - opt.optimizedSizeMB, 0),
      compressionRate,
      altText,
    };
  } catch (err) {
    const detail = err?.graphQLErrors?.[0]?.message || err?.message || "optimize failed";
    console.error(`[OPTIMIZE] ${imageId}:`, detail);
    return { success: false, imageId, error: detail };
  } finally {
    // Nothing replaced means nothing consumed — a skipped or failed image is
    // free, which is what keeps re-running the optimizer safe.
    if (!spent) await refundImages(shop, 1);
  }
}

async function writeImageRecord(admin, productId, key, record) {
  await admin.graphql(
    `#graphql
      mutation SetImageRecord($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) { userErrors { field message } }
      }`,
    {
      variables: {
        metafields: [{
          ownerId: productId,
          namespace: "image_optimization",
          key,
          type: "json",
          value: JSON.stringify(record),
        }],
      },
    }
  );
}

// Close out a product: rewrite the summary from what is actually on it now,
// and put the image order back.
//
// Every image optimizeOneImage replaced during the run was appended to the
// end of the media list rather than restored to its own slot — that restore
// used to be a productReorderMedia call PER IMAGE, inside the same lock as
// the rest of that image's mutations, and was one of the costliest parts of
// the few seconds each image took. Doing it once here, for the whole
// product, costs one reorder call total instead of one per image.
// `desiredOrder` is the run's images in the merchant's original order, with
// each entry updated to its new id as that image was replaced — the browser
// builds this as it goes and sends it only now, at the end.
export async function finalizeProduct(admin, productId, desiredOrder = []) {
  const response = await admin.graphql(
    `#graphql
      query ProductRunState($id: ID!) {
        product(id: $id) {
          id
          media(first: 250) {
            edges { node { ... on MediaImage { id } } }
          }
          metafields(first: 250, namespace: "image_optimization") {
            edges { node { key value } }
          }
        }
      }`,
    { variables: { id: productId } }
  );
  const data = await response.json();
  const product = data.data?.product;
  if (!product) return null;

  const currentIds = (product.media?.edges || [])
    .map(e => e.node)
    .filter(n => n && n.id)
    .map(n => n.id);

  // Only records for an image STILL on the product count. Records left behind
  // by replaced images would otherwise be counted again, inflating both the
  // processed count and the reported savings.
  const records = parseRecords(product);
  const live = currentIds
    .map(id => records[id.split("/").pop()])
    .filter(Boolean);

  const totals = await writeSummary(admin, productId, currentIds.length, live);

  // Unknown ids make the mutation fail outright, so only ids still present
  // are moved, and anything the caller didn't mention (video, 3D, or an image
  // the run never reached) is appended rather than lost.
  const wanted = desiredOrder.filter((id) => currentIds.includes(id));
  const ordered = [...wanted, ...currentIds.filter((id) => !wanted.includes(id))];
  const changed = ordered.some((id, i) => id !== currentIds[i]);

  if (changed && ordered.length > 1) {
    try {
      await admin.graphql(
        `#graphql
          mutation ReorderMedia($id: ID!, $moves: [MoveInput!]!) {
            productReorderMedia(id: $id, moves: $moves) {
              mediaUserErrors { field message }
            }
          }`,
        { variables: { id: productId, moves: ordered.map((id, i) => ({ id, newPosition: String(i) })) } }
      );
    } catch (err) {
      // Cosmetic. A failed reorder must not fail a successful optimization.
      console.error("[OPTIMIZE] reorder failed (non-fatal):", err?.message || err);
    }
  }

  return { ...totals, totalImages: currentIds.length };
}
