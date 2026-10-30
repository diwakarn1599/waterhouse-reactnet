using Dapper;
using Microsoft.Data.Sqlite;
using Waterhouse.Api.Infrastructure;
using Waterhouse.Api.Infrastructure.Auth;
using Waterhouse.Api.Infrastructure.Db;

namespace Waterhouse.Api.Features.Sales;

/// <param name="CapProductId">
/// Cap colour given away with this line, or null for none. One cap per unit, so
/// the cap quantity is always <paramref name="Quantity"/> - there is no second
/// number that could drift out of step with it.
/// </param>
public sealed record SaleLineInput(int ProductId, int Quantity, decimal Rate, int? CapProductId = null);

public sealed record CreateSaleInput(
    string? ClientUuid,
    string SaleDate,
    /// <summary>Null for a local walk-in sale, which has no customer.</summary>
    int? CustomerId,
    bool IsLocal,
    IReadOnlyList<SaleLineInput> Lines,
    decimal PaidAmount,
    string? PaymentMethod,
    string? Note);

public enum UpdateSaleStatus { Updated, NotFound, Voided }

/// <summary>Result of an edit: the outcome, and the new figures when it succeeded.</summary>
public sealed record UpdateSaleOutcome(UpdateSaleStatus Status, CreateSaleResult? Result)
{
    public static readonly UpdateSaleOutcome NotFound = new(UpdateSaleStatus.NotFound, null);
    public static readonly UpdateSaleOutcome Voided = new(UpdateSaleStatus.Voided, null);
}

public sealed record CreateSaleResult(
    int SaleId,
    string InvoiceNo,
    bool WasDuplicate,
    long TotalPaise,
    long PaidPaise,
    long BalancePaise,
    string PaymentStatus,
    long CustomerBalanceAfterPaise,
    IReadOnlyList<string> Warnings);

