const FIRECRAWL_API_BASE = "https://api.firecrawl.dev/v2";

import { getRetailersForProduct, retailerFromUrl } from "@/lib/retailers";

const PRODUCT_SCHEMA = {
  type: "object",
  properties: {
    productName: { type: "string" },
    currentPrice: { type: ["number", "null"] },
    currencyCode: { type: "string" },
    productImageUrl: { type: "string" },
    brand: { type: "string" },

    // Product family, e.g. MacBook Neo.
    model: { type: "string" },

    // Manufacturer part number, not a retailer SKU.
    modelNumber: { type: "string" },

    // Only standardized GTIN/EAN/UPC identifiers.
    gtin: { type: "string" },

    ram: { type: "string" },
    storage: { type: "string" },
    screenSize: { type: "string" },
    processor: { type: "string" },
    color: { type: "string" },

    originalPrice: { type: ["number", "null"] },
    availability: { type: "string" },
  },
  required: ["productName", "currentPrice"],
};

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeMatchText(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function parsePrice(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  if (typeof value !== "string") return null;

  const cleaned = value.replace(/,/g, "").replace(/[^\d.]/g, "");

  if (!cleaned) return null;

  const parsed = Number(cleaned);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeCurrency(value) {
  const raw = String(value || "")
    .trim()
    .toUpperCase();

  const symbols = {
    "₹": "INR",
    $: "USD",
    "€": "EUR",
    "£": "GBP",
  };

  return symbols[raw] || raw || "INR";
}

function normalizeGtin(value) {
  const digits = String(value || "").replace(/\D/g, "");

  // Valid common GTIN lengths: GTIN-8, UPC-A, EAN-13, GTIN-14.
  // Retailer SKUs and short catalog IDs are not GTINs.
  return [8, 12, 13, 14].includes(digits.length) ? digits : null;
}

function normalizeImageUrl(value, pageUrl) {
  if (!value || typeof value !== "string") return null;

  try {
    const image = new URL(value, pageUrl);

    if (!["http:", "https:"].includes(image.protocol)) {
      return null;
    }

    return image.toString();
  } catch {
    return null;
  }
}

function extractPayload(result) {
  const candidates = [
    result?.data?.json,
    result?.json,
    result?.data?.extract,
    result?.extract,
  ];

  for (const item of candidates) {
    let parsed = item;

    if (typeof parsed === "string") {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        continue;
      }
    }

    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      parsed.productName
    ) {
      return parsed;
    }
  }

  return {};
}

function validateHttpUrl(value) {
  let parsed;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Invalid product URL.");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are supported.");
  }

  const hostname = parsed.hostname.toLowerCase();

  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.startsWith("127.") ||
    hostname.startsWith("10.") ||
    hostname.startsWith("192.168.") ||
    hostname.startsWith("169.254.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  ) {
    throw new Error("Private network URLs are not supported.");
  }

  return parsed;
}

function getProductTokens(value) {
  const ignored = new Set([
    "the",
    "and",
    "for",
    "with",
    "new",
    "latest",
    "official",
    "online",
    "india",
    "price",
    "buy",
    "best",
    "offer",
    "offers",
    "sale",
  ]);

  return new Set(
    normalizeMatchText(value)
      .split(" ")
      .filter((word) => word.length > 1 && !ignored.has(word)),
  );
}

function candidateRelevance(product, candidate) {
  const targetText = [
    product.brand,
    product.model,
    product.modelNumber,
    product.ram,
    product.storage,
    product.processor,
    product.screenSize,
    product.name,
    product.productName,
  ]
    .filter(Boolean)
    .join(" ");

  const candidateText = [candidate.title, candidate.description]
    .filter(Boolean)
    .join(" ");

  const targetTokens = getProductTokens(targetText);
  const candidateTokens = getProductTokens(candidateText);

  if (!targetTokens.size || !candidateTokens.size) return 0;

  let overlap = 0;

  for (const token of targetTokens) {
    if (candidateTokens.has(token)) overlap++;
  }

  const score = overlap / targetTokens.size;

  const normalizedCandidate = normalizeMatchText(candidateText);
  const exactModel = normalizeMatchText(product.modelNumber || product.model);

  if (exactModel.length >= 4 && normalizedCandidate.includes(exactModel)) {
    return Math.min(1, score + 0.3);
  }

  return score;
}

