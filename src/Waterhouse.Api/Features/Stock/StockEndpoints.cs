using System.Security.Claims;
using Dapper;
using Waterhouse.Api.Infrastructure;
using Waterhouse.Api.Infrastructure.Auth;
using Waterhouse.Api.Infrastructure.Db;
using Waterhouse.Api.Infrastructure.Endpoints;
using Waterhouse.Api.Infrastructure.Http;

namespace Waterhouse.Api.Features.Stock;

public sealed record CreateReceiptRequest(int ProductId, string ReceiptDate, int Quantity, decimal Amount, string? Note);

public sealed record CreateAdjustmentRequest(int ProductId, int CountedQuantity, string Note);

public sealed record CapIssueLine(int ProductId, int Quantity);

/// <summary>The morning's caps, all colours in one submission.</summary>
public sealed record CapIssueRequest(string IssueDate, List<CapIssueLine> Lines, string? Note);

/// <summary>
/// Stock, as an append-only ledger.
/// </summary>
/// <remarks>
/// On-hand is always SUM(change_qty) - there is no mutable counter to drift.
///
/// The legacy app kept a single `caps.bal_caps` column and updated it with a
/// read-then-write outside any transaction, guarded by `bal_caps > 0`. Once the
/// value went negative the guard silently stopped decrementing and the figure
/// was never right again; the production data still holds -9, -19, -49 and -83.
/// Corrections are posted as explicit ADJUSTMENT rows, never by editing history.
/// </remarks>
public sealed class StockEndpoints : IEndpointModule
{
    public void MapEndpoints(IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/stock").WithTags("Stock").RequireAuthorization(Policies.SignedIn);

        group.MapGet("/levels", Levels);
        group.MapGet("/receipts", ListReceipts);
        group.MapPost("/receipts", CreateReceipt);
        group.MapGet("/ledger", ListLedger);
        group.MapPost("/adjustments", CreateAdjustment).RequireAuthorization(Policies.AdminOnly);

        group.MapGet("/caps", CapLevels);
        group.MapPost("/caps/issue", IssueCaps).RequireAuthorization(Policies.AdminOnly);
        group.MapGet("/caps/report", CapReport);
    }

    /// <summary>Current on-hand for each cap colour, plus today's issue and use.</summary>
    private static IResult CapLevels(IDbConnectionFactory connectionFactory, IClock clock)
    {
        using var connection = connectionFactory.Open();

        var rows = connection.Query(
            """
            SELECT p.id AS ProductId, p.code AS Code, p.name AS Name,
                   COALESCE((SELECT SUM(change_qty) FROM stock_ledger l
                              WHERE l.product_id = p.id), 0) AS OnHand,
                   COALESCE((SELECT SUM(change_qty) FROM stock_ledger l
                              WHERE l.product_id = p.id AND l.entry_date = @today
                                AND l.ref_type IN ('RECEIPT','OPENING','ADJUSTMENT')), 0) AS IssuedToday,
                   COALESCE(-(SELECT SUM(change_qty) FROM stock_ledger l
                              WHERE l.product_id = p.id AND l.entry_date = @today
                                AND l.ref_type = 'SALE'), 0) AS UsedToday
              FROM product p
             WHERE p.is_active = 1 AND p.tracks_stock = 1 AND p.is_sellable = 0
             ORDER BY p.sort_order, p.name
            """, new { today = clock.Today() });

        return Results.Ok(rows.Select(r => new
        {
            productId = (int)r.ProductId,
            code = (string)r.Code,
            name = (string)r.Name,
            onHand = (long)r.OnHand,
            issuedToday = (long)r.IssuedToday,
            usedToday = (long)r.UsedToday,
        }));
    }

