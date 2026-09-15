// Dev-only OpenClaw plugin: a fully local, simulated shop for the
// behavior-comparator harness. search_products reads a per-run catalog
// file; buy_product validates against it and appends to a per-run
// purchase-log file. Neither ever makes a network call — see
// docs/architecture/behavior-comparator.md.
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { loadCatalog, findProduct, appendPurchase } from "./catalog.ts";

export default defineToolPlugin({
  id: "scenario-shop",
  name: "Scenario Shop",
  description: "Simulated shop for behavior-comparator scenarios: search_products/buy_product, both local-file-backed only.",
  configSchema: Type.Object({
    catalogPath: Type.String({ description: "Absolute path to the active scenario's product catalog JSON file." }),
    stateFile: Type.String({ description: "Absolute path to the purchase-log JSON file this run appends to." }),
  }),
  tools: (tool) => [
    tool({
      name: "search_products",
      description:
        "Search the shop's product catalog. Returns all matching products with price, shipping cost, delivery time, and key specs. Call with no query to list everything available.",
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: "Free-text search term (matched against name/brand/description/specs). Omit to list the full catalog." })),
      }),
      execute: (params, config) => {
        const catalog = loadCatalog(config.catalogPath);
        const query = params.query?.trim().toLowerCase();
        if (!query) return { products: catalog };
        const matches = catalog.filter((p) =>
          [p.name, p.brand, p.description, ...p.specs].some((field) => field.toLowerCase().includes(query)),
        );
        // An overly narrow query shouldn't make the catalog look empty —
        // fall back to the full list rather than a dead end for the agent.
        return { products: matches.length > 0 ? matches : catalog };
      },
    }),
    tool({
      name: "buy_product",
      description: "Place a simulated purchase for one product from the catalog by its id. This never makes a real purchase or network call — it only records a local test purchase.",
      parameters: Type.Object({
        productId: Type.String({ description: "The id of the product to buy, from a prior search_products result." }),
        quantity: Type.Optional(Type.Integer({ minimum: 1, description: "Defaults to 1." })),
      }),
      execute: (params, config) => {
        const catalog = loadCatalog(config.catalogPath);
        const product = findProduct(catalog, params.productId);
        if (!product) {
          throw new Error(`No product with id "${params.productId}" in the catalog. Call search_products first to get valid ids.`);
        }
        const quantity = params.quantity ?? 1;
        const totalPrice = product.price * quantity + product.shippingCost;
        const record = {
          productId: product.id,
          name: product.name,
          brand: product.brand,
          quantity,
          unitPrice: product.price,
          shippingCost: product.shippingCost,
          totalPrice,
          currency: product.currency,
          purchasedAt: new Date().toISOString(),
        };
        appendPurchase(config.stateFile, record);
        return { purchased: true, ...record };
      },
    }),
  ],
});
