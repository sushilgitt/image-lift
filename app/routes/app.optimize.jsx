import PageHeader from "../components/PageHeader";
import { ImageMagicIcon, ProductIcon, ClockIcon, ImageIcon, ArrowDownIcon } from "@shopify/polaris-icons";
import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useLoaderData, useFetcher, useRevalidator } from 'react-router';
import { authenticate } from '../shopify.server';
import { getBillingStateCached } from '../billing.server';
import { getUsage, getRemaining } from '../usage.server';
import { entitled } from '../plans.server';
import db from '../db.server';
import { optimizeBatch } from '../optimize.server';
import { Meter, RisingBars } from '../components/Brand';
import {
  Page,
  Layout,
  Button,
  Badge,
  Checkbox,
  Box,
  Thumbnail,
  Banner,
  Select,
  EmptyState,
  Icon,
  Spinner
} from '@shopify/polaris';

// Mirrors catalog.server's EMPTY_STATS; declared here rather than imported
// because the component (client bundle) must not pull in a .server module.
const EMPTY_STATS = {
  total: 0,
  needsOptimization: 0,
  optimized: 0,
  totalImages: 0,
  totalSizeMB: 0,
  potentialSavingsMB: 0,
};

/* -------------------------------------------------------------------------- */
/*  Loader                                                                    */
/* -------------------------------------------------------------------------- */

// React Router re-runs this route's loader after EVERY fetcher action by
// default, so each ~8s optimize batch was followed by a 20-45s full-catalog
// reload. The UI tracks per-product progress client-side (liveProgress) and
// explicitly revalidates once the whole queue drains, so the per-batch
// revalidations are pure waste — skip them.
export function shouldRevalidate({ formMethod, defaultShouldRevalidate }) {
  if (formMethod && formMethod.toUpperCase() !== 'GET') return false;
  return defaultShouldRevalidate;
}

export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const filter = url.searchParams.get('filter') || 'all';
  const sortBy = url.searchParams.get('sortBy') || 'score_asc';

  // Plan, usage and per-shop settings drive the quota meter + auto-optimize UI.
  let plan = null;
  try {
    const state = await getBillingStateCached(admin, session.shop);
    plan = state.plan;
  } catch { /* fall through to Free defaults below */ }
  let usage = { period: '', imagesUsed: 0 };
  let autoOptimize = false;
  try {
    usage = await getUsage(session.shop);
    const settings = await db.shopSettings.findUnique({ where: { shop: session.shop } });
    autoOptimize = settings?.autoOptimize ?? false;
  } catch { /* usage/settings tables not ready yet — default to zero/off */ }
  const planInfo = {
    tier: plan?.tier || 'free',
    name: plan?.name || 'Free',
    monthlyImages: plan?.monthlyImages ?? 100,
    autoOptimizeAllowed: entitled(plan, 'autoOptimize'),
  };

  // Everything here has to be fast, because the browser cannot finish the
  // navigation until this returns — building the product catalog here made
  // opening the optimizer look dead for the whole fetch. The catalog lives in
  // /api/catalog (app/catalog.server.js) and is requested once this page has
  // already painted.
  return { filter, sortBy, plan: planInfo, usage, autoOptimize };
}

/* -------------------------------------------------------------------------- */
/*  Action — toggles auto-optimize, or processes ONE optimization batch       */
/* -------------------------------------------------------------------------- */

