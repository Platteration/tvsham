import { SOLD_ACCENTS, accentProduct, type SoldAccent } from "@tvsham/shared";

/**
 * What the website sells: the accent packs, one product each, paid once. The kit (kit/app.js,
 * validateCatalogue) checks this when the server starts and throws on a malformed one. A
 * product's Stripe Price is the variable kit/app.js's priceVariable names - STRIPE_PRICE_ACCENT_SUNSET
 * for accent-sunset - and a product without one is not sold. The website draws an accent from
 * these as owned only when GET /api/me reports its entitlement; the phone apps keep every accent
 * as they always had it.
 */
const DESCRIBED: Record<SoldAccent, { name: string; description: string }> = {
  sunset: { name: "Sunset accent", description: "A warm orange for the buttons, links and highlights." },
  forest: { name: "Forest accent", description: "A deep green for the buttons, links and highlights." },
  mono: { name: "Mono accent", description: "A pale grey for the buttons, links and highlights." },
};

export const catalogue = {
  app: "tvsham",
  name: "TVsham",
  products: SOLD_ACCENTS.map((accent) => ({
    id: accentProduct(accent),
    name: DESCRIBED[accent].name,
    description: DESCRIBED[accent].description,
    mode: "payment" as const,
    grants: accentProduct(accent),
  })),
};
