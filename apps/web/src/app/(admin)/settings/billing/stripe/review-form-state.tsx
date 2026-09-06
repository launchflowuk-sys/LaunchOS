"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { Checkbox } from "@/components/ui/checkbox";

/**
 * The review form's answers, held once.
 *
 * `DataList` renders every row twice — a table for `md+` and stacked cards
 * under it, one of the two hidden with `display: none` — and a hidden form
 * control still posts. Two copies of a tick or a select therefore post two
 * values, and the copy nobody touched wins or loses by DOM order. So the
 * controls in the rows carry no `name` at all: they read and write this
 * store, and `HiddenFields` (rendered once, inside the form) is what posts —
 * `product` per ticked product, `fileUnder:<customer>` and
 * `clientName:<customer>` per customer the owner can place.
 */
export interface ReviewFormInitial {
  /** productId → ticked */
  products: Record<string, boolean>;
  /** customerId → "new" | client id | "" (leave it) */
  fileUnder: Record<string, string>;
  /** customerId → the name a new client would get */
  clientNames: Record<string, string>;
}

interface ReviewFormStore extends ReviewFormInitial {
  setProduct: (productId: string, ticked: boolean) => void;
  setFileUnder: (customerId: string, choice: string) => void;
  setClientName: (customerId: string, name: string) => void;
}

const ReviewFormContext = createContext<ReviewFormStore | null>(null);

export function ReviewFormProvider({ initial, children }: { initial: ReviewFormInitial; children: ReactNode }) {
  const [products, setProducts] = useState(initial.products);
  const [fileUnder, setFileUnderState] = useState(initial.fileUnder);
  const [clientNames, setClientNames] = useState(initial.clientNames);

  const store: ReviewFormStore = {
    products, fileUnder, clientNames,
    setProduct: (productId, ticked) => setProducts((prev) => ({ ...prev, [productId]: ticked })),
    setFileUnder: (customerId, choice) => setFileUnderState((prev) => ({ ...prev, [customerId]: choice })),
    setClientName: (customerId, name) => setClientNames((prev) => ({ ...prev, [customerId]: name })),
  };

  return (
    <ReviewFormContext.Provider value={store}>
      {children}
      <HiddenFields store={store} />
    </ReviewFormContext.Provider>
  );
}

export function useReviewForm(): ReviewFormStore {
  const store = useContext(ReviewFormContext);
  if (!store) throw new Error("useReviewForm: not inside ReviewFormProvider");
  return store;
}

/** What actually posts. One input per answer, whatever the viewport shows. */
function HiddenFields({ store }: { store: ReviewFormStore }) {
  return (
    <>
      {Object.entries(store.products).filter(([, ticked]) => ticked).map(([productId]) => (
        <input key={productId} type="hidden" name="product" value={productId} />
      ))}
      {Object.entries(store.fileUnder).map(([customerId, choice]) => (
        <input key={customerId} type="hidden" name={`fileUnder:${customerId}`} value={choice} />
      ))}
      {Object.entries(store.clientNames).map(([customerId, name]) => (
        <input key={customerId} type="hidden" name={`clientName:${customerId}`} value={name} />
      ))}
    </>
  );
}

/** The "Import" tick on a product row: both copies of the row show the same answer. */
export function ProductTick({ productId, label }: { productId: string; label: string }) {
  const { products, setProduct } = useReviewForm();
  return (
    <Checkbox
      checked={products[productId] ?? false}
      onCheckedChange={(state) => setProduct(productId, state === true)}
      aria-label={label}
    />
  );
}
