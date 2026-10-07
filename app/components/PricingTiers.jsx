import { PLAN_TIERS } from "../planCatalog";
import { LiftMark, RisingBars, Sparkle } from "./Brand";

// Plan comparison used by the standalone pricing page. Presentational only:
// every plan CTA is a real top-frame link (`target="_top"`) to Shopify's hosted
// managed-pricing page, where the actual price/cycle live and are picked. A
// direct anchor is used (rather than a form POST + reauthorize-header redirect)
// because a user click is a reliable user activation that can navigate the top
// frame out of the embedded iframe.
//
// Prices come from planCatalog.js and are display-only: the amount actually
// charged is set on the Partner Dashboard plans, so keep the two in sync.
export default function PricingTiers({ pricingUrl }) {
  return (
    <div className="il-pricing">
      <RisingBars />
      <Sparkle size={34} style={{ right: "8%", top: 48 }} />
      <Sparkle size={18} style={{ left: "10%", top: 120, opacity: 0.5 }} />
      <header className="il-pricing-head">
        <p className="il-eyebrow is-light"><LiftMark size={20} />Image Lift plans</p>
        <h1>
          Faster pages,<br /><em className="il-grad-text">priced for your catalog.</em>
        </h1>
        <p>
          Optimize product photos, generate alt text and track storefront speed. Start free and
          upgrade only when your catalog grows.
        </p>
      </header>

      <div className="il-pricing-grid">
        {PLAN_TIERS.map((tier) => (
          <div key={tier.name} className={`il-price-card${tier.popular ? " is-popular" : ""}`}>
            {tier.popular && <span className="il-price-flag">Most popular</span>}
            <p className="il-price-name">{tier.name}</p>
            <p className="il-price-tag">{tier.tagline}</p>
            <p className="il-price-amount">
              {`$${tier.price.toLocaleString("en-US")}`}<span>/mo</span>
            </p>
            <p className="il-price-annual">
              {tier.price === 0 ? "Free forever, no card required" : `Or $${tier.priceAnnual.toLocaleString("en-US")}/year (save ~17%)`}
            </p>
            <a href={pricingUrl} target="_top" className={`il-btn ${tier.popular ? "il-btn-primary" : "il-btn-ghost"} il-price-cta`}>
              {tier.price === 0 ? "Start for free" : `Choose ${tier.name}`}
            </a>
            <ul className="il-price-features">
              {tier.features.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <p className="il-pricing-foot">Billed securely through Shopify · Upgrade, downgrade or cancel anytime</p>
    </div>
  );
}
