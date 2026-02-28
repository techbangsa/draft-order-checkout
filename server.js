require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "ngrok-skip-browser-warning"],
  })
);
app.use(express.json());

// Explicit OPTIONS handler for preflight (Vercel compatibility)
app.options("*", cors());

// ---------------------------------------------------------------------------
// Multi-store registry: reads STORE_{n}_DOMAIN & STORE_{n}_TOKEN from .env
// ---------------------------------------------------------------------------
function getStoreToken(shopDomain) {
  let i = 1;
  while (true) {
    const domain = process.env[`STORE_${i}_DOMAIN`];
    const token = process.env[`STORE_${i}_TOKEN`];
    if (!domain || !token) break;
    if (domain.toLowerCase() === shopDomain.toLowerCase()) return token;
    i++;
  }
  return null;
}

function listRegisteredStores() {
  const stores = [];
  let i = 1;
  while (true) {
    const domain = process.env[`STORE_${i}_DOMAIN`];
    if (!domain) break;
    stores.push(domain);
    i++;
  }
  return stores;
}

// ---------------------------------------------------------------------------
// GraphQL mutation
// ---------------------------------------------------------------------------
const DRAFT_ORDER_CREATE_MUTATION = `
  mutation draftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id
        name
        status
        totalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Helper: call Shopify Admin GraphQL for a specific store
// ---------------------------------------------------------------------------
async function shopifyGraphQL(shopDomain, accessToken, query, variables = {}) {
  const url = `https://${shopDomain}/admin/api/2025-01/graphql.json`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify API error (${res.status}): ${text}`);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// Helper: parse customer name into firstName & lastName
// ---------------------------------------------------------------------------
function parseName(fullName) {
  if (!fullName) return { firstName: "", lastName: "" };
  const parts = fullName.trim().split(/\s+/);
  const firstName = parts[0] || "";
  const lastName = parts.slice(1).join(" ") || "";
  return { firstName, lastName };
}

// ---------------------------------------------------------------------------
// Helper: format phone number to E.164 using libphonenumber-js
// Automatically handles all countries
// ---------------------------------------------------------------------------
const { parsePhoneNumberFromString } = require("libphonenumber-js");

function formatPhone(phone, countryCode = "ID") {
  if (!phone) return "";
  // Remove spaces, dashes, and parentheses
  const cleaned = phone.replace(/[\s\-\(\)]/g, "");
  // Already in E.164 format and valid
  if (cleaned.startsWith("+")) {
    const parsed = parsePhoneNumberFromString(cleaned);
    return parsed ? parsed.format("E.164") : cleaned;
  }
  // Parse with country code hint
  const parsed = parsePhoneNumberFromString(cleaned, countryCode.toUpperCase());
  if (parsed && parsed.isValid()) {
    return parsed.format("E.164");
  }
  // Fallback: if parsing fails, return as-is with + prefix
  if (cleaned.startsWith("0") && countryCode.toUpperCase() === "ID") {
    return `+62${cleaned.slice(1)}`;
  }
  return `+${cleaned}`;
}

