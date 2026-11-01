"use server";

import { createClient } from "@/utils/supabase/server";
import {
  scrapeProduct,
  discoverProductUrls,
  retailerFromUrl,
  isSameProduct,
} from "@/lib/firecrawl";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { inferProductCategory } from "@/lib/retailers";

async function getCurrentUser(supabase) {
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    throw new Error("Please log in to continue.");
  }

  return user;
}
function getRetailerName(url) {
  const retailer = retailerFromUrl(url)?.toLowerCase();

  const names = {
    "amzn.in": "Amazon",
    "amazon.in": "Amazon",
    "flipkart.com": "Flipkart",
    "croma.com": "Croma",
    "jiomart.com": "JioMart",
  };

  return names[retailer] || retailer || "Online Store";
}

async function findOrCreateComparisonGroup(
  supabase,
  userId,
  productData,
  existingOffer,
) {
  // Reuse the comparison group if this exact URL is already tracked.
  if (existingOffer?.comparison_group_id) {
    const { data: existingGroup, error } = await supabase
      .from("comparison_groups")
      .select("*")
      .eq("id", existingOffer.comparison_group_id)
      .eq("user_id", userId)
      .maybeSingle();

    if (error) throw error;
    if (existingGroup) return existingGroup;
  }

  // Look for an existing matching product for this user.
  const { data: groups, error: groupsError } = await supabase
    .from("comparison_groups")
    .select("id, name, brand, model, gtin")
    .eq("user_id", userId);

  if (groupsError) throw groupsError;

  const matchingGroup = (groups || []).find((group) =>
    isSameProduct(group, productData),
  );

  if (matchingGroup) {
    return matchingGroup;
  }

  // Create a separate group when no confident match exists.
  const { data: newGroup, error: insertError } = await supabase
    .from("comparison_groups")
    .insert({
      user_id: userId,
      name: productData.productName,
      brand: productData.brand,
      model: productData.model,
      gtin: productData.gtin,
      image_url: productData.productImageUrl,
      model_number: productData.modelNumber,
      ram: productData.ram,
      storage: productData.storage,
      screen_size: productData.screenSize,
      processor: productData.processor,
    })
    .select()
    .single();

  if (insertError) throw insertError;

  return newGroup;
}

