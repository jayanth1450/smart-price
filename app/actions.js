
"use server";

import { createClient } from "@/utils/supabase/server";
import { scrapeProduct } from "@/lib/firecrawl";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function addProduct(formData) {
  const url = String(formData.get("url") || "").trim();

  if (!url) {
    return { error: "Product URL is required." };
  }

  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return { error: "Please log in to track products." };
    }

    // Extract product information using Firecrawl JSON API.
    const productData = await scrapeProduct(url);

    if (
      !productData.productName ||
      !Number.isFinite(productData.currentPrice) ||
      productData.currentPrice <= 0
    ) {
      return {
        error: "Could not extract valid product information."
      };
    }

    const newPrice = productData.currentPrice;
    const currency = productData.currencyCode || "INR";

    // Check whether the product already exists.
    const {
      data: existingProduct,
      error: lookupError
    } = await supabase
      .from("products")
      .select("id, current_price")
      .eq("user_id", user.id)
      .eq("url", url)
      .maybeSingle();

    if (lookupError) throw lookupError;

    const isUpdate = !!existingProduct;

    // Insert or update product.
    const {
      data: product,
      error: productError
    } = await supabase
      .from("products")
      .upsert(
        {
          user_id: user.id,
          url,
          name: productData.productName,
          current_price: newPrice,
          currency,
          image_url: productData.productImageUrl,
          updated_at: new Date().toISOString()
        },
        {
          onConflict: "user_id,url"
        }
      )
      .select()
      .single();

    if (productError) throw productError;

    // Add history only when the price changes.
    const shouldAddHistory =
      !isUpdate ||
      Number(existingProduct.current_price) !== newPrice;

    if (shouldAddHistory) {
      const { error: historyError } = await supabase
        .from("price_history")
        .insert({
          product_id: product.id,
          price: newPrice,
          currency
        });

      if (historyError) {
        console.error("Price history insertion failed:", historyError);
        throw historyError;
      }
    }

    revalidatePath("/");

    return {
      success: true,
      product,
      message: isUpdate
        ? "Product updated with latest price!"
        : "Product added successfully!"
    };

  } catch (error) {
    console.error("Add product error:", error);

    return {
      error: error.message || "Failed to add product."
    };
  }
}

export async function deleteProduct(productId) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return { error: "Not authenticated." };
    }

    const { error } = await supabase
      .from("products")
      .delete()
      .eq("id", productId)
      .eq("user_id", user.id);

    if (error) throw error;

    revalidatePath("/");

    return { success: true };

  } catch (error) {
    console.error("Delete product error:", error);
    return { error: error.message };
  }
}

export async function getProducts() {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError
    } = await supabase.auth.getUser();

    if (authError || !user) return [];

    const { data, error } = await supabase
      .from("products")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (error) throw error;

    return data || [];

  } catch (error) {
    console.error("Get products error:", error);
    return [];
  }
}

export async function getPriceHistory(productId) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError
    } = await supabase.auth.getUser();

    if (authError || !user) return [];

    // Verify product ownership before reading history.
    const { data: product, error: productError } = await supabase
      .from("products")
      .select("id")
      .eq("id", productId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (productError) throw productError;
    if (!product) return [];

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