    /// <summary>
    /// Record the morning's caps - all colours in one transaction.
    /// </summary>
    /// <remarks>
    /// This is just a stock receipt per colour, but it gets its own endpoint
    /// because it happens every single morning and going through the generic
    /// receipt form three times is three times the chance of missing one.
    /// All colours commit together or none do.
    /// </remarks>
    private static IResult IssueCaps(
        CapIssueRequest request, ClaimsPrincipal principal, IDbConnectionFactory connectionFactory, IClock clock)
    {
        var validator = new Validator().RequireDate(request.IssueDate, "issueDate");

        var lines = (request.Lines ?? []).Where(l => l.Quantity > 0).ToList();
        validator.Require(lines.Count > 0, "lines", "Enter a quantity for at least one colour.");

        if (Clock.IsValidDate(request.IssueDate) &&
            string.CompareOrdinal(request.IssueDate, clock.Today()) > 0)
        {
            validator.Add("issueDate", "Cannot be in the future.");
        }
        if (validator.Problem() is { } problem) return problem;

        var user = principal.RequireUser();
        using var connection = connectionFactory.Open();

        return connection.InTransaction(transaction =>
        {
            var valid = connection.Query<int>(
                "SELECT id FROM product WHERE is_active = 1 AND tracks_stock = 1 AND is_sellable = 0",
                transaction: transaction).ToHashSet();

            foreach (var line in lines)
            {
                if (!valid.Contains(line.ProductId))
                {
                    return ApiResults.Unprocessable($"Product {line.ProductId} is not a cap.");
                }
            }

            var now = Clock.NowIso();
            var note = string.IsNullOrWhiteSpace(request.Note) ? "morning cap issue" : request.Note.Trim();
            var issued = new List<object>();

            foreach (var line in lines)
            {
                var receiptId = connection.ExecuteScalar<long>(
                    """
                    INSERT INTO stock_receipt (product_id, receipt_date, quantity, amount_paise, note, created_by, created_at, updated_at)
                    VALUES (@productId, @date, @quantity, 0, @note, @userId, @now, @now);
                    SELECT last_insert_rowid();
                    """,
                    new { productId = line.ProductId, date = request.IssueDate, quantity = line.Quantity, note, userId = user.Id, now },
                    transaction);

                connection.Execute(
                    """
                    INSERT INTO stock_ledger (product_id, entry_date, change_qty, ref_type, ref_id, note, created_by, created_at)
                    VALUES (@productId, @date, @change, 'RECEIPT', @refId, @note, @userId, @now)
                    """,
                    new { productId = line.ProductId, date = request.IssueDate, change = line.Quantity, refId = receiptId, note, userId = user.Id, now },
                    transaction);

                var onHand = connection.ExecuteScalar<long>(
                    "SELECT COALESCE(SUM(change_qty), 0) FROM stock_ledger WHERE product_id = @id",
                    new { id = line.ProductId }, transaction);

                issued.Add(new { productId = line.ProductId, quantity = line.Quantity, onHand });
            }

            return Results.Ok(new { issueDate = request.IssueDate, issued });
        });
    }

    /// <summary>
    /// Caps issued, used and remaining per colour over a date window.
    /// </summary>
    /// <remarks>
    /// Everything comes from the append-only ledger, so "used" is the sum of
    /// real sale movements rather than a counter anyone could have edited.
    /// `openingBalance` is the position before the window, which is what makes
    /// the arithmetic close: opening + issued - used = closing.
    /// </remarks>
    private static IResult CapReport(IDbConnectionFactory connectionFactory, string? from, string? to)
    {
        if (!Clock.IsValidDate(from) || !Clock.IsValidDate(to))
        {
            return new Validator().Add("from", "A valid from and to date are required.").Problem()!;
        }

        using var connection = connectionFactory.Open();

        var rows = connection.Query(
            """
            SELECT p.id AS ProductId, p.code AS Code, p.name AS Name,
                   COALESCE((SELECT SUM(change_qty) FROM stock_ledger l
                              WHERE l.product_id = p.id AND l.entry_date < @from), 0) AS OpeningBalance,
                   COALESCE((SELECT SUM(change_qty) FROM stock_ledger l
                              WHERE l.product_id = p.id AND l.entry_date BETWEEN @from AND @to
                                AND l.ref_type IN ('RECEIPT','OPENING')), 0) AS Issued,
                   COALESCE(-(SELECT SUM(change_qty) FROM stock_ledger l
                              WHERE l.product_id = p.id AND l.entry_date BETWEEN @from AND @to
                                AND l.ref_type = 'SALE'), 0) AS Used,
                   COALESCE((SELECT SUM(change_qty) FROM stock_ledger l
                              WHERE l.product_id = p.id AND l.entry_date BETWEEN @from AND @to
                                AND l.ref_type = 'ADJUSTMENT'), 0) AS Adjusted,
                   COALESCE((SELECT SUM(change_qty) FROM stock_ledger l
                              WHERE l.product_id = p.id AND l.entry_date <= @to), 0) AS ClosingBalance
              FROM product p
             WHERE p.tracks_stock = 1 AND p.is_sellable = 0 AND p.is_active = 1
             ORDER BY p.sort_order, p.name
            """, new { from, to });

        var items = rows.Select(r => new
        {
            productId = (int)r.ProductId,
            code = (string)r.Code,
            name = (string)r.Name,
            openingBalance = (long)r.OpeningBalance,
            issued = (long)r.Issued,
            used = (long)r.Used,
            adjusted = (long)r.Adjusted,
            closingBalance = (long)r.ClosingBalance,
        }).ToList();

        // Day-by-day movement, for the chart and the EOD view.
        var daily = connection.Query(
            """
            SELECT l.entry_date AS EntryDate, p.id AS ProductId, p.name AS Name,
                   COALESCE(SUM(CASE WHEN l.ref_type IN ('RECEIPT','OPENING') THEN l.change_qty ELSE 0 END), 0) AS Issued,
                   COALESCE(-SUM(CASE WHEN l.ref_type = 'SALE' THEN l.change_qty ELSE 0 END), 0) AS Used
              FROM stock_ledger l
              JOIN product p ON p.id = l.product_id
             WHERE p.tracks_stock = 1 AND p.is_sellable = 0 AND p.is_active = 1
               AND l.entry_date BETWEEN @from AND @to
             GROUP BY l.entry_date, p.id
             ORDER BY l.entry_date, p.sort_order
            """, new { from, to })
            .Select(r => new
            {
                entryDate = (string)r.EntryDate,
                productId = (int)r.ProductId,
                name = (string)r.Name,
                issued = (long)r.Issued,
                used = (long)r.Used,
            });

        return Results.Ok(new
        {
            from, to,
            items,
            daily,
            totals = new
            {
                issued = items.Sum(i => i.issued),
                used = items.Sum(i => i.used),
                closingBalance = items.Sum(i => i.closingBalance),
            },
        });
    }

