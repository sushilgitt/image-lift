import PageHeader from "../components/PageHeader";
import { CreditCardIcon } from "@shopify/polaris-icons";
import { useLoaderData, useSubmit, useNavigation, useActionData } from "react-router";
import { authenticate } from "../shopify.server";
import {
  getBillingState,
  managedPricingUrl,
  appBridgeRedirect,
  cancelSubscription,
} from "../billing.server";
import { getUsage } from "../usage.server";
import { PLAN_TIERS } from "../planCatalog";
import { Page, Layout, BlockStack, Banner } from "@shopify/polaris";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { RingGauge, RisingBars } from "../components/Brand";

// Human labels for the entitlement flags, shown as the current plan's inclusions.
const FEATURE_LABELS = {
  optimize: "WebP image optimization",
  altText: "AI Alt Text generator",
  autoOptimize: "Auto-Optimize new products",
  pageSpeed: "Speed Insights reports",
};

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  let state = { hasActivePlan: false, plan: null, appHandle: undefined };
  try {
    state = await getBillingState(admin, session.shop);
  } catch (e) {
    if (e instanceof Response) throw e;
  }

  let usage = { imagesUsed: 0 };
  try { usage = await getUsage(session.shop); } catch { /* table not ready */ }

  const plan = state.plan || { name: "Free", tier: "free", monthlyImages: 100, features: {} };
  const included = Object.keys(FEATURE_LABELS).filter((k) => plan.features?.[k]);

  return {
    hasActivePlan: state.hasActivePlan,
    planName: plan.name,
    tier: plan.tier,
    monthlyImages: plan.monthlyImages,
    included,
    imagesUsed: usage.imagesUsed || 0,
    // Direct top-frame link target for the Change/Choose-plan CTA.
    pricingUrl: managedPricingUrl(session.shop, state.appHandle),
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get("actionType");

  const state = await getBillingState(admin);
  const pricingUrl = managedPricingUrl(session.shop, state.appHandle);

  // Cancel: try the in-app cancel mutation first; if managed pricing blocks it,
  // fall back to the hosted page to cancel manually.
  if (actionType === "cancel") {
    const sub = state.activeSubscription;
    if (!sub) return { cancelled: true };
    try {
      await cancelSubscription(admin, sub.id);
      return { cancelled: true };
    } catch (e) {
      console.error("[BILLING] in-app cancel failed, redirecting:", e?.message);
      throw appBridgeRedirect(pricingUrl);
    }
  }

  return null;
};

export default function BillingPage() {
  const { hasActivePlan, planName, monthlyImages, included, imagesUsed, pricingUrl } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const submit = useSubmit();
  const isBusy = navigation.state !== "idle";

  const post = (actionType) => {
    const fd = new FormData();
    fd.append("actionType", actionType);
    submit(fd, { method: "post" });
  };

  const quota = monthlyImages || 0;
  const used = imagesUsed || 0;
  const pct = quota > 0 ? Math.min(100, Math.round((used / quota) * 100)) : 0;
  const fmt = (n) => Number(n).toLocaleString();
  const currentIdx = PLAN_TIERS.findIndex((t) => t.name === planName);

  return (
    <Page>
      <Layout>
        <Layout.Section>
          <PageHeader icon={CreditCardIcon} eyebrow="Account" title="Plans & billing" subtitle="Your current plan, credit usage and the features included" />
        </Layout.Section>

        {actionData?.cancelled && !hasActivePlan && (
          <Layout.Section>
            <Banner title="Subscription cancelled" tone="info">
              You're now on the Free plan. Upgrade anytime when you need more credits.
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <BlockStack gap="500">
            <div className="il-plan-hero">
              <RisingBars />
              <RingGauge pct={pct} size={136} stroke={11} label={`${pct}% of monthly credits used`}>
                <strong>{`${pct}%`}</strong>
                <span>used</span>
              </RingGauge>
              <div>
                <p className="il-eyebrow is-light">{hasActivePlan ? "Active subscription" : "Current plan"}</p>
                <p className="il-plan-name">{planName}</p>
                <p className="il-plan-sub">
                  {`${fmt(used)} of ${fmt(quota)} image credits used this month · resets on the 1st`}
                </p>
                <div className="il-actions">
                  <a className="il-btn il-btn-primary" href={pricingUrl} target="_top">
                    {hasActivePlan ? "Change plan" : "Upgrade plan"}
                  </a>
                  {hasActivePlan && (
                    <button type="button" className="il-btn il-btn-ghost" disabled={isBusy} onClick={() => post("cancel")}>
                      {isBusy ? "Cancelling…" : "Cancel subscription"}
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div>
              <div className="il-section-head" style={{ marginTop: 6 }}>
                <p className="il-section-title">Compare plans</p>
                <p className="il-section-sub">Billed through Shopify · changes apply instantly</p>
              </div>
              <div className="il-tier-row">
                {PLAN_TIERS.map((t, i) => (
                  <div key={t.name} className={`il-tier${i === currentIdx ? " is-current" : ""}`}>
                    <p className="il-tier-name">
                      {t.name}
                      {i === currentIdx && <span className="il-tier-badge">Current</span>}
                    </p>
                    <p className="il-tier-price">{`$${t.price.toLocaleString("en-US")}`}<span>/mo</span></p>
                    <p className="il-tier-meta">{`${t.images} image credits / month`}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="il-card">
              <p className="il-card-title" style={{ marginBottom: 14 }}>Included in your plan</p>
              <ul className="il-checklist">
                {Object.entries(FEATURE_LABELS).map(([k, label]) => {
                  const on = included.includes(k);
                  return (
                    <li key={k} className={on ? "" : "is-locked"}>
                      <span className="il-check" aria-hidden="true">{on ? "✓" : "–"}</span>
                      <span>{label}</span>
                      {!on && <span className="il-pill is-lock il-lock-tag">Upgrade</span>}
                    </li>
                  );
                })}
              </ul>
            </div>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
