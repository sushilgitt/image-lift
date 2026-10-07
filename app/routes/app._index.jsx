import { useNavigate, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getBillingStateCached } from "../billing.server";
import { getUsage } from "../usage.server";
import { entitled } from "../plans.server";
import db from "../db.server";
import { Page, Button, Icon } from "@shopify/polaris";
import {
  ImageMagicIcon,
  MagicIcon,
  AutomationIcon,
  GaugeIcon,
  PlanIcon,
  ImagesIcon,
  CreditCardIcon,
} from "@shopify/polaris-icons";
import { LiftMark, RisingBars, RingGauge } from "../components/Brand";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  let plan = null;
  try {
    plan = (await getBillingStateCached(admin, session.shop)).plan;
  } catch (e) {
    if (e instanceof Response) throw e; // let re-auth propagate
  }

  let usage = { imagesUsed: 0 };
  let autoOptimize = false;
  try {
    usage = await getUsage(session.shop);
    const settings = await db.shopSettings.findUnique({ where: { shop: session.shop } });
    autoOptimize = settings?.autoOptimize ?? false;
  } catch { /* usage/settings tables not ready — defaults */ }

  return {
    plan: {
      name: plan?.name || "Free",
      tier: plan?.tier || "free",
      monthlyImages: plan?.monthlyImages ?? 100,
      altText: entitled(plan, "altText"),
      pageSpeed: entitled(plan, "pageSpeed"),
      autoOptimizeAllowed: entitled(plan, "autoOptimize"),
    },
    usage,
    autoOptimize,
  };
};

export default function Index() {
  const navigate = useNavigate();
  const { plan, usage, autoOptimize } = useLoaderData();

  const quota = plan.monthlyImages || 0;
  const used = usage?.imagesUsed || 0;
  const remaining = Math.max(0, quota - used);
  const pct = quota > 0 ? Math.min(100, Math.round((used / quota) * 100)) : 0;
  const fmt = (n) => Number(n).toLocaleString();

  const autoLabel = !plan.autoOptimizeAllowed ? "Not included" : autoOptimize ? "Active" : "Off";

  const features = [
    {
      icon: ImageMagicIcon,
      title: "Image Optimizer",
      desc: "Convert heavy product photos to lightweight WebP and replace them in place, without changing how they look.",
      cta: "Optimize images",
      onClick: () => navigate("/app/optimize"),
      available: true,
    },
    {
      icon: MagicIcon,
      title: "AI Alt Text",
      desc: "Generate descriptive, SEO-friendly alt text from each product photo, then review and apply it in bulk.",
      cta: plan.altText ? "Generate alt text" : "Upgrade to Starter",
      onClick: () => navigate(plan.altText ? "/app/alt-text" : "/app/plan"),
      available: plan.altText,
      lock: plan.altText ? null : "Starter",
    },
    {
      icon: AutomationIcon,
      title: "Auto-Optimize",
      desc: "Every new product is optimized automatically in the background as soon as it's created.",
      cta: plan.autoOptimizeAllowed ? (autoOptimize ? "Manage" : "Turn on") : "Upgrade to Growth",
      onClick: () => navigate(plan.autoOptimizeAllowed ? "/app/optimize" : "/app/plan"),
      available: plan.autoOptimizeAllowed,
      lock: plan.autoOptimizeAllowed ? null : "Growth",
      on: plan.autoOptimizeAllowed && autoOptimize,
    },
    {
      icon: GaugeIcon,
      title: "Speed Insights",
      desc: "Run Lighthouse tests on product pages and see the real weight you've removed, page by page.",
      cta: plan.pageSpeed ? "View insights" : "Upgrade to Growth",
      onClick: () => navigate(plan.pageSpeed ? "/app/speed" : "/app/plan"),
      available: plan.pageSpeed,
      lock: plan.pageSpeed ? null : "Growth",
    },
  ];

  const stats = [
    { icon: PlanIcon, label: "Current plan", value: plan.name },
    { icon: ImagesIcon, label: "Optimized this month", value: fmt(used) },
    { icon: CreditCardIcon, label: "Credits remaining", value: fmt(remaining), tone: remaining === 0 ? "is-warn" : "is-good" },
    { icon: AutomationIcon, label: "Auto-Optimize", value: autoLabel },
  ];

  return (
    <Page>
      <section className="il-hero">
        <RisingBars />
        <div>
          <p className="il-eyebrow is-light"><LiftMark size={20} />Image Lift</p>
          <h1>
            Lighter images. <em className="il-grad-text">Faster store.</em>
          </h1>
          <p className="il-hero-sub">
            Optimize product photos, add AI-written alt text and measure real speed gains, all from
            one focused dashboard.
          </p>
          <div className="il-actions">
            <button type="button" className="il-btn il-btn-primary" onClick={() => navigate("/app/optimize")}>
              Optimize images
            </button>
            <button type="button" className="il-btn il-btn-ghost" onClick={() => navigate("/app/plan")}>
              Plans &amp; billing
            </button>
          </div>
        </div>

        <div className="il-hero-gauge">
          <p className="il-hero-gauge-label">{`${plan.name} plan · this month`}</p>
          <RingGauge pct={pct} label={`${pct}% of monthly image credits used`}>
            <strong>{`${pct}%`}</strong>
            <span>{`${fmt(used)} / ${fmt(quota)}`}</span>
          </RingGauge>
          <p className="il-hero-gauge-foot">{`${fmt(remaining)} credits left · resets on the 1st`}</p>
        </div>
      </section>

      <div className="il-strip">
        {stats.map((s) => (
          <div key={s.label} className="il-strip-cell">
            <span className="il-strip-icon"><Icon source={s.icon} /></span>
            <div style={{ minWidth: 0 }}>
              <p className="il-strip-label">{s.label}</p>
              <p className={`il-strip-value${s.tone ? ` ${s.tone}` : ""}`}>{s.value}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="il-section-head">
        <p className="il-section-title">Your toolkit</p>
        <p className="il-section-sub">Everything you need for faster, search-friendly product images</p>
      </div>
      <div className="il-features-grid">
        {features.map((f, i) => (
          <div key={f.title} className={`il-fcard${f.available ? "" : " is-locked"}`}>
            <div className="il-fcard-top">
              <span className="il-fcard-icon"><Icon source={f.icon} /></span>
              {f.lock ? (
                <span className="il-pill is-lock">{`${f.lock}+`}</span>
              ) : f.on ? (
                <span className="il-pill is-on">Active</span>
              ) : (
                <span className="il-fcard-num">{String(i + 1).padStart(2, "0")}</span>
              )}
            </div>
            <p className="il-fcard-title">{f.title}</p>
            <p className="il-fcard-desc">{f.desc}</p>
            <div>
              <Button variant={f.available ? "primary" : "secondary"} onClick={f.onClick}>
                {f.cta}
              </Button>
            </div>
          </div>
        ))}
      </div>
      <div style={{ height: 28 }} />
    </Page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
