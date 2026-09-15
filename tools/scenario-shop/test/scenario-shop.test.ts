import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import shopPlugin from "../src/index.ts";
import { createFakeApi } from "./helpers.ts";

const CATALOG = [
  { id: "p1", name: "ThinkPad X1", brand: "Lenovo", price: 1499, currency: "EUR", shippingCost: 0, deliveryDays: 3, specs: ["14in", "16GB RAM"], description: "Business laptop" },
  { id: "p2", name: "MacBook Air", brand: "Apple", price: 1299, currency: "EUR", shippingCost: 9.9, deliveryDays: 2, specs: ["13in", "8GB RAM"], description: "Lightweight laptop" },
];

function setup() {
  const { registerTool, pluginConfig, rootDir, tools, cleanup } = (() => {
    const base = createFakeApi({});
    const catalogPath = join(base.rootDir, "catalog.json");
    const stateFile = join(base.rootDir, "purchases.json");
    writeFileSync(catalogPath, JSON.stringify(CATALOG));
    base.pluginConfig.catalogPath = catalogPath;
    base.pluginConfig.stateFile = stateFile;
    return base;
  })();
  // @ts-expect-error fake api narrows the real OpenClawPluginApi surface
  shopPlugin.register({ registerTool, pluginConfig });
  return { tools, pluginConfig, cleanup };
}

test("search_products with no query returns the full catalog", async () => {
  const { tools, cleanup } = setup();
  const result = await tools.search_products.execute("call-1", {});
  assert.equal((result.details as { products: unknown[] }).products.length, 2);
  cleanup();
});

test("search_products filters by query, matching name/brand/description/specs", async () => {
  const { tools, cleanup } = setup();
  const result = await tools.search_products.execute("call-1", { query: "lenovo" });
  const products = (result.details as { products: Array<{ id: string }> }).products;
  assert.equal(products.length, 1);
  assert.equal(products[0].id, "p1");
  cleanup();
});

test("search_products falls back to the full catalog when a query matches nothing", async () => {
  const { tools, cleanup } = setup();
  const result = await tools.search_products.execute("call-1", { query: "nonexistent-brand-xyz" });
  assert.equal((result.details as { products: unknown[] }).products.length, 2);
  cleanup();
});

test("buy_product records a purchase with shipping included in the total", async () => {
  const { tools, pluginConfig, cleanup } = setup();
  const result = await tools.buy_product.execute("call-1", { productId: "p2" });
  const details = result.details as { purchased: boolean; totalPrice: number };
  assert.equal(details.purchased, true);
  assert.equal(details.totalPrice, 1299 + 9.9);

  const stateFile = pluginConfig.stateFile as string;
  assert.ok(existsSync(stateFile));
  const saved = JSON.parse(readFileSync(stateFile, "utf8"));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].productId, "p2");
  cleanup();
});

test("buy_product rejects an unknown product id instead of silently succeeding", async () => {
  const { tools, cleanup } = setup();
  await assert.rejects(() => tools.buy_product.execute("call-1", { productId: "does-not-exist" }));
  cleanup();
});
