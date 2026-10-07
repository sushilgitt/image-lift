import { authenticate } from "../shopify.server";

// Session-token check endpoint. The embedded app calls this with
// `Authorization: Bearer <App Bridge session token>`; authenticate.admin
// verifies the token's signature, audience and expiry (and exchanges it for an
// access token when needed). Invalid or missing tokens are rejected by the
// library with a 401 that App Bridge retries with a fresh token.
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  return Response.json(
    { ok: true, shop: session.shop },
    { headers: { "Cache-Control": "no-store" } },
  );
};