/// <summary>
/// Recording a sale: the one write path that must never be slow and must never
/// double-charge a customer.
/// </summary>
public sealed class SaleService(IDbConnectionFactory connectionFactory, ILogger<SaleService> logger)
{
    /// <summary>
    /// Record a sale, atomically, exactly once.
    /// </summary>
    /// <remarks>
    /// IDEMPOTENCY. The POS writes to an offline outbox and retries in the
    /// background, so the same sale can legitimately arrive several times - a
    /// reply lost to a dropped connection is indistinguishable from a request
    /// that never landed. Every submission carries a client-generated
    /// <c>clientUuid</c>; if one has already been recorded, the existing sale is
    /// returned unchanged with <c>WasDuplicate</c> set. The client sees success
    /// either way and the customer is billed once.
    ///
    /// ATOMICITY. Invoice number, sale, lines and every stock movement commit
    /// together or not at all. The legacy app updated cap stock in a separate
    /// non-transactional read-then-write, which is how its counter drifted
    /// permanently negative.
    ///
    /// STOCK NEVER BLOCKS A SALE. Insufficient stock produces a warning on the
    /// response, not a refusal. A customer is standing at the counter; the
    /// business decision to sell has already been made, and the physical goods
    /// are visibly there. Refusing would mean a queue and a manual paper bill.
    /// The ledger records reality, warnings surface the discrepancy.
    /// </remarks>
    public CreateSaleResult Create(CreateSaleInput input, CurrentUser user)
    {
        using var connection = connectionFactory.Open();
        return connection.InTransaction(transaction =>
        {
            // Idempotency check inside the transaction, so two concurrent
            // retries of the same sale cannot both pass it.
            if (!string.IsNullOrWhiteSpace(input.ClientUuid))
            {
                var existing = connection.QuerySingleOrDefault<ExistingSale>(
                    """
                    SELECT id AS Id, invoice_no AS InvoiceNo, total_amount_paise AS TotalPaise,
                           paid_amount_paise AS PaidPaise, balance_amount_paise AS BalancePaise,
                           payment_status AS PaymentStatus, customer_id AS CustomerId
                      FROM sale WHERE client_uuid = @uuid
                    """,
                    new { uuid = input.ClientUuid }, transaction);

                if (existing is not null)
                {
                    logger.LogInformation(
                        "Sale {InvoiceNo} re-submitted with the same clientUuid; returning the original.",
                        existing.InvoiceNo);
                    return new CreateSaleResult(
                        existing.Id, existing.InvoiceNo, WasDuplicate: true,
                        existing.TotalPaise, existing.PaidPaise, existing.BalancePaise, existing.PaymentStatus,
                        // Null for a re-submitted walk-in: no customer, no balance.
                        existing.CustomerId is { } cid ? CustomerBalance(connection, transaction, cid) : 0,
                        []);
                }
            }

            var products = connection.Query<ProductRow>(
                """
                SELECT id AS Id, code AS Code, name AS Name, tracks_stock AS TracksStock,
                       consumes_product_id AS ConsumesProductId, consume_qty AS ConsumeQty
                  FROM product WHERE is_active = 1
                """, transaction: transaction).ToDictionary(p => p.Id);

            var warnings = new List<string>();
            var now = Clock.NowIso();

            // ---- totals, in integer paise throughout ----------------------------
            var lines = new List<(SaleLineInput Input, long RatePaise, long AmountPaise)>();
            long totalPaise = 0;
            foreach (var line in input.Lines)
            {
                var ratePaise = Money.FromRupees(line.Rate);
                var amountPaise = ratePaise * line.Quantity;
                totalPaise += amountPaise;
                lines.Add((line, ratePaise, amountPaise));
            }

            // A walk-in has no account to bill later, so the bill is settled in
            // full by definition. Forcing it here keeps the API consistent with
            // the ck_local_sale_fully_paid constraint rather than surfacing a
            // constraint violation as a 500.
            var paidPaise = input.IsLocal ? totalPaise : Money.FromRupees(input.PaidAmount);
            var balancePaise = totalPaise - paidPaise;
            var status = balancePaise <= 0 ? "PAID" : paidPaise > 0 ? "PARTIAL" : "UNPAID";

            // ---- invoice number -------------------------------------------------
            var invoiceNo = AllocateNumber(connection, transaction, "sale", now);

            var saleId = connection.ExecuteScalar<long>(
                """
                INSERT INTO sale (invoice_no, sale_date, customer_id, is_local, total_amount_paise, paid_amount_paise,
                                  balance_amount_paise, payment_status, payment_method, note, client_uuid, is_void,
                                  created_by, created_at, updated_at)
                VALUES (@invoiceNo, @saleDate, @customerId, @isLocal, @total, @paid, @balance, @status, @method,
                        @note, @uuid, 0, @userId, @now, @now);
                SELECT last_insert_rowid();
                """,
                new
                {
                    invoiceNo,
                    saleDate = input.SaleDate,
                    // NULL for a walk-in. The ck_sale_local_has_no_customer
                    // constraint refuses any other combination.
                    customerId = input.IsLocal ? null : input.CustomerId,
                    isLocal = input.IsLocal ? 1 : 0,
                    total = totalPaise,
                    paid = paidPaise,
                    balance = balancePaise,
                    status,
                    method = NormaliseMethod(input.PaymentMethod),
                    note = input.Note ?? string.Empty,
                    uuid = string.IsNullOrWhiteSpace(input.ClientUuid) ? null : input.ClientUuid,
                    userId = user.Id,
                    now,
                }, transaction);

            // ---- lines and stock movements --------------------------------------
            foreach (var (line, ratePaise, amountPaise) in lines)
            {
                connection.Execute(
                    """
                    INSERT INTO sale_line (sale_id, product_id, quantity, rate_paise, amount_paise, cap_product_id)
                    VALUES (@saleId, @productId, @quantity, @rate, @amount, @capProductId)
                    """,
                    new
                    {
                        saleId, productId = line.ProductId, quantity = line.Quantity,
                        rate = ratePaise, amount = amountPaise,
                        capProductId = line.CapProductId,
                    },
                    transaction);

                // Caps given away with this line. One per unit, drawn from the
                // chosen colour's stock. Deliberately NOT a second sale_line:
                // the period reports sum sale_line.quantity, so a cap line would
                // make 100 cans report as 200 units sold.
                if (line.CapProductId is { } capId)
                {
                    RecordStockMovement(connection, transaction, capId, input.SaleDate,
                        -line.Quantity, saleId, user.Id, now);

                    if (products.TryGetValue(capId, out var cap))
                    {
                        WarnIfNegative(connection, transaction, cap, warnings);
                    }
                }

                if (!products.TryGetValue(line.ProductId, out var product)) continue;

                // The product itself, when it is stock-tracked.
                if (product.TracksStock == 1)
                {
                    RecordStockMovement(connection, transaction, product.Id, input.SaleDate,
                        -line.Quantity, saleId, user.Id, now);
                    WarnIfNegative(connection, transaction, product, warnings);
                }

                // Its consumed component - a Can drawing a Cap. Generalises the
                // rule the legacy app hard-coded in the can-entry controller.
                if (product.ConsumesProductId is { } componentId && product.ConsumeQty > 0)
                {
                    var consumed = line.Quantity * product.ConsumeQty;
                    RecordStockMovement(connection, transaction, componentId, input.SaleDate,
                        -consumed, saleId, user.Id, now);
                    if (products.TryGetValue(componentId, out var component))
                    {
                        WarnIfNegative(connection, transaction, component, warnings);
                    }
                }
            }

            return new CreateSaleResult(
                (int)saleId, invoiceNo, WasDuplicate: false,
                totalPaise, paidPaise, balancePaise, status,
                // A walk-in carries no running balance to report back.
                input.IsLocal ? 0 : CustomerBalance(connection, transaction, input.CustomerId!.Value),
                warnings);
        });
    }