export async function action({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get('actionType');

  if (actionType === 'setAutoOptimize') {
    const enabled = formData.get('enabled') === 'true';
    // Enabling is gated by plan entitlement; disabling is always allowed.
    if (enabled) {
      try {
        const { plan } = await getBillingStateCached(admin, session.shop);
        if (!entitled(plan, 'autoOptimize')) {
          return { success: false, settingUpdated: true, error: 'Auto-Optimize is available on Growth and Pro plans.' };
        }
      } catch { /* if billing check fails, fall through and block enabling */
        return { success: false, settingUpdated: true, error: 'Could not verify your plan. Try again.' };
      }
    }
    await db.shopSettings.upsert({
      where: { shop: session.shop },
      create: { shop: session.shop, autoOptimize: enabled },
      update: { autoOptimize: enabled },
    });
    return { success: true, settingUpdated: true, autoOptimize: enabled };
  }

  if (actionType === 'optimizeProduct') {
    const productId = formData.get('productId');
    try {
      const { plan } = await getBillingStateCached(admin, session.shop);
      const remainingQuota = await getRemaining(session.shop, plan);
      return await optimizeBatch(admin, productId, {
        shop: session.shop,
        remainingQuota,
        genAlt: entitled(plan, 'altText'),
      });
    } catch (error) {
      const msg = error?.graphQLErrors?.[0]?.message || error?.message || 'unknown error';
      console.error('[OPTIMIZE] product failed:', msg);
      return { success: false, productId, error: 'Failed to optimize product: ' + msg };
    }
  }

  return { success: false, error: 'Invalid action' };
}

/* -------------------------------------------------------------------------- */
/*  UI                                                                        */
/* -------------------------------------------------------------------------- */

export default function ProductOptimization() {
  const {
    filter: initialFilter, sortBy: initialSortBy,
    plan, usage, autoOptimize: initialAutoOptimize,
  } = useLoaderData();
  const fetcher = useFetcher();
  const settingsFetcher = useFetcher();
  const revalidator = useRevalidator();

  // The product list is fetched AFTER this page renders. Building it takes
  // seconds (a Shopify request per 10 products, plus a HEAD per unmeasured
  // image), and in the loader the browser could not finish the navigation —
  // opening the optimizer appeared to do nothing for the whole fetch.
  const catalogFetcher = useFetcher();
  useEffect(() => {
    if (catalogFetcher.state === 'idle' && !catalogFetcher.data) {
      catalogFetcher.load('/api/catalog');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogFetcher.state, catalogFetcher.data]);

  // Memoized so the empty placeholder keeps a stable identity — several
  // callbacks and memos take `products` as a dependency.
  const products = useMemo(() => catalogFetcher.data?.products ?? [], [catalogFetcher.data]);
  const stats = catalogFetcher.data?.stats ?? EMPTY_STATS;
  const catalogLoading = !catalogFetcher.data;
  const refreshCatalog = useCallback(() => {
    catalogFetcher.load('/api/catalog');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogFetcher]);

  const [filter, setFilter] = useState(initialFilter);
  const [sortBy, setSortBy] = useState(initialSortBy);
  const [selectedProducts, setSelectedProducts] = useState([]);
  const [error, setError] = useState(null);
  const [successMessage, setSuccessMessage] = useState(null);
  const [autoOptimize, setAutoOptimize] = useState(initialAutoOptimize);

  // buildCatalog reports failure as data, not a rejection, so surface it here.
  useEffect(() => {
    if (catalogFetcher.data?.error) setError(catalogFetcher.data.error);
  }, [catalogFetcher.data]);

  // Live per-product progress, keyed by product id, updated after every batch.
  const [liveProgress, setLiveProgress] = useState({});
  const [activeId, setActiveId] = useState(null);
  const queueRef = useRef([]);
  const activeRef = useRef(null);

  // Track images optimized this session so the usage meter moves without a reload.
  const [sessionImages, setSessionImages] = useState(0);
  const lastOptimizedRef = useRef({}); // productId -> optimized count last seen

  // sessionImages exists only to move the meter while a run is in progress,
  // before the loader has caught up. The moment fresh loader data arrives it
  // ALREADY includes those images, so the session delta has to be dropped —
  // otherwise both are added and the meter reads exactly double.
  useEffect(() => {
    setSessionImages(0);
    lastOptimizedRef.current = {};
  }, [usage]);

  const startNext = useCallback(() => {
    const next = queueRef.current.shift();
    if (!next) {
      activeRef.current = null;
      setActiveId(null);
      // Quietly refresh in place (no full-page reload): the loader for the
      // usage meter (cheap now that the catalog lives in /api/catalog), and
      // the catalog itself for fresh totals. The live numbers in liveProgress
      // remain authoritative for display, so stale read-after-write metafield
      // lag can't flip a finished product back to "needs optimization".
      revalidator.revalidate();
      refreshCatalog();
      return;
    }
    activeRef.current = next;
    setActiveId(next);
    fetcher.submit({ actionType: 'optimizeProduct', productId: next }, { method: 'post' });
  }, [fetcher, revalidator, refreshCatalog]);

  // Drive the batch loop: each completed batch either continues the same
  // product or advances to the next queued product.
  useEffect(() => {
    if (fetcher.state !== 'idle' || !fetcher.data) return;
    const data = fetcher.data;
    if (!data.productId || data.productId !== activeRef.current) return;

    if (data.success === false) {
      setError(data.error || 'Optimization failed');
      startNext();
      return;
    }

    setLiveProgress(prev => ({ ...prev, [data.productId]: data }));

    // Increment the session usage meter by the newly-optimized image delta.
    const prevSeen = lastOptimizedRef.current[data.productId] || 0;
    const delta = Math.max(0, (data.optimized || 0) - prevSeen);
    if (delta > 0) {
      lastOptimizedRef.current[data.productId] = data.optimized;
      setSessionImages(s => s + delta);
    }

    // Monthly quota hit — stop the whole queue and prompt to upgrade.
    if (data.quotaExceeded) {
      setError('You have used this month’s image credits. Upgrade your plan to keep optimizing.');
      queueRef.current = [];
      startNext();
      return;
    }

    if (data.done) {
      setSuccessMessage(data.message);
      setTimeout(() => setSuccessMessage(null), 4000);
      startNext();
    } else if (!data.advanced) {
      // A whole batch failed (e.g. unreachable images) — stop to avoid looping.
      setError(`Some images for "${data.title}" couldn't be processed (${data.remaining} remaining). Try again.`);
      startNext();
    } else {
      fetcher.submit({ actionType: 'optimizeProduct', productId: data.productId }, { method: 'post' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  // Reflect the saved auto-optimize setting (or surface a gating error).
  useEffect(() => {
    if (settingsFetcher.state !== 'idle' || !settingsFetcher.data) return;
    const d = settingsFetcher.data;
    if (!d.settingUpdated) return;
    if (d.success) {
      setAutoOptimize(d.autoOptimize);
    } else {
      setError(d.error || 'Could not update setting.');
      setAutoOptimize(false); // revert optimistic flip
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsFetcher.state, settingsFetcher.data]);

  const beginQueue = useCallback((ids) => {
    if (!ids.length || activeRef.current) return;
    setError(null);
    queueRef.current = [...ids];
    startNext();
  }, [startNext]);

  // Filter/sort are pure client-side transforms of the already-loaded product
  // list — no server roundtrip, so the list updates instantly.
  const handleFilterChange = useCallback((value) => setFilter(value), []);
  const handleSortChange = useCallback((value) => setSortBy(value), []);

  const handleToggleAutoOptimize = useCallback((checked) => {
    setAutoOptimize(checked); // optimistic
    setError(null);
    settingsFetcher.submit(
      { actionType: 'setAutoOptimize', enabled: String(checked) },
      { method: 'post' }
    );
  }, [settingsFetcher]);

  const displayedProducts = useMemo(() => {
    let list = products;
    if (filter === 'needs_optimization') list = list.filter(p => p.needsOptimization);
    else if (filter === 'optimized') list = list.filter(p => !p.needsOptimization);
    else if (filter === 'no_alt_text') list = list.filter(p => p.imagesWithAlt === 0);

    // Sort a copy so we never mutate loader data (which would corrupt the next
    // filter pass). Score reflects live progress, so re-sorts stay correct.
    const sorted = [...list];
    if (sortBy === 'score_asc') sorted.sort((a, b) => a.score - b.score);
    else if (sortBy === 'score_desc') sorted.sort((a, b) => b.score - a.score);
    else if (sortBy === 'size_desc') sorted.sort((a, b) => b.totalOriginalSizeMB - a.totalOriginalSizeMB);
    else if (sortBy === 'images_desc') sorted.sort((a, b) => b.imageCount - a.imageCount);
    return sorted;
  }, [products, filter, sortBy]);

  const handleSelectProduct = useCallback((id) => {
    setSelectedProducts(prev => prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id]);
  }, []);

  const handleSelectAll = useCallback(() => {
    setSelectedProducts(selectedProducts.length === displayedProducts.length ? [] : displayedProducts.map(p => p.id));
  }, [selectedProducts.length, displayedProducts]);

  const handleOptimizeProduct = useCallback((id) => beginQueue([id]), [beginQueue]);
  const handleOptimizeSelected = useCallback(() => {
    beginQueue(selectedProducts);
    setSelectedProducts([]);
  }, [beginQueue, selectedProducts]);

  const isBusy = activeId !== null;

  // Usage meter: loader baseline + images optimized live this session.
  const quota = plan?.monthlyImages ?? 100;
  const usedImages = (usage?.imagesUsed ?? 0) + sessionImages;
  const usagePct = quota > 0 ? Math.min(100, Math.round((usedImages / quota) * 100)) : 0;
  const quotaReached = usedImages >= quota;

  const formatBytes = (mb) => {
    const v = mb || 0;
    if (v >= 1000) return `${(v / 1000).toFixed(1)} GB`;
    if (v >= 1) return `${v.toFixed(1)} MB`;
    if (v > 0) return `${Math.max(1, Math.round(v * 1024))} KB`;
    return `0 KB`;
  };

  const filterOptions = [
    { label: 'All', value: 'all' },
    { label: 'Needs work', value: 'needs_optimization' },
    { label: 'Optimized', value: 'optimized' },
    { label: 'No alt text', value: 'no_alt_text' },
  ];
  const sortOptions = [
    { label: 'Lowest score', value: 'score_asc' },
    { label: 'Highest score', value: 'score_desc' },
    { label: 'Largest size', value: 'size_desc' },
    { label: 'Most images', value: 'images_desc' },
  ];

  // Merge loader values with any live progress for a product.
  const view = (product) => {
    const lp = liveProgress[product.id];
    if (!lp) return product;
    return {
      ...product,
      score: lp.score,
      optimizedImages: lp.optimized,
      totalOriginalSizeMB: lp.originalSizeMB || product.totalOriginalSizeMB,
      sizeSavedMB: lp.sizeSavedMB,
      compressionRate: lp.compressionRate,
      needsOptimization: lp.score < 100,
    };
  };

  const liveSavings = stats.potentialSavingsMB
    + Object.entries(liveProgress).reduce((sum, [id, lp]) => {
        const base = products.find(p => p.id === id)?.sizeSavedMB || 0;
        return sum + Math.max(0, (lp.sizeSavedMB || 0) - base);
      }, 0);

  const filterCounts = {
    all: products.length,
    needs_optimization: products.filter(p => view(p).needsOptimization).length,
    optimized: products.filter(p => !view(p).needsOptimization).length,
    no_alt_text: products.filter(p => p.imagesWithAlt === 0).length,
  };
  const allSelected = selectedProducts.length === displayedProducts.length && displayedProducts.length > 0;

  const stripStats = [
    { icon: ProductIcon, label: 'Products', value: stats.total.toLocaleString() },
    { icon: ClockIcon, label: 'Need optimizing', value: stats.needsOptimization.toLocaleString(), tone: stats.needsOptimization > 0 ? 'is-warn' : undefined },
    { icon: ImageIcon, label: 'Product images', value: stats.totalImages.toLocaleString() },
    { icon: ArrowDownIcon, label: 'Weight saved', value: formatBytes(liveSavings), tone: 'is-good' },
  ];

  return (
    <Page>
      <Layout>
        <Layout.Section>
          <PageHeader
            icon={ImageMagicIcon}
            eyebrow="Image Optimizer"
            title="Optimize product images"
            subtitle="Convert photos to lightweight WebP and swap them in place, keeping order, variants and featured images intact"
            aside={<span className="il-pill is-on">{`${plan?.name || 'Free'} plan`}</span>}
          />
        </Layout.Section>

        {error && (
          <Layout.Section>
            <Banner title="Something needs attention" tone="critical" onDismiss={() => setError(null)}>{error}</Banner>
          </Layout.Section>
        )}
        {successMessage && (
          <Layout.Section>
            <Banner title="Done" tone="success" onDismiss={() => setSuccessMessage(null)}>{successMessage}</Banner>
          </Layout.Section>
        )}

        {/* Stat strip */}
        <Layout.Section>
          <div className="il-strip">
            {stripStats.map(s => (
              <div key={s.label} className="il-strip-cell">
                <span className="il-strip-icon"><Icon source={s.icon} /></span>
                <div style={{ minWidth: 0 }}>
                  <p className="il-strip-label">{s.label}</p>
                  <p className={`il-strip-value${s.tone ? ` ${s.tone}` : ''}`}>{s.value}</p>
                </div>
              </div>
            ))}
          </div>
        </Layout.Section>

        {/* Credits + Auto-Optimize controls */}
        <Layout.Section>
          <div className="il-controls">
            <div className="il-card il-card-dark">
              <RisingBars />
              <div className="il-card-row">
                <span className="il-card-title">Monthly image credits</span>
                <span className="il-pill is-glass">Resets on the 1st</span>
              </div>
              <p className="il-card-big">
                {usedImages.toLocaleString()}
                <span>{` / ${quota.toLocaleString()} used`}</span>
              </p>
              <Meter pct={usagePct} dark quota label={`${usagePct}% of monthly credits used`} />
              {quotaReached ? (
                <p className="il-card-note is-alert">You've used all of this month's credits. Upgrade your plan to keep optimizing.</p>
              ) : (
                <p className="il-card-note">{`${Math.max(0, quota - usedImages).toLocaleString()} credits left. One credit = one optimized image.`}</p>
              )}
            </div>

            <div className="il-card">
              <div className="il-card-row">
                <span className="il-card-title">Auto-Optimize</span>
                {plan?.autoOptimizeAllowed
                  ? <span className={`il-pill${autoOptimize ? ' is-on' : ''}`}>{autoOptimize ? 'Active' : 'Off'}</span>
                  : <span className="il-pill is-lock">Growth+</span>}
              </div>
              <p className="il-card-note">Automatically optimize images on every new product as soon as it's created.</p>
              {plan?.autoOptimizeAllowed ? (
                <label className={`il-switch${settingsFetcher.state !== 'idle' ? ' is-disabled' : ''}`}>
                  <span>Optimize new products automatically</span>
                  <input
                    type="checkbox"
                    checked={autoOptimize}
                    onChange={(e) => handleToggleAutoOptimize(e.target.checked)}
                    disabled={settingsFetcher.state !== 'idle'}
                  />
                  <span className="il-switch-track" aria-hidden="true" />
                </label>
              ) : (
                <p className="il-card-note">Available on Growth and Pro plans.</p>
              )}
            </div>
          </div>
        </Layout.Section>

        {/* Product table */}
        <Layout.Section>
          <div className="il-table">
            <div className="il-toolbar">
              <div className="il-segments" role="tablist" aria-label="Filter products">
                {filterOptions.map(o => (
                  <button
                    key={o.value}
                    type="button"
                    role="tab"
                    aria-selected={filter === o.value}
                    className={`il-segment${filter === o.value ? ' is-active' : ''}`}
                    onClick={() => handleFilterChange(o.value)}
                    disabled={isBusy}
                  >
                    {o.label}
                    <span className="il-segment-count">{filterCounts[o.value]}</span>
                  </button>
                ))}
              </div>
              <Box width="220px">
                <Select label="Sort by" labelInline options={sortOptions} value={sortBy} onChange={handleSortChange} disabled={isBusy} />
              </Box>
            </div>

            <div className="il-trow il-trow-head">
              <Checkbox
                label="Select all"
                labelHidden
                checked={allSelected}
                onChange={handleSelectAll}
                disabled={isBusy || displayedProducts.length === 0}
              />
              <span />
              <span>Product</span>
              <span>Images optimized</span>
              <span>Saved</span>
              <span>Score</span>
              <span />
            </div>

            {catalogLoading ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', padding: '64px 0' }}>
                <Spinner size="small" accessibilityLabel="Loading products" />
                <span>Loading your products…</span>
              </div>
            ) : displayedProducts.length === 0 ? (
              <EmptyState heading="No products in this view" image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png">
                <p>Try a different filter to see more products.</p>
              </EmptyState>
            ) : (
              displayedProducts.map((raw) => {
                const product = view(raw);
                const isActive = activeId === product.id;
                const selected = selectedProducts.includes(product.id);
                const scoreTone = product.score >= 80 ? 'good' : product.score >= 60 ? 'warn' : 'bad';
                return (
                  <div key={product.id} className={`il-trow${selected ? ' is-selected' : ''}${isActive ? ' is-active' : ''}`}>
                    <Checkbox
                      label={`Select ${product.title}`}
                      labelHidden
                      checked={selected}
                      onChange={() => handleSelectProduct(product.id)}
                      disabled={isBusy}
                    />
                    <Thumbnail source={product.featuredImageUrl || ImageMagicIcon} alt={product.title} size="small" />
                    <div className="il-trow-main">
                      <p className="il-trow-title">{product.title}</p>
                      <p className="il-trow-meta">
                        {`${product.status.charAt(0) + product.status.slice(1).toLowerCase()} · ${product.imageCount} images · ${product.imagesWithAlt}/${product.imageCount} with alt text`}
                        {isActive && <span className="il-live">Optimizing</span>}
                      </p>
                    </div>
                    <div className="il-trow-progress">
                      <span>{`${product.optimizedImages} of ${product.imageCount}`}</span>
                      <Meter pct={product.score} label={`${product.score}% optimized`} />
                    </div>
                    <div className="il-trow-saved">
                      <strong>{formatBytes(product.sizeSavedMB)}</strong>
                      <span>{`from ${formatBytes(product.totalOriginalSizeMB)}`}</span>
                    </div>
                    <div className={`il-score il-score-${scoreTone}`} style={{ '--v': product.score }} title={`${product.score}% optimized`}>
                      <span>{`${product.score}%`}</span>
                    </div>
                    <div className="il-trow-action">
                      {product.needsOptimization ? (
                        <Button size="slim" variant="primary" onClick={() => handleOptimizeProduct(product.id)} loading={isActive} disabled={isBusy || quotaReached}>
                          Optimize
                        </Button>
                      ) : (
                        <Badge tone="success">Optimized</Badge>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </Layout.Section>
      </Layout>

      {selectedProducts.length > 0 && (
        <div className="il-dock" role="region" aria-label="Bulk actions">
          <span className="il-dock-count"><b>{selectedProducts.length}</b>{`product${selectedProducts.length === 1 ? '' : 's'} selected`}</span>
          <div className="il-dock-actions">
            <button type="button" className="il-btn il-btn-ghost" onClick={() => setSelectedProducts([])} disabled={isBusy}>Clear</button>
            <button type="button" className="il-btn il-btn-primary" onClick={handleOptimizeSelected} disabled={isBusy || quotaReached}>
              {isBusy ? 'Optimizing…' : 'Optimize selected'}
            </button>
          </div>
        </div>
      )}
    </Page>
  );
}

