// Catalog pagination shared by the loaders that list every product.
//
// Shopify rejects any single Admin GraphQL query whose *requested* cost is over
// 1,000 points, and nested connections multiply: products(first: 50) with
// images(first: 250) inside requests ~25,000 points and fails outright with
// MAX_COST_EXCEEDED. Every query passed here must therefore keep
// `products(first: N)` × (per-product cost) under 1,000 — each route's query
// documents its own budget. Images per product are capped accordingly
// (MAX_MEDIA_PER_PRODUCT); the optimizer itself (optimize.server.js) still
// processes all of a product's images, since it queries one product at a time.

import { measureSizesMB } from './optimize.server';

export const MAX_MEDIA_PER_PRODUCT = 40;

// Safety cap so a pathologically large catalog can't make a loader run forever.
const DEFAULT_MAX_PAGES = 1000;

// Runs `query` (which must take `$cursor: String` and select
// `products(first: N, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { … } }`)
// until the last page. Returns { products, truncated }. GraphQL errors throw
// with Shopify's message instead of surfacing later as a null-data crash.
export async function fetchAllProducts(admin, query, { maxPages = DEFAULT_MAX_PAGES } = {}) {
  const products = [];
  let cursor = null;
  let pages = 0;
  do {
    const response = await admin.graphql(query, { variables: { cursor } });
    const json = await response.json();
    if (json.errors?.length) {
      throw new Error(json.errors.map((e) => e.message).join("; "));
    }
    const conn = json.data?.products;
    if (!conn) throw new Error("Products query returned no data");
    products.push(...conn.nodes);
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    pages += 1;
  } while (cursor && pages < maxPages);
  return { products, truncated: Boolean(cursor) };
}

// MediaImage nodes from a `media { nodes { ... on MediaImage { … } } }`
// selection; videos / 3D models come back as empty objects and are dropped.
export function imageNodes(product) {
  return (product.media?.nodes || []).filter((n) => n?.id && n.image?.url);
}

// Parsed optimization_summary metafield (selected as `summary: metafield(…)`).
export function parseSummary(product) {
  if (!product.summary?.value) return null;
  try {
    return JSON.parse(product.summary.value);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  The optimizer page's catalog                                              */
/* -------------------------------------------------------------------------- */

// The catalog lists 20 images per product instead of MAX_MEDIA_PER_PRODUCT (40)
// so products can page at 20 per request instead of 10 — the pagination is
// sequential, so page size is the whole latency of this fetch. The listing cap
// only affects the shown alt-text tally and the pre-optimization size estimate
// of 20+-image products; the optimizer itself still processes every image, and
// once a product has a summary its real totals replace the estimate.
// Budget (Shopify caps a query at 1,000 requested points): per product ≈
// 1 + featuredMedia 3 + media(2 + 20×2) + summary 1 = 47, × 20 products ≈ 942.
const OPTIMIZER_MEDIA_PER_PRODUCT = 20;
const PRODUCTS_QUERY = `#graphql
  query OptimizerProducts($cursor: String) {
    products(first: 20, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        handle
        status
        featuredMedia { preview { image { url } } }
        media(first: ${OPTIMIZER_MEDIA_PER_PRODUCT}) {
          nodes { ... on MediaImage { id alt image { url } } }
        }
        summary: metafield(namespace: "image_optimization", key: "optimization_summary") { value }
      }
    }
  }
`;

export const EMPTY_STATS = {
  total: 0,
  needsOptimization: 0,
  optimized: 0,
  totalImages: 0,
  totalSizeMB: 0,
  potentialSavingsMB: 0,
};

// Builds the full product list the optimizer page renders. This is the
// expensive half of that page — one Shopify request per 10 products,
// sequential because pagination is cursor-based, plus a HEAD per image that
// has never been measured. It lives behind /api/catalog so the page can render
// first and ask for it afterwards; awaiting it inside the page loader made
// opening the optimizer look dead for the whole fetch.
//
// Never rejects: a failure comes back as { error } so the page shows a banner
// instead of an error boundary.
export async function buildCatalog(admin) {
  try {
    const { products } = await fetchAllProducts(admin, PRODUCTS_QUERY);

    // Build a flat list of images we need to measure (only for products that
    // have never been optimized — optimized products carry totals in their
    // summary metafield). measureSizesMB serves these from the ImageSize cache
    // and only goes to the network for urls it has never seen, so the HEAD
    // requests are paid once per image, not on every render.
    const measureTasks = [];
    for (const product of products) {
      if (parseSummary(product)) continue;
      for (const img of imageNodes(product)) {
        measureTasks.push({ productId: product.id, url: img.image.url });
      }
    }
    const sizeByUrl = await measureSizesMB(measureTasks.map(t => t.url));
    const measuredByProduct = {};
    for (const t of measureTasks) {
      measuredByProduct[t.productId] = (measuredByProduct[t.productId] || 0) + (sizeByUrl.get(t.url) || 0);
    }

    const processedProducts = products.map((product) => {
      const images = imageNodes(product);
      // The optimizer writes the summary on every batch, so a product without
      // one has not been processed yet. Its totalImages is the full count —
      // more accurate than the listing, which is capped at MAX_MEDIA_PER_PRODUCT.
      const summary = parseSummary(product);
      const imageCount = Math.max(images.length, summary?.totalImages || 0);
      const imagesWithAlt = images.filter(img => img.alt && img.alt.length > 10).length;
      let processed = summary ? (summary.optimizedImages || 0) : 0;
      processed = Math.min(processed, imageCount);

      let totalOriginalSize;
      let totalOptimizedSize;
      if (summary) {
        totalOriginalSize = summary.totalOriginalSizeMB || 0;
        totalOptimizedSize = summary.totalOptimizedSizeMB || 0;
      } else {
        totalOriginalSize = measuredByProduct[product.id] || 0;
        totalOptimizedSize = totalOriginalSize; // nothing saved yet
      }

      const score = imageCount > 0 ? Math.round((processed / imageCount) * 100) : 0;
      const sizeSavedMB = Math.max(0, totalOriginalSize - totalOptimizedSize);
      const compressionRate = totalOriginalSize > 0
        ? Math.max(0, Math.round((sizeSavedMB / totalOriginalSize) * 100))
        : 0;

      return {
        id: product.id,
        title: product.title,
        handle: product.handle,
        status: product.status,
        imageCount,
        imagesWithAlt,
        optimizedImages: processed,
        score,
        totalOriginalSizeMB: totalOriginalSize,
        totalOptimizedSizeMB: totalOptimizedSize,
        sizeSavedMB,
        compressionRate,
        featuredImageUrl: product.featuredMedia?.preview?.image?.url || images[0]?.image.url,
        needsOptimization: score < 100,
      };
    });

    // Return ALL products; filtering/sorting happens instantly on the client
    // from this list, so changing a filter never re-runs this (heavy) fetch.
    return {
      products: processedProducts,
      stats: {
        total: processedProducts.length,
        needsOptimization: processedProducts.filter(p => p.needsOptimization).length,
        optimized: processedProducts.filter(p => !p.needsOptimization).length,
        totalImages: processedProducts.reduce((s, p) => s + p.imageCount, 0),
        totalSizeMB: processedProducts.reduce((s, p) => s + p.totalOriginalSizeMB, 0),
        potentialSavingsMB: processedProducts.reduce((s, p) => s + p.sizeSavedMB, 0),
      },
      error: null,
    };
  } catch (error) {
    console.error('[CATALOG] Error loading products:', error);
    return { products: [], stats: EMPTY_STATS, error: 'Failed to load products' };
  }
}