function isLikelyProductPage(candidate) {
  let parsed;

  try {
    parsed = new URL(candidate.url);
  } catch {
    return false;
  }

  const path = parsed.pathname.toLowerCase();

  const blockedPath =
    /\/(search|category|categories|collection|collections|blog|blogs|news|article|reviews|review|sections|brands|brand)(\/|$)/i;

  if (blockedPath.test(path)) return false;

  const title = normalizeMatchText(candidate.title);

  const genericPageTerms = [
    "online shopping store",
    "buy online at best prices",
    "all products",
    "shop by category",
    "latest news",
    "product reviews",
    "shopping category",
  ];

  if (genericPageTerms.some((term) => title.includes(term))) {
    return false;
  }

  const accessoryTerms =
    /\b(replacement strap|screen protector|protective case|phone case|laptop sleeve|keyboard cover|compatible with|replacement band)\b/i;

  if (accessoryTerms.test(candidate.title || "")) {
    return false;
  }

  return true;
}

function normalizeProduct(extracted, pageUrl) {
  return {
    productName: normalizeText(extracted.productName),
    currentPrice: parsePrice(extracted.currentPrice),
    currencyCode: normalizeCurrency(extracted.currencyCode),
    productImageUrl: normalizeImageUrl(extracted.productImageUrl, pageUrl),
    brand: normalizeText(extracted.brand) || null,
    model: normalizeText(extracted.model) || null,
    modelNumber: normalizeText(extracted.modelNumber) || null,
    gtin: normalizeGtin(extracted.gtin),
    ram: normalizeText(extracted.ram) || null,
    storage: normalizeText(extracted.storage) || null,
    screenSize: normalizeText(extracted.screenSize) || null,
    processor: normalizeText(extracted.processor) || null,
    color: normalizeText(extracted.color) || null,
    originalPrice: parsePrice(extracted.originalPrice),
    availability: normalizeText(extracted.availability) || null,
  };
}
function normalizeSpec(value, field) {
  if (value == null) return null;

  const text = String(value).trim().toLowerCase();

  // Treat missing or invalid values as unknown.
  if (!text || ["null", "undefined", "n/a", "unknown", "none"].includes(text)) {
    return null;
  }

  if (field === "ram" || field === "storage") {
    const match = text.match(/(\d+(?:\.\d+)?)\s*(tb|gb|mb)\b/);

    if (!match) return null;

    const amount = Number(match[1]);

    // 0.1 GB is not credible smartphone RAM.
    if (field === "ram" && amount < 1) return null;

    return `${amount}${match[2]}`;
  }

  if (field === "screenSize") {
    const match = text.match(/(\d+(?:\.\d+)?)\s*(?:inch|inches|in)\b/);
    if (match) return `${Number(match[1])}inch`;
  }

  return text.replace(/\s+/g, "");
}
function normalizeProcessor(value) {
  if (value == null) return null;

  return (
    String(value)
      .toLowerCase()
      .replace(/\bsnapdragon\b/g, "")
      .replace(/\bfor galaxy\b/g, "")
      .replace(/\bchip\b/g, "")
      .replace(/\b\d+\s*core processor\b/g, "")
      .replace(/\bmobile platform\b/g, "")
      .replace(/[^\w]/g, "")
      .trim() || null
  );
}
export function isSameProduct(left, right) {
  if (!left || !right) return false;

  const leftName = left.name || left.productName;
  const rightName = right.name || right.productName;

  if (!leftName || !rightName) return false;

  const targetTitle = normalizeMatchText(leftName);
  const candidateTitle = normalizeMatchText(rightName);

  // Reject accessories being matched to the actual product.
  const accessoryPattern =
    /\b(phone case|protective case|laptop sleeve|screen protector|replacement strap|replacement band|keyboard cover|compatible with)\b/i;

  if (
    accessoryPattern.test(candidateTitle) &&
    !accessoryPattern.test(targetTitle)
  ) {
    return false;
  }

  const leftBrand = normalizeMatchText(left.brand);
  const rightBrand = normalizeMatchText(right.brand);

  if (leftBrand && rightBrand && leftBrand !== rightBrand) {
    return false;
  }

  // Reject explicitly conflicting specifications.
  const variantFields = ["ram", "storage", "screenSize", "processor"];

  for (const field of variantFields) {
    const a =
      field === "processor"
        ? normalizeProcessor(left[field])
        : normalizeSpec(left[field], field);

    const b =
      field === "processor"
        ? normalizeProcessor(right[field])
        : normalizeSpec(right[field], field);

    // Only reject when both values are known and conflict.
    if (a && b && a !== b) {
      return false;
    }
  }

  // GTIN is the strongest identifier.
  const leftGtin = normalizeGtin(left.gtin);
  const rightGtin = normalizeGtin(right.gtin);

  if (leftGtin && rightGtin) {
    return leftGtin === rightGtin;
  }

  // Manufacturer model number is a strong identifier.
  const leftModelNumber = normalizeMatchText(left.modelNumber);
  const rightModelNumber = normalizeMatchText(right.modelNumber);

  if (leftModelNumber && rightModelNumber) {
    if (leftModelNumber !== rightModelNumber) {
      return false;
    }

    // Matching manufacturer model numbers + no spec conflicts.
    return true;
  }

  // Compare product families.
  const leftModel = normalizeMatchText(left.model);
  const rightModel = normalizeMatchText(right.model);

  if (leftModel && rightModel && leftModel !== rightModel) {
    const a = getProductTokens(leftModel);
    const b = getProductTokens(rightModel);

    const common = [...a].filter((word) => b.has(word)).length;
    const union = new Set([...a, ...b]).size;

    const modelSimilarity = union ? common / union : 0;

    if (modelSimilarity < 0.7) return false;
  }

  // Fall back to brand + model + title similarity.
  const a = getProductTokens(leftName);
  const b = getProductTokens(rightName);

  if (!a.size || !b.size) return false;

  const common = [...a].filter((word) => b.has(word)).length;
  const union = new Set([...a, ...b]).size;

  const similarity = union ? common / union : 0;

  const sameBrand = !leftBrand || !rightBrand || leftBrand === rightBrand;

  const sameModel =
    leftModel && rightModel && (leftModel === rightModel || similarity >= 0.5);

  return Boolean(sameBrand && (sameModel || similarity >= 0.65));
}