async function insertPriceHistory(supabase, productId, price, currency) {
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  console.log("PRICE HISTORY AUTH:", {
    userId: user?.id,
    authError: authError?.message,
    productId,
  });

  if (!user || authError) {
    throw new Error(
      `Authentication failed: ${authError?.message || "No authenticated user"}`,
    );
  }

  const { data, error } = await supabase
    .from("price_history")
    .insert({
      product_id: productId,
      price,
      currency,
    })
    .select()
    .single();

  if (error) {
    console.error("PRICE HISTORY INSERT ERROR:", error);
    throw new Error(`Price history insert failed: ${error.message}`);
  }

  return data;
}
export async function addProduct(formData) {
  const submittedUrl = String(formData.get("url") || "").trim();

  if (!submittedUrl) {
    return { error: "Product URL is required." };
  }

  try {
    let url;

    try {
      const parsed = new URL(submittedUrl);

      if (!["http:", "https:"].includes(parsed.protocol)) {
        return {
          error: "Only HTTP and HTTPS product URLs are supported.",
        };
      }

      url = parsed.toString();
    } catch {
      return { error: "Please enter a valid product URL." };
    }

    const supabase = await createClient();
    const user = await getCurrentUser(supabase);

    // Scrape the submitted retailer listing.
    const productData = await scrapeProduct(url);

    if (
      !productData.productName ||
      !Number.isFinite(productData.currentPrice) ||
      productData.currentPrice <= 0
    ) {
      return {
        error: "Could not extract valid product information.",
      };
    }

    // Check if this exact URL already exists.
    const { data: existingOffer, error: lookupError } = await supabase
      .from("products")
      .select("id, current_price, comparison_group_id")
      .eq("user_id", user.id)
      .eq("url", url)
      .maybeSingle();

    if (lookupError) throw lookupError;

    const group = await findOrCreateComparisonGroup(
      supabase,
      user.id,
      productData,
      existingOffer,
    );

    const newPrice = productData.currentPrice;
    const currency = productData.currencyCode || "INR";

    // Save or update this retailer's listing.
    const { data: offer, error: offerError } = await supabase
      .from("products")
      .upsert(
        {
          user_id: user.id,
          comparison_group_id: group.id,
          url: url,

          name: productData.productName,
          brand: productData.brand,
          model: productData.model,
          gtin: productData.gtin,

          image_url: productData.productImageUrl,

          current_price: newPrice,
          original_price: productData.originalPrice,
          currency: currency,

          retailer: getRetailerName(url),

          model_number: productData.modelNumber,
          ram: productData.ram,
          storage: productData.storage,
          screen_size: productData.screenSize,
          processor: productData.processor,

          availability: productData.availability,
          last_checked_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        {
          onConflict: "user_id,url",
        },
      )
      .select()
      .single();

    if (offerError) throw offerError;

    // Store history for a new listing or an actual price change.
    const priceChanged =
      !existingOffer ||
      Number(existingOffer.current_price) !== Number(newPrice);

    if (priceChanged) {
      await insertPriceHistory(supabase, offer.id, newPrice, currency);
    }

    // Only fill missing group metadata; don't replace the group's name
    // with a retailer-specific title.
    await supabase
      .from("comparison_groups")
      .update({
        brand: group.brand || productData.brand,
        model: group.model || productData.model,
        gtin: group.gtin || productData.gtin,
        image_url: group.image_url || productData.productImageUrl,
        updated_at: new Date().toISOString(),
      })
      .eq("id", group.id)
      .eq("user_id", user.id);

    const { count: offerCount } = await supabase
      .from("products")
      .select("id", { count: "exact", head: true })
      .eq("comparison_group_id", group.id)
      .eq("user_id", user.id);

    revalidatePath("/");

    return {
      success: true,
      product: offer,
      groupId: group.id,
      message: existingOffer
        ? "Store listing updated with the latest price!"
        : (offerCount || 0) > 1
          ? "This store has been added to your comparison!"
          : "Product tracking started successfully!",
    };
  } catch (error) {
    console.error("Add product error:", error);

    return {
      error: error.message || "Failed to add product.",
    };
  }
}

/**
 * Search other supported retailers and add matching listings
 * to an existing comparison group.
 *
 * The limit of six candidate-page scrapes helps control API usage.
 */
export async function discoverOffers(groupId) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return { error: "Please log in to continue." };
    }

    const { data: group, error: groupError } = await supabase
      .from("comparison_groups")
      .select("*")
      .eq("id", groupId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (groupError) throw groupError;

    if (!group) {
      return { error: "Product comparison was not found." };
    }

    const { data: existingOffers, error: offersError } = await supabase
      .from("products")
      .select("id, url, retailer")
      .eq("comparison_group_id", groupId)
      .eq("user_id", user.id);

    if (offersError) throw offersError;

    const existingUrls = new Set(
      (existingOffers || []).map((item) => item.url),
    );

    const existingRetailers = new Set(
      (existingOffers || []).map((item) =>
        getRetailerName(item.url).toLowerCase(),
      ),
    );

    const discovery = await discoverProductUrls(group);
    const candidates = discovery.candidates || [];

    let added = 0;
    let rejected = 0;
    let unavailable = 0;
    let failed = 0;
    let attempts = 0;
    let rateLimited = Boolean(discovery.rateLimited);

    const attemptedPerRetailer = new Map();
    const addedRetailers = new Set();

    const maxAttempts = discovery.maxCandidateScrapes || 4;

    for (const candidate of candidates) {
      if (added >= 6 || attempts >= maxAttempts || rateLimited) {
        break;
      }

      if (!candidate.url || existingUrls.has(candidate.url)) {
        continue;
      }

      const retailer = getRetailerName(candidate.url);
      const retailerKey = retailer.toLowerCase();

      console.log("[SmartPrice Candidate Evaluation]", {
        retailer,
        retailerKey,
        alreadyExists: existingRetailers.has(retailerKey),
        alreadyAdded: addedRetailers.has(retailerKey),
        attempts,
        maxAttempts,
      });

      // One offer per retailer per comparison group.
      if (
        existingRetailers.has(retailerKey) ||
        addedRetailers.has(retailerKey)
      ) {
        continue;
      }

      // Maximum two candidate attempts per retailer.
      const retailerAttempts = attemptedPerRetailer.get(retailerKey) || 0;

      if (retailerAttempts >= 2) {
        continue;
      }

      attemptedPerRetailer.set(retailerKey, retailerAttempts + 1);
      attempts++;

      try {
        // Prevent a URL already tracked by this user from being
        // inserted into another comparison group.
        const { data: alreadyTracked, error: trackedError } = await supabase
          .from("products")
          .select("id")
          .eq("user_id", user.id)
          .eq("url", candidate.url)
          .maybeSingle();

        if (trackedError) throw trackedError;

        if (alreadyTracked) {
          continue;
        }

        const productData = await scrapeProduct(candidate.url);

        // Product details can be valid even if the retailer doesn't
        // expose a price. Count that separately.
        if (
          !Number.isFinite(productData.currentPrice) ||
          productData.currentPrice <= 0
        ) {
          unavailable++;

          console.log("[SmartPrice Offer Unavailable]", {
            retailer,
            url: candidate.url,
            productName: productData.productName,
            availability: productData.availability,
            reason: "No valid current selling price",
          });

          continue;
        }

        const matches = isSameProduct(group, productData);

        console.log("[SmartPrice Product Matching]", {
          retailer,
          target: {
            name: group.name,
            brand: group.brand,
            model: group.model,
            ram: group.ram,
            storage: group.storage,
            processor: group.processor,
            gtin: group.gtin,
          },
          candidate: {
            name: productData.productName,
            brand: productData.brand,
            model: productData.model,
            modelNumber: productData.modelNumber,
            ram: productData.ram,
            storage: productData.storage,
            processor: productData.processor,
            gtin: productData.gtin,
            price: productData.currentPrice,
          },
          matches,
        });

        if (!matches) {
          rejected++;
          continue;
        }

        const currency = productData.currencyCode || "INR";
        const now = new Date().toISOString();

        const { data: offer, error: insertError } = await supabase
          .from("products")
          .insert({
            user_id: user.id,
            comparison_group_id: group.id,
            url: candidate.url,
            retailer,
            name: productData.productName,
            brand: productData.brand,
            model: productData.model,
            model_number: productData.modelNumber,
            gtin: productData.gtin,
            ram: productData.ram,
            storage: productData.storage,
            screen_size: productData.screenSize,
            processor: productData.processor,
            product_category: discovery.category,
            current_price: productData.currentPrice,
            original_price: productData.originalPrice,
            currency,
            image_url: productData.productImageUrl,
            availability: productData.availability,
            last_checked_at: now,
            updated_at: now,
          })
          .select()
          .single();

        if (insertError) throw insertError;

        await insertPriceHistory(
          supabase,
          offer.id,
          productData.currentPrice,
          currency,
        );

        existingUrls.add(candidate.url);
        addedRetailers.add(retailerKey);
        added++;

        console.log("[SmartPrice Offer Added]", {
          retailer,
          product: productData.productName,
          price: productData.currentPrice,
          currency,
        });
      } catch (error) {
        failed++;

        console.error("[SmartPrice Candidate Failed]", {
          retailer,
          url: candidate.url,
          error: error.message,
          status: error.status,
        });

        // Stop making more requests when Firecrawl explicitly
        // tells us the rate limit has been reached.
        if (error.status === 429) {
          rateLimited = true;
          break;
        }
      }
    }

    revalidatePath("/");

    const message =
      added > 0
        ? `Found ${added} matching retailer offer${added === 1 ? "" : "s"}.`
        : candidates.length === 0
          ? "No relevant retailer product pages were found."
          : rejected > 0
            ? "Listings were found, but none passed product matching."
            : unavailable > 0
              ? "Matching listings may exist, but their current prices were unavailable."
              : rateLimited
                ? "Firecrawl rate limit reached. Try again after the limit resets."
                : "No additional usable retailer offers were found.";

    return {
      success: true,
      message,
      category: discovery.category,
      searched: candidates.length,
      attempts,
      added,
      rejected,
      unavailable,
      failed,
      rateLimited,
      searchErrors: discovery.searchErrors || [],
    };
  } catch (error) {
    console.error("[SmartPrice Discovery Error]", error);

    return {
      error: error.message || "Could not discover retailer offers.",
    };
  }
}