    /// <summary>
    /// Correct an existing sale in place, keeping its invoice number.
    /// </summary>
    /// <remarks>
    /// Editing a recorded sale is a financial correction, so three things hold:
    ///
    ///   STOCK IS COMPENSATED, NOT REWRITTEN. The ledger is append-only, so the
    ///   original movements stay and the edit adds reversing ADJUSTMENT rows
    ///   followed by the new SALE rows. On-hand stays correct and the history
    ///   still explains how it got there. Deleting the old rows would make the
    ///   stock figure right and the audit trail a lie.
    ///
    ///   THE INVOICE NUMBER IS PRESERVED. A slip may already be on the counter.
    ///
    ///   EVERY EDIT IS AUDITED with the before and after figures.
    ///
    /// A voided sale cannot be edited - it is already out of the books.
    /// </remarks>
    public UpdateSaleOutcome Update(int saleId, CreateSaleInput input, CurrentUser user)
    {
        using var connection = connectionFactory.Open();
        return connection.InTransaction(transaction =>
        {
            var before = connection.QuerySingleOrDefault<ExistingSale>(
                """
                SELECT id AS Id, invoice_no AS InvoiceNo, total_amount_paise AS TotalPaise,
                       paid_amount_paise AS PaidPaise, balance_amount_paise AS BalancePaise,
                       payment_status AS PaymentStatus, customer_id AS CustomerId, is_void AS IsVoid
                  FROM sale WHERE id = @id
                """, new { id = saleId }, transaction);

            if (before is null) return UpdateSaleOutcome.NotFound;
            if (before.IsVoid == 1) return UpdateSaleOutcome.Voided;

            var products = connection.Query<ProductRow>(
                """
                SELECT id AS Id, code AS Code, name AS Name, tracks_stock AS TracksStock,
                       consumes_product_id AS ConsumesProductId, consume_qty AS ConsumeQty
                  FROM product WHERE is_active = 1
                """, transaction: transaction).ToDictionary(p => p.Id);

            var now = Clock.NowIso();
            var warnings = new List<string>();

            // ---- recompute from the submitted lines -----------------------------
            var lines = new List<(SaleLineInput Input, long RatePaise, long AmountPaise)>();
            long totalPaise = 0;
            foreach (var line in input.Lines)
            {
                var ratePaise = Money.FromRupees(line.Rate);
                var amountPaise = ratePaise * line.Quantity;
                totalPaise += amountPaise;
                lines.Add((line, ratePaise, amountPaise));
            }

            var paidPaise = input.IsLocal ? totalPaise : Money.FromRupees(input.PaidAmount);
            var balancePaise = totalPaise - paidPaise;
            var status = balancePaise <= 0 ? "PAID" : paidPaise > 0 ? "PARTIAL" : "UNPAID";

            // ---- reverse the stock this sale had already taken ------------------
            var oldMovements = connection.Query<LedgerMovement>(
                """
                SELECT product_id AS ProductId, change_qty AS ChangeQty, entry_date AS EntryDate
                  FROM stock_ledger WHERE ref_type = 'SALE' AND ref_id = @id
                """, new { id = saleId }, transaction).ToList();

            foreach (var movement in oldMovements)
            {
                connection.Execute(
                    """
                    INSERT INTO stock_ledger (product_id, entry_date, change_qty, ref_type, ref_id, note, created_by, created_at)
                    VALUES (@productId, @entryDate, @change, 'ADJUSTMENT', @saleId, @note, @userId, @now)
                    """,
                    new
                    {
                        productId = movement.ProductId,
                        entryDate = movement.EntryDate,
                        change = -movement.ChangeQty,
                        saleId,
                        note = $"reversal for edit of sale {before.InvoiceNo}",
                        userId = user.Id,
                        now,
                    }, transaction);
            }

            // ---- replace the sale ------------------------------------------------
            connection.Execute(
                """
                UPDATE sale
                   SET sale_date = @saleDate, customer_id = @customerId, is_local = @isLocal,
                       total_amount_paise = @total, paid_amount_paise = @paid,
                       balance_amount_paise = @balance, payment_status = @status,
                       payment_method = @method, note = @note, updated_at = @now
                 WHERE id = @id
                """,
                new
                {
                    id = saleId,
                    saleDate = input.SaleDate,
                    customerId = input.IsLocal ? null : input.CustomerId,
                    isLocal = input.IsLocal ? 1 : 0,
                    total = totalPaise,
                    paid = paidPaise,
                    balance = balancePaise,
                    status,
                    method = NormaliseMethod(input.PaymentMethod),
                    note = input.Note ?? string.Empty,
                    now,
                }, transaction);

            // Lines carry no ledger semantics of their own, so replacing them
            // outright is safe - the stock history lives in stock_ledger.
            connection.Execute("DELETE FROM sale_line WHERE sale_id = @id", new { id = saleId }, transaction);

            foreach (var (line, ratePaise, amountPaise) in lines)
            {
                connection.Execute(
                    """
                    INSERT INTO sale_line (sale_id, product_id, quantity, rate_paise, amount_paise, cap_product_id)
                    VALUES (@saleId, @productId, @quantity, @rate, @amount, @capProductId)
                    """,
                    new
                    {
                        saleId, productId = line.ProductId, quantity = line.Quantity,
                        rate = ratePaise, amount = amountPaise, capProductId = line.CapProductId,
                    }, transaction);

                if (line.CapProductId is { } capId)
                {
                    RecordStockMovement(connection, transaction, capId, input.SaleDate,
                        -line.Quantity, saleId, user.Id, now);
                    if (products.TryGetValue(capId, out var cap)) WarnIfNegative(connection, transaction, cap, warnings);
                }

                if (!products.TryGetValue(line.ProductId, out var product)) continue;

                if (product.TracksStock == 1)
                {
                    RecordStockMovement(connection, transaction, product.Id, input.SaleDate,
                        -line.Quantity, saleId, user.Id, now);
                    WarnIfNegative(connection, transaction, product, warnings);
                }

                if (product.ConsumesProductId is { } componentId && product.ConsumeQty > 0)
                {
                    RecordStockMovement(connection, transaction, componentId, input.SaleDate,
                        -line.Quantity * product.ConsumeQty, saleId, user.Id, now);
                    if (products.TryGetValue(componentId, out var component))
                    {
                        WarnIfNegative(connection, transaction, component, warnings);
                    }
                }
            }

            connection.Execute(
                """
                INSERT INTO audit_log (entity, entity_id, action, detail, user_id, created_at)
                VALUES ('sale', @id, 'EDIT', @detail, @userId, @now)
                """,
                new
                {
                    id = saleId,
                    detail =
                        $"{before.InvoiceNo}: total {Money.Format(before.TotalPaise)} -> {Money.Format(totalPaise)}, " +
                        $"paid {Money.Format(before.PaidPaise)} -> {Money.Format(paidPaise)}, " +
                        $"balance {Money.Format(before.BalancePaise)} -> {Money.Format(balancePaise)}",
                    userId = user.Id,
                    now,
                }, transaction);

            return new UpdateSaleOutcome(
                UpdateSaleStatus.Updated,
                new CreateSaleResult(
                    saleId, before.InvoiceNo, WasDuplicate: false,
                    totalPaise, paidPaise, balancePaise, status,
                    input.IsLocal ? 0 : CustomerBalance(connection, transaction, input.CustomerId!.Value),
                    warnings));
        });
    }