export { retailerFromUrl };

export async function scrapeProduct(url) {
  const apiKey = process.env.FIRECRAWL_API_KEY;

  if (!apiKey) {
    throw new Error("FIRECRAWL_API_KEY is missing.");
  }

  const parsedUrl = validateHttpUrl(url);
  const normalizedUrl = parsedUrl.toString();

  const response = await fetch(`${FIRECRAWL_API_BASE}/scrape`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url: normalizedUrl,
      formats: [
        {
          type: "json",
          schema: PRODUCT_SCHEMA,
          prompt: `
            Extract the actual product being sold on this page.

            Return:
            - productName: Full product title.
            - currentPrice: Current selling price as a number, or null if unavailable.
            - currencyCode: ISO currency code such as INR.
            - productImageUrl: Main product image URL.
            - brand: Manufacturer or brand.
            - model: Product family/model name, e.g. MacBook Neo.
            - modelNumber: Manufacturer model or part number, if explicitly shown.
            - gtin: Actual standardized GTIN, EAN, UPC or barcode only.
            - ram: RAM capacity, e.g. 8GB.
            - storage: Storage capacity, e.g. 256GB SSD.
            - screenSize: Display size, e.g. 13 inch.
            - processor: Exact processor, e.g. Apple A18 Pro.
            - color: Product color.
            - originalPrice: MRP/original price if shown.
            - availability: In stock, out of stock, unavailable for pincode,
              or the actual visible availability text.

            IMPORTANT IDENTIFIER RULES:
            - Never return a retailer's internal product ID as GTIN.
            - Never return an Amazon ASIN, Flipkart listing ID, Croma product
              number, URL slug, or seller SKU as GTIN.
            - A GTIN must be an actual 8, 12, 13 or 14 digit barcode.
            - Manufacturer model numbers belong in modelNumber, not GTIN.
            - Do not guess missing specifications.

            PRICE RULES:
            - Extract the current selling price, not MRP.
            - Do not include delivery charges.
            - If no price is visible, return null.
            - Do not invent a price.
          `,
        },
      ],
      onlyMainContent: true,
      proxy: "auto",
    }),
  });

  let result;

  try {
    result = await response.json();
  } catch {
    throw new Error("Firecrawl returned an unreadable response.");
  }

  if (!response.ok || result?.success === false) {
    const error = new Error(
      result?.error ||
        result?.message ||
        `Firecrawl scrape failed with HTTP ${response.status}.`,
    );

    error.status = response.status;
    throw error;
  }

  const extracted = extractPayload(result);
  const product = normalizeProduct(extracted, normalizedUrl);

  if (!product.productName) {
    throw new Error("Product name could not be extracted.");
  }

  console.log("[SmartPrice Extraction]", {
    url: normalizedUrl,
    name: product.productName,
    brand: product.brand,
    model: product.model,
    modelNumber: product.modelNumber,
    gtin: product.gtin,
    price: product.currentPrice,
    availability: product.availability,
  });

  // Missing price is allowed here so discovery can classify it.
  // addProduct() should still reject a listing without a valid price.
  return product;
}

