import { useEffect } from "react";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider as ShopifyAppProvider } from "@shopify/shopify-app-react-router/react";
import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { getBillingStateCached } from "../billing.server";
import { entitled } from "../plans.server";

import "@shopify/polaris/build/esm/styles.css";

import enTranslations from "@shopify/polaris/locales/en.json";

// Authentication is session-token based end to end: authenticate.admin uses
// token exchange (the App Bridge id_token on document loads, the
// `Authorization: Bearer <session token>` header that App Bridge adds to every
// fetch). When a token is missing or expired the library answers with its own
// bounce page / 401 + retry header, which App Bridge handles inside the admin,
// so the app never needs to leave the iframe or run the legacy OAuth flow.
export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  // Free-tier defaults; refined from the live subscription below.
  let features = { pageSpeed: false, altText: false };
  try {
    // Subscription state decides which features unlock. Cached per-shop
    // (positive results only) so paying merchants don't pay a Shopify roundtrip
    // on every click; a fresh subscribe still unlocks instantly.
    const state = await getBillingStateCached(admin, session.shop);
    // Entitlement booleans drive which nav items render (Page Speed, Alt Text).
    features = {
      pageSpeed: entitled(state.plan, "pageSpeed"),
      altText: entitled(state.plan, "altText"),
    };
  } catch (e) {
    // Auth Responses (bounce / re-auth) come from the library — let them
    // through. Any other billing error falls back to the Free tier defaults.
    if (e instanceof Response) throw e;
  }

  // eslint-disable-next-line no-undef
  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    features,
  };
};

// Fetches a fresh session token from App Bridge and calls an authenticated
// endpoint with it, so session-token authentication is exercised explicitly
// on every app load (in addition to App Bridge's automatic fetch header).
function useSessionTokenPing() {
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await window.shopify?.idToken?.();
        if (!token || cancelled) return;
        await fetch("/api/session", {
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch {
        /* non-critical: page data already loaded via App Bridge */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
}

export default function App() {
  const { apiKey, features } = useLoaderData();
  useSessionTokenPing();

  return (
    <ShopifyAppProvider embedded apiKey={apiKey}>
      <PolarisAppProvider i18n={enTranslations}>
        {/* No hard paywall: a shop without a paid subscription runs on the Free
            tier (see getBillingState), and upgrades happen from the Plan page. */}
        <ui-nav-menu>
          <a href="/app" rel="home">Dashboard</a>
          <a href="/app/optimize">Image Optimizer</a>
          {features?.altText && (
            <a href="/app/alt-text">AI Alt Text</a>
          )}
          {features?.pageSpeed && (
            <a href="/app/speed">Speed Insights</a>
          )}
          <a href="/app/plan">Plans &amp; Billing</a>
        </ui-nav-menu>
        <Outlet />
      </PolarisAppProvider>
    </ShopifyAppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