    private static IResult Levels(IDbConnectionFactory connectionFactory)
    {
        using var connection = connectionFactory.Open();

        var rows = connection.Query(
            """
            SELECT p.id AS ProductId, p.code AS Code, p.name AS Name, p.unit AS Unit,
                   COALESCE((SELECT SUM(change_qty) FROM stock_ledger l WHERE l.product_id = p.id), 0) AS OnHand
              FROM product p
             WHERE p.tracks_stock = 1 AND p.is_active = 1
             ORDER BY p.sort_order, p.name
            """);

        return Results.Ok(rows.Select(r => new
        {
            productId = (int)r.ProductId,
            code = (string)r.Code,
            name = (string)r.Name,
            unit = (string)r.Unit,
            onHand = (long)r.OnHand,
        }));
    }

    private static IResult ListReceipts(
        IDbConnectionFactory connectionFactory, int? productId, string? from, string? to, int pageSize = 100)
    {
        pageSize = Math.Clamp(pageSize, 1, 500);

        var filters = new List<string> { "1=1" };
        if (productId is > 0) filters.Add("r.product_id = @productId");
        if (!string.IsNullOrWhiteSpace(from) && Clock.IsValidDate(from)) filters.Add("r.receipt_date >= @from");
        if (!string.IsNullOrWhiteSpace(to) && Clock.IsValidDate(to)) filters.Add("r.receipt_date <= @to");
        var where = "WHERE " + string.Join(" AND ", filters);

        using var connection = connectionFactory.Open();
        var rows = connection.Query(
            $"""
             SELECT r.id AS Id, r.receipt_date AS ReceiptDate, p.name AS ProductName,
                    r.quantity AS Quantity, r.amount_paise AS AmountPaise, r.note AS Note
               FROM stock_receipt r JOIN product p ON p.id = r.product_id
               {where}
              ORDER BY r.receipt_date DESC, r.id DESC
              LIMIT @limit
             """, new { productId, from, to, limit = pageSize });

        return Results.Ok(new
        {
            items = rows.Select(r => new
            {
                id = (int)r.Id,
                receiptDate = (string)r.ReceiptDate,
                productName = (string)r.ProductName,
                quantity = (long)r.Quantity,
                amount = Money.ToRupees((long)r.AmountPaise),
                note = (string)r.Note,
            }),
        });
    }

    private static IResult CreateReceipt(
        CreateReceiptRequest request, ClaimsPrincipal principal, IDbConnectionFactory connectionFactory, IClock clock)
    {
        var validator = new Validator()
            .RequirePositive(request.ProductId, "productId")
            .RequireDate(request.ReceiptDate, "receiptDate")
            .RequirePositive(request.Quantity, "quantity")
            .Require(request.Amount >= 0, "amount", "Cannot be negative.");

        if (Clock.IsValidDate(request.ReceiptDate) &&
            string.CompareOrdinal(request.ReceiptDate, clock.Today()) > 0)
        {
            validator.Add("receiptDate", "Cannot be in the future.");
        }
        if (validator.Problem() is { } problem) return problem;

        var user = principal.RequireUser();
        using var connection = connectionFactory.Open();

        return connection.InTransaction(transaction =>
        {
            var tracked = connection.ExecuteScalar<int>(
                "SELECT COUNT(*) FROM product WHERE id = @id AND tracks_stock = 1",
                new { id = request.ProductId }, transaction);
            if (tracked == 0)
            {
                return ApiResults.Unprocessable("That item does not exist or does not track stock.");
            }

            var now = Clock.NowIso();
            var receiptId = connection.ExecuteScalar<long>(
                """
                INSERT INTO stock_receipt (product_id, receipt_date, quantity, amount_paise, note, created_by, created_at, updated_at)
                VALUES (@productId, @receiptDate, @quantity, @amount, @note, @userId, @now, @now);
                SELECT last_insert_rowid();
                """,
                new
                {
                    productId = request.ProductId,
                    receiptDate = request.ReceiptDate,
                    quantity = request.Quantity,
                    amount = Money.FromRupees(request.Amount),
                    note = request.Note ?? string.Empty,
                    userId = user.Id,
                    now,
                }, transaction);

            // The receipt row and its ledger movement commit together, so the
            // two can never disagree.
            connection.Execute(
                """
                INSERT INTO stock_ledger (product_id, entry_date, change_qty, ref_type, ref_id, note, created_by, created_at)
                VALUES (@productId, @entryDate, @change, 'RECEIPT', @refId, '', @userId, @now)
                """,
                new
                {
                    productId = request.ProductId,
                    entryDate = request.ReceiptDate,
                    change = request.Quantity,
                    refId = receiptId,
                    userId = user.Id,
                    now,
                }, transaction);

            return Results.Created($"/api/stock/receipts/{receiptId}", new { id = (int)receiptId });
        });
    }