export async function discoverProductUrls(product) {
  const apiKey = process.env.FIRECRAWL_API_KEY;

  if (!apiKey) {
    throw new Error("FIRECRAWL_API_KEY is missing.");
  }

  const { category, retailers } = getRetailersForProduct(product);

  const queryParts = [
    product.brand,
    product.model,
    product.modelNumber,
    product.ram,
    product.storage,
    product.processor,
    product.screenSize,
    product.name || product.productName,
  ].filter(Boolean);

  const query = `${queryParts.join(" ")} price India -accessory -replacement -review -news -blog`;

  const candidates = [];
  const searchErrors = [];

  let rateLimited = false;

  // Search each retailer sequentially to avoid request bursts.
  for (const retailer of retailers) {
    if (rateLimited) break;

    const response = await fetch(`${FIRECRAWL_API_BASE}/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        sources: ["web"],
        limit: 5,
        country: "IN",
        includeDomains: [retailer.domain],
      }),
    });

    let result;

    try {
      result = await response.json();
    } catch {
      searchErrors.push({
        retailer: retailer.name,
        error: "Unreadable search response",
      });
      continue;
    }

    if (response.status === 429) {
      rateLimited = true;

      searchErrors.push({
        retailer: retailer.name,
        error: "Firecrawl rate limit reached",
      });

      console.warn(
        `[SmartPrice Search] Rate limit reached at ${retailer.name}. Stopping further searches.`,
      );

      break;
    }

    if (!response.ok || result?.success === false) {
      searchErrors.push({
        retailer: retailer.name,
        error: result?.error || `HTTP ${response.status}`,
      });

      console.error(
        `[SmartPrice Search] ${retailer.name} failed:`,
        result?.error || response.status,
      );

      continue;
    }

    const webResults = result?.data?.web || [];

    console.log(`[SmartPrice Search] ${retailer.name}`, {
      query,
      resultCount: webResults.length,
      titles: webResults.map((item) => item.title),
    });

    const ranked = webResults
      .filter((item) => item?.url)
      .flatMap((item) => {
        try {
          return [
            {
              url: validateHttpUrl(item.url).toString(),
              title: item.title || "",
              description: item.description || "",
              retailer: retailer.name,
              domain: retailer.domain,
            },
          ];
        } catch {
          return [];
        }
      })
      .filter((item) => {
        try {
          const host = new URL(item.url).hostname
            .toLowerCase()
            .replace(/^www\./, "");

          return (
            host === retailer.domain || host.endsWith(`.${retailer.domain}`)
          );
        } catch {
          return false;
        }
      })
      .filter(isLikelyProductPage)
      .map((item) => ({
        ...item,
        relevance: candidateRelevance(product, item),
      }))
      .filter((item) => item.relevance >= 0.12)
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, 2);

    candidates.push(...ranked);
  }

  // Keep URLs unique.
  const uniqueCandidates = [
    ...new Map(candidates.map((item) => [item.url, item])).values(),
  ];

  // Keep total Firecrawl work near 10 API requests per operation:
  // retailer searches + candidate-page scrapes.
  const maxCandidateScrapes = Math.max(1, Math.min(6, 10 - retailers.length));

  console.log("[SmartPrice Discovery Summary]", {
    category,
    retailersSearched: retailers.length,
    candidateCount: uniqueCandidates.length,
    maxCandidateScrapes,
    rateLimited,
    searchErrors,
  });

  return {
    category,
    candidates: uniqueCandidates,
    searchErrors,
    retailersSearched: retailers.length,
    maxCandidateScrapes,
    rateLimited,
  };
}