// ---------------------------------------------------------------------------
// POST /api/draft-order
//
// Accepts FLEXIBLE format from theme:
// {
//   "shop": "store.myshopify.com",   ← wajib
//   "customer": {
//     "name": "Agung Mubarok",       ← atau firstName/lastName
//     "email": "...",
//     "phone": "...",
//     "address": "Jl Siliwangi IV"   ← alamat singkat (opsional)
//   },
//   "shippingAddress": { ... },      ← opsional, lebih detail
//   "line_items": [                  ← atau lineItems
//     { "variant_id": 123, "quantity": 1 }
//   ],
//   "note": "..."
// }
// ---------------------------------------------------------------------------
app.post("/api/draft-order", async (req, res) => {
  try {
    const body = req.body;

    // ---- Normalize fields (support both camelCase and snake_case) ----------
    const shop = body.shop;
    const customer = body.customer || {};
    const rawLineItems = body.lineItems || body.line_items || [];
    const note = body.note || "";

    // Parse name: support "name" (full name) or "firstName"/"lastName"
    let firstName = customer.firstName || customer.first_name || "";
    let lastName = customer.lastName || customer.last_name || "";
    if (!firstName && customer.name) {
      const parsed = parseName(customer.name);
      firstName = parsed.firstName;
      lastName = parsed.lastName;
    }

    const email = customer.email || "";

    // Shipping address: support separate shippingAddress OR customer.address
    const shippingAddr = body.shippingAddress || body.shipping_address || {};
    const address1 =
      shippingAddr.address1 || shippingAddr.address || customer.address || "";
    const address2 = shippingAddr.address2 || "";
    const city = shippingAddr.city || "";
    const province =
      shippingAddr.province || shippingAddr.provinceCode || "";
    const zip = shippingAddr.zip || "";
    const country = shippingAddr.country || shippingAddr.countryCode || "ID";

    // Format phone based on country (must be after country is resolved)
    const phone = formatPhone(customer.phone || "", country);

    // ---- Validation -------------------------------------------------------
    const errors = [];

    if (!shop)
      errors.push("shop is required (e.g. store-name.myshopify.com)");
    if (!firstName) errors.push("customer name/firstName is required");
    if (!email) errors.push("customer.email is required");
    if (!phone) errors.push("customer.phone is required");
    if (!address1)
      errors.push(
        "address is required (customer.address or shippingAddress.address1)"
      );

    if (!rawLineItems || !Array.isArray(rawLineItems) || rawLineItems.length === 0)
      errors.push("line_items/lineItems is required (at least 1 item)");

    if (rawLineItems && Array.isArray(rawLineItems)) {
      rawLineItems.forEach((item, i) => {
        const vid = item.variantId || item.variant_id;
        if (!vid)
          errors.push(`line_items[${i}].variant_id is required`);
        if (!item.quantity || item.quantity < 1)
          errors.push(`line_items[${i}].quantity must be >= 1`);
      });
    }

    if (errors.length > 0) {
      return res.status(400).json({ success: false, errors });
    }

    // ---- Find store token -------------------------------------------------
    const token = getStoreToken(shop);

    if (!token) {
      return res.status(404).json({
        success: false,
        errors: [
          `Store "${shop}" tidak terdaftar. ` +
            `Store yang tersedia: ${listRegisteredStores().join(", ") || "(kosong)"}`,
        ],
      });
    }

    // ---- Build line items (auto-format variant ID to GID) -----------------
    const lineItems = rawLineItems.map((item) => {
      let variantId = String(item.variantId || item.variant_id);
      // Auto-convert numeric ID to GID format
      if (!variantId.startsWith("gid://")) {
        variantId = `gid://shopify/ProductVariant/${variantId}`;
      }
      return {
        variantId,
        quantity: item.quantity,
      };
    });

    // ---- Build DraftOrderInput -------------------------------------------
    const input = {
      email,
      phone,
      note,
      tags: ["dari-popup-cart"],
      shippingAddress: {
        firstName,
        lastName,
        address1,
        address2,
        city: city || "-",
        provinceCode: province,
        zip,
        countryCode: country,
        phone,
      },
      billingAddress: {
        firstName,
        lastName,
        address1,
        address2,
        city: city || "-",
        provinceCode: province,
        zip,
        countryCode: country,
        phone,
      },
      lineItems,
    };

    // ---- Call Shopify Admin API -------------------------------------------
    const result = await shopifyGraphQL(
      shop,
      token,
      DRAFT_ORDER_CREATE_MUTATION,
      { input }
    );

    const { draftOrderCreate } = result.data || {};

    if (draftOrderCreate?.userErrors?.length > 0) {
      return res.status(422).json({
        success: false,
        errors: draftOrderCreate.userErrors.map((e) => e.message),
      });
    }

    const draftOrder = draftOrderCreate?.draftOrder;

    return res.json({
      success: true,
      draftOrder: {
        id: draftOrder.id,
        name: draftOrder.name,
        status: draftOrder.status,
        totalPrice: draftOrder.totalPriceSet?.shopMoney?.amount,
        currency: draftOrder.totalPriceSet?.shopMoney?.currencyCode,
      },
    });
  } catch (err) {
    console.error("Error creating draft order:", err);
    return res.status(500).json({
      success: false,
      errors: ["Internal server error. Check server logs."],
    });
  }
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Draft Order API is running",
    stores: listRegisteredStores(),
  });
});

// ---------------------------------------------------------------------------
// Start server (only locally, Vercel handles this automatically)
// ---------------------------------------------------------------------------
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    const stores = listRegisteredStores();
    console.log(`🚀 Draft Order API running on http://localhost:${PORT}`);
    console.log(`   Registered stores (${stores.length}):`);
    stores.forEach((s, i) => console.log(`     ${i + 1}. ${s}`));
  });
}

// Export for Vercel
module.exports = app;