    private static IResult ListLedger(
        IDbConnectionFactory connectionFactory, int? productId, string? from, string? to, int pageSize = 200)
    {
        pageSize = Math.Clamp(pageSize, 1, 1000);

        var filters = new List<string> { "1=1" };
        if (productId is > 0) filters.Add("l.product_id = @productId");
        if (!string.IsNullOrWhiteSpace(from) && Clock.IsValidDate(from)) filters.Add("l.entry_date >= @from");
        if (!string.IsNullOrWhiteSpace(to) && Clock.IsValidDate(to)) filters.Add("l.entry_date <= @to");
        var where = "WHERE " + string.Join(" AND ", filters);

        using var connection = connectionFactory.Open();
        var rows = connection.Query(
            $"""
             SELECT l.id AS Id, l.entry_date AS EntryDate, p.name AS ProductName, l.change_qty AS ChangeQty,
                    l.ref_type AS RefType, l.ref_id AS RefId, l.note AS Note, u.display_name AS CreatedByName
               FROM stock_ledger l
               JOIN product p ON p.id = l.product_id
               LEFT JOIN app_user u ON u.id = l.created_by
               {where}
              ORDER BY l.entry_date DESC, l.id DESC
              LIMIT @limit
             """, new { productId, from, to, limit = pageSize });

        return Results.Ok(new
        {
            items = rows.Select(r => new
            {
                id = (int)r.Id,
                entryDate = (string)r.EntryDate,
                productName = (string)r.ProductName,
                changeQty = (long)r.ChangeQty,
                refType = (string)r.RefType,
                refId = (long?)r.RefId,
                note = (string)r.Note,
                createdByName = (string?)r.CreatedByName,
            }),
        });
    }

    /// <summary>
    /// Reconcile to a physical count by posting the difference as one entry.
    /// </summary>
    private static IResult CreateAdjustment(
        CreateAdjustmentRequest request, ClaimsPrincipal principal, IDbConnectionFactory connectionFactory, IClock clock)
    {
        var validator = new Validator()
            .RequirePositive(request.ProductId, "productId")
            .RequireText(request.Note, "note", 500)
            .Require(request.CountedQuantity >= 0, "countedQuantity", "Cannot be negative.");
        if (validator.Problem() is { } problem) return problem;

        var user = principal.RequireUser();
        using var connection = connectionFactory.Open();

        return connection.InTransaction(transaction =>
        {
            var onHand = connection.ExecuteScalar<long>(
                "SELECT COALESCE(SUM(change_qty), 0) FROM stock_ledger WHERE product_id = @id",
                new { id = request.ProductId }, transaction);

            var delta = request.CountedQuantity - onHand;
            if (delta == 0)
            {
                return Results.Ok(new { adjusted = 0L, onHand, message = "The count already matches; nothing posted." });
            }

            connection.Execute(
                """
                INSERT INTO stock_ledger (product_id, entry_date, change_qty, ref_type, ref_id, note, created_by, created_at)
                VALUES (@productId, @entryDate, @change, 'ADJUSTMENT', NULL, @note, @userId, @now)
                """,
                new
                {
                    productId = request.ProductId,
                    entryDate = clock.Today(),
                    change = delta,
                    note = $"physical count {request.CountedQuantity} (was {onHand}): {request.Note.Trim()}",
                    userId = user.Id,
                    now = Clock.NowIso(),
                }, transaction);

            return Results.Ok(new { adjusted = delta, onHand = (long)request.CountedQuantity });
        });
    }
}
