// Shapes exchanged with the API. Money crosses the wire as a decimal number of
// rupees; the server holds integer paise and converts at the boundary.

export type Role = 'admin' | 'operator';
export type PaymentStatus = 'PAID' | 'PARTIAL' | 'UNPAID';

export interface UserInfo {
  id: number;
  username: string;
  displayName: string;
  role: Role;
}

export interface Branch {
  code: string;
  name: string;
  address: string;
  phone: string;
  gstin: string;
  receiptFooter: string;
}

export interface Product {
  id: number;
  code: string;
  name: string;
  unit: string;
  isSellable: boolean;
  tracksStock: boolean;
  defaultRate: number;
}

export interface Customer {
  id: number;
  code: string;
  name: string;
  companyName: string;
  phone: string;
  /** Outstanding balance in rupees. Positive means the customer owes. */
  balance: number;
  /** Per-product rate overrides, keyed by product id as a string. */
  rates: Record<string, number>;
}

/**
 * Everything the till needs to sell, fetched once per session.
 * After this lands, the POS makes no blocking network call.
 */
export interface BootstrapData {
  branch: Branch;
  today: string;
  serverTime: string;
  products: Product[];
  /** Cap colours with current on-hand, for the Sell screen picker. */
  caps: Cap[];
  customers: Customer[];
  /** On-hand quantity keyed by product id as a string. */
  stock: Record<string, number>;
  /**
   * Suggested rate buttons for local walk-in entry, keyed by product id.
   * Derived server-side from what the counter actually charges, so the buttons
   * track real pricing without anyone maintaining a list.
   */
  quickRates: Record<string, number[]>;
}

export interface SaleLineInput {
  productId: number;
  quantity: number;
  rate: number;
  /** Cap colour given away with this line, or null for none. One per unit. */
  capProductId?: number | null;
}

/** A cap colour: giveaway stock, never sold. */
export interface Cap {
  id: number;
  code: string;
  name: string;
  onHand: number;
}

export type PaymentMethod = 'CASH' | 'UPI' | 'CARD' | 'BANK' | 'CHEQUE' | 'CREDIT';

export const paymentMethods: PaymentMethod[] = ['CASH', 'UPI', 'CARD', 'BANK', 'CHEQUE', 'CREDIT'];

export interface CreateSaleRequest {
  clientUuid: string;
  saleDate: string;
  /** Null for a local walk-in sale, which has no customer. */
  customerId: number | null;
  isLocal: boolean;
  lines: SaleLineInput[];
  paidAmount: number;
  paymentMethod: PaymentMethod;
  note?: string;
}

export interface CreateSaleResponse {
  id: number;
  invoiceNo: string;
  saleDate: string;
  totalAmount: number;
  paidAmount: number;
  balanceAmount: number;
  paymentStatus: PaymentStatus;
  customerBalanceAfter: number;
  wasDuplicate: boolean;
  warnings: string[];
}

export interface SaleListItem {
  id: number;
  invoiceNo: string;
  saleDate: string;
  customerId: number | null;
  customerCode: string;
  customerName: string;
  isLocal: boolean;
  quantity: number;
  totalAmount: number;
  paidAmount: number;
  balanceAmount: number;
  paymentStatus: PaymentStatus;
  paymentMethod: PaymentMethod;
  isVoid: boolean;
}

export interface Paged<T> {
  total: number;
  page: number;
  pageSize: number;
  items: T[];
}

export interface SaleDetail {
  id: number;
  invoiceNo: string;
  saleDate: string;
  customerId: number | null;
  customerCode: string;
  customerName: string;
  isLocal: boolean;
  totalAmount: number;
  paidAmount: number;
  balanceAmount: number;
  paymentStatus: PaymentStatus;
  paymentMethod: PaymentMethod;
  isVoid: boolean;
  note: string;
  createdByName: string | null;
  createdAt: string;
  lines: Array<{
    productId: number;
    productCode: string;
    productName: string;
    quantity: number;
    rate: number;
    amount: number;
    /** Cap colour given away with this line, or null. */
    capProductId: number | null;
    capName: string | null;
  }>;
}

/** A completed sale held locally, whether or not the server has it yet. */
export interface Receipt {
  invoiceNo: string;
  saleDate: string;
  customerCode: string;
  customerName: string;
  isLocal: boolean;
  paymentMethod: PaymentMethod;
  lines: Array<{ name: string; quantity: number; rate: number; amount: number; capName?: string | null }>;
  totalAmount: number;
  paidAmount: number;
  balanceAmount: number;
  previousBalance: number;
  createdAt: string;
  /** False while the sale is still only in the outbox. */
  synced: boolean;
}