    /// <summary>
    /// Void a sale and reverse its stock movements.
    /// </summary>
    /// <remarks>
    /// Sales are never deleted. A void writes compensating ledger entries rather
    /// than removing the originals, so the stock history stays append-only and
    /// every movement remains explainable.
    /// </remarks>
    public bool Void(int saleId, string reason, CurrentUser user)
    {
        using var connection = connectionFactory.Open();
        return connection.InTransaction(transaction =>
        {
            var isVoid = connection.QuerySingleOrDefault<int?>(
                "SELECT is_void FROM sale WHERE id = @id", new { id = saleId }, transaction);
            if (isVoid is null || isVoid == 1) return false;

            var now = Clock.NowIso();
            connection.Execute(
                """
                UPDATE sale
                   SET is_void = 1, voided_at = @now, voided_by = @userId,
                       void_reason = @reason, updated_at = @now
                 WHERE id = @id
                """,
                new { now, userId = user.Id, reason, id = saleId }, transaction);

            var movements = connection.Query<LedgerMovement>(
                """
                SELECT product_id AS ProductId, change_qty AS ChangeQty, entry_date AS EntryDate
                  FROM stock_ledger WHERE ref_type = 'SALE' AND ref_id = @id
                """, new { id = saleId }, transaction);

            foreach (var movement in movements)
            {
                connection.Execute(
                    """
                    INSERT INTO stock_ledger (product_id, entry_date, change_qty, ref_type, ref_id, note, created_by, created_at)
                    VALUES (@productId, @entryDate, @change, 'ADJUSTMENT', @saleId, @note, @userId, @now)
                    """,
                    new
                    {
                        productId = movement.ProductId,
                        entryDate = movement.EntryDate,
                        change = -movement.ChangeQty,
                        saleId,
                        note = $"reversal of voided sale {saleId}",
                        userId = user.Id,
                        now,
                    }, transaction);
            }

            connection.Execute(
                """
                INSERT INTO audit_log (entity, entity_id, action, detail, user_id, created_at)
                VALUES ('sale', @id, 'VOID', @reason, @userId, @now)
                """,
                new { id = saleId, reason, userId = user.Id, now }, transaction);

            return true;
        });
    }

