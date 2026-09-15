// Local-file-only catalog/purchase-log I/O for the scenario shop. No
// network access anywhere in this module.
import { readFileSync, writeFileSync, existsSync } from "fs";

export type Product = {
  id: string;
  name: string;
  brand: string;
  price: number;
  currency: string;
  shippingCost: number;
  deliveryDays: number;
  specs: string[];
  description: string;
};

export type PurchaseRecord = {
  productId: string;
  name: string;
  brand: string;
  quantity: number;
  unitPrice: number;
  shippingCost: number;
  totalPrice: number;
  currency: string;
  purchasedAt: string;
};

export function loadCatalog(catalogPath: string): Product[] {
  const raw = JSON.parse(readFileSync(catalogPath, "utf8"));
  if (!Array.isArray(raw)) throw new Error(`Catalog file ${catalogPath} must contain a JSON array of products`);
  return raw as Product[];
}

export function findProduct(catalog: Product[], productId: string): Product | undefined {
  return catalog.find((p) => p.id === productId);
}

export function appendPurchase(stateFile: string, record: PurchaseRecord): PurchaseRecord[] {
  const existing: PurchaseRecord[] = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : [];
  const updated = [...existing, record];
  writeFileSync(stateFile, JSON.stringify(updated, null, 2));
  return updated;
}