export async function deleteProduct(groupId) {
  try {
    const supabase = await createClient();
    const user = await getCurrentUser(supabase);

    const { data: offers, error: lookupError } = await supabase
      .from("products")
      .select("id")
      .eq("comparison_group_id", groupId)
      .eq("user_id", user.id);

    if (lookupError) throw lookupError;

    const offerIds = (offers || []).map((offer) => offer.id);

    // Delete history first because the existing foreign key may
    // not be configured with ON DELETE CASCADE.
    if (offerIds.length > 0) {
      const { error: historyError } = await supabase
        .from("price_history")
        .delete()
        .in("product_id", offerIds);

      if (historyError) throw historyError;

      const { error: offersError } = await supabase
        .from("products")
        .delete()
        .eq("comparison_group_id", groupId)
        .eq("user_id", user.id);

      if (offersError) throw offersError;
    }

    const { error: groupError } = await supabase
      .from("comparison_groups")
      .delete()
      .eq("id", groupId)
      .eq("user_id", user.id);

    if (groupError) throw groupError;

    revalidatePath("/");

    return { success: true };
  } catch (error) {
    console.error("Delete comparison error:", error);

    return {
      error: error.message || "Could not remove this comparison.",
    };
  }
}

export async function getProducts() {
  try {
    const supabase = await createClient();
    const user = await getCurrentUser(supabase);

    const { data: groups, error: groupsError } = await supabase
      .from("comparison_groups")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (groupsError) throw groupsError;
    if (!groups?.length) return [];

    const groupIds = groups.map((group) => group.id);

    const { data: offers, error: offersError } = await supabase
      .from("products")
      .select("*")
      .eq("user_id", user.id)
      .in("comparison_group_id", groupIds);

    if (offersError) throw offersError;

    return groups.map((group) => ({
      ...group,
      offers: (offers || [])
        .filter((offer) => offer.comparison_group_id === group.id)
        .sort((a, b) => Number(a.current_price) - Number(b.current_price)),
    }));
  } catch (error) {
    console.error("Get comparisons error:", error);
    return [];
  }
}

export async function getPriceHistory(productId) {
  try {
    const supabase = await createClient();
    const user = await getCurrentUser(supabase);

    // Verify ownership of the retailer listing before reading history.
    const { data: offer, error: offerError } = await supabase
      .from("products")
      .select("id")
      .eq("id", productId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (offerError) throw offerError;
    if (!offer) return [];

    const { data, error } = await supabase
      .from("price_history")
      .select("*")
      .eq("product_id", productId)
      .order("checked_at", { ascending: true });

    if (error) throw error;

    return data || [];
  } catch (error) {
    console.error("Get price history error:", error);
    return [];
  }
}

export async function signOut() {
  const supabase = await createClient();

  await supabase.auth.signOut();

  revalidatePath("/");
  redirect("/");
}