    // ------------------------------------------------------------------ helpers

    /// <summary>Payment methods accepted on a sale and on a later settlement.</summary>
    public static readonly string[] PaymentMethods = ["CASH", "UPI", "CARD", "BANK", "CHEQUE", "CREDIT"];

    /// <summary>
    /// Product ids that may appear as a line's cap: active, stock-tracked and
    /// not for sale.
    /// </summary>
    /// <remarks>
    /// The foreign key alone would accept any product id, so a request naming a
    /// water can as the "cap" would be stored and would decrement can stock.
    /// This narrows it to things that are actually giveaway stock.
    /// </remarks>
    public HashSet<int> ActiveCapProductIds()
    {
        using var connection = connectionFactory.Open();
        return connection.Query<int>(
            """
            SELECT id FROM product
             WHERE is_active = 1 AND tracks_stock = 1 AND is_sellable = 0
            """).ToHashSet();
    }

    /// <summary>
    /// Coerce a method to the canonical set, defaulting to CASH.
    /// Validation rejects an unknown value before this is reached; this exists so
    /// a null or differently-cased value can never violate the column.
    /// </summary>
    internal static string NormaliseMethod(string? method)
    {
        if (string.IsNullOrWhiteSpace(method)) return "CASH";
        var upper = method.Trim().ToUpperInvariant();
        return PaymentMethods.Contains(upper) ? upper : "CASH";
    }

