
const FIRECRAWL_API_URL = "https://api.firecrawl.dev/v2/scrape";

const PRODUCT_SCHEMA = {
  type: "object",
  properties: {
    productName: { type: "string" },
    currentPrice: { type: "number" },
    currencyCode: { type: "string" },
    productImageUrl: { type: "string" },
    brand: { type: "string" },
    originalPrice: { type: "number" },
    availability: { type: "string" }
  },
  required: ["productName", "currentPrice"]
};

function normalizeTitle(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value !== "string") return null;

  const cleaned = value.replace(/[^\d.-]/g, "");
  if (!cleaned) return null;

  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCurrency(value) {
  const currency = String(value || "").trim().toUpperCase();

  const symbols = {
    "₹": "INR",
    "$": "USD",
    "€": "EUR",
    "£": "GBP",
    "¥": "JPY"
  };

  return symbols[currency] || currency || "INR";
}

function normalizeImageUrl(value, pageUrl) {
  if (!value || typeof value !== "string") return null;

  try {
    const imageUrl = new URL(value, pageUrl);

    if (!["http:", "https:"].includes(imageUrl.protocol)) {
      return null;
    }

    return imageUrl.toString();
  } catch {
    return null;
  }
}

function extractPayload(result) {
  // Firecrawl v2 response may expose JSON directly or under data.
  const candidates = [
    result?.data?.json,
    result?.json,
    result?.data?.extract,
    result?.extract,
    result?.data
  ];

  return candidates.find(
    item =>
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      (item.productName || item.currentPrice != null)
  ) || {};
}

export async function scrapeProduct(url) {
  if (!process.env.FIRECRAWL_API_KEY) {
    throw new Error("FIRECRAWL_API_KEY is missing");
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(url);

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new Error("Only HTTP and HTTPS URLs are supported");
    }
  } catch {
    throw new Error("Invalid product URL");
  }

  try {
    console.log("Starting Firecrawl JSON extraction:", url);

    const response = await fetch(FIRECRAWL_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.FIRECRAWL_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        url,
        formats: [
          {
            type: "json",
            prompt: `
              Extract the actual product information from this e-commerce page.

              Return:
              - productName: Full product title.
              - currentPrice: Current selling price as a number.
              - currencyCode: ISO currency code such as INR, USD or EUR.
              - productImageUrl: Main product image URL.
              - brand: Product brand.
              - originalPrice: Original price before discount, if available.
              - availability: Product availability.

              Use the current selling price, not the original or MRP price.
              Do not invent information.
              If information is unavailable, return an empty string
              for string fields and null for numeric fields.
            `,
            schema: PRODUCT_SCHEMA
          }
        ],
        onlyMainContent: true,
        proxy: "auto"
      })
    });

    const result = await response.json();

    if (!response.ok) {
      console.error("Firecrawl API error:", {
        status: response.status,
        error: result
      });

      throw new Error(
        result.error || `Firecrawl API returned ${response.status}`
      );
    }

    console.log("Firecrawl request completed.");
    console.log("Response keys:", Object.keys(result || {}));

    const candidate = extractPayload(result);

    const normalized = {
      productName: normalizeTitle(candidate.productName),
      currentPrice: parseNumber(candidate.currentPrice),
      currencyCode: normalizeCurrency(candidate.currencyCode),
      productImageUrl: normalizeImageUrl(
        candidate.productImageUrl,
        result?.data?.metadata?.sourceURL || url
      ),
      brand: candidate.brand || null,
      originalPrice: parseNumber(candidate.originalPrice),
      availability: candidate.availability || null
    };

    if (
      !normalized.productName ||
      normalized.currentPrice === null ||
      normalized.currentPrice <= 0
    ) {
      console.error("Product extraction returned incomplete data:", {
        responseKeys: Object.keys(result || {}),
        extracted: candidate
      });

      throw new Error(
        "Product name or valid selling price was not found."
      );
    }

    console.log("Successfully extracted product:", {
      productName: normalized.productName,
      currentPrice: normalized.currentPrice,
      currencyCode: normalized.currencyCode,
      hasImage: !!normalized.productImageUrl
    });

    return normalized;

  } catch (error) {
    console.error("Firecrawl scraping failed:", error.message);
    throw new Error(`Product scraping failed: ${error.message}`);
  }
}
