import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

// Every /auth/* request (including the session-token bounce page) is handled by
// the library. Installs are Shopify-managed and requests are authenticated with
// session tokens via token exchange, so no OAuth redirect is started here.
export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