    /// <summary>
    /// Take the next document number. The UPDATE ... RETURNING runs as a single
    /// atomic statement, so two concurrent sales cannot be handed the same one.
    /// </summary>
    internal static string AllocateNumber(SqliteConnection connection, SqliteTransaction transaction, string sequence, string now)
    {
        // Mapped to a named class, not a ValueTuple: Dapper does not map tuple
        // element names to columns, so a tuple here would bind positionally at
        // best and silently produce wrong values at worst.
        var row = connection.QuerySingleOrDefault<SequenceRow>(
            """
            UPDATE number_sequence
               SET next_value = next_value + 1, updated_at = @now
             WHERE name = @name
            RETURNING next_value - 1 AS NextValue, prefix AS Prefix, pad_width AS PadWidth
            """,
            new { name = sequence, now }, transaction);

        if (row is null)
        {
            throw new InvalidOperationException($"Number sequence '{sequence}' is missing from the database.");
        }

        return row.Prefix + row.NextValue.ToString().PadLeft(row.PadWidth, '0');
    }

    private sealed class SequenceRow
    {
        public long NextValue { get; init; }
        public string Prefix { get; init; } = string.Empty;
        public int PadWidth { get; init; }
    }

    private static void RecordStockMovement(
        SqliteConnection connection, SqliteTransaction transaction,
        long productId, string entryDate, long changeQty, long saleId, int userId, string now)
    {
        connection.Execute(
            """
            INSERT INTO stock_ledger (product_id, entry_date, change_qty, ref_type, ref_id, note, created_by, created_at)
            VALUES (@productId, @entryDate, @change, 'SALE', @saleId, '', @userId, @now)
            """,
            new { productId, entryDate, change = changeQty, saleId, userId, now }, transaction);
    }

    private static void WarnIfNegative(
        SqliteConnection connection, SqliteTransaction transaction, ProductRow product, List<string> warnings)
    {
        var onHand = connection.ExecuteScalar<long>(
            "SELECT COALESCE(SUM(change_qty), 0) FROM stock_ledger WHERE product_id = @id",
            new { id = product.Id }, transaction);

        if (onHand < 0)
        {
            warnings.Add($"{product.Name} stock is now {onHand}. Record a stock receipt or adjust the count.");
        }
    }

    private static long CustomerBalance(SqliteConnection connection, SqliteTransaction transaction, int customerId) =>
        connection.ExecuteScalar<long>(
            """
            SELECT COALESCE(SUM(balance_amount_paise), 0) FROM sale
             WHERE customer_id = @id AND is_void = 0 AND balance_amount_paise <> 0
            """,
            new { id = customerId }, transaction);

    private sealed class ExistingSale
    {
        public int Id { get; init; }
        public string InvoiceNo { get; init; } = string.Empty;
        public long TotalPaise { get; init; }
        public long PaidPaise { get; init; }
        public long BalancePaise { get; init; }
        public string PaymentStatus { get; init; } = "UNPAID";
        /// <summary>Null when the sale was a local walk-in.</summary>
        public int? CustomerId { get; init; }
        public int IsVoid { get; init; }
    }

    private sealed class ProductRow
    {
        public int Id { get; init; }
        public string Code { get; init; } = string.Empty;
        public string Name { get; init; } = string.Empty;
        public int TracksStock { get; init; }
        public int? ConsumesProductId { get; init; }
        public int ConsumeQty { get; init; }
    }

    private sealed class LedgerMovement
    {
        public long ProductId { get; init; }
        public long ChangeQty { get; init; }
        public string EntryDate { get; init; } = string.Empty;
    }
}
