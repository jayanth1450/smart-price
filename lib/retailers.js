export const RETAILER_CATEGORIES = {
  electronics: [
    { name: "Amazon", domain: "amazon.in" },
    { name: "Flipkart", domain: "flipkart.com" },
    { name: "JioMart", domain: "jiomart.com" },
    { name: "Croma", domain: "croma.com" },
  ],

  fashion: [
    { name: "Amazon", domain: "amazon.in" },
    { name: "Flipkart", domain: "flipkart.com" },
    { name: "Meesho", domain: "meesho.com" },
    { name: "AJIO", domain: "ajio.com" },
    { name: "Myntra", domain: "myntra.com" },
    { name: "Tata Neu", domain: "tataneu.com" },
  ],

  groceries: [
    { name: "JioMart", domain: "jiomart.com" },
    { name: "Amazon", domain: "amazon.in" },
    { name: "BigBasket", domain: "bigbasket.com" },
  ],

  home: [
    { name: "Amazon", domain: "amazon.in" },
    { name: "Flipkart", domain: "flipkart.com" },
    { name: "Meesho", domain: "meesho.com" },
    { name: "JioMart", domain: "jiomart.com" },
  ],

  general: [
    { name: "Amazon", domain: "amazon.in" },
    { name: "Flipkart", domain: "flipkart.com" },
  ],
};

export function inferProductCategory(product) {
  const text = [
    product?.name,
    product?.productName,
    product?.brand,
    product?.model,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const fashionKeywords =
    /\b(shirt|tshirt|t-shirt|jeans|trousers|dress|kurta|kurti|saree|sneakers|shoes|sandals|heels|jacket|hoodie|clothing|apparel|handbag|wallet|fashion|ethnic wear)\b/;

  const groceryKeywords =
    /\b(grocery|groceries|rice|atta|flour|oil|milk|bread|snacks|biscuits|dal|pulses|fruits|vegetables|masala|spices|detergent)\b/;

  const homeKeywords =
    /\b(sofa|furniture|mattress|bedsheet|curtain|cookware|kitchenware|dinner set|storage rack|home decor|wall decor|lamp|table|chair)\b/;

  const electronicsKeywords =
    /\b(macbook|laptop|notebook|iphone|ipad|smartphone|mobile phone|android phone|galaxy|tablet|television|smart tv|soundbar|speaker|earbuds|headphones|smartwatch|monitor|camera|processor|graphics card|gpu|ssd|ram|keyboard|mouse|router|refrigerator|washing machine|air conditioner|ac\b|appliance|power bank)\b/;

  if (fashionKeywords.test(text)) return "fashion";
  if (groceryKeywords.test(text)) return "groceries";
  if (homeKeywords.test(text)) return "home";
  if (electronicsKeywords.test(text)) return "electronics";

  return "general";
}

export function getRetailersForProduct(product) {
  const category = inferProductCategory(product);

  return {
    category,
    retailers:
      RETAILER_CATEGORIES[category] || RETAILER_CATEGORIES.general,
  };
}

export function retailerFromUrl(value) {
  try {
    const hostname = new URL(value)
      .hostname
      .toLowerCase()
      .replace(/^www\./, "");

    for (const retailers of Object.values(RETAILER_CATEGORIES)) {
      const retailer = retailers.find(
        (item) =>
          hostname === item.domain ||
          hostname.endsWith(`.${item.domain}`)
      );

      if (retailer) return retailer.name;
    }

    return hostname;
  } catch {
    return "Unknown store";
  }
}