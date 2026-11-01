"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { deleteProduct, discoverOffers } from "@/app/actions";
import PriceChart from "./PriceChart";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ExternalLink,
  Trash2,
  TrendingDown,
  ChevronDown,
  ChevronUp,
  Search,
  Loader2,
  Trophy,
} from "lucide-react";
import { toast } from "sonner";

function formatPrice(price, currency = "INR") {
  const amount = Number(price);

  if (!Number.isFinite(amount)) {
    return "Price unavailable";
  }

  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toLocaleString("en-IN")}`;
  }
}

function formatCheckedAt(value) {
  if (!value) return "Not checked yet";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Not checked yet";
  }

  return date.toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export default function ProductCard({ product }) {
  const router = useRouter();

  const [chartOfferId, setChartOfferId] = useState(null);
  const [discovering, setDiscovering] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const offers = [...(product.offers || [])].sort(
    (a, b) => Number(a.current_price) - Number(b.current_price),
  );

  // Only compare prices that use the same currency.
  const comparisonCurrency = offers[0]?.currency || "INR";

  const comparableOffers = offers.filter(
    (offer) => (offer.currency || "INR") === comparisonCurrency,
  );

  const availableOffers = comparableOffers.filter(
    (offer) =>
      !/(out of stock|sold out|unavailable)/i.test(offer.availability || ""),
  );

  const lowestOfferId =
    availableOffers.length > 0
      ? availableOffers.reduce((lowest, current) =>
          Number(current.current_price) < Number(lowest.current_price)
            ? current
            : lowest,
        ).id
      : null;

  const handleDiscover = async () => {
    setDiscovering(true);

    try {
      const result = await discoverOffers(product.id);

      if (result.error) {
        toast.error(result.error);
        return;
      }

      toast.success(result.message);
      router.refresh();
    } catch (error) {
      toast.error(error.message || "Could not find prices at other stores.");
    } finally {
      setDiscovering(false);
    }
  };

  const handleDelete = async () => {
    const confirmed = confirm(
      "Remove this product comparison and all its retailer listings?",
    );

    if (!confirmed) return;

    setDeleting(true);

    try {
      const result = await deleteProduct(product.id);

      if (result.error) {
        toast.error(result.error);
        return;
      }

      toast.success("Product comparison removed.");
      router.refresh();
    } catch (error) {
      toast.error(error.message || "Could not remove comparison.");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Card className="hover:shadow-lg transition-shadow overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex gap-4">
          {product.image_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={product.image_url}
              alt={product.name}
              className="w-20 h-20 object-cover rounded-md border bg-white"
            />
          )}

          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-gray-900 line-clamp-2 mb-2">
              {product.name}
            </h3>

            {(product.brand || product.model) && (
              <p className="text-sm text-gray-500 mb-2">
                {[product.brand, product.model].filter(Boolean).join(" · ")}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary" className="gap-1">
                <TrendingDown className="w-3 h-3" />
                Price comparison
              </Badge>

              <Badge variant="outline">
                {offers.length} {offers.length === 1 ? "store" : "stores"}
              </Badge>
            </div>
          </div>
        </div>
      </CardHeader>

      <CardContent>
        <div className="flex items-center justify-between mb-3">
          <h4 className="font-semibold text-gray-800">Price comparison</h4>

          <span className="text-xs text-gray-500">
            {offers.length} listings
          </span>
        </div>

        {offers.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            No store listings found yet.
          </div>
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border border-gray-200">
              <table className="w-full min-w-[620px] text-sm text-left">
                <thead className="bg-gray-50 text-gray-600">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Store</th>
                    <th className="px-4 py-3 font-semibold">Price</th>
                    <th className="px-4 py-3 font-semibold">Availability</th>
                    <th className="px-4 py-3 font-semibold">Last checked</th>
                    <th className="px-4 py-3 font-semibold text-right">
                      Actions
                    </th>
                  </tr>
                </thead>

                <tbody className="divide-y divide-gray-200">
                  {offers.map((offer) => {
                    const isLowest = offer.id === lowestOfferId;
                    const isChartOpen = chartOfferId === offer.id;

                    return (
                      <tr
                        key={offer.id}
                        className={
                          isLowest ? "bg-orange-50/60" : "hover:bg-gray-50"
                        }
                      >
                        <td className="px-4 py-3">
                          <div className="font-medium text-gray-900">
                            {offer.retailer || "Online store"}
                          </div>

                          {isLowest && (
                            <Badge
                              variant="secondary"
                              className="mt-1 gap-1 bg-orange-100 text-orange-700 border-orange-200"
                            >
                              <Trophy className="w-3 h-3" />
                              Lowest price
                            </Badge>
                          )}
                        </td>

                        <td className="px-4 py-3">
                          <div className="font-bold text-orange-600 whitespace-nowrap">
                            {formatPrice(offer.current_price, offer.currency)}
                          </div>

                          {offer.original_price &&
                            Number(offer.original_price) >
                              Number(offer.current_price) && (
                              <div className="text-xs text-gray-500 line-through mt-1">
                                {formatPrice(
                                  offer.original_price,
                                  offer.currency,
                                )}
                              </div>
                            )}
                        </td>

                        <td className="px-4 py-3">
                          <span className="text-gray-600">
                            {offer.availability || "Check store"}
                          </span>
                        </td>

                        <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
                          {formatCheckedAt(offer.last_checked_at)}
                        </td>

                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              title="Show price history"
                              onClick={() =>
                                setChartOfferId(isChartOpen ? null : offer.id)
                              }
                            >
                              {isChartOpen ? (
                                <ChevronUp className="w-4 h-4" />
                              ) : (
                                <ChevronDown className="w-4 h-4" />
                              )}
                            </Button>

                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              asChild
                            >
                              <a
                                href={offer.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                title="Visit retailer"
                              >
                                <ExternalLink className="w-4 h-4" />
                              </a>
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {chartOfferId && (
              <div className="mt-4 border border-gray-200 rounded-lg p-4">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-semibold text-gray-700">
                    Price history
                  </h4>

                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setChartOfferId(null)}
                  >
                    Close
                  </Button>
                </div>

                <PriceChart productId={chartOfferId} />
              </div>
            )}
          </>
        )}
      </CardContent>

      <CardFooter className="flex flex-wrap justify-between gap-2 border-t pt-4">
        <Button
          type="button"
          onClick={handleDiscover}
          disabled={discovering || deleting}
          className="bg-orange-500 hover:bg-orange-600"
        >
          {discovering ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Searching stores...
            </>
          ) : (
            <>
              <Search className="w-4 h-4 mr-2" />
              Find prices at other stores
            </>
          )}
        </Button>

        <Button
          type="button"
          variant="ghost"
          onClick={handleDelete}
          disabled={deleting || discovering}
          className="text-red-600 hover:text-red-700 hover:bg-red-50"
        >
          {deleting ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <Trash2 className="w-4 h-4 mr-2" />
          )}
          Remove
        </Button>
      </CardFooter>
    </Card>
  );
}
