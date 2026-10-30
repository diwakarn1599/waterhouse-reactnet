import type { Receipt } from '../api/types';
import { money } from '../format';

/**
 * The dispensing slip (KOT).
 *
 * Item, cap, quantity, rate. Nothing else - no business name, address, GSTIN,
 * customer, totals, date or footer.
 *
 * This is deliberate and it is not a bill. The slip never leaves the premises
 * as a record: the cashier takes payment, hands it over, and the dispenser
 * reads it to know what to give out. Every line printed beyond those four
 * columns is thermal ink spent on information nobody in that loop reads, on
 * every single sale.
 *
 * Consequence worth knowing: because there is no invoice number on the slip, it
 * cannot be matched back to a sale once it is off the counter. That is fine for
 * dispensing and wrong for a dispute. The full record still exists in Sales -
 * it just is not printed.
 */
export function ReceiptView({ receipt }: { receipt: Receipt }) {
  return (
    <div id="receipt" className="font-mono text-[13px] leading-snug text-black">
      <table className="w-full">
        <thead>
          {/* One header line. The dispenser did not watch the sale being
              entered, so bare numbers would be ambiguous - "20" could be the
              quantity or the rate. */}
          <tr>
            <th className="text-left font-normal">ITEM</th>
            <th className="text-left font-normal">CAP</th>
            <th className="text-right font-normal">QTY</th>
            <th className="text-right font-normal">RATE</th>
          </tr>
        </thead>
        <tbody>
          {receipt.lines.map((line, index) => (
            <tr key={index}>
              <td className="text-left font-bold">{line.name}</td>
              <td className="text-left">{line.capName ?? '-'}</td>
              <td className="tnum text-right font-bold">{line.quantity}</td>
              <td className="tnum text-right">{money(line.rate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
